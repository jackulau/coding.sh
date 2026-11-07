// A/B experiments over harness bundles: run every (task, bundle, attempt),
// then compare two arms with paired statistics and honest wording.
import { availableParallelism } from "node:os";
import { sortableId } from "../core/ids.ts";
import type { Adapter, AgentEvent, BlobStore, EvalTask, HarnessBundle, IndexStore, RunResult, Session } from "../core/types.ts";
import { pairedPower, type PowerAnalysis } from "../experiments/power.ts";
import { infraKind, withRetries, type InfraKind, type RetryPolicy } from "../jobs/retry.ts";
import type { JobScope } from "../jobs/store.ts";
import { pairedBootstrap, wilson, type BootstrapResult, type Interval } from "../stats/interval.ts";
import { mean } from "../stats/summary.ts";
import { itemGate, dec, type ItemGateOpts, type ItemGateReport } from "./gate-item.ts";
import { gateDetail, gateHeadline, gateVerdict, idList, type GateVerdict } from "../stats/gate.ts";
import { acceptanceGate, mcnemar, type GateOpts, type GateResult, type McNemarResult } from "../stats/tests.ts";
import { paretoSupport, type ParetoOpts, type ParetoSupport } from "../stats/pareto.ts";
import { failureAnatomy, nestedVarianceShares, type ArmAnatomy, type VarianceShares } from "./anatomy.ts";
import { diffBundles, formatBundleDiff, type BundleDiff } from "./bundle.ts";
import { firstDivergence, type Divergence } from "./divergence.ts";
import { selfCheckSummary, type SelfCheckSummary } from "./selfcheck.ts";
import type { SnapshotOps } from "./git.ts";
import { runTask, type AgentRoute } from "./run.ts";

// ------------------------------------------------------------ running

export interface ExperimentProgress {
  done: number;
  total: number;
  result: RunResult;
  task: EvalTask;
  bundle: HarnessBundle;
}

export interface RunExperimentOpts {
  tasks: EvalTask[];
  bundles: HarnessBundle[];
  adapterFor: (bundle: HarnessBundle) => Adapter;
  blobs: BlobStore;
  index: IndexStore;
  /** Attempts per (task, bundle). Default 1. */
  k?: number;
  /** Parallel runs. Default min(4, cpus/2). */
  concurrency?: number;
  timeoutMs?: number;
  experimentId?: string;
  onProgress?: (p: ExperimentProgress) => void;
  keep?: boolean;
  env?: Record<string, string>;
  git?: SnapshotOps;
  runsDir?: string;
  /** Extra test globs for each run's tamper check. */
  testGlobs?: string[];
  /** Agent-only routing per arm (see RunTaskOpts.route). */
  route?: AgentRoute;
  /**
   * Interrupts the experiment: no new run starts, in-flight runs are killed
   * and stored as `cancelled`, and the result says `cancelled: true`.
   */
  signal?: AbortSignal;
  /** Graceful stop: no new run starts, the ones in flight finish; the result says `cancelled: true`. */
  drain?: AbortSignal;
  /**
   * Checkpoint and resume: each finished run is recorded here (its id; the run
   * itself is in the index), and runs already recorded are kept instead of run
   * again. The experiment id lives here too.
   */
  job?: JobScope;
  /** Re-run a run that failed on an infrastructure error (rate limit, 5xx, network) after a backoff. Task failures are never retried. */
  retry?: RetryPolicy;
}

/** The checkpoint key of one (task, bundle, attempt). */
export const runKey = (j: Job): string => `${j.task.id}\u0000${j.bundle.id}\u0000${j.attempt}`;

/**
 * Whether a failed run failed on infrastructure (rate limit, 5xx, network)
 * rather than on the task: its error, or the tail of a failing agent's output.
 * A pass, a cancelled run or the agent's own timeout never is.
 */
export function runInfra(r: RunResult): InfraKind | undefined {
  if (r.pass || r.cancelled || r.agent.timedOut) return undefined;
  const k = infraKind(r.error);
  if (k) return k;
  if (r.agent.exitCode === 0 || r.agent.exitCode === null) return undefined;
  return infraKind(`exited ${r.agent.exitCode}: ${r.agent.stderrTail.slice(-2000)} ${r.agent.stdoutTail.slice(-500)}`);
}

export interface Job {
  task: EvalTask;
  bundle: HarnessBundle;
  attempt: number;
}

/**
 * Job order: per task, attempts interleaved across arms (A1, B1, A2, B2, …),
 * so slow drift (API latency, rate limits, model updates) hits both arms alike.
 */
export function scheduleJobs(tasks: readonly EvalTask[], bundles: readonly HarnessBundle[], k: number): Job[] {
  const jobs: Job[] = [];
  for (const task of tasks) for (let attempt = 1; attempt <= k; attempt++) for (const bundle of bundles) jobs.push({ task, bundle, attempt });
  return jobs;
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
}

export async function runExperiment(o: RunExperimentOpts): Promise<{ experimentId: string; results: RunResult[]; cancelled: boolean }> {
  const jobScope = o.job;
  const experimentId = jobScope?.state<string>("experimentId") ?? o.experimentId ?? sortableId("exp_");
  if (jobScope && jobScope.state("experimentId") === undefined) {
    await jobScope.setState("experimentId", experimentId);
    await jobScope.job.addRefs(experimentId);
  }
  const jobs = scheduleJobs(o.tasks, o.bundles, Math.max(1, o.k ?? 1));
  if (jobScope && jobScope.prefix === "") await jobScope.job.setTotal(jobs.length);
  // A resume keeps every run already recorded with a known outcome (the runs live in the index).
  const stored = jobScope ? new Map((await o.index.listRuns({ experimentId })).map((r) => [r.id, r])) : new Map<string, RunResult>();
  const prior = jobs.map((j) => {
    const l = jobScope?.done(runKey(j));
    const id = l && !l.infra ? (l.data as { runId?: string } | undefined)?.runId : undefined;
    return id ? stored.get(id) : undefined;
  });
  let done = prior.filter(Boolean).length;
  const settled = await pool(jobs, o.concurrency ?? defaultConcurrency(), async (job, i): Promise<RunResult | undefined> => {
    if (prior[i]) return prior[i];
    if (o.signal?.aborted || o.drain?.aborted) return undefined; // never started: not a run
    const t0 = Date.now();
    let last: RunResult | undefined;
    const tried = await withRetries(
      async () => {
        // A retried attempt stays in the index for the record, marked so comparisons leave it out.
        if (last) await o.index.putRun({ ...last, superseded: true }).catch(() => {});
        last = await attemptRun(o, job, experimentId);
        return last;
      },
      { policy: o.retry ?? { retries: 0, baseMs: 0, maxMs: 0 }, errorOf: (r) => r.error, classify: runInfra, stop: [o.signal, o.drain] },
    );
    const result = tried.result;
    if (tried.attempts > 1 || tried.infra) {
      if (tried.attempts > 1) result.attempts = tried.attempts;
      if (tried.infra) result.infra = tried.infra;
      await o.index.putRun(result).catch(() => {});
    }
    if (result.cancelled) return result; // killed mid-run: kept as cancelled in the index, not a finished run
    if (jobScope) {
      const cost = result.agent.usage?.costUsd;
      await jobScope.record(runKey(job), {
        ms: Date.now() - t0,
        ...(tried.attempts > 1 ? { attempts: tried.attempts } : {}),
        ...(typeof cost === "number" ? { costUsd: cost } : {}),
        ...(tried.infra ? { infra: tried.infra } : {}),
        outcome: result.pass ? "pass" : result.error ? "error" : "fail",
        data: { runId: result.id },
      });
    }
    done++;
    o.onProgress?.({ done, total: jobs.length, result, task: job.task, bundle: job.bundle });
    return result;
  });
  const results = settled.filter((r): r is RunResult => r !== undefined);
  return { experimentId, results, cancelled: settled.some((r) => r === undefined || r.cancelled === true) };
}

