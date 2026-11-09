// coding.sh purge --literal <file|-> [--rule <regex>]… [--dry-run]
//
// Removes leaked secrets from the store after the fact (src/store/purge.ts does
// the work). Values come from a file or stdin, never argv, so they stay out of
// shell history and process listings, and they are never printed. A --rule
// pattern is on argv, so it should describe the secret's shape, not spell it.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../core/config.ts";
import { acquireLock } from "../../core/lock.ts";
import { paths } from "../../core/paths.ts";
import { fileUrlPath, parseStoreUrl } from "../../store/factory.ts";
import { findRuleMatches, MAX_FILE_BYTES, MAX_RULE_VALUES, MIN_LITERAL_LENGTH, purgeLiterals, RuleTooBroad, type PurgeResult } from "../../store/purge.ts";
import { UsageError } from "../args.ts";
import { withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

const safeUrl = (url: string): string => url.replace(/\/\/[^@/]*@/, "//…@");

/** One value per line; blank lines skipped, a trailing \r dropped, nothing else trimmed (a secret may hold spaces). */
export function parseLiterals(text: string): string[] {
  return [...new Set(text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== ""))];
}

/**
 * `--rule` patterns as regexes. Neither a bad pattern nor the engine's message
 * (which quotes it) is shown, and a pattern that matches empty text is refused.
 */
export function parseRules(raw: readonly string[]): RegExp[] {
  return raw.map((src, i) => {
    const which = raw.length > 1 ? `--rule ${i + 1}` : "--rule";
    let re: RegExp;
    try {
      re = new RegExp(src, "gu");
    } catch {
      throw new UsageError(`${which} is not a valid regular expression (JavaScript syntax, Unicode mode)`, { reason: "invalid_value" });
    }
    if (re.test("")) throw new UsageError(`${which} matches empty text, so it would match everywhere; describe the secret's shape, e.g. 'sk-[A-Za-z0-9]{20,}'`, { reason: "invalid_value" });
    return re;
  });
}

