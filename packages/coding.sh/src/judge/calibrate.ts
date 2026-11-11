// Judge calibration: can this judge's verdicts stand in for a human's?
//
// Agreement % alone flatters a judge on imbalanced data (a judge that always
// says "pass" agrees 90% of the time when 90% of cases pass). So we report
// Cohen's κ with a bootstrap CI, the full confusion matrix, and precision /
// recall for the class that matters — "fail" — and we report them on a
// HELD-OUT split only: a κ measured on the cases used to iterate on the prompt
// is an in-sample number and is labelled as such, never as "calibrated".
// Cases where humans disagree with each other, or where the judge is
// confidently opposite to unanimous humans, are surfaced for relabelling.
import type { Label, Score } from "../core/types.ts";
import type { CalibrationState, CalibrationStatus, Dataset, JudgeVersion, Split } from "../datasets/types.ts";
import { cohenKappa } from "../stats/agreement.ts";
import { roganGladen } from "../stats/interval.ts";
import { mulberry32 } from "../stats/prng.ts";
import { judgeBreakEven, labelEfficiency } from "../stats/stratified.ts";
import { quantileSorted } from "../stats/summary.ts";
import { auditedPassRate, type AuditedPassRate, type AuditPlan } from "./audit.ts";
import type { InjectionReport } from "./injection.ts";

/** Minimum held-out Cohen's κ for a judge to count as calibrated (one value, everywhere). */
export const DEFAULT_KAPPA_THRESHOLD = 0.6;
/** Minimum held-out cases with both a human label and a verdict before κ is reported as meaningful. */
export const DEFAULT_MIN_N = 20;

export interface HumanLabel {
  caseId: string;
  /** Labels without a criterion count for every criterion. */
  criterion?: string;
  value: "pass" | "fail" | "skip";
  by?: string;
}

export interface JudgedCase {
  caseId: string;
  pass: boolean;
  score?: number;
  confidence?: number;
  reason?: string;
  /** The judge abstained on a deciding (critical) item: no verdict to compare with a human. */
  undecided?: boolean;
}

/**
 * Map core session labels onto case ids (default: case id = session id). With
 * `hasCase`, a label scored on a case (`caseId`) of this dataset maps to that case.
 */
export function labelsFromCore(labels: readonly Label[], caseIdFor: (sessionId: string) => string | undefined = (s) => s, hasCase?: (caseId: string) => boolean): HumanLabel[] {
  const out: HumanLabel[] = [];
  for (const l of labels) {
    const caseId = l.caseId !== undefined && hasCase?.(l.caseId) ? l.caseId : caseIdFor(l.sessionId);
    if (caseId === undefined) continue;
    out.push({ caseId, criterion: l.criterion, value: l.value, by: l.by });
  }
  return out;
}

/**
 * Human pass/fail/skip scores on a case that names no session (`score add
 * case:<id>`): the labels view leaves them out, so they are read as scores.
 * Scores with a session are labels already and are skipped here.
 */
export function caseLabelsFromScores(scores: readonly Score[], hasCase: (caseId: string) => boolean, criterion?: string): HumanLabel[] {
  const out: HumanLabel[] = [];
  for (const s of scores) {
    if (s.source !== "human" || s.target !== "case" || s.sessionId !== undefined || !hasCase(s.targetId)) continue;
    if (criterion !== undefined && s.name !== criterion) continue;
    let value: HumanLabel["value"];
    if (s.dataType === "boolean" && typeof s.value === "boolean") value = s.value ? "pass" : "fail";
    else if (s.dataType === "categorical" && (s.value === "pass" || s.value === "fail" || s.value === "skip")) value = s.value;
    else continue;
    out.push({ caseId: s.targetId, criterion: s.name, value, by: s.by });
  }
  return out;
}

export interface Confusion {
  /** "fail" is the positive class: judge fail, human fail. */
  tp: number;
  /** judge fail, human pass */
  fp: number;
  /** judge pass, human fail */
  fn: number;
  /** judge pass, human pass */
  tn: number;
}

export interface NoisyCase {
  caseId: string;
  kind: "labeler-disagreement" | "judge-confident-opposite";
  split?: Split;
  votes: { pass: number; fail: number };
  judge?: { pass: boolean; score?: number; confidence: number; reason?: string };
  detail: string;
}

export interface SplitMetrics {
  splits: Split[];
  n: number;
  agreement: number;
  kappa: number;
  kappaCI: { lo: number; hi: number; iters: number; degenerate: number };
  confusion: Confusion;
  failPrecision: number;
  failRecall: number;
  failF1: number;
  humanFailRate: number;
  judgeFailRate: number;
}

