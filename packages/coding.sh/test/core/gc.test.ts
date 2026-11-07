import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { gc } from "../../src/core/gc.ts";
import { ingest, sinkCursorKey } from "../../src/core/ingest.ts";
import type { Adapter, BlobStore } from "../../src/core/types.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";

const DAY = 86_400_000;
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function setup() {
  const root = mkdtempSync(join(tmpdir(), "csh-gc-"));
  roots.push(root);
  const env = { CODING_SH_HOME: join(root, "home"), HOME: root };
  return { root, env, config: defaultConfig(env), spool: join(env.CODING_SH_HOME, "spool") };
}
/** raw = { session, kind, blob? } → one event (blob stored through ctx.blob). */
const fake: Adapter = {
  id: "fake",
  displayName: "Fake",
  tier: "A",
  detect: async () => ({ installed: true, hooked: true }),
  install: async () => [],
  uninstall: async () => [],
  async normalize(line, ctx) {
    const { session, kind, blob, ...payload } = line.raw as Record<string, string>;
    const e = { id: ctx.id(line.agent, session!, line.ts, line.event), v: 0 as const, sessionId: session!, ts: line.ts, agent: line.agent, kind: (kind ?? "notification") as "notification", payload };
    return [blob ? { ...e, blobs: [await ctx.blob(blob)] } : e];
  },
};
const spoolLine = (pid: number, ts: number, raw: Record<string, string>) => JSON.stringify({ v: 0, agent: "fake", event: `E${ts}`, ts, pid, cwd: "/w", raw }) + "\n";
const old = (p: string, days: number) => {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(p, t, t);
};

