// Run a task over a dataset, grade every output, aggregate with honest
// uncertainty, and (optionally) persist the result.
import { performance } from "node:perf_hooks";
import { sortableId } from "../core/ids.ts";
import type { FileEvalStore } from "../datasets/store.ts";
import type {
  Case,
  CaseRun,
  Dataset,
  ExperimentResult,
  ExperimentStatus,
  ExperimentSummary,
  Grader,
  GraderOutcome,
  GraderSummary,
  Split,
  TraceEvent,
} from "../datasets/types.ts";
import type { JobScope } from "../jobs/store.ts";
import { withRetries, type RetryPolicy } from "../jobs/retry.ts";
import { mapPool } from "../judge/limit.ts";
import { pairedBootstrap, wilson } from "../stats/interval.ts";
import { summarize } from "../stats/summary.ts";
import { ADAPTIVE_MAX, ADAPTIVE_TRIALS, allPassKeys, CaseTracker, caseVerdicts, type SamplesMode } from "./samples.ts";
import { resolveTask, type ResolvedTask, type TaskSpec } from "./task.ts";

/** A task may return `withTrace(output, events)` to hand graders (judges) the agent's trace. */
const TRACED = Symbol.for("coding.sh/traced-output");
export interface TracedOutput {
  [TRACED]: true;
  output: unknown;
  trace: TraceEvent[];
}
export function withTrace(output: unknown, trace: TraceEvent[]): TracedOutput {
  return { [TRACED]: true, output, trace };
}
function isTraced(v: unknown): v is TracedOutput {
  return !!v && typeof v === "object" && (v as Record<symbol, unknown>)[TRACED] === true;
}

export interface RunExperimentOpts {
  name: string;
  dataset: Dataset;
  task: TaskSpec;
  graders: readonly Grader[];
  /** Attempts per case. Default 1. */
  trials?: number;
  /** Concurrent case-trials. Default 4. */
  concurrency?: number;
  /** Only cases in these split(s). */
  split?: Split | readonly Split[];
  filter?: (c: Case) => boolean;
  /** Persist the result here when given. */
  store?: FileEvalStore;
  id?: string;
  metadata?: Record<string, unknown>;
  /**
   * Cancels the run: no new case-trial starts, in-flight tasks and graders are
   * killed, and the result has status "cancelled" with only the case-trials
   * that finished before the abort (never the ones it cut short).
   */
  signal?: AbortSignal;
  /**
   * Stops the run gracefully: no new case-trial starts, the ones in flight
   * finish (and are kept), then the result is stored as "cancelled".
   */
  drain?: AbortSignal;
  /**
   * Checkpoint: each finished case-trial is recorded here as it finishes, and
   * case-trials already recorded (a resume) are reused instead of run again.
   * The experiment id and creation time live in it too.
   */
  job?: JobScope;
  /** Retries for infrastructure errors (rate limits, 5xx, network); task failures are never retried. Default: none. */
  retry?: RetryPolicy;
  /** Per case-trial time limit (each attempt); a trial that hits it is a failure, not retried. */
  timeoutMs?: number;
  onProgress?: (run: CaseRun, done: number, total: number) => void;
  /** For the cluster bootstrap when trials > 1. */
  bootstrapIters?: number;
  seed?: number;
  /** "adaptive": two trials per case, a third when they disagree (src/experiments/samples.ts); `trials` is ignored. */
  samples?: SamplesMode;
  /**
   * Stop once a case that passed every graded trial of this baseline fails
   * here (half or more of its trials): no new case-trial starts, the ones in
   * flight finish, and the result is "cancelled" with `regression` set.
   */
  stopOnRegression?: ExperimentResult;
}

/**
 * Persist each LLM judge's version the first time it runs, so `judge
 * calibrate` knows its tuning splits and can record its calibration; a judge
 * already stored keeps its record untouched and grades with the calibration
 * stored there (measured against human labels), not the one it was built with.
 */
