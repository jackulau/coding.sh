// Contracts for the generic eval engine: datasets, graders, judges and
// experiments over ANY agent (not only coding agents replayed from a repo).
// Kept separate from src/core/types.ts so this engine can evolve without a
// cross-module contract change; see FileEvalStore for persistence.
import type { SequentialOutcome } from "../stats/sequential.ts";

// ---------------------------------------------------------------- datasets

export type Split = "train" | "dev" | "test";
export const SPLITS: readonly Split[] = ["train", "dev", "test"];

export interface Case {
  /** Stable id. Defaults to a content hash of input + expected. */
  id: string;
  input: unknown;
  expected?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
  /** Session this case was harvested from, when it came from a captured trace. */
  sourceSessionId?: string;
  split?: Split;
}

export interface Dataset {
  /** Stable across versions: slug of the name. */
  id: string;
  name: string;
  /** Content hash over the (id-sorted) cases. Same cases → same version. */
  version: string;
  cases: Case[];
  description?: string;
  createdAt?: number;
}

export interface DatasetVersionInfo {
  version: string;
  cases: number;
  createdAt: number;
  note?: string;
}

// ---------------------------------------------------------------- traces

/**
 * Minimal trace event a grader or judge can cite. Structurally compatible with
 * coding.sh/trace AgentEvent, but any agent's spans can be mapped onto it.
 */
