// Confidence intervals for proportions and paired differences.
import { mulberry32 } from "./prng.ts";
import { mean, quantileSorted } from "./summary.ts";

export interface Interval {
  /** Point estimate. */
  p: number;
  lo: number;
  hi: number;
}

/**
 * Wilson score interval for a binomial proportion (default 95%, z = 1.96).
 * Unlike the normal approximation it stays inside [0, 1] and behaves at 0/n and n/n.
 * n = 0 returns the uninformative [0, 1] with p = NaN.
 */
export function wilson(successes: number, n: number, z = 1.959963984540054): Interval {
  if (!(n > 0)) return { p: NaN, lo: 0, hi: 1 };
  if (successes < 0 || successes > n) throw new RangeError(`wilson: successes ${successes} outside [0, ${n}]`);
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/**
 * Newcombe's hybrid score interval (method 10) for the difference p2 − p1 of two independent
 * proportions: x1 of n1 against x2 of n2. Built from the two Wilson intervals, so it stays inside
 * [-1, 1] and is never zero-width. `p` is the observed difference; an empty arm gives [-1, 1] with p = NaN.
 */
export function newcombeDiff(x1: number, n1: number, x2: number, n2: number, z = 1.959963984540054): Interval {
  if (!(n1 > 0) || !(n2 > 0)) return { p: NaN, lo: -1, hi: 1 };
  const a = wilson(x1, n1, z);
  const b = wilson(x2, n2, z);
  const d = b.p - a.p;
  return {
    p: d,
    lo: Math.max(-1, d - Math.sqrt((b.p - b.lo) ** 2 + (a.hi - a.p) ** 2)),
    hi: Math.min(1, d + Math.sqrt((b.hi - b.p) ** 2 + (a.p - a.lo) ** 2)),
  };
}

export interface BootstrapOpts {
  iters?: number;
  seed?: number;
  /** Two-sided level; 0.05 → 95% CI. */
  alpha?: number;
}

export interface BootstrapResult {
  mean: number;
  lo: number;
  hi: number;
  n: number;
  iters: number;
}

/**
 * Paired (cluster) bootstrap over per-task differences: resample tasks with
 * replacement, take the mean difference, report the percentile CI. Resampling
 * tasks (not runs) keeps the k attempts of one task together, which is what
 * makes the interval honest when attempts within a task are correlated.
 */
export function pairedBootstrap(diffs: readonly number[], opts: BootstrapOpts = {}): BootstrapResult {
  const n = diffs.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n, iters: 0 };
  const { lo, hi, iters } = resample(diffs, opts, (xs) => {
    let s = 0;
    for (const x of xs) s += x;
    return s / n;
  });
  return { mean: mean(diffs), lo, hi, n, iters };
}

/**
 * Like pairedBootstrap, but for the median of the paired differences: robust
 * to the odd slow run, which is what timing metrics (ms) need. `mean` is
 * still the sample mean; `median` is the point estimate the CI goes with.
 */
export function pairedBootstrapMedian(diffs: readonly number[], opts: BootstrapOpts = {}): BootstrapResult & { median: number } {
  const n = diffs.length;
  if (n === 0) return { mean: NaN, median: NaN, lo: NaN, hi: NaN, n, iters: 0 };
  const mid = (xs: Float64Array) => {
    xs.sort();
    return quantileSorted(xs as unknown as number[], 0.5);
  };
  const { lo, hi, iters } = resample(diffs, opts, mid);
  return { mean: mean(diffs), median: mid(Float64Array.from(diffs)), lo, hi, n, iters };
}

/** Percentile CI of `stat` over `iters` seeded resamples (with replacement) of `xs`. */
function resample(xs: readonly number[], opts: BootstrapOpts, stat: (sample: Float64Array) => number): { lo: number; hi: number; iters: number } {
  const iters = opts.iters ?? 10_000;
  const alpha = opts.alpha ?? 0.05;
  const n = xs.length;
  const rand = mulberry32(opts.seed ?? 0x5eed);
  const stats = new Float64Array(iters);
  const sample = new Float64Array(n);
  for (let i = 0; i < iters; i++) {
    for (let j = 0; j < n; j++) sample[j] = xs[(rand() * n) | 0] as number;
    stats[i] = stat(sample);
  }
  stats.sort();
  const sorted = Array.from(stats);
  return { lo: quantileSorted(sorted, alpha / 2), hi: quantileSorted(sorted, 1 - alpha / 2), iters };
}

