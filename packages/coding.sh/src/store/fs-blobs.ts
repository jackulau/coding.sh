// Default BlobStore: <root>/ab/cd/<sha256>.zst, zstd level 3, content-addressed
// by the sha256 of the *uncompressed* bytes. Writes go to a temp file that is
// flushed (durable.ts writeTemp), renamed into place and the directory fsynced,
// so readers never see a partial blob, a power loss never leaves a torn one
// behind a durable index row, and concurrent puts of the same content are
// harmless (identical bytes win). Reads verify the sha256: a copy that does not
// match its ref reads as missing, and the next put of that content rewrites it.
//
// batch() is the bulk path (ingest): puts write their temp files in the
// background, a few at a time, and flush() renames them all into place and
// fsyncs each directory that gained an entry once, so the cost is per batch,
// not per put, and the guarantee is put()'s. On macOS one F_FULLFSYNC of the
// root covers the batch: the temp files' data is already on the drive, and an
// APFS/HFS+ fsync commits the volume's metadata (the renames) with it; this is
// git's core.fsyncMethod=batch, which git documents as safe there. A batch
// abandoned before flush() leaves temp files that sweepTmp removes.
import { existsSync } from "node:fs";
import { link, mkdir, readdir, readFile, stat, unlink, utimes } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { BlobRef } from "../schema/index.ts";
import type { BlobBatch, BlobMeta, BlobStore } from "../core/types.ts";
import { sha256Hex } from "../core/ids.ts";
import { assertBlobRef, blobPath, toBytes } from "./common.ts";
import { renameOver, syncDir, writeFileDurable, writeTemp } from "./durable.ts";

/** Temp files put and recompress write before the rename: `<sha>.zst.<pid>.<hex>.tmp`. */
const TMP_NAME = /^[0-9a-f]{64}\.zst\.\d+\.[0-9a-f]+\.tmp$/;

/** Temp-file writes a batch keeps in flight, and directories a commit syncs at once. */
const BATCH_PARALLEL = 16;

/** A blob written to a flushed temp file, not yet renamed into place. */
interface Staged {
  ref: BlobRef;
  file: string;
  tmp: string;
  /** The first directory mkdir created for it, if any (its parents need a sync too). */
  created?: string;
}

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
    const staged = await this.stage(ref, bytes);
    if (staged) await this.commit([staged]);
    return ref;
  }

  /**
   * A dedupe hit refreshes mtime so gc's age guard protects a blob that was just
   * re-referenced by an ingest racing the sweep, and needs nothing more. A stored
   * copy that is empty or fails verification (torn by a power loss) is rewritten:
   * the compressed bytes go to a flushed temp file beside the blob's path.
   */
  private async stage(ref: BlobRef, bytes: Uint8Array): Promise<Staged | undefined> {
    const file = this.pathFor(ref);
    // existsSync first: a miss (the usual case on ingest) costs no thrown ENOENT.
    if (existsSync(file) && (await this.read(ref, file)) !== undefined && (await touch(file))) return undefined;
    const created = await mkdir(dirname(file), { recursive: true });
    const compressed = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: this.level } });
    const tmp = await writeTemp(file, compressed);
    return created === undefined ? { ref, file, tmp } : { ref, file, tmp, created };
  }

  /** Renames staged blobs into place, then fsyncs every directory that gained an entry, each once (macOS: the root, once). */
  private async commit(staged: Staged[]): Promise<void> {
    if (!staged.length) return;
    const dirs = new Set<string>();
    const renamed = new Set<Staged>();
    try {
      await eachLimit(staged, BATCH_PARALLEL, async (s) => {
        // A concurrent put of the same content may win the rename; its verified copy is as good as ours.
        await renameOver(s.tmp, s.file, async () => (await this.read(s.ref, s.file)) !== undefined);
        renamed.add(s);
        const dir = dirname(s.file);
        dirs.add(dir);
        // Directories mkdir just made (ab/, ab/cd/) must be durable in their parents too.
        if (s.created !== undefined) for (let d = dir; d.length >= s.created.length; d = dirname(d)) dirs.add(dirname(d));
      });
    } catch (err) {
      for (const s of staged) if (!renamed.has(s)) await unlink(s.tmp).catch(() => {});
      throw err;
    }
    await eachLimit(process.platform === "darwin" ? [this.root] : [...dirs], BATCH_PARALLEL, syncDir);
  }

  /**
   * Write-behind puts for a bulk writer (see the header): put() returns the ref
   * once the data is hashed, and reads through the batch see unflushed blobs.
   */
  batch(): BlobBatch {
    const store = this;
    // ref → its temp-file write, settled with the staged blob (undefined for a dedupe hit) or the error.
    const writes = new Map<BlobRef, Promise<Staged | { error: unknown } | undefined>>();
    const inFlight = new Set<Promise<unknown>>();
    const stagedFor = async (ref: BlobRef): Promise<Staged | undefined> => {
      const w = await writes.get(ref);
      return w && "tmp" in w ? w : undefined;
    };
    return {
      kind: store.kind,
      async put(data) {
        const bytes = toBytes(data);
        const ref = sha256Hex(bytes);
        if (writes.has(ref)) return ref;
        while (inFlight.size >= BATCH_PARALLEL) await Promise.race(inFlight);
        const w = store.stage(ref, bytes).catch((error: unknown) => ({ error }));
        writes.set(ref, w);
        inFlight.add(w);
        void w.then(() => inFlight.delete(w));
        return ref;
      },
      async get(ref) {
        const s = writes.has(ref) ? await stagedFor(ref) : undefined;
        return s ? store.read(ref, s.tmp) : store.get(ref);
      },
      async getText(ref) {
        const b = await this.get(ref);
        return b ? new TextDecoder().decode(b) : undefined;
      },
      async has(refs) {
        const stored = await store.has(refs);
        return refs.map((r, i) => stored[i]! || writes.has(r));
      },
      list: () => store.list(),
      delete: (ref) => store.delete(ref),
      size: () => store.size(),
      stat: (ref) => store.stat(ref),
      async flush() {
        const settled = await Promise.all(writes.values());
        writes.clear();
        const failed = settled.find((w): w is { error: unknown } => !!w && "error" in w);
        await store.commit(settled.filter((w): w is Staged => !!w && "tmp" in w));
        if (failed) throw failed.error;
      },
    };
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
      await renameOver(file, trash);
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

/** Runs `fn` over `items`, at most `limit` at a time; rejects with the first error once all have settled. */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  let failed: { error: unknown } | undefined;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (error) {
        failed ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failed.error;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
