// The spool writer: shared by the hook (src/spool/hook.ts, bundled to
// dist/hook.mjs) and the `coding.sh run` wrapper (src/capture/wrapper.ts).
//
// This file is on the hook's hot path. It may only import node:fs, node:path
// (and node:os via ../core/paths.ts) and type-only imports.
//
// On-disk layout (all under dataHome()/spool):
//   <agent>/<yyyy-mm-dd>.jsonl         one SpoolLine per line, every writer that UTC day
//   <agent>/<yyyy-mm-dd>.<n>.jsonl     the same day continued (n = 1, 2, ...) once the
//                                      previous file reached SPOOL_FILE_CAP
//   <agent>/raw/<ts>-<pid>-<rand>.json side file for payloads too big to inline
//   errors.log                         one JSON object per line, hook failures
// Older versions had every hook call write its own <yyyy-mm-dd>.<pid>.jsonl: about
// 11,000 files a day for one busy user, each with its own ingest cursor.
// Readers take any *.jsonl name.
//
// Concurrency: every hook process appends to the same day file. Each line is
// one write(2) on a descriptor opened with O_APPEND (FILE_APPEND_DATA on
// Windows), which the kernel places at the end of the file as one unit, so
// lines from concurrent hooks never interleave on a local filesystem. A write
// cut short (ENOSPC, EIO) is truncated back off. If the file still ends in a torn
// fragment (a killed writer left no "\n"), the new line starts with "\n": the
// fragment becomes a line of its own that readers skip, instead of swallowing
// the new line.
//
// Files are created 0600 and dirs 0700: payloads can hold prompts and secrets.
import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { SpoolLine } from "../core/types.ts";
import { paths } from "../core/paths.ts";

/**
 * A serialized line above this many bytes (1024 with its newline, hook.sh's
 * limit) moves `raw` to a side file. Ingest rewrites side files with their
 * secrets redacted once it has stored their line (core/spool-scrub.ts); a day
 * file's short inline lines are redacted in place once the day has passed.
 */
export const MAX_INLINE_LINE_BYTES = 1023;

/** Agent ids become directory names: keep them path-safe. */
export function safeAgentId(agent: string | undefined): string {
  const a = (agent ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(a) && !a.includes("..") ? a : "unknown";
}

export function spoolDir(agent: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).spool, safeAgentId(agent));
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** A day's spool file at this size is full: the day continues in the next numbered file. */
export const SPOOL_FILE_CAP = 64 * 1024 * 1024;
/** Numbered files tried before a writer falls back to one of its own (64 GB in a day). */
const MAX_DAY_FILES = 1024;

/**
 * The file a line written now at `ts` goes to: `<day>.jsonl`, or once that has
 * reached SPOOL_FILE_CAP, the first of `<day>.1.jsonl`, `<day>.2.jsonl`, … that
 * hasn't. The cap is soft: writers racing at the boundary can take a file a
 * few lines past it.
 */
export function spoolFile(agent: string, ts: number, env: NodeJS.ProcessEnv = process.env, pid = process.pid): string {
  const dir = spoolDir(agent, env);
  const day = utcDay(ts);
  for (let n = 0; n < MAX_DAY_FILES; n++) {
    const file = join(dir, n ? `${day}.${n}.jsonl` : `${day}.jsonl`);
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st || st.size < SPOOL_FILE_CAP) return file;
  }
  return join(dir, `${day}.p${pid}.jsonl`);
}

function openAppend(file: string, dir: string): number {
  try {
    return openSync(file, "a+", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return openSync(file, "a+", 0o600);
  }
}

/**
 * Cuts the file back to `size`. A descriptor opened for append holds no write access on
 * Windows (FILE_APPEND_DATA only), so ftruncate on it fails there: truncate through a
 * second descriptor opened for writing.
 */
function truncateTo(fd: number, file: string, size: number): void {
  try {
    ftruncateSync(fd, size);
  } catch {
    const w = openSync(file, "r+");
    try {
      ftruncateSync(w, size);
    } finally {
      closeSync(w);
    }
  }
}

/** O_APPEND write of `data`, on a fresh line even when the file ends in a torn fragment. */
function append(file: string, dir: string, data: string): void {
  const fd = openAppend(file, dir);
  try {
    let buf = Buffer.from(data);
    const { size } = fstatSync(fd);
    if (size > 0) {
      const last = Buffer.alloc(1);
      if (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) buf = Buffer.concat([Buffer.from("\n"), buf]);
    }
    let off = 0;
    try {
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      // Cut short (ENOSPC, EIO): take the fragment back off, since hook.sh appends without
      // looking at the file's end and its next line would be glued onto it. Only when the
      // file ends where this write stopped: a line another hook appended since stays.
      if (off > 0) {
        try {
          if (fstatSync(fd).size === size + off) truncateTo(fd, file, size);
        } catch {
          // the fragment stays; readers skip it as a torn line
        }
      }
      throw e;
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // the bytes are written; a failed close must not make the caller undo them
    }
  }
}

export function isDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODING_SH_DISABLE === "1" || env.CODING_SH_DISABLE === "true";
}

/**
 * `spool/disabled-sessions`: one session id per line, from hook calls made while
 * CODING_SH_DISABLE was set (hook.sh writes it too). Ingest and backfill leave
 * those sessions out, so a paused session does not come back from its transcript.
 */
