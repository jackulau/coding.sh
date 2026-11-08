// coding.sh purge --literal <file|-> [--dry-run]
//
// Removes leaked secrets from the store after the fact (src/store/purge.ts does
// the work). Values come from a file or stdin, never argv, so they stay out of
// shell history and process listings, and they are never printed.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../core/config.ts";
import { acquireLock } from "../../core/lock.ts";
import { paths } from "../../core/paths.ts";
import { fileUrlPath, parseStoreUrl } from "../../store/factory.ts";
import { MIN_LITERAL_LENGTH, purgeLiterals, type PurgeResult } from "../../store/purge.ts";
import { UsageError } from "../args.ts";
import { withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

const safeUrl = (url: string): string => url.replace(/\/\/[^@/]*@/, "//…@");

/** One value per line; blank lines skipped, a trailing \r dropped, nothing else trimmed (a secret may hold spaces). */
export function parseLiterals(text: string): string[] {
  return [...new Set(text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== ""))];
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const source = c.flags.literal;
  if (typeof source !== "string" || source === "") throw new UsageError("give the values to remove in a file, one per line: coding.sh purge --literal secrets.txt (or --literal - to read stdin)");
  let text: string;
  try {
    text = source === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(c.cwd, source), "utf8");
  } catch (e) {
    // Neither the path nor the error (which repeats it) is shown: `--literal <secret>` is an easy slip.
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === "ENOENT" ? "no such file" : code === "EISDIR" ? "it is a directory" : code === "EACCES" ? "permission denied" : "read failed";
    throw new UsageError(source === "-" ? `couldn't read stdin: ${why}` : `couldn't read the --literal file (${why}); it takes a file path, one value per line`);
  }
  const literals = parseLiterals(text);
  if (!literals.length) throw new UsageError(`${source === "-" ? "stdin" : "the --literal file"} holds no values`);
  const short = literals.filter((l) => l.length < MIN_LITERAL_LENGTH).length;
  if (short) throw new UsageError(`${plural(short, "value")} shorter than ${MIN_LITERAL_LENGTH} characters; a short value would rewrite ordinary text`, { reason: "too_short" });

  const config = loadConfig({ env: c.env });
  const { scheme, rest } = parseStoreUrl(config.store.index);
  if (scheme !== "sqlite" || rest === ":memory:") {
    throw new CliError(`coding.sh purge rewrites the SQLite index; this store is ${safeUrl(config.store.index)}`, {
      reason: "unsupported_store",
      next: [`Remove the value with the ${scheme} database's own tools, then rotate it.`],
    });
  }
  const dryRun = c.flags["dry-run"] === true;
  const p = paths(c.env);

  // withContext opens (and migrates) the store and the blob store; the ingest lock keeps ingest out meanwhile.
  const r: PurgeResult = await withContext(c, async (ctx) => {
    // No spool dir: nothing ingests, and none is created just to lock it (as in ingest and gc).
    const lock = !existsSync(p.spool) ? undefined : await acquireLock(p.ingestLock, { waitMs: 30_000 }).catch((e) => {
      throw new CliError(`an ingest is running and holds the store: ${(e as Error).message}`, { reason: "busy", next: ["Try again in a minute:", "coding.sh purge --literal …"] });
    });
    try {
      return await purgeLiterals({ dbPath: fileUrlPath(rest), blobs: ctx.blobs, fileDirs: [p.spool, p.judgeCache], literals, dryRun });
    } finally {
      lock?.release();
    }
  });

  if (out.json) {
    out.data({ outcome: dryRun ? "planned" : "purged", values: literals.length, ...r });
    return r.integrity === false ? 1 : 0;
  }
  const verb = dryRun ? "would scrub" : "scrubbed";
  out.row("Events", `${verb} ${plural(r.events, "event")}`, "ok");
  out.row("Sessions", `${verb} ${plural(r.sessions, "session")}`, "ok");
  out.row("Other rows", `${verb} ${plural(r.otherRows, "row")} (labels, eval docs, settings)`, "ok");
  out.row("Blobs", `${verb} ${plural(r.blobs, "blob")}`, "ok");
  out.row("Raw files", `${verb} ${plural(r.files, "file")} (spool, judge cache)`, "ok");
  if (r.foldsDropped) out.row("Folds", `${dryRun ? "would drop" : "dropped"} ${plural(r.foldsDropped, "saved fold")} (rebuilt on the next ingest)`, "ok");
  if (r.integrity !== undefined) out.row("Integrity", r.integrity ? "index and search ok, file compacted" : "check failed: run coding.sh doctor", r.integrity ? "ok" : "fail");
  const total = r.events + r.sessions + r.otherRows + r.blobs + r.files;
  if (!total) out.note(`No copies of ${literals.length === 1 ? "the value" : "these values"} in the store`);
  else if (dryRun) out.note("Dry run: nothing changed. Run again without --dry-run to scrub");
  else out.note("Rotate the secret too: copies outside coding.sh (agent transcripts, shell history, git) are not touched");
  return r.integrity === false ? 1 : 0;
}
