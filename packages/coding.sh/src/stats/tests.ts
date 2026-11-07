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