describe("gc", () => {
  it("sweeps only unreferenced blobs older than a day; dry run deletes nothing", async () => {
    const t = setup();
    const index = new MemoryIndexStore();
    const blobs = new FsBlobStore(join(t.root, "blobs"));
    const kept = await blobs.put("referenced");
    const stale = await blobs.put("stale garbage");
    const young = await blobs.put("just written");
    await index.putEvents([{ id: "e", v: 0, sessionId: "s", ts: 1, agent: "a", kind: "notification", payload: {}, blobs: [kept] }]);
    old(blobs.pathFor(kept), 30);
    old(blobs.pathFor(stale), 2);
    const staleSize = statSync(blobs.pathFor(stale)).size;

    const dry = await gc({ index, blobs, config: t.config, env: t.env, dryRun: true });
    assert.deepEqual(dry.blobs, { scanned: 3, referenced: 1, deleted: 1, bytes: staleSize, skippedYoung: 1, skippedNoAge: 0, expired: 0, tmpFiles: 0, tmpBytes: 0 });
    assert.deepEqual(await blobs.has([kept, stale, young]), [true, true, true]);

    const real = await gc({ index, blobs, config: t.config, env: t.env });
    assert.equal(real.blobs.deleted, 1);
    assert.deepEqual(await blobs.has([kept, stale, young]), [true, false, true]);
  });

  it("expires blobs held only by tool output older than retention.toolOutputDays, and size-caps the judge cache", async () => {
    const t = setup();
    t.config.retention.toolOutputDays = 30;
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    const oldOut = await blobs.put("old tool output");
    const shared = await blobs.put("old output also used by a diff");
    const newOut = await blobs.put("fresh tool output");
    const patch = await blobs.put("reference patch");
    for (const r of [oldOut, shared, newOut, patch]) blobs.touch(r, Date.now() - 400 * DAY);
    const ev = (id: string, kind: "tool.end" | "file.change", ts: number, refs: string[]) =>
      ({ id, v: 0 as const, sessionId: "s", ts, agent: "a", kind, payload: {}, blobs: refs });
    await index.putEvents([
      ev("old", "tool.end", Date.now() - 60 * DAY, [oldOut, shared, patch]),
      ev("diff", "file.change", Date.now() - 60 * DAY, [shared]),
      ev("new", "tool.end", Date.now() - DAY, [newOut]),
    ]);
    await index.upsertSession({ id: "s", agent: "a", startedAt: 0, stats: { events: 3, turns: 0, toolCalls: 2, toolErrors: 0, filesChanged: 1 }, flags: [] });
    await index.putTask({ id: "t", name: "t", status: "draft", start: { repoRoot: "/r", snapshot: "s", head: "h" }, instruction: "i", setup: [], verifier: { command: "true", hiddenFiles: {}, timeoutMs: 1 }, referencePatch: patch, tags: [], createdAt: 0 });
    const jdir = join(t.env.CODING_SH_HOME, "judge-cache", "abcd", "aa");
    mkdirSync(jdir, { recursive: true });
    for (const n of ["a", "b"]) writeFileSync(join(jdir, `${n.repeat(64)}.json`), "x".repeat(100));
    old(join(jdir, `${"a".repeat(64)}.json`), 3);
    const r = await gc({ index, blobs, config: t.config, env: t.env, judgeCacheMaxBytes: 150 });
    assert.equal(r.blobs.expired, 1);
    assert.deepEqual(await blobs.has([oldOut, shared, newOut, patch]), [false, true, true, true]);
    assert.deepEqual([r.judgeCache?.scanned, r.judgeCache?.deleted], [2, 1]);
    assert.equal(existsSync(join(jdir, `${"a".repeat(64)}.json`)), false, "oldest entry evicted");
    t.config.retention.toolOutputDays = 0;
    assert.equal((await gc({ index, blobs, config: t.config, env: t.env, dryRun: true })).blobs.expired, 0, "0 disables expiry");
  });

  it("keeps unreferenced blobs when the store cannot report their age", async () => {
    const t = setup();
    const inner = new MemoryBlobStore();
    const ageless: BlobStore = {
      kind: "ageless",
      put: (d) => inner.put(d),
      get: (r) => inner.get(r),
      getText: (r) => inner.getText(r),
      has: (r) => inner.has(r),
      list: () => inner.list(),
      delete: (r) => inner.delete(r),
    };
    await ageless.put("x");
    const r = await gc({ index: new MemoryIndexStore(), blobs: ageless, config: t.config, env: t.env });
    assert.equal(r.blobs.skippedNoAge, 1);
    assert.equal(r.blobs.deleted, 0);
  });

  it("deletes old spool files only once every cursor (local + sinks) has consumed them", async () => {
    const t = setup();
    t.config.sinks = [{ kind: "otlp", name: "otel", endpoint: "http://x", mode: "metadata" }];
    const dir = join(t.spool, "fake");
    mkdirSync(join(dir, "raw"), { recursive: true });
    const write = (name: string, content: string, days: number) => {
      const p = join(dir, name);
      writeFileSync(p, content);
      old(p, days);
      return p;
    };
    const rawPath = join(dir, "raw", "big.json");
    writeFileSync(rawPath, "{}");
    const lineWithRaw = JSON.stringify({ v: 0, agent: "fake", event: "x", ts: 1, pid: 1, cwd: "/", rawFile: "raw/big.json" }) + "\n";
    const done = write("done.jsonl", lineWithRaw, 10);
    const sinkBehind = write("sink-behind.jsonl", "{}\n", 10);
    const recent = write("recent.jsonl", "{}\n", 1);
    const index = new MemoryIndexStore();
    for (const [p, src] of [[done, "fake/done.jsonl"], [sinkBehind, "fake/sink-behind.jsonl"], [recent, "fake/recent.jsonl"]] as const) {
      await index.setCursor(src, statSync(p).size);
    }
    await index.setCursor(sinkCursorKey("otel", "fake/done.jsonl"), statSync(done).size);
    await index.setCursor(sinkCursorKey("otel", "fake/recent.jsonl"), statSync(recent).size);

    const dry = await gc({ index, blobs: new MemoryBlobStore(), config: t.config, env: t.env, dryRun: true });
    assert.deepEqual(dry.spool, { scanned: 3, deleted: 1, bytes: statSync(done).size + 2, rawFiles: 1 });
    assert.ok(existsSync(done));

    await gc({ index, blobs: new MemoryBlobStore(), config: t.config, env: t.env });
    assert.ok(!existsSync(done));
    assert.ok(!existsSync(rawPath), "side file removed with its spool file");
    assert.ok(existsSync(sinkBehind), "a lagging sink keeps the file");
    assert.ok(existsSync(recent), "younger than keepSpoolDays");
  });

  it("resets the cursors of the spool files it deletes, so a file recreated at the same path is read from the start", async () => {
    const t = setup();
    t.config.retention.keepSpoolDays = 0;
    t.config.sinks = [{ kind: "otlp", name: "otel", endpoint: "http://x", mode: "metadata" }];
    const dir = join(t.spool, "fake");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "2026-11-06.4242.jsonl");
    const index = new MemoryIndexStore();
    const blobs = new MemoryBlobStore();
    const opts = { config: t.config, index, blobs, env: t.env, adapters: new Map([["fake", fake]]) };
    appendFileSync(file, spoolLine(4242, Date.now(), { session: "old", kind: "turn.end" }));
    await ingest(opts);
    await index.setCursor(sinkCursorKey("otel", "fake/2026-11-06.4242.jsonl"), statSync(file).size);
    const g = await gc({ index, blobs, config: t.config, env: t.env, judgeCacheDir: false });
    assert.equal(g.spool.deleted, 1);
    assert.equal(await index.getCursor("fake/2026-11-06.4242.jsonl"), 0);
    assert.equal(await index.getCursor(sinkCursorKey("otel", "fake/2026-11-06.4242.jsonl")), 0);
    // pid 4242 reused later the same UTC day, with a longer line.
    appendFileSync(file, spoolLine(4242, Date.now() + 5000, { session: "new", kind: "user.message", text: "x".repeat(400) }));
    const r = await ingest(opts);
    assert.deepEqual([r.lines, r.errors], [1, []]);
    assert.ok(await index.getSession("new"));
  });

  it("deletes raw side files no spool line references once older than keepSpoolDays, and keeps referenced ones", async () => {
    const t = setup();
    const raw = join(t.spool, "fake", "raw");
    mkdirSync(raw, { recursive: true });
    const orphan = join(raw, "1-1-orphan.json");
    const referenced = join(raw, "2-2-ref.json");
    const young = join(raw, "3-3-young.json");
    for (const p of [orphan, referenced, young]) writeFileSync(p, "{}");
    writeFileSync(join(t.spool, "fake", "2026-11-06.2.jsonl"), JSON.stringify({ v: 0, agent: "fake", event: "x", ts: 1, pid: 2, cwd: "/", rawFile: referenced }) + "\n");
    old(orphan, 30);
    old(referenced, 30);
    old(young, 3); // younger than keepSpoolDays (7)
    const dry = await gc({ index: new MemoryIndexStore(), blobs: new MemoryBlobStore(), config: t.config, env: t.env, judgeCacheDir: false, dryRun: true });
    assert.equal(dry.spool.rawFiles, 1);
    assert.ok(existsSync(orphan));
    await gc({ index: new MemoryIndexStore(), blobs: new MemoryBlobStore(), config: t.config, env: t.env, judgeCacheDir: false });
    assert.deepEqual([existsSync(orphan), existsSync(referenced), existsSync(young)], [false, true, true]);
  });

  it("holds the ingest lock across the blob sweep, so an ingest deduping onto an old unreferenced blob never loses it", async () => {
    const t = setup();
    const dir = join(t.spool, "fake");
    mkdirSync(dir, { recursive: true });
    const index = new MemoryIndexStore();
    const payload = "big tool output ".repeat(100);
    let racing: Promise<unknown> | undefined;
    class RacingBlobs extends FsBlobStore {
      override async stat(ref: string) {
        const s = await super.stat(ref);
        if (!racing) {
          // A hook-kicked ingest re-captures the same content right between gc's stat and delete.
          appendFileSync(join(dir, "2026-11-06.7.jsonl"), spoolLine(7, Date.now(), { session: "s", kind: "tool.end", blob: payload }));
          racing = ingest({ config: t.config, index, blobs: this, env: t.env, adapters: new Map([["fake", fake]]) });
          await new Promise((r) => setTimeout(r, 300));
        }
        return s;
      }
    }
    const blobs = new RacingBlobs(join(t.root, "blobs"));
    const ref = await blobs.put(payload); // its old event was deleted by retention
    old(blobs.pathFor(ref), 3);
    await gc({ index, blobs, config: t.config, env: t.env, judgeCacheDir: false });
    await racing;
    const [e] = await index.listEvents("s");
    assert.deepEqual(e?.blobs, [ref]);
    assert.deepEqual(await blobs.has([ref]), [true], "the committed event's blob exists");
  });

  it("never loses a blob that a writer outside the ingest lock (backfill, otel, eval) re-captures between gc's stat and delete", async () => {
    const t = setup();
    const index = new MemoryIndexStore();
    const payload = "transcript tool output ".repeat(100);
    let raced = false;
    class RacingBlobs extends FsBlobStore {
      override async stat(ref: string) {
        const s = await super.stat(ref);
        if (!raced) {
          raced = true;
          // backfill/tailIngest: dedupe-hit put (refreshes mtime) and commit, with no lock, after gc read the old mtime.
          const again = await this.put(payload);
          await index.putEvents([{ id: "e1", v: 0, sessionId: "s", ts: Date.now(), agent: "fake", kind: "tool.end", payload: {}, blobs: [again] }]);
        }
        return s;
      }
    }
    const blobs = new RacingBlobs(join(t.root, "blobs"));
    const ref = await blobs.put(payload);
    const gone = await blobs.put("nobody wants this");
    old(blobs.pathFor(ref), 3);
    old(blobs.pathFor(gone), 3);
    const r = await gc({ index, blobs, config: t.config, env: t.env, judgeCacheDir: false });
    assert.equal(r.blobs.skippedYoung, 1);
    assert.equal(r.blobs.deleted, 1);
    assert.deepEqual(await blobs.has([gone]), [false]);
    assert.deepEqual((await index.listEvents("s"))[0]?.blobs, [ref]);
    assert.equal(await blobs.getText(ref), payload, "the committed event's blob exists and reads back");
    assert.deepEqual(await blobs.sweepTmp({ olderThanMs: 0 }), { files: 0, bytes: 0 }, "no trash left behind");
  });

  it("removes orphan temp files of interrupted blob writes older than minBlobAgeMs, and keeps fresh ones", async () => {
    const t = setup();
    const blobs = new FsBlobStore(join(t.root, "blobs"));
    const ref = await blobs.put("anything");
    const shard = join(blobs.pathFor(ref), "..");
    const oldTmp = join(shard, `${"a".repeat(64)}.zst.123.abcd.tmp`);
    const freshTmp = join(shard, `${"b".repeat(64)}.zst.456.ef01.tmp`); // a put in flight
    writeFileSync(oldTmp, "x".repeat(10));
    writeFileSync(freshTmp, "y");
    old(oldTmp, 2);
    const dry = await gc({ index: new MemoryIndexStore(), blobs, config: t.config, env: t.env, judgeCacheDir: false, dryRun: true });
    assert.deepEqual([dry.blobs.tmpFiles, dry.blobs.tmpBytes], [1, 10]);
    assert.ok(existsSync(oldTmp));
    const r = await gc({ index: new MemoryIndexStore(), blobs, config: t.config, env: t.env, judgeCacheDir: false });
    assert.equal(r.blobs.tmpFiles, 1);
    assert.deepEqual([existsSync(oldTmp), existsSync(freshTmp)], [false, true]);
  });
});
