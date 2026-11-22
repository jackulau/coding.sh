// coding.sh sessions [--agent --repo --since --flag --limit --empty] [--where <query>] [--view <name>] [--facets [keys]]
import type { IndexStore, SessionFilter } from "../../core/types.ts";
import { failureFlags, FLAGS, isEmptySession } from "../../core/sessions.ts";
import { facetCounts, findSessions } from "../../query/run.ts";
import { andQuery, FACET_KEYS, scopesSubagents, type Node, type Query } from "../../query/where.ts";
import { parsePlace, placeNode } from "../../mcp/data.ts";
import { userHome } from "../../core/paths.ts";
import { viewQuery } from "../../query/views.ts";
import { viewCliError } from "./views.ts";
import type { Session } from "../../schema/index.ts";
import { parseSinceWhen, positiveInt, UsageError } from "../args.ts";
import { agentScope, agentsFlag, autoIngest, rejectAgentTypos, fieldsFlag, pendingField, pickFields, queryCliError, readIngest, num, oneLine, SESSION_FIELDS, sessionJson, str, timeWindow, whereFlag, windowJson, windowNote, withContext, type IngestBacklog } from "../common.ts";
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

/**
 * --repo on `sessions` and `export`: a path or a repo name, read as `work` and `budget` read it
 * (parsePlace), ANDed onto `where`. A name matches the repo's main checkout and every worktree
 * (`repo:<name>`) and a folder of that name; a path matches sessions at or under it, and a
 * checkout's root or a folder inside a linked worktree stands for the whole repo (`repo:<main root>`).
 */
export function withRepo(where: Query | undefined, repo: string | undefined, c: Pick<CommandContext, "cwd" | "env">, platform: string = process.platform): Query | undefined {
  if (repo === undefined) return where;
  const place = parsePlace(repo, c.cwd, userHome(c.env));
  // Wrapped in a group, as --agent is, so a repo facet keeps it.
  const node = place.name !== undefined && platform === "win32" ? nameNodeAnyCase(place.name) : placeNode(place);
  return node ? andQuery(where ?? {}, { t: "or", items: [node] }) : where;
}

/**
 * A repo name on Windows, where folder names ignore case: `repo:` and the folder name compared
 * without case (a glob value with no wildcard), as `work --repo` compares them (matchesPlace), so
 * DEMO-REPO finds the main checkout's sessions and every worktree's, not only the ones whose
 * folder happens to match. The folder name is matched after either slash.
 */
function nameNodeAnyCase(name: string): Node {
  const cmp = (key: string, parts: string[]): Node => ({ t: "cmp", key, op: ":", values: [{ raw: parts.join("*"), parts, quoted: false, kind: "glob" }], at: 0 });
  return { t: "or", items: [cmp("repo", [name]), cmp("dir", ["", "\\" + name]), cmp("dir", ["", `/${name}`])] };
}

/** "1 of these 5 sessions is flagged", "2 of these 5 sessions are flagged", "This session is flagged". */
/**
 * The query asks for trial sessions (`is:run`, `run:<id>`), so the list keeps them.
 * A negated clause asks to leave them out, which the default already does.
 */
