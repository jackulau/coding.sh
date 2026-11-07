// Group sequential test for a paired A/B with a fixed case budget (EM-3).
//
// Why group sequential and not an anytime-valid test (mSPRT, e-values): an
// eval A/B knows its maximum size in advance (the dataset, or --max-cases),
// and it is checked at a few planned looks. For a known horizon and a
// handful of looks, a group sequential design spends its alpha where the data
// is, and loses little power against the fixed-n test; always-valid tests pay
// for unlimited peeking with wider bounds. Spotify's comparison found power
// 0.93 for a group sequential test vs 0.72 for mSPRT over 14 looks:
//   Spotify, "Choosing a Sequential Testing Framework", 2023,
//   https://engineering.atspotify.com/2023/3/choosing-sequential-testing-framework-comparisons-and-discussions
//
// Design: Lan–DeMets alpha spending with the O'Brien–Fleming-type function
// α(t) = 2 − 2Φ(z_{1−α/4} / √t) per side, boundaries found by the
// Armitage–McPherson–Rowe recursive integration. Early looks need very strong
// evidence (z ≈ 4.33 at a quarter of the cases for 4 looks), so the final look
// is close to the fixed-n test (z ≈ 2.01 vs 1.96).
//   Lan, DeMets, "Discrete sequential boundaries for clinical trials",
//   Biometrika 70(3), 1983. https://doi.org/10.1093/biomet/70.3.659
//   O'Brien, Fleming, "A multiple testing procedure for clinical trials",
//   Biometrics 35(3), 1979. https://doi.org/10.2307/2530245
//
// Statistic: the self-normalized score statistic Σd / √Σd² on per-case
// (B − A) differences, which is McNemar's (c − b)/√(b + c) for one trial per
// case and uses the variance under the null, so it does not explode when few
// cases differ. The reported interval inverts the same statistic: the
// repeated confidence interval {δ : |Σ(d − δ)| / √Σ(d − δ)² < c_k} (Jennison,
// Turnbull, "Interim analyses: the repeated confidence interval approach",
// JRSS B 51(3), 1989). Repeated CIs cover the true difference at every look
// at once, so the interval stays valid whenever and why ever the run stopped,
// and it excludes 0 exactly when the test rejects.
import { normalCdf, normalQuantile } from "./normal.ts";

const phi = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/**
 * Cumulative two-sided alpha spent by information fraction t under the
 * O'Brien–Fleming-type Lan–DeMets function, applied to each side's α/2 (the
 * gsDesign and ldbounds convention): 2 · (2 − 2Φ(z_{1−α/4} / √t)).
 */
export function obrienFlemingSpend(t: number, alpha: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return alpha;
  return 4 * (1 - normalCdf(normalQuantile(1 - alpha / 4) / Math.sqrt(t)));
}

/** Simpson weights for `m` (odd) equally spaced points over [-h, h]. */
function simpson(m: number, h: number) {
  const w = new Float64Array(m);
  const step = (2 * h) / (m - 1);
  for (let i = 0; i < m; i++) w[i] = ((i === 0 || i === m - 1 ? 1 : i % 2 ? 4 : 2) * step) / 3;
  return w;
}

/**
 * Two-sided z boundaries c_k for looks at increasing information fractions
 * (the last should be 1), spending alpha by the O'Brien–Fleming-type
 * function: under H0 the chance |Z_k| ≥ c_k at some look is `alpha`.
 * A look with nothing left to spend gets Infinity (it never rejects).
 */
