// Paired comparison of two experiments on the same cases. Pairing by case id
// removes between-case variance (most of it, on agent evals), so a paired
// bootstrap CI on per-case differences and an exact McNemar test on per-case
// outcomes detect changes an unpaired comparison would miss.
import type { Case, CaseRun, ExperimentResult } from "../datasets/types.ts";
import { verifierCorrected, type VerifierAudit, type VerifierCorrection } from "../judge/verifier.ts";
import { clusteredBootstrap } from "../stats/cluster.ts";
import { pairedBootstrap, roganGladen, type BootstrapOpts, type RoganGladenResult } from "../stats/interval.ts";
import { pairedPosterior, type PairedPosterior } from "../stats/posterior.ts";
import type { SequentialOutcome } from "../stats/sequential.ts";
import { gateVerdict, type GateVerdict } from "../stats/gate.ts";
import { acceptanceGate, fisherExact, hardRegressions, mcnemar, nonInferiority, type GateOpts, type GateResult, type McNemarResult, type NonInferiorityResult } from "../stats/tests.ts";
import { pairedPower, passHatK, type NoisePrior, type PowerAnalysis } from "./power.ts";
import { caseRates } from "./run.ts";
import { outcomesByCase, turnover, type Turnover } from "./turnover.ts";

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
  /** Both arms came from one interleaved run (`exp run --arm`, `exp aa`). */
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
export function runTiming(a: Pick<ExperimentResult, "createdAt" | "finishedAt" | "pair">, b: Pick<ExperimentResult, "createdAt" | "finishedAt" | "pair">): Timing {
  const interleaved = !!a.pair && a.pair.id === b.pair?.id;
  const start = Math.max(a.createdAt, b.createdAt);
  const end = Math.min(a.finishedAt, b.finishedAt);
  const out: Timing = { interleaved, gapMs: Math.max(0, start - end) };
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
  /** Task errors that look like infrastructure: timeouts, spawn failures, network, HTTP 429/5xx. */
  infra: number;
  /** The other task errors (the agent crashed or exited non-zero). */
  agent: number;
  /** Grader errors: outcome unknown, left out. */
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
  let infra = 0;
  let ungraded = 0;
  for (const r of runs) {
    if (r.error !== undefined) {
      errored++;
      if (isInfraError(r.error)) infra++;
    } else if (r.ungraded) ungraded++;
  }
  const lost = errored + ungraded + missing;
  return { runs: runs.length + missing, completed: runs.length - errored - ungraded, errored, infra, agent: errored - infra, ungraded, missing, lost };
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
  a: { id: string; name: string; passRate: number };
  b: { id: string; name: string; passRate: number };
  /** Set when A and B ran on different dataset versions (pairing still by case id). */
  datasetWarning?: string;
  /** Runs left out because a grader errored (outcome unknown), per side. */
  ungraded: { a: number; b: number };
  /** Set when either side has ungraded runs: the comparison covers only graded runs. */
  gradeWarning?: string;
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
   * "better" / "worse" when the CI excludes 0; otherwise "inconclusive". For
   * a group sequential A/B (`sequential`), the sequential test's verdict: the
   * fixed-n interval is not valid for that design.
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
}

export interface CompareOpts {
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

export function compareExperiments(a: ExperimentResult, b: ExperimentResult, opts: CompareOpts = {}): Comparison {
  if (!opts.force) for (const x of [a, b]) if (x.status === "cancelled") throw new IncompleteExperimentError(x);
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
  const seq = timing.interleaved && a.pair?.experiments[0] === a.id && b.pair?.experiments[1] === b.id ? a.pair.sequential : undefined;
  const verdict: Comparison["verdict"] = seq ? seq.verdict : d.n > 0 && d.lo > 0 ? "better" : d.n > 0 && d.hi < 0 ? "worse" : "inconclusive";
  const byDelta = (x: CaseDelta, y: CaseDelta) => x.delta - y.delta || (x.caseId < y.caseId ? -1 : 1);
  const rateOf = (r: Map<string, number>) => {
    const v = [...r.values()];
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
  };
  const gIds = a.graders.map((g) => g.id).filter((id) => b.graders.some((g) => g.id === id));
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
    return out;
  });
  const ungraded = { a: a.runs.filter((r) => r.ungraded).length, b: b.runs.filter((r) => r.ungraded).length };
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
  const out: Comparison = {
    a: { id: a.id, name: a.name, passRate: rateOf(ra) },
    b: { id: b.id, name: b.name, passRate: rateOf(rb) },
    ungraded,
    paired: ids.length,
    onlyInA,
    onlyInB,
    diff: { mean: d.mean, lo: d.lo, hi: d.hi, iters: d.iters },
    mcnemar: mcnemar(regress, improve),
    verdict,
    timing,
    regressions: deltas.filter((x) => x.delta < 0).sort(byDelta),
    improvements: deltas.filter((x) => x.delta > 0).sort((x, y) => y.delta - x.delta || (x.caseId < y.caseId ? -1 : 1)),
    graders,
    attrition,
    power: pairedPower(
      deltas.map((x) => x.delta),
      { alpha: boot.alpha, power: opts.power, minPaired: opts.minPaired, significant: verdict !== "inconclusive", ...(opts.noise ? { noise: opts.noise } : {}) },
    ),
    turnover: turnover(outcomesByCase(a.runs), outcomesByCase(b.runs)),
  };
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
  if (ungraded.a || ungraded.b) {
    out.gradeWarning = `${ungraded.a + ungraded.b} run(s) had a grader error (A ${ungraded.a}, B ${ungraded.b}); their outcome is unknown, so they are left out and only graded runs are compared. Re-run them before trusting the verdict`;
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
  if (opts.gate) {
    const g = acceptanceGate({ wins: improve, losses: regress, solved }, opts.gate);
    out.gate = { ...g, verdict: gateVerdict(g), lostCases, wonCases };
    if (attrition.warning || out.gradeWarning) out.gate.note = "trials were lost to errors: the gate counts a task error as a failure and leaves ungraded runs out";
  }
  return out;
}