export function scopesRuns(n: Node | undefined, negated = false): boolean {
  if (!n) return false;
  if (n.t === "and" || n.t === "or") return n.items.some((x) => scopesRuns(x, negated));
  if (n.t === "not") return scopesRuns(n.item, !negated);
  if (negated) return false;
  return (n.t === "is" && n.name === "run") || (n.t === "cmp" && n.key === "run");
}

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
  const typed = whereFlag(c);
  const viewName = str(c.flags.view);
  const fields = fieldsFlag(c, SESSION_FIELDS);
  const agents = agentsFlag(c);
  return withContext(c, async (ctx) => {
    // --view: the saved query, AND --where when both are given (each side keeps its OR and negations).
    const where = viewName === undefined ? typed : (await viewQuery(ctx.index, viewName, typed).catch((e) => Promise.reject(viewCliError(e)))).query;
    const window = timeWindow({ since: sinceWhen }, where);
    // Several agents: an `agent:a,b` clause on the query (facets, --where), or one listing per agent.
    const scope = agentScope(agents, where);
    const scoped = withRepo(scope.where, repo, c);
    const backlog = await autoIngest(ctx, readIngest(c));
    const topOnly = !(c.flags.subagents === true || scopesSubagents(where?.root));
    // Trial sessions (eval, compare and exp runs, CODING_SH_RUN_ID) stay out unless asked for.
    const organicOnly = !(c.flags["include-runs"] === true || scopesRuns(where?.root));
    const base: SessionFilter = {
      ...(scope.agent ? { agent: scope.agent } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(str(c.flags.project) ? { project: str(c.flags.project)! } : {}),
      ...(str(c.flags.flag) ? { flag: str(c.flags.flag)! } : {}),
    };
    if (organicOnly) base.runId = null;
    const filter: SessionFilter = topOnly ? { ...base, parentSessionId: null } : base;
    windowNote(out, window);
    const facets = facetKeys(c.flags.facets, ctx.index.queryFacets !== undefined || ctx.index.kind === "memory");
    if (facets && fields) throw new UsageError("--fields picks from the session rows: drop --facets", { reason: "invalid_argument" });
    if (facets) return printFacets(c, await counts(ctx.index, scoped ?? {}, facets, filter, positiveInt(c.flags.limit, "limit") ?? 10), backlog);
    const empty = c.flags.empty === true;
    let listing: Listing;
    if (where || repo !== undefined) listing = await query(ctx.index, scoped ?? {}, filter, positiveInt(c.flags.limit, "limit") ?? where?.limit ?? 20, empty);
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
    if (!sessions.length) await rejectAgentTypos(ctx.index, agents);
    const hiddenChildren = topOnly ? await childCount(ctx.index, scoped, base) : 0;
    const hiddenRuns = organicOnly ? await runCount(ctx.index, scoped, filter) : 0;
    if (out.json) {
      // Rows are a digest; --fields picks from the whole session (stats.phases, each derail's event).
      const rows = fields ? sessions.map((s) => pickFields(sessionJson(s, { derailEvents: true, phases: true }), fields)) : sessions.map((s) => sessionJson(s));
      const doc: Record<string, unknown> = { sessions: rows, total: listing.total };
      if (listing.capped) doc.totalCapped = true;
      if (listing.hidden) doc.hiddenEmpty = listing.hidden;
      if (hiddenChildren) doc.hiddenChildren = hiddenChildren;
      if (hiddenRuns) doc.hiddenRuns = hiddenRuns;
      if (window.since !== undefined || window.until !== undefined) doc.window = windowJson(window);
      out.data({ ...doc, ...pendingField(backlog) });
      return 0;
    }
    const footer = () => {
      if (listing.total > sessions.length) out.note(`${listing.total}${listing.capped ? "+" : ""} matched, ${sessions.length} shown`);
      if (listing.hidden) out.note(`(${plural(listing.hidden, "empty session")} hidden; --empty shows them)`);
    };
    // The last lines: subagent sessions the top-level list left out, and trial sessions.
    const childLine = () => {
      if (hiddenChildren) out.note(`${plural(hiddenChildren, "child session")} not shown (--subagents)`);
      if (hiddenRuns) out.note(`${plural(hiddenRuns, "session")} from eval, compare or exp runs not shown (--include-runs)`);
    };
    if (!sessions.length) {
      out.note("No sessions");
      footer();
      // An empty store (not just an empty filter): say how the first session gets here.
      if (!(await ctx.index.listSessions({ limit: 1 })).length) {
        const n = noSessionsNext(c.env);
        out.next(n.label, n.command);
      }
      childLine();
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
        // "-": the source records model calls only (tools:unseen), so 0 would claim too much.
        s.stats.toolErrors ? `${s.stats.toolCalls} (${s.stats.toolErrors} failed)` : !s.stats.toolCalls && s.flags.includes(FLAGS.toolsUnseen) ? "-" : String(s.stats.toolCalls),
        // Off a TTY the row stays one line a reader can scan; --json keeps the whole title.
        oneLine(clean(s.title ?? ""), tty ? 60 : 100),
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
    childLine();
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

/**
 * Child (subagent) sessions the same filters match, which a top-level list leaves out: one
 * facet query (each session has one agent), empty ones included. 0 when the store can't count them.
 */
async function childCount(index: IndexStore, scoped: Query | undefined, filter: SessionFilter): Promise<number> {
  // The scope in a group, so the agent facet keeps a typed agent: clause.
  const root = andQuery(scoped?.root ? { root: { t: "or", items: [scoped.root] } } : {}, { t: "is", name: "child", at: 0 });
  try {
    const r = await facetCounts(index, root, ["agent"], { filter, limit: 1000 });
    return (r.agent ?? []).reduce((n, x) => n + x.count, 0);
  } catch {
    return 0;
  }
}

/**
 * Trial sessions (a run id: eval, compare, exp) the same filters match, which the list leaves out:
 * one facet query, as childCount. 0 when the store can't count them.
 */
async function runCount(index: IndexStore, scoped: Query | undefined, filter: SessionFilter): Promise<number> {
  const { runId: _organic, ...rest } = filter;
  const root = andQuery(scoped?.root ? { root: { t: "or", items: [scoped.root] } } : {}, { t: "is", name: "run", at: 0 });
  try {
    const r = await facetCounts(index, root, ["agent"], { filter: rest, limit: 1000 });
    return (r.agent ?? []).reduce((n, x) => n + x.count, 0);
  } catch {
    return 0;
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
