import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import type { Config } from "../../src/core/types.ts";
import { openStores, parseStoreUrl, registerBlobStore, registerIndexStore, registerSink, storePluginPackage } from "../../src/store/factory.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";

const root = mkdtempSync(join(tmpdir(), "csh-factory-"));
after(() => rmSync(root, { recursive: true, force: true }));

function config(over: Partial<Config> = {}): Config {
  return { ...defaultConfig({ CODING_SH_HOME: join(root, "home"), HOME: root }), ...over };
}

describe("openStores", () => {
  it("opens the default sqlite + file stores", async () => {
    const c = config();
    const { index, blobs, sinks } = await openStores(c);
    assert.equal(index.kind, "sqlite");
    assert.equal(blobs.kind, "file");
    assert.deepEqual(sinks, []);
    await blobs.put("x");
    assert.ok(existsSync(join(c.home, "index.db")));
    assert.ok(existsSync(join(c.home, "blobs")));
    await index.close();
  });

  it("supports memory:// and built-in sinks", async () => {
    const { index, blobs, sinks } = await openStores(config({
      store: { index: "memory://", blobs: "memory://" },
      sinks: [
        { kind: "otlp", endpoint: "http://localhost:4318", mode: "metadata" },
        { kind: "http", name: "relay", endpoint: "http://localhost:1", mode: "full" },
      ],
    }));
    assert.equal(index.kind, "memory");
    assert.equal(blobs.kind, "memory");
    assert.deepEqual(sinks.map((s) => [s.name, s.mode]), [["otlp", "metadata"], ["relay", "full"]]);
  });

  it("names the plugin package convention for unknown schemes", async () => {
    // Schemes no workspace plugin provides (coding.sh-store-postgres and -s3 live in this monorepo).
    await assert.rejects(() => openStores(config({ store: { index: "nosuchdb://db/x", blobs: "memory://" } })),
      /no index store for "nosuchdb:\/\/"\. Install the npm package "coding\.sh-store-nosuchdb"/);
    await assert.rejects(() => openStores(config({ store: { index: "memory://", blobs: "nosuchblob://bucket/p" } })),
      /no blob store for "nosuchblob:\/\/"\. Install the npm package "coding\.sh-store-nosuchblob"/);
    assert.equal(storePluginPackage("postgres"), "coding.sh-store-postgres");
    assert.equal(storePluginPackage("postgresql"), "coding.sh-store-postgres", "hosting platforms hand out postgresql:// URLs");
    assert.equal(storePluginPackage("s3"), "coding.sh-store-s3");
    await assert.rejects(() => openStores(config({ store: { index: "memory://", blobs: "memory://" }, sinks: [{ kind: "kafka", endpoint: "x", mode: "metadata" }] })),
      /no sink of kind "kafka"\. Install the npm package "coding\.sh-sink-kafka"/);
    assert.throws(() => parseStoreUrl("/just/a/path"), /must look like scheme:\/\//);
  });

  it("uses registered third-party factories and closes the index if a later store fails", async () => {
    let closed = false;
    let migrated = false;
    registerIndexStore("custom", () => {
      const s = new MemoryIndexStore();
      s.migrate = async () => { migrated = true; };
      s.close = async () => { closed = true; };
      return s;
    });
    registerBlobStore("custom", (url) => {
      if (url.includes("fail")) throw new Error("bucket missing");
      return new MemoryBlobStore();
    });
    registerSink("null", (sc) => ({ name: sc.name ?? "null", mode: sc.mode, write: async () => ({ ok: true }) }));
    const ok = await openStores(config({ store: { index: "custom://a", blobs: "custom://b" }, sinks: [{ kind: "null", endpoint: "", mode: "full" }] }));
    assert.ok(migrated, "openStores migrates the index");
    assert.equal(ok.sinks[0]!.name, "null");
    await assert.rejects(() => openStores(config({ store: { index: "custom://a", blobs: "custom://fail" } })), /bucket missing/);
    assert.ok(closed);
  });
});
