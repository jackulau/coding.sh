// Run a task over a dataset, grade every output, aggregate with honest
// uncertainty, and (optionally) persist the result.
import { performance } from "node:perf_hooks";
import { sortableId } from "../core/ids.ts";
import type { FileEvalStore } from "../datasets/store.ts";
import { stampKinds, summarizeKinds } from "../datasets/kinds.ts";
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
  SeqAttempt,
  SeqTrajectory,
  Split,
  TraceEvent,
} from "../datasets/types.ts";
import type { JobScope } from "../jobs/store.ts";
import { infraStopFor, withRetries, type InfraStop, type RetryPolicy } from "../jobs/retry.ts";
import { mapPool } from "../judge/limit.ts";
import { pairedBootstrap, wilson } from "../stats/interval.ts";
import { summarize } from "../stats/summary.ts";
import { ADAPTIVE_MAX, ADAPTIVE_TRIALS, allPassKeys, CaseTracker, caseVerdicts, type SamplesMode } from "./samples.ts";
import { selectRunCases, type CaseSelection, type SelectOpts } from "./select.ts";
import { checkSeq, markUnchanged, seqCritic, seqFeedback, seqFeedbackName, seqTaskError, summarizeSeq, type SeqOpts } from "./seq.ts";
import { resolveTask, type ResolvedTask, type TaskContext, type TaskSpec } from "./task.ts";
import type { LlmCache } from "../llmcache/proxy.ts";
import { llmMetadata, openLlmCache, withLlmJob, type LlmRunOpts, type TaskLlm } from "../llmcache/run.ts";

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
  /** Run only some cases (X-26): another run's failures or errors, id patterns, a seeded sample, the first N. Stored as `metadata.selection`. */
  selection?: SelectOpts;
  /**
   * Continue this stored (cancelled or partial) experiment: same id, its
   * finished case-trials are kept and only the rest run. It must have run the
   * same dataset version, task, graders, trials and selection
   * (ResumeMismatchError names what changed). Infra-failed trials always run again.
   */
  resumeFrom?: ExperimentResult;
  /** With resumeFrom: also run again the case-trials whose task errored. */
  retryErrors?: boolean;
  /**
   * With a store: write the experiment so far, marked `metadata.checkpoint`
   * and status "cancelled", at most this often (ms) while it runs, so a crash
   * keeps a partial result to resume from.
   */
  checkpointMs?: number;
  /**
   * `exp run --seq K` (AC-9): a case-trial whose first attempt fails is tried
   * again with feedback, up to K attempts (seq.ts). The run's outcome stays
   * the first attempt's; `CaseRun.seq` holds the trajectory.
   */
  seq?: SeqOpts;
  /**
   * X-11: record the task's model calls, or replay them from another
   * experiment's recording (src/llmcache). Command tasks get
   * ANTHROPIC_BASE_URL/OPENAI_BASE_URL, function tasks `ctx.llm`; each
   * case-trial's counts land in `CaseRun.llm`, the settings in `metadata.llm`.
   */
  llm?: LlmRunOpts;
}

/** Thrown when resumeFrom ran with a different dataset, task, graders, trials or selection. */
export class ResumeMismatchError extends Error {
  /** What changed: "dataset", "task", "graders", "trials", "selection". */
  readonly fields: string[];
  constructor(id: string, fields: string[], detail: string[]) {
    super(`can't resume ${id}: ${detail.join("; ")}. Its finished case-trials would mix with ones measured differently`);
    this.name = "ResumeMismatchError";
    this.fields = fields;
  }
}

