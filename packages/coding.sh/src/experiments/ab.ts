// Interleaved A/B runs (EM-2) with optional group sequential early stopping
// (EM-3). Both arms share one job queue: cases in a seeded random order, and
// for each case-trial the two arms in a random order, next to each other. So
// provider drift, rate limits and time of day hit both arms alike, instead of
// landing on whichever arm ran second (Bjarnason et al., "On Randomness in
// Agentic Evals", 2026, https://arxiv.org/abs/2602.07150).
//
// With early stopping, looks happen at planned paired-case counts along the
// schedule: look k waits until the first n_k cases of the schedule have every
// trial of both arms done, however long one of them takes. Deciding on the
// first n_k cases to *finish* would bias the look toward fast cases, and fast
// often means failed. Once a boundary is crossed, in-flight case-trials are
// killed and the stored arms hold exactly the cases the decision saw.
import { sortableId } from "../core/ids.ts";
import type { FileEvalStore } from "../datasets/store.ts";
import type { Case, CaseRun, Dataset, ExperimentResult, Grader, Split } from "../datasets/types.ts";
import { mapPool } from "../judge/limit.ts";
import { mulberry32 } from "../stats/prng.ts";
import { planSequential, sequentialLook, sequentialOutcome, type LookResult, type SequentialOutcome } from "../stats/sequential.ts";
import { caseRates, experimentResult, prepareGraders, runTrial, selectCases, storeResult, type TrialEnv } from "./run.ts";
import { resolveTask, type TaskSpec } from "./task.ts";

export interface AbArm {
  /** Arm name; the experiment is stored as `<name>-<arm>`. */
  name: string;
  task: TaskSpec;
}

export interface StopEarlyOpts {
  /** Planned looks, evenly spaced over the case budget. Default 4. */
  looks?: number;
  /** Two-sided level. Default 0.05. */
  alpha?: number;
  /** No look before this many paired cases. Default MIN_LOOK_CASES (20). */
  minCases?: number;
}

export interface RunAbOpts {
  name: string;
  dataset: Dataset;
  /** A (baseline) then B (candidate). */
  arms: readonly [AbArm, AbArm];
  graders: readonly Grader[];
  trials?: number;
  /** Concurrent case-trials across both arms. Default 4. */
  concurrency?: number;
  split?: Split | readonly Split[];
  filter?: (c: Case) => boolean;
  store?: FileEvalStore;
  signal?: AbortSignal;
  /** Seed for the case order and the arm order. Default: random (recorded on both arms). */
  seed?: number;
  /** Run at most this many cases (a random subset, by the seed). */
  maxCases?: number;
  /** Group sequential early stopping over the case budget. */
  stopEarly?: boolean | StopEarlyOpts;
  bootstrapIters?: number;
  onProgress?: (run: CaseRun, arm: 0 | 1, done: number, total: number) => void;
  onLook?: (look: LookResult) => void;
}

export interface AbResult {
  pairId: string;
  seed: number;
  a: ExperimentResult;
  b: ExperimentResult;
  sequential?: SequentialOutcome;
}

/** Per-case (B − A) pass-rate differences over the given cases, in their order; cases ungraded in an arm are left out. */
export function pairedDiffs(a: readonly CaseRun[], b: readonly CaseRun[], caseIds: readonly string[]): number[] {
  const ra = caseRates(a);
  const rb = caseRates(b);
  const out: number[] = [];
  for (const id of caseIds) {
    const x = ra.get(id);
    const y = rb.get(id);
    if (x !== undefined && y !== undefined) out.push(y - x);
  }
  return out;
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
  }
  return xs;
}

