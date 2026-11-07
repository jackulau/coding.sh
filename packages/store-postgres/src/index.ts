// coding.sh-store-postgres: the postgres:// (and postgresql://) index and blob
// stores. The core factory loads this package by naming convention
// (coding.sh-store-<scheme>), so installing it next to coding.sh is enough:
//
//   CODING_SH_STORE_URL=postgres://user:pass@host:5432/db?sslmode=require coding.sh serve
//
// Blobs default to the same database when the index is postgres://.
import type { BlobStore, IndexStore } from "coding.sh/store";
import { PgBlobStore } from "./blob-store.ts";
import { PgIndexStore } from "./index-store.ts";

export { PgBlobStore, type PgBlobOptions } from "./blob-store.ts";
export { PgIndexStore, searchFolded, tsQuery, type PgIndexOptions } from "./index-store.ts";
export { parsePgUrl, redactUrl, PG_SCHEMA_VERSION } from "./pool.ts";

/** Index store factory for the core plugin loader: (url, config) → migrated store. */
export const indexStore = (url: string, _config?: unknown): Promise<IndexStore> => PgIndexStore.open(url);

/** Blob store factory for the core plugin loader. */
export const blobStore = (url: string, _config?: unknown): Promise<BlobStore> => PgBlobStore.open(url);
