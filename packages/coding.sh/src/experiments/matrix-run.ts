// Run an experiment matrix (Z-4): every cell over the same cases, interleaved
// like `exp run --arm` (cases in a seeded random order, and for each
// case-trial the cells in a random order, next to each other), so drift hits
// every cell alike. Each cell is stored as its own experiment; then each
// non-baseline cell is compared with the baseline (paired, compare.ts) and the
// McNemar p-values are Holm-adjusted across the family.
import { sortableId } from "../core/ids.ts";
import type { FileEvalStore } from "../datasets/store.ts";
import type { Case, CaseRun, Dataset, ExperimentResult, Grader, Split } from "../datasets/types.ts";
import type { RetryPolicy } from "../jobs/retry.ts";
import type { JobScope } from "../jobs/store.ts";
import { mapPool } from "../judge/limit.ts";
import { mulberry32 } from "../stats/prng.ts";
import { holm } from "../stats/tests.ts";
import { compareExperiments, type Comparison } from "./compare.ts";
import { MatrixPlanError, parsePointer, type MatrixPlan, type MatrixSpec } from "./matrix.ts";
import { experimentResult, prepareGraders, priorRun, rememberIdentity, runTrial, selectCases, storeResult, trialKey, type TrialEnv } from "./run.ts";
import { resolveTask, type TaskSpec } from "./task.ts";
import { DEFAULT_TRIAL_REUSE_MAX_AGE_MS, newestTrialByCell, trialCellKey, trialTaskKey } from "./trial-cells.ts";

/**
 * What a matrix cell of `exp run` may change: the task and the trial count.
 * Graders, dataset and split define the comparison. Takes the raw spec (to
 * check before expanding) or an expanded plan.
 */
export function checkExpPointers(x: MatrixSpec | MatrixPlan): void {
  const pointers =
    "cells" in x
      ? [...x.cells.flatMap((c) => Object.keys(c.overrides)), ...x.vary]
      : [
          ...Object.values(x.matrix ?? {}).map((a) => (a && typeof a === "object" ? a.path : undefined)),
          ...Object.values(x.variants ?? {}).flatMap((o) => (o && typeof o === "object" ? Object.keys(o) : [])),
          ...(Array.isArray(x.vary) ? x.vary : []),
        ].filter((p): p is string => typeof p === "string");
  const fixed = new Set(["graders", "dataset", "split"]);
  for (const p of pointers) {
    const [head] = parsePointer(p);
    if (head !== undefined && fixed.has(head)) throw new MatrixPlanError(`${p}: graders and dataset are not overridable: they define the comparison`, { field: p });
    if (head !== "task" && head !== "trials") throw new MatrixPlanError(`${p}: a cell may only change /task/… and /trials`, { field: p });
  }
}

/** The matrix block each cell's experiment carries in `metadata.matrix`. */
export interface MatrixMeta {
  /** Shared by every cell of one matrix run. */
  id: string;
  name: string;
  cell: string;
  labels?: Record<string, string>;
  baseline: string;
  vary: string[];
  seed: number;
  /** Case-trials of this cell copied from earlier experiments (`exp run --reuse`); absent when none were. */
  reused?: number;
}

/** `exp run --reuse`: copy finished case-trials of the same content key from earlier experiments. */
export interface MatrixReuse {
  /** "baseline": only the baseline cell; "all": every cell. */
  cells: "baseline" | "all";
  /** Only case-trials that started this recently. Default 7 days. */
  maxAgeMs?: number;
  /** Clock for the age check (tests). */
  now?: () => number;
}

export interface MatrixComparison extends Comparison {
  /** Holm-adjusted McNemar p across the non-baseline cells. */
  pHolm: number;
  /** better / worse when pHolm < alpha (direction from the flipped cases), else inconclusive. */
  holmVerdict: "better" | "worse" | "inconclusive";
}