/** One attempt of one job, stored in the index (runTask never throws for what the agent does). */
async function attemptRun(o: RunExperimentOpts, job: Job, experimentId: string): Promise<RunResult> {
  try {
    return await runTask({
      task: job.task,
      bundle: job.bundle,
      adapter: o.adapterFor(job.bundle),
      blobs: o.blobs,
      index: o.index,
      attempt: job.attempt,
      experimentId,
      timeoutMs: o.timeoutMs,
      keep: o.keep,
      env: o.env,
      route: o.route,
      git: o.git,
      runsDir: o.runsDir,
      testGlobs: o.testGlobs,
      signal: o.signal,
    });
  } catch (e) {
    // runTask should not throw; if adapterFor does, record and move on.
    const now = Date.now();
    const result: RunResult = {
      id: sortableId("run_"),
      experimentId,
      taskId: job.task.id,
      bundleId: job.bundle.id,
      attempt: job.attempt,
      pass: false,
      verifierExit: null,
      agent: { exitCode: null, timedOut: false, durationMs: 0, stdoutTail: "", stderrTail: "" },
      startedAt: now,
      endedAt: now,
      error: e instanceof Error ? e.message : String(e),
    };
    await o.index.putRun(result).catch(() => {});
    return result;
  }
}

/** Sessions captured for runs (via hooks, tagged with CODING_SH_RUN_ID), keyed by run id. */
export async function loadRunSessions(index: IndexStore, results: readonly RunResult[]): Promise<Map<string, Session>> {
  const out = new Map<string, Session>();
  for (const r of results) {
    let s = r.sessionId ? await index.getSession(r.sessionId) : undefined;
    if (!s) s = (await index.listSessions({ runId: r.id, limit: 1 }))[0];
    if (s) out.set(r.id, s);
  }
  return out;
}

/** Events per run id, for trace divergence. */
export async function loadRunEvents(index: IndexStore, sessions: Map<string, Session>): Promise<Map<string, AgentEvent[]>> {
  const out = new Map<string, AgentEvent[]>();
  for (const [runId, s] of sessions) out.set(runId, await index.listEvents(s.id));
  return out;
}

// ------------------------------------------------------------ comparing

export type MetricKey = "cost" | "tokens" | "turns" | "wall" | "agentTime" | "llmTime" | "llmP50" | "llmP95" | "ttftP50";

export interface MetricDelta {
  key: MetricKey;
  label: string;
  unit: "usd" | "ms" | "count";
  /** Mean per run over runs where the metric is known. */
  baseline: number;
  candidate: number;
  /** candidate − baseline. */
  delta: number;
  /** delta / baseline (NaN when baseline is 0 or unknown). */
  relative: number;
  /** Runs where the metric is known. */
  n: { baseline: number; candidate: number };
  /** Runs per arm (after dropping cancelled runs); n < runs means partial coverage. */
  runs: { baseline: number; candidate: number };
  /** Cost only: runs whose cost came from the price table (session usage), not the agent. */
  costEstimatedRuns?: { baseline: number; candidate: number };
}

/** A metric delta is a verdict only when each arm knows it for at least this share of runs. */
export const COST_COVERAGE_MIN = 0.8;

const covered = (m: MetricDelta) =>
  m.runs.baseline > 0 && m.runs.candidate > 0 && m.n.baseline / m.runs.baseline >= COST_COVERAGE_MIN && m.n.candidate / m.runs.candidate >= COST_COVERAGE_MIN;

export interface ArmSummary {
  bundleId: string;
  name?: string;
  runs: number;
  passes: number;
  passRate: Interval;
  errors: number;
  /** Runs that carry a tamper check (older runs have none). */
  tamperChecked: number;
  /** Checked runs whose diff edited, deleted or skipped tests. */
  tampered: number;
  /** tampered / tamperChecked; NaN when no run was checked. */
  tamperRate: number;
  /** Tampered runs that still passed: passes that may not be earned. */
  tamperedPasses: number;
  /** Failed runs split by the agent's own last test result (silent misses: own tests green, verifier red). */
  selfCheck: SelfCheckSummary;
}

export interface TaskOutcome {
  taskId: string;
  baseline: { passes: number; runs: number };
  candidate: { passes: number; runs: number };
  /** candidate rate − baseline rate. */
  diff: number;
  divergence?: Divergence;
}

export type VerdictKind = "better" | "worse" | "no-difference" | "inconclusive";