async function syncJudges(graders: readonly Grader[], store: FileEvalStore): Promise<Grader[]> {
  return Promise.all(
    graders.map(async (g): Promise<Grader> => {
      if (!g.judgeVersion) return g;
      const stored = await store.getJudge(g.version);
      if (!stored) {
        await store.putJudge(g.judgeVersion);
        return g;
      }
      if (!stored.calibration) return g;
      const calibration = stored.calibration;
      return { id: g.id, version: g.version, kind: g.kind, calibration, judgeVersion: { ...g.judgeVersion, calibration }, grade: (ctx) => g.grade(ctx) };
    }),
  );
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** JSON-safe copy of a task output (functions/symbols/cycles become strings). */
function jsonSafe(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v)) as unknown;
  } catch {
    return String(v);
  }
}

/** Check grader ids are unique and, with a store, sync LLM judges (see syncJudges). */
export async function prepareGraders(graders: readonly Grader[], store?: FileEvalStore): Promise<readonly Grader[]> {
  const ids = new Set<string>();
  for (const g of graders) {
    if (ids.has(g.id)) throw new Error(`two graders share the id ${JSON.stringify(g.id)}; give one a distinct name`);
    ids.add(g.id);
  }
  return store ? syncJudges(graders, store) : graders;
}

/** The dataset's cases in the given split(s) that pass the filter, in dataset order. */
export function selectCases(dataset: Dataset, split?: Split | readonly Split[], filter?: (c: Case) => boolean): Case[] {
  const want = split === undefined ? undefined : new Set<Split>(typeof split === "string" ? [split] : split);
  return dataset.cases.filter((c) => (!want || (c.split !== undefined && want.has(c.split))) && (!filter || filter(c)));
}

/** What one case-trial needs: the experiment it belongs to, its task and graders. */
export interface TrialEnv {
  runId: string;
  task: ResolvedTask;
  graders: readonly Grader[];
  /** Kills the case-trial: it is dropped, not recorded. */
  signal?: AbortSignal;
  /** No new case-trial (or retry) starts once aborted; one already running finishes. */
  drain?: AbortSignal;
  /** Each finished case-trial is recorded here (key: case id + trial). */
  job?: JobScope;
  retry?: RetryPolicy;
  timeoutMs?: number;
  /** The content key a case-trial is stamped with (matrix runs, experiments/trial-cells.ts). */
  keyOf?: (c: Case, trial: number) => string | undefined;
}

/** The checkpoint key of a case-trial. */
export const trialKey = (caseId: string, trial: number): string => `${caseId}\u0000${trial}`;

/** A case-trial a resumed run can keep: recorded with a known outcome (not an infra error). */
export function priorRun(job: JobScope | undefined, caseId: string, trial: number): CaseRun | undefined {
  const l = job?.done(trialKey(caseId, trial));
  return l && !l.infra && l.data && typeof l.data === "object" ? (l.data as CaseRun) : undefined;
}

/** What a task reported it cost: `costUsd` (or cost_usd, usage.costUsd) on its output object. */
export function costOf(output: unknown): number | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  const u = (o.usage && typeof o.usage === "object" ? o.usage : {}) as Record<string, unknown>;
  for (const v of [o.costUsd, o.cost_usd, u.costUsd, u.cost_usd]) if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  return undefined;
}

/** One attempt of the task: its output (and trace) or its error. A per-attempt timeout is the task's failure. */
async function attemptTask(env: TrialEnv, c: Case, trial: number): Promise<{ output?: unknown; trace?: TraceEvent[]; error?: string }> {
  const { signal, task } = env;
  const timer = env.timeoutMs ? AbortSignal.timeout(env.timeoutMs) : undefined;
  const sig = timer ? (signal ? AbortSignal.any([signal, timer]) : timer) : signal;
  const timedOut = () => !!timer?.aborted && !signal?.aborted;
  try {
    const raw = await task.run(c.input, {
      runId: env.runId,
      caseId: c.id,
      trial,
      ...(c.metadata ? { metadata: c.metadata } : {}),
      ...(sig ? { signal: sig } : {}),
    });
    if (timedOut()) return { error: `timed out after ${env.timeoutMs} ms (trial timeout)` };
    return isTraced(raw) ? { output: raw.output, trace: raw.trace } : { output: raw };
  } catch (e) {
    if (timedOut()) return { error: `timed out after ${env.timeoutMs} ms (trial timeout)` };
    return { error: errMessage(e) };
  }
}

