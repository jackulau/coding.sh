// BlobStore on Postgres: content-addressed rows (sha256 of the uncompressed
// bytes), zstd-compressed like the filesystem store. Lets a deployment keep
// everything in one database; s3:// is the better fit for large volumes.
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { assertBlobRef, sha256Hex, toBytes, type BlobMeta, type BlobRef, type BlobStore } from "coding.sh/store";
import { acquirePool, migrateSchema, openError, parsePgUrl, quoteIdent, releasePool } from "./pool.ts";

const LIST_PAGE = 1000;

export interface PgBlobOptions {
  /** zstd level for new blobs (default 3, as the filesystem store). */
  level?: number;
  /** Test hook: drop the whole schema on close. */
  dropSchemaOnClose?: boolean;
}

export class PgBlobStore implements BlobStore {
  readonly kind = "postgres";
  readonly schema: string;
  private readonly entry: ReturnType<typeof acquirePool>;
  private readonly table: string;
  private readonly opts: PgBlobOptions;
  private closed = false;

  private constructor(url: string, opts: PgBlobOptions) {
    const parsed = parsePgUrl(url);
    this.schema = parsed.schema;
    this.opts = opts;
    this.entry = acquirePool(parsed);
    this.table = `${quoteIdent(parsed.schema)}.blobs`;
  }

  /**
   * Connects and makes sure the schema exists. The core factory does not call
   * migrate() on blob stores, so open() does; the migrations are shared with
   * the index store and are a no-op when it already ran them.
   */
  static async open(url: string, opts: PgBlobOptions = {}): Promise<PgBlobStore> {
    const store = new PgBlobStore(url, opts);
    try {
      await migrateSchema(store.entry, store.schema);
    } catch (err) {
      await store.close().catch(() => {});
      throw openError(url, err);
    }
    return store;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.opts.dropSchemaOnClose) {
        await this.entry.pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(this.schema)} CASCADE`);
        this.entry.migrated.delete(this.schema);
      }
    } finally {
      await releasePool(this.entry);
    }
  }

  /**
   * Write-once. A dedupe hit refreshes created_at (as the filesystem store
   * touches mtime), so gc's minimum-age guard also protects a blob that an
   * ingest has just re-referenced.
   */
  async put(data: Uint8Array | string, _meta?: BlobMeta): Promise<BlobRef> {
    const bytes = toBytes(data);
    const ref = sha256Hex(bytes);
    const now = Date.now();
    const touched = await this.entry.pool.query(`UPDATE ${this.table} SET created_at = $2 WHERE ref = $1`, [ref, now]);
    if ((touched.rowCount ?? 0) > 0) return ref;
    const compressed = zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: this.opts.level ?? 3 } });
    await this.entry.pool.query(
      `INSERT INTO ${this.table} (ref, data, size, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (ref) DO NOTHING`,
      [ref, compressed, compressed.byteLength, now],
    );
    return ref;
  }

  async get(ref: BlobRef): Promise<Uint8Array | undefined> {
    assertBlobRef(ref);
    const { rows } = await this.entry.pool.query<{ data: Buffer }>(`SELECT data FROM ${this.table} WHERE ref = $1`, [ref]);
    if (!rows[0]) return undefined;
    try {
      const out = zstdDecompressSync(rows[0].data);
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    } catch (err) {
      throw new Error(`blob ${ref} is corrupt: ${(err as Error).message}`);
    }
  }

  async getText(ref: BlobRef): Promise<string | undefined> {
    const b = await this.get(ref);
    return b ? new TextDecoder().decode(b) : undefined;
  }

  async has(refs: BlobRef[]): Promise<boolean[]> {
    if (!refs.length) return [];
    for (const r of refs) assertBlobRef(r);
    const { rows } = await this.entry.pool.query<{ ref: string }>(`SELECT ref FROM ${this.table} WHERE ref = ANY($1::text[])`, [[...new Set(refs)]]);
    const found = new Set(rows.map((r) => r.ref));
    return refs.map((r) => found.has(r));
  }

  async *list(): AsyncIterable<BlobRef> {
    for (let after = "";;) {
      const { rows } = await this.entry.pool.query<{ ref: string }>(
        `SELECT ref FROM ${this.table} WHERE ref > $1 ORDER BY ref LIMIT ${LIST_PAGE}`,
        [after],
      );
      for (const r of rows) yield r.ref;
      if (rows.length < LIST_PAGE) return;
      after = rows[rows.length - 1]!.ref;
    }
  }

  async delete(ref: BlobRef): Promise<void> {
    assertBlobRef(ref);
    await this.entry.pool.query(`DELETE FROM ${this.table} WHERE ref = $1`, [ref]);
  }

  /** Total compressed bytes. */
  async size(): Promise<number> {
    const { rows } = await this.entry.pool.query<{ n: number | null }>(`SELECT sum(size)::bigint AS n FROM ${this.table}`);
    return rows[0]?.n ?? 0;
  }

  /** Compressed size and created_at (refreshed on dedupe hits), which gc reads as the blob's age. */
  async stat(ref: BlobRef): Promise<{ size: number; mtimeMs: number } | undefined> {
    assertBlobRef(ref);
    const { rows } = await this.entry.pool.query<{ size: number; created_at: number }>(`SELECT size, created_at FROM ${this.table} WHERE ref = $1`, [ref]);
    return rows[0] ? { size: rows[0].size, mtimeMs: rows[0].created_at } : undefined;
  }
}
