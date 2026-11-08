// Exact power of the two-sided McNemar test (AD-9).
//
// n paired cases, a share d of them discordant (one arm passes, the other
// fails), and a true gap δ = P(B wins) − P(A wins). Then the number of
// discordant cases is K ~ Bin(n, d) and, given K, B's wins are
// C ~ Bin(K, (d + δ) / 2d). The exact test (stats/tests.ts mcnemar) rejects
// when 2 · P(X ≤ min(C, K − C)) ≤ α for X ~ Bin(K, 1/2), so
//
//   power(n, d, δ) = Σ_K P(K) · P(reject | K)
//
// (Connor 1987 and Lachin 1992 give the normal approximations; this sums the
// exact distribution, as in arXiv 2610.04433's power appendix). The test
// needs a minimum number of discordant cases to reject at all (6 at α 0.05:
// 2 / 2⁶ = 0.031, while 5 give 2 / 2⁵ = 0.0625), so a small suite has a
// power ceiling: even δ = d (B wins every discordant case) is found only
// when K reaches that minimum. Below the ceiling no gap has the target power,
// whatever the normal-approximation MDE says.
import { betaCdf } from "./posterior.ts";

export interface McNemarPowerOpts {
  /** Two-sided significance level. Default 0.05. */
  alpha?: number;
}

export interface McNemarPlan {
  /** Paired cases. */
  n: number;
  /** Share of paired cases that are discordant. */
  discordance: number;
  alpha: number;
  /** Target power (1 − β). */
  power: number;
  /** Fewest discordant cases that can reject at `alpha`. */
  minDiscordant: number;
  /** Power at the largest possible gap (δ = d): the most this design can find. */
  ceiling: number;
  /** Smallest gap δ with power ≥ `power`; NaN when `ceiling` < `power`. */
  mde: number;
}

/** Terms of K ~ Bin(n, d) below this probability are skipped. */
const SKIP = 1e-15;

/** P(X ≤ k) for X ~ Bin(n, p) via the regularized incomplete beta: I_{1−p}(n − k, k + 1). */
function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  return betaCdf(1 - p, n - k, k + 1);
}

function checkAlpha(alpha: number, fn: string): void {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`${fn}: alpha must be in (0, 1) (got ${alpha})`);
}

/**
 * Largest C with 2 · P(X ≤ C) ≤ α for X ~ Bin(k, 1/2), per k = 0..n (−1 when
 * k discordant cases can never reject). The test rejects when min(C, K − C)
 * is at most this. crit(k) never falls and grows by at most 1 per k.
 */
function criticalValues(n: number, alpha: number): Int32Array {
  const crit = new Int32Array(n + 1);
  let c = -1;
  for (let k = 0; k <= n; k++) {
    while (c + 1 < k && 2 * binomCdf(c + 1, k, 0.5) <= alpha) c++;
    crit[k] = c;
  }
  return crit;
}

/** Fewest discordant cases that can reject at `alpha`: the smallest k with 2 / 2^k ≤ α. */
export function mcnemarMinDiscordant(alpha = 0.05): number {
  checkAlpha(alpha, "mcnemarMinDiscordant");
  return Math.max(1, Math.ceil(Math.log2(2 / alpha) - 1e-12));
}

/** Exact power as a function of δ for fixed n, d and α (the K weights and critical values computed once). */
function powerCurve(n: number, d: number, alpha: number): (delta: number) => number {
  if (!(Number.isInteger(n) && n >= 0)) throw new RangeError(`mcnemarPower: n must be a non-negative integer (got ${n})`);
  if (!(d >= 0 && d <= 1)) throw new RangeError(`mcnemarPower: discordance must be in [0, 1] (got ${d})`);
  checkAlpha(alpha, "mcnemarPower");
  if (n === 0 || d === 0) return () => 0;
  const crit = criticalValues(n, alpha);
  // P(K) for the K that can reject, in log space so large n stays finite.
  const lf = new Float64Array(n + 1);
  for (let i = 2; i <= n; i++) lf[i] = (lf[i - 1] as number) + Math.log(i);
  const ks: number[] = [];
  const pk: number[] = [];
  for (let k = mcnemarMinDiscordant(alpha); k <= n; k++) {
    const p = d === 1 ? (k === n ? 1 : 0) : Math.exp((lf[n] as number) - (lf[k] as number) - (lf[n - k] as number) + k * Math.log(d) + (n - k) * Math.log1p(-d));
    if (p < SKIP || (crit[k] as number) < 0) continue;
    ks.push(k);
    pk.push(p);
  }
  return (delta) => {
    if (!(delta >= 0 && delta <= d + 1e-12)) throw new RangeError(`mcnemarPower: delta must be in [0, discordance] (got ${delta}, discordance ${d})`);
    const q = Math.min(1, (d + delta) / (2 * d));
    let s = 0;
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i] as number;
      const c = crit[k] as number;
      // Reject when B's wins C ≤ c or A's wins K − C ≤ c (disjoint: c < k/2).
      s += (pk[i] as number) * (binomCdf(c, k, q) + binomCdf(c, k, 1 - q));
    }
    return Math.min(1, Math.max(0, s));
  };
}

/**
 * Exact two-sided McNemar power for n paired cases with discordance d and a
 * true gap δ in [0, d] (the sign does not matter, the test is two-sided).
 * At δ = 0 it is the test's size, at most α.
 */
export function mcnemarPower(n: number, d: number, delta: number, opts: McNemarPowerOpts = {}): number {
  return powerCurve(n, d, opts.alpha ?? 0.05)(Math.abs(delta));
}

/**
 * The exact design: the power ceiling at n and d, and the exact minimum
 * detectable gap (smallest δ with power ≥ the target, by bisection), NaN when
 * no gap reaches the target.
 */
export function mcnemarPlan(n: number, d: number, opts: McNemarPowerOpts & { power?: number } = {}): McNemarPlan {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  if (!(power > 0 && power < 1)) throw new RangeError(`mcnemarPlan: power must be in (0, 1) (got ${power})`);
  const f = powerCurve(n, d, alpha);
  const ceiling = f(d);
  let mde = NaN;
  if (ceiling >= power) {
    let lo = 0;
    let hi = d;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) >= power) hi = mid;
      else lo = mid;
    }
    mde = hi;
  }
  return { n, discordance: d, alpha, power, minDiscordant: mcnemarMinDiscordant(alpha), ceiling, mde };
}

/**
 * Paired cases the exact test needs to find a gap `effect` with the target
 * power at discordance d: the n where power first crosses the target by
 * bisection up to `max` (exact power saw-tooths a little in n, so a few
 * smaller n can also reach it). NaN when the effect is not in (0, d] or
 * `max` cases are not enough.
 */
export function mcnemarCasesFor(effect: number, d: number, opts: McNemarPowerOpts & { power?: number; max?: number } = {}): number {
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  const max = opts.max ?? 20000;
  if (!(effect > 0 && effect <= d && d <= 1)) return NaN;
  const ok = (n: number) => mcnemarPower(n, d, effect, { alpha }) >= power;
  if (!ok(max)) return NaN;
  let lo = mcnemarMinDiscordant(alpha) - 1;
  let hi = max;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