function readLiterals(source: string, cwd: string): string[] {
  let text: string;
  try {
    text = source === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(cwd, source), "utf8");
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
  return literals;
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const source = c.flags.literal;
  const ruleSources = Array.isArray(c.flags.rule) ? c.flags.rule : [];
  if ((typeof source !== "string" || source === "") && !ruleSources.length) {
    throw new UsageError("give the values to remove in a file, one per line: coding.sh purge --literal secrets.txt (or --literal - to read stdin), or their shape: --rule 'sk-[A-Za-z0-9]{20,}'", { askUser: true });
  }
  const rules = parseRules(ruleSources);
  const given = typeof source === "string" && source !== "" ? readLiterals(source, c.cwd) : [];

  const config = loadConfig({ env: c.env });
  const { scheme, rest } = parseStoreUrl(config.store.index);
  if (scheme !== "sqlite" || rest === ":memory:") {
    throw new CliError(`coding.sh purge rewrites the SQLite index; this store is ${safeUrl(config.store.index)}`, {
      reason: "unsupported_store",
      askUser: true,
      next: [`Remove the value with the ${scheme} database's own tools, then rotate it.`],
    });
  }
  const dryRun = c.flags["dry-run"] === true;
  const p = paths(c.env);
  const fileDirs = [p.spool, p.judgeCache, p.runs];
  let literals = given;
  let matched: { values: number; short: number } | undefined;

  // withContext opens (and migrates) the store and the blob store; the ingest lock keeps ingest out meanwhile.
  const r: PurgeResult | undefined = await withContext(c, async (ctx) => {
    // No spool dir: nothing ingests, and none is created just to lock it (as in ingest and gc).
    const lock = !existsSync(p.spool) ? undefined : await acquireLock(p.ingestLock, { waitMs: 30_000 }).catch((e) => {
      throw new CliError(`an ingest is running and holds the store: ${(e as Error).message}`, { reason: "busy", askUser: true, next: ["Try again in a minute:", "coding.sh purge --literal …"] });
    });
    try {
      if (rules.length) {
        const found = await findRuleMatches({ dbPath: fileUrlPath(rest), blobs: ctx.blobs, fileDirs, rules }).catch((e) => {
          if (e instanceof RuleTooBroad) throw new CliError(`the --rule patterns match more than ${MAX_RULE_VALUES} distinct values, which is ordinary text, not one secret`, { reason: "too_broad", next: ["Anchor the pattern on the secret's prefix and length, e.g. 'sk-ant-[A-Za-z0-9_-]{80,}'"] });
          throw e;
        });
        matched = { values: found.values.length, short: found.short };
        literals = [...new Set([...given, ...found.values])];
      }
      if (!literals.length) return undefined;
      return await purgeLiterals({ dbPath: fileUrlPath(rest), blobs: ctx.blobs, fileDirs, literals, dryRun });
    } finally {
      lock?.release();
    }
  });

  if (!r) {
    // Only rules were given, and they matched nothing to purge.
    if (out.json) {
      out.data({ outcome: dryRun ? "planned" : "purged", values: 0, ruleMatches: matched?.values ?? 0, ...(matched?.short ? { shortMatches: matched.short } : {}), events: 0, sessions: 0, otherRows: 0, blobs: 0, files: 0, foldsDropped: 0 });
      return 0;
    }
    out.row("Rules", `matched no value of ${MIN_LITERAL_LENGTH}+ characters`, "ok");
    if (matched?.short) out.row("Short matches", `left ${plural(matched.short, "value")} under ${MIN_LITERAL_LENGTH} characters alone`, "ok");
    out.note("Nothing to purge");
    return 0;
  }

  if (out.json) {
    out.data({ outcome: dryRun ? "planned" : "purged", values: literals.length, ...(matched ? { ruleMatches: matched.values } : {}), ...(matched?.short ? { shortMatches: matched.short } : {}), ...r });
    return r.integrity === false || r.oldBytesKept?.length ? 1 : 0;
  }
  const verb = dryRun ? "would scrub" : "scrubbed";
  if (matched) out.row("Rules", `matched ${plural(matched.values, "distinct value")}`, "ok");
  if (matched?.short) out.row("Short matches", `left ${plural(matched.short, "value")} under ${MIN_LITERAL_LENGTH} characters alone`, "ok");
  out.row("Events", `${verb} ${plural(r.events, "event")}`, "ok");
  out.row("Sessions", `${verb} ${plural(r.sessions, "session")}`, "ok");
  out.row("Other rows", `${verb} ${plural(r.otherRows, "row")} (labels, eval docs, settings)`, "ok");
  out.row("Blobs", `${verb} ${plural(r.blobs, "blob")}`, "ok");
  out.row("Raw files", `${verb} ${plural(r.files, "file")} (spool, judge cache, eval run dirs)`, "ok");
  if (r.filesSkipped) out.row("Skipped", `${plural(r.filesSkipped, "file")} over ${MAX_FILE_BYTES / 1024 / 1024} MB, not read`, "warn");
  if (r.foldsDropped) out.row("Folds", `${dryRun ? "would drop" : "dropped"} ${plural(r.foldsDropped, "saved fold")} (rebuilt on the next ingest)`, "ok");
  if (r.integrity !== undefined) out.row("Integrity", r.integrity ? "index and search ok, file compacted" : "check failed: run coding.sh doctor", r.integrity ? "ok" : "fail");
  for (const f of r.oldBytesKept ?? []) {
    const file = f === "index" ? "index.db" : "blobs/pack.db";
    out.row("Old bytes", `still in ${file}: another process is reading it (the viewer, serve, a sqlite3 shell or a backup). Close it and run the same purge again`, "fail");
  }
  if (r.oldBytesKept?.length) return 1;
  const total = r.events + r.sessions + r.otherRows + r.blobs + r.files;
  if (!total) out.note(`No copies of ${literals.length === 1 ? "the value" : "these values"} in the store`);
  else if (dryRun) out.note("Dry run: nothing changed. Run again without --dry-run to scrub; that cannot be undone, so an agent asks the user first");
  else out.note("Rotate the secret too: copies outside coding.sh (agent transcripts, shell history, git) are not touched");
  return r.integrity === false ? 1 : 0;
}
