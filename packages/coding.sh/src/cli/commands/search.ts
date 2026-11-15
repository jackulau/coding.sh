// coding.sh search <text> [--where <query>]
import { searchWhere } from "../../query/run.ts";
import { positiveInt } from "../args.ts";
import { agentQuery, agentsFlag, autoIngest, emptyStateNext, pendingField, queryCliError, readIngest, oneLine, str, whereFlag, withContext } from "../common.ts";
import { ago, clean } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const text = c.positionals.join(" ").trim();
  const userWhere = whereFlag(c);
  const limit = positiveInt(c.flags.limit, "limit") ?? userWhere?.limit ?? 20;
  // --agent picks sessions by the session's agent, as `sessions --agent` does: a Claude Code session hosted
  // by T3 Code is t3code, though its events carry claude-code.
  const agents = agentsFlag(c);
  const where = agents.length ? agentQuery(agents, userWhere) : userWhere;
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const project = str(c.flags.project);
    const opts = { limit, ...(project ? { project } : {}) };
    const hits = where ? await searchWhere(ctx.index, text, where, opts).catch((e) => Promise.reject(queryCliError(e))) : await ctx.index.search(text, opts);
    if (out.json) {
      // The session's agent, not the event's: the same one `sessions` reports.
      const agentOf = new Map<string, string>();
      for (const id of new Set(hits.map((h) => h.event.sessionId))) {
        const s = await ctx.index.getSession(id);
        if (s) agentOf.set(id, s.agent);
      }
      out.data({ query: text, hits: hits.map((h) => ({ sessionId: h.event.sessionId, eventId: h.event.id, agent: agentOf.get(h.event.sessionId) ?? h.event.agent, kind: h.event.kind, ts: new Date(h.event.ts).toISOString(), snippet: h.snippet })), ...pendingField(backlog) });
      return 0;
    }
    if (!hits.length) {
      out.note(`No matches for ${JSON.stringify(text)}`);
      await emptyStateNext(out, c.env, ctx.index);
      return 0;
    }
    const tty = out.stdoutTTY;
    out.table(
      ["SESSION", "KIND", "WHEN", "MATCH"],
      hits.map((h) => [h.event.sessionId, h.event.kind, ago(h.event.ts), oneLine(clean(h.snippet), tty ? 80 : 10_000)]),
    );
    return 0;
  }, { create: false });
}