export async function runAb(opts: RunAbOpts): Promise<AbResult> {
  const trials = opts.trials ?? 1;
  if (!(Number.isInteger(trials) && trials >= 1)) throw new RangeError(`trials must be a positive integer (got ${trials})`);
  const [armA, armB] = opts.arms;
  if (armA.name === armB.name) throw new Error(`the two arms share the name ${JSON.stringify(armA.name)}`);
  if (opts.maxCases !== undefined && !(Number.isInteger(opts.maxCases) && opts.maxCases >= 1)) throw new RangeError(`maxCases must be a positive integer (got ${opts.maxCases})`);
  const graders = await prepareGraders(opts.graders, opts.store);
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 32);
  const rand = mulberry32(seed);
  const cases = shuffle(selectCases(opts.dataset, opts.split, opts.filter), rand).slice(0, opts.maxCases);
  const tasks = [resolveTask(armA.task), resolveTask(armB.task)] as const;
  const ids: [string, string] = [sortableId("exp_"), sortableId("exp_")];
  const names = [`${opts.name}-${armA.name}`, `${opts.name}-${armB.name}`] as const;
  const pairId = sortableId("pair_");
  const createdAt = Date.now();

  const jobs: { ci: number; c: Case; trial: number; arm: 0 | 1 }[] = [];
  cases.forEach((c, ci) => {
    for (let trial = 1; trial <= trials; trial++) {
      const first: 0 | 1 = rand() < 0.5 ? 0 : 1;
      jobs.push({ ci, c, trial, arm: first }, { ci, c, trial, arm: first === 0 ? 1 : 0 });
    }
  });

  const se = opts.stopEarly;
  const plan = se && cases.length ? planSequential(cases.length, se === true ? {} : se) : undefined;
  // Stopping early kills in-flight case-trials like a cancel does, but the run still counts as completed.
  const stop = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
  const store = opts.store;
  const envs: [TrialEnv, TrialEnv] = [0, 1].map((i) => ({ runId: ids[i]!, task: tasks[i]!, graders, signal, ...(store ? { store } : {}) })) as [TrialEnv, TrialEnv];
  if (store) {
    for (const i of [0, 1] as const) {
      await store.appendExperimentLog(ids[i], { type: "start", status: "running", id: ids[i], name: names[i], total: jobs.length / 2, createdAt });
    }
  }

  const left = cases.map(() => 2 * trials); // case-trials still to finish, per case
  const finished: [CaseRun[], CaseRun[]] = [[], []];
  const history: LookResult[] = [];
  let ready = 0; // leading cases of the schedule with every case-trial done
  let stopAt: number | undefined; // cases kept: the planned count at the deciding look
  let done = 0;
  const take = () => {
    while (ready < cases.length && left[ready] === 0) ready++;
    while (plan && stopAt === undefined && history.length < plan.looks.length && (plan.looks[history.length] as number) <= ready) {
      const n = plan.looks[history.length] as number;
      const look = sequentialLook(plan, history.length + 1, pairedDiffs(finished[0], finished[1], cases.slice(0, n).map((c) => c.id)));
      history.push(look);
      opts.onLook?.(look);
      if (look.crossed || history.length === plan.looks.length) {
        stopAt = n;
        if (n < cases.length) stop.abort();
      }
    }
  };

  const settled = await mapPool(jobs, opts.concurrency ?? 4, async (job) => {
    const run = await runTrial(envs[job.arm], job.c, job.trial);
    if (!run) return undefined;
    finished[job.arm].push(run);
    left[job.ci]!--;
    opts.onProgress?.(run, job.arm, ++done, jobs.length);
    take();
    return run;
  });

  const cancelled = opts.signal?.aborted === true;
  const keep = stopAt ?? cases.length;
  const sequential = plan ? sequentialOutcome(plan, history) : undefined;
  const results = ([0, 1] as const).map((i) => {
    const r = experimentResult({
      id: ids[i],
      name: names[i],
      status: cancelled ? "cancelled" : "completed",
      dataset: opts.dataset,
      ...(opts.split !== undefined ? { split: opts.split } : {}),
      task: tasks[i].info,
      graders,
      trials,
      createdAt,
      // Schedule order; after an early stop, only the cases the deciding look saw.
      runs: settled.filter((run, j): run is CaseRun => run !== undefined && jobs[j]!.arm === i && jobs[j]!.ci < keep),
      boot: { iters: opts.bootstrapIters ?? 2000, seed: 0x5eed },
    });
    r.pair = { id: pairId, arm: opts.arms[i].name, experiments: ids, seed, ...(sequential ? { sequential } : {}) };
    return r;
  }) as [ExperimentResult, ExperimentResult];
  if (store) for (const r of results) await storeResult(store, r);
  return { pairId, seed, a: results[0], b: results[1], ...(sequential ? { sequential } : {}) };
}