/** Every grader on one output; a grader that throws gives an error outcome, not a fail. Shared by runTrial and regradeExperiment. */
/**
 * Whether a grader error leaves the run's outcome unknown. A run passes only
 * when every grader passes, so one grader's fail settles it even when another
 * grader errored: a judge outage leaves out only the runs it could have changed.
 */
export function gradeUnknown(grades: readonly GraderOutcome[]): boolean {
  return grades.some((g) => g.error !== undefined) && !grades.some((g) => g.result?.pass === false);
}

export async function gradeOne(graders: readonly Grader[], c: Case, output: unknown, trace?: TraceEvent[], signal?: AbortSignal): Promise<GraderOutcome[]> {
  return Promise.all(
    graders.map(async (g): Promise<GraderOutcome> => {
      try {
        const result = await g.grade({
          input: c.input,
          output,
          expected: c.expected,
          caseId: c.id,
          ...(c.metadata ? { metadata: c.metadata } : {}),
          ...(trace ? { trace } : {}),
          ...(signal ? { signal } : {}),
        });
        return { graderId: g.id, result };
      } catch (e) {
        return { graderId: g.id, error: errMessage(e) };
      }
    }),
  );
}

/**
 * Run and grade one case-trial, retrying infrastructure errors with backoff.
 * Undefined when it was not run (stopped before it started) or the signal
 * killed it part way: a killed task says nothing about the agent. A trial whose
 * last attempt still hit an infra error comes back with `infra` set and
 * `ungraded`: outcome unknown, and a resume runs it again.
 */
