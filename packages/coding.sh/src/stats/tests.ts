// Hypothesis tests.
import { clusteredBootstrap } from "./cluster.ts";
import { pairedBootstrap } from "./interval.ts";
import { mulberry32 } from "./prng.ts";

/** ln C(n, k) via a running sum of logs — exact enough for n up to ~1e6. */
function logChoose(n: number, k: number, logFact: Float64Array): number {
  return (logFact[n] as number) - (logFact[k] as number) - (logFact[n - k] as number);
}

function logFactorials(n: number): Float64Array {
  const t = new Float64Array(n + 1);
  for (let i = 2; i <= n; i++) t[i] = (t[i - 1] as number) + Math.log(i);
  return t;
}

/** P(X ≤ k) for X ~ Binomial(n, 1/2). */
export function binomCdfHalf(k: number, n: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  const lf = logFactorials(n);
  const ln2n = n * Math.LN2;
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(logChoose(n, i, lf) - ln2n);
  return Math.min(1, s);
}

export interface McNemarResult {
  /** Discordant pairs: baseline passed, candidate failed. */
  b: number;
  /** Discordant pairs: baseline failed, candidate passed. */
  c: number;
  n: number;
  /** Exact two-sided p-value (binomial test on discordant pairs, p = 1/2). */
  p: number;
}

/**
 * Exact McNemar test for paired pass/fail outcomes. Only discordant pairs
 * carry information; under H0 each is equally likely to favour either arm.
 * Two-sided p = min(1, 2 · P(X ≤ min(b, c))), X ~ Bin(b + c, 1/2).
 */
export function mcnemar(b: number, c: number): McNemarResult {
  if (b < 0 || c < 0 || !Number.isInteger(b) || !Number.isInteger(c)) {
    throw new RangeError(`mcnemar: counts must be non-negative integers (got ${b}, ${c})`);
  }
  const n = b + c;
  if (n === 0) return { b, c, n, p: 1 };
  return { b, c, n, p: Math.min(1, 2 * binomCdfHalf(Math.min(b, c), n)) };
}

export interface SignTestResult {
  /** Differences above zero. */
  pos: number;
  /** Differences below zero. */
  neg: number;
  /** Exact zeros (left out of the test, as usual). */
  ties: number;
  /** Exact two-sided p-value: 2 · P(X ≤ min(pos, neg)), X ~ Bin(pos + neg, 1/2). 1 when every difference is 0. */
  p: number;
}

/**
 * Exact sign test on paired differences (H0: the median difference is 0). It
 * assumes nothing about their distribution, so it stays honest at small n,
 * where bootstrap tails are too thin. Same test as McNemar on the signs.
 */
export function signTest(diffs: readonly number[]): SignTestResult {
  let pos = 0;
  let neg = 0;
  let ties = 0;
  for (const d of diffs) {
    if (d > 0) pos++;
    else if (d < 0) neg++;
    else ties++;
  }
  return { pos, neg, ties, p: mcnemar(neg, pos).p };
}

/** McNemar from aligned pass/fail arrays (baseline[i] pairs with candidate[i]). */
export function mcnemarPaired(baseline: readonly boolean[], candidate: readonly boolean[]): McNemarResult {
  if (baseline.length !== candidate.length) throw new RangeError("mcnemarPaired: arrays differ in length");
  let b = 0;
  let c = 0;
  for (let i = 0; i < baseline.length; i++) {
    if (baseline[i] && !candidate[i]) b++;
    else if (!baseline[i] && candidate[i]) c++;
  }
  return mcnemar(b, c);
}

/**
 * Holm–Bonferroni step-down adjustment: adjusted p-values (same order as the
 * input) that control the family-wise error rate across m tests.
 */
export function holm(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(m);
  let running = 0;
  for (const [rank, [p, i]] of order.entries()) {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    out[i] = running;
  }
  return out;
}

