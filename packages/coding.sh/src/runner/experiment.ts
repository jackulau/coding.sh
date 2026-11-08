// A/B experiments over harness bundles: run every (task, bundle, attempt),
// then compare two arms with paired statistics and honest wording.
import { availableParallelism } from "node:os";
import { progressMetrics } from "../core/derail.ts";
import { sortableId } from "../core/ids.ts";
import type { Adapter, AgentEvent, BlobStore, EvalTask, HarnessBundle, IndexStore, RunResult, Session } from "../core/types.ts";
import { exactPowerText, pairedPower, type PowerAnalysis } from "../experiments/power.ts";
import { infraKind, withRetries, type InfraKind, type RetryPolicy } from "../jobs/retry.ts";
import type { JobScope } from "../jobs/store.ts";
import { pairedBootstrap, wilson, type BootstrapResult, type Interval } from "../stats/interval.ts";
import { mean } from "../stats/summary.ts";
import { itemGate, dec, type ItemGateOpts, type ItemGateReport } from "./gate-item.ts";
import { gateDetail, gateHeadline, gateVerdict, idList, type GateVerdict } from "../stats/gate.ts";
import { acceptanceGate, mcnemar, type GateOpts, type GateResult, type McNemarResult } from "../stats/tests.ts";
import { paretoSupport, type ParetoOpts, type ParetoSupport } from "../stats/pareto.ts";
import { failureAnatomy, nestedVarianceShares, type ArmAnatomy, type VarianceShares } from "./anatomy.ts";
import { diffBundles, formatBundleDiff, type BundleDiff, type InstructionSurface } from "./bundle.ts";
import { firstDivergence, type Divergence } from "./divergence.ts";
import { selfCheckSummary, type SelfCheckSummary } from "./selfcheck.ts";
import type { SnapshotOps } from "./git.ts";
import { attributeTamper, tamperDisclosure, type TamperAttribution, type TamperDisclosure } from "./tamper.ts";
import type { RepairOpts } from "./repair.ts";
import { armRepair, armSeq, passAfterRepair, seqRanking, type ArmRepair, type ArmSeq, type SeqRanking } from "./repair-report.ts";
import { runTask, type AgentRoute } from "./run.ts";
import { cellKey, DEFAULT_REUSE_MAX_AGE_MS, newestByCell, type ReuseOpts } from "./cells.ts";
import { agentVersions, releaseCache, releaseList, releaseNote, type AgentVersions } from "./release.ts";

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
  /** Ingests the spool after each run, before its dir is removed (see RunTaskOpts.ingest). */
  ingest?: () => Promise<unknown>;
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
  /**
   * Spend cap in USD over the agent cost each run reports plus its verifier's
   * `judge grade` calls: once the finished runs reach it, no new run starts. Runs already in flight finish, so the
   * total can pass the cap by up to `concurrency` runs. Runs that report no
   * cost count as $0 and are counted in `budget.unpriced`.
   */
  maxCostUsd?: number;
  /**
   * Copy finished runs of the same cell (runner/cells.ts) from earlier
   * comparisons instead of running them again, for these bundles only.
   */
  reuse?: ReuseOpts;
  /** The agent version a bundle runs under, for the cell key. Default: its adapter's detect(). */
  agentVersion?: (bundle: HarnessBundle) => Promise<string | undefined>;
  /** Only these of the scheduled jobs (`compare --retry-errors`); the rest are not part of this run. */
  select?: (job: Job) => boolean;
  /**
   * Stored runs this run replaces, by runKey (`--retry-errors`): once the job's
   * new run finishes, the old one is marked `superseded` so the slot counts once.
   */
  replaces?: ReadonlyMap<string, RunResult>;
  /** Repair rounds after a failed verifier (`compare --repair N`, see RunTaskOpts.repair). Part of each cell key. */
  repair?: RepairOpts;
}

/** The jobs of a run: scheduleJobs order, narrowed by `select`. */
function jobsOf(o: Pick<RunExperimentOpts, "tasks" | "bundles" | "k" | "select">): Job[] {
  const all = scheduleJobs(o.tasks, o.bundles, Math.max(1, o.k ?? 1));
  return o.select ? all.filter(o.select) : all;
}

/** Which jobs a stored run can stand in for, and which must run. */
export interface CellPlan {
  /** The jobs, in scheduleJobs order. */
  jobs: Job[];
  /** Cell key per job. */
  keys: string[];
  /** Job index → the stored run that will be copied. */
  cached: Map<number, RunResult>;
  /** Job indexes that must run. */
  missing: number[];
  /** With reuse: agents whose version is unknown, so an upgrade can't change the key. */
  unknownVersion: string[];
}

/** The cell key of every job, and with `reuse` the stored runs that can stand in for them. */
export async function planCells(o: Pick<RunExperimentOpts, "tasks" | "bundles" | "adapterFor" | "index" | "k" | "timeoutMs" | "env" | "route" | "reuse" | "agentVersion" | "select" | "repair">, excludeExperiment?: string): Promise<CellPlan> {
  const jobs = jobsOf(o);
  const versions = new Map<string, { adapter: string; version: string | undefined }>();
  for (const b of o.bundles) {
    let adapter = b.agent;
    let version: string | undefined;
    try {
      const a = o.adapterFor(b);
      adapter = a.id;
      version = o.agentVersion ? await o.agentVersion(b) : (await a.detect()).version;
    } catch {
      // no adapter or no version: the key says unknown
    }
    versions.set(b.id, { adapter, version });
  }
  const keys = jobs.map((j) => {
    const v = versions.get(j.bundle.id)!;
    return cellKey({ task: j.task, bundle: j.bundle, adapter: v.adapter, agentVersion: v.version, attempt: j.attempt, timeoutMs: o.timeoutMs, env: o.env, route: o.route, ...(o.repair ? { repair: o.repair } : {}) });
  });
  const cached = new Map<number, RunResult>();
  const unknownVersion = new Set<string>();
  if (o.reuse?.bundleIds.length) {
    const notBefore = (o.reuse.now ?? Date.now)() - (o.reuse.maxAgeMs ?? DEFAULT_REUSE_MAX_AGE_MS);
    const byCell = new Map<string, RunResult>();
    for (const id of new Set(o.reuse.bundleIds)) {
      if (!o.bundles.some((b) => b.id === id)) continue;
      if (versions.get(id)?.version === undefined) unknownVersion.add(versions.get(id)!.adapter);
      for (const [k, r] of newestByCell(await o.index.listRuns({ bundleId: id }), notBefore, excludeExperiment)) byCell.set(k, r);
    }
    jobs.forEach((j, i) => {
      const hit = o.reuse!.bundleIds.includes(j.bundle.id) ? byCell.get(keys[i] as string) : undefined;
      if (hit) cached.set(i, hit);
    });
  }
  return { jobs, keys, cached, missing: jobs.map((_, i) => i).filter((i) => !cached.has(i)), unknownVersion: [...unknownVersion] };
}

