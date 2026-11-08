// One call that gives CLI commands and the viewer everything they need:
// effective config, paths, opened stores and sinks, and a single close().
import type { BlobStore, Config, IndexStore, Sink } from "./types.ts";
import { loadConfig } from "./config.ts";
import { paths } from "./paths.ts";
import { openStores } from "../store/factory.ts";
import { LockBusyError } from "./lock.ts";
import type { BackfillResult, IngestOptions, IngestResult } from "./ingest.ts";
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
  ingest(opts?: Pick<IngestOptions, "lock" | "checkpointEvents" | "now" | "deadline" | "signal" | "onProgress">): Promise<IngestResult>;
  /** Imports agents' local transcript history (adapter.backfill), skipping copies live capture already has. */
  backfill(opts?: { agents?: string[]; since?: number; deadline?: number }): Promise<BackfillResult>;
  /** Rebuilds sessions stored by an older adapter parse (or every one with `all`) from their transcripts and spool. */
  reparse(opts?: Pick<ReparseOptions, "all" | "agents" | "onProgress" | "runLock">): Promise<ReparseResult>;
  /** True when sessions stored by an older adapter parse wait for an automatic re-parse (cheap once none do). */
  reparseDue(): Promise<boolean>;
  /** Blob/spool/judge-cache garbage collection with the effective config. */
  gc(opts?: Pick<GcOptions, "dryRun" | "compact" | "minBlobAgeMs" | "judgeCacheMaxBytes">): Promise<GcResult>;
  close(): Promise<void>;
}

export interface OpenContextOptions {
  env?: NodeJS.ProcessEnv;
  /** Apply the per-repo override found above this directory. */
  cwd?: string;
  /** Use this config instead of loading one (tests, embedding). */
  config?: Config;
}

export async function openContext(opts: OpenContextOptions = {}): Promise<Context> {
  const env = opts.env ?? process.env;
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
    storeOverridden: !!(env.CODING_SH_STORE_URL?.trim() || env.CODING_SH_BLOB_URL?.trim()),
    async ingest(o = {}) {
      // Lazy: adapters and ingest are only loaded by commands that need them.
      const [{ ingest }, { ADAPTERS }] = await Promise.all([import("./ingest.ts"), import("../adapters/index.ts")]);
      return ingest({ ...o, config, index, blobs, sinks, env, spoolDir: p.spool, adapters: new Map(ADAPTERS.map((a) => [a.id, a])) });
    },
    async backfill(o = {}) {
      const [{ backfill }, { ADAPTERS }] = await Promise.all([import("./ingest.ts"), import("../adapters/index.ts")]);
      const chosen = o.agents?.length ? ADAPTERS.filter((a) => o.agents!.includes(a.id)) : ADAPTERS;
      return backfill({ config, index, blobs, env, adapters: chosen, ...(o.since !== undefined ? { since: o.since } : {}), ...(o.deadline !== undefined ? { deadline: o.deadline } : {}) });
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
      const results = await Promise.allSettled([...sinks.map((s) => s.close?.()), index.close()]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
  return ctx;
}
