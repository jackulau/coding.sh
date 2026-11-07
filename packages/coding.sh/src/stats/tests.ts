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
