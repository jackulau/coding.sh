// The model scorecard (`coding.sh stats --scorecard`): the window's sessions side by side, one group
// per model or per agent, each row with its counts and a 95% interval. It adds up what the fold keeps
// per session (Session.stats.turnsByModel, edits and shells, core/turn-stats.ts) and reads no events.
//
// - Turn rows (turns, pushback, cancelled, duration) count the turns of top-level sessions launched
//   interactively, the only sessions with turnsByModel: a headless prompt is no person's reaction,
//   and a subagent's prompt comes from its parent. By model, a turn counts under the model that ran
//   it; by agent, under its session's agent.
// - Cancelled counts only the sessions of agents whose captures record a stopped turn
//   (CANCEL_AGENTS). A group with no such session has no cancelled row: "not recorded", never 0.
// - Tool rows (failed file edits, failed shell commands) count every session's calls, subagents and
//   headless runs included, under that session's own model (Session.model) or agent.
// - A rate is k of n with its Wilson 95% interval, and the median turn duration has the
//   order-statistic interval (medianInterval). With exactly two groups each row also has the second
//   group minus the first: newcombeDiff for a rate, intervalDiff of the two medians' intervals for
//   the duration. A difference whose interval includes 0 is not clear.
// The intervals treat each turn and each call as independent. Turns of one session are alike, so
// the real uncertainty is larger than they show.
import type { PushbackKind, Session, TurnTally } from "../schema/index.ts";
import { intervalDiff, medianInterval, newcombeDiff, wilson, type Interval } from "../stats/interval.ts";
import { quantileSorted } from "../stats/summary.ts";
import { PUSHBACK_KINDS } from "./pushback.ts";
import { CANCEL_AGENTS } from "./turn-stats.ts";

export type ScorecardBy = "model" | "agent";

/** k of n, the sessions n came from, and k/n with its Wilson 95% interval. */
export interface ScorecardRate {
  k: number;
  n: number;
  sessions: number;
  rate: number;
  lo: number;
  hi: number;
}

/** Turn durations (ms): how many and from how many sessions, the median with its 95% interval, and the quartiles. */
export interface ScorecardDuration {
  n: number;
  sessions: number;
  medianMs: number;
  /** The median's 95% interval. Absent below 6 turns, where order statistics give none. */
  loMs?: number;
  hiMs?: number;
  p25Ms: number;
  p75Ms: number;
}

/** One column: a model ("" for sessions that name none) or an agent. Each row is absent when the group has nothing to count in it. */
export interface ScorecardGroup {
  key: string;
  /** The turns the group ran, and the sessions they came from. */
  turns?: { n: number; sessions: number };
  /** Of the turns the person answered with a prompt, the ones that prompt pushed back on; byKind splits them, each out of the same turns. */
  pushback?: ScorecardRate & { byKind: Record<PushbackKind, ScorecardRate> };
  /** Turns the person stopped, out of the turns of sessions whose agent records it. */
  cancelled?: ScorecardRate;
  /** Turns left out of cancelled, by agent: their captures do not record a stopped turn. */
  cancelNotRecorded?: Record<string, number>;
  duration?: ScorecardDuration;
  /** File-edit calls that failed for real, out of the file-edit calls that ended. */
  edits?: ScorecardRate;
  /** Shell calls that failed for real, out of the shell calls that ended. */
  shells?: ScorecardRate;
}

/** The second group minus the first on one row. `clear` is false when the 95% interval includes 0, or when there is none. */
export interface ScorecardDiff {
  d: number;
  lo?: number;
  hi?: number;
  clear: boolean;
}

/** With exactly two groups: b minus a, row by row, on each row both groups have. Rates in proportions, the duration in ms. */
export interface ScorecardDifference {
  a: string;
  b: string;
  pushback?: ScorecardDiff;
  pushbackByKind?: Partial<Record<PushbackKind, ScorecardDiff>>;
  cancelled?: ScorecardDiff;
  durationMs?: ScorecardDiff;
  edits?: ScorecardDiff;
  shells?: ScorecardDiff;
}

/** Sessions that count in no turn row, by why. Absent fields are 0. */
export interface ScorecardLeftOut {
  subagent?: number;
  headless?: number;
  /** By agent: sessions whose capture does not say how the agent was launched. */
  launchUnknown?: Record<string, number>;
}