export interface RunMatrixOpts {
  name: string;
  dataset: Dataset;
  graders: readonly Grader[];
  /** Expanded plan; each cell's config holds `task` and optionally `trials`. */
  plan: MatrixPlan;
  /** Only these cells (the baseline always runs). */
  only?: readonly string[];
  split?: Split | readonly Split[];
  filter?: (c: Case) => boolean;
  /** Concurrent case-trials across all cells. Default 4. */
  concurrency?: number;
  store?: FileEvalStore;
  signal?: AbortSignal;
  drain?: AbortSignal;
  /** Checkpoint and resume: each cell records under its own scope; the seed and ids live here. */
  job?: JobScope;
  retry?: RetryPolicy;
  timeoutMs?: number;
  /** Seed for the case order and the cell order within a case-trial. Default random, recorded. */
  seed?: number;
  /** Family-wise level for the Holm verdicts. Default 0.05. */
  alpha?: number;
  bootstrapIters?: number;
  onProgress?: (run: CaseRun, cell: string, done: number, total: number) => void;
  /** Copy finished case-trials of the same content key from earlier experiments in `store`. */
  reuse?: MatrixReuse;
  /** Directory a command task's relative files resolve from, for the content key. Default the process cwd. */
  cwd?: string;
}

export interface MatrixResult {
  id: string;
  seed: number;
  status: "completed" | "cancelled";
  plan: MatrixPlan;
  /** Cell name → stored experiment. */
  experiments: Record<string, ExperimentResult>;
  /** Non-baseline cell name → comparison with the baseline. */
  comparisons: Record<string, MatrixComparison>;
  /** With `reuse`: case-trials copied per cell (every cell listed, 0 included). */
  reused?: Record<string, number>;
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
  }
  return xs;
}

/** Holm across the family of baseline-vs-cell comparisons; a single comparison keeps its raw p. */
export function holmComparisons(comparisons: Record<string, Comparison>, alpha = 0.05): Record<string, MatrixComparison> {
  const names = Object.keys(comparisons);
  const adjusted = holm(names.map((n) => comparisons[n]!.mcnemar.p));
  return Object.fromEntries(
    names.map((n, i) => {
      const c = comparisons[n]!;
      const pHolm = adjusted[i] as number;
      const dir = c.mcnemar.c > c.mcnemar.b ? "better" : c.mcnemar.b > c.mcnemar.c ? "worse" : "inconclusive";
      return [n, { ...c, pHolm, holmVerdict: pHolm < alpha ? dir : "inconclusive" }];
    }),
  );
}

/** Each cell's case-trial keys, and with `reuse` the stored case-trials that can stand in for them. */
export interface MatrixTrialPlan {
  /** Per cell (in `cells` order): the content key of a case-trial, undefined when the task can't be keyed. */
  keyOf: ((c: Case, trial: number) => string | undefined)[];
  /** The stored case-trial to copy for this cell's case-trial, if any. */
  hit: (cell: number, c: Case, trial: number) => { run: CaseRun; experimentId: string } | undefined;
  /** Per cell name: case-trials that would be copied and that must run. */
  counts: Record<string, { reused: number; toRun: number }>;
  /** Cells whose task can't be keyed (a function task), so nothing of them is stamped or reused. */
  unkeyed: string[];
}