/**
 * Fisher's exact test on a 2×2 table [[a, b], [c, d]]. Two-sided p: the sum
 * of hypergeometric probabilities (margins fixed) of every table no more
 * likely than the observed one. Exact at any n, so it suits small arms.
 */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  for (const v of [a, b, c, d]) {
    if (!(Number.isInteger(v) && v >= 0)) throw new RangeError(`fisherExact: counts must be non-negative integers (got ${a}, ${b}, ${c}, ${d})`);
  }
  const r1 = a + b;
  const c1 = a + c;
  const n = a + b + c + d;
  if (n === 0) return 1;
  const lf = logFactorials(n);
  const r2 = n - r1;
  const logP = (x: number) => logChoose(r1, x, lf) + logChoose(r2, c1 - x, lf) - logChoose(n, c1, lf);
  const observed = logP(a);
  let p = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) {
    const lp = logP(x);
    if (lp <= observed + 1e-7) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

/**
 * P(X ≥ k) for X ~ Binomial(n, p), summed in log space so it stays exact for
 * large n. 1 for k ≤ 0, 0 for k > n.
 */
export function binomUpperTail(k: number, n: number, p: number): number {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0) {
    throw new RangeError(`binomUpperTail: k and n must be integers, n ≥ 0 (got k=${k}, n=${n})`);
  }
  if (!(p >= 0 && p <= 1)) throw new RangeError(`binomUpperTail: p must be in [0, 1] (got ${p})`);
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p === 0) return 0;
  if (p === 1) return 1;
  const lf = logFactorials(n);
  const lp = Math.log(p);
  const lq = Math.log1p(-p);
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(logChoose(n, i, lf) + i * lp + (n - i) * lq);
  return Math.min(1, Math.max(0, s));
}

/**
 * Tuning for {@link acceptanceGate}. The defaults are ours: the SAGE paper
 * (arXiv 2609.36043) reports none. Its advice: loosen α when a reliable
 * verifier grades the task, tighten it when grading is noisy.
 */
export interface GateOpts {
  /** What one break costs, in fixes (λ ≥ 1). Default 2: breaking a solved item costs two fixes. */
  lambda?: number;
  /** One-sided significance level (0 < α ≤ 1). Default 0.05. */
  alpha?: number;
  /** Largest share of solved items the candidate may break (0 ≤ τ ≤ 1). Default 0.10. */
  tau?: number;
}

/**
 * stratum-regression: set by callers that also gate per group (`compare --gate
 * --by`): the pooled gate may pass, but one group's gate says don't ship.
 */
export type GateReason = "no-discordant" | "net-gain" | "not-significant" | "regression-fraction" | "stratum-regression";

export interface GateResult {
  decision: "accept" | "abstain";
  /** Items the candidate gets right that the baseline got wrong. */
  wins: number;
  /** Items the baseline got right that the candidate got wrong. */
  losses: number;
  /** Items the baseline got right (the pool losses come from). */
  solved: number;
  /** wins − λ · losses. */
  netGain: number;
  /** losses / solved (0 when nothing was solved). */
  regressionFraction: number;
  /** λ / (1 + λ): the win share at which the candidate only breaks even. */
  breakEven: number;
  /** Exact one-sided p: P(Bin(wins + losses, breakEven) ≥ wins). 1 with no discordant items. */
  p: number;
  lambda: number;
  alpha: number;
  tau: number;
  /** Wins needed, with no losses, to accept at this λ and α. */
  minCleanWins: number;
  /** Every condition that failed; empty on accept. */
  reasons: GateReason[];
}

/**
 * SAGE accept-or-abstain gate for a paired change (Wang et al., arXiv
 * 2609.36043). Ties are dropped; each discordant item is a win or a loss.
 * Accept only when the λ-weighted net gain is positive, the exact one-sided
 * binomial test on the discordant items beats break-even at α, and the
 * candidate breaks at most τ of the solved items. Otherwise abstain: keep
 * what you have. At (λ, α, τ) = (1, 1, 1) it is "accept when wins > losses"
 * (the mean-up rule), and every accept also passes that rule.
 */
