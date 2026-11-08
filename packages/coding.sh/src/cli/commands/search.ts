// coding.sh search <text> [--where <query>]
import { searchWhere } from "../../query/run.ts";
import { positiveInt } from "../args.ts";
import { autoIngest, pendingField, queryCliError, readIngest, oneLine, str, whereFlag, withContext } from "../common.ts";
import { ago, clean } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const text = c.positionals.join(" ").trim();
  const where = whereFlag(c);
  const limit = positiveInt(c.flags.limit, "limit") ?? where?.limit ?? 20;
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const agent = str(c.flags.agent);
    const project = str(c.flags.project);
    const opts = { limit, ...(agent ? { agent } : {}), ...(project ? { project } : {}) };
    const hits = where ? await searchWhere(ctx.index, text, where, opts).catch((e) => Promise.reject(queryCliError(e))) : await ctx.index.search(text, opts);
    if (out.json) {
      out.data({ query: text, hits: hits.map((h) => ({ sessionId: h.event.sessionId, eventId: h.event.id, agent: h.event.agent, kind: h.event.kind, ts: new Date(h.event.ts).toISOString(), snippet: h.snippet })), ...pendingField(backlog) });
      return 0;
    }
    if (!hits.length) {
      out.note(`No matches for ${JSON.stringify(text)}`);
      return 0;
    }
    const tty = out.stdoutTTY;
    out.table(
      ["SESSION", "KIND", "WHEN", "MATCH"],
      hits.map((h) => [h.event.sessionId, h.event.kind, ago(h.event.ts), oneLine(clean(h.snippet), tty ? 80 : 10_000)]),
    );
    return 0;
  });
}