export interface CompareReport {
  baseline: ArmSummary;
  candidate: ArmSummary;
  tasks: TaskOutcome[];
  /** Tasks with at least one run in each arm. */
  pairedTasks: number;
  /** Tasks present in only one arm (excluded from paired stats). */
  unpairedTasks: string[];
  /** Max attempts seen for any (task, arm). */
  k: number;
  /** Paired bootstrap over tasks of the per-task pass-rate difference. */
  diff: BootstrapResult;
  /**
   * Exact McNemar over per-task majority outcomes (pass when the task's pass
   * rate is >= 0.5), one pair per paired task. Attempts are not separate pairs.
   */
  mcnemar: McNemarResult;
  /**
   * Minimum detectable effect and power warnings over the per-task pass-rate
   * differences (the task is the cluster), same analysis as `exp compare`.
   */
  power: PowerAnalysis;
  metrics: MetricDelta[];
  verdict: { kind: VerdictKind; text: string };
  notes: string[];
  bundleDiff?: BundleDiff;
  alpha: number;
  /**
   * Why each arm's runs failed and where the outcome variance sits. Only when
   * every paired task has 2+ attempts in both arms (with k=1 a bad run and a
   * task beyond the arm look the same).
   */
  anatomy?: { baseline: ArmAnatomy; candidate: ArmAnatomy; variance: VarianceShares };
  /** Set by `compare A --without <path>`: B is A without `paths`. */
  ablation?: AblationReport;
  /** Set by `compare --gate`: ship B or keep A (SAGE accept-or-abstain on per-task majority outcomes). */
  gate?: CompareGate;
  /**
   * Set by `compare --promote` when cost (else tokens) is known on enough runs:
   * Pareto support that B is credible progress in quality or cost (ParetoSaddler).
   */
  pareto?: ComparePareto;
  /**
   * Set when B adds or removes exactly one rule, skill or context file (or with
   * `compare --item-gate`): Cortex's one-item gate on the tasks where the item
   * reached the agent's context.
   */
  itemGate?: ItemGateReport;
}

/** The Pareto promotion gate: quality = pass (1/0) per run, cost = USD per run, else tokens. */
export interface ComparePareto extends ParetoSupport {
  unit: "usd" | "tokens";
  /** Which branch carried the promotion; "none" when held. */
  reason: "quality-gain" | "cost-cut" | "both" | "none";
}

/**
 * The acceptance gate on per-task majority outcomes. wins: tasks A failed and
 * B passed; losses: tasks A passed and B failed; solved: paired tasks A passed.
 * A tamper-flagged B attempt counts as a fail here only (pass rates keep it).
 */
export interface CompareGate extends GateResult {
  /** ship (accept), hold (not enough evidence) or dont-ship (B breaks solved tasks). */
  verdict: GateVerdict;
  /** Tasks A solved that B lost. */
  lost: string[];
  /** Tasks A failed that B solved. */
  won: string[];
  /**
   * `compare --gate --by <prefix>`: the same gate per task group (the first tag
   * with the prefix, "(none)" when a task has none), sorted by group. The
   * numbers above stay pooled; a group that says dont-ship makes the whole
   * gate abstain with reason "stratum-regression". Hold never blocks.
   */
  strata?: GateStratum[];
  /** Groups whose gate said dont-ship. */
  blockedBy?: string[];
}

export interface GateStratum {
  group: string;
  /** Paired tasks in the group. */
  tasks: number;
  gate: GateResult & { verdict: GateVerdict };
  lost: string[];
  won: string[];
}

export interface AblationReport {
  paths: string[];
  /** Bundle files B dropped. */
  dropped: string[];
  /** Paths that matched no bundle file (removed from the task repo only). */
  unmatched: string[];
  /** Effect of having `paths` = A − B pass rate (the bootstrap diff, sign flipped). */
  effect: { mean: number; lo: number; hi: number };
}

export interface CompareOpts {
  /** Bundle ids of the two arms. */
  baseline: string;
  candidate: string;
  /** Captured sessions keyed by run id (turns, latency, usage fallback). */
  sessions?: Map<string, Session>;
  /** Events keyed by run id (first trace divergence per task). */
  events?: Map<string, AgentEvent[]>;
  bundles?: { baseline?: HarnessBundle; candidate?: HarnessBundle };
  alpha?: number;
  iters?: number;
  seed?: number;
  /** B is an ablation of A (`compare --without`). */
  ablation?: Pick<AblationReport, "paths" | "dropped" | "unmatched">;
  /** Add the acceptance gate (`compare --gate`) with these settings. */
  gate?: GateOpts;
  /** With `gate`: also gate each task group, grouped by the first tag with this prefix (`compare --gate --by suite:`). */
  gateBy?: string;
  /** Task tags by task id, for `gateBy`. */
  taskTags?: ReadonlyMap<string, readonly string[]>;
  /** Add the Pareto promotion gate (`compare --promote`) with these settings; its seed defaults to `seed`. */
  pareto?: Pick<ParetoOpts, "gamma" | "epsQ" | "epsC" | "draws">;
  /** Add the one-item gate: B adds (mode "add") or removes ("remove") one instruction item. */
  itemGate?: Omit<ItemGateOpts, "baseline" | "candidate">;
}

type Extract = (r: RunResult, s: Session | undefined) => number | undefined;

