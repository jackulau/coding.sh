// coding.sh stats --scorecard [--by model|agent] [--since 30d] [--until ...] [--where q] [--json]
//
// The model scorecard: the window's sessions in one column per model (or agent) and one row per
// measure, each with the counts it read and a 95% interval. core/scorecard.ts adds them up from what
// the fold keeps per session. With exactly two columns a DIFFERENCE column gives the second minus
// the first. stats.ts runs it once the store is open and the backlog ingested.
import type { Context } from "../../core/context.ts";
import { PUSHBACK_KINDS } from "../../core/pushback.ts";
import { scorecardOf, type Scorecard, type ScorecardBy, type ScorecardDiff, type ScorecardDuration, type ScorecardGroup, type ScorecardLeftOut, type ScorecardRate } from "../../core/scorecard.ts";
import { matchesSession } from "../../query/match.ts";
import { findSessions, QUERY_SCAN_CAP } from "../../query/run.ts";
import { andQuery, parseWhere, printWhere, type Query } from "../../query/where.ts";
import type { Session } from "../../schema/index.ts";
import { NONE } from "../../viewer/metrics.ts";
import { UsageError } from "../args.ts";
import { pendingField, queryCliError, str, windowJson, windowNote, type IngestBacklog, type TimeWindow } from "../common.ts";
import { noSessionsNext } from "../first-session.ts";
import { cliCommand } from "../next-steps.ts";
import { duration, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** --scorecard's columns: --by model (the default) or agent. --measure and --per have no meaning here. */
export function scorecardBy(c: CommandContext): ScorecardBy {
  for (const f of ["measure", "per"]) if (c.flags[f] !== undefined) throw new UsageError(`--${f} does not work with --scorecard`, { reason: "invalid_argument" });
  const by = str(c.flags.by) ?? "model";
  if (by !== "model" && by !== "agent") throw new UsageError(`--scorecard has a column per model or per agent: --by ${by} does not work with it`, { reason: "invalid_argument" });
  return by;
}

export interface ScorecardRead {
  by: ScorecardBy;
  since: number;
  until: number;
  where: Query | undefined;
  window: TimeWindow;
  backlog: IngestBacklog;
}

export async function runScorecard(c: CommandContext, ctx: Context, o: ScorecardRead): Promise<number> {
  const { out } = c;
  let found;
  try {
    found = await findSessions(ctx.index, o.where ?? {}, { filter: { since: o.since, until: o.until } });
  } catch (e) {
    throw queryCliError(e);
  }
  const card = scorecardOf(found.sessions, o.by);
  if (out.json) {
    const doc: Scorecard & { truncated?: true } = { ...card };
    if (found.truncated) doc.truncated = true;
    out.data({ ...doc, window: windowJson(o.window), ...pendingField(o.backlog) });
    return 0;
  }
  windowNote(out, o.window);
  const span = `from ${day(o.since)} to ${day(o.until)}${o.where ? " matching the query" : ""}`;
  const base = o.by === "agent" ? ["stats", "--scorecard", "--by", "agent"] : ["stats", "--scorecard"];
  const again = (...more: string[]) => cliCommand(c.env, [...base, ...more]);
  if (!card.sessions) {
    out.note(`No sessions ${span}`);
    if (!(await ctx.index.listSessions({ limit: 1 })).length) {
      // An empty store, not just an empty window: say how the first session gets here.
      const n = noSessionsNext(c.env);
      out.next(n.label, n.command);
    } else if (o.where) out.next("Drop --where to see every session in the window, or widen it", again("--since", "90d"));
    else out.next("Widen the window", again("--since", "90d"));
    return 0;
  }
  if (!card.groups.length) {
    out.note(card.sessions === 1 ? `The one session ${span} has no turn, file edit or shell command to count.` : `None of the ${card.sessions} sessions ${span} has a turn, a file edit or a shell command to count.`);
    out.note(scopeNote(card));
    return 0;
  }
  const headers = ["MEASURE", ...card.groups.map((g) => g.key || NONE)];
  if (card.difference) headers.push("DIFFERENCE");
  // Every column stays whole: a cut count or interval reads as another number.
  out.table(headers, scorecardRows(card), { keep: headers, collapse: [] });
  const noun = o.by === "model" ? "models" : "agents";
  if (card.difference) out.note(`DIFFERENCE is ${card.difference.b || NONE} minus ${card.difference.a || NONE}: percentage points for a rate, time for the median. Where its 95% interval includes 0 it says no clear difference.`);
  out.note(scopeNote(card));
  const notRecorded = cancelLeftOut(card.groups);
  if (notRecorded) out.note(notRecorded);
  out.note("The intervals treat each turn and each call as independent. Turns of one session are alike, so the real uncertainty is larger.");
  if (card.groups.length > 1) out.note(`The ${noun} did different tasks, so a difference can come from the task mix. coding.sh compare runs two of them on the same tasks: https://coding.sh/docs/how-to/compare-models`);
  if (found.truncated) out.warn(`Stopped after ${QUERY_SCAN_CAP.toLocaleString("en-US")} sessions: narrow --since or --where.`);
  const firstTwo = firstTwoWhere(card, found.sessions, o);
  if (firstTwo) {
    // The person's window, as they typed it.
    const bounds = ["since", "until"].flatMap((f) => (str(c.flags[f]) === undefined ? [] : [`--${f}`, str(c.flags[f])!]));
    out.next("Compare the first two columns, with a DIFFERENCE column", again(...bounds, "--where", firstTwo));
  }
  return 0;
}

/**
 * With three or more columns: the person's query AND `by:a OR by:b`, a and b the first two
 * columns. Only when it leaves just those two. `model:` matches a session's main model, so a turn
 * another model ran in one of those sessions keeps its own column, and the command would print
 * three columns again.
 */
function firstTwoWhere(card: Scorecard, sessions: readonly Session[], o: ScorecardRead): string | undefined {
  const [a, b] = card.groups;
  if (card.groups.length < 3 || ![a!.key, b!.key].every((k) => /^[\w.:/@+-]+$/.test(k))) return undefined;
  const pair = parseWhere(`${o.by}:${a!.key} OR ${o.by}:${b!.key}`);
  // Session keys only, so the match needs no events.
  if (scorecardOf(sessions.filter((s) => matchesSession(pair.root, s, () => [])), o.by).groups.length !== 2) return undefined;
  return printWhere(andQuery(o.where ?? {}, pair.root));
}

/** The table's rows: a measure's row, then its interval and the sessions it read. A measure no column has is left out. */
export function scorecardRows(card: Scorecard): string[][] {
  const { groups, difference: d } = card;
  const rows: string[][] = [];
  const row = (label: string, cell: (g: ScorecardGroup) => string, diff = "") => {
    const r = [label, ...groups.map(cell)];
    if (d) r.push(diff);
    rows.push(r);
  };
  const any = (has: (g: ScorecardGroup) => unknown) => groups.some(has);
  const rateRows = (label: string, r: (g: ScorecardGroup) => ScorecardRate | undefined, diff: ScorecardDiff | undefined, sessions = true) => {
    row(label, (g) => rateCell(r(g)) ?? "-", diffCell(diff, ppPoint));
    row("  95% CI", (g) => rateCi(r(g)), diffCi(diff, pp, "pp"));
    if (sessions) row("  sessions", (g) => String(r(g)?.sessions ?? ""));
  };
  if (any((g) => g.turns)) {
    row("Turns", (g) => String(g.turns?.n ?? "-"));
    row("  sessions", (g) => String(g.turns?.sessions ?? ""));
  }
  if (any((g) => g.pushback)) {
    rateRows("Pushback", (g) => g.pushback, d?.pushback);
    for (const kind of PUSHBACK_KINDS) rateRows(`Pushback: ${kind}`, (g) => g.pushback?.byKind[kind], d?.pushbackByKind?.[kind], false);
  }
  if (any((g) => g.cancelled || g.cancelNotRecorded)) {
    row("Cancelled turns", (g) => rateCell(g.cancelled) ?? (g.cancelNotRecorded ? "not recorded" : "-"), diffCell(d?.cancelled, ppPoint));
    row("  95% CI", (g) => rateCi(g.cancelled), diffCi(d?.cancelled, pp, "pp"));
    row("  sessions", (g) => String(g.cancelled?.sessions ?? ""));
  }
  if (any((g) => g.duration)) {
    row("Median turn", (g) => (g.duration ? `${duration(g.duration.medianMs)} (${g.duration.n})` : "-"), diffCell(d?.durationMs, signedDuration));
    row("  95% CI", (g) => durationCi(g.duration), diffCi(d?.durationMs, signedDuration, ""));
    row("  quartiles", (g) => (g.duration ? `${duration(g.duration.p25Ms)} to ${duration(g.duration.p75Ms)}` : ""));
    row("  sessions", (g) => String(g.duration?.sessions ?? ""));
  }
  if (any((g) => g.edits)) rateRows("Failed file edits", (g) => g.edits, d?.edits);
  if (any((g) => g.shells)) rateRows("Failed shell commands", (g) => g.shells, d?.shells);
  return rows;
}

/** What each kind of row read, and the sessions the turn rows left out. */
function scopeNote(card: Scorecard): string {
  const left = leftOutParts(card.turnsLeftOut);
  const turns = card.turnSessions
    ? `Turn rows count the ${plural(card.turnSessions, "top-level session")} launched interactively${left.length ? `, not ${join(left)}` : ""}.`
    : `No top-level session was launched interactively, so there are no turn rows${left.length ? `: the window has ${join(left)}` : ""}.`;
  const n = card.sessions;
  const calls = n === 1 ? "the one session, under its own" : `${n === 2 ? "both sessions" : `all ${n} sessions`}, each under its own`;
  return `${turns} Edit and shell rows count the calls of ${calls} ${card.by}.`;
}

function leftOutParts(l: ScorecardLeftOut): string[] {
  const parts: string[] = [];
  if (l.subagent) parts.push(plural(l.subagent, "subagent session"));
  if (l.headless) parts.push(plural(l.headless, "headless session"));
  const unknown = Object.entries(l.launchUnknown ?? {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  const one = unknown.length === 1 && unknown[0]![1] === 1;
  if (unknown.length) parts.push(`${join(unknown.map(([agent, n]) => `${n} ${agent}`))} ${one ? "session whose capture does not say how it was launched" : "sessions whose captures do not say how they were launched"}`);
  return parts;
}

/** The cancelled row's coverage, when a column counted turns whose capture does not record a stopped turn. */
function cancelLeftOut(groups: readonly ScorecardGroup[]): string | undefined {
  const turns = new Map<string, number>();
  for (const g of groups) for (const [agent, n] of Object.entries(g.cancelNotRecorded ?? {})) turns.set(agent, (turns.get(agent) ?? 0) + n);
  if (!turns.size) return undefined;
  const parts = [...turns].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([agent, n]) => `${plural(n, "turn")} of ${agent}`);
  return `Cancelled turns leave out ${join(parts)}: those captures do not record a turn the person stopped.`;
}

const join = (xs: readonly string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const percent = (x: number) => `${(x * 100).toFixed(1)}%`;
const rateCell = (r: ScorecardRate | undefined) => (r ? `${percent(r.rate)} (${r.k}/${r.n})` : undefined);
const rateCi = (r: ScorecardRate | undefined) => (r ? `${percent(r.lo)} to ${percent(r.hi)}` : "");
/** Percentage points with a sign, to a tenth: rounded first, so a difference that rounds to 0 prints +0.0. */
const pp = (x: number) => {
  const v = Math.round(x * 1000) / 10;
  return `${v < 0 ? "-" : "+"}${Math.abs(v).toFixed(1)}`;
};
const ppPoint = (x: number) => `${pp(x)}pp`;
const signedDuration = (ms: number) => `${ms < 0 ? "-" : "+"}${duration(Math.abs(ms))}`;
const durationCi = (d: ScorecardDuration | undefined) => (!d ? "" : d.loMs === undefined ? "too few turns" : `${duration(d.loMs)} to ${duration(d.hiMs)}`);
/** A difference: the value when its interval leaves out 0, else "no clear difference". */
const diffCell = (d: ScorecardDiff | undefined, fmt: (x: number) => string) => (!d ? "" : d.clear ? fmt(d.d) : "no clear difference");
const diffCi = (d: ScorecardDiff | undefined, fmt: (x: number) => string, unit: string) => (!d ? "" : d.lo === undefined || d.hi === undefined ? "too few turns" : `${fmt(d.lo)} to ${fmt(d.hi)}${unit}`);

/** A local day, as stats labels its rows. */
function day(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