export interface Scorecard {
  by: ScorecardBy;
  /** The sessions read: every one in the window that matches the query. */
  sessions: number;
  /** The top-level sessions launched interactively the turn rows read. */
  turnSessions: number;
  /** Most turns first, then most edit and shell calls, then by key. */
  groups: ScorecardGroup[];
  difference?: ScorecardDifference;
  turnsLeftOut: ScorecardLeftOut;
}

interface Calls {
  calls: number;
  failed: number;
  sessions: number;
}

interface Acc {
  turns: number;
  turnSessions: number;
  replied: number;
  repliedSessions: number;
  pushback: Record<PushbackKind, number>;
  cancelTurns: number;
  cancelled: number;
  cancelSessions: number;
  notRecorded: Map<string, number>;
  durations: number[];
  durationSessions: number;
  edits: Calls;
  shells: Calls;
}

const noCalls = (): Calls => ({ calls: 0, failed: 0, sessions: 0 });
const noAcc = (): Acc => ({
  turns: 0,
  turnSessions: 0,
  replied: 0,
  repliedSessions: 0,
  pushback: { intent: 0, undo: 0, redo: 0, broken: 0 },
  cancelTurns: 0,
  cancelled: 0,
  cancelSessions: 0,
  notRecorded: new Map(),
  durations: [],
  durationSessions: 0,
  edits: noCalls(),
  shells: noCalls(),
});

/** One session's turns under one group: its models' tallies added up (by agent, a session's models share a group). */
interface SessionTurns {
  turns: number;
  replied: number;
  pushback: Record<PushbackKind, number>;
  cancelled: number;
  durations: number[];
}

function addTally(to: SessionTurns, t: TurnTally): void {
  to.turns += t.turns;
  to.replied += t.replied ?? 0;
  to.cancelled += t.cancelled ?? 0;
  for (const kind of PUSHBACK_KINDS) to.pushback[kind] += t.pushback?.[kind] ?? 0;
  if (t.durationsMs) for (const d of t.durationsMs) to.durations.push(d);
}

/** k of n with its Wilson interval. At 0 of n the low end is 0 and at n of n the high end is 1, where the formula can be off by a rounding error (1e-17). */
const rateOf = (k: number, n: number, sessions: number): ScorecardRate => {
  const w = wilson(k, n);
  return { k, n, sessions, rate: w.p, lo: k === 0 ? 0 : w.lo, hi: k === n ? 1 : w.hi };
};

/** A subagent, as sessionOf (core/sessions.ts) tells one: a parent that is not a provider switch. */
const isSubagent = (s: Session): boolean => !!s.parent && s.parent.type !== "provider-switch";

