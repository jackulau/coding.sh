// `exp sweep` (EM-17): race N task configs on a selection split with
// Sequential Halving, then re-score the winner and the start config on a
// held-out split and report the optimism gap.
//
// Sequential Halving splits a fixed budget evenly over ⌈log2 N⌉ rounds. Each
// round runs every surviving config on the same fresh batch of cases, ranks
// them on all the cases seen so far, and keeps the better half. It is the
// standard fixed-budget best-arm method, and the one TRIPLE found strong for
// picking prompts under a budget:
//   Karnin, Koren, Somekh, "Almost Optimal Exploration in Multi-Armed
//   Bandits", ICML 2013, https://proceedings.mlr.press/v28/karnin13.html
//   Shi et al., "TRIPLE: best-arm identification for prompt learning", 2024,
//   https://arxiv.org/abs/2402.09723
// Survivors share cases (paired), and each round's jobs are interleaved in
// one seeded queue as in exp run --arm, so drift hits every config alike.
//
// The winner's score on the cases that picked it is biased upward: the most
// lucky config tends to win. Re-scoring on cases the race never saw removes
// that bias, and the difference is the optimism gap. On the same held-out
// cases, the acceptance gate (SAGE, stats/tests.ts) says adopt the winner or
// keep the start config. The gap itself:
//   Hu, Tang, "The Winner's Curse in LLM Self-Improvement Loops", 2026,
//   https://arxiv.org/abs/2610.09239
import { sortableId } from "../core/ids.ts";
import type { FileEvalStore } from "../datasets/store.ts";
import type { Case, CaseRun, Dataset, ExperimentResult, Grader, Interval, Split } from "../datasets/types.ts";
import type { JobScope } from "../jobs/store.ts";
import type { RetryPolicy } from "../jobs/retry.ts";
import { mapPool } from "../judge/limit.ts";
import { pairedBootstrap } from "../stats/interval.ts";
import { mulberry32 } from "../stats/prng.ts";
import { runAb } from "./ab.ts";
import { compareExperiments, type Comparison, type ComparisonGate } from "./compare.ts";
import { caseRates, experimentResult, prepareGraders, priorRun, rememberIdentity, runExperiment, runTrial, selectCases, storeResult, type TrialEnv } from "./run.ts";
import { resolveTask, type TaskSpec } from "./task.ts";

/** Held-out share when the dataset has no splits and the sweep makes its own. */
export const RANDOM_HOLDOUT = 0.3;

export interface SweepConfig {
  name: string;
  task: TaskSpec;
}

export interface RunSweepOpts {
  name: string;
  dataset: Dataset;
  /** The first one is the start (baseline) config. */
  configs: readonly SweepConfig[];
  graders: readonly Grader[];
  /** Case runs on the selection split, over all configs and rounds. Default: what uses every selection case once by the last round. */
  budget?: number;
  /** Split the race runs on. Default "train". */
  select?: Split;
  /** Split the winner is re-scored on. Default "test". */
  heldOut?: Split;
  concurrency?: number;
  store?: FileEvalStore;
  signal?: AbortSignal;
  /** Graceful stop: no new case run starts, the ones in flight finish. */
  drain?: AbortSignal;
  /**
   * Checkpoint and resume: each finished case run is recorded here, and a
   * resume reuses the seed, ids and finished runs, so every round ranks (and
   * drops) the same configs as the uninterrupted sweep would have.
   */
  job?: JobScope;
  retry?: RetryPolicy;
  timeoutMs?: number;
  /** Seed for the case order, the job order and rank ties. Default random (recorded). */
  seed?: number;
  bootstrapIters?: number;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface SweepRoundConfig {
  config: string;
  /** Pass rate over every selection case this config has run so far. */
  passRate: number;
  n: number;
  kept: boolean;
  /** Dropped configs: paired difference against the round's leader on the same cases, with a bootstrap CI. */
  vsLeader?: { mean: number; lo: number; hi: number };
}

export interface SweepRound {
  round: number;
  /** New cases each surviving config ran this round. */
  cases: number;
  /** Cases each surviving config has run so far. */
  totalCases: number;
  configs: SweepRoundConfig[];
}

export interface SweepConfigResult {
  name: string;
  task: ExperimentResult["task"];
  /** The stored experiment with this config's selection-split runs. */
  experiment: string;
  train: { passRate: number; n: number };
  /** Round it was dropped in (1-based); absent for the winner. */
  droppedIn?: number;
}

export interface SweepResult {
  name: string;
  seed: number;
  method: "sequential-halving";
  status: "completed" | "cancelled";
  budget: number;
  /** Case runs the race used on the selection split. */
  used: number;
  splits: {
    select: Split;
    heldOut: Split;
    /** "dataset": the cases' own splits. "random": the dataset had none, so the sweep held out a seeded 30%. */
    source: "dataset" | "random";
    selectCases: number;
    heldOutCases: number;
  };
  rounds: SweepRound[];
  configs: SweepConfigResult[];
  winner?: {
    name: string;
    /** Score on the cases that picked it. */
    train: { passRate: number; n: number };
    heldOut: Interval & { n: number; experiment: string };
    /** train − held-out: how much the race overstates the winner. */
    optimismGap: number;
  };
  /** The start config on the held-out split (same as the winner when it won). */
  start?: { name: string; heldOut: Interval & { n: number; experiment: string } };
  /** Winner (B) against the start config (A) on the held-out split, interleaved; absent when the start config won. */
  comparison?: Comparison;
  /**
   * Adopt the winner or keep the start config: the acceptance gate (default
   * settings) on that held-out comparison. Absent when the start config won.
   */
  adopt?: ComparisonGate;
  notes: string[];
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
  }
  return xs;
}

