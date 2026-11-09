import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { runBlobStoreConformance, runIndexStoreConformance, runProxyCallConformance } from "../../src/store/conformance.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { closeBlobs, fsBlobs } from "./_blobs.ts";

const root = mkdtempSync(join(tmpdir(), "csh-conf-"));
after(async () => {
  await closeBlobs();
  rmSync(root, { recursive: true, force: true });
});
let n = 0;

runIndexStoreConformance("memory", async () => new MemoryIndexStore());
runIndexStoreConformance("sqlite :memory:", () => SqliteIndexStore.open(":memory:"));
runIndexStoreConformance("sqlite file", () => SqliteIndexStore.open(join(root, `idx-${n++}.db`)));
runBlobStoreConformance("memory", async () => new MemoryBlobStore());
runBlobStoreConformance("fs", async () => fsBlobs(join(root, `blobs-${n++}`)));
runProxyCallConformance("sqlite file, fs blobs", async () => {
  const index = await SqliteIndexStore.open(join(root, `idx-${n++}.db`));
  return { index, close: () => index.close() };
});
