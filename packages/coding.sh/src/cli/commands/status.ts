// coding.sh status: capture totals, pending spool, latest session.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { autoIngest, readIngest, oneLine, sessionJson, withContext } from "../common.ts";
import { ago, bytes, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

function spoolSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let total = 0;
  if (!existsSync(dir)) return { files, bytes: total };
  for (const agent of readdirSync(dir)) {
    const sub = join(dir, agent);
    let st;
    try {
      st = statSync(sub);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(sub)) {
      if (!f.endsWith(".jsonl")) continue;
      files++;
      total += statSync(join(sub, f)).size;
    }
  }
  return { files, bytes: total };
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  return withContext(c, async (ctx) => {
    await autoIngest(ctx, readIngest(c));
    const day = Date.now() - 86400e3;
    const recent = await ctx.index.listSessions({ since: day, limit: 10_000 });
    const [latest] = await ctx.index.listSessions({ limit: 1, parentSessionId: null });
    const agents = [...new Set(recent.map((s) => s.agent))].sort();
    const spool = spoolSize(ctx.paths.spool);
    if (out.json) {
      out.data({ home: ctx.paths.root, store: ctx.config.store.index, last24h: { sessions: recent.length, agents }, spool, latest: latest ? sessionJson(latest) : null });
      return 0;
    }
    out.row("Home", ctx.paths.root);
    out.row("Store", ctx.config.store.index);
    out.row("Last 24h", recent.length ? `${plural(recent.length, "session")} from ${agents.join(", ")}` : "No sessions");
    out.row("Spool", `${plural(spool.files, "file")}, ${bytes(spool.bytes)}`);
    if (latest) {
      out.print(`${latest.id}  ${latest.agent}  ${ago(latest.startedAt)}  ${oneLine(latest.title, 60)}`);
    } else {
      out.note("No sessions captured yet");
      out.next("Install capture hooks", "coding.sh init");
    }
    return 0;
  });
}