export function disabledSessionsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).spool, "disabled-sessions");
}

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Payload keys that hold the session id, by agent: Claude Code, Codex, Gemini (session_id), Cursor (conversation_id), Copilot (sessionId), Antigravity (conversationId). */
const SESSION_KEYS = ["session_id", "conversation_id", "sessionId", "conversationId"] as const;

/** The payload's session id (the first of SESSION_KEYS it has), when it is a plain id. */
export function payloadSessionId(raw: unknown, text: string): string | undefined {
  let id: unknown;
  if (raw && typeof raw === "object") id = SESSION_KEYS.map((k) => (raw as Record<string, unknown>)[k]).find((v) => v !== undefined);
  // Too large to parse: the first one in the text, as hook.sh reads it.
  else id = /"(?:session_id|conversation_id|sessionId|conversationId)"\s*:\s*"([^"\\]{1,128})"/.exec(text.slice(0, 65536))?.[1];
  return typeof id === "string" && SESSION_ID_RE.test(id) ? id : undefined;
}

/** Appends a session id to spool/disabled-sessions. Throws on I/O errors; the hook logs them. */
export function recordDisabledSession(id: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!SESSION_ID_RE.test(id)) return;
  const p = paths(env);
  append(disabledSessionsFile(env), p.spool, id + "\n");
}

/** The ids in `<spoolDir>/disabled-sessions` (empty when there is none). */
export function readDisabledSessions(spoolDir: string): Set<string> {
  let text: string;
  try {
    text = readFileSync(join(spoolDir, "disabled-sessions"), "utf8");
  } catch {
    return new Set();
  }
  return new Set(text.split("\n").map((l) => l.trim()).filter((l) => SESSION_ID_RE.test(l)));
}

export interface AppendOptions {
  /**
   * The payload exactly as received (e.g. stdin text). When given, a side file
   * stores these bytes verbatim instead of re-serializing `line.raw`.
   */
  rawText?: string;
}

/**
 * Append one SpoolLine. Returns the spool file written, or undefined when
 * capture is disabled (CODING_SH_DISABLE=1). Throws on I/O errors; the hook
 * catches and logs them.
 *
 * When the serialized line exceeds MAX_INLINE_LINE_BYTES, `raw` is written to
 * `<agent>/raw/<ts>-<pid>-<rand>.json`, removed from the line, and the absolute
 * side-file path is set as `rawFile`. Side-file contents: `rawText` verbatim
 * when provided, else JSON.stringify(raw). Readers recover `raw` with
 * resolveRaw(): JSON.parse the file, falling back to the plain string — the
 * same rule the hook applies to stdin.
 */
export function appendSpool(line: SpoolLine, env: NodeJS.ProcessEnv = process.env, opts: AppendOptions = {}): string | undefined {
  if (isDisabled(env)) return undefined;
  const agent = safeAgentId(line.agent);
  const dir = spoolDir(agent, env);
  const file = spoolFile(agent, line.ts, env, line.pid);

  let out: string | undefined;
  const rawTooBig = opts.rawText !== undefined && Buffer.byteLength(opts.rawText) > MAX_INLINE_LINE_BYTES;
  if (!rawTooBig) {
    out = JSON.stringify(line);
    if (Buffer.byteLength(out) > MAX_INLINE_LINE_BYTES) out = undefined;
  }
  if (out === undefined) {
    const rawDir = join(dir, "raw");
    const rand = Math.random().toString(36).slice(2, 10);
    const rawFile = join(rawDir, `${line.ts}-${line.pid}-${rand}.json`);
    const body = opts.rawText ?? JSON.stringify(line.raw ?? null);
    try {
      writeFileSync(rawFile, body, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      mkdirSync(rawDir, { recursive: true, mode: 0o700 });
      writeFileSync(rawFile, body, { mode: 0o600, flag: "wx" });
    }
    const { raw: _raw, ...rest } = line;
    try {
      append(file, dir, JSON.stringify({ ...rest, rawFile }) + "\n");
    } catch (e) {
      // Nothing will ever reference the side file: don't leave the payload (prompts, secrets) behind.
      rmSync(rawFile, { force: true });
      throw e;
    }
    return file;
  }
  append(file, dir, out + "\n");
  return file;
}

/** The line's payload, reading the side file when it was too large to inline. */
export function resolveRaw(line: SpoolLine): unknown {
  if (!line.rawFile) return line.raw;
  const text = readFileSync(line.rawFile, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Best-effort append to spool/errors.log. Never throws. */
export function logSpoolError(err: unknown, ctx: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const p = paths(env);
    const e = err as { message?: string; stack?: string; code?: string };
    const entry = {
      ts: Date.now(),
      pid: process.pid,
      ...ctx,
      error: e && typeof e === "object" ? (e.message ?? String(err)) : String(err),
      code: e && typeof e === "object" ? e.code : undefined,
      stack: e && typeof e === "object" ? e.stack?.split("\n").slice(0, 6).join("\n") : undefined,
    };
    append(p.spoolErrors, p.spool, JSON.stringify(entry) + "\n");
  } catch {
    // Nowhere left to report. Capture must never break the agent.
  }
}
