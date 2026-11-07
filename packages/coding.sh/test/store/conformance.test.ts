import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { runBlobStoreConformance, runIndexStoreConformance } from "../../src/store/conformance.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

const root = mkdtempSync(join(tmpdir(), "csh-conf-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

runIndexStoreConformance("memory", async () => new MemoryIndexStore());
runIndexStoreConformance("sqlite :memory:", () => SqliteIndexStore.open(":memory:"));
runIndexStoreConformance("sqlite file", () => SqliteIndexStore.open(join(root, `idx-${n++}.db`)));
runBlobStoreConformance("memory", async () => new MemoryBlobStore());
runBlobStoreConformance("fs", async () => new FsBlobStore(join(root, `blobs-${n++}`)));
