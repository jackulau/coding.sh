// coding.sh gc [--compact] [--dry-run]
import { withContext } from "../common.ts";
import { bytes, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const dryRun = c.flags["dry-run"] === true;
  const compact = c.flags.compact === true && !dryRun;
  return withContext(c, async (ctx) => {
    const r = await ctx.gc({ dryRun, compact });
    if (out.json) {
      out.data({ outcome: dryRun ? "planned" : "deleted", ...r });
      return 0;
    }
    const verb = dryRun ? "would delete" : "deleted";
    out.row("Spool", `${verb} ${plural(r.spool.deleted, "file")}`, "ok");
    out.row("Blobs", `${verb} ${plural(r.blobs.deleted, "blob")} (${r.blobs.expired} expired tool output)`, "ok");
    if (r.judgeCache) out.row("Judge cache", `${verb} ${plural(r.judgeCache.deleted, "entry", "entries")}, ${bytes(r.judgeCache.keptBytes)} kept`, "ok");
    if (r.compacted) out.row("Index", "compacted", "ok");
    if (c.flags.compact === true && dryRun) out.note("--compact is skipped in a dry run");
    return 0;
  });
}
