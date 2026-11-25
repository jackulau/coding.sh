// The spool writer: shared by the hook (src/spool/hook.ts, bundled to
// dist/hook.mjs) and the `coding.sh run` wrapper (src/capture/wrapper.ts).
//
// This file is on the hook's hot path. It may only load node:fs and node:path
// (and node:os via ../core/paths.ts), from process.getBuiltinModule as ./hook.ts
// says, and make type-only imports.
//
// Redaction: the caller says how to redact a line (AppendOptions.redact), and
// appendSpool does it before any byte of the payload is written, inline or to a
// side file. spoolLineRedactor() in ./redact.ts applies the rules of the user's
// config and counts what they replaced in the line's `redactions`. The hook
// loads it only for a payload ./gate.ts says may hold a secret.
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
import type { SpoolLine } from "../core/types.ts";
import { paths } from "../core/paths.ts";

// node:fs is called through its module object, so a test that replaces fs.writeSync reaches these calls.
const fs = process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");

/**
 * A serialized line above this many bytes (1024 with its newline, hook.sh's
 * limit) moves `raw` to a side file. Both are redacted before they are written.
 * Ingest also rewrites side files with their secrets redacted once it has stored
 * their line (core/spool-scrub.ts), and a day file's short inline lines in place
 * once the day has passed: hook.sh writes without redacting, and a repo config
 * can add rules.
 */
export const MAX_INLINE_LINE_BYTES = 1023;

/**
 * Agent ids become directory names: keep them path-safe. A name Windows keeps for a device
 * (`con`, `nul.txt`) or one ending in a dot, which Windows drops, would not name its own folder.
 */
export function safeAgentId(agent: string | undefined): string {
  const a = (agent ?? "").trim().toLowerCase();
  const ok = /^[a-z0-9][a-z0-9._-]{0,63}$/.test(a) && !a.includes("..") && !a.endsWith(".");
  return ok && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/.test(a) ? a : "unknown";
}

export function spoolDir(agent: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).spool, safeAgentId(agent));
}

/**
 * The UTC day of `ts` as toISOString() writes it (YYYY-MM-DD). The hook names a spool
 * file on every event, and the first toISOString() call in its process took about 0.8 ms
 * on Windows; the getters take a hundredth of that.
 */
export function utcDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  // toISOString() writes these years with a sign and six digits, and throws for an invalid date.
  if (!(y >= 0 && y <= 9999)) return d.toISOString().slice(0, 10);
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${String(y).padStart(4, "0")}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
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
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st || st.size < SPOOL_FILE_CAP) return file;
  }
  return join(dir, `${day}.p${pid}.jsonl`);
}

