// coding.sh-store-clickhouse: the clickhouse:// (and clickhouses://, TLS) index
// store. The core factory loads this package by naming convention
// (coding.sh-store-<scheme>), so installing it next to coding.sh is enough:
//
//   CODING_SH_STORE_URL=clickhouses://user:pass@host:8443/coding coding.sh serve
//
// It talks to ClickHouse's HTTP interface with fetch and has no dependencies.
// There is no ClickHouse blob store: blobs stay on the configured blob store
// (file:// by default, s3:// for a team server).
import type { IndexStore } from "coding.sh/store";
import { ChIndexStore } from "./index-store.ts";

export { ChIndexStore, likeTerms, searchText, type ChIndexOptions } from "./index-store.ts";
export { ChClient, ChError, encodeParam, parseChUrl, quoteLiteral, redactUrl, CH_SCHEMA_VERSION } from "./client.ts";

/** Index store factory for the core plugin loader: (url, config) → migrated store. */
export const indexStore = (url: string, _config?: unknown): Promise<IndexStore> => ChIndexStore.open(url);
