// coding.sh export sessions|events|labels|scores [--format jsonl|csv] [--out FILE] [--agent --repo --since --until --flag --subagents --project --name --source --limit]
// coding.sh export --evidence <dir> [--force] [same filters]
//
// Streams stored rows to stdout (or --out) with the same filters as `coding.sh sessions`
// (src/query/export.ts). Works on every store. --evidence writes the matching
// sessions' raw traces as a directory instead (src/core/evidence.ts).
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeEvidence } from "../../core/evidence.ts";
import { createRedactor } from "../../core/redact.ts";
import type { ScoreSource } from "../../core/types.ts";
import type { Session } from "../../schema/index.ts";
import { EXPORT_FORMATS, EXPORT_KINDS, exportRows, sessionsOf, type ExportFormat, type ExportKind, type ExportOptions } from "../../query/export.ts";
import { rejectFlagTypos } from "../../query/flag-typos.ts";
import { scopesSubagents } from "../../query/where.ts";
import { cliError as scoreCliError } from "../../scores/cli.ts";
import { NAME_RE, SCORE_SOURCES, ScoreError } from "../../scores/scores.ts";
import { parseSince, parseSinceWhen, positiveInt, suggest, UsageError } from "../args.ts";
import { agentScope, agentsFlag, autoIngest, queryCliError, readIngest, rejectAgentTypos, shellQuote, str, whereFlag, withContext } from "../common.ts";
import { CliError, forTerminal, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { withRepo } from "./sessions.ts";

/** Writes to stdout, waiting for 'drain' when the pipe is full. A terminal gets no escape sequence. */
function stdoutWriter(): (chunk: string) => void | Promise<void> {
  const tty = process.stdout.isTTY === true;
  return (chunk) => {
    if (process.stdout.write(tty ? forTerminal(chunk) : chunk)) return;
    return new Promise<void>((r) => process.stdout.once("drain", () => r()));
  };
}

/** Streams chunks into a file with backpressure; finishes on close and destroys on error. */
function fileWriter(path: string): { write: (chunk: string) => void | Promise<void>; finish: () => Promise<void>; abort: () => void } {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { encoding: "utf8" });
  let err: unknown;
  stream.on("error", (e) => {
    err = e;
  });
  return {
    write(chunk) {
      if (err) return Promise.reject(err);
      if (stream.write(chunk)) return;
      return new Promise<void>((res, rej) => {
        const onDrain = () => {
          stream.off("error", onErr);
          res();
        };
        const onErr = (e: Error) => {
          stream.off("drain", onDrain);
          rej(e);
        };
        stream.once("drain", onDrain);
        stream.once("error", onErr);
      });
    },
    finish() {
      if (err) return Promise.reject(err);
      return new Promise<void>((res, rej) => {
        stream.once("finish", () => res());
        stream.once("error", (e) => rej(e));
        stream.end();
      });
    },
    abort() {
      stream.destroy();
    },
  };
}

function kindNoun(kind: ExportKind): string {
  if (kind === "sessions") return "session";
  if (kind === "events") return "event";
  if (kind === "labels") return "label";
  return "score";
}

/** True when `dir` exists and holds anything. */
function nonEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * What an earlier `--evidence` run left in `dir`: its top-level index.md and each session directory
 * (the ones holding a session.json). Anything else the directory holds is not ours and stays.
 */
function clearEvidence(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === "index.md") rmSync(p);
    else if (e.isDirectory() && existsSync(join(p, "session.json"))) rmSync(p, { recursive: true });
  }
}

/** The command as the user ran it with --force added, each word quoted for the shell. */
function forceCommand(c: CommandContext, evidence: string): string {
  const words = (c.argv ?? ["export", "--evidence", evidence]).filter((w) => w !== "--force");
  return ["coding.sh", ...words.map(shellQuote), "--force"].join(" ");
}