export function acceptanceGate(counts: { wins: number; losses: number; solved: number }, opts: GateOpts = {}): GateResult {
  const { wins, losses, solved } = counts;
  const lambda = opts.lambda ?? 2;
  const alpha = opts.alpha ?? 0.05;
  const tau = opts.tau ?? 0.1;
  for (const [name, v] of [["wins", wins], ["losses", losses], ["solved", solved]] as const) {
    if (!(Number.isInteger(v) && v >= 0)) throw new RangeError(`acceptanceGate: ${name} must be a non-negative integer (got ${v})`);
  }
  if (losses > solved) throw new RangeError(`acceptanceGate: losses (${losses}) exceed solved (${solved})`);
  if (!(lambda >= 1 && Number.isFinite(lambda))) throw new RangeError(`acceptanceGate: lambda must be a finite number ≥ 1 (got ${lambda})`);
  if (!(alpha > 0 && alpha <= 1)) throw new RangeError(`acceptanceGate: alpha must be in (0, 1] (got ${alpha})`);
  if (!(tau >= 0 && tau <= 1)) throw new RangeError(`acceptanceGate: tau must be in [0, 1] (got ${tau})`);

  const breakEven = lambda / (1 + lambda);
  const netGain = wins - lambda * losses;
  const regressionFraction = solved === 0 ? 0 : losses / solved;
  const m = wins + losses;
  const p = m === 0 ? 1 : binomUpperTail(wins, m, breakEven);
  // The p of w wins and no losses is breakEven^w: the smallest w below α.
  let minCleanWins = 1;
  while (breakEven ** minCleanWins >= alpha) minCleanWins++;

  const reasons: GateReason[] = [];
  if (m === 0) reasons.push("no-discordant");
  else {
    if (!(netGain > 0)) reasons.push("net-gain");
    if (!(p < alpha)) reasons.push("not-significant");
  }
  if (regressionFraction > tau) reasons.push("regression-fraction");
  return {
    decision: reasons.length === 0 ? "accept" : "abstain",
    wins,
    losses,
    solved,
    netGain,
    regressionFraction,
    breakEven,
    p,
    lambda,
    alpha,
    tau,
    minCleanWins,
    reasons,
  };
}

/** {@link acceptanceGate} from aligned pass/fail arrays (baseline[i] pairs with candidate[i]). */
export function acceptanceGatePaired(baseline: readonly boolean[], candidate: readonly boolean[], opts: GateOpts = {}): GateResult {
  if (baseline.length !== candidate.length) throw new RangeError("acceptanceGatePaired: arrays differ in length");
  let wins = 0;
  let losses = 0;
  let solved = 0;
  for (let i = 0; i < baseline.length; i++) {
    if (baseline[i]) solved++;
    if (baseline[i] && !candidate[i]) losses++;
    else if (!baseline[i] && candidate[i]) wins++;
  }
  return acceptanceGate({ wins, losses, solved }, opts);
}

export interface PermutationOpts {
  /** Enumerate all 2^n sign flips up to this many pairs; Monte Carlo above. Default 20. */
  exactMaxN?: number;
  /** Monte Carlo sign-flip draws. Default 20000. */
  iters?: number;
  seed?: number;
  /** "greater": B − A > 0; "less": B − A < 0. Default "two-sided". */
  alternative?: "two-sided" | "greater" | "less";
}

export interface PermutationResult {
  p: number;
  /** Paired units (tasks); zeros are kept. */
  n: number;
  /** Observed mean of the per-pair differences (NaN when n = 0). */
  observed: number;
  method: "exact" | "monte-carlo";
  /** Monte Carlo draws (absent for the exact test). */
  iters?: number;
}

/**
 * Paired permutation (sign-flip) test on per-pair differences d_i = B_i − A_i.
 * H0: the two arms are exchangeable within each pair, so each d_i is equally
 * likely to be +|d_i| or −|d_i|. The statistic is the mean difference, zeros
 * kept. Up to `exactMaxN` pairs all 2^n sign assignments are enumerated in
 * Gray-code order (one flip per step on a running sum), so p is exact. Above
 * it p is the Monte Carlo estimate (1 + #{T* as extreme}) / (1 + iters), which
 * is never 0 and keeps the level (Phipson and Smyth, "Permutation p-values
 * should never be zero", SAGMB 9(1), 2010).
 *
 * Unlike a percentile bootstrap it holds its level at 5-11 tasks, the size of
 * a typical tool-eval suite, and unlike the sign test it keeps magnitudes, so
 * it works on per-task mean rewards with unequal k and on continuous metrics.
 * Fisher, The Design of Experiments (1935) §21; the task-paired form follows
 * AT-AT (arXiv 2610.34679) and Zmigrod et al. (2022). Exact values match
 * scipy.stats.permutation_test(permutation_type="samples", n_resamples=inf).
 */
