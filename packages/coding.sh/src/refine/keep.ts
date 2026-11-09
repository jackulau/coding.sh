// Keep-rule pieces that read the per-task outcomes of a refine trial (Y-3).
// EvoAudit (arXiv 2611.07624 §6.3-6.4, App. D.4) found that a net score hides
// tasks a candidate stopped solving, that a candidate rejected on net score can
// still cover tasks the incumbent never solves, and that the top scorer is a
// poor pick among near-ties. So, around the keep decision:
//
//   preservation   coverage turnover on dev and held-out, and R: the tasks whose
//                  pass rate fell. Reported on every decision, never gating: the
//                  paper's own gate replay shows a preservation gate throws the
//                  best candidate away more often.
//   alternative    a rejected candidate worth archiving: K1 passed, it gained a
//                  task nothing kept covers, and it has no hard regression.
//   rankKeeps      several keeps: largest dev effect, overlapping CIs tied, ties
//                  broken by fewer regressions, then cost per solved task, then id.
//
// Outcomes are per task in attempt order (`outcomesByCase` from a run's CaseRuns).
// Pure: the trial runner and the ledger that call these are R2-8.
import { turnover } from "../experiments/turnover.ts";
import { hardRegressions } from "../stats/tests.ts";

/** Task id → pass/fail per attempt, in attempt order. */
export type Outcomes = ReadonlyMap<string, readonly boolean[]>;

/** Base and candidate outcomes on one task set. */
export interface ArmOutcomes {
  base: Outcomes;
  cand: Outcomes;
}

/** Coverage turnover on one task set (a task is covered when it passed at least once). */
export interface SetPreservation {
  /** Base never passed, candidate passed at least once. */
  gained: string[];
  /** Base passed at least once, candidate never. */
  lost: string[];
  /** Covered by both. */
  keptCovered: number;
}

export interface Preservation {
  dev: SetPreservation;
  heldOut?: SetPreservation;
  /** Which set R and `lost-coverage` read: held-out when there is one. */
  basis: "heldOut" | "dev";
  /** Tasks of the basis set whose candidate pass rate is below the base's. Sorted. */
  regressed: string[];
  /** R(C): regressed.length. */
  R: number;
  /** Tasks of the basis set neither arm passed in any attempt (AE-2: the proposer's next target). Sorted. */
  stillFailing: string[];
  /** Non-gating notes: `lost-coverage: N tasks`. */
  reasons: string[];
}

const rate = (xs: readonly boolean[]): number => xs.filter(Boolean).length / xs.length;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

function setPreservation(s: ArmOutcomes): SetPreservation {
  const t = turnover(s.base, s.cand);
  return { gained: t.gained, lost: t.lost, keptCovered: t.keptCovered };
}

/** Tasks in both arms whose candidate pass rate is below the base's. */
export function regressedTasks(s: ArmOutcomes): string[] {
  const out: string[] = [];
  for (const [id, a] of s.base) {
    const b = s.cand.get(id);
    if (a.length && b?.length && rate(b) < rate(a)) out.push(id);
  }
  return out.sort();
}

/** Tasks in both arms that neither arm passed in any attempt. */
export function stillFailingTasks(s: ArmOutcomes): string[] {
  const out: string[] = [];
  for (const [id, a] of s.base) {
    const b = s.cand.get(id);
    if (a.length && b?.length && !a.some(Boolean) && !b.some(Boolean)) out.push(id);
  }
  return out.sort();
}

/** The preservation report for a decision. It never changes the decision. */
export function preservation(sets: { dev: ArmOutcomes; heldOut?: ArmOutcomes }): Preservation {
  const dev = setPreservation(sets.dev);
  const heldOut = sets.heldOut ? setPreservation(sets.heldOut) : undefined;
  const basis = sets.heldOut ? "heldOut" : "dev";
  const regressed = regressedTasks(sets.heldOut ?? sets.dev);
  const lost = (heldOut ?? dev).lost;
  return { dev, ...(heldOut ? { heldOut } : {}), basis, regressed, R: regressed.length, stillFailing: stillFailingTasks(sets.heldOut ?? sets.dev), reasons: lost.length ? [`lost-coverage: ${plural(lost.length, "task")}`] : [] };
}

export interface AlternativeCheck {
  alternative: boolean;
  /** Basis-set gains no kept or applied candidate covers. */
  uniqueGains: string[];
  /** Basis-set hard regressions (base passed every attempt, candidate ≤ 1/3). */
  hardRegressions: string[];
  /** Why it is not an alternative; empty when it is. */
  why: string[];
}

/**
 * Whether a rejected candidate is archived as an `alternative` ("rejected on net
 * score, covers tasks the incumbent never solves"): K1 passed, its gains on the
 * held-out set (dev with none) include a task that no kept or applied candidate
 * covers, and that set has no hard regression. Rerun it after an apply: once an
 * applied candidate covers the tasks it turns back into a plain reject.
 */
