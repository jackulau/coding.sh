// The spool writer: shared by the hook (src/spool/hook.ts, bundled to
// dist/hook.mjs) and the `coding.sh run` wrapper (src/capture/wrapper.ts).
//
// This file is on the hook's hot path. It may only import node:fs, node:path
// (and node:os via ../core/paths.ts) and type-only imports.
//
// On-disk layout (all under dataHome()/spool):
//   <agent>/<yyyy-mm-dd>.<pid>.jsonl   one SpoolLine per line (date is UTC)
//   <agent>/raw/<ts>-<pid>-<rand>.json side file for payloads too big to inline
//   errors.log                         one JSON object per line, hook failures
//
// Concurrency: each writing process appends to its own per-pid file, so lines
// from concurrent hooks can never interleave. Within a file, appendFileSync opens
// with O_APPEND, so every write(2) lands at the current end of file atomically
// with respect to other appenders (and writes < PIPE_BUF are never split on local
// filesystems). A pid reused later by another hook simply appends after the
// previous owner's last complete line.
//
// Files are created 0600 and dirs 0700: payloads can hold prompts and secrets.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpoolLine } from "../core/types.ts";
import { paths } from "../core/paths.ts";

/** A serialized line above this many bytes moves `raw` to a side file. */
export const MAX_INLINE_LINE_BYTES = 256 * 1024;

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

export function spoolFile(agent: string, ts: number, pid: number, env: NodeJS.ProcessEnv = process.env): string {
  return join(spoolDir(agent, env), `${utcDay(ts)}.${pid}.jsonl`);
}

function append(file: string, dir: string, data: string): void {
  try {
    appendFileSync(file, data, { mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(file, data, { mode: 0o600 });
  }
}

export function isDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODING_SH_DISABLE === "1" || env.CODING_SH_DISABLE === "true";
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
  const file = join(dir, `${utcDay(line.ts)}.${line.pid}.jsonl`);

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
    out = JSON.stringify({ ...rest, rawFile });
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