export async function planMatrixTrials(o: {
  dataset: Dataset;
  graders: readonly Grader[];
  cells: readonly MatrixPlan["cells"][number][];
  baseline: string;
  split?: Split | readonly Split[];
  filter?: (c: Case) => boolean;
  store?: FileEvalStore;
  reuse?: MatrixReuse;
  cwd?: string;
  timeoutMs?: number;
  /** This run's own experiment ids: never a source. */
  exclude?: ReadonlySet<string>;
}): Promise<MatrixTrialPlan> {
  const taskKeys = o.cells.map((c) => trialTaskKey(c.config.task, o.cwd));
  const graders = o.graders.map((g) => ({ id: g.id, version: g.version }));
  const keyOf = taskKeys.map((taskKey) => (c: Case, trial: number) => (taskKey ? trialCellKey({ datasetId: o.dataset.id, case: c, taskKey, graders, trial, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }) : undefined));
  let byCell = new Map<string, { run: CaseRun; experimentId: string }>();
  if (o.reuse && o.store) {
    const notBefore = (o.reuse.now ?? Date.now)() - (o.reuse.maxAgeMs ?? DEFAULT_TRIAL_REUSE_MAX_AGE_MS);
    byCell = newestTrialByCell(await o.store.listExperiments({ datasetId: o.dataset.id }), notBefore, o.exclude);
  }
  const reusable = (cell: number) => !!o.reuse && (o.reuse.cells === "all" || o.cells[cell]?.name === o.baseline);
  const hit = (cell: number, c: Case, trial: number) => {
    if (!reusable(cell)) return undefined;
    const k = keyOf[cell]?.(c, trial);
    return k ? byCell.get(k) : undefined;
  };
  const cases = selectCases(o.dataset, o.split, o.filter);
  const counts: Record<string, { reused: number; toRun: number }> = {};
  o.cells.forEach((cell, i) => {
    const trials = (cell.config.trials as number | undefined) ?? 1;
    let reused = 0;
    for (const c of cases) for (let t = 1; t <= trials; t++) if (hit(i, c, t)) reused++;
    counts[cell.name] = { reused, toRun: cases.length * trials - reused };
  });
  return { keyOf, hit, counts, unkeyed: o.cells.filter((_, i) => !taskKeys[i]).map((c) => c.name) };
}

