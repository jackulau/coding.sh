// "Plausibly best" set (EM-7): multiple comparisons with the best (MCB) by a
// paired bootstrap, for comparing more than two configs on the same cases.
//
// Picking the top of K configs is a selection event: Jain, "The Leaderboard
// Lottery" (ICML 2026) finds the reported winner truly best only 0-58% of the
// time, and a paired-bootstrap MCB restores at least 95% coverage. Config i stays
// in the set when its gap to the best other config, max_{j≠i}(m_j − m_i), is
// within the (1−α) bootstrap quantile of max_{j≠i}[(m*_j − m*_i) − (m_j − m_i)].
// For the truly best config b every μ_j − μ_b ≤ 0, so b stays in the set with
// probability at least that quantile's level: the set covers the best at 1−α.
import { mulberry32 } from "./prng.ts";
import { quantileSorted } from "./summary.ts";

export interface BestSetArm {
  name: string;
  /** Per-case score (pass rate over trials, or 1/0), aligned on the same case index for every arm. NaN = missing. */
  scores: readonly number[];
}

export interface BestSetOpts {
  /** Miss rate for the set (default 0.05 → covers the best at 95%). */
  alpha?: number;
  iters?: number;
  seed?: number;
}

export interface BestSetRow {
  name: string;
  mean: number;
  /** max_{j≠i}(m_j − m_i): how far behind the best other config (≤ 0 for the leader). */
  gap: number;
  /** The bootstrap allowance for that gap. */
  margin: number;
  inSet: boolean;
}

export interface BestSet {
  /** Names in the set, best mean first. */
  best: string[];
  /** Cases every arm scored. */
  n: number;
  alpha: number;
  /** Every arm, in input order. */
  rows: BestSetRow[];
}

/**
 * The configs not significantly worse than the best, on the cases every arm
 * scored (a case missing from any arm is dropped). Cases are resampled together
 * across arms, so per-case difficulty cancels. The arm(s) with the top mean are
 * always in the set. Deterministic per seed.
 */
export function bestSet(arms: readonly BestSetArm[], opts: BestSetOpts = {}): BestSet {
  const alpha = opts.alpha ?? 0.05;
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`bestSet: alpha must be in (0, 1), got ${alpha}`);
  const iters = opts.iters ?? 2000;
  const K = arms.length;
  if (K === 0) return { best: [], n: 0, alpha, rows: [] };
  const len = Math.min(...arms.map((a) => a.scores.length));
  const cases: number[] = [];
  for (let c = 0; c < len; c++) if (arms.every((a) => Number.isFinite(a.scores[c]))) cases.push(c);
  const n = cases.length;
  const X = arms.map((a) => cases.map((c) => a.scores[c]!));
  const means = X.map((xs) => (n ? xs.reduce((s, x) => s + x, 0) / n : NaN));
  const gapOf = (m: readonly number[], i: number) => {
    let g = -Infinity;
    for (let j = 0; j < K; j++) if (j !== i) g = Math.max(g, m[j]! - m[i]!);
    return g;
  };
  const gaps = means.map((_, i) => (K > 1 ? gapOf(means, i) : 0));
  if (n === 0 || K === 1) {
    const rows = arms.map((a, i) => ({ name: a.name, mean: means[i]!, gap: gaps[i]!, margin: NaN, inSet: n > 0 || K === 1 }));
    return { best: n || K === 1 ? arms.map((a) => a.name) : [], n, alpha, rows };
  }
  const rand = mulberry32(opts.seed ?? 0x5eed);
  const stats: number[][] = arms.map(() => []);
  const m = new Float64Array(K);
  for (let b = 0; b < iters; b++) {
    m.fill(0);
    for (let k = 0; k < n; k++) {
      const c = Math.floor(rand() * n);
      for (let a = 0; a < K; a++) m[a]! += X[a]![c]!;
    }
    for (let a = 0; a < K; a++) m[a] = m[a]! / n - means[a]!;
    for (let i = 0; i < K; i++) {
      let g = -Infinity;
      for (let j = 0; j < K; j++) if (j !== i) g = Math.max(g, m[j]! - m[i]!);
      stats[i]!.push(g);
    }
  }
  const top = Math.max(...means);
  const rows: BestSetRow[] = arms.map((a, i) => {
    const sorted = stats[i]!.sort((x, y) => x - y);
    const margin = Math.max(0, quantileSorted(sorted, 1 - alpha));
    return { name: a.name, mean: means[i]!, gap: gaps[i]!, margin, inSet: means[i] === top || gaps[i]! <= margin + 1e-12 };
  });
  const best = rows
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.inSet)
    .sort((x, y) => y.r.mean - x.r.mean || x.i - y.i)
    .map((x) => x.r.name);
  return { best, n, alpha, rows };
}

/** One line: "plausibly best (95%, 40 cases): a, b" or "best: a (clearly ahead at 95%, 40 cases)". */
export function formatBestSet(s: BestSet): string {
  const level = `${Math.round((1 - s.alpha) * 100)}%`;
  if (!s.best.length) return `plausibly best: none (no case scored by every config)`;
  if (s.best.length === 1 && s.rows.length > 1) return `best: ${s.best[0]} (clearly ahead of the rest at ${level}, ${s.n} shared cases)`;
  return `plausibly best (${level}, ${s.n} shared cases): ${s.best.join(", ")}`;
}