export interface CalibrationReport extends SplitMetrics {
  judgeId: string;
  criterion?: string;
  reportSplit: Split;
  tunedOn: Split[];
  /** False when reportSplit is one the prompt was tuned on: every metric above is in-sample. */
  heldOut: boolean;
  threshold: number;
  minN: number;
  state: CalibrationState;
  reasons: string[];
  /** Metrics on the tuning split(s), for diagnosis only — never a calibration claim. */
  inSample?: SplitMetrics;
  /** `undecided`: labelled cases the judge abstained on (checklist `abstain`); absent when none. */
  excluded: { noVerdict: number; noLabel: number; tied: number; noSplit: number; undecided?: number };
  noisy: NoisyCase[];
  status: CalibrationStatus;
  ts: number;
  /** Prompt-injection probe on human-fail cases (`judge calibrate --probe-injection`); never changes `status`. */
  injection?: InjectionReport;
  /** Is calibrating this judge worth the human labels? Present with held-out sensitivity and specificity; never changes `status`. */
  efficiency?: JudgeEfficiency;
  /** Human-audited pass rate from a `judge sample` plan's labelled picks (`--plan`); never changes `status`. */
  audited?: AuditedPassRate;
}

/**
 * Label efficiency of correcting this judge versus auditing outputs directly
 * (Choi et al., arXiv 2610.35698, Eq.6-8; see stats/stratified.ts).
 */
export interface JudgeEfficiency {
  /** Held-out pass-recall s = P(judge pass | human pass). */
  sensitivity: number;
  /** Held-out false-pass rate α = 1 − specificity = P(judge pass | human fail). */
  alpha: number;
  /** Discrimination gap s − α. */
  gap: number;
  /**
   * Pass rate η is evaluated at, clamped to [0.01, 0.99]: the Rogan-Gladen
   * corrected judge pass rate over `judged` cases in the report split, or the
   * held-out human pass share when gap ≤ 0.
   */
  theta: number;
  thetaFrom: "corrected-judge" | "human-labels";
  /** Judged cases in the report split. */
  judged: number;
  /** θ(1 − θ) / A_v (Eq.7); absent when gap ≤ 0. Below 1, auditing outputs directly needs fewer human labels. */
  eta?: number;
  /** Oracle share of the human labels to spend on human-pass cases (Eq.7); absent when gap ≤ 0. */
  n1Share?: number;
  /** USD per judge call, from `judgeCost`. */
  judgeCost?: number;
  /** Human label cost (USD) above which the judge pays off (Eq.8); null when it never does (η ≤ 1). */
  breakEvenHumanCost?: number | null;
}

/** Discrimination gap below which calibrate notes that the judge barely separates passes from fails. */
export const MIN_GAP = 0.2;

export interface CalibrateOpts {
  judge: Pick<JudgeVersion, "id" | "tunedOn"> & { criterion?: string };
  labels: readonly HumanLabel[];
  verdicts: readonly JudgedCase[] | ReadonlyMap<string, JudgedCase>;
  /** Split of each case: a dataset, a map, or a record. */
  splits: Dataset | ReadonlyMap<string, Split> | Readonly<Record<string, Split>>;
  /** Split to report on. Default "test". */
  reportSplit?: Split;
  /** Labels for this criterion only. Default: the judge's criterion. */
  criterion?: string;
  /** Minimum κ to count as calibrated. Default DEFAULT_KAPPA_THRESHOLD (0.6). */
  kappaThreshold?: number;
  /** Minimum labelled + judged held-out cases. Default DEFAULT_MIN_N (20). */
  minN?: number;
  /** Bootstrap resamples for the κ CI. Default 2000. */
  bootstrapIters?: number;
  seed?: number;
  /** Two-sided CI level; 0.05 → 95%. */
  alpha?: number;
  /** Judge confidence at or above which an opposite verdict is "confident". Default 0.8. */
  confidentAt?: number;
  /** Throw instead of reporting when reportSplit was used for tuning. Default false (report, flagged in-sample). */
  strict?: boolean;
  /** USD per judge call: adds the human-label cost break-even to `efficiency`. */
  judgeCost?: number;
  /** A `judge sample` plan: adds `audited`, the stratified human pass rate over its labelled picks. */
  plan?: AuditPlan;
  now?: number;
}

export class InSampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InSampleError";
  }
}