export function pairedPermutation(diffs: readonly number[], opts: PermutationOpts = {}): PermutationResult {
  const n = diffs.length;
  const alt = opts.alternative ?? "two-sided";
  const exactMaxN = opts.exactMaxN ?? 20;
  for (const d of diffs) if (!Number.isFinite(d)) throw new RangeError(`pairedPermutation: differences must be finite (got ${d})`);
  if (n === 0) return { p: 1, n: 0, observed: NaN, method: "exact" };
  let obs = 0;
  let abs = 0;
  for (const d of diffs) {
    obs += d;
    abs += Math.abs(d);
  }
  // Sums closer than this are ties: the running sum and the observed sum add
  // the same terms in different orders, so an exact tie can drift by ulps.
  const tol = 1e-9 * Math.max(1, abs);
  const hit =
    alt === "two-sided" ? (s: number) => Math.abs(s) >= Math.abs(obs) - tol : alt === "greater" ? (s: number) => s >= obs - tol : (s: number) => s <= obs + tol;
  // 2^30 flips is the most the 32-bit Gray-code step can index (and minutes of work).
  if (n <= Math.min(exactMaxN, 30)) {
    // Gray code: step k flips the sign of pair ctz(k), starting from all +.
    const sign = new Int8Array(n).fill(1);
    let s = obs;
    let count = hit(s) ? 1 : 0;
    const total = 2 ** n;
    for (let k = 1; k < total; k++) {
      const i = 31 - Math.clz32(k & -k);
      s -= 2 * (sign[i] as number) * (diffs[i] as number);
      sign[i] = -(sign[i] as number);
      if (hit(s)) count++;
    }
    return { p: Math.min(1, count / total), n, observed: obs / n, method: "exact" };
  }
  const iters = opts.iters ?? 20_000;
  const rand = mulberry32(opts.seed ?? 0x5eed);
  let count = 0;
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rand() < 0.5 ? -(diffs[i] as number) : (diffs[i] as number);
    if (hit(s)) count++;
  }
  return { p: Math.min(1, (1 + count) / (1 + iters)), n, observed: obs / n, method: "monte-carlo", iters };
}

export interface SignFlipOpts extends PermutationOpts {
  /** Flip whole clusters, not single pairs (`clusterIds[i]` is the cluster of `diffs[i]`). */
  clusterIds?: readonly string[];
  /** Added to every difference before flipping: δ tests "B − A ≤ −δ" (a non-inferiority margin). Default 0. */
  shift?: number;
}

export interface SignFlipResult {
  /** Exact sign-flip p up to 20 units, a seeded Monte Carlo estimate above. */
  p: number;
  /** Units whose signs were flipped: pairs, or clusters with `clusterIds`. */
  units: number;
  method: "exact" | "monte-carlo";
}

/**
 * Sign-flip test at the unit a bootstrap resamples: pairs, or whole clusters.
 * Each unit's summed (shifted) difference keeps or flips its sign, so the test
 * holds its level however few units there are, where a bootstrap's interval or
 * share of draws does not: with 3 units that all improve, the bootstrap
 * interval is [x, x], while this p can't go below 1/2³ (one-sided). The
 * statistic is the total, which is the case-weighted mean times a constant.
 */
export function clusterSignFlip(diffs: readonly number[], opts: SignFlipOpts = {}): SignFlipResult {
  const { clusterIds, shift = 0, ...perm } = opts;
  if (clusterIds && clusterIds.length !== diffs.length) throw new RangeError("clusterSignFlip: diffs and clusterIds differ in length");
  let units: number[];
  if (clusterIds) {
    const sums = new Map<string, number>();
    diffs.forEach((d, i) => sums.set(clusterIds[i] as string, (sums.get(clusterIds[i] as string) ?? 0) + d + shift));
    units = [...sums.values()];
  } else units = diffs.map((d) => d + shift);
  const r = pairedPermutation(units, perm);
  return { p: r.p, units: r.n, method: r.method };
}

