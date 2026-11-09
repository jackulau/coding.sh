// Default BlobStore: zstd level 3, content-addressed by the sha256 of the
// *uncompressed* bytes. A blob whose compressed form is under PACK_MAX_BYTES is a
// row of <root>/pack.db (SQLite, WAL); a larger one is a file, <root>/ab/cd/<sha256>.zst.
//
// Why the pack: most blobs are small (a hook line's raw payload is a few hundred
// bytes), and a file of its own costs a whole 4 KiB disk block plus a temp file,
// a rename and an fsync of the data and of its directory. A pack row costs its
// bytes, and a batch of them commits with one fsync. Reads look in the pack, then
// for a file, so a store written before the pack (all files) reads as it did. Pack
// commits are synchronous=FULL (and fullfsync on macOS): a put() that resolves is
// durable, as for a file. Rows are never torn (SQLite transactions); reads still
// verify the sha256.
//
// Files: Writes go to a temp file that is
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
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { link, mkdir, readdir, stat, unlink, utimes } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { BlobRef } from "../schema/index.ts";
import type { BlobBatch, BlobMeta, BlobStore } from "../core/types.ts";
import { sha256Hex } from "../core/ids.ts";
import { assertBlobRef, blobPath, toBytes } from "./common.ts";
import { renameOver, syncDir, writeFileDurable, writeTemp } from "./durable.ts";
import { loadSqlite, switchToWal } from "./sqlite-open.ts";

/** Temp files put and recompress write before the rename: `<sha>.zst.<pid>.<hex>.tmp`. */
const TMP_NAME = /^[0-9a-f]{64}\.zst\.\d+\.[0-9a-f]+\.tmp$/;

/** Temp-file writes a batch keeps in flight, and directories a commit syncs at once. */
const BATCH_PARALLEL = 16;

/** A blob whose zstd frame is smaller than this (one disk block) is a pack row, not a file. */
export const PACK_MAX_BYTES = 4096;
/** The pack's file name in the root. */
export const PACK_FILE = "pack.db";
/** Raw sizes at or under this always compress to under PACK_MAX_BYTES (zstd adds a few dozen bytes at most). */
const SURELY_PACKED_BYTES = PACK_MAX_BYTES - 128;

/** A blob compressed for the pack, not yet written. */
interface Packed {
  ref: BlobRef;
  data: Uint8Array;
  /** Kept from the file it came from (compact); a put stamps the time of the write. */
  mtime?: number;
}

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
  /** Compressed size under which a blob goes in the pack (default PACK_MAX_BYTES; 0 writes every blob as a file). */
  packMaxBytes?: number;
}

export class FsBlobStore implements BlobStore {
  readonly kind = "file";
  readonly root: string;
  private readonly level: number;
  private readonly packMaxBytes: number;
  private readonly pack: BlobPack;

  constructor(root: string, opts: FsBlobStoreOptions = {}) {
    this.root = root;
    this.level = opts.level ?? 3;
    this.packMaxBytes = Math.min(opts.packMaxBytes ?? PACK_MAX_BYTES, PACK_MAX_BYTES);
    this.pack = new BlobPack(join(root, PACK_FILE));
  }

  /** Closes the pack (the next use opens it again). */
  async close(): Promise<void> {
    this.pack.close();
  }

  pathFor(ref: BlobRef): string {
    assertBlobRef(ref);
    return join(this.root, ...blobPath(ref));
  }

  async put(data: Uint8Array | string, _meta?: BlobMeta): Promise<BlobRef> {
    const bytes = toBytes(data);
    const ref = sha256Hex(bytes);
    const staged = await this.stage(ref, bytes);
    if (staged && "data" in staged) await this.pack.write([staged]);
    else if (staged) await this.commit([staged]);
    return ref;
  }

