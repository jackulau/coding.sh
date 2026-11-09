// Prediction-powered inference (PPI++) for judge-graded pass rates (R1-18, EM-5 step 2).
//
// A judge grades every case; humans label a random subset. The judge's mean
// over all cases is precise but biased (it over- or under-passes); the human
// mean over the labelled subset is unbiased but noisy. PPI adds the judge's
// mean to a rectifier, the mean human-minus-judge gap on the labelled cases,
// which removes the bias. PPI++ scales the judge term by a tuned λ in [0, 1],
// so the interval is never wider than the human-only one (λ = 0) and shrinks
// as the judge tracks the humans:
//   Angelopoulos, Bates, Fannjiang, Jordan, Zrnic, "Prediction-powered
//   inference", Science 2023; Angelopoulos, Duchi, Zrnic, "PPI++: Efficient
//   prediction-powered inference", 2023, https://arxiv.org/abs/2311.01453
//   Boyeau et al., "AutoEval Done Right", 2024, https://arxiv.org/abs/2403.07008
//
// Here the labelled cases are a simple random subset of the judged ones (the
// judge also graded them), so with σ² from the labelled cases:
//   θ = ȳ_n + λ (f̄_N − f̄_n)
//   Var θ = σ_y²/n + (λ² σ_f² − 2λ σ_yf)(1/n − 1/N),   λ* = σ_yf / σ_f²
// With a perfect judge (f = y) λ* = 1 and θ is the judge mean over all N.
//
// A judge whose error rates differ between the arms (ΔJ, arXiv 2605.06939)
// biases a raw B − A even when each arm's judge looks fine: compare warns
// when sensitivity or specificity differ by more than DELTA_J between arms.
import type { HumanLabel } from "../judge/calibrate.ts";
import { normalQuantile } from "../stats/normal.ts";

/** Default minimum usable human labels per arm before a delta is corrected. */
export const MIN_PPI_LABELS = 20;
/** Sensitivity or specificity gap between arms above which compare warns (ΔJ). */
export const DELTA_J = 0.15;

export interface PpiEstimate {
  /** Corrected mean (human-scale pass rate). */
  theta: number;
  lo: number;
  hi: number;
  se: number;
  /** Weight on the judge term: 0 is human-only, 1 is plain PPI. */
  lambda: number;
  /** Labelled cases. */
  n: number;
  /** Judged cases (the labelled ones included). */
  N: number;
}

