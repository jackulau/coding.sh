// Paired comparison of two experiments on the same cases. Pairing by case id
// removes between-case variance (most of it, on agent evals), so a paired
// bootstrap CI on per-case differences and an exact McNemar test on per-case
// outcomes detect changes an unpaired comparison would miss.
import type { Case, CaseKind, CaseRun, ExperimentResult } from "../datasets/types.ts";
import { compareKinds, type KindComparisonReport } from "../datasets/kinds.ts";
import { infraKinds, infraKindsText, voidText, type InfraKind } from "../jobs/retry.ts";
import { verifierCorrected, type VerifierAudit, type VerifierCorrection } from "../judge/verifier.ts";
import { clusteredBootstrap } from "../stats/cluster.ts";
import { pairedBootstrap, roganGladen, type BootstrapOpts, type RoganGladenResult } from "../stats/interval.ts";
import { pairedPosterior, type PairedPosterior } from "../stats/posterior.ts";
import type { SequentialOutcome } from "../stats/sequential.ts";
import { gateVerdict, type GateVerdict } from "../stats/gate.ts";
import { acceptanceGate, clusterSignFlip, fisherExact, hardRegressions, mcnemar, nonInferiority, type GateOpts, type GateResult, type McNemarResult, type NonInferiorityResult, type SignFlipResult } from "../stats/tests.ts";
import type { ReplayNoise } from "./continuation.ts";
import { llmReplayNote, type ComparisonLlmReplay } from "../llmcache/report.ts";
import { pairedPower, passHatK, type NoisePrior, type PowerAnalysis } from "./power.ts";
import { caseRates, summarizeRuns } from "./run.ts";
import { directionStability, type DirectionStability } from "./stability.ts";
import { outcomesByCase, turnover, type Turnover } from "./turnover.ts";
import type { HumanLabel } from "../judge/calibrate.ts";
import { graderPpi, labelMajority, type GraderPpi } from "./ppi.ts";
import type { ReplicationConclusion } from "./replicate.ts";
import { selectionWarning } from "./select.ts";
import { stampedWith, weightsOf, weightsWarning, type WeightsStamp } from "./weights.ts";

export interface CaseDelta {
  caseId: string;
  /** Pass rate over trials in A and B. */
  a: number;
  b: number;
  delta: number;
}

export interface GraderDelta {
  id: string;
  n: number;
  meanA: number;
  meanB: number;
  diff: { mean: number; lo: number; hi: number };
  /**
   * Rogan–Gladen bias-corrected judge pass rate per side, present when that
   * side's grader calibration carries sensitivity and specificity.
   */
  corrected?: { a?: RoganGladenResult; b?: RoganGladenResult };
  /**
   * Pass rate corrected for an audited verifier's precision (`judge calibrate --grader
   * <verifier>`), per side, present when that side's grader version has a stored audit.
   */
  verifier?: { a?: VerifierCorrection; b?: VerifierCorrection };
  /**
   * Judge graders only (kind "llm", or calibrated on either side): how often a
   * resample of the per-case score differences keeps the sign, and n*.
   */
  stability?: DirectionStability;
  /** Set when A and B graded with different versions of this grader: its B − A mixes the change with a new measurement. */
  versionChanged?: { a: string; b: string };
  /**
   * Judge graders with human labels (`labels` option): the PPI++ corrected
   * B − A on the human scale, or why it is missing. Absent without labels.
   */
  ppi?: GraderPpi;
  /** Judge error warnings from the human labels (ΔJ between arms, low sensitivity). Absent without labels. */
  warnings?: string[];
}

const unit = (x: unknown): x is number => typeof x === "number" && x >= 0 && x <= 1;

/** Corrected pass rate of one judge grader in one experiment, or undefined without calibration rates. */
function correctedRate(r: ExperimentResult, graderId: string): RoganGladenResult | undefined {
  const cal = r.graders.find((g) => g.id === graderId)?.calibration;
  const s = r.summary.graders.find((g) => g.id === graderId);
  if (!cal || !s || !(s.n > 0) || !unit(cal.sensitivity) || !unit(cal.specificity)) return undefined;
  const nCal =
    typeof cal.positives === "number" && typeof cal.negatives === "number" ? { positives: cal.positives, negatives: cal.negatives } : (cal.n ?? 0);
  return roganGladen(s.passed / s.n, cal.sensitivity, cal.specificity, s.n, nCal);
}

/** Precision-corrected pass rate of one verifier grader in one experiment, or undefined without an audit. */
function verifierRate(r: ExperimentResult, graderId: string, audits: ReadonlyMap<string, VerifierAudit> | undefined): VerifierCorrection | undefined {
  const version = r.graders.find((g) => g.id === graderId)?.version;
  const audit = version ? audits?.get(version) : undefined;
  const s = r.summary.graders.find((g) => g.id === graderId);
  if (!audit || !s || !(s.n > 0)) return undefined;
  return verifierCorrected(s.passed / s.n, s.n, audit);
}

/** Clusters below which the cluster bootstrap is flagged as unreliable. */
export const MIN_CLUSTERS = 10;
/** Paired cases below which compare also reports the Bayesian posterior. */
export const POSTERIOR_BELOW = 100;
/** Attrition p-value below which compare warns. */
export const ATTRITION_ALPHA = 0.01;
/** A gap between two runs above which compare says how far apart they ran. */
export const TIMING_GAP_MS = 24 * 3600_000;

