// One call that gives CLI commands and the viewer everything they need:
// effective config, paths, opened stores and sinks, and a single close().
import { existsSync } from "node:fs";
import type { BlobStore, Config, IndexStore, Sink } from "./types.ts";
import { loadConfig } from "./config.ts";
import { paths } from "./paths.ts";
import { clearIngestStopped } from "./ingest-health.ts";
import { fileUrlPath, openStores, parseStoreUrl } from "../store/factory.ts";
import { LockBusyError } from "./lock.ts";
import type { BackfillProgress, BackfillResult, IngestOptions, IngestResult } from "./ingest.ts";
import type { GcOptions, GcResult } from "./gc.ts";
import type { ReparseOptions, ReparseResult } from "./reparse.ts";

export interface Context {
  config: Config;
  paths: ReturnType<typeof paths>;
  /** The environment the context was opened with (paths, child processes). */
  env: NodeJS.ProcessEnv;
  index: IndexStore;
  blobs: BlobStore;
  sinks: Sink[];
  /**
   * True when CODING_SH_STORE_URL / CODING_SH_BLOB_URL (or the global `--store`/`--blobs`
   * flags) point this process at another store. Reads then skip autoIngest, so a local
   * agent spool is never pushed into a shared production database.
   */
  storeOverridden: boolean;
  /** Drains the spool through the adapters' normalize into the index and sinks (lazy-loads adapters). */
  ingest(opts?: Pick<IngestOptions, "lock" | "checkpointEvents" | "now" | "deadline" | "signal" | "onProgress" | "repair">): Promise<IngestResult>;
  /** Imports agents' local transcript history (adapter.backfill), skipping copies live capture already has, and sends what it stores to the sinks. */
  backfill(opts?: { agents?: string[]; since?: number; deadline?: number; onProgress?: (p: BackfillProgress) => void }): Promise<BackfillResult>;
  /** Rebuilds sessions stored by an older adapter parse (or every one with `all`) from their transcripts and spool. */
  reparse(opts?: Pick<ReparseOptions, "all" | "agents" | "onProgress" | "runLock">): Promise<ReparseResult>;
  /** True when sessions stored by an older adapter parse wait for an automatic re-parse (cheap once none do). */
  reparseDue(): Promise<boolean>;
  /** Blob/spool/judge-cache garbage collection with the effective config. */
  gc(opts?: Pick<GcOptions, "dryRun" | "compact" | "minBlobAgeMs" | "judgeCacheMaxBytes" | "llmCacheMaxBytes">): Promise<GcResult>;
  close(): Promise<void>;
}

export interface OpenContextOptions {
  env?: NodeJS.ProcessEnv;
  /** Apply the per-repo override found above this directory. */
  cwd?: string;
  /** Use this config instead of loading one (tests, embedding). */
  config?: Config;
  /**
   * false: a read. A SQLite file named by --store or CODING_SH_STORE_URL that does not
   * exist throws StoreMissingError instead of being created (a typo makes no new store).
   * Default true: the store is created on first use.
   */
  create?: boolean;
}

/** The index store URL from --store / CODING_SH_STORE_URL, if one overrides the config. */
const storeUrlOverride = (env: NodeJS.ProcessEnv): string | undefined => env.CODING_SH_STORE_URL?.trim() || undefined;

/** The next step when the store does not open: check what named it (never echoing a URL, which may hold a password). */
export function storeOpenNext(env: NodeJS.ProcessEnv): string[] {
  return storeUrlOverride(env) ? ["Check the store URL given with --store or set in CODING_SH_STORE_URL"] : ["Check the [store] section of the config:", "coding.sh config path"];
}

/** A read named a SQLite store (--store / CODING_SH_STORE_URL) that does not exist; nothing was created. */
export class StoreMissingError extends Error {
  readonly reason = "store_missing";
  readonly path: string;
  readonly next: string[];
  constructor(path: string) {
    super(`No coding.sh store at ${path}. Nothing was created there`);
    this.name = "StoreMissingError";
    this.path = path;
    this.next = ["Check the path given with --store or set in CODING_SH_STORE_URL"];
  }
}

/** The SQLite file a read would create: the --store / CODING_SH_STORE_URL one, when it is missing. */
function missingStoreFile(env: NodeJS.ProcessEnv): string | undefined {
  const url = storeUrlOverride(env);
  if (!url) return undefined;
  const { scheme, rest } = parseStoreUrl(url);
  if (scheme !== "sqlite" || rest === ":memory:") return undefined;
  const file = fileUrlPath(rest);
  return existsSync(file) ? undefined : file;
}

export async function openContext(opts: OpenContextOptions = {}): Promise<Context> {
  const env = opts.env ?? process.env;
  if (opts.create === false) {
    const missing = missingStoreFile(env);
    if (missing) throw new StoreMissingError(missing);
  }
  const config = opts.config ?? loadConfig({ env, cwd: opts.cwd });
  const { index, blobs, sinks } = await openStores(config);
  let closed = false;
  const p = paths(env);
  const ctx: Context = {
    config,
    paths: p,
    env,
    index,
    blobs,
    sinks,
    storeOverridden: !!(storeUrlOverride(env) || env.CODING_SH_BLOB_URL?.trim()),
    async ingest(o = {}) {
      // Lazy: adapters and ingest are only loaded by commands that need them.
      const [{ ingest }, { ADAPTERS }] = await Promise.all([import("./ingest.ts"), import("../adapters/index.ts")]);
      const r = await ingest({ ...o, config, index, blobs, sinks, env, spoolDir: p.spool, adapters: new Map(ADAPTERS.map((a) => [a.id, a])) });
      // An ingest ran, so whatever stopped the hook's is over, unless the blob store stopped this one too.
      if (r.storeWriteFailed === undefined) clearIngestStopped(p.ingestStopped);
      return r;
    },
    async backfill(o = {}) {
      const [{ backfill }, { ADAPTERS }] = await Promise.all([import("./ingest.ts"), import("../adapters/index.ts")]);
      const chosen = o.agents?.length ? ADAPTERS.filter((a) => o.agents!.includes(a.id)) : ADAPTERS;
      return backfill({ config, index, blobs, sinks, env, adapters: chosen, ...(o.since !== undefined ? { since: o.since } : {}), ...(o.deadline !== undefined ? { deadline: o.deadline } : {}), ...(o.onProgress ? { onProgress: o.onProgress } : {}) });
    },
    async reparse(o = {}) {
      const [{ reparse }, { ADAPTERS }] = await Promise.all([import("./reparse.ts"), import("../adapters/index.ts")]);
      // Between its lock holds, a re-parse ingests what hooks and reads left waiting (another ingest running: skip).
      const onWake = async () => {
        await ctx.ingest({ lock: { waitMs: 0 } }).catch((e: unknown) => {
          if (!(e instanceof LockBusyError)) throw e;
        });
      };
      return reparse({ onWake, ...o, config, index, blobs, env, spoolDir: p.spool, adapters: new Map(ADAPTERS.map((a) => [a.id, a])) });
    },
    async reparseDue() {
      const [{ reparseDue }, { ADAPTERS }] = await Promise.all([import("./reparse.ts"), import("../adapters/index.ts")]);
      return reparseDue(index, new Map(ADAPTERS.map((a) => [a.id, a])));
    },
    async gc(o = {}) {
      const { gc } = await import("./gc.ts");
      return gc({ ...o, index, blobs, config, env, spoolDir: p.spool });
    },
    async close() {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([...sinks.map((s) => s.close?.()), index.close(), blobs.close?.()]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
  return ctx;
}
