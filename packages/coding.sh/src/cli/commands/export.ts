// coding.sh export sessions|events|labels [--format jsonl|csv] [--agent --repo --since --flag --subagents --project --limit]
// coding.sh export --evidence <dir> [--force] [same filters]
//
// Streams stored rows to stdout with the same filters as `coding.sh sessions`
// (src/query/export.ts). Works on every store. --evidence writes the matching
// sessions' raw traces as a directory instead (src/core/evidence.ts).
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { writeEvidence } from "../../core/evidence.ts";
import { createRedactor } from "../../core/redact.ts";
import type { Session } from "../../schema/index.ts";
import { EXPORT_FORMATS, EXPORT_KINDS, exportRows, sessionsOf, type ExportFormat, type ExportKind } from "../../query/export.ts";
import { scopesSubagents } from "../../query/where.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { agentScope, agentsFlag, autoIngest, queryCliError, readIngest, str, whereFlag, withContext } from "../common.ts";
import { CliError, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** Writes to stdout, waiting for 'drain' when the pipe is full. */
function stdoutWriter(): (chunk: string) => void | Promise<void> {
  return (chunk) => {
    if (process.stdout.write(chunk)) return;
    return new Promise<void>((r) => process.stdout.once("drain", () => r()));
  };
}

/** True when `dir` exists and holds anything. */
function nonEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export async function run(c: CommandContext): Promise<number> {
  const evidence = str(c.flags.evidence);
  if (c.flags.evidence !== undefined && !evidence) throw new UsageError("--evidence needs a directory, e.g. --evidence traces/", { reason: "missing_argument" });
  const kind = (c.positionals[0] ?? (evidence ? "sessions" : undefined)) as ExportKind;
  if (kind === undefined) throw new UsageError(`export what? one of ${EXPORT_KINDS.join(", ")}, or --evidence <dir>`, { reason: "missing_argument" });
  if (!(EXPORT_KINDS as readonly string[]).includes(kind)) throw new UsageError(`export what? one of ${EXPORT_KINDS.join(", ")}`, { reason: "bad_arg" });
  if (evidence && kind !== "sessions") throw new UsageError(`--evidence writes whole sessions; drop "${kind}"`, { reason: "bad_arg" });
  const format = (str(c.flags.format) ?? "jsonl") as ExportFormat;
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new UsageError(`--format must be one of ${EXPORT_FORMATS.join(", ")}`, { reason: "bad_flag" });
  const maxSessions = positiveInt(c.flags.limit, "limit");
  const since = str(c.flags.since) !== undefined ? parseSince(str(c.flags.since)!) : undefined;
  const repo = str(c.flags.repo);
  const userWhere = whereFlag(c);
  const { agent, where } = agentScope(agentsFlag(c), userWhere);
  const dir = evidence ? resolve(c.cwd, evidence) : undefined;
  if (dir && nonEmpty(dir) && c.flags.force !== true) {
    throw new CliError(`${dir} is not empty`, { reason: "target_exists", askUser: true, next: [`coding.sh export --evidence ${evidence} --force`, "or pick an empty directory"] });
  }
  return withContext(c, async (ctx) => {
    await autoIngest(ctx, readIngest(c));
    const filter = {
      ...(agent ? { agent } : {}),
      ...(repo ? { repoRoot: resolve(c.cwd, repo) } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(c.flags.subagents === true || scopesSubagents(userWhere?.root) ? {} : { parentSessionId: null }),
      ...(str(c.flags.project) ? { project: str(c.flags.project)! } : {}),
      ...(str(c.flags.flag) ? { flag: str(c.flags.flag)! } : {}),
    };
    const pick = {
      filter,
      ...(maxSessions !== undefined || userWhere?.limit !== undefined ? { maxSessions: maxSessions ?? userWhere!.limit! } : {}),
      ...(where ? { query: where } : {}),
    };
    if (dir) {
      const sessions: Session[] = [];
      try {
        for await (const s of sessionsOf(ctx.index, pick)) sessions.push(s);
      } catch (e) {
        throw queryCliError(e);
      }
      // The capture rules, and always the secret rules: an export is made to be passed on.
      const redactor = createRedactor({ redact: [...new Set(["secrets", ...ctx.config.capture.redact])], patterns: ctx.config.capture.redactPatterns });
      const r = await writeEvidence({ index: ctx.index, blobs: ctx.blobs, sessions, dir, redactor });
      if (c.out.json) c.out.data({ outcome: "written", ...r });
      else {
        c.out.print(r.dir);
        c.out.note(`Wrote ${plural(r.sessions, "session")}, ${plural(r.files, "file")}${r.cut ? ` (${plural(r.cut, "file")} cut at the size cap)` : ""}`);
      }
      return 0;
    }
    const r = await exportRows(ctx.index, kind, {
      ...pick,
      format,
      write: stdoutWriter(),
    }).catch((e) => Promise.reject(queryCliError(e)));
    c.out.note(`Exported ${plural(r.rows, kind === "sessions" ? "session" : kind === "events" ? "event" : "label")}`);
    return 0;
  });
}