export interface PpiOpts {
  /** Two-sided level. Default 0.05. */
  alpha?: number;
  /** Fix λ (1 = plain PPI). Default: the PPI++ power-tuned λ*, clipped to [0, 1]. */
  lambda?: number;
  /** Clamp the interval to this range. Default [0, 1] for a mean; a delta uses [-1, 1]. */
  range?: [number, number];
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/**
 * PPI++ mean of a quantity the judge predicts on every case (`yhatAll`) and
 * humans measured on `labelled` (each with the judge's prediction for the
 * same case). NaN with fewer than two labels.
 */
export function ppiMean(yhatAll: readonly number[], labelled: readonly { yhat: number; y: number }[], opts: PpiOpts = {}): PpiEstimate {
  const n = labelled.length;
  const N = Math.max(yhatAll.length, n);
  const [lo0, hi0] = opts.range ?? [0, 1];
  if (n < 2) return { theta: NaN, lo: NaN, hi: NaN, se: NaN, lambda: NaN, n, N };
  const y = labelled.map((l) => l.y);
  const f = labelled.map((l) => l.yhat);
  const my = mean(y);
  const mf = mean(f);
  let syy = 0;
  let sff = 0;
  let syf = 0;
  for (let i = 0; i < n; i++) {
    const dy = y[i]! - my;
    const df = f[i]! - mf;
    syy += dy * dy;
    sff += df * df;
    syf += dy * df;
  }
  syy /= n - 1;
  sff /= n - 1;
  syf /= n - 1;
  const tuned = sff > 0 ? Math.min(1, Math.max(0, syf / sff)) : 0;
  const lambda = opts.lambda ?? tuned;
  const fAll = yhatAll.length ? mean(yhatAll) : mf;
  const theta = my + lambda * (fAll - mf);
  const shrink = 1 / n - 1 / N;
  const variance = Math.max(0, syy / n + (lambda * lambda * sff - 2 * lambda * syf) * shrink);
  const se = Math.sqrt(variance);
  const z = normalQuantile(1 - (opts.alpha ?? 0.05) / 2);
  return { theta, lo: Math.max(lo0, theta - z * se), hi: Math.min(hi0, theta + z * se), se, lambda, n, N };
}

export interface PpiDelta {
  mean: number;
  lo: number;
  hi: number;
  se: number;
}

/**
 * B − A from two arms corrected on their own labels. The arms' errors are
 * combined as independent, which ignores the positive correlation paired
 * cases add, so the interval is conservative.
 */
export function ppiDelta(a: PpiEstimate, b: PpiEstimate, alpha = 0.05): PpiDelta {
  const m = b.theta - a.theta;
  const se = Math.sqrt(a.se * a.se + b.se * b.se);
  const z = normalQuantile(1 - alpha / 2);
  return { mean: m, lo: Math.max(-1, m - z * se), hi: Math.min(1, m + z * se), se };
}

/**
 * Paired B − A when humans labelled the same cases on both arms: PPI++ on
 * per-case differences, judge (yhatB − yhatA) against human (yB − yA).
 */
export function ppiPairedDiff(
  casesAll: readonly { a: number; b: number }[],
  labelledBoth: readonly { yhatA: number; yhatB: number; yA: number; yB: number }[],
  opts: Omit<PpiOpts, "range"> = {},
): PpiEstimate {
  return ppiMean(
    casesAll.map((c) => c.b - c.a),
    labelledBoth.map((l) => ({ yhat: l.yhatB - l.yhatA, y: l.yB - l.yA })),
    { ...opts, range: [-1, 1] },
  );
}

/** Judge error rates on one arm's labelled cases; a rate is absent when its class has no labels. */
export interface JudgeRates {
  /** P(judge pass | human pass). */
  sensitivity?: number;
  /** P(judge fail | human fail). */
  specificity?: number;
  positives: number;
  negatives: number;
  /** Judge pass rate over every judged case. */
  judgePassRate: number;
}

export function judgeRates(yhatAll: readonly number[], labelled: readonly { yhat: number; y: number }[]): JudgeRates {
  let tp = 0;
  let pos = 0;
  let tn = 0;
  let neg = 0;
  for (const l of labelled) {
    const jp = l.yhat >= 0.5;
    if (l.y >= 0.5) {
      pos++;
      if (jp) tp++;
    } else {
      neg++;
      if (!jp) tn++;
    }
  }
  return {
    ...(pos ? { sensitivity: tp / pos } : {}),
    ...(neg ? { specificity: tn / neg } : {}),
    positives: pos,
    negatives: neg,
    judgePassRate: mean(yhatAll),
  };
}

/** One arm's human labels for a criterion: majority per case ("skip" and ties left out), 1 = pass. */
export function labelMajority(labels: readonly HumanLabel[], criterion: string | undefined): Map<string, number> {
  const votes = new Map<string, { pass: number; fail: number }>();
  for (const l of labels) {
    if (l.value === "skip") continue;
    if (l.criterion !== undefined && criterion !== undefined && l.criterion !== criterion) continue;
    const v = votes.get(l.caseId) ?? { pass: 0, fail: 0 };
    v[l.value]++;
    votes.set(l.caseId, v);
  }
  const out = new Map<string, number>();
  for (const [id, v] of votes) if (v.pass !== v.fail) out.set(id, v.pass > v.fail ? 1 : 0);
  return out;
}

/** What compare reports per judge grader when human labels are given. */
export interface GraderPpi {
  /** Usable labels (majority per case, on paired cases the judge graded) per arm. */
  labels: { a: number; b: number };
  /** Present when both arms have at least minLabels labels. */
  corrected?: {
    a: PpiEstimate;
    b: PpiEstimate;
    /** B − A on the human scale. */
    diff: PpiDelta;
    /** "paired": humans labelled the same cases on both arms; else each arm is corrected on its own labels. */
    method: "paired" | "independent";
    /** Raw judge pass-rate B − A over the same cases, for contrast. */
    raw: number;
  };
  /** Why there is no correction. */
  reason?: string;
  rates: { a: JudgeRates; b: JudgeRates };
}

/**
 * PPI++ for one judge grader of a paired comparison. `yhat` maps case id to
 * the judge's pass share on that case (over trials) per arm, on the paired
 * cases; `labels` are each arm's human labels by case (1 pass, 0 fail).
 */
export function graderPpi(
  yhat: { a: ReadonlyMap<string, number>; b: ReadonlyMap<string, number> },
  labels: { a: ReadonlyMap<string, number>; b: ReadonlyMap<string, number> },
  opts: { minLabels?: number; alpha?: number } = {},
): { ppi: GraderPpi; warnings: string[] } {
  const min = opts.minLabels ?? MIN_PPI_LABELS;
  const alpha = opts.alpha ?? 0.05;
  const ids = [...yhat.a.keys()].filter((k) => yhat.b.has(k)).sort();
  const side = (arm: "a" | "b") => {
    const f = yhat[arm];
    const all = ids.map((k) => f.get(k)!);
    const lab = ids.filter((k) => labels[arm].has(k)).map((k) => ({ caseId: k, yhat: f.get(k)!, y: labels[arm].get(k)! }));
    return { all, lab };
  };
  const A = side("a");
  const B = side("b");
  const rates = { a: judgeRates(A.all, A.lab), b: judgeRates(B.all, B.lab) };
  const ppi: GraderPpi = { labels: { a: A.lab.length, b: B.lab.length }, rates };
  const warnings: string[] = [];
  const pctS = (x: number) => `${Math.round(x * 100)}%`;
  for (const [name, key] of [
    ["sensitivity", "sensitivity"],
    ["specificity", "specificity"],
  ] as const) {
    const ra = rates.a[key];
    const rb = rates.b[key];
    if (ra !== undefined && rb !== undefined && Math.abs(ra - rb) > DELTA_J) {
      warnings.push(
        `the judge's ${name} differs between arms (A ${pctS(ra)}, B ${pctS(rb)}): its errors are not the same on both sides, so the raw judge B − A is biased; read the corrected delta`,
      );
    }
  }
  for (const arm of ["a", "b"] as const) {
    const r = rates[arm];
    const label = arm.toUpperCase();
    if (r.sensitivity !== undefined && r.sensitivity < 0.5) warnings.push(`on ${label} the judge passes only ${pctS(r.sensitivity)} of the cases humans pass (sensitivity below 50%)`);
    if (ids.length && (r.judgePassRate === 0 || r.judgePassRate === 1)) {
      warnings.push(`on ${label} the judge ${r.judgePassRate === 1 ? "passes" : "fails"} every case: a correction cannot recover a rate the judge never reports`);
    }
  }
  if (A.lab.length < min || B.lab.length < min) {
    ppi.reason = `needs at least ${min} human labels per arm on paired cases (A ${A.lab.length}, B ${B.lab.length})`;
    return { ppi, warnings };
  }
  const estA = ppiMean(A.all, A.lab, { alpha });
  const estB = ppiMean(B.all, B.lab, { alpha });
  const raw = (B.all.reduce((s, x) => s + x, 0) - A.all.reduce((s, x) => s + x, 0)) / (ids.length || NaN);
  const both = ids.filter((k) => labels.a.has(k) && labels.b.has(k));
  let diff: PpiDelta;
  let method: "paired" | "independent";
  if (both.length >= min) {
    const p = ppiPairedDiff(
      ids.map((k) => ({ a: yhat.a.get(k)!, b: yhat.b.get(k)! })),
      both.map((k) => ({ yhatA: yhat.a.get(k)!, yhatB: yhat.b.get(k)!, yA: labels.a.get(k)!, yB: labels.b.get(k)! })),
      { alpha },
    );
    diff = { mean: p.theta, lo: p.lo, hi: p.hi, se: p.se };
    method = "paired";
  } else {
    diff = ppiDelta(estA, estB, alpha);
    method = "independent";
  }
  ppi.corrected = { a: estA, b: estB, diff, method, raw };
  for (const [arm, l] of [
    ["A", A.lab],
    ["B", B.lab],
  ] as const) {
    if (l.every((x) => x.y === l[0]!.y)) warnings.push(`every human label on ${arm} is ${l[0]!.y ? "pass" : "fail"}: the corrected interval for ${arm} is too narrow; label more cases`);
  }
  return { ppi, warnings };
}
