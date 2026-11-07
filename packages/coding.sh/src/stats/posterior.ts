// Bayesian posterior for a paired pass/fail comparison. Below about 100 cases
// percentile bootstrap intervals under-cover (Bowyer et al.; Hariri et al.,
// "Don't Pass@k", ICLR 2026), so small comparisons also get a posterior on the
// paired outcome table: a Dirichlet over {A only, B only, neither/both} with a
// uniform prior. P(B > A) is exact: the B-only share of discordant pairs is
// Beta(c + prior, b + prior), so P(B > A) = P(that share > 1/2).
import { mulberry32 } from "./prng.ts";
import { quantileSorted } from "./summary.ts";

export interface PairedPosteriorOpts {
  /** Dirichlet concentration per cell. Default 1 (uniform). */
  prior?: number;
  /** Two-sided level for the credible interval; 0.05 → 95%. */
  alpha?: number;
  /** Monte Carlo draws for the credible interval. Default 20000. */
  draws?: number;
  seed?: number;
}

export interface PairedPosterior {
  /** P(B's pass rate > A's) under the posterior. */
  pBetter: number;
  /** Posterior mean of the pass-rate difference B − A. */
  mean: number;
  /** Equal-tailed credible interval for B − A. */
  lo: number;
  hi: number;
  prior: number;
  draws: number;
}

/** ln Γ(x) for x > 0 (Lanczos, g = 7, n = 9; ~15 digits). */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0] as number;
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += (c[i] as number) / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (modified Lentz). */
function betaCf(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b) = P(X ≤ x) for X ~ Beta(a, b). */
export function betaCdf(x: number, a: number, b: number): number {
  if (!(a > 0 && b > 0)) throw new RangeError(`betaCdf: shape parameters must be > 0 (got ${a}, ${b})`);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaCf(x, a, b)) / a : 1 - (front * betaCf(1 - x, b, a)) / b;
}

/** Gamma(shape, 1) draw (Marsaglia–Tsang; shape < 1 via the U^(1/a) boost). */
function gamma(shape: number, rand: () => number): number {
  if (shape < 1) return gamma(shape + 1, rand) * rand() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box–Muller standard normal.
      x = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - rand();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/**
 * Posterior for paired pass/fail outcomes: `b` cases only A passed, `c` only
 * B passed, `ties` both or neither. Dirichlet(b + α, c + α, ties + 2α) over
 * {A only, B only, tie}, which is the four-cell Dirichlet with the two tie
 * cells merged.
 */
export function pairedPosterior(b: number, c: number, ties: number, opts: PairedPosteriorOpts = {}): PairedPosterior {
  for (const [name, v] of [
    ["b", b],
    ["c", c],
    ["ties", ties],
  ] as const) {
    if (!(Number.isInteger(v) && v >= 0)) throw new RangeError(`pairedPosterior: ${name} must be a non-negative integer (got ${v})`);
  }
  const prior = opts.prior ?? 1;
  if (!(prior > 0)) throw new RangeError(`pairedPosterior: prior must be > 0 (got ${prior})`);
  const alpha = opts.alpha ?? 0.05;
  const draws = opts.draws ?? 20_000;
  const ab = b + prior;
  const ac = c + prior;
  const at = ties + 2 * prior;
  const rand = mulberry32(opts.seed ?? 0x5eed);
  const ds = new Float64Array(draws);
  for (let i = 0; i < draws; i++) {
    const gb = gamma(ab, rand);
    const gc = gamma(ac, rand);
    const gt = gamma(at, rand);
    ds[i] = (gc - gb) / (gb + gc + gt);
  }
  ds.sort();
  const sorted = Array.from(ds);
  return {
    pBetter: 1 - betaCdf(0.5, ac, ab),
    mean: (ac - ab) / (ab + ac + at),
    lo: quantileSorted(sorted, alpha / 2),
    hi: quantileSorted(sorted, 1 - alpha / 2),
    prior,
    draws,
  };
}