export async function runTrial(env: TrialEnv, c: Case, trial: number): Promise<CaseRun | undefined> {
  const { signal, graders } = env;
  if (signal?.aborted || env.drain?.aborted) return undefined; // stopped before it started: not a run
  const startedAt = Date.now();
  const t0 = performance.now();
  const tried = await withRetries(() => attemptTask(env, c, trial), {
    policy: env.retry ?? { retries: 0, baseMs: 0, maxMs: 0 },
    errorOf: (a) => a.error,
    stop: [signal, env.drain],
  });
  const { output, trace, error } = tried.result;
  const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
  const grades: GraderOutcome[] = error !== undefined || signal?.aborted ? [] : await gradeOne(graders, c, output, trace, signal);
  // The abort cut this case-trial short (killed task or grader): its outcome says nothing about the agent.
  if (signal?.aborted) return undefined;
  const ungraded = tried.infra !== undefined || (error === undefined && gradeUnknown(grades));
  const run: CaseRun = {
    caseId: c.id,
    trial,
    latencyMs,
    grades,
    pass: error === undefined && !ungraded && grades.every((g) => g.result?.pass === true),
    startedAt,
  };
  if (ungraded) run.ungraded = true;
  if (tried.infra) run.infra = tried.infra;
  if (tried.attempts > 1) run.attempts = tried.attempts;
  const safe = jsonSafe(output);
  if (safe !== undefined) run.output = safe;
  if (error !== undefined) run.error = error;
  const cost = costOf(output);
  if (cost !== undefined) run.costUsd = cost;
  const key = env.keyOf?.(c, trial);
  if (key) run.cellKey = key;
  if (env.job) {
    await env.job.record(trialKey(c.id, trial), {
      ms: latencyMs,
      ...(run.attempts ? { attempts: run.attempts } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
      ...(run.infra ? { infra: run.infra } : {}),
      outcome: run.error !== undefined ? "error" : run.pass ? "pass" : "fail",
      data: run,
    });
  }
  return run;
}

/** The stored record of a finished (or cancelled) run. */
export function experimentResult(o: {
  id: string;
  name: string;
  status: ExperimentStatus;
  dataset: Dataset;
  split?: Split | readonly Split[];
  task: ResolvedTask["info"];
  graders: readonly Grader[];
  trials: number;
  createdAt: number;
  runs: CaseRun[];
  boot: { iters: number; seed: number };
  metadata?: Record<string, unknown>;
  samples?: SamplesMode;
  regression?: ExperimentResult["regression"];
}): ExperimentResult {
  const result: ExperimentResult = {
    id: o.id,
    name: o.name,
    status: o.status,
    dataset: {
      id: o.dataset.id,
      name: o.dataset.name,
      version: o.dataset.version,
      ...(typeof o.split === "string" ? { split: o.split } : {}),
    },
    task: o.task,
    graders: o.graders.map((g) => ({ id: g.id, version: g.version, kind: g.kind, ...(g.calibration ? { calibration: g.calibration } : {}) })),
    trials: o.trials,
    createdAt: o.createdAt,
    finishedAt: Date.now(),
    runs: o.runs,
    summary: summarizeRuns(o.runs, o.graders, o.trials, o.boot),
  };
  if (o.metadata) result.metadata = o.metadata;
  if (o.samples === "adaptive") {
    result.samples = "adaptive";
    result.summary.caseVerdicts = caseVerdicts(o.runs.map((r) => ({ key: r.caseId, pass: r.ungraded ? undefined : r.pass })));
  }
  if (o.regression) result.regression = o.regression;
  return result;
}

/** Store the final record (a resumed run overwrites its cancelled one: same id). */
export async function storeResult(store: FileEvalStore, result: ExperimentResult): Promise<void> {
  await store.putExperiment(result);
}

/**
 * The experiment id and creation time a job scope remembers (a resume reuses
 * them), else `fresh` ones, which it remembers from now on.
 */
export async function rememberIdentity(job: JobScope | undefined, fresh: { id: string; createdAt: number }): Promise<{ id: string; createdAt: number }> {
  const id = job?.state<string>("experimentId");
  const createdAt = job?.state<number>("createdAt");
  if (id && createdAt !== undefined) return { id, createdAt };
  if (job) {
    await job.setState("experimentId", fresh.id);
    await job.setState("createdAt", fresh.createdAt);
    await job.job.addRefs(fresh.id);
  }
  return fresh;
}

export async function runExperiment(opts: RunExperimentOpts): Promise<ExperimentResult> {
  const adaptive = opts.samples === "adaptive";
  const trials = adaptive ? ADAPTIVE_TRIALS : (opts.trials ?? 1);
  if (!(Number.isInteger(trials) && trials >= 1)) throw new RangeError(`trials must be a positive integer (got ${trials})`);
  const graders = await prepareGraders(opts.graders, opts.store);
  const cases = selectCases(opts.dataset, opts.split, opts.filter);
  const task = resolveTask(opts.task);
  const job = opts.job;
  const { id, createdAt } = await rememberIdentity(job, { id: opts.id ?? sortableId("exp_"), createdAt: Date.now() });
  const jobs: { c: Case; trial: number }[] = [];
  for (const c of cases) for (let t = 1; t <= trials; t++) jobs.push({ c, trial: t });
  if (job && job.prefix === "") await job.job.setTotal(jobs.length);
  const { signal } = opts;
  const outcome = (r: CaseRun) => ({ key: r.caseId, pass: r.ungraded ? undefined : r.pass });
  const base = opts.stopOnRegression;
  const tracker = new CaseTracker(adaptive ? "adaptive" : "fixed", trials, base ? allPassKeys(base.runs.map(outcome)) : undefined);
  // A regression stops the run like a graceful drain: nothing new starts, runs in flight finish.
  const stop = new AbortController();
  let regression: ExperimentResult["regression"];
  const drain = opts.drain ? AbortSignal.any([opts.drain, stop.signal]) : stop.signal;
  const settle = (run: CaseRun | undefined): CaseRun | undefined => {
    if (run && tracker.add(run.caseId, outcome(run).pass) && !regression) {
      regression = { caseId: run.caseId, baseline: base!.id };
      stop.abort();
    }
    return run;
  };
  let done = 0;
  let total = jobs.length;
  const env: TrialEnv = {
    runId: id,
    task,
    graders,
    drain,
    ...(signal ? { signal } : {}),
    ...(job ? { job } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };
  const runAll = async (list: { c: Case; trial: number }[]) => {
    // A resume keeps every case-trial already recorded with a known outcome.
    const prior = list.map(({ c, trial }) => priorRun(job, c.id, trial));
    done += prior.filter(Boolean).length;
    return mapPool(list, opts.concurrency ?? 4, async ({ c, trial }, i) => {
      if (prior[i]) return settle(prior[i]);
      const run = await runTrial(env, c, trial);
      if (run) opts.onProgress?.(run, ++done, total);
      return settle(run);
    });
  };
  const settled = await runAll(jobs);
  // Adaptive: a third trial for each case whose first two disagree.
  const ties = adaptive && !drain.aborted && !signal?.aborted ? cases.filter((c) => tracker.needsTieBreak(c.id)).map((c) => ({ c, trial: ADAPTIVE_MAX })) : [];
  if (ties.length) {
    total += ties.length;
    if (job && job.prefix === "") await job.job.setTotal(total);
    settled.push(...(await runAll(ties)));
  }
  const result = experimentResult({
    id,
    name: opts.name,
    // Cancelled when some case-trial never ran or was cut short (infra-failed ones did run), or a regression stopped it.
    status: settled.some((r) => r === undefined) || regression ? "cancelled" : "completed",
    ...(adaptive ? { samples: "adaptive" as const } : {}),
    ...(regression ? { regression } : {}),
    dataset: opts.dataset,
    ...(opts.split !== undefined ? { split: opts.split } : {}),
    task: task.info,
    graders,
    trials,
    createdAt,
    runs: settled.filter((r): r is CaseRun => r !== undefined),
    boot: { iters: opts.bootstrapIters ?? 2000, seed: opts.seed ?? 0x5eed },
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });
  if (opts.store) await storeResult(opts.store, result);
  return result;
}

export interface RegradeOpts {
  /** The stored experiment whose outputs are graded again. */
  result: ExperimentResult;
  /** Its dataset (any version with the same id; a different version only warns). */
  dataset: Dataset;
  graders: readonly Grader[];
  concurrency?: number;
  /** Aborting returns a "cancelled" result, which is never stored. */
  signal?: AbortSignal;
  store?: FileEvalStore;
  id?: string;
  name?: string;
  onWarn?: (message: string) => void;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Grade a stored experiment's outputs again with (new) graders, without
 * calling the task: a grader change is a new measurement of the same outputs
 * (X-21). Runs whose task errored or failed on infrastructure are copied as
 * they were. Stored runs keep no trace, so graders that read one see none
 * (`metadata.regradeNoTrace`). The result is a new experiment with
 * `metadata.regradeOf` set; it is stored only when it completed.
 */
export async function regradeExperiment(o: RegradeOpts): Promise<ExperimentResult> {
  const prev = o.result;
  if (o.dataset.id !== prev.dataset.id) throw new Error(`experiment ${prev.id} ran on dataset ${prev.dataset.id}, not ${o.dataset.id}`);
  if (o.dataset.version !== prev.dataset.version) o.onWarn?.(`dataset ${o.dataset.id} is at version ${o.dataset.version}; ${prev.id} ran on ${prev.dataset.version}, so expected values may differ`);
  const graders = await prepareGraders(o.graders, o.store);
  const cases = new Map(o.dataset.cases.map((c) => [c.id, c]));
  let missing = 0;
  let done = 0;
  const createdAt = Date.now();
  const settled = await mapPool(prev.runs, o.concurrency ?? 4, async (run): Promise<CaseRun | undefined> => {
    if (o.signal?.aborted) return undefined;
    const c = cases.get(run.caseId);
    if (run.error !== undefined || run.infra || !c) {
      if (!c && run.error === undefined && !run.infra) missing++;
      o.onProgress?.(++done, prev.runs.length);
      return run;
    }
    const grades = await gradeOne(graders, c, run.output, undefined, o.signal);
    if (o.signal?.aborted) return undefined;
    const ungraded = gradeUnknown(grades);
    const { ungraded: _u, ...rest } = run;
    const next: CaseRun = { ...rest, grades, pass: !ungraded && grades.every((g) => g.result?.pass === true) };
    if (ungraded) next.ungraded = true;
    o.onProgress?.(++done, prev.runs.length);
    return next;
  });
  if (missing) o.onWarn?.(`${missing} run(s) name cases that are not in dataset ${o.dataset.id}@${o.dataset.version}; they keep their old grades`);
  const result = experimentResult({
    id: o.id ?? sortableId("exp_"),
    name: o.name ?? prev.name,
    status: settled.some((r) => r === undefined) ? "cancelled" : "completed",
    dataset: o.dataset,
    ...(prev.dataset.split ? { split: prev.dataset.split } : {}),
    task: prev.task,
    graders,
    trials: prev.trials,
    createdAt,
    runs: settled.filter((r): r is CaseRun => r !== undefined),
    boot: { iters: 2000, seed: 0x5eed },
    metadata: { ...prev.metadata, regradeOf: prev.id, regradeNoTrace: true },
  });
  if (o.store && result.status === "completed") await storeResult(o.store, result);
  return result;
}

/** Per-case pass rate (fraction of graded trials passed), keyed by case id, in first-seen order. Ungraded runs are left out. */
export function caseRates(runs: readonly CaseRun[]): Map<string, number> {
  const acc = new Map<string, { pass: number; n: number }>();
  for (const r of runs) {
    if (r.ungraded) continue; // outcome unknown: neither a pass nor a fail
    const a = acc.get(r.caseId) ?? { pass: 0, n: 0 };
    a.n++;
    if (r.pass) a.pass++;
    acc.set(r.caseId, a);
  }
  return new Map([...acc].map(([k, v]) => [k, v.pass / v.n]));
}

export function summarizeRuns(
  runs: readonly CaseRun[],
  graders: readonly Pick<Grader, "id" | "kind" | "calibration">[],
  trials: number,
  boot: { iters: number; seed: number } = { iters: 2000, seed: 0x5eed },
): ExperimentSummary {
  const n = runs.length;
  const passed = runs.filter((r) => r.pass).length;
  const errors = runs.filter((r) => r.error !== undefined).length;
  const ungraded = runs.filter((r) => r.ungraded).length;
  const infra = runs.filter((r) => r.infra).length;
  const graded = n - ungraded;
  const rates = caseRates(runs);
  let passRate: ExperimentSummary["passRate"];
  let ciMethod: ExperimentSummary["ciMethod"];
  if (trials <= 1) {
    passRate = wilson(passed, graded);
    ciMethod = "wilson";
  } else {
    // Trials of one case are correlated; resample cases, not trials.
    const b = pairedBootstrap([...rates.values()], { iters: boot.iters, seed: boot.seed });
    passRate = { p: graded ? passed / graded : NaN, lo: Number.isNaN(b.lo) ? 0 : b.lo, hi: Number.isNaN(b.hi) ? 1 : b.hi };
    ciMethod = "cluster-bootstrap";
  }
  const gs: GraderSummary[] = graders.map((g) => {
    let gn = 0;
    let gp = 0;
    let ge = 0;
    let sum = 0;
    for (const r of runs) {
      const o = r.grades.find((x) => x.graderId === g.id);
      if (!o) continue;
      if (o.error !== undefined) {
        ge++;
        continue;
      }
      if (!o.result) continue;
      gn++;
      sum += o.result.score;
      if (o.result.pass) gp++;
    }
    const s: GraderSummary = { id: g.id, kind: g.kind, n: gn, passed: gp, errors: ge, meanScore: gn ? sum / gn : NaN, passRate: wilson(gp, gn) };
    if (g.calibration) s.calibration = g.calibration;
    return s;
  });
  const lat = summarize(runs.map((r) => r.latencyMs));
  return {
    n,
    cases: new Set(runs.map((r) => r.caseId)).size,
    passed,
    errors,
    ungraded,
    ...(infra ? { infra } : {}),
    passRate,
    ciMethod,
    graders: gs,
    latencyMs: { mean: lat.mean, median: lat.median, p90: lat.p90, max: lat.max },
  };
}
