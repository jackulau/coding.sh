// Chooses store implementations by URL scheme and sinks by kind.
//
// Built-ins: sqlite:// and memory:// (index), file:// and memory:// (blobs),
// otlp and http (sinks). Anything else is resolved from the registry, or from
// an npm package named by convention:
//   coding.sh-store-<scheme>  exporting { indexStore?, blobStore? } factories
//                             (postgresql:// loads coding.sh-store-postgres,
//                             clickhouses:// loads coding.sh-store-clickhouse)
//   coding.sh-sink-<kind>     exporting { sink } factory
import { resolve } from "node:path";
import type { BlobStore, Config, IndexStore, Sink, SinkConfig } from "../core/types.ts";
import { expandHome } from "../core/paths.ts";
import { repriceStored } from "../core/reprice.ts";
import { version } from "../cli/meta.ts";
import { ownerGuard } from "../core/store-guard.ts";
import { createHttpSink } from "../sinks/http.ts";
import { createOtlpSink } from "../sinks/otlp.ts";
import { FsBlobStore } from "./fs-blobs.ts";
import { MemoryBlobStore, MemoryIndexStore } from "./memory.ts";
import { SqliteIndexStore } from "./sqlite.ts";

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

/** Filesystem path from sqlite:///abs, sqlite://~/x or sqlite://relative (resolved against cwd). */
export function fileUrlPath(rest: string): string {
  const p = decodeURIComponent(rest.replace(/[?#].*$/, ""));
  return resolve(expandHome(p));
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

export async function openIndexStore(url: string, config: Config): Promise<IndexStore> {
  const { scheme } = parseStoreUrl(url);
  let factory = indexFactories.get(scheme);
  if (!factory) {
    const pkg = storePluginPackage(scheme);
    factory = (await loadPlugin(pkg))?.indexStore;
    if (!factory) {
      throw new Error(`no index store for "${scheme}://". Install the npm package "${pkg}" (exporting indexStore), or call registerIndexStore("${scheme}", factory). Built-in: ${[...indexFactories.keys()].join(", ")}.`);
    }
    indexFactories.set(scheme, factory);
  }
  const store = await factory(url, config);
  await store.migrate();
  // Cost estimates for events stored before local pricing (or under older prices): once per
  // price table. Never fails the open: a pass that errors runs again on the next one.
  await repriceStored(store, config.pricing).catch(() => {});
  return store;
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
  return factory(sc, config);
}

export interface Stores {
  index: IndexStore;
  blobs: BlobStore;
  sinks: Sink[];
}

/** Opens (and migrates) the configured index, blob store and sinks. Closes what it opened on failure. */
export async function openStores(config: Config): Promise<Stores> {
  const index = await openIndexStore(config.store.index, config);
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
