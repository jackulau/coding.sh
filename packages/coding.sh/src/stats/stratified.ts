// Stratified human audits of a judge, and when a judge is worth calibrating.
//
// Source: Choi et al., "From Self-Confidence to Statistical Accuracy"
// (arXiv 2610.35698, https://arxiv.org/abs/2610.35698). Equation numbers below
// are the paper's. A judge's confidence is a valid stratification variable even
// when it is miscalibrated: sample at random within confidence strata, weight
// each stratum by its population share, and the human-audited pass rate is
// unbiased. Proportional allocation nearly matches Neyman (RMSE 2.46 vs 2.41 pp
// at 200 labels on MMLU-Pro; equal shares per stratum: 4.56 pp).
//
// The second half asks whether calibrating a judge saves human labels at all.
// Correcting a judge's pass rate costs A_v human labels' worth of variance per
// unit (Eq.6); auditing outputs directly costs θ(1 − θ). Their ratio is the label
// efficiency η (Eq.7). Only 6 of 56 MMLU-Pro target-verifier pairs reached η > 1
// despite 0.66-0.89 judgment accuracy.

const unit = (name: string, v: number, fn: string) => {
  if (!(v >= 0 && v <= 1)) throw new RangeError(`${fn}: ${name} ${v} outside [0, 1]`);
};

export interface StratumBin {
  /** Lower edge (inclusive); NaN for the unknown stratum. */
  lo: number;
  /** Upper edge (exclusive, except 1 is inclusive); NaN for the unknown stratum. */
  hi: number;
  size: number;
  /** Values that were undefined (no confidence): never merged. */
  unknown?: true;
}

/**
 * Bin values in [0, 1] (judge confidences) at `edges` (default the paper's
 * 0.2, 0.4, 0.6, 0.8), then merge any bin smaller than `minSize` (default 25)
 * into its smaller neighbour, smallest first, until every stratum has at least
 * `minSize` values or one is left. Undefined values form their own unmerged
 * 'unknown' stratum, last. `index[i]` is value i's stratum.
 */
export function binStrata(values: readonly (number | undefined)[], opts: { edges?: readonly number[]; minSize?: number } = {}): { index: number[]; strata: StratumBin[] } {
  const edges = [...(opts.edges ?? [0.2, 0.4, 0.6, 0.8])];
  const minSize = opts.minSize ?? 25;
  for (let i = 0; i < edges.length; i++) {
    if (!(edges[i]! > 0 && edges[i]! < 1) || (i > 0 && !(edges[i]! > edges[i - 1]!))) throw new RangeError(`binStrata: edges must increase within (0, 1) (got ${edges.join(", ")})`);
  }
  const bounds = [0, ...edges, 1];
  const bins = bounds.slice(0, -1).map((lo, i) => ({ lo, hi: bounds[i + 1]!, size: 0 }));
  const raw: number[] = values.map((v) => {
    if (v === undefined) return -1;
    unit("value", v, "binStrata");
    let b = 0;
    while (b < edges.length && v >= edges[b]!) b++;
    bins[b]!.size++;
    return b;
  });
  // owner[b] = which merged stratum raw bin b ended up in.
  let merged = bins.map((b, i) => ({ ...b, raw: [i] }));
  while (merged.length > 1) {
    let pick = -1;
    for (let i = 0; i < merged.length; i++) if (merged[i]!.size < minSize && (pick < 0 || merged[i]!.size < merged[pick]!.size)) pick = i;
    if (pick < 0) break;
    const left = merged[pick - 1];
    const right = merged[pick + 1];
    const into = !left ? pick + 1 : !right ? pick - 1 : left.size <= right.size ? pick - 1 : pick + 1;
    const [a, b] = into < pick ? [into, pick] : [pick, into];
    const m = { lo: merged[a]!.lo, hi: merged[b]!.hi, size: merged[a]!.size + merged[b]!.size, raw: [...merged[a]!.raw, ...merged[b]!.raw] };
    merged = [...merged.slice(0, a), m, ...merged.slice(b + 1)];
  }
  const owner = new Array<number>(bins.length);
  merged.forEach((m, j) => m.raw.forEach((r) => (owner[r] = j)));
  const strata: StratumBin[] = merged.map(({ lo, hi, size }) => ({ lo, hi, size }));
  const unknown = raw.filter((r) => r < 0).length;
  if (unknown) strata.push({ lo: NaN, hi: NaN, size: unknown, unknown: true });
  return { index: raw.map((r) => (r < 0 ? strata.length - 1 : owner[r]!)), strata };
}

