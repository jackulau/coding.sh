// Coverage turnover between two arms that ran the same cases k times each
// (EvoAudit, arXiv 2611.07624 §3, App. B.1-B.2). A case is covered when it
// passed in at least one of its trials. A net coverage gain can hide cases the
// candidate stopped solving at all, and a reliability gain (higher mean pass
// rate) can move the other way from coverage, so gains and losses are counted
// separately, with a success-count matrix and a first-half / second-half check
// on the trial order (some aggregate directions reverse between halves).
import type { CaseRun } from "../datasets/types.ts";

/** One half of the trials (by trial order): B − A on the mean pass rate and on coverage. */
export interface TurnoverHalf {
  /** Trials in this half, 1-based and inclusive: [from, to]. Per case and arm the split is floor(k/2). */
  trials: [number, number];
  avgDiff: number;
  coverageDiff: number;
}

export interface Turnover {
  /** Cases with outcomes in both arms. */
  paired: number;
  /** Share of paired cases with at least one pass, per arm; diff = b − a. */
  coverage: { a: number; b: number; diff: number };
  /** A never passed, B passed at least once. Sorted by id. */
  gained: string[];
  /** A passed at least once, B never. Sorted by id. */
  lost: string[];
  /** Covered in both arms. */
  keptCovered: number;
  /** Covered in neither arm. */
  neverCovered: number;
  /** Paired cases whose pass rate went up, down or stayed the same from A to B. */
  reliability: { up: number; down: number; same: number };
  /**
   * Success counts: matrix[sA][sB] = cases that passed sA of k trials in A and
   * sB in B, size (k+1)×(k+1). Only when every paired case ran k trials in both arms.
   */
  matrix?: number[][];
  /** k of the matrix. */
  k?: number;
  /** Trials split in halves by order, when every paired case ran at least 2 trials in both arms. */
  halves?: {
    first: TurnoverHalf;
    second: TurnoverHalf;
    /** True when both halves are non-zero with opposite signs. */
    reversed: { avg: boolean; coverage: boolean };
  };
}

/** Each case's graded outcomes in trial order; a task error is a fail (its `pass` is false), an ungraded run is left out (as caseRates). */
export function outcomesByCase(runs: readonly CaseRun[]): Map<string, boolean[]> {
  const acc = new Map<string, { trial: number; pass: boolean }[]>();
  for (const r of runs) {
    if (r.ungraded) continue;
    const list = acc.get(r.caseId) ?? [];
    list.push({ trial: r.trial, pass: r.pass });
    acc.set(r.caseId, list);
  }
  const out = new Map<string, boolean[]>();
  for (const [id, list] of acc) out.set(id, list.sort((x, y) => x.trial - y.trial).map((x) => x.pass));
  return out;
}

const passes = (xs: readonly boolean[]) => xs.reduce((s, x) => s + (x ? 1 : 0), 0);
const meanOf = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** Mean pass rate and coverage over cases, each case cut to `slice` of its outcomes. */
function armStats(cases: readonly (readonly boolean[])[], slice: (xs: readonly boolean[]) => readonly boolean[]): { avg: number; coverage: number } {
  const parts = cases.map(slice);
  return { avg: meanOf(parts.map((p) => (p.length ? passes(p) / p.length : 0))), coverage: meanOf(parts.map((p) => (passes(p) > 0 ? 1 : 0))) };
}

const opposite = (x: number, y: number) => x !== 0 && y !== 0 && Math.sign(x) !== Math.sign(y);

/**
 * Coverage turnover from arm A to arm B. Each map holds one case's outcomes
 * in trial order; only cases in both maps (with at least one outcome each) are paired.
 */
export function turnover(a: ReadonlyMap<string, readonly boolean[]>, b: ReadonlyMap<string, readonly boolean[]>): Turnover {
  const ids = [...a.keys()].filter((id) => (a.get(id)?.length ?? 0) > 0 && (b.get(id)?.length ?? 0) > 0).sort();
  const gained: string[] = [];
  const lost: string[] = [];
  let keptCovered = 0;
  let neverCovered = 0;
  const reliability = { up: 0, down: 0, same: 0 };
  for (const id of ids) {
    const xa = a.get(id) as readonly boolean[];
    const xb = b.get(id) as readonly boolean[];
    const ca = passes(xa) > 0;
    const cb = passes(xb) > 0;
    if (ca && cb) keptCovered++;
    else if (!ca && !cb) neverCovered++;
    else if (cb) gained.push(id);
    else lost.push(id);
    const d = passes(xb) / xb.length - passes(xa) / xa.length;
    if (d > 0) reliability.up++;
    else if (d < 0) reliability.down++;
    else reliability.same++;
  }
  const n = ids.length;
  const share = (x: number) => (n ? x / n : NaN);
  const covA = share(keptCovered + lost.length);
  const covB = share(keptCovered + gained.length);
  const out: Turnover = { paired: n, coverage: { a: covA, b: covB, diff: covB - covA }, gained, lost, keptCovered, neverCovered, reliability };
  if (!n) return out;

  const A = ids.map((id) => a.get(id) as readonly boolean[]);
  const B = ids.map((id) => b.get(id) as readonly boolean[]);
  const k = A[0]!.length;
  if ([...A, ...B].every((xs) => xs.length === k)) {
    const matrix = Array.from({ length: k + 1 }, () => new Array<number>(k + 1).fill(0));
    for (let i = 0; i < n; i++) matrix[passes(A[i]!)]![passes(B[i]!)]!++;
    out.matrix = matrix;
    out.k = k;
  }
  if ([...A, ...B].every((xs) => xs.length >= 2)) {
    // Each case and arm splits its own trials at floor(k/2): h1 = [0, h), h2 = the rest.
    const h1 = (xs: readonly boolean[]) => xs.slice(0, Math.floor(xs.length / 2));
    const h2 = (xs: readonly boolean[]) => xs.slice(Math.floor(xs.length / 2));
    const half = (slice: typeof h1): Omit<TurnoverHalf, "trials"> => {
      const sa = armStats(A, slice);
      const sb = armStats(B, slice);
      return { avgDiff: sb.avg - sa.avg, coverageDiff: sb.coverage - sa.coverage };
    };
    const kMin = Math.min(...[...A, ...B].map((xs) => xs.length));
    const kMax = Math.max(...[...A, ...B].map((xs) => xs.length));
    const h = Math.floor(kMin / 2);
    const first = { trials: [1, h] as [number, number], ...half(h1) };
    const second = { trials: [h + 1, kMax] as [number, number], ...half(h2) };
    out.halves = { first, second, reversed: { avg: opposite(first.avgDiff, second.avgDiff), coverage: opposite(first.coverageDiff, second.coverageDiff) } };
  }
  return out;
}