const METRICS: { key: MetricKey; label: string; unit: MetricDelta["unit"]; get: Extract }[] = [
  { key: "cost", label: "cost / run", unit: "usd", get: (r, s) => r.agent.usage?.costUsd ?? s?.stats.usage?.costUsd },
  {
    key: "tokens",
    label: "tokens / run",
    unit: "count",
    get: (r, s) => {
      const u = r.agent.usage ?? s?.stats.usage;
      if (!u || (u.inputTokens === undefined && u.outputTokens === undefined)) return undefined;
      return (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    },
  },
  { key: "turns", label: "turns / run", unit: "count", get: (_r, s) => s?.stats.turns },
  { key: "wall", label: "wall time / run", unit: "ms", get: (r) => r.endedAt - r.startedAt },
  { key: "agentTime", label: "agent time / run", unit: "ms", get: (r) => (r.agent.durationMs > 0 ? r.agent.durationMs : undefined) },
  { key: "llmTime", label: "LLM time / run", unit: "ms", get: (_r, s) => s?.stats.latency?.llmMs },
  { key: "llmP50", label: "LLM call p50", unit: "ms", get: (_r, s) => s?.stats.latency?.llmP50Ms },
  { key: "llmP95", label: "LLM call p95", unit: "ms", get: (_r, s) => s?.stats.latency?.llmP95Ms },
  { key: "ttftP50", label: "TTFT p50", unit: "ms", get: (_r, s) => s?.stats.latency?.ttftP50Ms },
];

function arm(results: readonly RunResult[], bundleId: string, name: string | undefined, opts: Pick<CompareOpts, "sessions" | "events">): ArmSummary {
  const passes = results.filter((r) => r.pass).length;
  const checked = results.filter((r) => r.tamper);
  const tampered = checked.filter((r) => r.tamper?.flagged);
  return {
    bundleId,
    name,
    runs: results.length,
    passes,
    passRate: wilson(passes, results.length),
    errors: results.filter((r) => r.error).length,
    tamperChecked: checked.length,
    tampered: tampered.length,
    tamperRate: checked.length ? tampered.length / checked.length : NaN,
    tamperedPasses: tampered.filter((r) => r.pass).length,
    selfCheck: selfCheckSummary(results, opts.sessions, opts.events),
  };
}

export function compare(all: readonly RunResult[], opts: CompareOpts): CompareReport {
  const alpha = opts.alpha ?? 0.05;
  // Interrupted runs were killed mid-flight, and runs that failed on infrastructure (rate
  // limit, 5xx, network) never measured the agent: neither says anything about either harness.
  // A superseded attempt was retried; its retry is the run that counts.
  const mine = all.filter((r) => !r.superseded && (r.bundleId === opts.baseline || r.bundleId === opts.candidate));
  const results = all.filter((r) => !r.cancelled && !r.superseded && !r.infra);
  const cancelled = mine.filter((r) => r.cancelled).length;
  const infra = mine.filter((r) => !r.cancelled && r.infra).length;
  const retried = mine.filter((r) => (r.attempts ?? 1) > 1).length;
  const A = results.filter((r) => r.bundleId === opts.baseline);
  const B = results.filter((r) => r.bundleId === opts.candidate);
  const byTask = (rs: readonly RunResult[]) => {
    const m = new Map<string, RunResult[]>();
    for (const r of rs) m.set(r.taskId, [...(m.get(r.taskId) ?? []), r]);
    for (const v of m.values()) v.sort((x, y) => x.attempt - y.attempt);
    return m;
  };
  const ta = byTask(A);
  const tb = byTask(B);
  const taskIds = [...new Set([...ta.keys(), ...tb.keys()])].sort();
  const tasks: TaskOutcome[] = [];
  const unpaired: string[] = [];
  const diffs: number[] = [];
  let mb = 0;
  let mc = 0;
  let k = 0;
  const lost: string[] = [];
  const won: string[] = [];
  let solved = 0;
  /** Per paired task: A's majority pass, and B's not counting tampered passes. */
  const gateCells: { id: string; a: boolean; b: boolean }[] = [];
  for (const id of taskIds) {
    const ra = ta.get(id) ?? [];
    const rb = tb.get(id) ?? [];
    k = Math.max(k, ra.length, rb.length);
    const pa = ra.filter((r) => r.pass).length;
    const pb = rb.filter((r) => r.pass).length;
    if (!ra.length || !rb.length) {
      unpaired.push(id);
      continue;
    }
    const diff = pb / rb.length - pa / ra.length;
    diffs.push(diff);
    // One McNemar pair per task (the cluster), on its majority outcome: attempts
    // of one task are correlated, so counting them as separate pairs would
    // overstate the evidence. Same rule as experiments/compare.ts (rate >= 0.5
    // counts as a pass).
    const x = pa / ra.length >= 0.5;
    const y = pb / rb.length >= 0.5;
    if (x && !y) mb++;
    else if (!x && y) mc++;
    // The gate does not credit B for passes that edited, deleted or skipped tests.
    const yg = rb.filter((r) => r.pass && !r.tamper?.flagged).length / rb.length >= 0.5;
    if (x) solved++;
    if (x && !yg) lost.push(id);
    else if (!x && yg) won.push(id);
    gateCells.push({ id, a: x, b: yg });
    let divergence: Divergence | undefined;
    const ea = opts.events?.get((ra[0] as RunResult).id);
    const eb = opts.events?.get((rb[0] as RunResult).id);
    if (ea && eb) divergence = firstDivergence(ea, eb);
    tasks.push({ taskId: id, baseline: { passes: pa, runs: ra.length }, candidate: { passes: pb, runs: rb.length }, diff, divergence });
  }

  const boot = pairedBootstrap(diffs, { iters: opts.iters, seed: opts.seed, alpha });
  const mcn = mcnemar(mb, mc);

  const metrics: MetricDelta[] = [];
  for (const m of METRICS) {
    const va = A.map((r) => m.get(r, opts.sessions?.get(r.id))).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    const vb = B.map((r) => m.get(r, opts.sessions?.get(r.id))).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
    if (!va.length && !vb.length) continue;
    const a = mean(va);
    const b = mean(vb);
    const md: MetricDelta = {
      key: m.key,
      label: m.label,
      unit: m.unit,
      baseline: a,
      candidate: b,
      delta: b - a,
      relative: a ? (b - a) / a : NaN,
      n: { baseline: va.length, candidate: vb.length },
      runs: { baseline: A.length, candidate: B.length },
    };
    if (m.key === "cost") {
      // Reported by the agent vs priced from the session's tokens.
      const est = (rs: readonly RunResult[]) => rs.filter((r) => r.agent.usage?.costUsd === undefined && Number.isFinite(opts.sessions?.get(r.id)?.stats.usage?.costUsd)).length;
      md.costEstimatedRuns = { baseline: est(A), candidate: est(B) };
    }
    metrics.push(md);
  }

  const notes: string[] = [];
  if (k > 1) notes.push(`pass-rate intervals (Wilson) treat the ${k} runs per task as independent and are optimistic; the bootstrap CI resamples tasks and is the one to trust`);
  if (unpaired.length) notes.push(`${unpaired.length} task(s) ran in only one arm and are excluded from paired stats`);
  const sa = arm(A, opts.baseline, opts.bundles?.baseline?.name, opts);
  const sb = arm(B, opts.candidate, opts.bundles?.candidate?.name, opts);
  if (cancelled) notes.push(`${cancelled} run(s) were cancelled before they finished and are left out`);
  if (infra) notes.push(`${infra} run(s) still failed on infrastructure errors (rate limit, 5xx, network) after their retries and are left out; compare --resume runs them again`);
  if (retried) notes.push(`${retried} run(s) were retried after infrastructure errors; only their last attempt counts (task failures are never retried)`);
  const errored = [...A, ...B].filter((r) => r.error);
  if (errored.length) {
    const passed = errored.filter((r) => r.pass).length;
    notes.push(
      passed
        ? `${errored.length} run(s) recorded an error (setup, agent or verifier); ${passed} of them still passed the verifier and count as passes${passed < errored.length ? `, the other ${errored.length - passed} count as failures` : ""}`
        : `${errored.length} run(s) recorded an error (setup, agent or verifier); they count as failures`,
    );
  }
  const tampered = sa.tampered + sb.tampered;
  if (tampered) {
    const tp = sa.tamperedPasses + sb.tamperedPasses;
    notes.push(
      `${tampered} run(s) edited, deleted or skipped tests (baseline ${sa.tampered}, candidate ${sb.tampered}); ${tp} of them passed and still count as passes, so inspect their diffs before trusting the pass rate`,
    );
  }

  const verdict = decide(diffs.length, boot, mcn, alpha, metrics);
  if (verdict.extra) notes.push(verdict.extra);

  const pairedIds = tasks.map((t) => t.taskId);
  const failed = pairedIds.some((id) => (ta.get(id) ?? []).some((r) => !r.pass) || (tb.get(id) ?? []).some((r) => !r.pass));
  let anatomy: CompareReport["anatomy"];
  if (pairedIds.length && pairedIds.every((id) => (ta.get(id)?.length ?? 0) >= 2 && (tb.get(id)?.length ?? 0) >= 2)) {
    const fa = failureAnatomy(ta, tb, pairedIds);
    const cells = pairedIds.flatMap((id) => [
      ...(ta.get(id) ?? []).map((r) => ({ group: id, sub: "A", y: r.pass ? 1 : 0 })),
      ...(tb.get(id) ?? []).map((r) => ({ group: id, sub: "B", y: r.pass ? 1 : 0 })),
    ]);
    anatomy = { ...fa, variance: nestedVarianceShares(cells) };
    notes.push(...anatomyNotes(anatomy));
  } else if (failed) {
    notes.push(`${k <= 1 ? "k=1" : "some tasks ran once"}: bad runs and beyond-ability failures look the same; rerun with --k 3 (arXiv 2611.08285)`);
  }
  let pareto: ComparePareto | undefined;
  if (opts.pareto) {
    const p = paretoGate(ta, tb, pairedIds, metrics, opts.sessions, { ...opts.pareto, seed: opts.seed });
    if (typeof p === "string") notes.push(p);
    else pareto = p;
  }
  return {
    baseline: sa,
    candidate: sb,
    tasks,
    pairedTasks: diffs.length,
    unpairedTasks: unpaired,
    k,
    diff: boot,
    mcnemar: mcn,
    power: pairedPower(diffs, { alpha }),
    metrics,
    verdict: { kind: verdict.kind, text: verdict.text },
    notes,
    bundleDiff: opts.bundles?.baseline && opts.bundles.candidate ? diffBundles(opts.bundles.baseline, opts.bundles.candidate) : undefined,
    alpha,
    ...(anatomy ? { anatomy } : {}),
    ...(opts.ablation ? { ablation: { ...opts.ablation, effect: { mean: -boot.mean, lo: -boot.hi, hi: -boot.lo } } } : {}),
    ...(opts.gate ? { gate: stratify(compareGate(acceptanceGate({ wins: won.length, losses: lost.length, solved }, opts.gate), lost, won), gateCells, opts) } : {}),
    ...(pareto ? { pareto } : {}),
    // Cancelled runs count as invalid here: an incomplete sweep is not scorable.
    ...(opts.itemGate ? { itemGate: itemGate(all, { ...opts.itemGate, baseline: opts.baseline, candidate: opts.candidate }) } : {}),
  };
}

/** Why `compare --promote` has no Pareto gate. */
export const PARETO_NEEDS_COST = `pareto gate needs cost or tokens on >=${Math.round(COST_COVERAGE_MIN * 100)}% of runs per arm`;

/**
 * The Pareto promotion gate on paired tasks: per run q = pass (1/0) and c =
 * cost in USD when cost is known on enough runs per arm (Z-19's rule), else
 * tokens. Runs without the value are left out. A string says why there is none.
 */
function paretoGate(
  ta: ReadonlyMap<string, RunResult[]>,
  tb: ReadonlyMap<string, RunResult[]>,
  taskIds: readonly string[],
  metrics: readonly MetricDelta[],
  sessions: Map<string, Session> | undefined,
  o: ParetoOpts,
): ComparePareto | string {
  const usd = metrics.find((m) => m.key === "cost");
  const tokens = metrics.find((m) => m.key === "tokens");
  const unit = usd && covered(usd) ? "usd" : tokens && covered(tokens) ? "tokens" : undefined;
  if (!unit) return PARETO_NEEDS_COST;
  const get = METRICS.find((m) => m.key === (unit === "usd" ? "cost" : "tokens"))!.get;
  const qc = (rs: readonly RunResult[]) => rs.map((r) => ({ q: r.pass ? 1 : 0, c: get(r, sessions?.get(r.id)) ?? NaN }));
  const p = paretoSupport(
    taskIds.map((id) => ({ id, base: qc(ta.get(id) ?? []), cand: qc(tb.get(id) ?? []) })),
    o,
  );
  const k = Math.max(0, ...taskIds.flatMap((id) => [ta.get(id)?.length ?? 0, tb.get(id)?.length ?? 0]));
  const notes = k < 2 ? [...p.notes.filter((n) => !n.startsWith("no within-case replicates")), "k=1: pareto support uses case-level resampling only; run --k 3 for the paper's within-task replicates"] : [...p.notes];
  if (unit === "tokens") notes.unshift(`cost is known on too few runs, so the cost side is tokens per run`);
  const s = p.branchShares;
  const reason = !p.promote ? "none" : s.quality >= 0.5 && s.cost >= 0.5 ? "both" : s.cost > s.quality ? "cost-cut" : "quality-gain";
  return { ...p, notes, unit, reason };
}

function compareGate(g: GateResult, lost: string[], won: string[]): CompareGate {
  return { ...g, verdict: gateVerdict(g), lost, won };
}

/** The group a task gates in under `--by <prefix>`: its first tag with the prefix, else "(none)". */
export function gateGroup(tags: readonly string[] | undefined, prefix: string): string {
  return tags?.find((t) => t.startsWith(prefix)) ?? "(none)";
}

/**
 * AB-2: gate each task group too, so a pooled "ship" can't hide one suite
 * collapsing (arXiv 2611.03219: one gate change took a suite 96 → 0).
 */
function stratify(pooled: CompareGate, cells: readonly { id: string; a: boolean; b: boolean }[], opts: CompareOpts): CompareGate {
  if (opts.gateBy === undefined) return pooled;
  const groups = new Map<string, { id: string; a: boolean; b: boolean }[]>();
  for (const c of cells) {
    const g = gateGroup(opts.taskTags?.get(c.id), opts.gateBy);
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const strata: GateStratum[] = [...groups.keys()].sort().map((group) => {
    const cs = groups.get(group)!;
    const lost = cs.filter((c) => c.a && !c.b).map((c) => c.id);
    const won = cs.filter((c) => !c.a && c.b).map((c) => c.id);
    const g = acceptanceGate({ wins: won.length, losses: lost.length, solved: cs.filter((c) => c.a).length }, opts.gate);
    return { group, tasks: cs.length, gate: { ...g, verdict: gateVerdict(g) }, lost, won };
  });
  const blockedBy = strata.filter((s) => s.gate.verdict === "dont-ship").map((s) => s.group);
  if (!blockedBy.length) return { ...pooled, strata, blockedBy };
  const reasons = [...pooled.reasons.filter((r) => r !== "stratum-regression"), "stratum-regression" as const];
  return { ...pooled, decision: "abstain", reasons, verdict: "dont-ship", strata, blockedBy };
}

/** The gate's headline. With `--without`, B is A minus a component: accepting means drop it. */
function gateLine(g: CompareGate, ab: AblationReport | undefined): string {
  const blocked = g.strata?.filter((s) => g.blockedBy?.includes(s.group)) ?? [];
  if (blocked.length) {
    const what = blocked.map((s) => `${s.lost.length} of ${s.gate.solved} ${s.group} task${s.gate.solved === 1 ? "" : "s"}`).join(" and ");
    return ab ? `Keep it: dropping ${ab.paths.join(", ")} breaks ${what} A solved` : `Don't ship: B breaks ${what} A solved`;
  }
  if (!ab) return gateHeadline(g, "task");
  const what = ab.paths.join(", ");
  const tasks = (n: number) => `${n} task${n === 1 ? "" : "s"}`;
  switch (g.verdict) {
    case "ship":
      return `Drop it: without ${what}, B wins ${tasks(g.wins)}, loses ${g.losses}`;
    case "dont-ship":
      return `Keep it: dropping ${what} breaks ${tasks(g.losses)} A solved`;
    default:
      return `Keep it: not enough evidence that dropping ${what} helps (B wins ${g.wins}, loses ${g.losses})`;
  }
}

const share = (x: number) => `${Math.round(x * 100)}%`;

function anatomyNotes(a: NonNullable<CompareReport["anatomy"]>): string[] {
  const out: string[] = [];
  const b = a.candidate;
  const real = b.fails - b.infra;
  if (real > 0 && b.badRun / real >= 0.5) {
    out.push(`most of B's failures are bad runs (${b.badRun} of ${real}: the same task passed in another attempt): retries, pass@k or a verify-and-retry loop pay off before another harness change`);
  }
  const fails = a.baseline.fails + b.fails;
  const unsolved = a.baseline.unsolvedByAll + b.unsolvedByAll;
  if (fails > 0 && unsolved / fails >= 0.3) {
    const n = a.baseline.tasks.unsolvedByAll.length;
    out.push(`${n} task${n === 1 ? "" : "s"} failed every attempt in both arms (${share(unsolved / fails)} of failed runs): check them with coding.sh eval validate / eval curate`);
  }
  const v = a.variance;
  if (Number.isFinite(v.run) && v.run > v.arm) out.push(`run-to-run noise (${share(v.run)}) outweighs the harness effect (${share(v.arm)})`);
  return out;
}

const pp = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pp`;
const pval = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

function decide(
  paired: number,
  boot: BootstrapResult,
  mcn: McNemarResult,
  alpha: number,
  metrics: MetricDelta[],
): { kind: VerdictKind; text: string; extra?: string } {
  if (paired === 0) return { kind: "inconclusive", text: "inconclusive: no task ran in both arms" };
  const level = `${Math.round((1 - alpha) * 100)}%`;
  const ci = `${level} CI [${pp(boot.lo)}, ${pp(boot.hi)}]`;
  const bootSig = boot.lo > 0 || boot.hi < 0;
  const mcSig = mcn.p < alpha;
  const small = paired < 10 ? ` (only ${paired} task${paired === 1 ? "" : "s"}; underpowered)` : "";
  const cost = metrics.find((m) => m.key === "cost");
  let costNote: string | undefined;
  if (cost && !covered(cost)) {
    // Means over different subsets of runs (e.g. one arm on an unpriced model) are not comparable.
    if (cost.n.baseline > 0 || cost.n.candidate > 0) {
      costNote = `cost is known for ${cost.n.baseline}/${cost.runs.baseline} baseline and ${cost.n.candidate}/${cost.runs.candidate} candidate runs; the cost delta compares different subsets of runs and is not a verdict`;
    }
  } else if (cost && Number.isFinite(cost.relative) && Math.abs(cost.relative) >= 0.05) {
    costNote = `pass rates aside, candidate is ${Math.abs(cost.relative * 100).toFixed(0)}% ${cost.relative < 0 ? "cheaper" : "more expensive"} per run`;
  }
  if (bootSig && mcSig) {
    const better = boot.mean > 0;
    return { kind: better ? "better" : "worse", text: `candidate ${better ? "better" : "worse"}: ${pp(boot.mean)} pass rate, ${ci}, McNemar ${pval(mcn.p)}`, extra: costNote };
  }
  if (!bootSig && !mcSig) {
    return { kind: "no-difference", text: `no significant difference: ${pp(boot.mean)} pass rate, ${ci} includes 0, McNemar ${pval(mcn.p)}${small}`, extra: costNote };
  }
  return {
    kind: "inconclusive",
    text: `inconclusive: ${pp(boot.mean)} pass rate; ${bootSig ? `bootstrap ${ci} excludes 0 but McNemar ${pval(mcn.p)}` : `McNemar ${pval(mcn.p)} but bootstrap ${ci} includes 0`}${small}; run more tasks or attempts`,
    extra: costNote,
  };
}

// ------------------------------------------------------------ formatting

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const neg = ms < 0 ? "-" : "";
  const a = Math.abs(ms);
  if (a < 1000) return `${neg}${Math.round(a)}ms`;
  if (a < 60_000) return `${neg}${(a / 1000).toFixed(1)}s`;
  const m = Math.floor(a / 60_000);
  const s = Math.round((a % 60_000) / 1000);
  return `${neg}${m}m${String(s).padStart(2, "0")}s`;
}

function fmtValue(v: number, unit: MetricDelta["unit"]): string {
  if (!Number.isFinite(v)) return "—";
  if (unit === "usd") return `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(Math.abs(v) < 1 ? 3 : 2)}`;
  if (unit === "ms") return formatDuration(v);
  return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(1).replace(/\.0$/, "");
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "—");

const ITEM_PASS = new Set(["KEEP", "ACCEPT"]);
const ITEM_FAIL = new Set(["KILL", "REJECT"]);

/** `item gate k=3 τ=.34 m=2: KEEP · G=1.67 net +4 runs D=.33 fired 11/36 · S=9 tasks`, then reasons. */
function itemGateLines(g: ItemGateReport, arms: string, p: Record<"good" | "bad" | "bold" | "dim", (s: string) => string>): string[] {
  const v = ITEM_PASS.has(g.verdict) ? p.good(g.verdict) : ITEM_FAIL.has(g.verdict) ? p.bad(g.verdict) : p.bold(g.verdict);
  const net = `net ${g.kN > 0 ? "+" : g.kN < 0 ? "−" : ""}${Math.abs(g.kN)} run${Math.abs(g.kN) === 1 ? "" : "s"}`;
  const out = [`item gate k=${g.k} τ=${dec(g.tau)} m=${g.m}: ${v} · G=${dec(g.G)} ${net} D=${dec(g.D)} fired ${g.f.fired}/${g.f.rollouts} · S=${g.S.length} task${g.S.length === 1 ? "" : "s"}`];
  const ind = "          ";
  if (g.item) out.push(p.dim(`${ind}${g.mode === "add" ? "B adds" : "B removes"} ${g.item.kind} ${g.item.path}${g.item.tier === "path" ? " (path-scoped)" : g.item.tier === "requested" ? " (on request)" : ""}`));
  for (const r of g.reasons) out.push(`${ind}${r}`);
  if (g.recheck?.length) out.push(`${ind}recheck: coding.sh compare ${arms} ${g.recheck.map((t) => `--task ${t}`).join(" ")} --k ${g.k}`);
  return out;
}

export interface FormatOpts {
  color?: boolean;
  /** How to name the two arms in a suggested command (default "<A> <B>"). */
  arms?: string;
  /** Max per-task rows (default 20). */
  maxTasks?: number;
}

export function formatCompare(r: CompareReport, opts: FormatOpts = {}): string {
  const c = opts.color ?? false;
  const paint = (code: string, s: string) => (c ? `\x1b[${code}m${s}\x1b[0m` : s);
  const good = (s: string) => paint("32", s);
  const bad = (s: string) => paint("31", s);
  const dim = (s: string) => paint("2", s);
  const bold = (s: string) => paint("1", s);
  // Pad by visible width so ANSI codes don't break alignment.
  const vis = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vis(s)));
  const W = [18, 22, 22, 26];
  // A cell that fills (or overflows) its column still gets one space, so
  // adjacent cells never run together.
  const row = (cells: string[]) =>
    cells
      .map((x, i) => {
        const w = W[i] ?? 10;
        return vis(x) >= w ? `${x} ` : pad(x, w);
      })
      .join("")
      .trimEnd();
  const signed = (delta: number, lowerIsBetter: boolean, text: string) =>
    !Number.isFinite(delta) || delta === 0 ? text : (delta < 0) === lowerIsBetter ? good(text) : bad(text);

  const name = (a: ArmSummary) => `${a.name ? `${a.name} ` : ""}(${a.bundleId.slice(0, 8)})`;
  const out: string[] = [];
  out.push(bold("coding.sh compare"));
  out.push(`baseline   ${name(r.baseline)}`);
  out.push(`candidate  ${name(r.candidate)}`);
  const ab = r.ablation;
  if (ab) {
    const a = r.baseline.name ?? r.baseline.bundleId.slice(0, 8);
    out.push(`A = ${a} · B = ${a} without ${ab.paths.join(", ")} (${ab.dropped.length} file${ab.dropped.length === 1 ? "" : "s"} dropped)`);
  }
  out.push(dim(`${r.pairedTasks} paired task(s) · k=${r.k} · ${r.baseline.runs} vs ${r.candidate.runs} runs`));
  out.push("");
  out.push(dim(row(["", "baseline", "candidate", "delta"])));
  const rate = (a: ArmSummary) => `${pct(a.passRate.p)} [${pct(a.passRate.lo).replace("%", "")}–${pct(a.passRate.hi)}]`;
  const dtext = `${pp(r.diff.mean)} [${pp(r.diff.lo).replace(" pp", "")}, ${pp(r.diff.hi)}]`;
  out.push(row(["pass rate", rate(r.baseline), rate(r.candidate), signed(r.diff.mean, false, dtext)]));
  out.push(row(["passes", `${r.baseline.passes}/${r.baseline.runs}`, `${r.candidate.passes}/${r.candidate.runs}`, `McNemar ${pval(r.mcnemar.p)}`]));
  if (r.baseline.tamperChecked || r.candidate.tamperChecked) {
    const tr = (a: ArmSummary) => (a.tamperChecked ? `${pct(a.tamperRate)} (${a.tampered}/${a.tamperChecked})` : "—");
    const td = r.candidate.tamperRate - r.baseline.tamperRate;
    out.push(row(["tamper rate", tr(r.baseline), tr(r.candidate), Number.isFinite(td) ? signed(td, true, pp(td)) : "—"]));
  }
  for (const m of r.metrics) {
    const rel = Number.isFinite(m.relative) ? ` (${m.relative >= 0 ? "+" : ""}${(m.relative * 100).toFixed(0)}%)` : "";
    const d = `${m.delta >= 0 && Number.isFinite(m.delta) ? "+" : ""}${fmtValue(m.delta, m.unit)}${rel}`;
    // "(3/10)": the mean covers only the runs where the metric is known.
    const val = (v: number, n: number, runs: number) => (n > 0 && n < runs ? `${fmtValue(v, m.unit)} ${dim(`(${n}/${runs})`)}` : fmtValue(v, m.unit));
    out.push(row([m.label, val(m.baseline, m.n.baseline, m.runs.baseline), val(m.candidate, m.n.candidate, m.runs.candidate), covered(m) ? signed(m.delta, true, d) : d]));
  }
  if (r.anatomy) {
    const fa = (a: ArmAnatomy) =>
      `${a.fails} (bad-run ${a.badRun} · beyond-arm ${a.beyondArm} · unsolved-by-all ${a.unsolvedByAll}${a.infra ? ` · infra ${a.infra}` : ""})`;
    out.push(`${pad("failures", W[0] as number)}A ${fa(r.anatomy.baseline)}`);
    out.push(`${pad("", W[0] as number)}B ${fa(r.anatomy.candidate)}`);
    const v = r.anatomy.variance;
    out.push(`${pad("variance", W[0] as number)}${Number.isFinite(v.task) ? `task ${share(v.task)} · arm ${share(v.arm)} · run-to-run ${share(v.run)}` : "no variance (every run had the same outcome)"}`);
  }
  // Only arms with a failed run whose own test result is known.
  const self = (["A", "B"] as const).map((k) => [k, k === "A" ? r.baseline.selfCheck : r.candidate.selfCheck] as const).filter(([, s]) => s && s.fails > s.unknown);
  self.forEach(([k, s], i) => {
    const rest = (["red", "stale", "none", "unknown"] as const).filter((x) => s[x] > 0).map((x) => `${x} ${s[x]}`);
    out.push(`${pad(i === 0 ? "own tests" : "", W[0] as number)}${k} fails ${s.fails}: own tests green ${s.green} (${share(s.green / s.fails)})${rest.length ? `, ${rest.join(", ")}` : ""}`);
    if (s.greenRuns >= 5 && s.otherRuns >= 5) {
      const ci = (x: Interval) => `${share(x.p)} [${share(x.lo).replace("%", "")}–${share(x.hi)}]`;
      out.push(dim(`${pad("", W[0] as number)}  own-green runs passed the verifier ${ci(s.greenPassRate)} vs ${ci(s.otherPassRate)} otherwise`));
    }
  });
  if (r.tasks.length) {
    out.push("");
    out.push(dim(row(["task", "baseline", "candidate", "first divergence"])));
    const max = opts.maxTasks ?? 20;
    for (const t of [...r.tasks].sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, max)) {
      const mark = t.diff > 0 ? good("▲") : t.diff < 0 ? bad("▼") : " ";
      const div = t.divergence ? `step ${t.divergence.index + 1}: ${t.divergence.a?.tool ?? "(end)"} vs ${t.divergence.b?.tool ?? "(end)"}` : "";
      // "▲ " + id must leave at least one space in the first column.
      const idW = (W[0] as number) - 3;
      const id = t.taskId.length > idW ? `${t.taskId.slice(0, idW - 1)}…` : t.taskId;
      out.push(row([`${mark} ${id}`, `${t.baseline.passes}/${t.baseline.runs}`, `${t.candidate.passes}/${t.candidate.runs}`, div]));
    }
    if (r.tasks.length > max) out.push(dim(`… ${r.tasks.length - max} more`));
  }
  if (r.bundleDiff) {
    out.push("");
    out.push(dim("harness changes"));
    for (const l of formatBundleDiff(r.bundleDiff)) out.push(`  ${l}`);
  }
  out.push("");
  const v = r.verdict;
  const vtext = v.kind === "better" ? good(v.text) : v.kind === "worse" ? bad(v.text) : bold(v.text);
  out.push(`verdict: ${vtext}`);
  if (r.gate) {
    const g = r.gate;
    const head = gateLine(g, ab);
    const label = ab ? "drop-it gate:" : "gate:";
    const indent = " ".repeat(label.length + 1);
    out.push(`${label} ${g.verdict === "ship" ? good(head) : g.verdict === "dont-ship" ? bad(head) : bold(head)}`);
    out.push(dim(`${indent}${gateDetail(g)}`));
    if (g.lost.length) out.push(`${indent}lost: ${idList(g.lost)}`);
    if (g.strata) {
      const w = Math.max(...g.strata.map((s) => s.group.length));
      for (const s of g.strata) {
        const h = gateHeadline(s.gate, "task");
        out.push(`${indent}${pad(s.group, w)}  ${s.gate.verdict === "ship" ? good(h) : s.gate.verdict === "dont-ship" ? bad(h) : h}`);
      }
    }
  }
  if (r.pareto) {
    const x = r.pareto;
    const what = x.unit === "usd" ? "cost" : "tokens";
    const cv = (v: number) =>
      !Number.isFinite(v) ? "—" : x.dC.scale === "relative" ? `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%` : `${v > 0 ? "+" : ""}${fmtValue(v, x.unit === "usd" ? "usd" : "count")}`;
    const head = `support ${x.support.toFixed(2)} ${x.promote ? "≥" : "<"} ${x.gamma.toFixed(2)} → ${x.promote ? "promote" : "hold"}`;
    const detail = `(${x.reason === "none" ? "" : `${x.reason}: `}${what} ${cv(x.dC.mean)} [${cv(x.dC.lo)}, ${cv(x.dC.hi)}], quality ${pp(x.dQ.mean)} [${pp(x.dQ.lo).replace(" pp", "")}, ${pp(x.dQ.hi)}])`;
    out.push(`pareto: ${x.promote ? good(head) : bold(head)} ${detail}`);
    for (const n of x.notes) out.push(dim(`        ${n}`));
  }
  if (r.itemGate) out.push(...itemGateLines(r.itemGate, opts.arms ?? "<A> <B>", { good, bad, bold, dim }));
  if (ab) {
    const e = ab.effect;
    out.push(`effect of ${ab.paths.join(", ")} = A − B: ${pp(e.mean)} [${pp(e.lo).replace(" pp", "")}, ${pp(e.hi)}]`);
  }
  const p = r.power;
  out.push(
    `power   MDE ${Number.isFinite(p.mde) ? `${(p.mde * 100).toFixed(1)}pp` : "—"} ` +
      dim(`(α ${p.alpha}, power ${Math.round(p.power * 100)}%, paired, sd of per-case Δ ${Number.isFinite(p.sd) ? p.sd.toFixed(2) : "—"})`),
  );
  for (const w of p.warnings) out.push(paint("33", `! ${w.message}`));
  for (const n of r.notes) out.push(dim(`note: ${n}`));
  const est = r.metrics.find((m) => m.key === "cost")?.costEstimatedRuns;
  if (est && est.baseline + est.candidate > 0) {
    out.push(dim(`cost: ${est.baseline + est.candidate} of ${r.baseline.runs + r.candidate.runs} runs estimated from the price table`));
  }
  return `${out.join("\n")}\n`;
}