function splitLookup(s: CalibrateOpts["splits"]): (id: string) => Split | undefined {
  if (s instanceof Map) return (id) => s.get(id);
  if ("cases" in s && Array.isArray((s as Dataset).cases)) {
    const m = new Map<string, Split>();
    for (const c of (s as Dataset).cases) if (c.split) m.set(c.id, c.split);
    return (id) => m.get(id);
  }
  const r = s as Readonly<Record<string, Split>>;
  return (id) => (Object.hasOwn(r, id) ? r[id] : undefined);
}

/** κ for two binary raters from counts (fast path for the bootstrap). NaN when p_e = 1. */
function kappaFromCounts(tp: number, fp: number, fn: number, tn: number): number {
  const n = tp + fp + fn + tn;
  if (n === 0) return NaN;
  const po = (tp + tn) / n;
  const judgeFail = (tp + fp) / n;
  const humanFail = (tp + fn) / n;
  const pe = judgeFail * humanFail + (1 - judgeFail) * (1 - humanFail);
  return 1 - pe < 1e-12 ? NaN : (po - pe) / (1 - pe);
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : NaN);

function metrics(pairs: readonly { human: boolean; judge: boolean }[], splits: Split[], iters: number, seed: number, alpha: number): SplitMetrics {
  const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  // code per pair: 0 tp, 1 fp, 2 fn, 3 tn (human/judge as pass booleans)
  const codes = new Uint8Array(pairs.length);
  pairs.forEach((p, i) => {
    const code = !p.judge && !p.human ? 0 : !p.judge && p.human ? 1 : p.judge && !p.human ? 2 : 3;
    codes[i] = code;
    if (code === 0) c.tp++;
    else if (code === 1) c.fp++;
    else if (code === 2) c.fn++;
    else c.tn++;
  });
  const n = pairs.length;
  const k = cohenKappa(
    pairs.map((p) => (p.judge ? "pass" : "fail")),
    pairs.map((p) => (p.human ? "pass" : "fail")),
    ["pass", "fail"],
  );
  const samples: number[] = [];
  let degenerate = 0;
  if (n > 0) {
    const rand = mulberry32(seed);
    for (let it = 0; it < iters; it++) {
      const cnt = [0, 0, 0, 0];
      for (let j = 0; j < n; j++) (cnt[codes[(rand() * n) | 0] as number] as number)++;
      const kk = kappaFromCounts(cnt[0] as number, cnt[1] as number, cnt[2] as number, cnt[3] as number);
      if (Number.isNaN(kk)) degenerate++;
      else samples.push(kk);
    }
  }
  samples.sort((a, b) => a - b);
  let lo = samples.length ? quantileSorted(samples, alpha / 2) : NaN;
  let hi = samples.length ? quantileSorted(samples, 1 - alpha / 2) : NaN;
  if (n > 0 && c.fp + c.fn === 0 && !Number.isNaN(k.kappa)) {
    // No disagreement: every resample is κ = 1, a CI of no width. Bound it instead by the exact
    // (Clopper-Pearson) lower limit on agreement with no misses, (α/2)^(1/n), at the observed marginals.
    const pe = ((c.tp + c.fp) / n) * ((c.tp + c.fn) / n) + ((c.fn + c.tn) / n) * ((c.fp + c.tn) / n);
    lo = Math.max(-1, ((alpha / 2) ** (1 / n) - pe) / (1 - pe));
    hi = 1;
  }
  const precision = ratio(c.tp, c.tp + c.fp);
  const recall = ratio(c.tp, c.tp + c.fn);
  return {
    splits,
    n,
    agreement: k.agreement,
    kappa: k.kappa,
    kappaCI: {
      lo,
      hi,
      iters: n > 0 ? iters : 0,
      degenerate,
    },
    confusion: c,
    failPrecision: precision,
    failRecall: recall,
    failF1: Number.isNaN(precision) || Number.isNaN(recall) || precision + recall === 0 ? NaN : (2 * precision * recall) / (precision + recall),
    humanFailRate: ratio(c.tp + c.fn, n),
    judgeFailRate: ratio(c.tp + c.fp, n),
  };
}

