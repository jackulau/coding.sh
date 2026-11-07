// Inter-rater agreement (judge vs human labels).

export interface KappaResult {
  n: number;
  /** Observed agreement p_o. */
  agreement: number;
  /** Chance agreement p_e from the marginals. */
  expected: number;
  /** Cohen's κ = (p_o − p_e) / (1 − p_e). NaN when p_e = 1 (both raters used one category only). */
  kappa: number;
  categories: string[];
  /** confusion[a][b] = items rater A put in a and rater B put in b. */
  confusion: Record<string, Record<string, number>>;
}

export function cohenKappa(a: readonly string[], b: readonly string[], categories?: readonly string[]): KappaResult {
  if (a.length !== b.length) throw new RangeError("cohenKappa: label arrays differ in length");
  const cats = [...new Set([...(categories ?? []), ...a, ...b])];
  const confusion: Record<string, Record<string, number>> = {};
  for (const x of cats) {
    const row: Record<string, number> = {};
    for (const y of cats) row[y] = 0;
    confusion[x] = row;
  }
  const n = a.length;
  let agree = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as string;
    const y = b[i] as string;
    const row = confusion[x] as Record<string, number>;
    row[y] = (row[y] ?? 0) + 1;
    if (x === y) agree++;
  }
  if (n === 0) return { n, agreement: NaN, expected: NaN, kappa: NaN, categories: cats, confusion };
  let pe = 0;
  for (const c of cats) {
    let ra = 0;
    let rb = 0;
    for (const y of cats) ra += (confusion[c] as Record<string, number>)[y] ?? 0;
    for (const x of cats) rb += (confusion[x] as Record<string, number>)[c] ?? 0;
    pe += (ra / n) * (rb / n);
  }
  const po = agree / n;
  const kappa = 1 - pe < 1e-12 ? NaN : (po - pe) / (1 - pe);
  return { n, agreement: po, expected: pe, kappa, categories: cats, confusion };
}

export function percentAgreement(a: readonly string[], b: readonly string[]): number {
  if (a.length !== b.length) throw new RangeError("percentAgreement: label arrays differ in length");
  if (a.length === 0) return NaN;
  let k = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) k++;
  return k / a.length;
}
