// Hypothesis tests.

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