  /**
   * A small blob comes back compressed for the pack: writing its row is the
   * dedupe too (an existing row gets a fresh mtime, and its bytes again).
   * Otherwise a dedupe hit on the file refreshes mtime so gc's age guard
   * protects a blob that was just re-referenced by an ingest racing the sweep,
   * and needs nothing more. A stored copy that is empty or fails verification
   * (torn by a power loss) is rewritten: the compressed bytes go to a flushed
   * temp file beside the blob's path.
   */
  private async stage(ref: BlobRef, bytes: Uint8Array): Promise<Staged | Packed | undefined> {
    const compress = () => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: this.level } });
    // Packed whatever it compresses to: no file to look for.
    if (bytes.byteLength <= SURELY_PACKED_BYTES && this.packMaxBytes === PACK_MAX_BYTES) return { ref, data: compress() };
    const file = this.pathFor(ref);
    // existsSync first: a miss (the usual case on ingest) costs no thrown ENOENT.
    if (existsSync(file) && (await this.read(ref, file)) !== undefined && (await touch(file))) return undefined;
    const compressed = compress();
    if (compressed.byteLength < this.packMaxBytes) return { ref, data: compressed };
    const created = await mkdir(dirname(file), { recursive: true });
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
    // ref → its write, settled with the staged blob (a temp file, or a pack row still to write; undefined for a dedupe hit) or the error.
    const writes = new Map<BlobRef, Promise<Staged | Packed | { error: unknown } | undefined>>();
    const inFlight = new Set<Promise<unknown>>();
    const stagedFor = async (ref: BlobRef): Promise<Staged | Packed | undefined> => {
      const w = await writes.get(ref);
      return w && !("error" in w) ? w : undefined;
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
        if (s && "data" in s) return verified(ref, s.data);
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
        // Pack rows (one transaction) and files both land even when the other fails; the first error is thrown after.
        let packFailed: { error: unknown } | undefined;
        try {
          await store.pack.write(settled.filter((w): w is Packed => !!w && "data" in w));
        } catch (error) {
          packFailed = { error };
        }
        await store.commit(settled.filter((w): w is Staged => !!w && "tmp" in w));
        if (failed) throw failed.error;
        if (packFailed) throw packFailed.error;
      },
    };
  }

  /**
   * The verified content of a blob: undefined when the file is missing, does not
   * decompress, or does not hash to its ref, so a torn write never reads as empty bytes.
   */
  async get(ref: BlobRef): Promise<Uint8Array | undefined> {
    const packed = await this.pack.get(ref);
    return (packed && verified(ref, packed)) || this.read(ref, this.pathFor(ref));
  }

  private async read(ref: BlobRef, file: string): Promise<Uint8Array | undefined> {
    let compressed: Buffer;
    try {
      // Read in one synchronous call: a blob is small and local, its decompress
      // and hash below are synchronous anyway, and the promise readFile's four
      // thread-pool round trips cost more than the read when a proxied request
      // is rebuilt from dozens of message blocks.
      compressed = readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    return verified(ref, compressed);
  }

  async getText(ref: BlobRef): Promise<string | undefined> {
    const b = await this.get(ref);
    return b ? new TextDecoder().decode(b) : undefined;
  }

  async has(refs: BlobRef[]): Promise<boolean[]> {
    const packed = await this.pack.has(refs);
    return Promise.all(refs.map(async (ref, i) => {
      if (packed[i]) return true;
      try {
        await stat(this.pathFor(ref));
        return true;
      } catch {
        return false;
      }
    }));
  }

  /** Pack rows, then files (a ref in both is listed once). */
  async *list(): AsyncIterable<BlobRef> {
    yield* this.pack.list();
    for await (const ref of this.listFiles()) if (!(await this.pack.has([ref]))[0]) yield ref;
  }

  private async *listFiles(): AsyncIterable<BlobRef> {
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
    await this.pack.delete(ref);
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
    // A pack row goes in one statement: a put that re-captured it since gc's stat has moved its mtime past the cutoff.
    const packed = await this.pack.deleteIfOlder(ref, (opts.now ?? Date.now()) - opts.olderThanMs);
    if (packed !== undefined) return packed;
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
    let total = await this.pack.size();
    for await (const ref of this.listFiles()) total += (await this.fileStat(ref))?.size ?? 0;
    return total;
  }

  /** Compressed size and mtime (refreshed on dedupe hits). */
  async stat(ref: BlobRef): Promise<{ size: number; mtimeMs: number } | undefined> {
    return (await this.pack.stat(ref)) ?? this.fileStat(ref);
  }

  private async fileStat(ref: BlobRef): Promise<{ size: number; mtimeMs: number } | undefined> {
    try {
      const s = await stat(this.pathFor(ref));
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  /**
   * `gc --compact` and purge. Moves the file blobs small enough for the pack into
   * it (a store written before the pack had every blob as a file), keeping their
   * mtime; a file goes only after its row is committed, and one that fails
   * verification stays for a re-put to heal. Then rewrites the pack and empties
   * its WAL, so rows deleted from it leave no bytes on disk. Returns the files moved.
   */
  async compact(): Promise<{ packed: number }> {
    let packed = 0;
    if (this.packMaxBytes === PACK_MAX_BYTES) {
      let rows: Packed[] = [];
      let files: string[] = [];
      const move = async () => {
        await this.pack.write(rows);
        for (const f of files) await unlink(f).catch(() => {});
        packed += rows.length;
        rows = [];
        files = [];
      };
      for await (const ref of this.listFiles()) {
        const file = this.pathFor(ref);
        let data: Buffer;
        let mtime: number;
        try {
          const st = await stat(file);
          if (st.size >= this.packMaxBytes) continue;
          mtime = Math.round(st.mtimeMs);
          data = readFileSync(file);
        } catch {
          continue; // removed meanwhile
        }
        if (data.byteLength >= this.packMaxBytes || !verified(ref, data)) continue;
        rows.push({ ref, data, mtime });
        files.push(file);
        if (rows.length >= 1000) await move();
      }
      await move();
    }
    await this.pack.vacuum();
    return { packed };
  }

  /** Re-compresses a blob at a higher level (for `gc --compact`). Returns bytes saved. */
  async recompress(ref: BlobRef, level = 19): Promise<number> {
    const before = await this.stat(ref);
    const data = await this.get(ref);
    if (!before || !data) return 0;
    const compressed = zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: level } });
    if (compressed.byteLength >= before.size) return 0;
    if (await this.pack.stat(ref)) await this.pack.write([{ ref, data: compressed }]);
    else await writeFileDurable(this.pathFor(ref), compressed);
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

/** How long a pack statement waits for another process's write. */
const PACK_BUSY_TIMEOUT_MS = 5000;

/**
 * <root>/pack.db: the small blobs, one row each (ref as its 32 bytes, mtime in ms,
 * the zstd frame). Opened on first use, so reading a store with no pack creates
 * nothing, and kept open until FsBlobStore.close().
 */
class BlobPack {
  readonly path: string;
  private db: DatabaseSync | undefined;
  private opening: Promise<DatabaseSync> | undefined;
  private readonly stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    this.path = path;
  }

  /** The open pack, or undefined when there is none yet and `create` is false. */
  private async open(create: boolean): Promise<DatabaseSync | undefined> {
    if (this.db) return this.db;
    if (!create && !this.opening && !existsSync(this.path)) return undefined;
    this.opening ??= this.connect().finally(() => (this.opening = undefined));
    return this.opening;
  }

  private async connect(): Promise<DatabaseSync> {
    const { DatabaseSync } = await loadSqlite();
    await mkdir(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);
    try {
      db.exec(`PRAGMA busy_timeout = ${PACK_BUSY_TIMEOUT_MS}`);
      await switchToWal(db);
      // A commit is on disk when it returns (on macOS through the drive's cache too), as a blob file is once put() resolves.
      db.exec("PRAGMA synchronous = FULL; PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON;");
      db.exec("CREATE TABLE IF NOT EXISTS blobs (ref BLOB PRIMARY KEY, mtime INTEGER NOT NULL, data BLOB NOT NULL)");
    } catch (e) {
      db.close();
      throw e;
    }
    this.db = db;
    return db;
  }

  private stmt(db: DatabaseSync, sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = db.prepare(sql)));
    return s;
  }

  /**
   * Writes rows in one transaction. An existing row gets the bytes again and the
   * later of the two mtimes: a dedupe hit refreshes it, and compact moving in an
   * old file never ages a row a put just refreshed.
   */
  async write(rows: Packed[]): Promise<void> {
    if (!rows.length) return;
    const db = (await this.open(true))!;
    const upsert = this.stmt(db, "INSERT INTO blobs (ref, mtime, data) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET mtime = max(mtime, excluded.mtime), data = excluded.data");
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) upsert.run(key(r.ref), r.mtime ?? now, r.data);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async get(ref: BlobRef): Promise<Uint8Array | undefined> {
    const k = key(ref);
    const db = await this.open(false);
    const row = db && (this.stmt(db, "SELECT data FROM blobs WHERE ref = ?").get(k) as { data: Uint8Array } | undefined);
    return row ? row.data : undefined;
  }

  async has(refs: BlobRef[]): Promise<boolean[]> {
    const keys = refs.map(key);
    const db = await this.open(false);
    if (!db) return refs.map(() => false);
    const s = this.stmt(db, "SELECT 1 AS x FROM blobs WHERE ref = ?");
    return keys.map((k) => s.get(k) !== undefined);
  }

  async stat(ref: BlobRef): Promise<{ size: number; mtimeMs: number } | undefined> {
    const k = key(ref);
    const db = await this.open(false);
    const row = db && (this.stmt(db, "SELECT length(data) AS size, mtime FROM blobs WHERE ref = ?").get(k) as { size: number; mtime: number } | undefined);
    return row ? { size: row.size, mtimeMs: row.mtime } : undefined;
  }

  async *list(): AsyncIterable<BlobRef> {
    const db = await this.open(false);
    if (!db) return;
    const page = this.stmt(db, "SELECT ref FROM blobs WHERE ref > ? ORDER BY ref LIMIT 1000");
    for (let after: Uint8Array = new Uint8Array(0); ;) {
      const rows = page.all(after) as { ref: Uint8Array }[];
      if (!rows.length) return;
      for (const r of rows) yield Buffer.from(r.ref).toString("hex");
      after = rows[rows.length - 1]!.ref;
    }
  }

  async delete(ref: BlobRef): Promise<void> {
    const k = key(ref);
    const db = await this.open(false);
    if (db) this.stmt(db, "DELETE FROM blobs WHERE ref = ?").run(k);
  }

  /** Bytes removed when the row's mtime is at or before `cutoff`; "kept" when it is newer; undefined when there is no row. */
  async deleteIfOlder(ref: BlobRef, cutoff: number): Promise<number | "kept" | undefined> {
    const k = key(ref);
    const db = await this.open(false);
    if (!db) return undefined;
    const gone = this.stmt(db, "DELETE FROM blobs WHERE ref = ? AND mtime <= ? RETURNING length(data) AS size").get(k, cutoff) as { size: number } | undefined;
    if (gone) return gone.size;
    return this.stmt(db, "SELECT 1 AS x FROM blobs WHERE ref = ?").get(k) ? "kept" : undefined;
  }

  async size(): Promise<number> {
    const db = await this.open(false);
    return db ? Number((this.stmt(db, "SELECT coalesce(sum(length(data)), 0) AS n FROM blobs").get() as { n: number }).n) : 0;
  }

  /** Copies the WAL in, rewrites the file without free pages, and empties the WAL. */
  async vacuum(): Promise<void> {
    const db = await this.open(false);
    if (!db) return;
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.stmts.clear();
    this.db?.close();
    this.db = undefined;
  }
}

/** A ref as the pack stores it: its 32 bytes. */
function key(ref: BlobRef): Uint8Array {
  assertBlobRef(ref);
  return Buffer.from(ref, "hex");
}

/**
 * The content of a zstd frame when it hashes to `ref`: undefined when it does not
 * decompress or holds other bytes (zstd returns an empty buffer for a truncated
 * frame, so only the hash proves the content).
 */
function verified(ref: BlobRef, compressed: Uint8Array): Uint8Array | undefined {
  let out: Buffer;
  try {
    out = zstdDecompressSync(compressed);
  } catch {
    return undefined;
  }
  if (sha256Hex(out) !== ref) return undefined;
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
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
