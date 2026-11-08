// Tie-break sampling and the regression stop (T3 Code evals), shared by
// `exp run` and `toolevals run`. Adaptive: two trials per case, a third only
// when the two disagree; a case fails when half or more of its trials fail.
// Its trial count depends on its outcomes, so a paired CI over it is biased:
// reports say "adaptive, no CI". Regression stop: the run stops once a case
// that passed every baseline trial fails. Pure: no I/O.

export type SamplesMode = "fixed" | "adaptive";

/** Trials every case gets under adaptive sampling; one more breaks a tie. */
export const ADAPTIVE_TRIALS = 2;
export const ADAPTIVE_MAX = 3;

/** Two graded trials that disagree. */
export const needsTieBreak = (passes: readonly boolean[]): boolean => passes.length === 2 && passes[0] !== passes[1];

/** A case fails when half or more of its graded trials fail (never on no graded trial). */
export const caseFails = (passes: readonly boolean[]): boolean => passes.length > 0 && 2 * passes.filter((p) => !p).length >= passes.length;

/** Keys whose every graded outcome passed (at least one). Undefined outcomes (ungraded) are left out. */
export function allPassKeys(outcomes: Iterable<{ key: string; pass: boolean | undefined }>): Set<string> {
  const seen = new Map<string, boolean>();
  for (const o of outcomes) {
    if (o.pass === undefined) continue;
    seen.set(o.key, (seen.get(o.key) ?? true) && o.pass);
  }
  return new Set([...seen].filter(([, ok]) => ok).map(([k]) => k));
}

export interface CaseVerdicts {
  /** Cases that passed: fewer than half their graded trials failed. */
  passed: number;
  failed: number;
  /** Cases that got a third trial. */
  tieBreaks: number;
}

/** Per-case verdicts over finished trials (pass undefined = ungraded). */
export function caseVerdicts(outcomes: Iterable<{ key: string; pass: boolean | undefined }>): CaseVerdicts {
  const by = new Map<string, { passes: boolean[]; n: number }>();
  for (const o of outcomes) {
    const c = by.get(o.key) ?? { passes: [], n: 0 };
    c.n++;
    if (o.pass !== undefined) c.passes.push(o.pass);
    by.set(o.key, c);
  }
  const v: CaseVerdicts = { passed: 0, failed: 0, tieBreaks: 0 };
  for (const c of by.values()) {
    if (!c.passes.length) continue;
    if (caseFails(c.passes)) v.failed++;
    else v.passed++;
    if (c.n > ADAPTIVE_TRIALS) v.tieBreaks++;
  }
  return v;
}

/**
 * Follows each case's trials as they finish: whether it needs a tie-break,
 * and whether a finished case is a regression against the baseline.
 */
export class CaseTracker {
  private readonly runs = new Map<string, { passes: boolean[]; n: number }>();
  private readonly mode: SamplesMode;
  private readonly trials: number;
  private readonly baseline: ReadonlySet<string> | undefined;
  constructor(mode: SamplesMode, trials: number, baseline?: ReadonlySet<string>) {
    this.mode = mode;
    this.trials = mode === "adaptive" ? ADAPTIVE_TRIALS : trials;
    this.baseline = baseline;
  }

  /** Records a finished trial; true when it completes a case that passed every baseline trial and now fails. */
  add(key: string, pass: boolean | undefined): boolean {
    const c = this.runs.get(key) ?? { passes: [], n: 0 };
    c.n++;
    if (pass !== undefined) c.passes.push(pass);
    this.runs.set(key, c);
    const done = this.mode === "adaptive" ? c.n >= ADAPTIVE_MAX || (c.n === ADAPTIVE_TRIALS && !needsTieBreak(c.passes)) : c.n >= this.trials;
    return done && !!this.baseline?.has(key) && caseFails(c.passes);
  }

  /** Adaptive: the case's first two trials finished and disagree. */
  needsTieBreak(key: string): boolean {
    const c = this.runs.get(key);
    return this.mode === "adaptive" && !!c && c.n === ADAPTIVE_TRIALS && needsTieBreak(c.passes);
  }
}
