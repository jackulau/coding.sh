// coding.sh export sessions|events|labels [--format jsonl|csv] [--agent --repo --since --flag --subagents --project --limit]
//
// Streams stored rows to stdout with the same filters as `coding.sh sessions`
// (src/query/export.ts). Works on every store.
import { resolve } from "node:path";
import { EXPORT_FORMATS, EXPORT_KINDS, exportRows, type ExportFormat, type ExportKind } from "../../query/export.ts";
import { parseSince, positiveInt, UsageError } from "../args.ts";
import { autoIngest, queryCliError, readIngest, str, whereFlag, withContext } from "../common.ts";
import { plural } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** Writes to stdout, waiting for 'drain' when the pipe is full. */
function stdoutWriter(): (chunk: string) => void | Promise<void> {
  return (chunk) => {
    if (process.stdout.write(chunk)) return;
    return new Promise<void>((r) => process.stdout.once("drain", () => r()));
  };
}

export async function run(c: CommandContext): Promise<number> {
  const kind = c.positionals[0] as ExportKind;
  if (!(EXPORT_KINDS as readonly string[]).includes(kind)) throw new UsageError(`export what? one of ${EXPORT_KINDS.join(", ")}`, { reason: "bad_arg" });
  const format = (str(c.flags.format) ?? "jsonl") as ExportFormat;
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new UsageError(`--format must be one of ${EXPORT_FORMATS.join(", ")}`, { reason: "bad_flag" });
  const maxSessions = positiveInt(c.flags.limit, "limit");
  const since = str(c.flags.since) !== undefined ? parseSince(str(c.flags.since)!) : undefined;
  const repo = str(c.flags.repo);
  const where = whereFlag(c);
  return withContext(c, async (ctx) => {
    await autoIngest(ctx, readIngest(c));
    const r = await exportRows(ctx.index, kind, {
      filter: {
        ...(str(c.flags.agent) ? { agent: str(c.flags.agent)! } : {}),
        ...(repo ? { repoRoot: resolve(c.cwd, repo) } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(c.flags.subagents === true ? {} : { parentSessionId: null }),
        ...(str(c.flags.project) ? { project: str(c.flags.project)! } : {}),
        ...(str(c.flags.flag) ? { flag: str(c.flags.flag)! } : {}),
      },
      ...(maxSessions !== undefined || where?.limit !== undefined ? { maxSessions: maxSessions ?? where!.limit! } : {}),
      ...(where ? { query: where } : {}),
      format,
      write: stdoutWriter(),
    }).catch((e) => Promise.reject(queryCliError(e)));
    c.out.note(`Exported ${plural(r.rows, kind === "sessions" ? "session" : kind === "events" ? "event" : "label")}`);
    return 0;
  });
}