/** When A and B ran relative to each other. */
export interface Timing {
  /** Both arms came from one interleaved run (`exp run --arm`, `exp aa`, or two cells of one matrix run). */
  interleaved: boolean;
  /** Time between the first run's end and the second's start; 0 when they overlapped. */
  gapMs: number;
  /** Set when the two runs were not interleaved and did not overlap. */
  warning?: string;
}

function duration(ms: number): string {
  const h = ms / 3600_000;
  if (h >= 48) return `${Math.round(h / 24)} days`;
  if (h >= 1) return `${Math.round(h)} h`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** Interleaved, overlapping, or one after the other (with how far apart). */
type Timed = Pick<ExperimentResult, "createdAt" | "finishedAt" | "pair" | "metadata">;
const matrixOf = (r: Timed) => (r.metadata?.matrix as { id?: unknown } | undefined)?.id;

const reusedOf = (r: Timed) => {
  const n = (r.metadata?.matrix as { reused?: unknown } | undefined)?.reused;
  return typeof n === "number" && n > 0 ? n : 0;
};

export function runTiming(a: Timed, b: Timed): Timing {
  const ma = matrixOf(a);
  const sameMatrix = typeof ma === "string" && ma === matrixOf(b);
  const copied = sameMatrix ? reusedOf(a) + reusedOf(b) : 0;
  const interleaved = (!!a.pair && a.pair.id === b.pair?.id) || (sameMatrix && !copied);
  const start = Math.max(a.createdAt, b.createdAt);
  const end = Math.min(a.finishedAt, b.finishedAt);
  const out: Timing = { interleaved, gapMs: Math.max(0, start - end) };
  if (copied) {
    // `exp run --reuse` copied case-trials from earlier runs: those did not run next to the new ones.
    const which = [reusedOf(a) ? `A ${reusedOf(a)}` : "", reusedOf(b) ? `B ${reusedOf(b)}` : ""].filter(Boolean).join(", ");
    out.warning = `reused case-trials from earlier experiments (${which}): they did not run interleaved with the new ones, so drift since then (model updates, API latency, rate limits) is not balanced across the cells`;
    return out;
  }
  if (interleaved || start < end) return out;
  const fix = "run both in one interleaved job: coding.sh exp run --arm a=<TASK> --arm b=<TASK>";
  out.warning =
    out.gapMs > TIMING_GAP_MS
      ? `A and B ran ${duration(out.gapMs)} apart: provider drift, rate limits and time of day may differ between them and show up as a difference; ${fix}`
      : `A and B ran one after the other, not interleaved, so drift during the runs lands on one arm; ${fix}`;
  return out;
}

export interface ClusterInfo {
  /** Case metadata field the cases were grouped by. */
  key: string;
  /** Distinct clusters among the paired cases. */
  clusters: number;
  /** Paired cases without the key; each counts as its own cluster. */
  missing: number;
  /** Set below MIN_CLUSTERS. */
  warning?: string;
}

/** Trials one arm lost before an outcome was known. */
export interface ArmAttrition {
  /** Trials expected: runs that happened plus missing ones. */
  runs: number;
  /** Ran and graded. */
  completed: number;
  /** Task errors (they count as fails in the pass rate). */
  errored: number;
  /**
   * Trials lost to infrastructure: those still on an infra error after their
   * retries (a refused login, a failed setup, a rate limit; outcome unknown,
   * counted in `ungraded`), plus task errors that look like infrastructure
   * (timeouts, spawn failures, network, HTTP 429/5xx).
   */
  infra: number;
  /** The task errors that do not look like infrastructure (the agent crashed or exited non-zero). */
  agent: number;
  /** Grader errors and trials still on an infra error after their retries: outcome unknown, left out. */
  ungraded: number;
  /** Trials of cases that ran only in the other arm (same dataset version only). */
  missing: number;
  /** errored + ungraded + missing. */
  lost: number;
}

export interface Attrition {
  a: ArmAttrition;
  b: ArmAttrition;
  /** Fisher's exact two-sided p for lost vs kept trials by arm. */
  p: number;
  /** Set when p < ATTRITION_ALPHA: one arm lost noticeably more trials. */
  warning?: string;
}

const INFRA = /time[sd]? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network|could not start|spawn|ENOMEM|killed by SIG|HTTP (429|5\d\d)\b|rate.?limit|overloaded/i;

/** Whether a task error message looks like infrastructure rather than the agent. */
export function isInfraError(message: string): boolean {
  return INFRA.test(message);
}

function armAttrition(runs: readonly CaseRun[], missing: number): ArmAttrition {
  let errored = 0;
  let infraErrors = 0;
  let infraUnknown = 0;
  let ungraded = 0;
  for (const r of runs) {
    if (r.infra) {
      // Still on an infra error after its retries: outcome unknown, not a task failure.
      infraUnknown++;
      ungraded++;
    } else if (r.error !== undefined) {
      errored++;
      if (isInfraError(r.error)) infraErrors++;
    } else if (r.ungraded) ungraded++;
  }
  const lost = errored + ungraded + missing;
  return { runs: runs.length + missing, completed: runs.length - errored - ungraded, errored, infra: infraErrors + infraUnknown, agent: errored - infraErrors, ungraded, missing, lost };
}

/**
 * Each case's cluster from a case field: `metadata.<key>` (a leading
 * "metadata." is optional), or, for "session", the case's source session
 * when its metadata has none. Cases without a value are left out.
 */
export function clusterMap(cases: readonly Case[], key: string): Map<string, string> {
  const k = key.replace(/^metadata\./, "");
  const out = new Map<string, string>();
  for (const c of cases) {
    const v = c.metadata?.[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.set(c.id, String(v));
    else if (k === "session" && c.sourceSessionId) out.set(c.id, c.sourceSessionId);
  }
  return out;
}

export interface Comparison {
  /** `weights`: the checkpoint the side ran (`exp run --weights`); absent when it was not stamped. */
  a: { id: string; name: string; passRate: number; weights?: WeightsStamp };
  b: { id: string; name: string; passRate: number; weights?: WeightsStamp };
  /**
   * Set when both sides carry the same weights stamp and neither is a regrade
   * of the other, or when only one side carries a stamp. Absent when neither
   * side is stamped.
   */
  weightsWarning?: string;
  /** Set when A and B ran on different dataset versions (pairing still by case id). */
  datasetWarning?: string;
  /** Runs left out because a grader errored or the task still hit an infra error after its retries (outcome unknown), per side. */
  ungraded: { a: number; b: number };
  /** Of the ungraded runs, those lost to infrastructure after their retries (a refused login, a failed setup, …), per side and by kind. Absent when none. */
  infra?: { a: number; b: number; kinds: Partial<Record<InfraKind, number>> };
  /** Set when either side has ungraded runs: the comparison covers only graded runs. Starts with "void:" when infrastructure left no pair to compare. */
  gradeWarning?: string;
  /** Cases that ran on both sides but have no graded run on at least one, so they are not paired. Absent when none. */
  ungradedCases?: string[];
  /** Grader ids that graded only one side. Absent when both sides used the same graders. */
  gradersOnlyIn?: { a: string[]; b: string[] };
  /**
   * Set when the two sides were not measured with the same instrument: a
   * grader changed version, or graded one side only. The pass rate is a
   * conjunction of every grader, so B − A then mixes the change under test
   * with a change of measurement (regrade A with B's graders to separate them).
   */
  instrumentWarning?: string;
  paired: number;
  onlyInA: string[];
  onlyInB: string[];
  /** Mean of per-case (B − A) pass-rate differences, with paired bootstrap CI (over clusters with `cluster`). */
  diff: { mean: number; lo: number; hi: number; iters: number };
  /** Present with the cluster option: the bootstrap resampled clusters of cases. */
  cluster?: ClusterInfo;
  /**
   * Present below POSTERIOR_BELOW paired cases, where percentile bootstrap
   * intervals under-cover: Dirichlet posterior on the paired majority outcomes.
   */
  posterior?: PairedPosterior;
  /** Trials each arm lost to task errors, grader errors or missing runs, and whether the split is uneven. */
  attrition: Attrition;
  /** On per-case majority outcomes: b = A pass → B fail (regressions), c = A fail → B pass. */
  mcnemar: McNemarResult;
  /**
   * Exact two-sided sign-flip test of the same per-case differences at the
   * bootstrap's unit: cases, or clusters with `cluster`. p is 1 with no pairs.
   */
  signFlip: SignFlipResult;
  /**
   * "better" / "worse" when the CI excludes 0 and the sign-flip p is below
   * alpha; otherwise "inconclusive". A percentile interval is [x, x] when a few
   * units all move the same way, so on its own it calls 3 improved cases
   * better. For a group sequential A/B (`sequential`), the sequential test's
   * verdict: the fixed-n interval is not valid for that design.
   */
  verdict: "better" | "worse" | "inconclusive";
  /** Whether A and B were interleaved, and how far apart they ran if not. */
  timing: Timing;
  /** Present when A and B are the two arms of one `exp run --arm … --stop-early` run. */
  sequential?: SequentialOutcome;
  /** Set when that run stopped early: the paired bootstrap above assumes a fixed n. */
  sequentialWarning?: string;
  regressions: CaseDelta[];
  improvements: CaseDelta[];
  graders: GraderDelta[];
  /** Minimum detectable effect for this paired design and the warnings it implies. */
  power: PowerAnalysis;
  /**
   * Present when either side ran more than one trial: pass^k (tau-bench), the
   * share of paired cases where every one of the k trials passed.
   */
  passK?: { a: { k: number; rate: number }; b: { k: number; rate: number }; diff: number };
  /** Present with the gate option (`exp compare --gate`): adopt B or keep A. */
  gate?: ComparisonGate;
  /** Present with the margin option (`exp compare --margin`): is B at most δ worse than A? */
  nonInferiority?: ComparisonNonInferiority;
  /**
   * Coverage turnover on paired, graded cases: cases B gained or lost (passed
   * in any of k trials), per-case reliability shift, the success-count matrix
   * and the trial-half check.
   */
  turnover: ComparisonTurnover;
  /**
   * Continuation experiments (EM-19): how often the control arm (A, the
   * recorded config) diverged from the recorded turn from the same prefix.
   * `warning` is set when B's change is smaller than that noise floor.
   */
  replay?: ComparisonReplay;
  /** Set when A is a continuation experiment with no control arm (`exp run --no-control`). */
  controlWarning?: string;
  /**
   * X-11: a side replayed recorded model calls (`exp run --replay`). The arms
   * are correlated; `noise` is the control arm's divergence from the recording.
   */
  llmReplay?: ComparisonLlmReplay;
  /**
   * Set when one side ran only on the other side's failures or errors
   * (`exp run --failing`/`--errors-from`) and the two were not chosen alike:
   * the verdict is forced to inconclusive (regression to the mean).
   */
  selectionWarning?: string;
  /** AC-9: Seq@K of each side and B − A, when both ran --seq with the same K and feedback. */
  seqK?: ComparisonSeqK;
  /** Why there is no Seq@K row although one side ran --seq. */
  seqNote?: string;
  /** Set with CompareOpts.verdictOn: what the verdict was read from ("pass" when Seq@K was asked for but missing). */
  verdictOn?: "pass" | "seq";
  /** TB-12: the comparison split by case kind (bad fixed, guards and controls broken); absent when no paired case has a kind. */
  kinds?: KindComparisonReport;
  /** Present with the given option (`exp compare --given`): every number above is over the kept cases only. */
  given?: ComparisonGiven;
}

/** `exp compare --given <grader>`: the cases where that grader passes in both arms are compared, the rest are dropped. */
export interface ComparisonGiven {
  grader: string;
  /** Cases that ran on both sides and passed the gate grader on both (a majority of trials). */
  kept: number;
  /** Cases that ran on both sides and did not. */
  dropped: number;
  /** Plain words: the deltas hold among the kept cases, not on the whole dataset. */
  note: string;
}

export interface ComparisonReplay extends ReplayNoise {
  /** |B − A| is below the noise floor: the replay itself moves outcomes that much. */
  withinNoise: boolean;
  warning?: string;
}

/**
 * Paired non-inferiority on the per-case pass-rate differences: B is
 * non-inferior when the lower end of the two-sided (1 − alpha) CI, the
 * interval printed as B − A, lies above −δ (one-sided level alpha/2).
 */
export interface ComparisonNonInferiority extends NonInferiorityResult {
  /** Cases A passed on every trial that B passes on at most a third of its trials. */
  hardRegressions: string[];
}

export interface ComparisonTurnover extends Turnover {
  /** Set when the verdict is significant but the mean change reverses between trial halves. */
  warning?: string;
}

/**
 * The acceptance gate (SAGE) on per-case majority outcomes of paired, graded
 * cases: wins = improved, losses = regressed, solved = cases A passes.
 */
export interface ComparisonGate extends GateResult {
  /** ship (accept), hold (not enough evidence) or dont-ship (B breaks solved cases). */
  verdict: GateVerdict;
  /** Cases A solved that B lost. */
  lostCases: string[];
  /** Cases A failed that B solved. */
  wonCases: string[];
  /** Set when trials were lost to errors: the gate counts errored trials as failures. */
  note?: string;
  /** `exp compare --pairwise` (AB-13): the pairwise judges turned a ship into a hold. */
  judgeHold?: { conclusion: ReplicationConclusion; detail: string };
}

export interface ComparisonSeqK {
  k: number;
  feedback: string;
  /** Paired cases. */
  n: number;
  a: number;
  b: number;
  diff: { mean: number; lo: number; hi: number; n: number };
}

export interface CompareOpts {
  /** Compare only the cases where this grader passes in both arms (a majority of each arm's trials); see ComparisonGiven. */
  given?: string;
  /** "seq": read the verdict from the Seq@K difference instead of the first-attempt pass rate, when both sides have one. */
  verdictOn?: "pass" | "seq";
  iters?: number;
  seed?: number;
  /** Two-sided level for the bootstrap CI and the MDE. Default 0.05. */
  alpha?: number;
  /** Target power for the MDE. Default 0.8. */
  power?: number;
  /** Warn when fewer paired cases than this. Default 200. */
  minPaired?: number;
  /** Compare a cancelled experiment anyway (its unfinished cases are missing, not failed). */
  force?: boolean;
  /** Resample clusters, not cases: `key` names the case field, `of` maps case id → cluster (see clusterMap). */
  cluster?: { key: string; of: ReadonlyMap<string, string> };
  /** A/A noise floor of this config on this dataset (`exp aa`); power planning uses it. */
  noise?: NoisePrior;
  /** Add the acceptance gate with these settings. */
  gate?: GateOpts;
  /** Add a non-inferiority check: how much worse (pass-rate points, 0.05 = 5pp) B may be. */
  margin?: number;
  /** Stored verifier precision audits by grader version (`FileEvalStore.getVerifierAudit`). */
  verifiers?: ReadonlyMap<string, VerifierAudit>;
  /** The control arm's replay noise floor (continuation.ts replayNoise on A). */
  replay?: ReplayNoise;
  /**
   * Human labels of each arm's outputs, by case (never shared across arms):
   * judge graders get a PPI++ corrected delta (src/experiments/ppi.ts).
   */
  labels?: { a: readonly HumanLabel[]; b: readonly HumanLabel[] };
  /** Minimum usable labels per arm for a corrected delta. Default 20. */
  minLabels?: number;
  /** Judge criterion by grader id, for matching labels' `criterion` (default: the grader id). */
  criteria?: ReadonlyMap<string, string>;
}

/** Thrown when a side of a comparison is a cancelled (partial) experiment and `force` is not set. */
export class IncompleteExperimentError extends Error {
  readonly experimentId: string;
  constructor(r: Pick<ExperimentResult, "id" | "name" | "runs">) {
    super(`experiment ${r.name} (${r.id}) was cancelled after ${r.runs.length} case run(s); its result is partial`);
    this.name = "IncompleteExperimentError";
    this.experimentId = r.id;
  }
}

/** Per case: the share of graded trials this grader passed. */
function graderPassShares(r: ExperimentResult, graderId: string): Map<string, number> {
  const acc = new Map<string, { s: number; n: number }>();
  for (const run of r.runs) {
    const g = run.grades.find((x) => x.graderId === graderId);
    if (!g?.result) continue;
    const a = acc.get(run.caseId) ?? { s: 0, n: 0 };
    if (g.result.pass) a.s++;
    a.n++;
    acc.set(run.caseId, a);
  }
  return new Map([...acc].map(([k, v]) => [k, v.s / v.n]));
}

function graderMeans(r: ExperimentResult, graderId: string): Map<string, number> {
  const acc = new Map<string, { s: number; n: number }>();
  for (const run of r.runs) {
    const g = run.grades.find((x) => x.graderId === graderId);
    if (!g?.result) continue;
    const a = acc.get(run.caseId) ?? { s: 0, n: 0 };
    a.s += g.result.score;
    a.n++;
    acc.set(run.caseId, a);
  }
  return new Map([...acc].map(([k, v]) => [k, v.s / v.n]));
}

/** Seq@K per case: the share of its graded trials solved by attempt K. */
function seqRates(r: ExperimentResult): Map<string, number> {
  const acc = new Map<string, { s: number; n: number }>();
  for (const run of r.runs) {
    if (!run.seq || run.ungraded) continue;
    const x = acc.get(run.caseId) ?? { s: 0, n: 0 };
    x.s += run.seq.solvedAt !== undefined ? 1 : 0;
    x.n++;
    acc.set(run.caseId, x);
  }
  return new Map([...acc].map(([k, v]) => [k, v.s / v.n]));
}

/** The Seq@K row (paired bootstrap over cases) when A and B ran --seq alike, else a note saying why there is none. */
function seqKCompare(
  a: ExperimentResult,
  b: ExperimentResult,
  boot: (ids: readonly string[], diffs: readonly number[]) => { mean: number; lo: number; hi: number; n: number },
): { seqK?: ComparisonSeqK; seqNote?: string } {
  const qa = a.summary.seq;
  const qb = b.summary.seq;
  if (!qa && !qb) return {};
  const say = (q: typeof qa) => (q ? `K ${q.k} with ${q.feedback} feedback` : "no --seq");
  if (!qa || !qb || qa.k !== qb.k || qa.feedback !== qb.feedback) return { seqNote: `Seq@K not compared: A ran ${say(qa)}, B ran ${say(qb)}; run both with the same --seq and --feedback` };
  const ra = seqRates(a);
  const rb = seqRates(b);
  const ids = [...ra.keys()].filter((id) => rb.has(id)).sort();
  const d = boot(
    ids,
    ids.map((id) => (rb.get(id) as number) - (ra.get(id) as number)),
  );
  const mean = (m: Map<string, number>) => (ids.length ? ids.reduce((s, id) => s + (m.get(id) as number), 0) / ids.length : NaN);
  return { seqK: { k: qa.k, feedback: qa.feedback, n: ids.length, a: mean(ra), b: mean(rb), diff: { mean: d.mean, lo: d.lo, hi: d.hi, n: d.n } } };
}

/** Grader ids that graded both experiments: the ones `--given` can gate on. */
export function givenGraders(a: Pick<ExperimentResult, "graders">, b: Pick<ExperimentResult, "graders">): string[] {
  return a.graders.map((g) => g.id).filter((id) => b.graders.some((g) => g.id === id));
}

/** Both experiments cut down to the cases where the gate grader passes in both, and how many cases that kept and dropped. */
function givenCases(a: ExperimentResult, b: ExperimentResult, grader: string): { a: ExperimentResult; b: ExperimentResult; given: ComparisonGiven } {
  const have = givenGraders(a, b);
  if (!have.includes(grader)) {
    throw new RangeError(`no grader named ${JSON.stringify(grader)} in both experiments${have.length ? `; graders in both: ${have.join(", ")}` : "; they share no grader"}`);
  }
  const sa = graderPassShares(a, grader);
  const sb = graderPassShares(b, grader);
  const ran = [...new Set(a.runs.map((r) => r.caseId))].filter((id) => b.runs.some((r) => r.caseId === id));
  // Majority of trials, as in the per-case outcomes McNemar reads.
  const keep = new Set(ran.filter((id) => (sa.get(id) ?? 0) >= 0.5 && (sb.get(id) ?? 0) >= 0.5));
  const cut = (r: ExperimentResult): ExperimentResult => {
    const runs = r.runs.filter((x) => keep.has(x.caseId));
    return { ...r, runs, summary: summarizeRuns(runs, r.graders, r.trials) };
  };
  const kept = keep.size;
  const dropped = ran.length - kept;
  return {
    a: cut(a),
    b: cut(b),
    given: {
      grader,
      kept,
      dropped,
      note: `conditioned on ${grader}: only the ${kept} case(s) where ${grader} passes in both A and B are compared, ${dropped} dropped. The deltas describe those cases, not the whole dataset`,
    },
  };
}

export function compareExperiments(a: ExperimentResult, b: ExperimentResult, opts: CompareOpts = {}): Comparison {
  if (!opts.force) for (const x of [a, b]) if (x.status === "cancelled") throw new IncompleteExperimentError(x);
  let given: ComparisonGiven | undefined;
  if (opts.given !== undefined) ({ a, b, given } = givenCases(a, b, opts.given));
  const boot = { iters: opts.iters ?? 10_000, seed: opts.seed ?? 0x5eed, alpha: opts.alpha ?? 0.05 };
  const ra = caseRates(a.runs);
  const rb = caseRates(b.runs);
  const ids = [...ra.keys()].filter((id) => rb.has(id)).sort();
  // "Only in" means the case ran on one side only; a case that ran on both but is ungraded on one is just left out.
  const ranA = new Set(a.runs.map((r) => r.caseId));
  const ranB = new Set(b.runs.map((r) => r.caseId));
  const onlyInA = [...ranA].filter((id) => !ranB.has(id)).sort();
  const onlyInB = [...ranB].filter((id) => !ranA.has(id)).sort();
  const deltas: CaseDelta[] = ids.map((caseId) => {
    const x = ra.get(caseId) as number;
    const y = rb.get(caseId) as number;
    return { caseId, a: x, b: y, delta: y - x };
  });
  // With a cluster key, a case without one is its own cluster.
  const cl = opts.cluster;
  const clusterOf = (id: string) => cl?.of.get(id) ?? `\u0000${id}`;
  const bootstrap = (caseIds: readonly string[], diffs: readonly number[], o: BootstrapOpts) =>
    cl ? clusteredBootstrap(diffs, caseIds.map(clusterOf), o) : pairedBootstrap(diffs, o);
  const d = bootstrap(
    ids,
    deltas.map((x) => x.delta),
    boot,
  );
  let regress = 0;
  let improve = 0;
  let solved = 0;
  const lostCases: string[] = [];
  const wonCases: string[] = [];
  for (const x of deltas) {
    const pa = x.a >= 0.5;
    const pb = x.b >= 0.5;
    if (pa) solved++;
    if (pa && !pb) {
      regress++;
      lostCases.push(x.caseId);
    } else if (!pa && pb) {
      improve++;
      wonCases.push(x.caseId);
    }
  }
  const timing = runTiming(a, b);
  // A regrade reuses the other side's outputs: when it ran says nothing about drift.
  if (b.metadata?.regradeOf === a.id || a.metadata?.regradeOf === b.id) delete timing.warning;
  const seq = timing.interleaved && a.pair?.experiments[0] === a.id && b.pair?.experiments[1] === b.id ? a.pair.sequential : undefined;
  const signFlip = clusterSignFlip(
    deltas.map((x) => x.delta),
    { seed: boot.seed, iters: boot.iters, ...(cl ? { clusterIds: ids.map(clusterOf) } : {}) },
  );
  const rtm = selectionWarning(a, b);
  // AC-9: Seq@K, when both sides ran --seq with the same K and feedback. Its verdict takes the same exact test over its own per-case differences.
  let seqP = 1;
  const sk = seqKCompare(a, b, (ids2, diffs) => {
    seqP = clusterSignFlip(diffs, { seed: boot.seed, iters: boot.iters, ...(cl ? { clusterIds: ids2.map(clusterOf) } : {}) }).p;
    return bootstrap(ids2, diffs, boot);
  });
  const onSeq = opts.verdictOn === "seq" && sk.seqK ? sk.seqK.diff : undefined;
  const v = onSeq ?? d;
  const exact = (onSeq ? seqP : signFlip.p) < boot.alpha;
  const verdict: Comparison["verdict"] = rtm ? "inconclusive" : seq && !onSeq ? seq.verdict : v.n > 0 && exact && v.lo > 0 ? "better" : v.n > 0 && exact && v.hi < 0 ? "worse" : "inconclusive";
  const byDelta = (x: CaseDelta, y: CaseDelta) => x.delta - y.delta || (x.caseId < y.caseId ? -1 : 1);
  const rateOf = (r: Map<string, number>) => {
    const v = [...r.values()];
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
  };
  const gIds = a.graders.map((g) => g.id).filter((id) => b.graders.some((g) => g.id === id));
  const pairedIds = new Set(ids);
  const graders: GraderDelta[] = gIds.map((gid) => {
    const ma = graderMeans(a, gid);
    const mb = graderMeans(b, gid);
    const common = [...ma.keys()].filter((k) => mb.has(k)).sort();
    const diffs = common.map((k) => (mb.get(k) as number) - (ma.get(k) as number));
    const bd = bootstrap(common, diffs, boot);
    const mean = (m: Map<string, number>) => (common.length ? common.reduce((s, k) => s + (m.get(k) as number), 0) / common.length : NaN);
    const out: GraderDelta = { id: gid, n: common.length, meanA: mean(ma), meanB: mean(mb), diff: { mean: bd.mean, lo: bd.lo, hi: bd.hi } };
    const ca = correctedRate(a, gid);
    const cb = correctedRate(b, gid);
    if (ca || cb) out.corrected = { ...(ca ? { a: ca } : {}), ...(cb ? { b: cb } : {}) };
    const va = verifierRate(a, gid, opts.verifiers);
    const vb = verifierRate(b, gid, opts.verifiers);
    if (va || vb) out.verifier = { ...(va ? { a: va } : {}), ...(vb ? { b: vb } : {}) };
    const infoA = a.graders.find((g) => g.id === gid);
    const infoB = b.graders.find((g) => g.id === gid);
    const judge = infoA?.kind === "llm" || infoB?.kind === "llm" || !!infoA?.calibration || !!infoB?.calibration;
    if (common.length && judge) {
      out.stability = directionStability(diffs, { seed: boot.seed, ...(cl ? { clusterIds: common.map(clusterOf) } : {}) });
    }
    if (opts.labels && judge) {
      const criterion = opts.criteria?.get(gid) ?? gid;
      const keep = (m: Map<string, number>) => new Map([...m].filter(([k]) => pairedIds.has(k)));
      const p = graderPpi(
        { a: keep(graderPassShares(a, gid)), b: keep(graderPassShares(b, gid)) },
        { a: labelMajority(opts.labels.a, criterion), b: labelMajority(opts.labels.b, criterion) },
        { alpha: boot.alpha, ...(opts.minLabels !== undefined ? { minLabels: opts.minLabels } : {}) },
      );
      out.ppi = p.ppi;
      out.warnings = p.warnings;
    }
    return out;
  });
  const ungraded = { a: a.runs.filter((r) => r.ungraded).length, b: b.runs.filter((r) => r.ungraded).length };
  const versionOf = (r: ExperimentResult, id: string) => r.graders.find((g) => g.id === id)?.version;
  for (const g of graders) {
    const va = versionOf(a, g.id);
    const vb = versionOf(b, g.id);
    if (va !== undefined && vb !== undefined && va !== vb) g.versionChanged = { a: va, b: vb };
  }
  const onlyA = a.graders.map((g) => g.id).filter((id) => !gIds.includes(id));
  const onlyB = b.graders.map((g) => g.id).filter((id) => !gIds.includes(id));
  // Cases that ran on one side only are lost trials only when both sides ran the same cases.
  const sameData = a.dataset.id === b.dataset.id && a.dataset.version === b.dataset.version;
  const attA = armAttrition(a.runs, sameData ? onlyInB.length * a.trials : 0);
  const attB = armAttrition(b.runs, sameData ? onlyInA.length * b.trials : 0);
  const attrition: Attrition = { a: attA, b: attB, p: fisherExact(attA.lost, attA.runs - attA.lost, attB.lost, attB.runs - attB.lost) };
  if (attrition.p < ATTRITION_ALPHA) {
    const infra = attA.infra + attB.infra;
    attrition.warning =
      `uneven attrition: A lost ${attA.lost} of ${attA.runs} trials, B lost ${attB.lost} of ${attB.runs} (Fisher p=${attrition.p < 0.001 ? "<0.001" : attrition.p.toFixed(3)}); ` +
      `lost trials are not missing at random, so the paired result may be biased` +
      (infra ? `. ${infra} task error(s) look like infrastructure (timeout, network, HTTP 429/5xx): re-run those cases before trusting the verdict` : "");
  }
  const wa = weightsOf(a);
  const wb = weightsOf(b);
  const out: Comparison = {
    a: stampedWith({ id: a.id, name: a.name, passRate: rateOf(ra) }, wa),
    b: stampedWith({ id: b.id, name: b.name, passRate: rateOf(rb) }, wb),
    ungraded,
    paired: ids.length,
    onlyInA,
    onlyInB,
    diff: { mean: d.mean, lo: d.lo, hi: d.hi, iters: d.iters },
    mcnemar: mcnemar(regress, improve),
    signFlip,
    verdict,
    timing,
    regressions: deltas.filter((x) => x.delta < 0).sort(byDelta),
    improvements: deltas.filter((x) => x.delta > 0).sort((x, y) => y.delta - x.delta || (x.caseId < y.caseId ? -1 : 1)),
    graders,
    attrition,
    power: pairedPower(
      deltas.map((x) => x.delta),
      {
        alpha: boot.alpha,
        power: opts.power,
        minPaired: opts.minPaired,
        significant: verdict !== "inconclusive",
        discordant: { b: regress, c: improve },
        ...(opts.noise ? { noise: opts.noise } : {}),
      },
    ),
    turnover: turnover(outcomesByCase(a.runs), outcomesByCase(b.runs)),
  };
  const ungradedCases = [...ranA].filter((id) => ranB.has(id) && !(ra.has(id) && rb.has(id))).sort();
  if (ungradedCases.length) out.ungradedCases = ungradedCases;
  if (onlyA.length || onlyB.length) out.gradersOnlyIn = { a: onlyA, b: onlyB };
  // One side regrades the other's stored outputs: the same task outputs, so the grader change is all B − A measures.
  const regrade = b.metadata?.regradeOf === a.id || a.metadata?.regradeOf === b.id;
  const instrument = instrumentText(graders, onlyA, onlyB, regrade);
  if (instrument) out.instrumentWarning = instrument;
  const sameWeights = weightsWarning(wa, wb, regrade);
  if (sameWeights) out.weightsWarning = sameWeights;
  const hv = out.turnover.halves;
  if (verdict !== "inconclusive" && hv?.reversed.avg) {
    const span = (t: [number, number]) => (t[0] === t[1] ? `trial ${t[0]}` : `trials ${t[0]}-${t[1]}`);
    out.turnover.warning = `B is ${verdict} overall, but the change reverses between trial halves (${span(hv.first.trials)} vs ${span(hv.second.trials)}); confirm with more trials`;
  }
  if (seq) {
    out.sequential = seq;
    if (seq.early) {
      out.sequentialWarning = `this A/B stopped early at look ${seq.history.length} of ${seq.plan.looks.length}; the paired bootstrap interval assumes a fixed number of cases and is too narrow here, so read the repeated confidence interval instead`;
    }
  }
  if (cl) {
    const clusters = new Set(ids.map(clusterOf)).size;
    const info: ClusterInfo = { key: cl.key, clusters, missing: ids.filter((id) => !cl.of.has(id)).length };
    if (ids.length && clusters < MIN_CLUSTERS) {
      info.warning = `only ${clusters} ${cl.key} cluster(s) (< ${MIN_CLUSTERS}): a cluster bootstrap with so few clusters gives a rough, often too narrow interval`;
    }
    out.cluster = info;
  }
  if (ids.length > 0 && ids.length < POSTERIOR_BELOW) out.posterior = pairedPosterior(regress, improve, ids.length - regress - improve, { alpha: boot.alpha, seed: boot.seed });
  if (a.trials > 1 || b.trials > 1) {
    const pa = passHatK(a.runs, ids);
    const pb = passHatK(b.runs, ids);
    out.passK = { a: { k: a.trials, rate: pa }, b: { k: b.trials, rate: pb }, diff: pb - pa };
  }
  const lostA = a.runs.filter((r) => r.infra);
  const lostB = b.runs.filter((r) => r.infra);
  const kinds = infraKinds([...lostA, ...lostB]);
  if (lostA.length || lostB.length) out.infra = { a: lostA.length, b: lostB.length, kinds };
  if (ungraded.a || ungraded.b) {
    const infra = lostA.length + lostB.length;
    const grader = { a: ungraded.a - lostA.length, b: ungraded.b - lostB.length };
    const parts = [
      infra ? `${infra} run(s) failed on infrastructure (${infraKindsText(kinds)}) after their retries (A ${lostA.length}, B ${lostB.length})` : "",
      grader.a || grader.b ? `${grader.a + grader.b} run(s) had a grader error (A ${grader.a}, B ${grader.b})` : "",
    ].filter(Boolean);
    // Nothing left to pair because of infrastructure (a dead login): no quality verdict, not "no difference".
    out.gradeWarning =
      infra && !ids.length
        ? voidText(infra, kinds)
        : `${parts.join("; ")}; their outcome is unknown, so they are left out and only graded runs are compared. Re-run them before trusting the verdict`;
  }
  if (a.dataset.id !== b.dataset.id || a.dataset.version !== b.dataset.version) {
    out.datasetWarning = `A ran on ${a.dataset.id}@${a.dataset.version}, B on ${b.dataset.id}@${b.dataset.version}; only the ${ids.length} shared case id(s) are compared`;
  }
  if (opts.margin !== undefined) {
    const ni = nonInferiority(
      deltas.map((x) => x.delta),
      opts.margin,
      { iters: boot.iters, seed: boot.seed, alpha: boot.alpha / 2, ...(cl ? { clusterIds: ids.map(clusterOf) } : {}) },
    );
    out.nonInferiority = { ...ni, hardRegressions: hardRegressions(outcomesByCase(a.runs), outcomesByCase(b.runs)) };
  }
  if (opts.replay) {
    const withinNoise = ids.length > 0 && Math.abs(d.mean) < opts.replay.rate;
    out.replay = { ...opts.replay, withinNoise };
    if (withinNoise) {
      out.replay.warning = `B − A (${(d.mean * 100).toFixed(1)} points) is smaller than the replay noise floor (${(opts.replay.rate * 100).toFixed(0)}%): the control arm alone diverges from the recorded turns that often, so this difference may be replay noise`;
    }
  }
  if (a.task.kind === "continuation" && a.metadata?.control === "skipped") {
    out.controlWarning = "A ran without a control arm (--no-control): there is no replay noise floor to read the difference against";
  }
  const llmReplay = llmReplayNote(a, b, ids.length ? d.mean : undefined);
  if (llmReplay) out.llmReplay = llmReplay;
  if (rtm) out.selectionWarning = rtm;
  if (sk.seqK) out.seqK = sk.seqK;
  if (sk.seqNote) out.seqNote = sk.seqNote;
  if (opts.verdictOn === "seq") out.verdictOn = sk.seqK ? "seq" : "pass";
  if (given) out.given = given;
  const kindOf = new Map<string, CaseKind>();
  for (const r of [...a.runs, ...b.runs]) if (r.kind) kindOf.set(r.caseId, r.kind);
  const caseKinds = kindOf.size ? compareKinds(kindOf, ra, rb) : undefined;
  if (caseKinds) out.kinds = caseKinds;
  if (opts.gate) {
    const g = acceptanceGate({ wins: improve, losses: regress, solved }, opts.gate);
    out.gate = { ...g, verdict: gateVerdict(g), lostCases, wonCases };
    // Regression to the mean: a run on the other side's failures cannot ship on its own.
    if (rtm && out.gate.verdict === "ship") Object.assign(out.gate, { decision: "abstain", verdict: "hold" });
    const notes = [
      ...(attrition.warning || out.gradeWarning ? ["trials were lost to errors: the gate counts a task error as a failure and leaves ungraded runs out"] : []),
      ...(out.instrumentWarning ? ["the arms were graded with different graders, so the gate also counts the grader change"] : []),
      ...(rtm ? ["one side ran only on the other's failures: the gate holds until the baseline is re-run on the same cases"] : []),
    ];
    if (notes.length) out.gate.note = notes.join("; ");
  }
  return out;
}

const shortVersion = (v: string) => (v.length > 12 ? v.slice(0, 12) : v);

/** The instrument warning: graders that changed version or graded one side only; undefined when A and B were graded alike. */
function instrumentText(graders: readonly GraderDelta[], onlyA: readonly string[], onlyB: readonly string[], regrade: boolean): string | undefined {
  const parts: string[] = [];
  const changed = graders.filter((g) => g.versionChanged);
  if (changed.length) parts.push(`${changed.map((g) => `${g.id} (A ${shortVersion(g.versionChanged!.a)}, B ${shortVersion(g.versionChanged!.b)})`).join(", ")} changed version`);
  if (onlyA.length) parts.push(`${onlyA.join(", ")} graded only A`);
  if (onlyB.length) parts.push(`${onlyB.join(", ")} graded only B`);
  if (!parts.length) return undefined;
  if (regrade) return `A and B were not graded alike: ${parts.join("; ")}. One is a regrade of the other's outputs (the task did not run again), so B − A is the grader change alone`;
  return `A and B were not graded alike: ${parts.join("; ")}. Re-grading is a new measurement, so B − A mixes your change with the grader change; regrade A with B's graders (coding.sh exp regrade <A> <spec>) and compare that instead`;
}