export async function run(c: CommandContext): Promise<number> {
  const evidence = str(c.flags.evidence);
  if (c.flags.evidence !== undefined && !evidence) throw new UsageError("--evidence needs a directory, e.g. --evidence traces/", { reason: "missing_argument" });
  const kind = (c.positionals[0] ?? (evidence ? "sessions" : undefined)) as ExportKind;
  if (kind === undefined) throw new UsageError(`export what? one of ${EXPORT_KINDS.join(", ")}, or --evidence <dir>`, { reason: "missing_argument" });
  if (!(EXPORT_KINDS as readonly string[]).includes(kind)) {
    const s = suggest(kind, EXPORT_KINDS);
    throw new UsageError(`export what? one of ${EXPORT_KINDS.join(", ")}`, { reason: "bad_arg", suggestion: s ? `coding.sh export ${s}` : undefined });
  }
  if (evidence && kind !== "sessions") throw new UsageError(`--evidence writes whole sessions; drop "${kind}"`, { reason: "bad_arg" });
  const outFile = str(c.flags.out);
  if (c.flags.out !== undefined && !outFile) throw new UsageError("--out needs a file path, e.g. --out scores.jsonl", { reason: "missing_argument" });
  if (outFile && evidence) throw new UsageError("--out writes rows to one file; --evidence writes a directory", { reason: "bad_flag" });
  const scoreName = str(c.flags.name);
  const scoreSourceRaw = str(c.flags.source);
  if (scoreName !== undefined && kind !== "scores") throw new UsageError("--name only applies to export scores", { reason: "bad_flag" });
  if (scoreSourceRaw !== undefined && kind !== "scores") throw new UsageError("--source only applies to export scores", { reason: "bad_flag" });
  if (scoreName !== undefined && !NAME_RE.test(scoreName)) throw new UsageError("--name must be 1-100 chars of [A-Za-z0-9_.:/-]", { reason: "invalid_argument" });
  if (scoreSourceRaw !== undefined && !(SCORE_SOURCES as readonly string[]).includes(scoreSourceRaw)) {
    throw new UsageError(`--source must be one of ${SCORE_SOURCES.join(", ")}`, { reason: "bad_flag" });
  }
  const scoreSource = scoreSourceRaw as ScoreSource | undefined;
  const format = (str(c.flags.format) ?? "jsonl") as ExportFormat;
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) throw new UsageError(`--format must be one of ${EXPORT_FORMATS.join(", ")}`, { reason: "bad_flag" });
  if (c.out.json && !evidence && !outFile) throw new UsageError(`export already prints one ${kindNoun(kind)} per line (JSONL); drop --json, or use --format csv`, { reason: "bad_flag" });
  const maxSessions = positiveInt(c.flags.limit, "limit");
  const now = Date.now();
  const since = str(c.flags.since) !== undefined ? parseSince(str(c.flags.since)!, now) : undefined;
  const until = str(c.flags.until) !== undefined ? parseSinceWhen(str(c.flags.until)!, now, "until").ms : undefined;
  if (since !== undefined && until !== undefined && !(since < until)) throw new UsageError("--since must be before --until", { reason: "invalid_argument" });
  const repo = str(c.flags.repo);
  const userWhere = whereFlag(c);
  const agents = agentsFlag(c);
  const scope = agentScope(agents, userWhere);
  const agent = scope.agent;
  // Nothing matched: an --agent, --flag or flag: value typed wrong is named, as `sessions` does.
  const rejectTypos = async (index: Parameters<typeof rejectAgentTypos>[0]) => {
    await rejectAgentTypos(index, agents);
    await rejectFlagTypos(index, str(c.flags.flag), userWhere);
  };
  // --repo as `sessions` reads it: a path or a repo name, worktrees included.
  const where = withRepo(scope.where, repo, c);
  const dir = evidence ? resolve(c.cwd, evidence) : undefined;
  const outPath = outFile ? resolve(c.cwd, outFile) : undefined;
  if (dir && nonEmpty(dir) && c.flags.force !== true) {
    throw new CliError(`${dir} is not empty`, { reason: "target_exists", askUser: true, next: ["Replace what is there (sessions from an earlier export are removed):", forceCommand(c, evidence!)] });
  }
  return withContext(c, async (ctx) => {
    await autoIngest(ctx, readIngest(c));
    const filter: ExportOptions["filter"] = {
      ...(agent ? { agent } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(c.flags.subagents === true || scopesSubagents(userWhere?.root) ? {} : { parentSessionId: null }),
      ...(str(c.flags.project) ? { project: str(c.flags.project)! } : {}),
      ...(str(c.flags.flag) ? { flag: str(c.flags.flag)! } : {}),
    };
    if (until !== undefined) filter.until = until;
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
      if (!sessions.length) await rejectTypos(ctx.index);
      // The directory is rewritten whole: sessions an earlier run left there are not part of this one.
      if (c.flags.force === true && nonEmpty(dir)) clearEvidence(dir);
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
    const mapErr = (e: unknown) => (e instanceof ScoreError ? scoreCliError(e) : queryCliError(e));
    const exportOpts: ExportOptions = {
      ...pick,
      format,
      write: stdoutWriter(),
    };
    if (scoreName !== undefined) exportOpts.scoreName = scoreName;
    if (scoreSource !== undefined) exportOpts.scoreSource = scoreSource;
    if (kind === "scores") {
      exportOpts.redactor = createRedactor({ redact: [...new Set(["secrets", ...ctx.config.capture.redact])], patterns: ctx.config.capture.redactPatterns });
    }
    if (outPath) {
      const fw = fileWriter(outPath);
      exportOpts.write = fw.write;
      let r: { rows: number };
      try {
        r = await exportRows(ctx.index, kind, exportOpts);
        await fw.finish();
      } catch (e) {
        fw.abort();
        throw mapErr(e);
      }
      if (!r.rows) await rejectTypos(ctx.index);
      if (c.out.json) c.out.data({ outcome: "written", path: outPath, kind, format, rows: r.rows });
      else {
        c.out.print(outPath);
        c.out.note(`Exported ${plural(r.rows, kindNoun(kind))}`);
      }
      return 0;
    }
    const r = await exportRows(ctx.index, kind, exportOpts).catch((e) => Promise.reject(mapErr(e)));
    if (!r.rows) await rejectTypos(ctx.index);
    c.out.note(`Exported ${plural(r.rows, kindNoun(kind))}`);
    return 0;
  }, { create: false });
}