/** Survivors per round: ⌈s/2⌉ repeatedly, from N down to 1. */
export function halvingSchedule(n: number): number[] {
  const out: number[] = [];
  for (let s = n; s > 1; s = Math.ceil(s / 2)) out.push(s);
  return out;
}

/** Default budget: the largest whose per-round batches fit the selection split once. */
export function defaultBudget(configs: number, cases: number): number {
  const sched = halvingSchedule(configs);
  const R = sched.length;
  return Math.floor((cases * R) / sched.reduce((s, x) => s + 1 / x, 0));
}

/** Selection and held-out cases: the dataset's splits, or a seeded random split when it has none. */
function splitCases(ds: Dataset, select: Split, heldOut: Split, rand: () => number): { sel: Case[]; held: Case[]; source: "dataset" | "random" } {
  if (select === heldOut) throw new RangeError(`the selection and held-out splits are both "${select}"; the held-out split must be one the race never sees`);
  const sel = selectCases(ds, select);
  const held = selectCases(ds, heldOut);
  if (sel.length && held.length) return { sel, held, source: "dataset" };
  if (ds.cases.some((c) => c.split !== undefined)) {
    throw new RangeError(`dataset ${ds.name} has no cases in the "${sel.length ? heldOut : select}" split (${sel.length} ${select}, ${held.length} ${heldOut})`);
  }
  if (ds.cases.length < 2) throw new RangeError(`dataset ${ds.name} needs at least 2 cases to hold some out`);
  const all = shuffle([...ds.cases], rand);
  const k = Math.min(all.length - 1, Math.max(1, Math.round(all.length * RANDOM_HOLDOUT)));
  return { sel: all.slice(k), held: all.slice(0, k), source: "random" };
}

const rateOf = (runs: readonly CaseRun[]) => {
  const r = [...caseRates(runs).values()];
  return { passRate: r.length ? r.reduce((s, x) => s + x, 0) / r.length : NaN, n: r.length };
};

