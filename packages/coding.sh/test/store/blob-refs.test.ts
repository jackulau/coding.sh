// gc keeps every blob a stored task or run still points at (BLOB_REF_FIELDS),
// on both built-in index stores.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { gc } from "../../src/core/gc.ts";
import type { IndexStore, RunResult } from "../../src/core/types.ts";
import { fixtureRun, fixtureTask } from "../../src/store/conformance.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { closeBlobs, fsBlobs } from "./_blobs.ts";

const root = mkdtempSync(join(tmpdir(), "csh-blobrefs-"));
after(async () => {
  await closeBlobs();
  rmSync(root, { recursive: true, force: true });
});
let n = 0;

for (const [name, make] of [
  ["memory", async () => new MemoryIndexStore()],
  ["sqlite", () => SqliteIndexStore.open(join(root, `idx-${n++}.db`))],
] as [string, () => Promise<IndexStore>][]) {
  describe(`gc blob references (${name})`, () => {
    it("keeps impossible-variant hidden files and toolevals tap logs", async () => {
      const index = await make();
      const blobs = fsBlobs(join(root, `blobs-${n++}`));
      const hidden = await blobs.put("test('a', () => expect(add(1,2)).toBe(3))");
      const variantHidden = await blobs.put("test('a', () => expect(add(1,2)).toBe('3_impossible'))");
      const tap = await blobs.put('{"tool":"x","args":{}}\n');
      const garbage = await blobs.put("nobody points at me");
      await index.putTask(fixtureTask({
        verifier: { command: "npm test", hiddenFiles: { "a.test.ts": hidden }, timeoutMs: 1000 },
        validation: {
          ok: true, ts: 1, noopFails: true, referencePasses: { passed: 1, of: 1 }, nearMissesFail: { failed: 0, of: 0 }, leakage: [],
          impossible: { gameable: false, tried: 1, passedByReference: [], variant: { label: "flip", noopFails: true, hiddenFiles: { "a.test.ts": variantHidden } } },
        },
      }));
      await index.putRun({ ...fixtureRun(), tapBlob: tap } as RunResult);
      const env = { CODING_SH_HOME: join(root, `home-${n++}`), HOME: root };
      const r = await gc({ index, blobs, config: defaultConfig(env), env, now: Date.now() + 2 * 86_400_000, spoolDir: join(root, "no-spool"), judgeCacheDir: false });
      assert.equal(r.blobs.deleted, 1);
      assert.deepEqual(await blobs.has([hidden, variantHidden, tap, garbage]), [true, true, true, false]);
      await index.close();
    });
  });
}
