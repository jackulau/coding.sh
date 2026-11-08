// Transcript readers: streaming JSONL, tail reads, and bounded directory walks.
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface JsonlRecord {
  value: unknown;
  /** 0-based line number; stable across re-reads, used for deterministic ids. */
  lineNo: number;
  /** Byte offset of the line start (assumes "\n" line endings). */
  offset: number;
}

/** Streams parsed JSON lines; blank and unparseable lines are skipped (lineNo still advances). */
export async function* readJsonl(path: string): AsyncGenerator<JsonlRecord> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNo = -1;
  let offset = 0;
  try {
    for await (const line of rl) {
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
  } finally {
    rl.close();
  }
}

/** Parses the complete JSON lines within the last `maxBytes` of a file (oldest first). */
export async function readJsonlTail(path: string, maxBytes = 256 * 1024): Promise<unknown[]> {
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

/** Depth-bounded walk yielding matching files sorted by path (deterministic order). Missing root → nothing. */
export async function* walkFiles(root: string, opts: WalkOpts, depth = 0): AsyncGenerator<WalkedFile> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const p = join(root, e.name);
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