export function calibrate(opts: CalibrateOpts): CalibrationReport {
  const reportSplit = opts.reportSplit ?? "test";
  const tunedOn = [...new Set(opts.judge.tunedOn)];
  const heldOut = !tunedOn.includes(reportSplit);
  if (!heldOut && opts.strict) {
    throw new InSampleError(`refusing to report κ on "${reportSplit}": judge ${opts.judge.id} was tuned on it. Label a split it has not seen.`);
  }
  const criterion = opts.criterion ?? opts.judge.criterion;
  const threshold = opts.kappaThreshold ?? DEFAULT_KAPPA_THRESHOLD;
  const minN = opts.minN ?? DEFAULT_MIN_N;
  const iters = opts.bootstrapIters ?? 2000;
  const seed = opts.seed ?? 0x5eed;
  const alpha = opts.alpha ?? 0.05;
  const confidentAt = opts.confidentAt ?? 0.8;
  const splitOf = splitLookup(opts.splits);
  const verdicts = opts.verdicts instanceof Map ? (opts.verdicts as ReadonlyMap<string, JudgedCase>) : new Map((opts.verdicts as readonly JudgedCase[]).map((v) => [v.caseId, v]));

  // Human votes per case (skip ignored; a criterion-less label counts for all).
  const votes = new Map<string, { pass: number; fail: number }>();
  for (const l of opts.labels) {
    if (l.value === "skip") continue;
    if (criterion !== undefined && l.criterion !== undefined && l.criterion !== criterion) continue;
    const v = votes.get(l.caseId) ?? { pass: 0, fail: 0 };
    v[l.value]++;
    votes.set(l.caseId, v);
  }

  const excluded: CalibrationReport["excluded"] = { noVerdict: 0, noLabel: 0, tied: 0, noSplit: 0 };
  const noisy: NoisyCase[] = [];
  const held: { human: boolean; judge: boolean }[] = [];
  const tuning: { human: boolean; judge: boolean }[] = [];
  for (const [caseId, v] of votes) {
    const split = splitOf(caseId);
    const j = verdicts.get(caseId);
    const judgeInfo = j
      ? (() => {
          const info: NonNullable<NoisyCase["judge"]> = { pass: j.pass, confidence: j.confidence ?? (j.score !== undefined ? Math.abs(j.score - 0.5) * 2 : 0) };
          if (j.score !== undefined) info.score = j.score;
          if (j.reason) info.reason = j.reason;
          return info;
        })()
      : undefined;
    const base = (kind: NoisyCase["kind"], detail: string): NoisyCase => {
      const n: NoisyCase = { caseId, kind, votes: { ...v }, detail };
      if (split) n.split = split;
      if (judgeInfo) n.judge = judgeInfo;
      return n;
    };
    if (v.pass > 0 && v.fail > 0) noisy.push(base("labeler-disagreement", `${v.pass} pass vs ${v.fail} fail from human labelers`));
    if (v.pass === v.fail) {
      excluded.tied++;
      continue;
    }
    const human = v.pass > v.fail;
    if (!j || !judgeInfo) {
      excluded.noVerdict++;
      continue;
    }
    // An abstention is not a "fail": counting it as one would credit the judge for missing evidence.
    if (j.undecided) {
      excluded.undecided = (excluded.undecided ?? 0) + 1;
      continue;
    }
    const unanimous = v.pass === 0 || v.fail === 0;
    if (unanimous && j.pass !== human && judgeInfo.confidence >= confidentAt) {
      noisy.push(
        base(
          "judge-confident-opposite",
          `humans say ${human ? "pass" : "fail"} (${v.pass + v.fail}/${v.pass + v.fail}), judge says ${j.pass ? "pass" : "fail"} at confidence ${judgeInfo.confidence.toFixed(2)}`,
        ),
      );
    }
    if (!split) {
      excluded.noSplit++;
      continue;
    }
    if (split === reportSplit) held.push({ human, judge: j.pass });
    else if (tunedOn.includes(split)) tuning.push({ human, judge: j.pass });
  }
  for (const id of verdicts.keys()) if (!votes.has(id)) excluded.noLabel++;
  noisy.sort((a, b) => (a.kind === b.kind ? (b.judge?.confidence ?? 0) - (a.judge?.confidence ?? 0) || (a.caseId < b.caseId ? -1 : 1) : a.kind === "labeler-disagreement" ? -1 : 1));

  const m = metrics(held, [reportSplit], iters, seed, alpha);
  const reasons: string[] = [];
  let state: CalibrationState;
  if (!heldOut) {
    state = "in-sample";
    reasons.push(`"${reportSplit}" was used to tune this judge; κ here is in-sample and overstates real agreement`);
  } else if (m.n < minN) {
    state = "insufficient-data";
    reasons.push(`only ${m.n} held-out case(s) have both a human label and a verdict (need ${minN})`);
  } else if (Number.isNaN(m.kappa)) {
    state = "insufficient-data";
    reasons.push("κ is undefined: humans and judge each used a single label; include both passes and failures");
  } else if (m.kappa < threshold) {
    state = "uncalibrated";
    reasons.push(`κ = ${m.kappa.toFixed(2)} is below the ${threshold} threshold`);
  } else {
    state = "calibrated";
    if (m.kappaCI.lo < threshold) reasons.push(`κ CI lower bound ${m.kappaCI.lo.toFixed(2)} is below ${threshold}; label more cases to tighten it`);
  }
  if (heldOut && m.n > 0 && Number.isNaN(m.failRecall)) reasons.push("no human-labelled failures in the held-out split: recall on failures is unknown");

  const status: CalibrationStatus = { state, n: m.n, split: reportSplit, ts: opts.now ?? Date.now() };
  if (!Number.isNaN(m.kappa)) status.kappa = m.kappa;
  if (!Number.isNaN(m.kappaCI.lo)) {
    status.kappaLo = m.kappaCI.lo;
    status.kappaHi = m.kappaCI.hi;
  }
  if (reasons.length) status.reason = reasons[0] as string;
  // Confusion rates for the Rogan–Gladen correction in compare; only held-out ones (in-sample rates flatter the judge).
  if (heldOut) {
    const { tp, fp, fn, tn } = m.confusion;
    status.positives = tn + fp;
    status.negatives = tp + fn;
    if (tn + fp > 0) status.sensitivity = tn / (tn + fp);
    if (tp + fn > 0) status.specificity = tp / (tp + fn);
  }

  const report: CalibrationReport = {
    ...m,
    judgeId: opts.judge.id,
    reportSplit,
    tunedOn,
    heldOut,
    threshold,
    minN,
    state,
    reasons,
    excluded,
    noisy,
    status,
    ts: status.ts as number,
  };
  if (criterion !== undefined) report.criterion = criterion;
  if (status.sensitivity !== undefined && status.specificity !== undefined) {
    let judged = 0;
    let judgedPass = 0;
    for (const [id, v] of verdicts) {
      if (splitOf(id) !== reportSplit) continue;
      judged++;
      if (v.pass) judgedPass++;
    }
    report.efficiency = efficiency(status, judged, judgedPass, m, opts.judgeCost);
    const e = report.efficiency;
    if (e.eta === undefined) reasons.push("the judge passes human-fail cases as often as human-pass ones (gap ≤ 0): its pass rate can't be corrected, audit outputs directly");
    else {
      if (e.eta < 1) reasons.push(`label efficiency η = ${e.eta.toFixed(2)} < 1: auditing outputs directly needs ~${(1 / e.eta).toFixed(1)}x fewer human labels than correcting this judge's pass rate`);
      if (e.gap < MIN_GAP) reasons.push(`discrimination gap ${e.gap.toFixed(2)} < ${MIN_GAP}: the judge barely separates passes from fails, so its corrected pass rate is noisy`);
    }
  }
  if (opts.plan) report.audited = auditedPassRate(opts.plan, opts.labels, criterion);
  const tuneSplits = tunedOn.filter((s) => s !== reportSplit);
  if (tuning.length) report.inSample = metrics(tuning, tuneSplits, iters, seed, alpha);
  return report;
}

