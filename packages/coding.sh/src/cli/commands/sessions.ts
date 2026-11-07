// coding.sh sessions [--agent --repo --since --limit]
import { resolve } from "node:path";
import { parseSince, positiveInt } from "../args.ts";
import { autoIngest, num, oneLine, sessionJson, str, withContext } from "../common.ts";
import { ago, clean, duration } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const limit = positiveInt(c.flags.limit, "limit") ?? num(c.flags.limit) ?? 20;
  const since = str(c.flags.since) !== undefined ? parseSince(str(c.flags.since)!) : undefined;
  const repo = str(c.flags.repo);
  return withContext(c, async (ctx) => {
    await autoIngest(ctx);
    const sessions = await ctx.index.listSessions({
      ...(str(c.flags.agent) ? { agent: str(c.flags.agent)! } : {}),
      ...(repo ? { repoRoot: resolve(c.cwd, repo) } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(c.flags.subagents === true ? {} : { parentSessionId: null }),
      ...(str(c.flags.project) ? { project: str(c.flags.project)! } : {}),
      limit,
    });
    if (out.json) {
      out.data({ sessions: sessions.map(sessionJson) });
      return 0;
    }
    if (!sessions.length) {
      out.note("No sessions");
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
    return 0;
  });
}