export function alternativeCheck(input: { k1: boolean; dev: ArmOutcomes; heldOut?: ArmOutcomes; covered: Iterable<string>; preservation?: Preservation }): AlternativeCheck {
  const p = input.preservation ?? preservation(input);
  const covered = new Set(input.covered);
  const gains = (p.heldOut ?? p.dev).gained;
  const uniqueGains = gains.filter((t) => !covered.has(t));
  const s = input.heldOut ?? input.dev;
  const hard = hardRegressions(s.base, s.cand);
  const why: string[] = [];
  if (!input.k1) why.push("K1 failed");
  if (!uniqueGains.length) why.push(gains.length ? "every gained task is covered by a kept candidate" : "gained no task");
  if (hard.length) why.push(`hard-regression: ${hard.join(", ")}`);
  return { alternative: why.length === 0, uniqueGains, hardRegressions: hard, why };
}

/** One kept candidate, as `rankKeeps` sees it. */
export interface KeepCandidate {
  id: string;
  /** K2 dev effect: the paired bootstrap mean and its 95% interval from exp compare, not adjusted for multiplicity; used only to order and tie keeps. */
  effect: { mean: number; lo: number; hi: number };
  /** R(C) from its preservation report. */
  R: number;
  /** Held-out USD and solved tasks per arm. Leave `usd` undefined when an arm's cost is not fully known. */
  cost?: { base: { usd?: number; solved: number }; cand: { usd?: number; solved: number } };
}

export interface KeepRanking {
  /** Best first. */
  order: string[];
  winner: string;
  /** One line on why the winner beat the runner-up. */
  reason: string;
  /** Other keeps tied with the winner on effect: they stay 'keep', not applied. */
  tied: string[];
  /** "compose with <id>? needs its own trial (K6)" per tied keep. */
  hints: string[];
}

/** Candidate cost per solved held-out task, when both arms' USD is known. */
function costPerSolved(c: KeepCandidate): number | undefined {
  const k = c.cost;
  if (!k || k.base.usd === undefined || k.cand.usd === undefined || !(k.cand.solved > 0)) return undefined;
  return k.cand.usd / k.cand.solved;
}

const overlap = (a: KeepCandidate["effect"], b: KeepCandidate["effect"]): boolean => a.lo <= b.hi && b.lo <= a.hi;
const usd = (x: number): string => `$${x < 0.1 ? x.toFixed(3) : x.toFixed(2)}`;

/** Compares two tied candidates: fewer regressions, then lower cost per solved (both known), then id. */
function tieOrder(a: KeepCandidate, b: KeepCandidate): number {
  if (a.R !== b.R) return a.R - b.R;
  const ca = costPerSolved(a);
  const cb = costPerSolved(b);
  if (ca !== undefined && cb !== undefined && ca !== cb) return ca - cb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function tieReason(w: KeepCandidate, r: KeepCandidate): string {
  if (w.R !== r.R) return `tied on effect; fewer per-task regressions ${w.R} vs ${r.R}`;
  const cw = costPerSolved(w);
  const cr = costPerSolved(r);
  if (cw !== undefined && cr !== undefined && cw !== cr) return `tied on effect and regressions; lower cost per solved task ${usd(cw)} vs ${usd(cr)}`;
  return `tied on effect, regressions${cw !== undefined && cr !== undefined ? " and cost" : ""}; first by id`;
}

/**
 * Orders several keeps from one `refine test`. The largest dev effect leads;
 * every keep whose interval overlaps the leader's is tied with it, and the tie
 * goes to fewer per-task regressions (R), then lower held-out cost per solved
 * task when both candidates have full USD for both arms, then id. Repeats on the
 * rest for the full order. Only the winner is applied; tied keeps get a
 * compose hint, since combining edits needs its own trial (K6).
 */
export function rankKeeps(cands: readonly KeepCandidate[]): KeepRanking {
  if (!cands.length) throw new RangeError("rankKeeps: no candidates");
  const left = [...cands];
  const order: KeepCandidate[] = [];
  let firstTie: KeepCandidate[] | undefined;
  while (left.length) {
    const leader = left.reduce((m, c) => (c.effect.mean > m.effect.mean || (c.effect.mean === m.effect.mean && c.id < m.id) ? c : m));
    const tie = left.filter((c) => overlap(c.effect, leader.effect)).sort(tieOrder);
    firstTie ??= tie;
    const pick = tie[0]!;
    order.push(pick);
    left.splice(left.indexOf(pick), 1);
  }
  const winner = order[0]!;
  const tie = firstTie!;
  const tied = tie.filter((c) => c !== winner).map((c) => c.id);
  let reason: string;
  if (cands.length === 1) reason = "the only keep";
  else if (tie.length > 1) reason = tieReason(winner, tie[1]!);
  else reason = `largest dev effect ${winner.effect.mean.toFixed(2)} vs ${order[1]!.effect.mean.toFixed(2)}, intervals apart`;
  return { order: order.map((c) => c.id), winner: winner.id, reason, tied, hints: tied.map((id) => `compose with ${id}? needs its own trial (K6)`) };
}