export function obrienFlemingBounds(fractions: readonly number[], alpha = 0.05): number[] {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must be in (0, 1) (got ${alpha})`);
  for (let k = 0; k < fractions.length; k++) {
    const t = fractions[k] as number;
    if (!(t > 0 && t <= 1) || (k > 0 && !(t > (fractions[k - 1] as number)))) throw new RangeError(`information fractions must increase within (0, 1] (got ${fractions.join(", ")})`);
  }
  const M = 401; // grid points over the continuation region of the Brownian motion B(t) = Z·√t
  const bounds: number[] = [];
  let grid = new Float64Array(0);
  let dens = new Float64Array(0); // sub-density of B at the last look, on paths that never crossed
  let w = new Float64Array(0);
  let prevT = 0;
  let spent = 0;
  for (const t of fractions) {
    const target = obrienFlemingSpend(t, alpha) - spent;
    const s = Math.sqrt(t - prevT);
    // P(cross at this look | no earlier crossing), as a function of the z boundary c.
    const cross = (c: number) => {
      const a = c * Math.sqrt(t);
      if (!grid.length) return 2 * (1 - normalCdf(c));
      let p = 0;
      for (let j = 0; j < grid.length; j++) {
        const u = grid[j] as number;
        p += (w[j] as number) * (dens[j] as number) * (normalCdf((-a - u) / s) + 1 - normalCdf((a - u) / s));
      }
      return p;
    };
    let c: number;
    if (!(target > 1e-12)) c = Infinity;
    else {
      let lo = 0;
      let hi = 40;
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (cross(mid) > target) lo = mid;
        else hi = mid;
      }
      c = (lo + hi) / 2;
    }
    bounds.push(c);
    spent += Number.isFinite(c) ? cross(c) : 0;
    // Carry the density of B(t) over the continuation region |B| < c√t to the next look.
    const h = Number.isFinite(c) ? c * Math.sqrt(t) : 10 * Math.sqrt(t);
    const next = new Float64Array(M);
    const nextGrid = new Float64Array(M);
    for (let i = 0; i < M; i++) nextGrid[i] = -h + (2 * h * i) / (M - 1);
    for (let i = 0; i < M; i++) {
      const v = nextGrid[i] as number;
      if (!grid.length) next[i] = phi(v / s) / s;
      else {
        let f = 0;
        for (let j = 0; j < grid.length; j++) f += (w[j] as number) * (dens[j] as number) * phi((v - (grid[j] as number)) / s);
        next[i] = f / s;
      }
    }
    grid = nextGrid;
    dens = next;
    w = simpson(M, h);
    prevT = t;
  }
  return bounds;
}

/** Self-normalized score statistic Σd / √Σd² on paired differences; 0 when every difference is 0. */
export function pairedScoreZ(diffs: readonly number[]): number {
  let s1 = 0;
  let s2 = 0;
  for (const d of diffs) {
    s1 += d;
    s2 += d * d;
  }
  return s2 > 0 ? s1 / Math.sqrt(s2) : 0;
}

/**
 * Repeated confidence interval at boundary c: the differences δ for which
 * |Σ(d − δ)| / √Σ(d − δ)² < c, clipped to [lo, hi] (the range a difference
 * can take). With n ≤ c² no δ can be rejected and the interval is the range.
 */
export function pairedScoreInterval(diffs: readonly number[], c: number, range: [number, number] = [-1, 1]): { mean: number; lo: number; hi: number } {
  const n = diffs.length;
  if (!n) return { mean: NaN, lo: range[0], hi: range[1] };
  const m = diffs.reduce((s, d) => s + d, 0) / n;
  const ss = diffs.reduce((s, d) => s + (d - m) ** 2, 0);
  if (!(n > c * c)) return { mean: m, lo: range[0], hi: range[1] };
  const half = c * Math.sqrt(ss / (n * (n - c * c)));
  return { mean: m, lo: Math.max(range[0], m - half), hi: Math.min(range[1], m + half) };
}

export interface SequentialPlan {
  design: "obrien-fleming";
  alpha: number;
  /** Paired-case budget: the last look. */
  maxCases: number;
  /** Paired cases at each look, increasing; the last is maxCases. */
  looks: number[];
  /** Two-sided z boundary at each look. */
  bounds: number[];
  /** Cumulative alpha spent by each look. */
  spent: number[];
}

/** Paired cases below which no look is taken: early looks with fewer are merged into the first one with enough. */
export const MIN_LOOK_CASES = 20;

/**
 * Looks at k/K of the budget (K = `looks`), dropping any before `minCases`
 * paired cases; boundaries spend `alpha` over the looks that remain. A budget
 * under `minCases` gets a single look at the end (a fixed-n test).
 */
export function planSequential(maxCases: number, opts: { looks?: number; alpha?: number; minCases?: number } = {}): SequentialPlan {
  const K = opts.looks ?? 4;
  const alpha = opts.alpha ?? 0.05;
  const min = opts.minCases ?? MIN_LOOK_CASES;
  if (!(Number.isInteger(maxCases) && maxCases >= 1)) throw new RangeError(`maxCases must be a positive integer (got ${maxCases})`);
  if (!(Number.isInteger(K) && K >= 1)) throw new RangeError(`looks must be a positive integer (got ${K})`);
  const looks = [...new Set(Array.from({ length: K }, (_, i) => Math.round(((i + 1) / K) * maxCases)))].filter((n) => n >= min || n === maxCases);
  const fractions = looks.map((n) => n / maxCases);
  return { design: "obrien-fleming", alpha, maxCases, looks, bounds: obrienFlemingBounds(fractions, alpha), spent: fractions.map((t) => obrienFlemingSpend(t, alpha)) };
}

export interface LookResult {
  /** 1-based look number. */
  look: number;
  /** Planned paired cases at this look. */
  planned: number;
  /** Paired cases with an outcome in both arms (ungraded ones are left out). */
  n: number;
  z: number;
  bound: number;
  /** Mean of per-case (B − A) differences with the repeated confidence interval. */
  diff: { mean: number; lo: number; hi: number };
  /** |z| ≥ bound. */
  crossed: boolean;
}

/** One look of the plan on the paired differences seen so far. */
export function sequentialLook(plan: SequentialPlan, look: number, diffs: readonly number[]): LookResult {
  const bound = plan.bounds[look - 1];
  if (bound === undefined) throw new RangeError(`look ${look} is not in the plan (${plan.looks.length} looks)`);
  const z = pairedScoreZ(diffs);
  return { look, planned: plan.looks[look - 1] as number, n: diffs.length, z, bound, diff: pairedScoreInterval(diffs, bound), crossed: Math.abs(z) >= bound };
}

/** Where a group sequential A/B stopped, and why. */
export interface SequentialOutcome {
  plan: SequentialPlan;
  /** Looks taken, in order; the last is where the run stopped. */
  history: LookResult[];
  /**
   * "crossed": a boundary was crossed (early, or at the last look).
   * "budget": the last look ran without crossing.
   * "cancelled": interrupted before the last look.
   */
  reason: "crossed" | "budget" | "cancelled";
  /** Stopped before the last planned look. */
  early: boolean;
  verdict: "better" | "worse" | "inconclusive";
  /** Paired cases the stored arms hold: the planned count at the last look taken (0 before any look). */
  stoppedAt: number;
  /** Mean B − A at the last look with its repeated confidence interval; valid however the run stopped. */
  diff: { mean: number; lo: number; hi: number };
}

/** Summarize the looks taken (see SequentialOutcome). */
export function sequentialOutcome(plan: SequentialPlan, history: readonly LookResult[]): SequentialOutcome {
  const last = history.at(-1);
  const crossed = last?.crossed === true;
  const final = history.length === plan.looks.length;
  return {
    plan,
    history: [...history],
    reason: crossed ? "crossed" : final ? "budget" : "cancelled",
    early: crossed && !final,
    verdict: crossed ? ((last as LookResult).z > 0 ? "better" : "worse") : "inconclusive",
    stoppedAt: last?.planned ?? 0,
    diff: last ? last.diff : { mean: NaN, lo: -1, hi: 1 },
  };
}
