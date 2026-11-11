// coding.sh sessions [--agent --repo --since --flag --limit --empty] [--where <query>] [--facets [keys]]
import { resolve } from "node:path";
import type { IndexStore, SessionFilter } from "../../core/types.ts";
import { failureFlags, isEmptySession } from "../../core/sessions.ts";
import { facetCounts, findSessions } from "../../query/run.ts";
import { FACET_KEYS, scopesSubagents, type Query } from "../../query/where.ts";
import type { Session } from "../../schema/index.ts";
import { parseSinceWhen, positiveInt, UsageError } from "../args.ts";
import { agentScope, agentsFlag, autoIngest, fieldsFlag, pendingField, pickFields, queryCliError, readIngest, num, oneLine, SESSION_FIELDS, sessionJson, str, timeWindow, whereFlag, windowJson, windowNote, withContext, type IngestBacklog } from "../common.ts";
import { ago, clean, duration, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { noSessionsNext } from "../first-session.ts";

/** `--facets` alone counts these (tool only where the store indexes events). */
const DEFAULT_FACETS = ["agent", "model", "repo", "flag", "skill", "tool"];

/** `--facets agent,model`: the keys, checked against the facet keys. */
function facetKeys(v: unknown, eventIndex: boolean): string[] | undefined {
  if (v === undefined || v === false) return undefined;
  if (v === true) return DEFAULT_FACETS.filter((k) => eventIndex || k !== "tool");
  const keys = String(v).split(",").map((k) => k.trim()).filter(Boolean);
  const bad = keys.filter((k) => !FACET_KEYS.includes(k));
  if (bad.length || !keys.length) throw new UsageError(`--facets: can't count ${bad.join(", ") || "nothing"}; use ${FACET_KEYS.join(", ")}`, { reason: "bad_flag" });
  return keys;
}

/** "1 of these 5 sessions is flagged", "2 of these 5 sessions are flagged", "This session is flagged". */
export function flaggedText(flagged: number, total: number): string {
  if (total === 1) return "This session is flagged";
  return `${flagged} of these ${total} sessions ${flagged === 1 ? "is" : "are"} flagged`;
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const limit = positiveInt(c.flags.limit, "limit") ?? num(c.flags.limit) ?? 20;
  const sinceWhen = str(c.flags.since) !== undefined ? parseSinceWhen(str(c.flags.since)!) : undefined;
  const since = sinceWhen?.ms;
  const repo = str(c.flags.repo);
  const where = whereFlag(c);
  const window = timeWindow({ since: sinceWhen }, where);
  const fields = fieldsFlag(c, SESSION_FIELDS);
  const agents = agentsFlag(c);
  // Several agents: an `agent:a,b` clause on the query (facets, --where), or one listing per agent.
  const scope = agentScope(agents, where);
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const filter: SessionFilter = {
      ...(scope.agent ? { agent: scope.agent } : {}),
      ...(repo ? { repoRoot: resolve(c.cwd, repo) } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(c.flags.subagents === true || scopesSubagents(where?.root) ? {} : { parentSessionId: null }),
      ...(str(c.flags.project) ? { project: str(c.flags.project)! } : {}),
      ...(str(c.flags.flag) ? { flag: str(c.flags.flag)! } : {}),
    };
    windowNote(out, window);
    const facets = facetKeys(c.flags.facets, ctx.index.queryFacets !== undefined || ctx.index.kind === "memory");
    if (facets && fields) throw new UsageError("--fields picks from the session rows: drop --facets", { reason: "invalid_argument" });
    if (facets) return printFacets(c, await counts(ctx.index, scope.where ?? {}, facets, filter, positiveInt(c.flags.limit, "limit") ?? 10), backlog);
    const empty = c.flags.empty === true;
    let listing: Listing;
    if (where) listing = await query(ctx.index, scope.where!, filter, positiveInt(c.flags.limit, "limit") ?? where.limit ?? 20, empty);
    else if (agents.length > 1) {
      const each = await Promise.all(agents.map((agent) => listPlain(ctx.index, { ...filter, agent }, limit, empty)));
      listing = {
        sessions: each.flatMap((l) => l.sessions).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit),
        total: each.reduce((n, l) => n + l.total, 0),
        capped: each.some((l) => l.capped),
        hidden: each.reduce((n, l) => n + l.hidden, 0),
      };
    } else listing = await listPlain(ctx.index, filter, limit, empty);
    const { sessions } = listing;
    if (out.json) {
      // Rows are a digest; --fields picks from the whole session (stats.phases, each derail's event).
      const rows = fields ? sessions.map((s) => pickFields(sessionJson(s, { derailEvents: true, phases: true }), fields)) : sessions.map((s) => sessionJson(s));
      const doc: Record<string, unknown> = { sessions: rows, total: listing.total };
      if (listing.capped) doc.totalCapped = true;
      if (listing.hidden) doc.hiddenEmpty = listing.hidden;
      if (window.since !== undefined || window.until !== undefined) doc.window = windowJson(window);
      out.data({ ...doc, ...pendingField(backlog) });
      return 0;
    }
    const footer = () => {
      if (listing.total > sessions.length) out.note(`${listing.total}${listing.capped ? "+" : ""} matched, ${sessions.length} shown`);
      if (listing.hidden) out.note(`(${plural(listing.hidden, "empty session")} hidden; --empty shows them)`);
    };
    if (!sessions.length) {
      out.note("No sessions");
      footer();
      // An empty store (not just an empty filter): say how the first session gets here.
      if (!(await ctx.index.listSessions({ limit: 1 })).length) {
        const n = noSessionsNext(c.env);
        out.next(n.label, n.command);
      }
      return 0;
    }
    const tty = out.stdoutTTY;
    out.table(
      ["ID", "AGENT", "STARTED", "DURATION", "TURNS", "TOOLS", "TITLE"],
      sessions.map((s) => [
        s.id,
        s.agent,
        ago(s.startedAt),
        s.endedAt !== undefined ? duration(s.endedAt - s.startedAt) : "-",
        String(s.stats.turns),
        s.stats.toolErrors ? `${s.stats.toolCalls} (${s.stats.toolErrors} failed)` : String(s.stats.toolCalls),
        tty ? oneLine(clean(s.title ?? ""), 60) : clean(s.title ?? "").replace(/[\t\n]+/g, " "),
      ]),
    );
    footer();
    const byFlag = new Map<string, number>();
    for (const s of sessions) for (const f of new Set(failureFlags(s.flags))) byFlag.set(f, (byFlag.get(f) ?? 0) + 1);
    if (byFlag.size) {
      const flagged = sessions.filter((s) => failureFlags(s.flags).length).length;
      const top = [...byFlag].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${f} ${n}`).join(", ");
      out.next(`${flaggedText(flagged, sessions.length)} (${top}). See what to fix first and the line that fixes it`, "coding.sh improve");
    }
    return 0;
  }, { create: false });
}

/** The rows a listing kept, and what the filter matched beyond them. */
interface Listing {
  sessions: Session[];
  /** Sessions the filter matched, empty ones left out (a lower bound when `capped`). */
  total: number;
  capped: boolean;
  /** Empty sessions the filter matched and the list left out. */
  hidden: number;
}

/** Rows read to count matches past the page; more than this and the count is "N+". */
const COUNT_CAP = 10000;

/** Keep the first `limit` of `rows` that are not empty (unless `empty`), counting the rest. */
function keep(rows: Session[], limit: number, empty: boolean, into: Listing): void {
  for (const s of rows) {
    if (!empty && isEmptySession(s)) into.hidden++;
    else {
      into.total++;
      if (into.sessions.length < limit) into.sessions.push(s);
    }
  }
}

/** The newest `limit` sessions the filter keeps; empty ones left out unless `empty`. */
async function listPlain(index: IndexStore, filter: SessionFilter, limit: number, empty: boolean): Promise<Listing> {
  const l: Listing = { sessions: [], total: 0, capped: false, hidden: 0 };
  // Empty sessions are left out after the store's page, so read pages until every match is counted.
  // The first page is small (most lists end there); counting the rest reads big pages.
  let offset = 0;
  for (let page = Math.max(limit * 2, 50); ; page = 1000) {
    if (offset >= COUNT_CAP) {
      l.capped = true;
      break;
    }
    const got = await index.listSessions({ ...filter, limit: page, offset });
    keep(got, limit, empty, l);
    offset += page;
    if (got.length < page) break;
  }
  return l;
}

async function query(index: IndexStore, q: Query, filter: SessionFilter, limit: number, empty: boolean): Promise<Listing> {
  try {
    const r = await findSessions(index, q, { filter, limit: COUNT_CAP });
    if (r.truncated) process.stderr.write("Scanned the newest sessions only; narrow with --since\n");
    const l: Listing = { sessions: [], total: 0, capped: r.sessions.length >= COUNT_CAP || r.truncated === true, hidden: 0 };
    keep(r.sessions, limit, empty, l);
    return l;
  } catch (e) {
    throw queryCliError(e);
  }
}

async function counts(index: IndexStore, q: Query, keys: string[], filter: SessionFilter, limit: number): Promise<Record<string, { value: string; count: number }[]>> {
  try {
    return await facetCounts(index, q, keys, { filter, limit });
  } catch (e) {
    throw queryCliError(e);
  }
}

function printFacets(c: CommandContext, facets: Record<string, { value: string; count: number }[]>, backlog: IngestBacklog): number {
  const { out } = c;
  if (out.json) {
    out.data({ facets, ...pendingField(backlog) });
    return 0;
  }
  let first = true;
  for (const [key, rows] of Object.entries(facets)) {
    if (!first) process.stdout.write("\n");
    first = false;
    out.table([key.toUpperCase(), "SESSIONS"], rows.length ? rows.map((r) => [clean(r.value), String(r.count)]) : [["(none)", "0"]]);
  }
  return 0;
}
