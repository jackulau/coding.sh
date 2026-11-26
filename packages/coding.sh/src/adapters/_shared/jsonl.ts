// Transcript readers: streaming JSONL, tail reads, and bounded directory walks.
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Transform } from "node:stream";
import * as zlib from "node:zlib";

export interface JsonlRecord {
  value: unknown;
  /** 0-based line number; stable across re-reads, used for deterministic ids. */
  lineNo: number;
  /** Byte offset of the line start (assumes "\n" line endings). */
  offset: number;
}

export function isZst(path: string): boolean {
  return path.endsWith(".zst");
}

let warnedNoZstd = false;

/**
 * Lines of a text file, "
" or "

" ended. A `.zst` file is decompressed as it streams. A truncated or
 * corrupt `.zst` ends after the lines decoded before the cut and never throws; so does a runtime without zstd
 * (one warning). A plain file's read errors still throw.
 */
async function* readLines(path: string): AsyncGenerator<string> {
  let input: NodeJS.ReadableStream;
  if (isZst(path)) {
    const make = (zlib as { createZstdDecompress?: () => Transform }).createZstdDecompress;
    if (typeof make !== "function") {
      if (!warnedNoZstd) {
        warnedNoZstd = true;
        process.stderr.write(`coding.sh: this Node has no zstd support (zlib.createZstdDecompress); skipping ${path}
`);
      }
      return;
    }
    const src = createReadStream(path);
    const dec = make();
    dec.on("error", () => {}); // reported through the iteration below
    src.on("error", (e) => dec.destroy(e));
    src.pipe(dec);
    dec.setEncoding("utf8");
    input = dec;
  } else {
    input = createReadStream(path, { encoding: "utf8" });
  }
  try {
    yield* splitLines(input as AsyncIterable<string>);
  } catch (e) {
    if (!isZst(path)) throw e;
  } finally {
    (input as { destroy?: () => void }).destroy?.();
  }
}

/**
 * Lines of a text stream, split on LF only (a CR before it is dropped). Not node:readline: it also
 * splits on U+2028 and U+2029, which JSON allows raw inside a string, so a transcript line holding one
 * came out as two halves that neither parse, and the line was lost.
 */
export async function* splitLines(input: AsyncIterable<string>): AsyncGenerator<string> {
  let parts: string[] = []; // the current line's text so far, from earlier chunks
  for await (const raw of input) {
    const chunk = String(raw);
    let start = 0;
    for (let i = chunk.indexOf("\n"); i >= 0; i = chunk.indexOf("\n", start)) {
      let line = chunk.slice(start, i);
      if (parts.length) {
        line = parts.join("") + line;
        parts = [];
      }
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
      start = i + 1;
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  }
  if (parts.length) {
    const line = parts.join("");
    yield line.endsWith("\r") ? line.slice(0, -1) : line;
  }
}

/** Streams parsed JSON lines; blank and unparseable lines are skipped (lineNo still advances). Reads `.zst` too. */
export async function* readJsonl(path: string): AsyncGenerator<JsonlRecord> {
  let lineNo = -1;
  let offset = 0;
  for await (const line of readLines(path)) {
    lineNo++;
    const start = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    yield { value, lineNo, offset: start };
  }
}

/** The first `maxBytes` of a file as text, and whether the file goes on past them (then its last line may be cut short); unreadable → undefined. */
export async function readHead(path: string, maxBytes: number): Promise<{ text: string; more: boolean } | undefined> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = (await fh.stat()).size;
    const buf = Buffer.alloc(Math.min(maxBytes, size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { text: buf.subarray(0, bytesRead).toString("utf8"), more: size > bytesRead };
  } catch {
    return undefined;
  } finally {
    await fh.close();
  }
}

/** The first `maxBytes` of a file as text (the last line may be cut short); unreadable → undefined. */
export async function readHeadText(path: string, maxBytes: number): Promise<string | undefined> {
  return (await readHead(path, maxBytes))?.text;
}

/** The file's first line, parsed, when it ends within `maxBytes`; else (or unreadable) undefined. */
export async function readJsonlHead(path: string, maxBytes = 1024 * 1024): Promise<unknown> {
  if (isZst(path)) {
    try {
      for await (const line of readLines(path)) return Buffer.byteLength(line) <= maxBytes ? JSON.parse(line) : undefined;
    } catch {
      // unreadable or corrupt
    }
    return undefined;
  }
  const text = await readHeadText(path, maxBytes);
  if (text === undefined) return undefined;
  const end = text.indexOf("\n");
  try {
    return JSON.parse(end < 0 ? text : text.slice(0, end));
  } catch {
    return undefined;
  }
}

/** Parses the complete JSON lines within the last `maxBytes` of a file (oldest first). */
export async function readJsonlTail(path: string, maxBytes = 256 * 1024): Promise<unknown[]> {
  if (isZst(path)) {
    // No seeking in a compressed file: stream it all and keep the last `maxBytes` of whole lines.
    const kept: string[] = [];
    let bytes = 0;
    try {
      for await (const l of readLines(path)) {
        kept.push(l);
        bytes += Buffer.byteLength(l) + 1;
        while (bytes > maxBytes && kept.length) bytes -= Buffer.byteLength(kept.shift()!) + 1;
      }
    } catch {
      // unreadable: keep what was read
    }
    const out: unknown[] = [];
    for (const l of kept) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        // corrupt line
      }
    }
    return out;
  }
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return [];
  }
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    let lines = buf.toString("utf8").split("\n");
    if (start > 0) lines = lines.slice(1); // first line is partial
    const out: unknown[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        // partial or corrupt line
      }
    }
    return out;
  } finally {
    await fh.close();
  }
}

