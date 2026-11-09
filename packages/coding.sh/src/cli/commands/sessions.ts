// coding.sh sessions [--agent --repo --since --flag --limit --empty] [--where <query>] [--facets [keys]]
import { resolve } from "node:path";
import type { IndexStore, SessionFilter } from "../../core/types.ts";
import { failureFlags, isEmptySession } from "../../core/sessions.ts";
import { facetCounts, findSessions } from "../../query/run.ts";
import { FACET_KEYS, scopesSubagents, type Query } from "../../query/where.ts";
import type { Session } from "../../schema/index.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { agentScope, agentsFlag, autoIngest, pendingField, queryCliError, readIngest, num, oneLine, sessionJson, str, whereFlag, withContext, type IngestBacklog } from "../common.ts";
import { ago, clean, duration } from "../output.ts";
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

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const limit = positiveInt(c.flags.limit, "limit") ?? num(c.flags.limit) ?? 20;
  const since = str(c.flags.since) !== undefined ? parseSince(str(c.flags.since)!) : undefined;
  const repo = str(c.flags.repo);
  const where = whereFlag(c);
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
    const facets = facetKeys(c.flags.facets, ctx.index.queryFacets !== undefined || ctx.index.kind === "memory");
    if (facets) return printFacets(c, await counts(ctx.index, scope.where ?? {}, facets, filter, positiveInt(c.flags.limit, "limit") ?? 10), backlog);
    let sessions: Session[];
    if (where) sessions = await query(ctx.index, scope.where!, filter, positiveInt(c.flags.limit, "limit") ?? where.limit ?? 20);
    else if (agents.length > 1) {
      const each = await Promise.all(agents.map((agent) => listPlain(ctx.index, { ...filter, agent }, limit, c.flags.empty === true)));
      sessions = each.flat().sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
    } else sessions = await listPlain(ctx.index, filter, limit, c.flags.empty === true);
    if (out.json) {
      out.data({ sessions: sessions.map(sessionJson), ...pendingField(backlog) });
      return 0;
    }
    if (!sessions.length) {
      out.note("No sessions");
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
    const byFlag = new Map<string, number>();
    for (const s of sessions) for (const f of new Set(failureFlags(s.flags))) byFlag.set(f, (byFlag.get(f) ?? 0) + 1);
    if (byFlag.size) {
      const flagged = sessions.filter((s) => failureFlags(s.flags).length).length;
      const top = [...byFlag].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${f} ${n}`).join(", ");
      out.next(`${flagged} of these ${sessions.length} sessions are flagged (${top}). See what to fix first and the line that fixes it`, "coding.sh improve");
    }
    return 0;
  });
}

/** The newest `limit` sessions the filter keeps; empty ones left out unless `empty`. */
async function listPlain(index: IndexStore, filter: SessionFilter, limit: number, empty: boolean): Promise<Session[]> {
  if (empty) return index.listSessions({ ...filter, limit });
  // Empty sessions are left out after the store's page, so read pages until `limit` are kept.
  const sessions: Session[] = [];
  const page = Math.max(limit * 2, 50);
  for (let offset = 0; sessions.length < limit; offset += page) {
    const got = await index.listSessions({ ...filter, limit: page, offset });
    for (const s of got) if (!isEmptySession(s) && sessions.length < limit) sessions.push(s);
    if (got.length < page) break;
  }
  return sessions;
}

async function query(index: IndexStore, q: Query, filter: SessionFilter, limit: number): Promise<Session[]> {
  try {
    const r = await findSessions(index, q, { filter, limit });
    if (r.truncated) process.stderr.write("Scanned the newest sessions only; narrow with --since\n");
    return r.sessions;
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
