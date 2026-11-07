// Cluster bootstrap for paired differences: resample whole clusters (cases
// from one repo, one source session, one task family) instead of single
// cases. Cases inside a cluster are correlated, so treating them as
// independent makes the interval too narrow; Miller ("Adding Error Bars to
// Evals", 2024) saw clustering inflate the SE by up to 3x.
import type { BootstrapOpts, BootstrapResult } from "./interval.ts";
import { mulberry32 } from "./prng.ts";
import { mean, quantileSorted } from "./summary.ts";

export interface ClusteredBootstrapResult extends BootstrapResult {
  /** Distinct clusters resampled. */
  clusters: number;
}

/**
 * Percentile CI for the mean of `diffs`, resampling clusters with
 * replacement. Each resample's statistic is the case-weighted mean over the
 * drawn clusters (sum of their diffs / their case count), so the point
 * estimate is the plain mean and one large cluster weighs as much as its
 * cases. `clusterIds[i]` is the cluster of `diffs[i]`.
 */
export function clusteredBootstrap(diffs: readonly number[], clusterIds: readonly string[], opts: BootstrapOpts = {}): ClusteredBootstrapResult {
  if (diffs.length !== clusterIds.length) throw new RangeError("clusteredBootstrap: diffs and clusterIds differ in length");
  const iters = opts.iters ?? 10_000;
  const alpha = opts.alpha ?? 0.05;
  const n = diffs.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n, iters: 0, clusters: 0 };
  const acc = new Map<string, { s: number; k: number }>();
  diffs.forEach((d, i) => {
    const a = acc.get(clusterIds[i] as string) ?? { s: 0, k: 0 };
    a.s += d;
    a.k++;
    acc.set(clusterIds[i] as string, a);
  });
  const sums = Float64Array.from([...acc.values()].map((a) => a.s));
  const sizes = Float64Array.from([...acc.values()].map((a) => a.k));
  const g = sums.length;
  const rand = mulberry32(opts.seed ?? 0x5eed);
  const means = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    let k = 0;
    for (let j = 0; j < g; j++) {
      const c = (rand() * g) | 0;
      s += sums[c] as number;
      k += sizes[c] as number;
    }
    means[i] = s / k;
  }
  means.sort();
  const sorted = Array.from(means);
  return { mean: mean(diffs), lo: quantileSorted(sorted, alpha / 2), hi: quantileSorted(sorted, 1 - alpha / 2), n, iters, clusters: g };
}
