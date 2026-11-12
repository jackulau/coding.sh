// Reads hook spool files incrementally from a byte cursor.
//
// The hook appends whole lines with O_APPEND, but a reader can still observe a
// line mid-write. A final line without "\n" is therefore not consumed while it
// is fresh: the returned nextOffset stops before it and the next ingest picks
// it up whole. One still incomplete after TORN_TAIL_MS is a torn write (ENOSPC,
// EIO, a killed writer): it is reported and skipped, so the cursor reaches the
// end of the file and gc can remove it. The node writer starts its next line on a
// fresh line after such a fragment (spool/write.ts); hook.sh appends without
// looking, so a whole line glued onto a fragment is read from where it starts.
import { readdirSync, statSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SpoolLine } from "./types.ts";

export interface SpoolFile {
  /** Cursor key: path relative to the spool dir, "/"-separated (e.g. "codex/2026-11-06.123.jsonl"). */
  source: string;
  path: string;
  agent: string;
  size: number;
  mtimeMs: number;
}

export interface SpoolRecord {
  source: string;
  line: SpoolLine;
  /** Byte offset where this line starts. */
  offset: number;
  /** Byte offset just past this line's "\n" — the cursor value once it is processed. */
  nextOffset: number;
}

export interface SpoolReadError {
  source: string;
  offset: number;
  nextOffset: number;
  message: string;
}

/** A trailing line without "\n" in a file untouched this long is a torn write, not one in progress. */
export const TORN_TAIL_MS = 60 * 60_000;

export interface ReadSpoolOptions {
  /** Called for lines that are skipped (bad JSON/shape) or degraded (missing rawFile). */
  onError?: (err: SpoolReadError) => void;
  /** Read buffer size; small values are useful in tests. */
  chunkSize?: number;
  /** Load rawFile side files into line.raw (default true). */
  resolveRaw?: boolean;
  /** Clock for the torn-tail age check (default Date.now). */
  now?: () => number;
}

const toSource = (spoolDir: string, file: string) => relative(spoolDir, file).split(sep).join("/");

const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})\./;

/** The UTC day a spool file's name starts with (`2026-11-06` for `2026-11-06.jsonl`), or "" for another name. */
export function spoolFileDay(name: string): string {
  return DAY_PREFIX.exec(name)?.[1] ?? "";
}

/**
 * Lists `<spool>/<agent>/*.jsonl`, oldest first within each agent: by the UTC
 * day in the name, then mtime, then name. Hooks share `<day>.jsonl` and its
 * numbered continuations (`<day>.1.jsonl`, … — 9 and 10 sort the wrong way as
 * strings); older versions wrote one `<day>.<pid>.jsonl` per hook call, where
 * the pid says nothing about order. mtime is when the last line was written,
 * so a tool.start is normally read before its tool.end.
 *
 * Stats are synchronous: a week of hook calls is tens of thousands of files,
 * and one awaited stat each costs a thread-pool round trip (seconds on a big
 * spool, against well under a second for statSync).
 */
