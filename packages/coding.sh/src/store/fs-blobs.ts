// Default BlobStore: <root>/ab/cd/<sha256>.zst, zstd level 3, content-addressed
// by the sha256 of the *uncompressed* bytes. Writes go to a temp file and are
// renamed into place, so readers never see a partial blob and concurrent puts
// of the same content are harmless (identical bytes win either way).
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { BlobRef } from "../schema/index.ts";
import type { BlobMeta, BlobStore } from "../core/types.ts";
import { sha256Hex } from "../core/ids.ts";
import { assertBlobRef, blobPath, toBytes } from "./common.ts";

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
    if (await this.touchIfExists(file)) return ref;
    const dir = join(this.root, ref.slice(0, 2), ref.slice(2, 4));
    await mkdir(dir, { recursive: true });
    const compressed = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: this.level } });
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, compressed, { flag: "wx" });
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return ref;
  }

  /**
   * A dedupe hit refreshes mtime so gc's age guard protects a blob that was
   * just re-referenced by an ingest racing the sweep.
   */
  private async touchIfExists(file: string): Promise<boolean> {
    try {
      const now = new Date();
      await utimes(file, now, now);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async get(ref: BlobRef): Promise<Uint8Array | undefined> {
    const file = this.pathFor(ref);
    let compressed: Buffer;
    try {
      compressed = await readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    try {
      const out = zstdDecompressSync(compressed);
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    } catch (err) {
      throw new Error(`blob ${ref} is corrupt (${file}): ${(err as Error).message}`);
    }
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
    const file = this.pathFor(ref);
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(compressed);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
    return before.size - compressed.byteLength;
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