/** Throw ResumeMismatchError unless `prev` measured what this run measures. */
export function assertResumable(
  prev: ExperimentResult,
  now: { dataset: Pick<Dataset, "id" | "version">; task: ResolvedTask["info"]; graders: readonly Pick<Grader, "id" | "version">[]; trials: number; selection?: CaseSelection; seq?: unknown },
): void {
  const fields: string[] = [];
  const detail: string[] = [];
  const ds = (d: { id: string; version: string }) => `${d.id}@${d.version}`;
  if (ds(prev.dataset) !== ds(now.dataset)) {
    fields.push("dataset");
    detail.push(`dataset changed (${ds(prev.dataset)} → ${ds(now.dataset)})`);
  }
  if (prev.task.kind !== now.task.kind || prev.task.ref !== now.task.ref) {
    fields.push("task");
    detail.push(`task changed (${prev.task.kind}: ${prev.task.ref} → ${now.task.kind}: ${now.task.ref})`);
  }
  const gs = (g: readonly Pick<Grader, "id" | "version">[]) => g.map((x) => `${x.id}@${x.version.slice(0, 12)}`).sort().join(", ");
  if (gs(prev.graders) !== gs(now.graders)) {
    fields.push("graders");
    detail.push(`graders changed (${gs(prev.graders) || "none"} → ${gs(now.graders) || "none"})`);
  }
  if (prev.trials !== now.trials) {
    fields.push("trials");
    detail.push(`trials changed (${prev.trials} → ${now.trials})`);
  }
  const sel = (x: CaseSelection | undefined) => (x ? JSON.stringify({ ...x, selected: 0, of: 0 }) : "all cases");
  const prevSel = prev.metadata?.selection as CaseSelection | undefined;
  if (sel(prevSel) !== sel(now.selection)) {
    fields.push("selection");
    detail.push("the case selection changed");
  }
  if (JSON.stringify(prev.metadata?.seq ?? null) !== JSON.stringify(now.seq ?? null)) {
    fields.push("seq");
    detail.push("the --seq settings changed");
  }
  if (fields.length) throw new ResumeMismatchError(prev.id, fields, detail);
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
  /**
   * Counts case-trials that fail on infrastructure in a row (infraStopFor(retry));
   * once it stops, no new case-trial starts. Share one across every env of a run.
   */
  infraStop?: InfraStop;
  /** Sequential attempts with feedback (seq.ts). */
  seq?: SeqOpts;
  /** The run's llm cache (src/llmcache): each case-trial gets its own job on it. */
  llm?: LlmCache;
  /** Set by runTrial: the case-trial's llm job, handed to the task. */
  llmTask?: TaskLlm;
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
async function attemptTask(env: TrialEnv, c: Case, trial: number, seqCtx?: Pick<TaskContext, "attempt" | "k" | "history">): Promise<{ output?: unknown; trace?: TraceEvent[]; error?: string }> {
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
      ...(seqCtx ?? {}),
      ...(env.llmTask ? { llm: env.llmTask } : {}),
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
 * The rest of a sequential trajectory (seq.ts): while the latest attempt
 * failed, give feedback on it and try again, up to K attempts. Sets
 * `run.seq`; a pass ends it. A task error is a failed attempt whose message
 * is the feedback; an infra failure after retries ends the trial ungraded. A
 * drain lets the trajectory finish (it is one case-trial); the kill signal
 * drops it, and then this returns false.
 */
async function sequence(env: TrialEnv, c: Case, trial: number, run: CaseRun, first: { output: unknown; latencyMs: number; costUsd?: number }): Promise<boolean> {
  const o = env.seq!;
  const mode = o.feedback;
  const traj: SeqTrajectory = { k: o.k, feedback: seqFeedbackName(mode), history: o.history ?? "full", attempts: [] };
  const firstAttempt: SeqAttempt = { pass: run.pass, latencyMs: first.latencyMs, ...(first.costUsd !== undefined ? { costUsd: first.costUsd } : {}), ...(run.error !== undefined ? { error: run.error } : {}) };
  traj.attempts.push(firstAttempt);
  run.seq = traj;
  if (run.pass) {
    traj.solvedAt = 1;
    return true;
  }
  if (run.ungraded) return true; // outcome unknown: no feedback to give
  const outputs: unknown[] = [first.output];
  const history: { output: unknown; feedback: string }[] = [];
  let last = { output: first.output, error: run.error, grades: run.grades, attempt: firstAttempt };
  for (let t = 2; t <= o.k; t++) {
    if (env.signal?.aborted) return false;
    let feedback: string;
    if (typeof mode === "string") feedback = seqFeedback(mode, { ...(last.error !== undefined ? { error: last.error } : {}), grades: last.grades }, c.expected);
    else {
      const critic = await seqCritic(mode.critic, {
        input: c.input,
        output: last.output,
        expected: c.expected,
        caseId: c.id,
        ...(c.metadata ? { metadata: c.metadata } : {}),
        ...(env.signal ? { signal: env.signal } : {}),
        ...(last.error !== undefined ? { error: last.error } : {}),
      });
      feedback = critic.feedback;
      if (critic.costUsd !== undefined) last.attempt.criticCostUsd = critic.costUsd;
    }
    last.attempt.feedback = feedback;
    history.push({ output: last.output ?? null, feedback });
    const shown = traj.history === "last" ? history.slice(-1) : [...history];
    const t0 = performance.now();
    const tried = await withRetries(() => attemptTask(env, c, trial, { attempt: t, k: o.k, history: shown }), {
      policy: env.retry ?? { retries: 0, baseMs: 0, maxMs: 0 },
      errorOf: (a) => a.error,
      stop: [env.signal],
    });
    if (env.signal?.aborted) return false;
    const { output, trace, error } = tried.result;
    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
    if (tried.infra) {
      run.ungraded = true;
      run.infra = tried.infra;
      traj.attempts.push({ pass: false, latencyMs, error: error ?? tried.infra });
      return true;
    }
    const grades = error !== undefined ? [] : await gradeOne(env.graders, c, output, trace, env.signal);
    if (env.signal?.aborted) return false;
    const pass = error === undefined && !gradeUnknown(grades) && grades.every((g) => g.result?.pass === true);
    const cost = costOf(output);
    const a: SeqAttempt = { pass, latencyMs, ...(cost !== undefined ? { costUsd: cost } : {}), ...(error !== undefined ? { error } : {}) };
    traj.attempts.push(a);
    outputs.push(output);
    if (pass) {
      traj.solvedAt = t;
      break;
    }
    if (error === undefined && gradeUnknown(grades)) break; // a grader outage: no feedback to give
    last = { output, error, grades, attempt: a };
  }
  markUnchanged(traj.attempts, outputs);
  return true;
}

/**
 * Run and grade one case-trial, retrying infrastructure errors with backoff.
 * Undefined when it was not run (stopped before it started) or the signal
 * killed it part way: a killed task says nothing about the agent. A trial whose
 * last attempt still hit an infra error comes back with `infra` set and
 * `ungraded`: outcome unknown, and a resume runs it again.
 */
export async function runTrial(env: TrialEnv, c: Case, trial: number): Promise<CaseRun | undefined> {
  if (env.signal?.aborted || env.drain?.aborted || env.infraStop?.signal.aborted) return undefined; // stopped before it started: not a run
  if (!env.llm) return runTrialWith(env, c, trial);
  // One llm job per case-trial (every seq attempt shares it); it is closed, and its recording written, before the run is recorded.
  let run: CaseRun | undefined;
  const { llm } = await withLlmJob(env.llm, { expId: env.runId, caseId: c.id, trial }, async (llmTask) => {
    run = await runTrialWith({ ...env, ...(llmTask ? { llmTask } : {}) }, c, trial, true);
  });
  if (!run) return undefined;
  const r = run as CaseRun;
  if (llm) {
    r.llm = llm;
    // A replay that could not run past its boundary (no source recording, an upstream error) is not scored.
    if (llm.unscored) {
      r.ungraded = true;
      r.pass = false;
    }
  }
  if (env.job) await recordTrial(env.job, c, trial, r);
  return r;
}

async function recordTrial(job: JobScope, c: Case, trial: number, run: CaseRun): Promise<void> {
  await job.record(trialKey(c.id, trial), {
    ms: run.latencyMs,
    ...(run.attempts ? { attempts: run.attempts } : {}),
    ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
    ...(run.infra ? { infra: run.infra } : {}),
    outcome: run.error !== undefined ? "error" : run.pass ? "pass" : "fail",
    data: run,
  });
}

async function runTrialWith(env: TrialEnv, c: Case, trial: number, deferRecord = false): Promise<CaseRun | undefined> {
  const { signal, graders } = env;
  const startedAt = Date.now();
  const t0 = performance.now();
  const tried = await withRetries(() => attemptTask(env, c, trial, env.seq ? { attempt: 1, k: env.seq.k, history: [] } : undefined), {
    policy: env.retry ?? { retries: 0, baseMs: 0, maxMs: 0 },
    errorOf: (a) => a.error,
    stop: [signal, env.drain, env.infraStop?.signal],
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
  env.infraStop?.add(run.infra);
  if (env.seq && !(await sequence(env, c, trial, run, { output, latencyMs, ...(cost !== undefined ? { costUsd: cost } : {}) }))) return undefined;
  if (env.job && !deferRecord) await recordTrial(env.job, c, trial, run);
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
  infraStop?: ExperimentResult["infraStop"];
}): ExperimentResult {
  const runs = stampKinds(o.runs, o.dataset.cases);
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
    runs,
    summary: summarizeRuns(runs, o.graders, o.trials, o.boot),
  };
  if (o.metadata) result.metadata = o.metadata;
  if (o.samples === "adaptive") {
    result.samples = "adaptive";
    result.summary.caseVerdicts = caseVerdicts(runs.map((r) => ({ key: r.caseId, pass: r.ungraded ? undefined : r.pass })));
  }
  if (o.regression) result.regression = o.regression;
  if (o.infraStop) result.infraStop = o.infraStop;
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
  let cases = selectCases(opts.dataset, opts.split, opts.filter);
  let selection: CaseSelection | undefined;
  if (opts.selection) ({ cases, selection } = selectRunCases(cases, opts.selection));
  if (opts.seq) {
    checkSeq(opts.seq);
    const why = seqTaskError(opts.task);
    if (why) throw new RangeError(why);
  }
  const seqMeta = opts.seq ? { k: opts.seq.k, feedback: seqFeedbackName(opts.seq.feedback), history: opts.seq.history ?? "full" } : undefined;
  const withSel = selection ? { ...(opts.metadata ?? {}), selection } : opts.metadata;
  const withSeq = seqMeta ? { ...(withSel ?? {}), seq: seqMeta } : withSel;
  const metadata = opts.llm ? { ...(withSeq ?? {}), llm: llmMetadata(opts.llm, opts.task) } : withSeq;
  const task = resolveTask(opts.task);
  const job = opts.job;
  const prev = opts.resumeFrom;
  if (prev) assertResumable(prev, { dataset: opts.dataset, task: task.info, graders, trials, ...(selection ? { selection } : {}), ...(seqMeta ? { seq: seqMeta } : {}) });
  const { id, createdAt } = await rememberIdentity(job, prev ? { id: prev.id, createdAt: prev.createdAt } : { id: opts.id ?? sortableId("exp_"), createdAt: Date.now() });
  // Case-trials resumeFrom finished: kept unless infra-failed (or task-errored, with retryErrors).
  const kept = new Map<string, CaseRun>();
  for (const r of prev?.runs ?? []) if (!r.infra && !(opts.retryErrors && r.error !== undefined)) kept.set(trialKey(r.caseId, r.trial), r);
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
  // Checkpoints (checkpointMs): the experiment so far, written while it runs.
  const finished: CaseRun[] = [];
  let lastCheckpoint = 0;
  let writes = Promise.resolve();
  // A throttled checkpoint is written when the window ends, so a hung case after a burst still finds the burst stored.
  let trailing: ReturnType<typeof setTimeout> | undefined;
  const checkpoint = () => {
    if (!opts.store || opts.checkpointMs === undefined) return;
    const now = Date.now();
    const wait = opts.checkpointMs - (now - lastCheckpoint);
    if (wait > 0) {
      trailing ??= setTimeout(() => ((trailing = undefined), checkpoint()), wait);
      trailing.unref?.();
      return;
    }
    lastCheckpoint = now;
    const snap = experimentResult({
      id,
      name: opts.name,
      status: "cancelled",
      dataset: opts.dataset,
      ...(opts.split !== undefined ? { split: opts.split } : {}),
      task: task.info,
      graders,
      trials,
      createdAt,
      runs: [...finished],
      boot: { iters: opts.bootstrapIters ?? 2000, seed: opts.seed ?? 0x5eed },
      metadata: { ...(metadata ?? {}), checkpoint: { done: finished.length, total, at: now } },
    });
    const store = opts.store;
    writes = writes.then(() => store.putExperiment(snap)).catch(() => {});
  };
  const settle = (run: CaseRun | undefined): CaseRun | undefined => {
    if (run) finished.push(run);
    if (run && tracker.add(run.caseId, outcome(run).pass) && !regression) {
      regression = { caseId: run.caseId, baseline: base!.id };
      stop.abort();
    }
    return run;
  };
  let done = 0;
  let total = jobs.length;
  const infraStop = infraStopFor(opts.retry);
  const env: TrialEnv = {
    runId: id,
    task,
    graders,
    drain,
    infraStop,
    ...(signal ? { signal } : {}),
    ...(job ? { job } : {}),
    ...(opts.retry ? { retry: opts.retry } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.seq ? { seq: opts.seq } : {}),
  };
  const cache = opts.llm ? await openLlmCache(opts.llm) : undefined;
  if (cache) env.llm = cache;
  const runAll = async (list: { c: Case; trial: number }[]) => {
    // A resume keeps every case-trial already recorded with a known outcome.
    const prior = list.map(({ c, trial }) => priorRun(job, c.id, trial) ?? kept.get(trialKey(c.id, trial)));
    done += prior.filter(Boolean).length;
    return mapPool(list, opts.concurrency ?? 4, async ({ c, trial }, i) => {
      if (prior[i]) return settle(prior[i]);
      const run = await runTrial(env, c, trial);
      if (run) opts.onProgress?.(run, ++done, total);
      const out = settle(run);
      if (run) checkpoint();
      return out;
    });
  };
  let settled: (CaseRun | undefined)[];
  try {
    settled = await runAll(jobs);
    // Adaptive: a third trial for each case whose first two disagree.
    const ties = adaptive && !drain.aborted && !signal?.aborted && !infraStop?.signal.aborted ? cases.filter((c) => tracker.needsTieBreak(c.id)).map((c) => ({ c, trial: ADAPTIVE_MAX })) : [];
    if (ties.length) {
      total += ties.length;
      if (job && job.prefix === "") await job.job.setTotal(total);
      settled.push(...(await runAll(ties)));
    }
  } finally {
    await cache?.close();
  }
  const result = experimentResult({
    id,
    name: opts.name,
    // Cancelled when some case-trial never ran or was cut short (infra-failed ones did run), or a regression or an infra streak stopped it.
    status: settled.some((r) => r === undefined) || regression || infraStop?.report ? "cancelled" : "completed",
    ...(adaptive ? { samples: "adaptive" as const } : {}),
    ...(regression ? { regression } : {}),
    infraStop: infraStop?.report,
    dataset: opts.dataset,
    ...(opts.split !== undefined ? { split: opts.split } : {}),
    task: task.info,
    graders,
    trials,
    createdAt,
    runs: settled.filter((r): r is CaseRun => r !== undefined),
    boot: { iters: opts.bootstrapIters ?? 2000, seed: opts.seed ?? 0x5eed },
    ...(metadata ? { metadata } : {}),
  });
  clearTimeout(trailing);
  await writes;
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
  const seq = summarizeSeq(runs, trials, boot);
  const kinds = summarizeKinds(runs, trials, boot);
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
    ...(seq ? { seq } : {}),
    ...(kinds ? { kinds } : {}),
  };
}