export async function listSpoolFiles(spoolDir: string): Promise<SpoolFile[]> {
  const out: SpoolFile[] = [];
  let agents: string[];
  try {
    agents = readdirSync(spoolDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  for (const agent of agents.sort()) {
    const dir = join(spoolDir, agent);
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const files: (SpoolFile & { day: string; name: string })[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const s = statSync(path);
        if (!s.isFile()) continue;
        files.push({ source: `${agent}/${name}`, path, agent, size: s.size, mtimeMs: s.mtimeMs, day: spoolFileDay(name), name });
      } catch {
        // Deleted between readdir and stat (gc in another process): skip.
      }
    }
    files.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
    for (const { day: _d, name: _n, ...f } of files) out.push(f);
  }
  return out;
}

/** Resolves a rawFile reference, refusing paths that escape the spool dir. */
export function resolveRawFile(spoolDir: string, spoolFile: string, rawFile: string): string {
  const root = resolve(spoolDir);
  const p = isAbsolute(rawFile) ? resolve(rawFile) : resolve(spoolFile, "..", rawFile);
  if (p !== root && !p.startsWith(root + sep)) throw new Error(`rawFile ${JSON.stringify(rawFile)} is outside the spool directory`);
  return p;
}

function validate(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "spool line is not a JSON object";
  const o = v as Record<string, unknown>;
  if (typeof o.agent !== "string" || !o.agent) return "spool line has no agent";
  if (typeof o.event !== "string") return "spool line has no event";
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return "spool line has no numeric ts";
  return undefined;
}

/** How every writer starts a spool line (hook.sh and JSON.stringify of a SpoolLine). */
const LINE_START = '{"v":0,"agent":"';

/**
 * A whole spool line glued onto a torn fragment: a write cut short (a full disk)
 * left a fragment with no "\n", and the next writer appended its line right
 * after it. Returns the first later line start that parses, with its index in `text`.
 */
function gluedLine(text: string): { line: unknown; at: number } | undefined {
  for (let at = text.indexOf(LINE_START, 1); at > 0; at = text.indexOf(LINE_START, at + 1)) {
    try {
      const line: unknown = JSON.parse(text.slice(at));
      if (!validate(line)) return { line, at };
    } catch {
      // not this one: the fragment's payload may hold the same characters
    }
  }
  return undefined;
}

/**
 * Yields complete lines of one spool file starting at byte `from`. Blank lines
 * are skipped silently; malformed lines are reported via onError and skipped.
 */
export async function* readSpoolFile(spoolDir: string, file: string, from = 0, opts: ReadSpoolOptions = {}): AsyncGenerator<SpoolRecord> {
  const source = toSource(spoolDir, file);
  const chunkSize = opts.chunkSize ?? 1 << 16;
  const fh = await open(file, "r");
  try {
    let pos = from; // file offset of buf[0]
    let buf: Buffer = Buffer.alloc(0);
    let eof = false;
    while (!eof || buf.length) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (eof) {
          // Trailing partial line: in progress (leave it for the next run), or torn long ago.
          const { mtimeMs } = await fh.stat();
          if ((opts.now ?? Date.now)() - mtimeMs > TORN_TAIL_MS) {
            opts.onError?.({ source, offset: pos, nextOffset: pos + buf.length, message: `incomplete last line (${buf.length} bytes, unchanged for over an hour): a torn write, skipped` });
          }
          return;
        }
        const chunk = Buffer.allocUnsafe(chunkSize);
        const { bytesRead } = await fh.read(chunk, 0, chunkSize, pos + buf.length);
        if (bytesRead === 0) eof = true;
        else buf = buf.length ? Buffer.concat([buf, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        continue;
      }
      const offset = pos;
      const nextOffset = pos + nl + 1;
      const text = buf.toString("utf8", 0, nl).replace(/\r$/, "");
      buf = buf.subarray(nl + 1);
      pos = nextOffset;
      if (!text.trim()) continue;
      let parsed: unknown;
      let lineOffset = offset;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        const glued = gluedLine(text);
        opts.onError?.({ source, offset, nextOffset, message: `invalid JSON: ${(err as Error).message}${glued ? "; the whole line after the torn fragment is kept" : ""}` });
        if (!glued) continue;
        parsed = glued.line;
        lineOffset = offset + Buffer.byteLength(text.slice(0, glued.at));
      }
      const problem = validate(parsed);
      if (problem) {
        opts.onError?.({ source, offset, nextOffset, message: problem });
        continue;
      }
      const line = parsed as SpoolLine;
      if (line.rawFile && line.raw === undefined && opts.resolveRaw !== false) {
        try {
          const rawText = await readFile(resolveRawFile(spoolDir, file, line.rawFile), "utf8");
          try {
            line.raw = JSON.parse(rawText);
          } catch {
            line.raw = rawText;
          }
        } catch (err) {
          // Keep the line (its event/ts/cwd still matter) but flag the missing payload.
          opts.onError?.({ source, offset: lineOffset, nextOffset, message: `cannot read rawFile ${line.rawFile}: ${(err as Error).message}` });
        }
      }
      yield { source, line, offset: lineOffset, nextOffset };
    }
  } finally {
    await fh.close();
  }
}

/** Raw-file paths referenced by a spool file's lines (for gc). */
export async function rawFilesOf(spoolDir: string, file: string): Promise<string[]> {
  const out: string[] = [];
  for await (const rec of readSpoolFile(spoolDir, file, 0, { resolveRaw: false })) {
    if (!rec.line.rawFile) continue;
    try {
      out.push(resolveRawFile(spoolDir, file, rec.line.rawFile));
    } catch {
      // Outside the spool dir: never ours to delete.
    }
  }
  return out;
}
