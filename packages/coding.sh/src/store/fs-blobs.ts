// Default BlobStore: <root>/ab/cd/<sha256>.zst, zstd level 3, content-addressed
// by the sha256 of the *uncompressed* bytes. Writes go to a temp file that is
// fsynced, renamed into place and the directory fsynced, so readers never see a
// partial blob, a power loss never leaves a torn one behind a durable index row,
// and concurrent puts of the same content are harmless (identical bytes win).
// Reads verify the sha256: a copy that does not match its ref reads as missing,
// and the next put of that content rewrites it.
import { link, mkdir, readdir, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { BlobRef } from "../schema/index.ts";
import type { BlobMeta, BlobStore } from "../core/types.ts";
import { sha256Hex } from "../core/ids.ts";
import { assertBlobRef, blobPath, toBytes } from "./common.ts";
import { syncDir, writeFileDurable } from "./durable.ts";

/** Temp files put and recompress write before the rename: `<sha>.zst.<pid>.<hex>.tmp`. */
const TMP_NAME = /^[0-9a-f]{64}\.zst\.\d+\.[0-9a-f]+\.tmp$/;

export interface FsBlobStoreOptions {
  /** zstd level for new blobs (default 3; `gc --compact` may rewrite at 19). */
  level?: number;
}

export class FsBlobStore implements BlobStore {
  readonly kind = "file";
  readonly root: string;
  private readonly level: number;

  constructor(root: string, opts: FsBlobStoreOptions = {}) {
    this.root = root;
    this.level = opts.level ?? 3;
  }

  pathFor(ref: BlobRef): string {
    assertBlobRef(ref);
    return join(this.root, ...blobPath(ref));
  }

  async put(data: Uint8Array | string, _meta?: BlobMeta): Promise<BlobRef> {
    const bytes = toBytes(data);
    const ref = sha256Hex(bytes);
    const file = this.pathFor(ref);
    // A dedupe hit refreshes mtime so gc's age guard protects a blob that was just
    // re-referenced by an ingest racing the sweep. A stored copy that is empty or
    // fails verification (torn by a power loss) is rewritten instead.
    if ((await this.read(ref, file)) !== undefined && (await touch(file))) return ref;
    const dir = dirname(file);
    const created = await mkdir(dir, { recursive: true });
    const compressed = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: this.level } });
    await writeFileDurable(file, compressed);
    // Directories mkdir just made (ab/, ab/cd/) must be durable in their parents too.
    if (created !== undefined) for (let d = dir; d.length >= created.length; d = dirname(d)) await syncDir(dirname(d));
    return ref;
  }

  /**
   * The verified content of a blob: undefined when the file is missing, does not
   * decompress, or does not hash to its ref, so a torn write never reads as empty bytes.
   */
  async get(ref: BlobRef): Promise<Uint8Array | undefined> {
    return this.read(ref, this.pathFor(ref));
  }

  private async read(ref: BlobRef, file: string): Promise<Uint8Array | undefined> {
    let compressed: Buffer;
    try {
      compressed = await readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    let out: Buffer;
    try {
      out = zstdDecompressSync(compressed);
    } catch {
      return undefined;
    }
    // zstd returns an empty buffer for a truncated frame, so only the hash proves the content.
    if (sha256Hex(out) !== ref) return undefined;
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }

  async getText(ref: BlobRef): Promise<string | undefined> {
    const b = await this.get(ref);
    return b ? new TextDecoder().decode(b) : undefined;
  }

  async has(refs: BlobRef[]): Promise<boolean[]> {
    return Promise.all(refs.map(async (ref) => {
      try {
        await stat(this.pathFor(ref));
        return true;
      } catch {
        return false;
      }
    }));
  }

  async *list(): AsyncIterable<BlobRef> {
    for (const a of await listDir(this.root)) {
      if (!/^[0-9a-f]{2}$/.test(a)) continue;
      for (const b of await listDir(join(this.root, a))) {
        if (!/^[0-9a-f]{2}$/.test(b)) continue;
        for (const name of await listDir(join(this.root, a, b))) {
          const m = /^([0-9a-f]{64})\.zst$/.exec(name);
          if (m && m[1]!.startsWith(a + b)) yield m[1]!;
        }
      }
    }
  }

  async delete(ref: BlobRef): Promise<void> {
    try {
      await unlink(this.pathFor(ref));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * gc's delete: removes the blob only if nothing re-captured it in the last
   * `olderThanMs`, atomically with respect to concurrent puts (backfill, otel,
   * eval writers hold no lock shared with gc). The blob is renamed to a temp
   * name first, so a dedupe-hit put either touched it before the rename (the
   * re-stat sees a fresh mtime and the blob is linked back) or finds it missing
   * and writes it anew. A crash mid-way leaves an old temp file for sweepTmp.
   * Returns the bytes removed, "kept" when re-captured, or undefined when already gone.
   */
  async deleteIfOlder(ref: BlobRef, opts: { olderThanMs: number; now?: number }): Promise<number | "kept" | undefined> {
    const file = this.pathFor(ref);
    const trash = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await rename(file, trash);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const s = await stat(trash);
    if ((opts.now ?? Date.now()) - s.mtimeMs < opts.olderThanMs) {
      // Re-captured since gc's stat: put it back unless a put already rewrote it.
      await link(trash, file).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
      await unlink(trash);
      return "kept";
    }
    await unlink(trash);
    return s.size;
  }

  async size(): Promise<number> {
    let total = 0;
    for await (const ref of this.list()) total += (await this.stat(ref))?.size ?? 0;
    return total;
  }

  /** Compressed size on disk and mtime (refreshed on dedupe hits). */
  async stat(ref: BlobRef): Promise<{ size: number; mtimeMs: number } | undefined> {
    try {
      const s = await stat(this.pathFor(ref));
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /** Re-compresses a blob at a higher level (for `gc --compact`). Returns bytes saved. */
  async recompress(ref: BlobRef, level = 19): Promise<number> {
    const before = await this.stat(ref);
    const data = await this.get(ref);
    if (!before || !data) return 0;
    const compressed = zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: level } });
    if (compressed.byteLength >= before.size) return 0;
    await writeFileDurable(this.pathFor(ref), compressed);
    return before.size - compressed.byteLength;
  }

  /**
   * Removes temp files that a crashed put or recompress left behind (never renamed
   * into place, so nothing can reference them) once older than `olderThanMs`;
   * younger ones may belong to a put still in flight. gc calls this with its blob
   * age guard. Returns what was (or, with dryRun, would be) removed.
   */
  async sweepTmp(opts: { olderThanMs: number; now?: number; dryRun?: boolean }): Promise<{ files: number; bytes: number }> {
    const now = opts.now ?? Date.now();
    const out = { files: 0, bytes: 0 };
    for (const a of await listDir(this.root)) {
      if (!/^[0-9a-f]{2}$/.test(a)) continue;
      for (const b of await listDir(join(this.root, a))) {
        if (!/^[0-9a-f]{2}$/.test(b)) continue;
        for (const name of await listDir(join(this.root, a, b))) {
          if (!TMP_NAME.test(name)) continue;
          const file = join(this.root, a, b, name);
          let s;
          try {
            s = await stat(file);
          } catch {
            continue; // renamed into place or removed meanwhile
          }
          if (now - s.mtimeMs < opts.olderThanMs) continue;
          if (!opts.dryRun) await unlink(file).catch(() => {});
          out.files++;
          out.bytes += s.size;
        }
      }
    }
    return out;
  }
}

/** Refreshes mtime; false when the file vanished (gc removed it) after it was read. */
async function touch(file: string): Promise<boolean> {
  try {
    const now = new Date();
    await utimes(file, now, now);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