/**
 * Proportional allocation of a label budget over strata of sizes N_j (App. B.2
 * integer version): one label per nonempty stratum, then each further label to
 * the stratum whose term π_j²/n_j in the Hoeffding denominator Σ π_j²/n_j
 * (Eq.3) falls most, with n_j < N_j, ties to the lower index. Minimising that
 * sum gives n_j ∝ π_j (App. C.2), so this is proportional allocation rounded
 * the way that keeps the worst-case bound tightest. A budget above Σ N_j is
 * clamped (labels everything).
 */
export function allocateProportional(sizes: readonly number[], budget: number): { n: number[]; clamped: boolean } {
  for (const s of sizes) if (!(Number.isInteger(s) && s >= 0)) throw new RangeError(`allocateProportional: sizes must be non-negative integers (got ${s})`);
  if (!(Number.isInteger(budget) && budget >= 0)) throw new RangeError(`allocateProportional: budget must be a non-negative integer (got ${budget})`);
  const N = sizes.reduce((s, x) => s + x, 0);
  const nonempty = sizes.filter((s) => s > 0).length;
  if (budget < nonempty) throw new RangeError(`allocateProportional: budget ${budget} is below the ${nonempty} nonempty strata (each needs one label)`);
  const clamped = budget > N;
  const B = Math.min(budget, N);
  const n = sizes.map((s) => (s > 0 ? 1 : 0));
  // π_j²/n_j − π_j²/(n_j + 1) = π_j² / (n_j (n_j + 1)); N² cancels, so compare N_j² / (n_j (n_j + 1)).
  for (let left = B - nonempty; left > 0; left--) {
    let best = -1;
    let gain = -1;
    for (let j = 0; j < sizes.length; j++) {
      const nj = n[j]!;
      if (nj >= sizes[j]!) continue;
      const g = (sizes[j]! * sizes[j]!) / (nj * (nj + 1));
      if (g > gain) {
        gain = g;
        best = j;
      }
    }
    n[best]!++;
  }
  return { n, clamped };
}

export interface StratumCount {
  /** Population size N_j. */
  N: number;
  /** Labelled (sampled) n_j ≤ N_j, drawn at random within the stratum. */
  n: number;
  /** Labelled items that passed. */
  successes: number;
}

export interface StratifiedEstimate {
  /** θ̂_str = Σ π_j p̂_j (Eq.1); NaN when a nonempty stratum has no labels. */
  p: number;
  /** √(Σ π_j² (1 − n_j/N_j) S_j² / n_j) (Eq.2, with the finite-population correction). */
  se: number;
  lo: number;
  hi: number;
  /** Worst-case half-width: P(|θ̂ − θ| ≥ ε) ≤ δ for ε = √(log(2/δ) Σ π_j²/n_j / 2) (Eq.3, Hoeffding). */
  hoeffdingEps: number;
  /**
   * Identification bounds when only n_j of N_j were labelled and the rest are
   * unknown (§3.1): [Σ π_j c_j μ_j, Σ π_j (c_j μ_j + 1 − c_j)], c_j = n_j/N_j.
   */
  bounds: { lo: number; hi: number };
  n: number;
  N: number;
}

/**
 * The stratified (self-weighting) audit estimator over strata of a random
 * design (Eq.1-3). S_j² = n_j/(n_j − 1) · p̂_j(1 − p̂_j), with 0.25 (the binary
 * maximum) when n_j < 2. The normal CI (z default 1.96) is clamped to [0, 1].
 */
export function stratifiedMean(strata: readonly StratumCount[], opts: { z?: number; delta?: number } = {}): StratifiedEstimate {
  const z = opts.z ?? 1.959963984540054;
  const delta = opts.delta ?? 0.05;
  if (!(delta > 0 && delta < 1)) throw new RangeError(`stratifiedMean: delta must be in (0, 1) (got ${delta})`);
  for (const s of strata) {
    if (!(Number.isInteger(s.N) && Number.isInteger(s.n) && Number.isInteger(s.successes) && s.N >= 0 && s.n >= 0 && s.n <= s.N && s.successes >= 0 && s.successes <= s.n)) {
      throw new RangeError(`stratifiedMean: need integers 0 ≤ successes ≤ n ≤ N (got N=${s.N}, n=${s.n}, successes=${s.successes})`);
    }
  }
  const N = strata.reduce((s, x) => s + x.N, 0);
  const n = strata.reduce((s, x) => s + x.n, 0);
  if (N === 0) return { p: NaN, se: NaN, lo: 0, hi: 1, hoeffdingEps: Infinity, bounds: { lo: 0, hi: 1 }, n, N };
  let p = 0;
  let v = 0;
  let h = 0;
  let blo = 0;
  let bhi = 0;
  let missing = false;
  for (const s of strata) {
    if (s.N === 0) continue;
    const pi = s.N / N;
    const cover = s.n / s.N;
    if (s.n === 0) {
      missing = true;
      bhi += pi;
      continue;
    }
    const pj = s.successes / s.n;
    p += pi * pj;
    const S2 = s.n < 2 ? 0.25 : (s.n / (s.n - 1)) * pj * (1 - pj);
    v += (pi * pi * (1 - cover) * S2) / s.n;
    h += (pi * pi) / s.n;
    blo += pi * cover * pj;
    bhi += pi * (cover * pj + 1 - cover);
  }
  const bounds = { lo: Math.max(0, blo), hi: Math.min(1, bhi) };
  if (missing) return { p: NaN, se: NaN, lo: 0, hi: 1, hoeffdingEps: Infinity, bounds, n, N };
  const se = Math.sqrt(v);
  return { p, se, lo: Math.max(0, p - z * se), hi: Math.min(1, p + z * se), hoeffdingEps: Math.sqrt((Math.log(2 / delta) * h) / 2), bounds, n, N };
}