export async function runSweep(opts: RunSweepOpts): Promise<SweepResult> {
  const N = opts.configs.length;
  if (N < 2) throw new RangeError(`a sweep needs at least 2 configs (got ${N})`);
  const names = new Set<string>();
  for (const c of opts.configs) {
    if (names.has(c.name)) throw new RangeError(`two configs share the name ${JSON.stringify(c.name)}`);
    names.add(c.name);
  }
  const select = opts.select ?? "train";
  const heldOut = opts.heldOut ?? "test";
  const job = opts.job;
  const seed = job?.state<number>("seed") ?? opts.seed ?? Math.floor(Math.random() * 2 ** 32);
  const rand = mulberry32(seed);
  const { sel, held, source } = splitCases(opts.dataset, select, heldOut, rand);
  const order = source === "dataset" ? shuffle([...sel], rand) : sel; // a random split is already shuffled
  const schedule = halvingSchedule(N);
  const R = schedule.length;
  const budget = opts.budget ?? defaultBudget(N, order.length);
  if (!(Number.isInteger(budget) && budget >= 1)) throw new RangeError(`budget must be a positive integer (got ${budget})`);
  if (Math.floor(budget / (N * R)) < 1) {
    throw new RangeError(`budget ${budget} is too small for ${N} configs over ${R} rounds: it needs at least ${N * R} case runs (1 new case per config per round)`);
  }
  const graders = await prepareGraders(opts.graders, opts.store);
  const tasks = opts.configs.map((c) => resolveTask(c.task));
  if (job && job.state("seed") === undefined) await job.setState("seed", seed);
  const scopes = opts.configs.map((_, i) => job?.scope(`c${i}:`));
  const now = Date.now();
  const ids: string[] = [];
  for (const sc of scopes) ids.push((await rememberIdentity(sc, { id: sortableId("exp_"), createdAt: now })).id);
  const createdAt = scopes[0]?.state<number>("createdAt") ?? now;
  // The plan: race case runs per round (survivors are known ahead), plus a held-out A/B (revised once the race ends).
  if (job && job.prefix === "") {
    let raceRuns = 0;
    let left = order.length;
    for (const s of schedule) {
      const take = Math.min(left, Math.max(1, Math.floor(budget / (s * R))));
      left -= take;
      raceRuns += take * s;
    }
    await job.job.setTotal(raceRuns + 2 * held.length);
  }
  const expNames = opts.configs.map((c) => `${opts.name}-${c.name}`);
  const store = opts.store;
  const { signal, drain } = opts;
  const envs: TrialEnv[] = tasks.map((task, i) => ({
    runId: ids[i]!,
    task,
    graders,
    ...(signal ? { signal } : {}),
    ...(drain ? { drain } : {}),
    ...(scopes[i] ? { job: scopes[i] } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  }));
  // Random rank for exact ties, so no config (the start one included) wins ties by position.
  const tiebreak = shuffle(opts.configs.map((_, i) => i), rand);
  const tieRank = new Map(tiebreak.map((ci, r) => [ci, r]));
  const runs: CaseRun[][] = opts.configs.map(() => []);
  const droppedIn = new Map<number, number>();
  const rounds: SweepRound[] = [];
  const notes: string[] = [];
  let survivors = opts.configs.map((_, i) => i);
  let used = 0;
  let next = 0;
  let cancelled = false;

  for (let r = 0; r < R; r++) {
    const s = survivors.length;
    const want = Math.max(1, Math.floor(budget / (s * R)));
    const batch = order.slice(next, next + want);
    if (batch.length < want && !notes.some((n) => n.startsWith("the selection split ran out"))) {
      notes.push(`the selection split ran out in round ${r + 1}: the budget asks for ${want} new case(s) per config but only ${batch.length} were left; later rounds rank on the cases already run`);
    }
    next += batch.length;
    const jobs: { c: Case; ci: number }[] = [];
    for (const c of batch) for (const ci of shuffle([...survivors], rand)) jobs.push({ c, ci });
    // Recorded runs (a resume) are kept; the rest run now.
    const prior = jobs.map((j) => priorRun(scopes[j.ci], j.c.id, 1));
    let done = prior.filter(Boolean).length;
    const got = await mapPool(jobs, opts.concurrency ?? 4, async (j, i) => {
      if (prior[i]) return prior[i];
      const run = await runTrial(envs[j.ci]!, j.c, 1);
      if (run) opts.onProgress?.(`round ${r + 1}/${R}`, ++done, jobs.length);
      return run;
    });
    // Job order, not finish order: the ranking and its bootstrap CIs then come out the same however the runs interleaved.
    got.forEach((run, i) => run && runs[jobs[i]!.ci]!.push(run));
    used += jobs.length;
    if (got.some((x) => x === undefined)) {
      cancelled = true;
      break;
    }
    const scored = survivors.map((ci) => ({ ci, ...rateOf(runs[ci]!) }));
    // NaN (nothing graded) ranks last.
    scored.sort((x, y) => (Number.isNaN(y.passRate) ? -1 : 0) - (Number.isNaN(x.passRate) ? -1 : 0) || y.passRate - x.passRate || tieRank.get(x.ci)! - tieRank.get(y.ci)!);
    const keep = Math.ceil(s / 2);
    const leader = scored[0]!;
    const leaderRates = caseRates(runs[leader.ci]!);
    const iters = opts.bootstrapIters ?? 2000;
    rounds.push({
      round: r + 1,
      cases: batch.length,
      totalCases: next,
      configs: scored.map((x, rank): SweepRoundConfig => {
        const out: SweepRoundConfig = { config: opts.configs[x.ci]!.name, passRate: x.passRate, n: x.n, kept: rank < keep };
        if (rank >= keep) {
          droppedIn.set(x.ci, r + 1);
          const mine = caseRates(runs[x.ci]!);
          const diffs = [...mine].filter(([id]) => leaderRates.has(id)).map(([id, v]) => v - leaderRates.get(id)!);
          const b = pairedBootstrap(diffs, { iters, seed: 0x5eed });
          out.vsLeader = { mean: b.mean, lo: b.lo, hi: b.hi };
        }
        return out;
      }),
    });
    survivors = scored.slice(0, keep).map((x) => x.ci);
  }

  const status = cancelled ? "cancelled" : "completed";
  const trainResults = opts.configs.map((c, i) =>
    experimentResult({
      id: ids[i]!,
      name: expNames[i]!,
      status,
      dataset: opts.dataset,
      ...(source === "dataset" ? { split: select } : {}),
      task: tasks[i]!.info,
      graders,
      trials: 1,
      createdAt,
      runs: runs[i]!,
      boot: { iters: opts.bootstrapIters ?? 2000, seed: 0x5eed },
      metadata: { sweep: { name: opts.name, seed, role: "select", ...(droppedIn.has(i) ? { droppedIn: droppedIn.get(i) } : {}) } },
    }),
  );
  if (store) for (const r of trainResults) await storeResult(store, r);
  const configs: SweepConfigResult[] = opts.configs.map((c, i) => ({
    name: c.name,
    task: tasks[i]!.info,
    experiment: ids[i]!,
    train: rateOf(runs[i]!),
    ...(droppedIn.has(i) ? { droppedIn: droppedIn.get(i)! } : {}),
  }));
  const out: SweepResult = {
    name: opts.name,
    seed,
    method: "sequential-halving",
    status,
    budget,
    used,
    splits: { select, heldOut, source, selectCases: order.length, heldOutCases: held.length },
    rounds,
    configs,
    notes,
  };
  if (cancelled || survivors.length !== 1) return out;

  // Held-out re-score: the start config and the winner, interleaved, on cases the race never saw.
  const w = survivors[0]!;
  const heldIds = new Set(held.map((c) => c.id));
  const heldJob = job?.scope("held:");
  if (job && job.prefix === "") await job.job.setTotal(used + (w === 0 ? 1 : 2) * held.length);
  const common = {
    dataset: opts.dataset,
    graders: opts.graders,
    ...(source === "dataset" ? { split: heldOut } : {}),
    filter: (c: Case) => heldIds.has(c.id),
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    ...(store ? { store } : {}),
    ...(signal ? { signal } : {}),
    ...(drain ? { drain } : {}),
    ...(heldJob ? { job: heldJob } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.bootstrapIters ? { bootstrapIters: opts.bootstrapIters } : {}),
  };
  const heldName = `${opts.name}-heldout`;
  const scoreOf = (r: ExperimentResult) => ({ ...r.summary.passRate, n: r.summary.n - (r.summary.ungraded ?? 0), experiment: r.id });
  let winnerHeld: ExperimentResult;
  let startHeld: ExperimentResult;
  if (w === 0) {
    winnerHeld = startHeld = await runExperiment({
      name: `${heldName}-${opts.configs[0]!.name}`,
      task: opts.configs[0]!.task,
      ...common,
      onProgress: (_r, done, total) => opts.onProgress?.("held-out", done, total),
    });
  } else {
    const ab = await runAb({
      name: heldName,
      arms: [opts.configs[0]!, opts.configs[w]!],
      seed,
      ...common,
      onProgress: (_r, _arm, done, total) => opts.onProgress?.("held-out", done, total),
    });
    [startHeld, winnerHeld] = [ab.a, ab.b];
    out.comparison = compareExperiments(ab.a, ab.b, { force: true, gate: {} });
    out.adopt = out.comparison.gate;
  }
  if (winnerHeld.status === "cancelled") {
    out.status = "cancelled";
    return out;
  }
  const train = rateOf(runs[w]!);
  const h = scoreOf(winnerHeld);
  out.winner = { name: opts.configs[w]!.name, train, heldOut: h, optimismGap: train.passRate - h.p };
  out.start = { name: opts.configs[0]!.name, heldOut: scoreOf(startHeld) };
  if (h.n < 30) notes.push(`only ${h.n} held-out case(s): the held-out score, and so the optimism gap, is rough (Wilson ${(h.lo * 100).toFixed(0)}-${(h.hi * 100).toFixed(0)}%)`);
  return out;
}