export interface TraceEvent {
  id: string;
  kind: string;
  ts?: number;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------- graders

export interface GradeContext {
  input: unknown;
  output: unknown;
  expected?: unknown;
  metadata?: Record<string, unknown>;
  trace?: readonly TraceEvent[];
  /** The agent's work as a unified diff, when the caller has it (`judge grade --diff`, $CODING_SH_AGENT_DIFF in a verifier). */
  diff?: string;
  /** Case id, when grading a dataset case (used for logs/caching only). */
  caseId?: string;
  signal?: AbortSignal;
}

export interface Citation {
  eventId?: string;
  quote: string;
  /** Set by the judge: whether the quote was actually found in the material shown to it. */
  verified?: boolean;
}

export interface GradeResult {
  /** 0..1 */
  score: number;
  pass: boolean;
  reason?: string;
  citations?: Citation[];
}

export type CalibrationState = "calibrated" | "uncalibrated" | "in-sample" | "insufficient-data";

/** Attached to graders whose scores need human agreement before they can be trusted (LLM judges). */
export interface CalibrationStatus {
  state: CalibrationState;
  kappa?: number;
  kappaLo?: number;
  kappaHi?: number;
  n?: number;
  split?: Split;
  reason?: string;
  ts?: number;
  /**
   * Held-out confusion rates, for the Rogan–Gladen correction in `exp compare`:
   * sensitivity = P(judge pass | human pass), specificity = P(judge fail | human fail),
   * measured on `positives` human passes and `negatives` human fails.
   */
  sensitivity?: number;
  specificity?: number;
  positives?: number;
  negatives?: number;
}

export interface Grader {
  /** Name used in reports, e.g. "exact" or "helpfulness". Unique within an experiment. */
  id: string;
  /** Hash of the grader's config (and code, for module graders). */
  version: string;
  kind: string;
  /** Only judges carry this; `undefined` means deterministic and trusted as is. */
  calibration?: CalibrationStatus;
  /** LLM judges only: the full judge version, so a run can persist it for later calibration. */
  judgeVersion?: JudgeVersion;
  grade(ctx: GradeContext): Promise<GradeResult>;
}

// ---------------------------------------------------------------- judges

export interface JudgeVersion {
  /** `<name>@<hash12>` over model + prompt template + rubric + criterion + params. */
  id: string;
  name: string;
  criterion: string;
  rubric: string;
  provider: string;
  model: string;
  /** sha256 of the prompt template. */
  promptHash: string;
  params: Record<string, unknown>;
  status: "draft" | "production";
  /** Splits whose cases were looked at while iterating on the prompt/rubric. */
  tunedOn: Split[];
  passThreshold: number;
  createdAt: number;
  calibration?: CalibrationStatus;
}

export interface JudgeVerdict extends GradeResult {
  /** 0..1; how sure the judge is. Model-reported when present, else |score − 0.5| · 2. */
  confidence: number;
  judgeVersion: string;
  cached: boolean;
}

// ---------------------------------------------------------------- experiments

export interface GraderInfo {
  id: string;
  version: string;
  kind: string;
  calibration?: CalibrationStatus;
}

export interface GraderOutcome {
  graderId: string;
  result?: GradeResult;
  error?: string;
}

export interface CaseRun {
  caseId: string;
  trial: number;
  output?: unknown;
  error?: string;
  latencyMs: number;
  grades: GraderOutcome[];
  /** Task succeeded and every grader passed. */
  pass: boolean;
  /**
   * A grader errored (judge outage, crashed scorer), so whether this run passed
   * is unknown. `pass` is false, but the run is left out of pass rates and
   * paired comparisons instead of counting as a failure.
   */
  ungraded?: true;
  startedAt: number;
  /** Attempts the task took when infrastructure errors (rate limit, 5xx, network) were retried; absent for one. */
  attempts?: number;
  /**
   * The last attempt still hit an infrastructure error after its retries: the
   * outcome is unknown (also `ungraded`), and `--resume` runs it again.
   */
  infra?: "rate-limit" | "server" | "network" | "tempfail";
  /** What the task reported it cost (`costUsd` on its output). */
  costUsd?: number;
  /** Content key of this case-trial (experiments/trial-cells.ts); set by matrix runs. */
  cellKey?: string;
  /** Copied by `exp run --reuse` from this earlier experiment instead of run again. */
  reusedFrom?: string;
}

export interface Interval {
  p: number;
  lo: number;
  hi: number;
}

export interface GraderSummary {
  id: string;
  kind: string;
  n: number;
  passed: number;
  errors: number;
  meanScore: number;
  passRate: Interval;
  calibration?: CalibrationStatus;
}

export interface ExperimentSummary {
  /** Case × trial count. */
  n: number;
  cases: number;
  passed: number;
  /** Runs whose task errored (they count as failures). */
  errors: number;
  /** Runs with a grader error: outcome unknown, left out of `passRate` (absent on older records). */
  ungraded?: number;
  /** Of the ungraded runs, those whose task hit infrastructure errors after its retries (absent when none). */
  infra?: number;
  /** Over graded runs: passed / (n − ungraded). */
  passRate: Interval;
  /** "wilson" for one trial per case; "cluster-bootstrap" (over cases) for several. */
  ciMethod: "wilson" | "cluster-bootstrap";
  graders: GraderSummary[];
  latencyMs: { mean: number; median: number; p90: number; max: number };
}

export interface TaskInfo {
  kind: "function" | "command" | "http" | "continuation";
  /** Human description: function name, argv, URL (credentials stripped), or continuation:<provider>/<model>#<harness hash>. */
  ref: string;
}

/**
 * "completed": every case-trial ran. "cancelled": interrupted (Ctrl-C,
 * SIGTERM); `runs` holds only the case-trials that finished before that, and
 * compare refuses it unless forced. Absent on older records = completed.
 */
export type ExperimentStatus = "completed" | "cancelled";

/**
 * Set on both arms of an interleaved A/B run (`exp run --arm`, `exp aa`):
 * one job queue ran (case, trial, arm) in a seeded order, so drift over the
 * run hit both arms alike.
 */
export interface ExperimentPair {
  /** Shared by both arms. */
  id: string;
  /** This arm's name. */
  arm: string;
  /** Experiment ids, A first. */
  experiments: [string, string];
  /** Seed of the case order and of the arm order within each case-trial. */
  seed: number;
  /** With --stop-early: the group sequential plan and where it stopped. */
  sequential?: SequentialOutcome;
}

export interface ExperimentResult {
  id: string;
  name: string;
  status?: ExperimentStatus;
  dataset: { id: string; name: string; version: string; split?: Split };
  task: TaskInfo;
  graders: GraderInfo[];
  trials: number;
  createdAt: number;
  finishedAt: number;
  runs: CaseRun[];
  summary: ExperimentSummary;
  metadata?: Record<string, unknown>;
  /** Present when this run is one arm of an interleaved A/B. */
  pair?: ExperimentPair;
}
