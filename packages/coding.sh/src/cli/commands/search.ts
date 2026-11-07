// coding.sh search <text>
import { positiveInt } from "../args.ts";
import { autoIngest, readIngest, oneLine, str, withContext } from "../common.ts";
import { ago, clean } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const text = c.positionals.join(" ").trim();
  const limit = positiveInt(c.flags.limit, "limit") ?? 20;
  return withContext(c, async (ctx) => {
    await autoIngest(ctx, readIngest(c));
    const agent = str(c.flags.agent);
    const project = str(c.flags.project);
    const hits = await ctx.index.search(text, { limit, ...(agent ? { agent } : {}), ...(project ? { project } : {}) });
    if (out.json) {
      out.data({ query: text, hits: hits.map((h) => ({ sessionId: h.event.sessionId, eventId: h.event.id, agent: h.event.agent, kind: h.event.kind, ts: new Date(h.event.ts).toISOString(), snippet: h.snippet })) });
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
