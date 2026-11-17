import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import type { Config } from "../../src/core/types.ts";
import { fileUrlPath, msysPath, openStores, parseStoreUrl, registerBlobStore, registerIndexStore, registerSink, storePluginPackage } from "../../src/store/factory.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

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
    await blobs.close?.();
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
    assert.equal(storePluginPackage("clickhouse"), "coding.sh-store-clickhouse");
    assert.equal(storePluginPackage("clickhouses"), "coding.sh-store-clickhouse", "clickhouses:// is ClickHouse over HTTPS");
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

describe("fileUrlPath", () => {
  it("leaves out a user:password@ in front of the path, and the slash before a drive letter", () => {
    const file = join(root, "pw-index.db");
    assert.equal(fileUrlPath(`coding:secret@/${file}`), resolve(file));
    assert.equal(fileUrlPath(file), resolve(file));
    assert.equal(fileUrlPath(parseStoreUrl(pathToFileURL(file).href).rest), resolve(file), "a file:// URL, as config set store.blobs writes it");
  });
});

describe("store URL paths under Git Bash on Windows", () => {
  const TEMP = String.raw`C:\Users\u\AppData\Local\Temp`;
  const gitBash = { platform: "win32" as const, env: { MSYSTEM: "MINGW64" }, tmp: TEMP };
  const rest = (url: string) => parseStoreUrl(url).rest;

  it("reads /tmp as the shell's /tmp, the user's temp dir, and /c/… as the C: drive", () => {
    assert.equal(msysPath("/tmp/x.db", gitBash), String.raw`${TEMP}\x.db`);
    assert.equal(msysPath("/tmp", gitBash), TEMP);
    assert.equal(msysPath("/c/data/index.db", gitBash), String.raw`C:\data\index.db`);
    assert.equal(msysPath("/d", gitBash), "D:\\");
    assert.equal(fileUrlPath(rest("sqlite:///tmp/x.db"), gitBash), String.raw`${TEMP}\x.db`);
    assert.equal(fileUrlPath(rest("file:///tmp/blobs"), gitBash), String.raw`${TEMP}\blobs`);
    assert.equal(fileUrlPath(rest("sqlite:///c/data/index.db"), gitBash), String.raw`C:\data\index.db`);
    assert.equal(fileUrlPath(rest("sqlite://u:secret@/tmp/x.db"), gitBash), String.raw`${TEMP}\x.db`);
  });

  it("leaves Windows paths, other shell paths and lookalikes as they were", () => {
    assert.equal(fileUrlPath(rest("sqlite:///C:/data/index.db"), gitBash), String.raw`C:\data\index.db`);
    assert.equal(fileUrlPath(rest(String.raw`sqlite://C:\data\index.db`), gitBash), String.raw`C:\data\index.db`);
    for (const p of ["/tmpfiles/x.db", "/temp/x.db", "/cc/x.db", "/usr/share/x.db", "relative/x.db", String.raw`C:\tmp\x.db`]) assert.equal(msysPath(p, gitBash), p, p);
  });

  it("maps nothing outside an MSYS shell or off Windows", () => {
    const powershell = { platform: "win32" as const, env: {}, tmp: TEMP };
    assert.equal(msysPath("/tmp/x.db", powershell), "/tmp/x.db");
    assert.match(fileUrlPath(rest("sqlite:///tmp/x.db"), powershell), /^(?:[A-Za-z]:)?\\tmp\\x\.db$/, "the current drive's \\tmp, as before");
    for (const platform of ["linux", "darwin"] as const) {
      const host = { platform, env: { MSYSTEM: "MINGW64" }, tmp: "/var/tmp" };
      assert.equal(msysPath("/tmp/x.db", host), "/tmp/x.db");
      assert.equal(fileUrlPath(rest("sqlite:///tmp/x.db"), host), "/tmp/x.db");
      assert.equal(fileUrlPath(rest("sqlite:///c/x.db"), host), "/c/x.db");
    }
  });
});

describe("SqliteIndexStore.open", () => {
  it("names the absolute path it tried when the index can't be opened", async () => {
    // A directory where the database file should be: SQLite alone says "unable to open database file".
    const dir = join(root, "a-dir.db");
    mkdirSync(dir, { recursive: true });
    await assert.rejects(SqliteIndexStore.open(dir), (e: Error) => e.message.includes(dir));
  });
});
