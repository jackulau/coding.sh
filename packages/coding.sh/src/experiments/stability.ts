// Direction stability (AB-14): how often a resample of m cases points the same
// way as the full data, and the smallest m at which it does 95% of the time.
// A CI that straddles zero can't tell "needs more cases" from "this judge flips
// its verdict"; a direction that stays below 95% even at the full n says more
// verdicts from the same judge are unlikely to settle it.
//
//   "Do LLM judges converge?", arXiv 2611.04090, H3
//   (https://arxiv.org/html/2611.04090v1): 1,000 resamples at n ∈ {25, 50, 100}
//   per system pair, share of resamples matching the full-data direction,
//   n* = the smallest n with share ≥ 0.95, else censored. 26-70% of pairs never
//   converged within 100 verdicts depending on the judge.
import { mulberry32 } from "../stats/prng.ts";

/** Share of resamples at which a direction counts as stable. */
export const STABLE_SHARE = 0.95;

export interface DirectionStability {
  /** Sign of the full-data mean: "b" positive, "a" negative, "none" zero (or no data). */
  direction: "a" | "b" | "none";
  /** Share at the full size (NaN without data). With no direction, the larger of P(+) and P(−). */
  share: number;
  /** Share per resample size, ascending; sizes count clusters when clustered. */
  bySize: { m: number; share: number }[];
  /** Smallest size with share ≥ 0.95, or "censored" when none reaches it. */
  nStar: number | "censored";
  /** A direction exists and its share at the full size is ≥ 0.95. */
  stable: boolean;
  iters: number;
}

export interface StabilityOpts {
  /** Resamples per size. Default 1000 (the paper's). */
  iters?: number;
  seed?: number;
  /** Resample sizes; default [25, 50, 100]. The full n always runs too; sizes above it are skipped. */
  sizes?: readonly number[];
  /** Cluster of each value: resample whole clusters, as clusteredBootstrap does. */
  clusterIds?: readonly string[];
}

const EPS = 1e-12;

/**
 * Direction stability of the mean of `centered` (per-case B − A on any scale,
 * e.g. +0.5 / 0 / −0.5 for pairwise wins). Each resample draws m units with
 * replacement (cases, or whole clusters with the case-weighted mean).
 */
export function directionStability(centered: readonly number[], opts: StabilityOpts = {}): DirectionStability {
  const iters = opts.iters ?? 1000;
  if (opts.clusterIds && opts.clusterIds.length !== centered.length) throw new RangeError("directionStability: values and clusterIds differ in length");
  if (!centered.length) return { direction: "none", share: NaN, bySize: [], nStar: "censored", stable: false, iters };
  // Units: one per case, or one per cluster with its sum and size.
  let sums: Float64Array;
  let sizes: Float64Array;
  if (opts.clusterIds) {
    const acc = new Map<string, { s: number; k: number }>();
    centered.forEach((d, i) => {
      const id = opts.clusterIds![i] as string;
      const a = acc.get(id) ?? { s: 0, k: 0 };
      a.s += d;
      a.k++;
      acc.set(id, a);
    });
    sums = Float64Array.from([...acc.values()].map((a) => a.s));
    sizes = Float64Array.from([...acc.values()].map((a) => a.k));
  } else {
    sums = Float64Array.from(centered);
    sizes = new Float64Array(centered.length).fill(1);
  }
  const g = sums.length;
  const full = centered.reduce((s, x) => s + x, 0) / centered.length;
  const direction: DirectionStability["direction"] = full > EPS ? "b" : full < -EPS ? "a" : "none";
  // The full size always runs: `share` is read there.
  const want = [...(opts.sizes ?? [25, 50, 100]), g].filter((m) => Number.isInteger(m) && m >= 1 && m <= g);
  const ms = [...new Set(want)].sort((x, y) => x - y);
  const rand = mulberry32(opts.seed ?? 0x5eed);
  const bySize = ms.map((m) => {
    let pos = 0;
    let neg = 0;
    for (let i = 0; i < iters; i++) {
      let s = 0;
      let k = 0;
      for (let j = 0; j < m; j++) {
        const c = (rand() * g) | 0;
        s += sums[c] as number;
        k += sizes[c] as number;
      }
      const mean = s / k;
      if (mean > EPS) pos++;
      else if (mean < -EPS) neg++;
    }
    const share = direction === "b" ? pos / iters : direction === "a" ? neg / iters : Math.max(pos, neg) / iters;
    return { m, share };
  });
  const share = bySize.at(-1)?.share ?? NaN;
  const hit = direction === "none" ? undefined : bySize.find((x) => x.share >= STABLE_SHARE);
  return { direction, share, bySize, nStar: hit ? hit.m : "censored", stable: direction !== "none" && share >= STABLE_SHARE, iters };
}

/** One line: `stable  B better in 97% of resamples (n*=50)` or `unstable  61% of resamples (n* censored)`. */
export function stabilityLine(s: DirectionStability): string {
  const pct = Number.isNaN(s.share) ? "—" : `${Math.round(s.share * 100)}%`;
  const n = s.nStar === "censored" ? "n* censored" : `n*=${s.nStar}`;
  if (s.stable) return `stable  ${s.direction === "b" ? "B" : "A"} better in ${pct} of resamples (${n})`;
  const lead = s.direction === "none" ? "no direction" : `${s.direction === "b" ? "B" : "A"} better`;
  return `unstable  ${lead} in ${pct} of resamples (${n})`;
}