export async function runMatrixExperiment(opts: RunMatrixOpts): Promise<MatrixResult> {
  const { plan } = opts;
  checkExpPointers(plan);
  for (const n of opts.only ?? []) if (!plan.cells.some((c) => c.name === n)) throw new MatrixPlanError(`--cell ${n} is not a cell of this matrix (${plan.cells.map((c) => c.name).join(", ")})`, { field: "cell" });
  const cells = plan.cells.filter((c) => c.name === plan.baseline || !opts.only?.length || opts.only.includes(c.name));
  if (cells.length < 2) throw new MatrixPlanError("run at least one cell besides the baseline", { field: "cell" });
  const trialsOf = cells.map((c) => {
    const t = (c.config.trials as number | undefined) ?? 1;
    if (!(Number.isInteger(t) && t >= 1)) throw new MatrixPlanError(`cell ${c.name}: trials must be a positive integer (got ${JSON.stringify(c.config.trials)})`, { field: "trials" });
    return t;
  });
  const tasks = cells.map((c) => {
    if (!c.config.task || typeof c.config.task !== "object") throw new MatrixPlanError(`cell ${c.name} has no task`, { field: "task" });
    return resolveTask(c.config.task as TaskSpec);
  });
  const graders = await prepareGraders(opts.graders, opts.store);
  const job = opts.job;
  const seed = job?.state<number>("seed") ?? opts.seed ?? Math.floor(Math.random() * 2 ** 32);
  if (job && job.state("seed") === undefined) await job.setState("seed", seed);
  const matrixId = job?.state<string>("matrixId") ?? sortableId("mx_");
  if (job && job.state("matrixId") === undefined) await job.setState("matrixId", matrixId);
  const rand = mulberry32(seed);
  const cases = shuffle(selectCases(opts.dataset, opts.split, opts.filter), rand);
  const scopes = cells.map((c) => job?.scope(`cell:${c.name}:`));
  const now = Date.now();
  const ids: string[] = [];
  for (const s of scopes) ids.push((await rememberIdentity(s, { id: sortableId("exp_"), createdAt: now })).id);
  const createdAt = scopes[0]?.state<number>("createdAt") ?? now;

  const jobs: { c: Case; trial: number; cell: number }[] = [];
  const maxTrials = Math.max(...trialsOf);
  for (const c of cases) {
    for (let trial = 1; trial <= maxTrials; trial++) {
      const order = shuffle(cells.map((_, i) => i).filter((i) => (trialsOf[i] as number) >= trial), rand);
      for (const cell of order) jobs.push({ c, trial, cell });
    }
  }
  if (job && job.prefix === "") await job.job.setTotal(jobs.length);
  const trialPlan = await planMatrixTrials({
    dataset: opts.dataset,
    graders,
    cells,
    baseline: plan.baseline,
    ...(opts.split !== undefined ? { split: opts.split } : {}),
    ...(opts.filter ? { filter: opts.filter } : {}),
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.reuse ? { reuse: opts.reuse } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    exclude: new Set(ids),
  });
  const envs: TrialEnv[] = cells.map((_, i) => ({
    runId: ids[i] as string,
    task: tasks[i]!,
    graders,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.drain ? { drain: opts.drain } : {}),
    ...(scopes[i] ? { job: scopes[i] } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    keyOf: trialPlan.keyOf[i]!,
  }));
  const prior = jobs.map((j) => priorRun(scopes[j.cell], j.c.id, j.trial));
  let done = prior.filter(Boolean).length;
  const settled = await mapPool(jobs, opts.concurrency ?? 4, async (j, i) => {
    if (prior[i]) return prior[i];
    if (opts.signal?.aborted || opts.drain?.aborted) return undefined;
    const src = trialPlan.hit(j.cell, j.c, j.trial);
    if (src) {
      // The same case-trial finished in an earlier experiment: copy it, no task call.
      const copy: CaseRun = { ...src.run, reusedFrom: src.experimentId };
      await scopes[j.cell]?.record(trialKey(j.c.id, j.trial), { ms: 0, outcome: copy.pass ? "pass" : "fail", data: copy });
      opts.onProgress?.(copy, cells[j.cell]!.name, ++done, jobs.length);
      return copy;
    }
    const run = await runTrial(envs[j.cell]!, j.c, j.trial);
    if (run) opts.onProgress?.(run, cells[j.cell]!.name, ++done, jobs.length);
    return run;
  });
  const cancelled = settled.some((r) => r === undefined);
  const experiments: Record<string, ExperimentResult> = {};
  const reused: Record<string, number> = {};
  for (const [i, cell] of cells.entries()) {
    const runs = settled.filter((run, j): run is CaseRun => run !== undefined && jobs[j]!.cell === i);
    reused[cell.name] = runs.filter((r) => r.reusedFrom).length;
    const matrix: MatrixMeta = {
      id: matrixId,
      name: opts.name,
      cell: cell.name,
      ...(cell.labels ? { labels: cell.labels } : {}),
      baseline: plan.baseline,
      vary: plan.vary,
      seed,
      ...(reused[cell.name] ? { reused: reused[cell.name] } : {}),
    };
    const r = experimentResult({
      id: ids[i] as string,
      name: `${opts.name}/${cell.name}`,
      status: cancelled ? "cancelled" : "completed",
      dataset: opts.dataset,
      ...(opts.split !== undefined ? { split: opts.split } : {}),
      task: tasks[i]!.info,
      graders,
      trials: trialsOf[i] as number,
      createdAt,
      runs,
      boot: { iters: opts.bootstrapIters ?? 2000, seed: 0x5eed },
      metadata: { matrix },
    });
    if (opts.store) await storeResult(opts.store, r);
    experiments[cell.name] = r;
  }
  const base = experiments[plan.baseline]!;
  const raw: Record<string, Comparison> = {};
  for (const cell of cells) if (cell.name !== plan.baseline) raw[cell.name] = compareExperiments(base, experiments[cell.name]!, { force: true, iters: opts.bootstrapIters ?? 10_000 });
  return { id: matrixId, seed, status: cancelled ? "cancelled" : "completed", plan, experiments, comparisons: holmComparisons(raw, opts.alpha), ...(opts.reuse ? { reused } : {}) };
}

/** The matrix id an experiment belongs to, from `metadata.matrix`. */
export function matrixIdOf(r: Pick<ExperimentResult, "metadata">): string | undefined {
  const m = r.metadata?.matrix as { id?: unknown } | undefined;
  return typeof m?.id === "string" ? m.id : undefined;
}
