// Text-overlap leakage check: does the instruction already contain the answer?

/** Code-ish tokens: identifiers/numbers, and single punctuation characters. */
export function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) ?? [];
}

function ngrams(tokens: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join("\u0001"));
  return out;
}

export interface Overlap {
  n: number;
  /** n-grams in the reference text. */
  total: number;
  /** Of those, how many also appear in the probe text. */
  shared: number;
  /** shared / total (0 when total = 0). */
  fraction: number;
}

/**
 * Fraction of the reference's token n-grams that also occur in `probe`.
 * With n ≈ 8, a match means a run of 8 identical code tokens — prose that
 * merely mentions identifiers does not trip it, pasted code does.
 */
export function ngramOverlap(reference: string, probe: string, n = 8): Overlap {
  const ref = ngrams(tokenize(reference), n);
  if (ref.length === 0) return { n, total: 0, shared: 0, fraction: 0 };
  const have = new Set(ngrams(tokenize(probe), n));
  let shared = 0;
  for (const g of ref) if (have.has(g)) shared++;
  return { n, total: ref.length, shared, fraction: shared / ref.length };
}

/**
 * Overlap summed over separate reference blocks (e.g. the added-line runs of
 * a patch), so no n-gram spans two unrelated places. Blocks shorter than n
 * tokens are too small to judge and are skipped.
 */
export function blockOverlap(blocks: readonly string[], probe: string, n = 8): Overlap {
  const have = new Set(ngrams(tokenize(probe), n));
  let total = 0;
  let shared = 0;
  for (const b of blocks) {
    for (const g of ngrams(tokenize(b), n)) {
      total++;
      if (have.has(g)) shared++;
    }
  }
  return { n, total, shared, fraction: total ? shared / total : 0 };
}
