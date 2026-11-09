// Public surface for store plugins (`coding.sh/store`). A package named
// `coding.sh-store-<scheme>` exports `{ indexStore?, blobStore? }` factories;
// this module gives it the types and the shared helpers the built-in stores use
// (search text, snippets, blob refs), so every backend behaves the same way.
// Conformance suites live under `coding.sh/store/conformance`.
export type {
  BlobMeta,
  BlobStore,
  Config,
  DatasetListing,
  EvalTask,
  FacetCount,
  HarnessBundle,
  IndexStore,
  Label,
  QueryOpts,
  RunResult,
  SearchHit,
  SearchOpts,
  SessionFilter,
  WriterLock,
} from "../core/types.ts";
export type { AgentEvent, AgentId, BlobRef, Session, Usage } from "../schema/index.ts";
export type { Dataset, DatasetVersionInfo, ExperimentResult, JudgeVersion } from "../datasets/types.ts";
export type { BlobStoreFactory, IndexStoreFactory, StorePlugin } from "./factory.ts";
export type { BlobRefField } from "./common.ts";
// `--where`: the parsed query and the key table a store compiles to its own SQL (querySessions, queryFacets).
export type { Cmp, KeyDef, Node, Query, Value } from "../query/where.ts";
export { HAS, IS, KEYS, levelOf, QueryError, QueryUnsupported } from "../query/where.ts";
export {
  BLOB_REF_FIELDS,
  MESSAGE_SEARCH_KINDS,
  SEARCHABLE_KINDS,
  SNIPPET_CLOSE,
  SNIPPET_ELLIPSIS,
  SNIPPET_OPEN,
  TOOL_SEARCH_TEXT_CAP,
  assertBlobRef,
  blobPath,
  bundleBlobs,
  foldTerm,
  ftsQuery,
  refsAt,
  runBlobs,
  searchTerms,
  searchableText,
  snippet,
  storedSearchText,
  taskBlobs,
  termMatches,
  toBytes,
} from "./common.ts";
export { sha256Hex } from "../core/ids.ts";
/** Project every event and session belongs to when none is set. */
export const DEFAULT_PROJECT = "default";