export interface NonInferiorityOpts {
  /** One-sided level: the bound is the α percentile of the bootstrap means. Default 0.05 (the lower end of the 90% two-sided interval). */
  alpha?: number;
  iters?: number;
  seed?: number;
  /** Resample these clusters instead of single pairs (`clusterIds[i]` is the cluster of `diffs[i]`). */
  clusterIds?: readonly string[];
}

export interface NonInferiorityResult {
  /** Mean of the per-pair differences (B − A). */
  mean: number;
  /** One-sided (1 − α) lower confidence bound on the mean difference; NaN with no pairs. */
  lower: number;
  /** The margin δ ≥ 0: how much worse B may be. */
  delta: number;
  /**
   * Exact one-sided sign-flip p of H0 "B − A ≤ −δ": each unit's (pair's, or
   * cluster's) summed difference plus δ times its size, signs flipped. 1 with no pairs.
   */
  p: number;
  /** Units the sign-flip test flipped: pairs, or clusters with `clusterIds`. */
  units: number;
  /** lower > −δ and p < α. False with no pairs. */
  nonInferior: boolean;
  n: number;
  alpha: number;
}

/**
 * Paired non-inferiority: is B at most δ worse than A? H0: μ_B − μ_A ≤ −δ
 * against H1: μ_B − μ_A > −δ, rejected at one-sided α when the (1 − α) lower
 * confidence bound of the mean paired difference lies above −δ. This is the
 * confidence-interval form of the test (CONSORT non-inferiority extension,
 * Piaggio et al., JAMA 308(24), 2012; FDA, "Non-Inferiority Clinical Trials to
 * Establish Effectiveness", 2016). The bound is the α percentile of the paired
 * bootstrap (pairs, or whole clusters, resampled), so it is the interval
 * `exp compare` already reports, read one-sided.
 *
 * A percentile bound is too narrow at a few units (3 tied pairs give a bound
 * of exactly 0), so the exact one-sided sign-flip test at the margin, at the
 * same unit, must reject too. It can only reject from ⌈log2(1/α)⌉ units: 5 at α 0.05,
 * 6 at 0.025. With many units the two agree, so the verdict is the bound's.
 */
export function nonInferiority(diffs: readonly number[], delta: number, opts: NonInferiorityOpts = {}): NonInferiorityResult {
  const alpha = opts.alpha ?? 0.05;
  if (!(delta >= 0 && Number.isFinite(delta))) throw new RangeError(`nonInferiority: delta must be a finite number ≥ 0 (got ${delta})`);
  if (!(alpha > 0 && alpha < 0.5)) throw new RangeError(`nonInferiority: alpha must be in (0, 0.5) (got ${alpha})`);
  const n = diffs.length;
  if (n === 0) return { mean: NaN, lower: NaN, delta, p: 1, units: 0, nonInferior: false, n, alpha };
  const seed = opts.seed ?? 0x5eed;
  const boot = { iters: opts.iters ?? 10_000, seed, alpha: 2 * alpha };
  const b = opts.clusterIds ? clusteredBootstrap(diffs, opts.clusterIds, boot) : pairedBootstrap(diffs, boot);
  const sf = clusterSignFlip(diffs, { shift: delta, alternative: "greater", seed, ...(opts.clusterIds ? { clusterIds: opts.clusterIds } : {}) });
  return { mean: b.mean, lower: b.lo, delta, p: sf.p, units: sf.units, nonInferior: b.lo > -delta && sf.p < alpha, n, alpha };
}

/**
 * Cases the baseline passed on every attempt (pass^k) that the candidate now
 * passes at most `maxRate` of the time. A non-inferior mean can hide them.
 * Sorted ids; cases missing from either side are skipped.
 */
export function hardRegressions(baseline: ReadonlyMap<string, readonly boolean[]>, candidate: ReadonlyMap<string, readonly boolean[]>, maxRate = 1 / 3): string[] {
  const out: string[] = [];
  for (const [id, a] of baseline) {
    const b = candidate.get(id);
    if (!a.length || !b?.length || !a.every(Boolean)) continue;
    if (b.filter(Boolean).length / b.length <= maxRate) out.push(id);
  }
  return out.sort();
}