/** Labels for a worst-case ±ε at confidence 1 − δ from simple random sampling: ⌈log(2/δ) / (2ε²)⌉ (Eq.3 with one stratum). */
export function hoeffdingBudget(eps: number, delta: number): number {
  if (!(eps > 0 && eps <= 1)) throw new RangeError(`hoeffdingBudget: eps must be in (0, 1] (got ${eps})`);
  if (!(delta > 0 && delta < 1)) throw new RangeError(`hoeffdingBudget: delta must be in (0, 1) (got ${delta})`);
  return Math.ceil(Math.log(2 / delta) / (2 * eps * eps));
}

export interface LabelEfficiency {
  /** Discrimination gap s − α (Youden's J): pass-recall minus false-pass rate. */
  gap: number;
  /**
   * Human-label variance per unit of the corrected judge estimate at the oracle
   * n1:n0 split (Eq.6): (θ√(s(1−s)) + (1−θ)√(α(1−α)))² / (s − α)². ∞ when gap ≤ 0.
   */
  A: number;
  /** Judge-call variance per unit (Eq.6): q(1 − q) / (s − α)², q = α + θ(s − α) the judge's pass rate. */
  D: number;
  /** η = θ(1 − θ) / A (Eq.7): > 1 means calibrating the judge needs 1/η of the human labels a direct audit would. 0 when gap ≤ 0. */
  eta: number;
  /** Oracle share of human labels on human-pass items (Eq.7): θ√(s(1−s)) / (θ√(s(1−s)) + (1−θ)√(α(1−α))). */
  n1Share: number;
}

/**
 * Label efficiency of correcting a judge (Rogan-Gladen with s and α estimated
 * from human labels) against auditing outputs directly, in the limit of
 * unlimited judge calls (Eq.4-7). θ = true pass rate, s = sensitivity
 * P(judge pass | human pass), α = false-pass rate P(judge pass | human fail).
 */
export function labelEfficiency(theta: number, s: number, alpha: number): LabelEfficiency {
  unit("theta", theta, "labelEfficiency");
  unit("s", s, "labelEfficiency");
  unit("alpha", alpha, "labelEfficiency");
  const gap = s - alpha;
  const r1 = theta * Math.sqrt(s * (1 - s));
  const r0 = (1 - theta) * Math.sqrt(alpha * (1 - alpha));
  const n1Share = r1 + r0 > 0 ? r1 / (r1 + r0) : 0.5;
  if (!(gap > 1e-12)) return { gap, A: Infinity, D: Infinity, eta: 0, n1Share };
  const A = ((r1 + r0) * (r1 + r0)) / (gap * gap);
  const q = alpha + theta * gap;
  const D = (q * (1 - q)) / (gap * gap);
  return { gap, A, D, eta: A > 0 ? (theta * (1 - theta)) / A : Infinity, n1Share };
}

/**
 * Human label cost above which calibrating the judge beats a direct audit at
 * the same precision, given a judge call costs `judgeCost` (Eq.8):
 * c_H* = c_L / ((√(θ(1−θ)) − √A) / √D)². ∞ when η ≤ 1 (the judge never saves labels).
 */
export function judgeBreakEven(theta: number, s: number, alpha: number, judgeCost: number): number {
  if (!(judgeCost >= 0 && Number.isFinite(judgeCost))) throw new RangeError(`judgeBreakEven: judgeCost must be a finite number ≥ 0 (got ${judgeCost})`);
  const e = labelEfficiency(theta, s, alpha);
  if (!(e.eta > 1)) return Infinity;
  const k = (Math.sqrt(theta * (1 - theta)) - Math.sqrt(e.A)) / Math.sqrt(e.D);
  return judgeCost / (k * k);
}
