// Seq@K and its companions: how much a task's success grows over K attempts.
//
// Pass@K counts a task solved when any of K independent attempts passes;
// Seq@K counts it solved when any of K sequential attempts with feedback
// passes (Yen et al., "Seq@K", arXiv 2610.37859 §3 Eq. 2). The two rank
// models differently: over 471 runs Pass@5 and Seq@5 correlate at Spearman
// +0.68, but the gains after attempt 1 at -0.08 (§5). So a report shows the
// whole curve, where its gain lands (EGS/LGS), how often a revision changed
// nothing, and which protocol buys success cheaper at each cost.
import { wilson, type BootstrapOpts } from "./interval.ts";
import { mulberry32 } from "./prng.ts";
import { quantileSorted } from "./summary.ts";

/**
 * Unbiased pass@k from n samples of which c passed (Chen et al., "Evaluating
 * Large Language Models Trained on Code", arXiv 2107.03374, Eq. 1):
 * pass@k = 1 − C(n−c, k) / C(n, k), computed as the running product
 * 1 − ∏_{i=n−c+1}^{n} (1 − k/i) so large n never overflows.
 */
export function passAtK(n: number, c: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k)) throw new RangeError(`passAtK: n, c and k must be integers (got ${n}, ${c}, ${k})`);
  if (k < 1 || k > n) throw new RangeError(`passAtK: k must be in [1, n] (got k=${k}, n=${n})`);
  if (c < 0 || c > n) throw new RangeError(`passAtK: c must be in [0, n] (got c=${c}, n=${n})`);
  if (n - c < k) return 1;
  let fail = 1;
  for (let i = n - c + 1; i <= n; i++) fail *= 1 - k / i;
  return 1 - fail;
}

/** One task's sequential trials: per trial, the 1-based attempt that first passed, or null. */
export interface SeqCase {
  id: string;
  solvedAt: readonly (number | null)[];
}

/** Seq@k with its 95% interval. */
export interface SeqPoint {
  k: number;
  rate: number;
  lo: number;
  hi: number;
}

/**
 * Seq@1..K (arXiv 2610.37859 Eq. 2): a trial counts at k when it passed at
 * attempt ≤ k; a task's Seq@k is the share of its trials that did; the curve
 * is the mean over tasks. The interval is Wilson's when every task has one
 * trial, else a percentile cluster bootstrap over tasks (a task's trials stay
 * together). Both are monotone in k: Wilson bounds rise with the count, and
 * each bootstrap draw's curve is monotone, so are its pointwise quantiles.
 */
export function seqCurve(cases: readonly SeqCase[], K: number, opts: BootstrapOpts = {}): SeqPoint[] {
  if (!Number.isInteger(K) || K < 1) throw new RangeError(`seqCurve: K must be a positive integer (got ${K})`);
  if (!cases.length) return [];
  // per[i][k-1] = case i's share of trials solved by attempt k.
  const per = cases.map((c) => {
    if (!c.solvedAt.length) throw new RangeError(`seqCurve: case ${c.id} has no trials`);
    const row = new Float64Array(K);
    for (const s of c.solvedAt) {
      if (s === null) continue;
      if (!Number.isInteger(s) || s < 1) throw new RangeError(`seqCurve: case ${c.id} has solvedAt ${s}; use a 1-based attempt or null`);
      for (let k = s; k <= K; k++) (row[k - 1] as number) += 1 / c.solvedAt.length;
    }
    return row;
  });
  const n = per.length;
  const rates = Array.from({ length: K }, (_, j) => per.reduce((s, r) => s + (r[j] as number), 0) / n);
  if (cases.every((c) => c.solvedAt.length === 1)) {
    return rates.map((rate, j) => {
      const w = wilson(Math.round(rate * n), n);
      return { k: j + 1, rate, lo: w.lo, hi: w.hi };
    });
  }
  const iters = opts.iters ?? 10_000;
  const alpha = opts.alpha ?? 0.05;
  const rand = mulberry32(opts.seed ?? 0x5eed);
  const draws = Array.from({ length: K }, () => new Float64Array(iters));
  const acc = new Float64Array(K);
  for (let b = 0; b < iters; b++) {
    acc.fill(0);
    for (let i = 0; i < n; i++) {
      const r = per[Math.floor(rand() * n)] as Float64Array;
      for (let j = 0; j < K; j++) (acc[j] as number) += r[j] as number;
    }
    for (let j = 0; j < K; j++) (draws[j] as Float64Array)[b] = (acc[j] as number) / n;
  }
  return rates.map((rate, j) => {
    const d = (draws[j] as Float64Array).sort() as unknown as number[];
    return { k: j + 1, rate, lo: Math.min(rate, quantileSorted(d, alpha / 2)), hi: Math.max(rate, quantileSorted(d, 1 - alpha / 2)) };
  });
}

/**
 * Where the gain from attempt 1 to K lands (arXiv 2610.37859 §5):
 * EGS = (Seq@2 − Seq@1) / (Seq@K − Seq@1), the early share;
 * LGS = (Seq@K − Seq@K−1) / (Seq@K − Seq@1), the share the last attempt
 * still adds. A high LGS says more attempts would still pay. Both are absent
 * when K < 2 or the curve does not rise; LGS is absent when K < 3 (it would
 * repeat EGS).
 */
export function gainShares(curve: readonly { rate: number }[]): { egs?: number; lgs?: number } {
  const K = curve.length;
  if (K < 2) return {};
  const at = (k: number) => (curve[k - 1] as { rate: number }).rate;
  const gain = at(K) - at(1);
  if (!(gain > 1e-12)) return {};
  return { egs: (at(2) - at(1)) / gain, ...(K >= 3 ? { lgs: (at(K) - at(K - 1)) / gain } : {}) };
}

