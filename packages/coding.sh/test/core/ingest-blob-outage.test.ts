// A blob store that is down (S3 refusing connections, say) must not cost events: the
// lines whose blobs could not be written stay unread, so the next ingest stores them.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import type { Adapter, BlobBatch, BlobMeta, BlobRef } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { ingest } from "../../src/core/ingest.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

/** raw = { session, kind, blob? } → one event, its blob put through ctx.blob. */
const fake: Adapter = {
  id: "fake",
  displayName: "Fake",
  tier: "A",
  detect: async () => ({ installed: true, hooked: true }),
  install: async () => [],
  uninstall: async () => [],
  async normalize(line, ctx) {
    const raw = line.raw as { session: string; kind?: EventKind; blob?: string; bad?: boolean };
    if (raw.bad) throw new SyntaxError("not a payload this adapter reads");
    const e: AgentEvent = { id: ctx.id(line.agent, raw.session, line.ts), v: 0, sessionId: raw.session, ts: line.ts, agent: line.agent, kind: raw.kind ?? "user.message", cwd: line.cwd, payload: { text: "hi" } };
    if (raw.blob) e.blobs = [await ctx.blob(raw.blob)];
    return [e];
  },
};

/** A write-behind batch (like FsBlobStore's) whose writes fail at flush, not at put. */
class FailingBatch extends MemoryBlobStore implements BlobBatch {
  async flush(): Promise<void> {
    throw new Error("ENOTDIR: not a directory, mkdir '/work/demo/blobs'");
  }
}

class FlushFailsBlobStore extends MemoryBlobStore {
  batch(): BlobBatch {
    return new FailingBatch();
  }
}

class DownBlobStore extends MemoryBlobStore {
  override async put(_data: Uint8Array | string, _meta?: BlobMeta): Promise<BlobRef> {
    throw Object.assign(new Error("s3 PUT http://127.0.0.1:9/b: connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "csh-blob-outage-"));
  roots.push(root);
  const env = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
  const dir = join(env.CODING_SH_HOME, "spool", "fake");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-11-06.jsonl");
  let ts = 1_700_000_000_000;
  const line = (raw: Record<string, unknown>) => JSON.stringify({ v: 0, agent: "fake", event: "E", ts: (ts += 1000), pid: 1, cwd: root, raw }) + "\n";
  return { env, file, line, config: defaultConfig(env), index: new MemoryIndexStore(), adapters: new Map([["fake", fake]]) };
}

describe("ingest with a blob store that is down", () => {
  it("leaves the cursor before the line whose blob failed, and a retry stores every event", async () => {
    const t = setup();
    const first = t.line({ session: "a" });
    appendFileSync(t.file, first + t.line({ session: "a", blob: "transcript a" }) + t.line({ session: "b", blob: "transcript b" }));

    const r = await ingest({ config: t.config, index: t.index, blobs: new DownBlobStore(), adapters: t.adapters, env: t.env, lock: false });
    assert.equal(r.errors.length, 1, JSON.stringify(r.errors));
    assert.match(r.errors[0]!.message, /blob store write failed: .*ECONNREFUSED/);
    assert.equal(r.errors[0]!.offset, Buffer.byteLength(first));
    // The line before the failure is stored and read past; the failed line is not.
    assert.equal(await t.index.getCursor("fake/2026-11-06.jsonl"), Buffer.byteLength(first));
    assert.equal(r.events, 1);
    assert.equal(r.pendingFiles, 1);
    assert.match(r.storeWriteFailed ?? "", /^blob store write failed: .*ECONNREFUSED/, "the CLI marks ingest stopped from this");

    const blobs = new MemoryBlobStore();
    const again = await ingest({ config: t.config, index: t.index, blobs, adapters: t.adapters, env: t.env, lock: false });
    assert.deepEqual(again.errors, []);
    assert.equal(again.events, 2);
    for (const [id, text] of [["a", "transcript a"], ["b", "transcript b"]] as const) {
      const events = await t.index.listEvents(id);
      const withBlob = events.find((e) => e.blobs?.length);
      assert.ok(withBlob, `session ${id} has its blob event`);
      assert.equal(await blobs.getText(withBlob.blobs![0]!), text);
    }
  });

  it("a write-behind batch that fails at flush commits nothing of its window, keeps the cursor, and returns instead of throwing", async () => {
    const t = setup();
    appendFileSync(t.file, t.line({ session: "a" }) + t.line({ session: "a", blob: "transcript a" }));
    const r = await ingest({ config: t.config, index: t.index, blobs: new FlushFailsBlobStore(), adapters: t.adapters, env: t.env, lock: false });
    assert.match(r.storeWriteFailed ?? "", /^blob store write failed: ENOTDIR/);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!.message, /ingest stopped, the next run retries/);
    assert.deepEqual({ lines: r.lines, events: r.events, pendingFiles: r.pendingFiles }, { lines: 0, events: 0, pendingFiles: 1 });
    assert.equal(await t.index.getCursor("fake/2026-11-06.jsonl"), 0);
    const again = await ingest({ config: t.config, index: t.index, blobs: new MemoryBlobStore(), adapters: t.adapters, env: t.env, lock: false });
    assert.deepEqual(again.errors, []);
    assert.equal(again.storeWriteFailed, undefined);
    assert.equal(again.events, 2);
  });

  it("still skips a line its adapter cannot parse, and moves past it", async () => {
    const t = setup();
    appendFileSync(t.file, t.line({ session: "a", bad: true }) + t.line({ session: "b" }));
    const r = await ingest({ config: t.config, index: t.index, blobs: new MemoryBlobStore(), adapters: t.adapters, env: t.env, lock: false });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!.message, /fake\.normalize failed/);
    assert.equal(r.events, 1);
    assert.equal(r.pendingFiles, 0);
  });
});