export interface WalkedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface WalkOpts {
  match: (name: string, path: string) => boolean;
  maxDepth?: number;
  /** Skip files last modified before this (ms epoch). */
  since?: number;
  /** Skip directories by name. */
  skipDir?: (name: string, path: string) => boolean;
}

/** Subdirectories of the walk root listed ahead of the one being read. */
const WALK_LOOKAHEAD = 16;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** Depth-bounded walk yielding matching files sorted by path (deterministic order). Missing root → nothing. */
export async function* walkFiles(root: string, opts: WalkOpts, depth = 0): AsyncGenerator<WalkedFile> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // The top level of a big tree (tens of thousands of project dirs): the next few subdirectories are listed
  // while the current one is read, since each listing waits on the disk. Files still come out in path order.
  const ahead = new Map<string, Promise<WalkedFile[]>>();
  let started = 0;
  const prefetch = (from: number) => {
    if (depth !== 0) return;
    for (; started < entries.length && started < from + WALK_LOOKAHEAD; started++) {
      const e = entries[started]!;
      if (e.isDirectory() && !opts.skipDir?.(e.name, join(root, e.name)) && (opts.maxDepth ?? 8) > 0) {
        ahead.set(e.name, collect(walkFiles(join(root, e.name), opts, 1)));
      }
    }
  };
  for (const [i, e] of entries.entries()) {
    prefetch(i);
    const p = join(root, e.name);
    const listed = ahead.get(e.name);
    if (listed) {
      ahead.delete(e.name);
      yield* await listed;
      continue;
    }
    // A symlink (or a Windows junction) is followed to what it points at; maxDepth bounds a link cycle.
    let linked;
    if (e.isSymbolicLink()) {
      try {
        linked = await stat(p);
      } catch {
        continue; // dangling link
      }
    }
    if (linked ? linked.isDirectory() : e.isDirectory()) {
      if (opts.skipDir?.(e.name, p)) continue;
      if (depth < (opts.maxDepth ?? 8)) yield* walkFiles(p, opts, depth + 1);
    } else if ((linked ? linked.isFile() : e.isFile()) && opts.match(e.name, p)) {
      let st = linked;
      if (!st) {
        try {
          st = await stat(p);
        } catch {
          continue;
        }
      }
      if (opts.since !== undefined && st.mtimeMs < opts.since) continue;
      yield { path: p, mtimeMs: st.mtimeMs, size: st.size };
    }
  }
}

/** Parses an ISO timestamp / epoch seconds / epoch ms into ms, else fallback. */
export function toMs(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
    const n = Number(v);
    if (Number.isFinite(n)) return toMs(n, fallback);
  }
  return fallback;
}