function openAppend(file: string, dir: string): number {
  try {
    return fs.openSync(file, "a+", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return fs.openSync(file, "a+", 0o600);
  }
}

/**
 * Cuts the file back to `size`. A descriptor opened for append holds no write access on
 * Windows (FILE_APPEND_DATA only), so ftruncate on it fails there: truncate through a
 * second descriptor opened for writing.
 */
function truncateTo(fd: number, file: string, size: number): void {
  try {
    fs.ftruncateSync(fd, size);
  } catch {
    const w = fs.openSync(file, "r+");
    try {
      fs.ftruncateSync(w, size);
    } finally {
      fs.closeSync(w);
    }
  }
}

/** O_APPEND write of `data`, on a fresh line even when the file ends in a torn fragment. */
function append(file: string, dir: string, data: string): void {
  const fd = openAppend(file, dir);
  try {
    let buf = Buffer.from(data);
    const { size } = fs.fstatSync(fd);
    if (size > 0) {
      const last = Buffer.alloc(1);
      if (fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) buf = Buffer.concat([Buffer.from("\n"), buf]);
    }
    let off = 0;
    try {
      while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      // Cut short (ENOSPC, EIO): take the fragment back off, since hook.sh appends without
      // looking at the file's end and its next line would be glued onto it. Only when the
      // file ends where this write stopped: a line another hook appended since stays.
      if (off > 0) {
        try {
          if (fs.fstatSync(fd).size === size + off) truncateTo(fd, file, size);
        } catch {
          // the fragment stays; readers skip it as a torn line
        }
      }
      throw e;
    }
  } finally {
    try {
      fs.closeSync(fd);
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
    text = fs.readFileSync(join(spoolDir, "disabled-sessions"), "utf8");
  } catch {
    return new Set();
  }
  return new Set(text.split("\n").map((l) => l.trim()).filter((l) => SESSION_ID_RE.test(l)));
}

/**
 * Redacts a line before appendSpool writes it. Returns the line with its payload
 * redacted, and the text a side file stores in place of `rawText`.
 * spoolLineRedactor() in ./redact.ts makes one from the user's config.
 */
export type RedactLine = (line: SpoolLine, rawText: string | undefined) => { line: SpoolLine; rawText: string | undefined };

export interface AppendOptions {
  /**
   * The payload exactly as received (e.g. stdin text). When given, a side file
   * stores these bytes verbatim instead of re-serializing `line.raw`.
   */
  rawText?: string;
  /** Redacts the line before any of it is written. */
  redact: RedactLine;
}

/**
 * Append one SpoolLine. Returns the spool file written, or undefined when
 * capture is disabled (CODING_SH_DISABLE=1). Throws on I/O errors; the hook
 * catches and logs them.
 *
 * When the serialized line exceeds MAX_INLINE_LINE_BYTES, `raw` is written to
 * `<agent>/raw/<ts>-<pid>-<rand>.json`, removed from the line, and the absolute
 * side-file path is set as `rawFile`. Side-file contents: `rawText` verbatim
 * when provided and nothing in it was redacted, else JSON.stringify(raw). Readers recover `raw` with
 * resolveRaw(): JSON.parse the file, falling back to the plain string — the
 * same rule the hook applies to stdin. A line with no `raw` and a `rawText` (the
 * hook leaves a payload too long to inline unparsed) always takes a side file, even
 * when redaction has made the text short enough to inline.
 */
export function appendSpool(line: SpoolLine, env: NodeJS.ProcessEnv, opts: AppendOptions): string | undefined {
  if (isDisabled(env)) return undefined;
  const agent = safeAgentId(line.agent);
  const dir = spoolDir(agent, env);
  const file = spoolFile(agent, line.ts, env, line.pid);
  const redacted = opts.redact(line, opts.rawText);
  line = redacted.line;
  const rawText = redacted.rawText;

  let out: string | undefined;
  // With no raw, the payload is in rawText alone: inlining the line would drop it.
  const rawTooBig = rawText !== undefined && (line.raw === undefined || Buffer.byteLength(rawText) > MAX_INLINE_LINE_BYTES);
  if (!rawTooBig) {
    out = JSON.stringify(line);
    if (Buffer.byteLength(out) > MAX_INLINE_LINE_BYTES) out = undefined;
  }
  if (out === undefined) {
    const rawDir = join(dir, "raw");
    const rand = Math.random().toString(36).slice(2, 10);
    const rawFile = join(rawDir, `${line.ts}-${line.pid}-${rand}.json`);
    const body = rawText ?? JSON.stringify(line.raw ?? null);
    try {
      fs.writeFileSync(rawFile, body, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      fs.mkdirSync(rawDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(rawFile, body, { mode: 0o600, flag: "wx" });
    }
    const { raw: _raw, ...rest } = line;
    try {
      append(file, dir, JSON.stringify({ ...rest, rawFile }) + "\n");
    } catch (e) {
      // Nothing will ever reference the side file: don't leave the payload (prompts, secrets) behind.
      fs.rmSync(rawFile, { force: true });
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
  const text = fs.readFileSync(line.rawFile, "utf8");
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