export interface ProtocolPoint {
  /** e.g. "pass@k" or "seq@k". */
  protocol: string;
  k: number;
  cost: number;
  success: number;
}

/**
 * The cost frontier of each protocol (arXiv 2610.37859 §6): the points no
 * other point of the same protocol beats on both cost (lower) and success
 * (higher), sorted by protocol and cost. `overall` marks the points no point
 * of any protocol dominates: the protocol to pay for at that cost. Points
 * with a non-finite cost or success are dropped; of exact duplicates the
 * smallest k is kept.
 */
export function protocolFront(points: readonly ProtocolPoint[]): (ProtocolPoint & { overall: boolean })[] {
  const ok = points.filter((p) => Number.isFinite(p.cost) && Number.isFinite(p.success));
  const dominated = (p: ProtocolPoint, pool: readonly ProtocolPoint[]) =>
    pool.some((q, j) => q !== p && q.cost <= p.cost && q.success >= p.success && (q.cost < p.cost || q.success > p.success || q.k < p.k || (q.k === p.k && j < pool.indexOf(p))));
  const out: (ProtocolPoint & { overall: boolean })[] = [];
  for (const protocol of [...new Set(ok.map((p) => p.protocol))].sort()) {
    const pool = ok.filter((p) => p.protocol === protocol);
    for (const p of pool) {
      if (dominated(p, pool)) continue;
      // Across protocols an equal point of another protocol does not knock this one off.
      const overall = !ok.some((q) => q.protocol !== protocol && q.cost <= p.cost && q.success >= p.success && (q.cost < p.cost || q.success > p.success));
      out.push({ ...p, overall });
    }
  }
  return out.sort((x, y) => (x.protocol < y.protocol ? -1 : x.protocol > y.protocol ? 1 : x.cost - y.cost || x.k - y.k));
}

export interface RankFlip {
  /** Ranked above `higherInB` by `a`. */
  higherInA: string;
  /** Ranked above `higherInA` by `b`. */
  higherInB: string;
  gapA: number;
  gapB: number;
}

export interface RankAgreement {
  /** Items both rankings score. */
  n: number;
  /** Kendall's τ-b (ties-corrected); absent for n < 2 or when one side is all ties. */
  kendallTau?: number;
  /** Spearman's ρ on average ranks; absent for n < 2 or when one side is all ties. */
  spearman?: number;
  /** Pairs the two order strictly the other way, largest gap in `b` first, at most 20. */
  flipped: RankFlip[];
}

type Scores = ReadonlyMap<string, number> | Readonly<Record<string, number>>;

/**
 * How far two rankings of the same items agree (higher score = better), e.g.
 * models by Pass@1 and by Seq@K. τ-b = (n_c − n_d) / √((n_0 − n_1)(n_0 − n_2))
 * (Kendall 1945); ρ = Pearson correlation of average ranks.
 */
export function rankAgreement(a: Scores, b: Scores): RankAgreement {
  const ma = a instanceof Map ? a : new Map(Object.entries(a));
  const mb = b instanceof Map ? b : new Map(Object.entries(b));
  const ids = [...ma.keys()].filter((id) => mb.has(id) && Number.isFinite(ma.get(id)) && Number.isFinite(mb.get(id))).sort();
  const n = ids.length;
  const xa = ids.map((id) => ma.get(id) as number);
  const xb = ids.map((id) => mb.get(id) as number);
  const flips: RankFlip[] = [];
  let nc = 0;
  let nd = 0;
  let ta = 0;
  let tb = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const da = Math.sign((xa[i] as number) - (xa[j] as number));
      const db = Math.sign((xb[i] as number) - (xb[j] as number));
      if (da === 0) ta++;
      if (db === 0) tb++;
      if (da * db > 0) nc++;
      else if (da * db < 0) {
        nd++;
        const [hi, lo] = da > 0 ? [i, j] : [j, i];
        flips.push({ higherInA: ids[hi] as string, higherInB: ids[lo] as string, gapA: Math.abs((xa[i] as number) - (xa[j] as number)), gapB: Math.abs((xb[i] as number) - (xb[j] as number)) });
      }
    }
  }
  flips.sort((x, y) => y.gapB - x.gapB || y.gapA - x.gapA);
  const out: RankAgreement = { n, flipped: flips.slice(0, 20) };
  if (n < 2) return out;
  const n0 = (n * (n - 1)) / 2;
  const den = Math.sqrt((n0 - ta) * (n0 - tb));
  if (den > 0) out.kendallTau = (nc - nd) / den;
  const ra = avgRanks(xa);
  const rb = avgRanks(xb);
  const rho = pearson(ra, rb);
  if (rho !== undefined) out.spearman = rho;
  return out;
}

/** 1-based ranks, ties sharing their average rank. */
function avgRanks(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && (order[j + 1] as readonly [number, number])[0] === (order[i] as readonly [number, number])[0]) j++;
    for (let t = i; t <= j; t++) r[(order[t] as readonly [number, number])[1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

function pearson(x: readonly number[], y: readonly number[]): number | undefined {
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - mx;
    const dy = (y[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : undefined;
}

/**
 * Share of revisions that resubmitted the previous answer unchanged (arXiv
 * 2610.37859 App. E.2: 0% to 48% by model), comparing after trimming and
 * collapsing whitespace. Undefined when there are no revisions.
 */
export function unchangedRate(revisions: readonly { prev: string; next: string }[]): number | undefined {
  if (!revisions.length) return undefined;
  const norm = (s: string) => s.trim().replace(/\s+/g, " ");
  return revisions.filter((r) => norm(r.next) === norm(r.prev)).length / revisions.length;
}
