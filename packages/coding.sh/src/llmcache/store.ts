// Recordings of model calls, one gzipped JSONL file per case-trial:
//   <dir>/<expId>/<sha256(caseId)[0:16]>-t<trial>.jsonl.gz
// Each line is one call's response (LlmEntry). Request headers, and so API
// keys, are never stored; the body is redacted before it is written.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { paths } from "../core/paths.ts";

export const LLM_ENTRY_VERSION = 1;

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** One recorded call: the response as the client got it, minus headers. */
export interface LlmEntry {
  v: number;
  /** 1-based position of the call among the case-trial's cached calls, in arrival order. */
  ordinal: number;
  provider: "anthropic" | "openai";
  /** Request path, e.g. /v1/messages. */
  path: string;
  /** llmCallKey of the request. */
  key: string;
  model?: string;
  status: number;
  contentType?: string;
  /** Response body (UTF-8 text, or base64 with bodyEncoding). */
  body: string;
  bodyEncoding?: "base64";
  startedAt: number;
  latencyMs: number;
  usage?: LlmUsage;
  /** The stored body had secrets replaced, so it differs from what the client got. */
  redacted?: true;
  /** This line was served from another recording (a replay records too). */
  replayed?: true;
}

export function llmCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return paths(env).llmCache;
}

const SAFE_ID = /^[\w.-]{1,200}$/;

/** The recording file of one case-trial of an experiment. */
export function recordingPath(dir: string, expId: string, caseId: string, trial: number): string {
  if (!SAFE_ID.test(expId) || expId === "." || expId === "..") throw new Error(`llm cache: bad experiment id ${JSON.stringify(expId)}`);
  if (!(Number.isInteger(trial) && trial >= 0)) throw new Error(`llm cache: bad trial ${trial}`);
  const h = createHash("sha256").update(caseId).digest("hex").slice(0, 16);
  return join(dir, expId, `${h}-t${trial}.jsonl.gz`);
}

/** The entries of a recording, in file order; undefined when there is none. A hit refreshes its mtime (gc is LRU). */
export async function readRecording(file: string): Promise<LlmEntry[] | undefined> {
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let text: string;
  try {
    text = gunzipSync(raw).toString("utf8");
  } catch {
    return undefined; // torn or corrupt: no recording
  }
  const now = new Date();
  await utimes(file, now, now).catch(() => {});
  const out: LlmEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LlmEntry;
      if (e && typeof e === "object" && typeof e.key === "string" && typeof e.body === "string" && typeof e.ordinal === "number") out.push(e);
    } catch {
      // a torn line ends the usable part
      break;
    }
  }
  return out;
}

/** Write a recording atomically (tmp file + rename). */
export async function writeRecording(file: string, entries: readonly LlmEntry[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const body = gzipSync(Buffer.from(entries.map((e) => JSON.stringify(e) + "\n").join(""), "utf8"));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, file);
}

/** The bytes of an entry's body. */
export function entryBytes(e: Pick<LlmEntry, "body" | "bodyEncoding">): Buffer {
  return e.bodyEncoding === "base64" ? Buffer.from(e.body, "base64") : Buffer.from(e.body, "utf8");
}

/** Body as stored: text when the bytes are UTF-8, else base64. */
export function storedBody(buf: Buffer): Pick<LlmEntry, "body" | "bodyEncoding"> {
  const text = buf.toString("utf8");
  return Buffer.from(text, "utf8").equals(buf) ? { body: text } : { body: buf.toString("base64"), bodyEncoding: "base64" };
}

/** Whether an experiment has any recording. */
export async function hasRecordings(dir: string, expId: string): Promise<boolean> {
  if (!SAFE_ID.test(expId)) return false;
  try {
    return (await readdir(join(dir, expId))).some((f) => f.endsWith(".jsonl.gz"));
  } catch {
    return false;
  }
}

/** Default size cap for the llm cache (gc drops least-recently-used recordings past it). */
export const DEFAULT_LLM_CACHE_MAX_BYTES = 1024 * 1024 * 1024;

export interface LlmCacheGcResult {
  scanned: number;
  /** Recordings removed (or that would be, in a dry run). */
  deleted: number;
  bytes: number;
  keptBytes: number;
}

/** Size-capped gc: past `maxBytes`, deletes the least recently used recordings first, then empty experiment dirs. */
export async function gcLlmCache(dir: string, opts: { maxBytes?: number; dryRun?: boolean } = {}): Promise<LlmCacheGcResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_LLM_CACHE_MAX_BYTES;
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  let exps: string[] = [];
  try {
    exps = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const exp of exps) {
    for (const f of await readdir(join(dir, exp)).catch(() => [] as string[])) {
      if (!f.endsWith(".jsonl.gz")) continue;
      const p = join(dir, exp, f);
      const s = await stat(p).catch(() => undefined);
      if (s?.isFile()) files.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
    }
  }
  let total = files.reduce((n, f) => n + f.size, 0);
  const result: LlmCacheGcResult = { scanned: files.length, deleted: 0, bytes: 0, keptBytes: total };
  if (total <= maxBytes) return result;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : 1));
  for (const f of files) {
    if (total <= maxBytes) break;
    if (!opts.dryRun) await unlink(f.path).catch(() => {});
    total -= f.size;
    result.deleted++;
    result.bytes += f.size;
  }
  if (!opts.dryRun) for (const exp of exps) await rmdir(join(dir, exp)).catch(() => {}); // only empty ones go
  result.keptBytes = total;
  return result;
}
