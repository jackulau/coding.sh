// Paired comparison of two experiments on the same cases. Pairing by case id
// removes between-case variance (most of it, on agent evals), so a paired
// bootstrap CI on per-case differences and an exact McNemar test on per-case
// outcomes detect changes an unpaired comparison would miss.
import type { CalibrationStatus, ExperimentResult } from "../datasets/types.ts";
import { pairedBootstrap, roganGladen, type RoganGladenResult } from "../stats/interval.ts";
import { mcnemar, type McNemarResult } from "../stats/tests.ts";
import { pairedPower, passHatK, type PowerAnalysis } from "./power.ts";
import { caseRates } from "./run.ts";

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
}

/**
 * Confusion-matrix rates a judge calibration may carry. Read structurally:
 * `CalibrationStatus` does not persist them yet, so until it does no
 * correction is reported.
 */
interface JudgeConfusion {
  sensitivity?: number;
  specificity?: number;
  /** Calibration labels per human class; else `n` is split evenly. */
  positives?: number;
  negatives?: number;
}

const unit = (x: unknown): x is number => typeof x === "number" && x >= 0 && x <= 1;

/** Corrected pass rate of one judge grader in one experiment, or undefined without calibration rates. */
function correctedRate(r: ExperimentResult, graderId: string): RoganGladenResult | undefined {
  const cal = r.graders.find((g) => g.id === graderId)?.calibration as (CalibrationStatus & JudgeConfusion) | undefined;
  const s = r.summary.graders.find((g) => g.id === graderId);
  if (!cal || !s || !(s.n > 0) || !unit(cal.sensitivity) || !unit(cal.specificity)) return undefined;
  const nCal =
    typeof cal.positives === "number" && typeof cal.negatives === "number" ? { positives: cal.positives, negatives: cal.negatives } : (cal.n ?? 0);
  return roganGladen(s.passed / s.n, cal.sensitivity, cal.specificity, s.n, nCal);
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
  /** Mean of per-case (B − A) pass-rate differences, with paired bootstrap CI. */
  diff: { mean: number; lo: number; hi: number; iters: number };
  /** On per-case majority outcomes: b = A pass → B fail (regressions), c = A fail → B pass. */
  mcnemar: McNemarResult;
  /** "better" / "worse" when the CI excludes 0; otherwise "inconclusive". */
  verdict: "better" | "worse" | "inconclusive";
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
  const d = pairedBootstrap(
    deltas.map((x) => x.delta),
    boot,
  );
  let regress = 0;
  let improve = 0;
  for (const x of deltas) {
    const pa = x.a >= 0.5;
    const pb = x.b >= 0.5;
    if (pa && !pb) regress++;
    else if (!pa && pb) improve++;
  }
  const verdict: Comparison["verdict"] = d.n > 0 && d.lo > 0 ? "better" : d.n > 0 && d.hi < 0 ? "worse" : "inconclusive";
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
    const bd = pairedBootstrap(diffs, boot);
    const mean = (m: Map<string, number>) => (common.length ? common.reduce((s, k) => s + (m.get(k) as number), 0) / common.length : NaN);
    const out: GraderDelta = { id: gid, n: common.length, meanA: mean(ma), meanB: mean(mb), diff: { mean: bd.mean, lo: bd.lo, hi: bd.hi } };
    const ca = correctedRate(a, gid);
    const cb = correctedRate(b, gid);
    if (ca || cb) out.corrected = { ...(ca ? { a: ca } : {}), ...(cb ? { b: cb } : {}) };
    return out;
  });
  const ungraded = { a: a.runs.filter((r) => r.ungraded).length, b: b.runs.filter((r) => r.ungraded).length };
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
    regressions: deltas.filter((x) => x.delta < 0).sort(byDelta),
    improvements: deltas.filter((x) => x.delta > 0).sort((x, y) => y.delta - x.delta || (x.caseId < y.caseId ? -1 : 1)),
    graders,
    power: pairedPower(
      deltas.map((x) => x.delta),
      { alpha: boot.alpha, power: opts.power, minPaired: opts.minPaired, significant: verdict !== "inconclusive" },
    ),
  };
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
  return out;
}
