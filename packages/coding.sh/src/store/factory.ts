// Chooses store implementations by URL scheme and sinks by kind.
//
// Built-ins: sqlite:// and memory:// (index), file:// and memory:// (blobs),
// otlp and http (sinks). Anything else is resolved from the registry, or from
// an npm package named by convention:
//   coding.sh-store-<scheme>  exporting { indexStore?, blobStore? } factories
//                             (postgresql:// loads coding.sh-store-postgres,
//                             clickhouses:// loads coding.sh-store-clickhouse)
//   coding.sh-sink-<kind>     exporting { sink } factory
import { tmpdir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import type { BlobStore, Config, IndexStore, Sink, SinkConfig } from "../core/types.ts";
import { expandHome } from "../core/paths.ts";
import { pricesFor } from "../core/pricing.ts";
import { deferReprice, priceStamp, REPRICE_CURSOR, repriceLock, repriceStored } from "../core/reprice.ts";
import { version } from "../cli/meta.ts";
import { ownerGuard } from "../core/store-guard.ts";
import { createHttpSink } from "../sinks/http.ts";
import { createOtlpSink } from "../sinks/otlp.ts";
import { sinceSink } from "../sinks/since.ts";
import { FsBlobStore } from "./fs-blobs.ts";
import { MemoryBlobStore, MemoryIndexStore } from "./memory.ts";
import { SqliteIndexStore } from "./sqlite.ts";
import { holdUpgradeLine, repriceTook } from "./upgrade.ts";

export type IndexStoreFactory = (url: string, config: Config) => IndexStore | Promise<IndexStore>;
export type BlobStoreFactory = (url: string, config: Config) => BlobStore | Promise<BlobStore>;
export type SinkFactory = (sink: SinkConfig, config: Config) => Sink | Promise<Sink>;

/** Shape a third-party package exports. */
export interface StorePlugin {
  indexStore?: IndexStoreFactory;
  blobStore?: BlobStoreFactory;
  sink?: SinkFactory;
}

const indexFactories = new Map<string, IndexStoreFactory>();
const blobFactories = new Map<string, BlobStoreFactory>();
const sinkFactories = new Map<string, SinkFactory>();

const normScheme = (s: string) => s.toLowerCase().replace(/:(\/\/)?$/, "");

export function registerIndexStore(scheme: string, factory: IndexStoreFactory): void {
  indexFactories.set(normScheme(scheme), factory);
}

export function registerBlobStore(scheme: string, factory: BlobStoreFactory): void {
  blobFactories.set(normScheme(scheme), factory);
}

export function registerSink(kind: string, factory: SinkFactory): void {
  sinkFactories.set(kind.toLowerCase(), factory);
}

/** Splits "scheme://rest" (throws a readable error otherwise). */
export function parseStoreUrl(url: string): { scheme: string; rest: string } {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (!m) throw new Error(`store URL ${JSON.stringify(url)} must look like scheme://… (e.g. sqlite://~/.coding.sh/index.db)`);
  return { scheme: m[1]!.toLowerCase(), rest: m[2]! };
}

/** Where a path is read: the platform, the environment and the temp dir (parameters, so tests run on every OS). */
export interface PathHost {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** The directory Git Bash mounts at /tmp (default os.tmpdir(): the user's %TEMP% on Windows). */
  tmp?: string;
}

/**
 * On Windows under Git Bash or another MSYS shell (MSYSTEM set), a path in the shell's
 * spelling as Windows spells it: `/tmp/x.db` is the shell's /tmp, the user's temp dir, and
 * `/c/data/x.db` is `C:\data\x.db`. The shell converts a path it is given as an argument,
 * but not one inside a URL (`--store sqlite:///tmp/x.db`), which Node then read as
 * `C:\tmp\x.db`. Any other path, and every path on another platform or shell, is returned as given.
 */
export function msysPath(p: string, host: PathHost = {}): string {
  const platform = host.platform ?? process.platform;
  const env = host.env ?? process.env;
  if (platform !== "win32" || !env.MSYSTEM) return p;
  const tmp = /^\/tmp(?:\/(.*))?$/s.exec(p);
  if (tmp) return win32.join(host.tmp ?? tmpdir(), tmp[1] ?? "");
  const drive = /^\/([A-Za-z])(?:\/(.*))?$/s.exec(p);
  if (drive) return win32.join(`${drive[1]!.toUpperCase()}:\\`, drive[2] ?? "");
  return p;
}

/**
 * Filesystem path from sqlite:///abs, sqlite://~/x or sqlite://relative (resolved against cwd).
 * A `user:password@` in front is not part of the path, and neither is the slash before a
 * Windows drive letter (`sqlite:///C:/data/index.db`). Under Git Bash on Windows, `/tmp/…`
 * and `/c/…` are the shell's paths (msysPath).
 */
export function fileUrlPath(rest: string, host: PathHost = {}): string {
  const platform = host.platform ?? process.platform;
  let p = decodeURIComponent(rest.replace(/[?#].*$/, "")).replace(/^[^/\\@:]+:[^/\\@]*@/, "");
  if (platform === "win32") p = p.replace(/^\/(?=[A-Za-z]:[\\/])/, "");
  p = msysPath(p, host);
  return (platform === "win32" ? win32 : posix).resolve(expandHome(p, host.env));
}

registerIndexStore("sqlite", (url, config) => {
  const { rest } = parseStoreUrl(url);
  if (rest === ":memory:") return SqliteIndexStore.open(":memory:");
  const file = fileUrlPath(rest);
  // A home's own index migrates only for the install that owns it, and only for a release
  // newer than its last writer, which every open records (core/store-guard.ts).
  const beforeMigrate = ownerGuard(config.home, file);
  return SqliteIndexStore.open(file, { writer: version(), beforeMigrate });
});
registerIndexStore("memory", () => new MemoryIndexStore());
registerBlobStore("file", (url) => new FsBlobStore(fileUrlPath(parseStoreUrl(url).rest)));
registerBlobStore("memory", () => new MemoryBlobStore());
registerSink("otlp", (s) => createOtlpSink(s));
registerSink("http", (s) => createHttpSink(s));

/**
 * Scheme spellings served by another scheme's plugin package: hosting platforms hand out
 * postgresql:// URLs, and clickhouses:// is ClickHouse over HTTPS.
 */
const PLUGIN_ALIASES: Record<string, string> = { postgresql: "postgres", clickhouses: "clickhouse" };
/** The canonical name of a scheme: `postgresql` → `postgres`, `clickhouses` → `clickhouse`; others unchanged. */
export const canonicalScheme = (scheme: string): string => PLUGIN_ALIASES[scheme] ?? scheme;
export const storePluginPackage = (scheme: string): string => `coding.sh-store-${canonicalScheme(scheme)}`;

async function loadPlugin(pkg: string): Promise<StorePlugin | undefined> {
  try {
    return (await import(pkg)) as StorePlugin;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      // Only "this package is missing" is swallowed; a broken plugin surfaces its own error.
      if (String((err as Error).message).includes(pkg)) return undefined;
    }
    throw new Error(`failed to load ${pkg}: ${(err as Error).message}`);
  }
}

export interface OpenIndexOptions {
  /**
   * Leave a due repricing to the background ingest that refolds (core/reparse.ts) when one will
   * run for this store (repriceDeferred). openStores, which reads open, sets it; default false: the
   * pass runs on the open.
   */
  defer?: boolean;
  /** The environment that decides whether background ingests run (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export async function openIndexStore(url: string, config: Config, o: OpenIndexOptions = {}): Promise<IndexStore> {
  const { scheme, rest } = parseStoreUrl(url);
  let factory = indexFactories.get(scheme);
  if (!factory) {
    const pkg = storePluginPackage(scheme);
    factory = (await loadPlugin(pkg))?.indexStore;
    if (!factory) {
      throw new Error(`no index store for "${scheme}://". Install the npm package "${pkg}" (exporting indexStore), or call registerIndexStore("${scheme}", factory). Built-in: ${[...indexFactories.keys()].join(", ")}.`);
    }
    indexFactories.set(scheme, factory);
  }
  const make = factory;
  // The line that closes an upgrade comes after the repricing below, and counts it.
  return holdUpgradeLine(async () => {
    const store = await make(url, config);
    await store.migrate();
    // A pass on a store other processes open holds the lock the refold of this home holds
    // (core/reparse.ts), so two processes never run one at once.
    if (store.setEventCosts && scheme !== "memory" && rest !== ":memory:") repriceLock(store, join(config.home, "reparse.lock"));
    await repriceOnOpen(store, url, config, o);
    return store;
  });
}

/**
 * Cost estimates for events stored before local pricing (or under older prices), once per price
 * table (core/reprice.ts). Left to the background ingest when one will run (`defer`), so the open
 * costs a cursor read; else run here. Never fails the open: a pass that errors, or finds another
 * running, runs again on a later open.
 */
async function repriceOnOpen(store: IndexStore, url: string, config: Config, o: OpenIndexOptions): Promise<void> {
  if (!store.setEventCosts) return;
  const stamp = priceStamp(pricesFor(config.pricing));
  if ((await store.getCursor(REPRICE_CURSOR)) === stamp) return;
  // A store with no sessions has nothing to reprice: the table already applies to all it holds.
  if (!(await store.listSessions({ limit: 1 })).length) {
    await store.setCursor(REPRICE_CURSOR, stamp);
    return;
  }
  if (o.defer && repriceDeferred(store, url, config, o.env ?? process.env)) {
    deferReprice(store, stamp);
    return;
  }
  const started = Date.now();
  let ran = false;
  try {
    ran = (await repriceStored(store, config.pricing)).ran;
  } catch (err) {
    ran = (err as Error).name !== "LockBusyError";
  }
  if (ran) repriceTook(Date.now() - started);
}

/**
 * Whether a background ingest will reprice this store: background ingests are on, the store keeps
 * event rows to fold from, and it is the home's own index, the one a background ingest opens
 * (a store named by CODING_SH_STORE_URL or another path is opened by this process alone).
 */
function repriceDeferred(store: IndexStore, url: string, config: Config, env: NodeJS.ProcessEnv): boolean {
  if (env.CODING_SH_NO_AUTO_INGEST === "1" || env.CODING_SH_STORE_URL?.trim() || env.CODING_SH_BLOB_URL?.trim()) return false;
  if (!store.replaceSessionEvents) return false;
  const { scheme, rest } = parseStoreUrl(url);
  if (scheme !== "sqlite" || rest === ":memory:") return false;
  return resolve(fileUrlPath(rest)) === resolve(join(config.home, "index.db"));
}

export async function openBlobStore(url: string, config: Config): Promise<BlobStore> {
  const { scheme } = parseStoreUrl(url);
  let factory = blobFactories.get(scheme);
  if (!factory) {
    const pkg = storePluginPackage(scheme);
    factory = (await loadPlugin(pkg))?.blobStore;
    if (!factory) {
      throw new Error(`no blob store for "${scheme}://". Install the npm package "${pkg}" (exporting blobStore), or call registerBlobStore("${scheme}", factory). Built-in: ${[...blobFactories.keys()].join(", ")}.`);
    }
    blobFactories.set(scheme, factory);
  }
  return factory(url, config);
}

export async function openSink(sc: SinkConfig, config: Config): Promise<Sink> {
  const kind = sc.kind.toLowerCase();
  let factory = sinkFactories.get(kind);
  if (!factory) {
    const pkg = `coding.sh-sink-${kind}`;
    factory = (await loadPlugin(pkg))?.sink;
    if (!factory) {
      throw new Error(`no sink of kind "${sc.kind}". Install the npm package "${pkg}" (exporting sink), or call registerSink("${kind}", factory). Built-in: ${[...sinkFactories.keys()].join(", ")}.`);
    }
    sinkFactories.set(kind, factory);
  }
  const sink = await factory(sc, config);
  // A sink with `since` never gets sessions that started before it, from any caller.
  return sc.since === undefined ? sink : sinceSink(sink, sc.since);
}

export interface Stores {
  index: IndexStore;
  blobs: BlobStore;
  sinks: Sink[];
}

/**
 * Opens (and migrates) the configured index, blob store and sinks. Closes what it opened on failure.
 * A due repricing is left to the background ingest when one will run (openIndexStore `defer`).
 */
export async function openStores(config: Config, o: Pick<OpenIndexOptions, "env"> = {}): Promise<Stores> {
  const index = await openIndexStore(config.store.index, config, { ...o, defer: true });
  try {
    const blobs = await openBlobStore(config.store.blobs, config);
    const sinks: Sink[] = [];
    for (const sc of config.sinks) sinks.push(await openSink(sc, config));
    return { index, blobs, sinks };
  } catch (err) {
    await index.close().catch(() => {});
    throw err;
  }
}
