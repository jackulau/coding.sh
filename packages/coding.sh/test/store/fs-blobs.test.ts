import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { after, describe, it } from "node:test";
import { sha256Hex } from "../../src/core/ids.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";

const root = mkdtempSync(join(tmpdir(), "csh-blobs-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => new FsBlobStore(join(root, `b${n++}`));

describe("FsBlobStore", () => {
  it("stores zstd-compressed bytes at ab/cd/<sha>.zst", async () => {
    const s = fresh();
    const text = "hello ".repeat(10_000);
    const ref = await s.put(text);
    const file = join(s.root, ref.slice(0, 2), ref.slice(2, 4), `${ref}.zst`);
    assert.equal(s.pathFor(ref), file);
    const disk = readFileSync(file);
    assert.ok(disk.byteLength < 1000, `compressed to ${disk.byteLength} bytes`);
    assert.equal(zstdDecompressSync(disk).toString("utf8"), text);
    assert.equal(ref, sha256Hex(text));
    assert.equal(await s.size(), disk.byteLength);
  });

  it("leaves no temp files behind, even with concurrent writers", async () => {
    const s = fresh();
    const payloads = Array.from({ length: 50 }, (_, i) => `blob ${i % 5}`);
    const refs = await Promise.all(payloads.map((p) => s.put(p)));
    assert.equal(new Set(refs).size, 5);
    const all: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else all.push(e.name);
      }
    };
    walk(s.root);
    assert.equal(all.length, 5);
    assert.ok(all.every((f) => f.endsWith(".zst")));
  });

  it("refreshes mtime on a dedupe hit (protects re-referenced blobs from gc)", async () => {
    const s = fresh();
    const ref = await s.put("x");
    const old = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(s.pathFor(ref), old, old);
    assert.ok(Date.now() - statSync(s.pathFor(ref)).mtimeMs > 9 * 86_400_000);
    await s.put("x");
    assert.ok(Date.now() - (await s.stat(ref))!.mtimeMs < 60_000);
  });

  it("reads a corrupt blob as missing and ignores foreign files in list()", async () => {
    const s = fresh();
    const ref = await s.put("data");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    writeFileSync(s.pathFor(ref), "not zstd");
    assert.equal(await s.get(ref), undefined);
    // Valid zstd of other content: only the sha256 check catches it.
    writeFileSync(s.pathFor(ref), zstdCompressSync(Buffer.from("other")));
    assert.equal(await s.get(ref), undefined);
    mkdirSync(join(s.root, "zz"), { recursive: true });
    writeFileSync(join(s.root, "README"), "x");
    const listed: string[] = [];
    for await (const r of s.list()) listed.push(r);
    assert.deepEqual(listed, [ref]);
  });

  it("a torn blob reads as missing, never as empty bytes, and a re-put of the content heals it", async () => {
    const s = fresh();
    const content = "full tool output ".repeat(200);
    const ref = await s.put(content);
    const full = readFileSync(s.pathFor(ref));
    for (const n of [0, 4, full.length >> 1, full.length - 1]) {
      writeFileSync(s.pathFor(ref), full.subarray(0, n)); // after a power loss: name durable, data not
      assert.equal(await s.get(ref), undefined, `truncated to ${n}/${full.length} bytes`);
      assert.equal(await s.put(content), ref);
      assert.equal(await s.getText(ref), content, `re-put after truncation to ${n} bytes`);
    }
    assert.deepEqual(readFileSync(s.pathFor(ref)), full);
  });

  /** Counts FileHandle.sync calls (fsync; F_FULLFSYNC on macOS) while `fn` runs. */
  async function countSyncs(fn: () => Promise<unknown>): Promise<number> {
    const probe = await open(import.meta.filename, "r");
    const proto = Object.getPrototypeOf(probe); // FileHandle.prototype
    await probe.close();
    const sync = proto.sync;
    let calls = 0;
    proto.sync = function (this: unknown) {
      calls++;
      return sync.call(this);
    };
    try {
      await fn();
    } finally {
      proto.sync = sync;
    }
    return calls;
  }

  it("syncs the blob's directory (and, without O_DSYNC, the file) before put resolves", async () => {
    const s = fresh();
    // The temp file is opened O_DSYNC where Node has it (the write is the flush), else fsynced.
    const expected = process.platform === "win32" ? 2 : 1;
    assert.ok((await countSyncs(() => s.put("durable"))) >= expected, `at least ${expected} fsync calls`);
    assert.equal(await countSyncs(() => s.put("durable")), 0, "a verified dedupe hit writes nothing");
  });

  it("batch: blobs reach their path only on flush, which syncs each directory once (macOS: the root once)", async () => {
    const s = fresh();
    const b = s.batch();
    const texts = Array.from({ length: 60 }, (_, i) => `blob ${i}`);
    const refs = await Promise.all(texts.map((t) => b.put(t)));
    assert.equal(await b.getText(refs[7]!), texts[7], "readable through the batch before the flush");
    // Every temp file written (Windows fsyncs each one), so only the flush's own syncs are counted below.
    await Promise.all(refs.map((r) => b.get(r)));
    assert.ok(refs.every((r) => !existsSync(s.pathFor(r))), "nothing at a blob path before the flush");
    const dirs = new Set(refs.map((r) => join(s.root, r.slice(0, 2), r.slice(2, 4))));
    const parents = new Set(refs.map((r) => join(s.root, r.slice(0, 2))));
    const syncs = await countSyncs(() => b.flush());
    if (process.platform === "darwin") assert.equal(syncs, 1);
    // Each blob directory, each new ab/ (in the root), and the new root itself (in its parent).
    else assert.ok(syncs <= dirs.size + parents.size + 2, `${syncs} syncs for ${dirs.size} directories`);
    for (const [i, r] of refs.entries()) assert.equal(await s.getText(r), texts[i]);
    const tmp = readdirSync(s.root, { recursive: true }).filter((f) => String(f).endsWith(".tmp"));
    assert.deepEqual(tmp, []);
  });

  it("batch: flush rejects with a write error, and the batch's other blobs still land", async () => {
    const s = fresh();
    const good = await s.put("already here"); // creates the root
    const b = s.batch();
    const ok = await b.put("lands");
    // A file where the blob's directory must go: its write fails.
    const bad = sha256Hex("cannot land");
    writeFileSync(join(s.root, bad.slice(0, 2)), "not a directory");
    assert.equal(await b.put("cannot land"), bad);
    await assert.rejects(b.flush());
    assert.equal(await s.getText(ok), "lands");
    assert.equal(await s.getText(good), "already here");
  });

  it("sweepTmp removes orphan temp files older than the age guard", async () => {
    const s = fresh();
    const ref = await s.put("kept");
    const dir = join(s.root, ref.slice(0, 2), ref.slice(2, 4));
    const old = join(dir, `${ref}.zst.4242.abcdef012345.tmp`);
    const young = join(dir, `${sha256Hex("y")}.zst.4243.0123456789ab.tmp`);
    const foreign = join(dir, "notes.tmp");
    for (const f of [old, young, foreign]) writeFileSync(f, "partial");
    const past = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(old, past, past);
    utimesSync(foreign, past, past);
    assert.deepEqual(await s.sweepTmp({ olderThanMs: 86_400_000, dryRun: true }), { files: 1, bytes: 7 });
    assert.ok(existsSync(old), "dry run removes nothing");
    assert.deepEqual(await s.sweepTmp({ olderThanMs: 86_400_000 }), { files: 1, bytes: 7 });
    assert.ok(!existsSync(old));
    assert.ok(existsSync(young), "a young temp file may be a put in flight");
    assert.ok(existsSync(foreign), "only files named like our temp files");
    assert.equal(await s.getText(ref), "kept");
    assert.deepEqual(await fresh().sweepTmp({ olderThanMs: 0 }), { files: 0, bytes: 0 }, "a missing root is fine");
  });

  it("recompresses at a higher level without changing content", async () => {
    const s = fresh();
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i % 97} of some repetitive log output`).join("\n");
    const ref = await s.put(text);
    const saved = await s.recompress(ref, 19);
    assert.ok(saved >= 0);
    assert.equal(await s.getText(ref), text);
  });

  it("works on a root that does not exist yet", async () => {
    const s = new FsBlobStore(join(root, "missing", "deep"));
    const listed: string[] = [];
    for await (const r of s.list()) listed.push(r);
    assert.deepEqual(listed, []);
    assert.equal(await s.size(), 0);
    await s.put("first");
    assert.ok(existsSync(s.root));
  });
});