/**
 * η and the cost break-even at the held-out s and α. θ is the corrected judge
 * pass rate over the report split's judged cases; with no discrimination it
 * falls back to the held-out human pass share. Clamped to [0.01, 0.99] so a
 * split that is all pass or all fail still gets a finite η.
 */
function efficiency(status: CalibrationStatus, judged: number, judgedPass: number, m: SplitMetrics, judgeCost: number | undefined): JudgeEfficiency {
  const s = status.sensitivity as number;
  const sp = status.specificity as number;
  const alpha = 1 - sp;
  const gap = s - alpha;
  const clamp = (x: number) => Math.min(0.99, Math.max(0.01, x));
  const human = (m.confusion.tn + m.confusion.fp) / m.n;
  const corrected = gap > 1e-12 && judged > 0;
  const theta = clamp(corrected ? roganGladen(judgedPass / judged, s, sp, judged, { positives: status.positives ?? 0, negatives: status.negatives ?? 0 }).p : human);
  const out: JudgeEfficiency = { sensitivity: s, alpha, gap, theta, thetaFrom: corrected ? "corrected-judge" : "human-labels", judged };
  if (gap > 1e-12) {
    const e = labelEfficiency(theta, s, alpha);
    out.eta = e.eta;
    out.n1Share = e.n1Share;
  }
  if (judgeCost !== undefined) {
    out.judgeCost = judgeCost;
    const be = judgeBreakEven(theta, s, alpha, judgeCost);
    out.breakEvenHumanCost = Number.isFinite(be) ? be : null;
  }
  return out;
}

/** JudgeVersion with this calibration attached (persist with FileEvalStore.putJudge). */
export function withCalibration(v: JudgeVersion, report: Pick<CalibrationReport, "status">): JudgeVersion {
  return { ...v, calibration: report.status };
}
