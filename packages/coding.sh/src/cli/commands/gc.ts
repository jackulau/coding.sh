// coding.sh gc [--compact] [--dry-run]
import { withContext } from "../common.ts";
import { bytes, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import type { GcResult } from "../../core/gc.ts";

/** The Spool row: day files, the raw side files removed with them or alone (orphans), and their bytes. */
export function spoolSummary(spool: GcResult["spool"], verb: string): string {
  const parts = [plural(spool.deleted, "file")];
  if (spool.rawFiles) parts.push(plural(spool.rawFiles, "raw side file"));
  return `${verb} ${parts.join(" and ")}${spool.bytes ? ` (${bytes(spool.bytes)})` : ""}`;
}

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
    out.row("Spool", spoolSummary(r.spool, verb), "ok");
    // Side files no spool line names (a hook stopped between writing one and its line).
    if (r.spool.orphans?.length) out.note(`${dryRun ? "would delete" : "deleted"} unreferenced side files: ${r.spool.orphans.map((p) => `spool/${p}`).join(", ")}`);
    out.row("Blobs", `${verb} ${plural(r.blobs.deleted, "blob")} (${r.blobs.expired} expired tool output)`, "ok");
    if (r.judgeCache) out.row("Judge cache", `${verb} ${plural(r.judgeCache.deleted, "entry", "entries")}, ${bytes(r.judgeCache.keptBytes)} kept`, "ok");
    if (r.llmCache) out.row("LLM cache", `${verb} ${plural(r.llmCache.deleted, "recording")}, ${bytes(r.llmCache.keptBytes)} kept`, "ok");
    if (r.compacted) out.row("Index", "compacted", "ok");
    if (r.blobsPacked) out.row("Blob pack", `moved ${plural(r.blobsPacked, "small blob file")} in`, "ok");
    if (r.blobPackHeld) out.row("Blob pack", "not compacted: another process is reading blobs/pack.db; run gc --compact again once it closes", "warn");
    if (c.flags.compact === true && dryRun) out.note("--compact is skipped in a dry run");
    return 0;
  });
}