export interface BudgetReport {
  capUsd: number;
  spentUsd: number;
  /** Jobs never started because the cap was reached. */
  skipped: number;
  /** Finished runs whose agent reported no cost. */
  unpriced: number;
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

export async function runExperiment(
  o: RunExperimentOpts,
): Promise<{
  experimentId: string;
  results: RunResult[];
  cancelled: boolean;
  budget?: BudgetReport;
  reuse?: { reused: number; unknownVersion: string[] };
  /** Jobs this call had to run: neither kept from a resumed job nor copied by `reuse`. */
  planned: number;
  /** Jobs kept from the resumed job instead of run again. */
  skipped: number;
  /** With `replaces`: stored runs replaced by a new run (marked superseded). */
  retried?: number;
}> {
  const jobScope = o.job;
  const experimentId = jobScope?.state<string>("experimentId") ?? o.experimentId ?? sortableId("exp_");
  if (jobScope && jobScope.state("experimentId") === undefined) {
    await jobScope.setState("experimentId", experimentId);
    await jobScope.job.addRefs(experimentId);
  }
  const jobs = jobsOf(o);
  if (jobScope && jobScope.prefix === "") await jobScope.job.setTotal(jobs.length);
  // A resume keeps every run already recorded with a known outcome (the runs live in the index).
  const stored = jobScope ? new Map((await o.index.listRuns({ experimentId })).map((r) => [r.id, r])) : new Map<string, RunResult>();
  const prior = jobs.map((j) => {
    const l = jobScope?.done(runKey(j));
    const id = l && !l.infra ? (l.data as { runId?: string } | undefined)?.runId : undefined;
    return id ? stored.get(id) : undefined;
  });
  let done = prior.filter(Boolean).length;
  const cells = await planCells(o, experimentId);
  let reused = prior.filter((r) => r?.reusedFrom).length;
  const skipped = prior.filter(Boolean).length;
  const planned = jobs.filter((_, i) => !prior[i] && !cells.cached.has(i)).length;
  let retried = 0;
  const cap = o.maxCostUsd;
  const budget: BudgetReport | undefined = cap === undefined ? undefined : { capUsd: cap, spentUsd: 0, skipped: 0, unpriced: 0 };
  /** Add a finished run's agent and judge cost to the budget. */
  const charge = (r: RunResult) => {
    // A reused run was paid for by the comparison that ran it.
    if (!budget || r.reusedFrom) return;
    const cost = r.agent.usage?.costUsd;
    if (typeof cost === "number" && Number.isFinite(cost)) budget.spentUsd += cost;
    else budget.unpriced++;
    for (const round of r.repair?.rounds ?? []) {
      const c = round.usage?.costUsd;
      if (typeof c === "number" && Number.isFinite(c)) budget.spentUsd += c;
    }
    budget.spentUsd += r.graderUsage?.costUsd ?? 0;
  };
  // A resumed comparison counts what its recorded runs already spent.
  for (const r of prior) if (r) charge(r);
  // Jobs the cap kept from starting: not runs, and not a cancellation either.
  const capped = new Set<number>();
  // The release each run starts on, asked again at most once a minute so an auto-update mid-run shows.
  const release = releaseCache();
  const releaseOf = (b: HarnessBundle) => release(b.agent, () => o.adapterFor(b).detect());
  const settled = await pool(jobs, o.concurrency ?? defaultConcurrency(), async (job, i): Promise<RunResult | undefined> => {
    if (prior[i]) return prior[i];
    if (o.signal?.aborted || o.drain?.aborted) return undefined; // never started: not a run
    const src = cells.cached.get(i);
    if (src) {
      // The same cell finished in an earlier comparison: copy it under this experiment, no agent call.
      const copy: RunResult = { ...src, id: sortableId("run_"), experimentId, reusedFrom: src.id };
      await o.index.putRun(copy);
      await jobScope?.record(runKey(job), { ms: 0, outcome: copy.pass ? "pass" : "fail", data: { runId: copy.id, reusedFrom: src.id } });
      reused++;
      done++;
      o.onProgress?.({ done, total: jobs.length, result: copy, task: job.task, bundle: job.bundle });
      return copy;
    }
    if (budget && budget.spentUsd >= budget.capUsd) {
      budget.skipped++;
      capped.add(i);
      return undefined;
    }
    const t0 = Date.now();
    let last: RunResult | undefined;
    const tried = await withRetries(
      async () => {
        // A retried attempt stays in the index for the record, marked so comparisons leave it out.
        if (last) await o.index.putRun({ ...last, superseded: true }).catch(() => {});
        last = await attemptRun(o, job, experimentId, cells.keys[i], await releaseOf(job.bundle));
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
    charge(result);
    if (result.cancelled) return result; // killed mid-run: kept as cancelled in the index, not a finished run
    const old = o.replaces?.get(runKey(job));
    if (old) {
      // The slot now holds the new run; the old one stays in the index for the record.
      await o.index.putRun({ ...old, superseded: true });
      retried++;
    }
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
  return {
    experimentId,
    results,
    cancelled: settled.some((r, i) => (r === undefined && !capped.has(i)) || r?.cancelled === true),
    ...(budget ? { budget } : {}),
    ...(o.reuse ? { reuse: { reused, unknownVersion: cells.unknownVersion } } : {}),
    planned,
    skipped,
    ...(o.replaces ? { retried } : {}),
  };
}

/** One attempt of one job, stored in the index (runTask never throws for what the agent does). */
async function attemptRun(o: RunExperimentOpts, job: Job, experimentId: string, key?: string, agentVersion?: string): Promise<RunResult> {
  try {
    return await runTask({
      ...(key ? { cellKey: key } : {}),
      ...(agentVersion ? { agentVersion } : {}),
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
      ...(o.ingest ? { ingest: o.ingest } : {}),
      ...(o.repair ? { repair: o.repair } : {}),
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
    // A reused run's session was captured under the run it was copied from.
    if (!s) s = (await index.listSessions({ runId: r.reusedFrom ?? r.id, limit: 1 }))[0];
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

export type MetricKey = "cost" | "tokens" | "turns" | "wall" | "agentTime" | "llmTime" | "llmP50" | "llmP95" | "ttftP50" | "derails" | "onTrack";

export interface MetricDelta {
  key: MetricKey;
  label: string;
  unit: "usd" | "ms" | "count";
  /** Set when a bigger number is the better one (time on track); lower is better otherwise. */
  better?: "higher";
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
  /** With traces and tampered passes: passes whose every test change came with a statement that tests were being changed. */
  tamperedPassesDisclosed?: number;
  /** With traces and tampered passes: passes with a test change made silently. The rest have no matching tool call. */
  tamperedPassesStealth?: number;
  /** Failed runs split by the agent's own last test result (silent misses: own tests green, verifier red). */
  selfCheck: SelfCheckSummary;
  /** With witness audits (`eval audit`): passes a confirmed witness refuted. */
  refutedPasses?: number;
  /** With witness audits: passes the audit replayed (clean or refuted); unreplayable runs are not. */
  auditedRuns?: number;
  /** With witness audits: Wilson interval of (raw passes − refuted) / runs. */
  auditedPassRate?: Interval;
  /** With repair rounds (`compare --repair N`): first failures fixed after verifier feedback, rounds, extra cost. */
  repair?: ArmRepair;
  /** With repair rounds: Seq@1..K over attempts (first plus rounds), gain shares, unchanged rounds, cost to solve, the pass@k vs seq@k front. */
  seq?: ArmSeq;
}

/** One run's witness-audit outcome (src/eval/witness.ts); only "refuted" changes anything. */
export type RunAuditStatus = "clean" | "audited-clean" | "refuted" | "unaudited" | "unreplayable" | "replay-mismatch";

export interface TaskOutcome {
  taskId: string;
  baseline: { passes: number; runs: number };
  candidate: { passes: number; runs: number };
  /** candidate rate − baseline rate. */
  diff: number;
  divergence?: Divergence;
}

export type VerdictKind = "better" | "worse" | "no-difference" | "inconclusive";

export interface ArmSpend {
  /** Agent cost, summed over the runs whose cost is known. Reused runs (`compare --reuse`) are left out: an earlier comparison paid for them. */
  usd: number;
  /** Runs with a known agent cost (reused runs left out). */
  priced: number;
  /** Runs this comparison paid for (reused runs left out). */
  runs: number;
  /**
   * Runs copied from earlier comparisons, and what their originals cost (known
   * costs only). Absent when no run was reused.
   */
  reused?: { runs: number; usd: number; priced: number };
  /** What the verifiers' `judge grade` model calls cost (priced calls only). */
  graderUsd: number;
  /** Judge model calls, and how many of them had no price. */
  graderCalls: number;
  graderUnpriced: number;
}

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
  /** Total agent spend per arm (reported by the agent, else priced from the session), cancelled runs included. */
  spend: { baseline: ArmSpend; candidate: ArmSpend };
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
  /** With traces: each tamper-flagged run's flags linked to the tool call that made them, keyed by run id. */
  tamperAttribution?: Record<string, RunTamperAttribution>;
  /**
   * `compare --audited` with every pass in both arms audited: refuted passes count as
   * fails in everything above (pass rates, bootstrap, McNemar, gates). `rawVerdict` is
   * the verdict before.
   */
  audited?: { rawVerdict: VerdictKind; method: "manual" | "sampled" | "per-trial" };
  /** How the witness audits were made, when there are any. */
  auditMethod?: "manual" | "sampled" | "per-trial";
  /**
   * Instruction bytes per arm (runner/bundle.ts INSTRUCTION_GLOBS), present
   * when both bundles were given. relative = (B − A) / A (NaN when A has none).
   */
  surface?: { baseline: InstructionSurface; candidate: InstructionSurface; relative: number };
  /** Runs per arm copied from earlier comparisons (`compare --reuse`); absent when none were. */
  reused?: { baseline: number; candidate: number };
  /** `compare --repair-verdict`: every statistic above counts a run's pass after repair rounds, not its first attempt. */
  repairVerdict?: true;
  /** Both arms with the same repair settings: how they rank on first pass and within K attempts. */
  seqRanking?: SeqRanking;
  /**
   * The agent release each arm's runs ran on (runner/release.ts), present when
   * at least one counted run has a known release. `confound` says when the arms
   * ran on different releases or the release changed mid-comparison.
   */
  agentVersions?: AgentVersions;
}

/** A candidate whose instruction surface grows by more than this gets the bloat note. */
export const SURFACE_BLOAT = 0.2;

export interface RunTamperAttribution {
  taskId: string;
  arm: "baseline" | "candidate";
  pass: boolean;
  disclosure: TamperDisclosure;
  changes: TamperAttribution[];
}

/** The Pareto promotion gate: quality = pass (1/0) per run, cost = USD per run, else tokens. */
export interface ComparePareto extends ParetoSupport {
  unit: "usd" | "tokens";
  /** Which branch carried the promotion; "none" when held. */
  reason: "quality-gain" | "cost-cut" | "both" | "none";
  /** Set when the gate holds whatever the support: the arms ran on different agent releases. */
  refused?: "release_confound";
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
  /** Witness-audit outcome per run id (task.meta.audits); adds the audited pass rate per arm. */
  audit?: ReadonlyMap<string, RunAuditStatus>;
  auditMethod?: "manual" | "sampled" | "per-trial";
  /** Refuted passes count as fails before every statistic, when every pass in both arms was audited. */
  audited?: boolean;
  /** Each bundle's instruction surface (`instructionSurface`); used only when `bundles` has both arms. */
  surfaces?: { baseline: InstructionSurface; candidate: InstructionSurface };
  /** Verdict, gates and pass rates on each run's pass after repair rounds instead of its first attempt (`--repair-verdict`). */
  repairVerdict?: boolean;
}

type Extract = (r: RunResult, s: Session | undefined) => number | undefined;

const METRICS: { key: MetricKey; label: string; unit: MetricDelta["unit"]; better?: "higher"; get: Extract }[] = [
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
  // Where a run went off the rails (core/derail.ts), from its captured session.
  { key: "derails", label: "derails / run", unit: "count", get: (_r, s) => (s ? (s.stats.derails?.length ?? 0) : undefined) },
  {
    key: "onTrack",
    label: "time to first derail",
    unit: "ms",
    better: "higher",
    get: (_r, s) => (s && s.endedAt !== undefined ? progressMetrics(s.stats.derails ?? [], s.startedAt, s.endedAt).timeToFirstDerailMs : undefined),
  },
];

/** Each tamper-flagged run's flags linked to the tool calls in its trace (session cwd makes paths repo-relative). */
function tamperAttributions(A: readonly RunResult[], B: readonly RunResult[], opts: Pick<CompareOpts, "sessions" | "events">): Map<string, RunTamperAttribution> {
  const out = new Map<string, RunTamperAttribution>();
  for (const [armName, rs] of [["baseline", A], ["candidate", B]] as const) {
    for (const r of rs) {
      if (!r.tamper?.flagged) continue;
      const changes = attributeTamper(r.tamper, opts.events?.get(r.id) ?? [], opts.sessions?.get(r.id)?.cwd);
      out.set(r.id, { taskId: r.taskId, arm: armName, pass: r.pass, disclosure: tamperDisclosure(changes), changes });
    }
  }
  return out;
}

function arm(
  results: readonly RunResult[],
  bundleId: string,
  name: string | undefined,
  opts: Pick<CompareOpts, "sessions" | "events">,
  atts?: ReadonlyMap<string, RunTamperAttribution>,
): ArmSummary {
  const passes = results.filter((r) => r.pass).length;
  const checked = results.filter((r) => r.tamper);
  const tampered = checked.filter((r) => r.tamper?.flagged);
  const tamperedPasses = tampered.filter((r) => r.pass);
  const split = (d: TamperDisclosure) => tamperedPasses.filter((r) => atts?.get(r.id)?.disclosure === d).length;
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
    tamperedPasses: tamperedPasses.length,
    ...(atts && tamperedPasses.length ? { tamperedPassesDisclosed: split("disclosed"), tamperedPassesStealth: split("stealth") } : {}),
    selfCheck: selfCheckSummary(results, opts.sessions, opts.events),
  };
}

/**
 * The harness A/B report. With witness audits (`opts.audit`) each arm also gets its
 * audited pass rate; with `opts.audited` and every pass in both arms audited, refuted
 * passes count as fails before every statistic (TestJack, arXiv 2610.10619 Table 2:
 * refuted passes cut resolution by 17 points on average, so an A/B can flip).
 * With repair rounds (`compare --repair N`) each arm also gets its repair summary;
 * `opts.repairVerdict` moves every statistic to the pass after repair.
 */
export function compare(all: readonly RunResult[], opts: CompareOpts): CompareReport {
  if (!all.some((r) => r.repair)) {
    const r = compareAudited(all, opts);
    if (opts.repairVerdict) r.notes.push("no repair rounds in these runs, so no verdict after repair; run compare --repair N first");
    return r;
  }
  const r = compareAudited(opts.repairVerdict ? all.map((x) => (x.repair ? { ...x, pass: passAfterRepair(x) } : x)) : all, opts);
  // The repair summary always reads the first attempt as the first attempt.
  const counted = all.filter((x) => !x.cancelled && !x.superseded && !x.infra);
  const A = counted.filter((x) => x.bundleId === opts.baseline);
  const B = counted.filter((x) => x.bundleId === opts.candidate);
  const ra = armRepair(A);
  const rb = armRepair(B);
  const boot = { iters: opts.iters ?? 2000, seed: opts.seed ?? 0x5eed };
  const sa = armSeq(A, boot);
  const sb = armSeq(B, boot);
  if (ra) r.baseline.repair = ra;
  if (rb) r.candidate.repair = rb;
  if (sa) r.baseline.seq = sa;
  if (sb) r.candidate.seq = sb;
  if (!ra !== !rb) r.notes.push(`only the ${ra ? "baseline" : "candidate"} ran with repair rounds; compare first-attempt pass rates, not the rates after repair`);
  else if (ra && rb && (ra.limit !== rb.limit || ra.signal !== rb.signal)) r.notes.push(`the arms ran different repair settings (${ra.signal} ×${ra.limit} vs ${rb.signal} ×${rb.limit}); their rates after repair are not comparable, so they are not ranked by Seq@K`);
  else if (sa && sb) {
    const la = r.baseline.name ?? "baseline";
    const lb = r.candidate.name && r.candidate.name !== la ? r.candidate.name : la === "baseline" ? "candidate" : `${la} (candidate)`;
    const sr = seqRanking([
      { label: la, seq: sa },
      { label: lb, seq: sb },
    ]);
    if (sr) {
      r.seqRanking = sr;
      const f = sr.flipped[0];
      if (f) r.notes.push(`ranking changes with verifier feedback: ${f.higherInA} beats ${f.higherInB} on first pass, ${f.higherInB} beats ${f.higherInA} within ${sr.k} attempts`);
    }
  }
  if (opts.repairVerdict) {
    r.repairVerdict = true;
    r.notes.push("verdict, gates and pass rates count each run's pass after repair rounds (--repair-verdict), not its first attempt");
  }
  return r;
}

function compareAudited(all: readonly RunResult[], opts: CompareOpts): CompareReport {
  const audit = opts.audit;
  if (!audit?.size) {
    const r = compareRuns(all, opts);
    if (opts.audited) r.notes.push("no witness audits for these runs, so no audited verdict; run eval audit <task> --experiment <id> first");
    return r;
  }
  const raw = compareRuns(all, opts);
  const counted = (r: RunResult) => !r.cancelled && !r.superseded && !r.infra;
  const fields = (bundleId: string) => {
    const rs = all.filter((r) => r.bundleId === bundleId && counted(r));
    const passes = rs.filter((r) => r.pass);
    const st = (r: RunResult) => audit.get(r.id);
    const refuted = passes.filter((r) => st(r) === "refuted").length;
    const replayed = passes.filter((r) => ["clean", "audited-clean", "refuted"].includes(st(r) ?? "")).length;
    const seen = passes.filter((r) => st(r) !== undefined).length;
    const out: Partial<ArmSummary> = seen ? { refutedPasses: refuted, auditedRuns: replayed, auditedPassRate: wilson(passes.length - refuted, rs.length) } : {};
    return { out, replayed, passes: passes.length };
  };
  const fa = fields(opts.baseline);
  const fb = fields(opts.candidate);
  const method = opts.auditMethod ?? "manual";
  const withFields = (r: CompareReport): CompareReport => ({ ...r, baseline: { ...r.baseline, ...fa.out }, candidate: { ...r.candidate, ...fb.out }, auditMethod: method });
  if (!opts.audited) return withFields(raw);
  // An audited verdict needs every pass in both arms replayed: unreplayable and replay-mismatch passes leave it partial.
  if (fa.replayed < fa.passes || fb.replayed < fb.passes) {
    const part = (f: typeof fa) => `${f.replayed}/${f.passes}`;
    const which = !fb.replayed ? `baseline only (${part(fa)} passes)` : !fa.replayed ? `candidate only (${part(fb)} passes)` : `baseline ${part(fa)} and candidate ${part(fb)} passes`;
    const r = withFields(raw);
    r.notes.push(`audit covers ${which}; no audited verdict`);
    return r;
  }
  const rewritten = all.map((r) => (r.pass && audit.get(r.id) === "refuted" ? { ...r, pass: false } : r));
  const r = withFields(compareRuns(rewritten, opts));
  r.audited = { rawVerdict: raw.verdict.kind, method };
  const refuted = (fa.out.refutedPasses ?? 0) + (fb.out.refutedPasses ?? 0);
  r.notes.push(
    r.verdict.kind === raw.verdict.kind
      ? `audited: ${refuted} refuted pass(es) count as fails; the verdict is the same as without the audit`
      : `audited verdict ${r.verdict.kind} differs from the raw verdict ${raw.verdict.kind}: ${refuted} refuted pass(es) count as fails`,
  );
  return r;
}

function compareRuns(all: readonly RunResult[], opts: CompareOpts): CompareReport {
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
      ...(m.better ? { better: m.better } : {}),
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
  // Total agent spend, cancelled runs included: a killed run was still billed for what it did.
  // Repair rounds the agent priced are added to its first attempt's reported cost.
  const costOf = (r: RunResult) => {
    const c = r.agent.usage?.costUsd;
    if (c === undefined) return opts.sessions?.get(r.id)?.stats.usage?.costUsd;
    return (r.repair?.rounds ?? []).reduce((s, x) => s + (Number.isFinite(x.usage?.costUsd) ? (x.usage?.costUsd as number) : 0), c);
  };
  const known = (rs: readonly RunResult[]) => rs.map(costOf).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const spendOf = (id: string): ArmSpend => {
    const mine = all.filter((r) => r.bundleId === id);
    // A reused run's agent and grader cost were paid by the comparison that ran it: shown apart, not spent here.
    const rs = mine.filter((r) => !r.reusedFrom);
    const copies = mine.filter((r) => r.reusedFrom);
    const paid = known(rs);
    const sum = (f: (u: NonNullable<RunResult["graderUsage"]>) => number) => rs.reduce((s, r) => s + (r.graderUsage ? f(r.graderUsage) : 0), 0);
    const was = known(copies);
    return {
      usd: paid.reduce((s, x) => s + x, 0),
      priced: paid.length,
      runs: rs.length,
      ...(copies.length ? { reused: { runs: copies.length, usd: was.reduce((s, x) => s + x, 0), priced: was.length } } : {}),
      graderUsd: sum((u) => u.costUsd),
      graderCalls: sum((u) => u.calls),
      graderUnpriced: sum((u) => u.unpriced),
    };
  };
  const spend = { baseline: spendOf(opts.baseline), candidate: spendOf(opts.candidate) };

  const notes: string[] = [];
  if (k > 1) notes.push(`pass-rate intervals (Wilson) treat the ${k} runs per task as independent and are optimistic; the bootstrap CI resamples tasks and is the one to trust`);
  if (unpaired.length) notes.push(`${unpaired.length} task(s) ran in only one arm and are excluded from paired stats`);
  // With traces, each tamper flag is linked to the tool call that made it, and tampered passes split by disclosure.
  const atts = opts.events ? tamperAttributions(A, B, opts) : undefined;
  const sa = arm(A, opts.baseline, opts.bundles?.baseline?.name, opts, atts);
  const sb = arm(B, opts.candidate, opts.bundles?.candidate?.name, opts, atts);
  if (cancelled) notes.push(`${cancelled} run(s) were cancelled before they finished and are left out`);
  if (infra) notes.push(`${infra} run(s) still failed on infrastructure errors (rate limit, 5xx, network) after their retries and are left out; compare --resume runs them again`);
  if (retried) notes.push(`${retried} run(s) were retried after infrastructure errors; only their last attempt counts (task failures are never retried)`);
  const reused = { baseline: A.filter((r) => r.reusedFrom).length, candidate: B.filter((r) => r.reusedFrom).length };
  if (reused.baseline || reused.candidate) {
    const copies = [...A, ...B].filter((r) => r.reusedFrom);
    const fresh = [...A, ...B].filter((r) => !r.reusedFrom);
    const gap = fresh.length ? Math.max(...fresh.map((r) => r.startedAt)) - Math.min(...copies.map((r) => r.endedAt)) : 0;
    const which = [reused.baseline ? `baseline ${reused.baseline}/${A.length}` : "", reused.candidate ? `candidate ${reused.candidate}/${B.length}` : ""].filter(Boolean).join(", ");
    notes.push(
      `reused runs from earlier comparisons (${which})${gap > 0 ? `, finished up to ${ageText(gap)} before the new ones` : ""}: the arms did not run interleaved, so drift since then (model updates, API latency, rate limits) is not balanced across them`,
    );
  }
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
    let how = "";
    if (atts && tp) {
      const d = (sa.tamperedPassesDisclosed ?? 0) + (sb.tamperedPassesDisclosed ?? 0);
      const s = (sa.tamperedPassesStealth ?? 0) + (sb.tamperedPassesStealth ?? 0);
      how = ` (${d} disclosed, ${s} stealth${tp - d - s ? `, ${tp - d - s} untraced` : ""})`;
    }
    notes.push(
      `${tampered} run(s) edited, deleted or skipped tests (baseline ${sa.tampered}, candidate ${sb.tampered}); ${tp} of them passed${how} and still count as passes, so inspect their diffs before trusting the pass rate`,
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
  const surface = opts.bundles?.baseline && opts.bundles.candidate && opts.surfaces ? surfaceDelta(opts.surfaces.baseline, opts.surfaces.candidate) : undefined;
  const bloat = surface && (surface.relative > SURFACE_BLOAT || (!surface.baseline.bytes && surface.candidate.bytes > 0));
  if (surface && bloat) {
    const grew = surface.baseline.bytes ? `+${Math.round(surface.relative * 100)}%` : `0 → ${surface.candidate.bytes} bytes`;
    notes.push(`instruction surface ${grew}: require a success CI above 0, not just non-inferiority (instructions cost tokens on every turn)`);
  }
  const releases = agentVersions(A, B, opts.sessions, { baseline: opts.bundles?.baseline?.agent, candidate: opts.bundles?.candidate?.agent });
  const releaseText = releaseNote(releases);
  if (releaseText) notes.push(releaseText);
  let pareto: ComparePareto | undefined;
  if (opts.pareto) {
    const p = paretoGate(ta, tb, pairedIds, metrics, opts.sessions, { ...opts.pareto, seed: opts.seed });
    if (typeof p === "string") notes.push(p);
    // A promotion across agent releases would credit B with what the release did.
    else pareto = releases?.confound === "arms-differ" ? { ...p, promote: false, reason: "none", refused: "release_confound" } : p;
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
    power: pairedPower(diffs, { alpha, discordant: { b: mb, c: mc } }),
    metrics,
    spend,
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
    ...(atts?.size ? { tamperAttribution: Object.fromEntries(atts) } : {}),
    ...(surface ? { surface } : {}),
    ...(reused.baseline || reused.candidate ? { reused } : {}),
    ...(releases ? { agentVersions: releases } : {}),
  };
}

function surfaceDelta(baseline: InstructionSurface, candidate: InstructionSurface): NonNullable<CompareReport["surface"]> {
  const a = baseline.bytes;
  const b = candidate.bytes;
  return { baseline, candidate, relative: a ? (b - a) / a : NaN };
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
/** The gate's one-line answer: Ship it / Hold / Don't ship (Drop it / Keep it for an ablation), naming a blocking task group. */
export function gateLine(g: CompareGate, ab: AblationReport | undefined): string {
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

/** A coarse age: 40s, 12m, 5h, 3d. */
function ageText(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 2 * 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

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

/** The item gate's first line: `item gate k=3 τ=.34 m=2: KEEP · G=1.00 net +3 runs D=0 fired 3/6 · S=1 task`. */
export function itemGateLine(g: ItemGateReport): string {
  const id = (s: string) => s;
  return itemGateLines(g, "", { good: id, bad: id, bold: id, dim: id })[0] as string;
}

function itemGateLines(g: ItemGateReport, arms: string, p: Record<"good" | "bad" | "bold" | "dim", (s: string) => string>): string[] {
  const v = ITEM_PASS.has(g.verdict) ? p.good(g.verdict) : ITEM_FAIL.has(g.verdict) ? p.bad(g.verdict) : p.bold(g.verdict);
  const net = `net ${g.kN > 0 ? "+" : g.kN < 0 ? "−" : ""}${Math.abs(g.kN)} run${Math.abs(g.kN) === 1 ? "" : "s"}`;
  const lv = g.level ? ` · U=${dec(g.level.U)} A=${dec(g.level.A)}` : "";
  const out = [`item gate k=${g.k} τ=${dec(g.tau)} m=${g.m}: ${v} · G=${dec(g.G)} ${net} D=${dec(g.D)} fired ${g.f.fired}/${g.f.rollouts} · S=${g.S.length} task${g.S.length === 1 ? "" : "s"}${lv}`];
  const ind = "          ";
  if (g.item) out.push(p.dim(`${ind}${g.mode === "add" ? "B adds" : "B removes"} ${g.item.kind} ${g.item.path}${g.item.tier === "path" ? " (path-scoped)" : g.item.tier === "requested" ? " (on request)" : ""}`));
  if (g.level) {
    const order = ["internalized", "works", "between", "hurts", "uncovered"] as const;
    out.push(p.dim(`${ind}tasks: ${order.filter((l) => g.level!.labels[l]).map((l) => `${g.level!.labels[l]} ${l}`).join(", ")} (U without the item, A with it)`));
  }
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
  /** Task names by id: per-task rows show the name instead of the id. */
  taskNames?: ReadonlyMap<string, string>;
}

/** Tampered passes shown per arm before "… N more". */
const TAMPER_LINES = 5;

/** The change that decided a tampered run's label: a silent one for stealth, else the first linked one, else the first flag. */
export function decidingChange(x: RunTamperAttribution): TamperAttribution | undefined {
  return x.changes.find((c) => c.finding && (x.disclosure !== "stealth" || !c.finding.disclosed)) ?? x.changes[0];
}

/**
 * "tampered passes  B 3: disclosed 2, stealth 1" per arm with traced tampered
 * passes, then one line per pass naming the change and the tool call:
 * `run_01J… edit tests/sum.test.js by Edit (event e42), said: "…"`.
 */
function tamperedPassLines(r: CompareReport, f: { pad: (s: string) => string; bad: (s: string) => string; dim: (s: string) => string }): string[] {
  const att = r.tamperAttribution;
  if (!att) return [];
  const out: string[] = [];
  const q = (s: string) => `"${s.length > 80 ? `${s.slice(0, 79)}…` : s}"`;
  for (const [k, key] of [["A", "baseline"], ["B", "candidate"]] as const) {
    const a = r[key];
    if (!a.tamperedPasses || a.tamperedPassesDisclosed === undefined) continue;
    const d = a.tamperedPassesDisclosed;
    const s = a.tamperedPassesStealth ?? 0;
    const u = a.tamperedPasses - d - s;
    out.push(`${f.pad(out.length ? "" : "tampered passes")}${k} ${a.tamperedPasses}: disclosed ${d}, ${s ? f.bad(`stealth ${s}`) : "stealth 0"}${u ? `, untraced ${u}` : ""}`);
    const runs = Object.entries(att).filter(([, x]) => x.arm === key && x.pass);
    for (const [id, x] of runs.slice(0, TAMPER_LINES)) {
      const c = decidingChange(x);
      if (!c) continue;
      const fd = c.finding;
      let line = `${id} ${c.kind} ${c.path}`;
      if (!fd) line += ", no matching tool call in the trace";
      else {
        line += ` by ${fd.tool ?? fd.via} (event ${fd.eventId})`;
        if (fd.disclosed) line += `, said: ${q(fd.intent ?? "")}`;
        else line += `, stealth${fd.intent ? ` (said: ${q(fd.intent)})` : ", no reason given"}`;
      }
      out.push(f.dim(`${f.pad("")}  ${line}`));
    }
    if (runs.length > TAMPER_LINES) out.push(f.dim(`${f.pad("")}  … ${runs.length - TAMPER_LINES} more (--json: tamperAttribution)`));
  }
  return out;
}

/**
 * The "with verifier feedback" block (`compare --repair N`): first-attempt and
 * after-repair pass rates per arm, how many first failures were repaired and
 * in how many rounds, and what the rounds cost. Empty without repair.
 */
function repairLines(
  r: CompareReport,
  f: { row: (cells: string[]) => string; bad: (s: string) => string; dim: (s: string) => string; signed: (delta: number, lowerIsBetter: boolean, text: string) => string },
): string[] {
  const a = r.baseline.repair;
  const b = r.candidate.repair;
  if (!a && !b) return [];
  const both = [a, b];
  const cell = (fn: (x: ArmRepair) => string) => both.map((x) => (x ? fn(x) : "—"));
  const rate = (i: Interval) => `${pct(i.p)} [${pct(i.lo).replace("%", "")}–${pct(i.hi)}]`;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const how = (x: ArmRepair) => `${x.signal}, up to ${plural(x.limit, "round")}, ${x.mode}`;
  const same = a && b ? how(a) === how(b) : true;
  const out = ["", f.dim(`with verifier feedback (${same ? how((a ?? b)!) : `A ${a ? how(a) : "none"} · B ${b ? how(b) : "none"}`})`)];
  const sa = r.baseline.seq;
  const sb = r.candidate.seq;
  const seqs = [sa, sb];
  const scell = (fn: (x: ArmSeq) => string) => seqs.map((x) => (x ? fn(x) : "—"));
  // Seq@k: the share of tasks solved by the k-th attempt (the first, then each round).
  const K = Math.max(sa?.k ?? 0, sb?.k ?? 0);
  for (let k = 1; k <= K; k++) {
    const pt = (x: ArmSeq) => x.curve[k - 1];
    const d = sa && sb && pt(sa) && pt(sb) ? pt(sb)!.rate - pt(sa)!.rate : NaN;
    out.push(f.row([`seq@${k}${k === 1 ? " (first)" : ""}`, ...scell((x) => (pt(x) ? `${pct(pt(x)!.rate)} [${pct(pt(x)!.lo).replace("%", "")}–${pct(pt(x)!.hi)}]` : "—")), Number.isFinite(d) ? f.signed(d, false, pp(d)) : ""]));
  }
  // With false alarms the end state can fall below Seq@K: a told passing run may break.
  if (both.some((x) => x?.falseAlarm)) {
    const d = a && b ? b.passAfterRepair.p - a.passAfterRepair.p : NaN;
    out.push(f.row(["after repair", ...cell((x) => rate(x.passAfterRepair)), Number.isFinite(d) ? f.signed(d, false, pp(d)) : ""]));
  }
  out.push(f.row(["repaired", ...cell((x) => `${x.repaired}/${x.firstFails}${x.firstFails ? ` (${share(x.repairRate)})` : ""}${x.meanRounds !== undefined ? ` · ${x.meanRounds.toFixed(1)} rd` : ""}`)]));
  const g = (v: number | undefined) => (v === undefined ? "—" : v.toFixed(2));
  if (seqs.some((x) => x && (x.egs !== undefined || x.lgs !== undefined))) out.push(f.row(["gain shares", ...scell((x) => `EGS ${g(x.egs)} · LGS ${g(x.lgs)}`), f.dim("gain by attempt 2 · by the last")]));
  if (seqs.some((x) => x?.unchangedRate !== undefined)) out.push(f.row(["unchanged", ...seqs.map((x, i) => (x?.unchangedRate === undefined ? "—" : `${x.unchanged}/${both[i]?.rounds ?? "?"} (${share(x.unchangedRate)})`)), f.dim("rounds that changed no file")]));
  const money = (v: number) => `$${v.toFixed(v < 1 ? 3 : 2)}`;
  if (seqs.some((x) => x?.costToSolve !== undefined)) out.push(f.row(["cost to solve", ...scell((x) => (x.costToSolve === undefined ? "—" : money(x.costToSolve))), f.dim("agent spend per run solved")]));
  const usd = (x: ArmRepair) => (x.extraPriced ? money(x.extraCostUsd) : formatDuration(x.extraAgentMs));
  out.push(f.row(["extra", ...cell((x) => `${usd(x)} · ${plural(x.rounds, "round")}`)]));
  if (both.some((x) => x?.tamperedRepairs)) out.push(f.row(["tampered repairs", ...cell((x) => (x.tamperedRepairs ? f.bad(String(x.tamperedRepairs)) : "0")), f.dim("not counted as repaired")]));
  if (both.some((x) => x?.falseAlarm)) out.push(f.row([`false alarms`, ...cell((x) => (x.falseAlarm ? `${x.falseAlarm.fired} told, ${x.falseAlarm.broke} broke` : "—")), f.dim(`p = ${(a?.falseAlarm ?? b?.falseAlarm)!.p}`)]));
  if (both.some((x) => x?.namesUnparsed)) out.push(f.row(["names unparsed", ...cell((x) => String(x.namesUnparsed ?? 0)), f.dim("rounds sent the bare bit")]));
  if (both.some((x) => x?.skipped)) out.push(f.row(["not repaired", ...cell((x) => String(x.skipped)), f.dim("first attempt errored or timed out")]));
  // Cost per task against success, for k repair attempts (seq@k) and k independent attempts (pass@k).
  for (const [arm, x] of [["A", sa], ["B", sb]] as const) {
    if (!x?.front?.length) continue;
    const pts = x.front.map((p) => `${p.protocol.replace("@k", `@${p.k}`)} ${money(p.cost)} ${pct(p.success)}${p.overall ? "*" : ""}`);
    out.push(f.row([`front ${arm}`, pts.join(" · ")]));
  }
  if (seqs.some((x) => x?.front?.length)) out.push(f.dim(`${" ".repeat(18)}cost per task → success; * = no protocol does better at that cost`));
  return out;
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
  const row = (cells: string[], widths: readonly number[] = W) =>
    cells
      .map((x, i) => {
        const w = widths[i] ?? 10;
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
  const rv = r.agentVersions;
  if (rv?.confound) {
    const cell = (m: Record<string, number>, unknown: number) => `${releaseList(m, true) || "—"}${unknown ? dim(` ?×${unknown}`) : ""}`;
    const what = rv.confound === "arms-differ" ? bad("release differs") : dim("release changed mid-run");
    out.push(row([rv.agent ? `agent ${rv.agent}` : "agent", cell(rv.baseline, rv.unknown.baseline), cell(rv.candidate, rv.unknown.candidate), what]));
  }
  if (r.baseline.tamperChecked || r.candidate.tamperChecked) {
    const tr = (a: ArmSummary) => (a.tamperChecked ? `${pct(a.tamperRate)} (${a.tampered}/${a.tamperChecked})` : "—");
    const td = r.candidate.tamperRate - r.baseline.tamperRate;
    out.push(row(["tamper rate", tr(r.baseline), tr(r.candidate), Number.isFinite(td) ? signed(td, true, pp(td)) : "—"]));
  }
  // Witness audits: raw → audited pass rate per audited arm, "A 60% → 30% (3 refuted, coverage 100%)".
  const audited = (["A", "B"] as const).map((k) => [k, k === "A" ? r.baseline : r.candidate] as const).filter(([, a]) => a.auditedPassRate);
  audited.forEach(([k, a], i) => {
    const refuted = a.refutedPasses ?? 0;
    const raw = r.audited ? a.passes + refuted : a.passes;
    const cov = raw ? share((a.auditedRuns ?? 0) / raw) : "n/a";
    const how = r.auditMethod && r.auditMethod !== "manual" ? `, ${r.auditMethod}` : "";
    const text = `${k} ${share(raw / a.runs)} → ${share((raw - refuted) / a.runs)} (${refuted} refuted, coverage ${cov}${how})`;
    out.push(`${pad(i === 0 ? "audited pass" : "", W[0] as number)}${refuted ? bad(text) : text}`);
  });
  for (const m of r.metrics) {
    const rel = Number.isFinite(m.relative) ? ` (${m.relative >= 0 ? "+" : ""}${(m.relative * 100).toFixed(0)}%)` : "";
    const d = `${m.delta >= 0 && Number.isFinite(m.delta) ? "+" : ""}${fmtValue(m.delta, m.unit)}${rel}`;
    // "(3/10)": the mean covers only the runs where the metric is known.
    const val = (v: number, n: number, runs: number) => (n > 0 && n < runs ? `${fmtValue(v, m.unit)} ${dim(`(${n}/${runs})`)}` : fmtValue(v, m.unit));
    out.push(row([m.label, val(m.baseline, m.n.baseline, m.runs.baseline), val(m.candidate, m.n.candidate, m.runs.candidate), covered(m) ? signed(m.delta, m.better !== "higher", d) : d]));
  }
  if (r.surface) {
    const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
    const { baseline: a, candidate: b, relative } = r.surface;
    const d = b.bytes - a.bytes;
    const text = `${d >= 0 ? "+" : "−"}${kb(Math.abs(d))}${Number.isFinite(relative) ? ` (${relative >= 0 ? "+" : ""}${(relative * 100).toFixed(0)}%)` : ""}`;
    const files = (s: InstructionSurface) => `${kb(s.bytes)} ${dim(`(${Object.keys(s.files).length} files)`)}`;
    out.push(row(["surface", files(a), files(b), signed(d, true, text)]));
  }
  const sp = r.spend;
  if (sp && sp.baseline.priced + sp.candidate.priced > 0) {
    const priced = sp.baseline.priced + sp.candidate.priced;
    const runs = sp.baseline.runs + sp.candidate.runs;
    const usd = (x: number) => `$${x.toFixed(2)}`;
    out.push(row(["agent spend", usd(sp.baseline.usd), usd(sp.candidate.usd), `${usd(sp.baseline.usd + sp.candidate.usd)} total${priced < runs ? dim(` (${priced}/${runs} runs priced)`) : ""}`]));
  }
  const ra = sp?.baseline.reused;
  const rb = sp?.candidate.reused;
  if (ra || rb) {
    const usd = (x: number) => `$${x.toFixed(2)}`;
    const n = (ra?.runs ?? 0) + (rb?.runs ?? 0);
    const priced = (ra?.priced ?? 0) + (rb?.priced ?? 0);
    const cell = (x: typeof ra) => (x ? (x.priced ? usd(x.usd) : "—") : "");
    out.push(row(["reused", cell(ra), cell(rb), dim(`${priced ? `${usd((ra?.usd ?? 0) + (rb?.usd ?? 0))} ` : ""}not spent: ${n} run${n === 1 ? "" : "s"} paid for by earlier comparisons`)]));
  }
  if (sp && sp.baseline.graderCalls + sp.candidate.graderCalls > 0) {
    const usd = (x: number) => `$${x.toFixed(2)}`;
    const calls = sp.baseline.graderCalls + sp.candidate.graderCalls;
    const unpriced = sp.baseline.graderUnpriced + sp.candidate.graderUnpriced;
    out.push(row(["grader spend", usd(sp.baseline.graderUsd), usd(sp.candidate.graderUsd), `${usd(sp.baseline.graderUsd + sp.candidate.graderUsd)} total · ${calls} judge calls${unpriced ? dim(` (${unpriced} unpriced)`) : ""}`]));
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
  out.push(...tamperedPassLines(r, { pad: (s) => pad(s, W[0] as number), bad, dim }));
  out.push(...repairLines(r, { row: (cells) => row(cells), bad, dim, signed }));
  if (r.tasks.length) {
    out.push("");
    const max = opts.maxTasks ?? 20;
    const shown = [...r.tasks].sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, max);
    const labels = shown.map((t) => opts.taskNames?.get(t.taskId) || t.taskId);
    // Names widen the first column (up to 50) so names that share a prefix stay apart; bare ids keep 18.
    const tw = opts.taskNames?.size ? Math.min(50, Math.max(W[0] as number, ...labels.map((l) => l.length + 3))) : (W[0] as number);
    const widths = [tw, ...W.slice(1)];
    out.push(dim(row(["task", "baseline", "candidate", "first divergence"], widths)));
    shown.forEach((t, i) => {
      const mark = t.diff > 0 ? good("▲") : t.diff < 0 ? bad("▼") : " ";
      const div = t.divergence ? `step ${t.divergence.index + 1}: ${t.divergence.a?.tool ?? "(end)"} vs ${t.divergence.b?.tool ?? "(end)"}` : "";
      // "▲ " + label must leave at least one space in the first column.
      const label = labels[i] as string;
      const id = label.length > tw - 3 ? `${label.slice(0, tw - 4)}…` : label;
      out.push(row([`${mark} ${id}`, `${t.baseline.passes}/${t.baseline.runs}`, `${t.candidate.passes}/${t.candidate.runs}`, div], widths));
    });
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
  out.push(`${r.audited ? "verdict (audited)" : r.repairVerdict ? "verdict (after repair)" : "verdict"}: ${vtext}`);
  if (r.gate) {
    const g = r.gate;
    const head = gateLine(g, ab);
    const label = ab ? "drop-it gate:" : "gate:";
    const indent = " ".repeat(label.length + 1);
    out.push(`${label} ${g.verdict === "ship" ? good(head) : g.verdict === "dont-ship" ? bad(head) : bold(head)}`);
    out.push(dim(`${indent}${gateDetail(g)}`));
    if (g.lost.length) out.push(`${indent}lost: ${idList(g.lost)}`);
    if (r.agentVersions?.confound === "arms-differ") out.push(paint("33", `${indent}the arms ran on different agent releases (see the agent row): this answer mixes the change with the release`));
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
    const head = x.refused
      ? `support ${x.support.toFixed(2)} → hold (release confound: the arms ran on different agent releases)`
      : `support ${x.support.toFixed(2)} ${x.promote ? "≥" : "<"} ${x.gamma.toFixed(2)} → ${x.promote ? "promote" : "hold"}`;
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
    `power   MDE ${Number.isFinite(p.mde) ? `${(p.mde * 100).toFixed(1)}pp` : "—"}${exactPowerText(p)} ` +
      dim(`(α ${p.alpha}, power ${Math.round(p.power * 100)}%, paired, sd of per-case Δ ${Number.isFinite(p.sd) ? p.sd.toFixed(2) : "—"}${p.exact ? `, ${Math.round(p.exact.discordance * 100)}% discordant` : ""})`),
  );
  for (const w of p.warnings) out.push(paint("33", `! ${w.message}`));
  for (const n of r.notes) out.push(dim(`note: ${n}`));
  const est = r.metrics.find((m) => m.key === "cost")?.costEstimatedRuns;
  if (est && est.baseline + est.candidate > 0) {
    out.push(dim(`cost: ${est.baseline + est.candidate} of ${r.baseline.runs + r.candidate.runs} runs estimated from the price table`));
  }
  return `${out.join("\n")}\n`;
}