/** Calibration label counts: sensitivity is estimated on human-positive items, specificity on human-negative ones. */
export interface CalibrationCounts {
  /** m₁: human-labelled positives (pass) the judge's sensitivity was measured on. */
  positives: number;
  /** m₀: human-labelled negatives (fail) the judge's specificity was measured on. */
  negatives: number;
}

export interface RoganGladenResult extends Interval {
  /** Raw judge pass rate p̂, as passed in. */
  raw: number;
  /** False when q₀ + q₁ ≤ 1: the judge is no better than chance and the correction is refused (p = NaN, CI = [0, 1]). */
  corrected: boolean;
  /** Youden's J = q₀ + q₁ − 1, the denominator of the correction. */
  youden: number;
  /** Delta-method standard error of the corrected rate (before clamping the CI). NaN when not corrected. */
  se: number;
}

/**
 * Rogan–Gladen bias correction of an LLM-judge pass rate, with a delta-method CI that
 * covers uncertainty from both the test set and the calibration set (Lee et al. 2026,
 * "How to Correctly Report LLM-as-a-Judge Evaluations").
 *
 *   θ̂ = (p̂ + q₀ − 1) / (q₀ + q₁ − 1)
 *   Var(θ̂) = [ p̂(1−p̂)/n + (1−θ̂)² q₀(1−q₀)/m₀ + θ̂² q₁(1−q₁)/m₁ ] / (q₀ + q₁ − 1)²
 *
 * q₁ = sensitivity (judge says pass | human pass), q₀ = specificity (judge says fail | human fail),
 * both from calibration against human labels. θ̂ is clamped to [0, 1] before it enters the
 * variance, and the CI is clamped to [0, 1].
 *
 * `nCal` is either the per-class counts {positives: m₁, negatives: m₀} (preferred) or a single
 * total, which is assumed to split evenly (m₁ = m₀ = nCal / 2). A class with no calibration labels
 * gives se = NaN and the uninformative CI [0, 1]. When q₀ + q₁ ≤ 1 the correction is refused.
 */
export function roganGladen(
  observedRate: number,
  sensitivity: number,
  specificity: number,
  nTest: number,
  nCal: number | CalibrationCounts,
  z = 1.959963984540054,
): RoganGladenResult {
  for (const [name, v] of [
    ["observedRate", observedRate],
    ["sensitivity", sensitivity],
    ["specificity", specificity],
  ] as const) {
    if (!(v >= 0 && v <= 1)) throw new RangeError(`roganGladen: ${name} ${v} outside [0, 1]`);
  }
  const m1 = typeof nCal === "number" ? nCal / 2 : nCal.positives;
  const m0 = typeof nCal === "number" ? nCal / 2 : nCal.negatives;
  for (const [name, v] of [
    ["nTest", nTest],
    ["calibration positives", m1],
    ["calibration negatives", m0],
  ] as const) {
    if (!(v >= 0)) throw new RangeError(`roganGladen: ${name} ${v} must be ≥ 0`);
  }
  const p = observedRate;
  const q1 = sensitivity;
  const q0 = specificity;
  const youden = q0 + q1 - 1;
  if (!(youden > 1e-12)) return { p: NaN, lo: 0, hi: 1, raw: p, corrected: false, youden, se: NaN };
  const theta = Math.min(1, Math.max(0, (p + q0 - 1) / youden));
  if (!(nTest > 0 && m1 > 0 && m0 > 0)) return { p: theta, lo: 0, hi: 1, raw: p, corrected: true, youden, se: NaN };
  const v =
    (p * (1 - p)) / nTest + ((1 - theta) ** 2 * q0 * (1 - q0)) / m0 + (theta ** 2 * q1 * (1 - q1)) / m1;
  const se = Math.sqrt(v) / youden;
  return {
    p: theta,
    lo: Math.max(0, theta - z * se),
    hi: Math.min(1, theta + z * se),
    raw: p,
    corrected: true,
    youden,
    se,
  };
}