/** The scorecard of the sessions read, grouped by model or agent. */
export function scorecardOf(sessions: readonly Session[], by: ScorecardBy): Scorecard {
  const accs = new Map<string, Acc>();
  const acc = (key: string): Acc => {
    let a = accs.get(key);
    if (!a) accs.set(key, (a = noAcc()));
    return a;
  };
  const left: ScorecardLeftOut = {};
  let turnSessions = 0;
  for (const s of sessions) {
    const own = by === "model" ? (s.model ?? "") : s.agent;
    for (const [kind, tally] of [["edits", s.stats.edits], ["shells", s.stats.shells]] as const) {
      if (!tally?.calls) continue;
      const c = acc(own)[kind];
      c.calls += tally.calls;
      c.failed += tally.failed ?? 0;
      c.sessions++;
    }
    const byModel = s.stats.turnsByModel;
    if (!byModel) {
      if (isSubagent(s)) left.subagent = (left.subagent ?? 0) + 1;
      else if (s.stats.launch === "headless") left.headless = (left.headless ?? 0) + 1;
      else if (s.stats.launch === undefined) (left.launchUnknown ??= {})[s.agent] = (left.launchUnknown[s.agent] ?? 0) + 1;
      continue;
    }
    turnSessions++;
    const mine = new Map<string, SessionTurns>();
    for (const [model, t] of Object.entries(byModel)) {
      const key = by === "model" ? model : s.agent;
      let to = mine.get(key);
      if (!to) mine.set(key, (to = { turns: 0, replied: 0, pushback: { intent: 0, undo: 0, redo: 0, broken: 0 }, cancelled: 0, durations: [] }));
      addTally(to, t);
    }
    const records = CANCEL_AGENTS.has(s.agent);
    for (const [key, t] of mine) {
      if (!t.turns) continue;
      const a = acc(key);
      a.turns += t.turns;
      a.turnSessions++;
      if (t.replied) {
        a.replied += t.replied;
        a.repliedSessions++;
        for (const kind of PUSHBACK_KINDS) a.pushback[kind] += t.pushback[kind];
      }
      if (records) {
        a.cancelTurns += t.turns;
        a.cancelled += t.cancelled;
        a.cancelSessions++;
      } else a.notRecorded.set(s.agent, (a.notRecorded.get(s.agent) ?? 0) + t.turns);
      if (t.durations.length) {
        for (const d of t.durations) a.durations.push(d);
        a.durationSessions++;
      }
    }
  }
  const groups = [...accs].map(([key, a]) => groupOf(key, a));
  const calls = (g: ScorecardGroup) => (g.edits?.n ?? 0) + (g.shells?.n ?? 0);
  groups.sort((x, y) => (y.turns?.n ?? 0) - (x.turns?.n ?? 0) || calls(y) - calls(x) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const card: Scorecard = { by, sessions: sessions.length, turnSessions, groups, turnsLeftOut: left };
  if (groups.length === 2) card.difference = differenceOf(groups[0]!, groups[1]!);
  return card;
}

function groupOf(key: string, a: Acc): ScorecardGroup {
  const g: ScorecardGroup = { key };
  if (a.turns) g.turns = { n: a.turns, sessions: a.turnSessions };
  if (a.replied) {
    const byKind = {} as Record<PushbackKind, ScorecardRate>;
    let any = 0;
    for (const kind of PUSHBACK_KINDS) {
      byKind[kind] = rateOf(a.pushback[kind], a.replied, a.repliedSessions);
      any += a.pushback[kind];
    }
    g.pushback = { ...rateOf(any, a.replied, a.repliedSessions), byKind };
  }
  if (a.cancelTurns) g.cancelled = rateOf(a.cancelled, a.cancelTurns, a.cancelSessions);
  if (a.notRecorded.size) g.cancelNotRecorded = Object.fromEntries([...a.notRecorded].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  if (a.durations.length) {
    const sorted = Array.from(Float64Array.from(a.durations).sort());
    const m = medianInterval(sorted);
    const d: ScorecardDuration = { n: sorted.length, sessions: a.durationSessions, medianMs: m.p, p25Ms: quantileSorted(sorted, 0.25), p75Ms: quantileSorted(sorted, 0.75) };
    if (Number.isFinite(m.lo) && Number.isFinite(m.hi)) {
      d.loMs = m.lo;
      d.hiMs = m.hi;
    }
    g.duration = d;
  }
  for (const kind of ["edits", "shells"] as const) {
    const c = a[kind];
    if (c.calls) g[kind] = rateOf(c.failed, c.calls, c.sessions);
  }
  return g;
}

function diffOf(i: Interval): ScorecardDiff {
  const out: ScorecardDiff = { d: i.p, clear: false };
  if (Number.isFinite(i.lo) && Number.isFinite(i.hi)) {
    out.lo = i.lo;
    out.hi = i.hi;
    out.clear = i.lo > 0 || i.hi < 0;
  }
  return out;
}

const rateDiff = (a: ScorecardRate, b: ScorecardRate): ScorecardDiff => diffOf(newcombeDiff(a.k, a.n, b.k, b.n));

/** A group's median with its interval, unbounded where it has none. */
const medianOf = (d: ScorecardDuration): Interval => ({ p: d.medianMs, lo: d.loMs ?? -Infinity, hi: d.hiMs ?? Infinity });

function differenceOf(a: ScorecardGroup, b: ScorecardGroup): ScorecardDifference {
  const out: ScorecardDifference = { a: a.key, b: b.key };
  if (a.pushback && b.pushback) {
    out.pushback = rateDiff(a.pushback, b.pushback);
    const byKind: Partial<Record<PushbackKind, ScorecardDiff>> = {};
    for (const kind of PUSHBACK_KINDS) byKind[kind] = rateDiff(a.pushback.byKind[kind], b.pushback.byKind[kind]);
    out.pushbackByKind = byKind;
  }
  if (a.cancelled && b.cancelled) out.cancelled = rateDiff(a.cancelled, b.cancelled);
  if (a.duration && b.duration) out.durationMs = diffOf(intervalDiff(medianOf(a.duration), medianOf(b.duration)));
  if (a.edits && b.edits) out.edits = rateDiff(a.edits, b.edits);
  if (a.shells && b.shells) out.shells = rateDiff(a.shells, b.shells);
  return out;
}
