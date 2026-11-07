// Descriptive statistics. Pure; NaN for empty input rather than throwing so
// report code can render "—" without guarding every call.

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n − 1). NaN when n < 2. */
export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/**
 * Quantile with linear interpolation between order statistics (Hyndman–Fan
 * type 7, the default in R, NumPy and Excel's PERCENTILE.INC).
 */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0 || !(q >= 0 && q <= 1)) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return quantileSorted(s, q);
}

export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (h - lo) * (b - a);
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

export function p90(xs: readonly number[]): number {
  return quantile(xs, 0.9);
}

export interface Summary {
  n: number;
  mean: number;
  median: number;
  p90: number;
  min: number;
  max: number;
  sum: number;
}

export function summarize(xs: readonly number[]): Summary {
  const s = [...xs].sort((a, b) => a - b);
  let sum = 0;
  for (const x of s) sum += x;
  return {
    n: s.length,
    mean: s.length ? sum / s.length : NaN,
    median: quantileSorted(s, 0.5),
    p90: quantileSorted(s, 0.9),
    min: s.length ? (s[0] as number) : NaN,
    max: s.length ? (s[s.length - 1] as number) : NaN,
    sum,
  };
}
