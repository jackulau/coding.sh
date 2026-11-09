import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { after, describe, it } from "node:test";
import { sha256Hex } from "../../src/core/ids.ts";
import { FsBlobStore, PACK_FILE, PACK_MAX_BYTES, type FsBlobStoreOptions } from "../../src/store/fs-blobs.ts";
import { blobPath } from "../../src/store/common.ts";
import { ageBlob } from "./_blobs.ts";
import { tsNodeArgs } from "../capture/_helpers.ts";

const root = mkdtempSync(join(tmpdir(), "csh-blobs-"));
const opened: FsBlobStore[] = [];
after(async () => {
  for (const s of opened) await s.close();
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
const make = (opts?: FsBlobStoreOptions) => {
  const s = new FsBlobStore(join(root, `b${n++}`), opts);
  opened.push(s);
  return s;
};
/** Every blob a file: the file-layout tests below. */
const fresh = () => make({ packMaxBytes: 0 });

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
    opened.push(s);
    const listed: string[] = [];
    for await (const r of s.list()) listed.push(r);
    assert.deepEqual(listed, []);
    assert.equal(await s.size(), 0);
    await s.put("first");
    assert.ok(existsSync(s.root));
  });
});

describe("FsBlobStore pack", () => {
  /** Incompressible bytes: their zstd frame is about as big as they are. */
  const noise = (bytes: number) => randomBytes(bytes);
  const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String) : []);

  it("keeps a blob under one disk block in pack.db, and a larger one as a file", async () => {
    const s = make();
    const small = "a hook line's raw payload ".repeat(20);
    const big = noise(PACK_MAX_BYTES + 100);
    const [sr, br] = [await s.put(small), await s.put(big)];
    assert.equal(sr, sha256Hex(small));
    assert.ok(!existsSync(s.pathFor(sr)), "no file for the small blob");
    assert.ok(existsSync(s.pathFor(br)), "the big one is a file");
    assert.ok(existsSync(join(s.root, PACK_FILE)));
    assert.equal(await s.getText(sr), small);
    assert.deepEqual(Buffer.from((await s.get(br))!), big);
    assert.deepEqual(await s.has([sr, br, sha256Hex("nope")]), [true, true, false]);
    const listed: string[] = [];
    for await (const r of s.list()) listed.push(r);
    assert.deepEqual(listed.sort(), [sr, br].sort());
    assert.equal(await s.size(), (await s.stat(sr))!.size + statSync(s.pathFor(br)).size);
    // Highly compressible data well over a block still packs: the compressed size decides.
    const log = "line 7 of the same output\n".repeat(2000);
    const lr = await s.put(log);
    assert.ok(!existsSync(s.pathFor(lr)));
    assert.equal(await s.getText(lr), log);
  });

  it("a store with no pack reads, lists and sizes without creating one", async () => {
    const s = make();
    assert.equal(await s.get(sha256Hex("x")), undefined);
    assert.deepEqual(await s.has([sha256Hex("x")]), [false]);
    for await (const _ of s.list()) assert.fail("nothing to list");
    assert.equal(await s.size(), 0);
    assert.ok(!existsSync(join(s.root, PACK_FILE)));
  });

  it("reads a store written before the pack (every blob a file), and a re-put of a file blob writes nothing new", async () => {
    const dir = join(root, `b${n++}`);
    const before = new FsBlobStore(dir, { packMaxBytes: 0 });
    const big = noise(5000);
    const refs = [await before.put("old small blob"), await before.put(big)];
    const now = new FsBlobStore(dir);
    opened.push(now);
    assert.equal(await now.getText(refs[0]!), "old small blob");
    assert.deepEqual(Buffer.from((await now.get(refs[1]!))!), big);
    assert.equal(await now.put(big), refs[1]);
    const listed: string[] = [];
    for await (const r of now.list()) listed.push(r);
    assert.deepEqual(listed.sort(), [...refs].sort());
  });

  it("refreshes a row's mtime on a dedupe hit, and gc's deleteIfOlder keeps a row re-captured after its stat", async () => {
    const s = make();
    const ref = await s.put("x");
    await ageBlob(s, ref, 10);
    assert.ok(Date.now() - (await s.stat(ref))!.mtimeMs > 9 * 86_400_000);
    await s.put("x");
    assert.ok(Date.now() - (await s.stat(ref))!.mtimeMs < 60_000);
    assert.equal(await s.deleteIfOlder(ref, { olderThanMs: 86_400_000 }), "kept");
    await ageBlob(s, ref, 2);
    const size = (await s.stat(ref))!.size;
    assert.equal(await s.deleteIfOlder(ref, { olderThanMs: 86_400_000 }), size);
    assert.equal(await s.get(ref), undefined);
    assert.equal(await s.deleteIfOlder(ref, { olderThanMs: 86_400_000 }), undefined);
  });

  it("batch: small blobs are readable before the flush and land in one transaction on it", async () => {
    const s = make();
    const b = s.batch();
    const texts = Array.from({ length: 200 }, (_, i) => `blob ${i}`);
    const refs = await Promise.all(texts.map((t) => b.put(t)));
    assert.equal(await b.getText(refs[7]!), texts[7]);
    assert.deepEqual(await b.has([refs[3]!]), [true]);
    assert.deepEqual(await s.has([refs[3]!]), [false], "nothing in the store before the flush");
    await b.flush();
    for (const [i, r] of refs.entries()) assert.equal(await s.getText(r), texts[i]);
    assert.deepEqual(walk(s.root).filter((f) => f.endsWith(".zst") || f.endsWith(".tmp")), [], "no blob files");
  });

  it("a corrupt row reads as missing, and a re-put heals it", async () => {
    const s = make();
    const ref = await s.put("data to keep");
    const { loadSqlite } = await import("../../src/store/sqlite-open.ts");
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(join(s.root, PACK_FILE));
    db.prepare("UPDATE blobs SET data = ? WHERE ref = ?").run(zstdCompressSync(Buffer.from("other")), Buffer.from(ref, "hex"));
    db.close();
    assert.equal(await s.get(ref), undefined);
    await s.put("data to keep");
    assert.equal(await s.getText(ref), "data to keep");
  });

  it("delete removes a row; compact moves small file blobs in (keeping mtime) and leaves no deleted bytes in the pack or its WAL", async () => {
    const dir = join(root, `b${n++}`);
    const files = new FsBlobStore(dir, { packMaxBytes: 0 });
    const secret = "sk-live-TOPSECRET-0123456789";
    const oldRef = await files.put("written before the pack");
    const big = noise(6000);
    const bigRef = await files.put(big);
    await ageBlob(files, oldRef, 5);
    const s = new FsBlobStore(dir);
    opened.push(s);
    const gone = await s.put(`payload with ${secret} inside`);
    await s.delete(gone);
    assert.equal(await s.get(gone), undefined);
    assert.deepEqual(await s.compact(), { packed: 1, readerHeld: false });
    assert.ok(!existsSync(s.pathFor(oldRef)), "the small file moved into the pack");
    assert.ok(existsSync(s.pathFor(bigRef)), "a big one stays a file");
    if (oldRef.slice(0, 4) !== bigRef.slice(0, 4)) assert.ok(!existsSync(dirname(s.pathFor(oldRef))), "the folder it emptied is gone");
    if (oldRef.slice(0, 2) !== bigRef.slice(0, 2)) assert.ok(!existsSync(join(dir, oldRef.slice(0, 2))), "and its parent");
    assert.deepEqual(readdirSync(dir).filter((f) => /^[0-9a-f]{2}$/.test(f)), [bigRef.slice(0, 2)], "only the big blob's folder is left");
    assert.equal(await s.getText(oldRef), "written before the pack");
    assert.ok(Date.now() - (await s.stat(oldRef))!.mtimeMs > 4 * 86_400_000, "mtime kept");
    for (const f of readdirSync(dir).filter((f) => f.startsWith(PACK_FILE))) {
      assert.ok(!readFileSync(join(dir, f)).includes(secret), `${f} still holds the deleted bytes`);
    }
  });

  it("compact never ages a row that a put refreshed: an old file of the same blob moves in under the newer mtime", async () => {
    const dir = join(root, `b${n++}`);
    const ref = await new FsBlobStore(dir, { packMaxBytes: 0 }).put("captured last week and again today");
    utimesSync(join(dir, ...blobPath(ref)), new Date(Date.now() - 7 * 86_400_000), new Date(Date.now() - 7 * 86_400_000));
    const t = new FsBlobStore(dir);
    opened.push(t);
    await t.put("captured last week and again today");
    assert.deepEqual(await t.compact(), { packed: 1, readerHeld: false });
    assert.ok(!existsSync(t.pathFor(ref)));
    assert.ok(Date.now() - (await t.stat(ref))!.mtimeMs < 60_000, "the put's mtime stands");
  });

  it("compact says when another connection's read kept a deleted row's bytes, and finishes once it ends", async () => {
    const s = make();
    const secret = "sk-live-HELDBYAREADER-0123456789";
    const ref = await s.put(`payload with ${secret} inside`);
    await s.put("something else");
    const { loadSqlite } = await import("../../src/store/sqlite-open.ts");
    const { DatabaseSync } = await loadSqlite();
    const reader = new DatabaseSync(join(s.root, PACK_FILE)); // a sqlite3 shell or a backup, say
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM blobs").get();
      await s.delete(ref);
      assert.deepEqual(await s.compact({ waitMs: 100 }), { packed: 0, readerHeld: true });
      const packHolds = () => readdirSync(s.root).filter((f) => f.startsWith(PACK_FILE)).some((f) => readFileSync(join(s.root, f)).includes(secret));
      assert.ok(packHolds(), "SQLite kept the old pages for the reader");
      reader.exec("COMMIT");
      assert.deepEqual(await s.compact({ waitMs: 100 }), { packed: 0, readerHeld: false });
      assert.ok(!packHolds());
    } finally {
      reader.close();
    }
  });

  it("checkpoint() and close() empty the pack's WAL while another connection keeps the pack open", async () => {
    const s = make();
    await s.put("first");
    const { loadSqlite } = await import("../../src/store/sqlite-open.ts");
    const { DatabaseSync } = await loadSqlite();
    const viewer = new DatabaseSync(join(s.root, PACK_FILE)); // open, between reads: SQLite won't fold the WAL in on its own
    const wal = () => statSync(join(s.root, `${PACK_FILE}-wal`)).size;
    try {
      viewer.prepare("SELECT count(*) FROM blobs").get();
      const b = s.batch();
      for (let i = 0; i < 3000; i++) await b.put(noise(1000));
      await b.flush();
      assert.ok(wal() > 2_000_000, `a bulk write fills the WAL (${wal()} bytes)`);
      await s.checkpoint();
      assert.equal(wal(), 0);
      await s.put("one more");
      assert.ok(wal() > 0);
      await s.close();
      assert.equal(wal(), 0);
    } finally {
      viewer.close();
    }
  });

  it("a put that finds the pack's write lock taken writes a file instead of failing, and compact moves it in", async () => {
    const s = make();
    await s.put("first");
    const { loadSqlite } = await import("../../src/store/sqlite-open.ts");
    const { DatabaseSync } = await loadSqlite();
    const writer = new DatabaseSync(join(s.root, PACK_FILE)); // another process's long write
    writer.exec("BEGIN IMMEDIATE");
    let single: string;
    let batched: string;
    try {
      const t0 = Date.now();
      single = await s.put("put while the pack is locked");
      const b = s.batch();
      batched = await b.put("batched while the pack is locked");
      await b.flush();
      assert.ok(Date.now() - t0 < 3000, `waited ${Date.now() - t0} ms, not the 5 s busy timeout`);
      assert.ok(existsSync(s.pathFor(single)) && existsSync(s.pathFor(batched)), "both became files");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    assert.equal(await s.getText(single), "put while the pack is locked");
    assert.equal(await s.getText(batched), "batched while the pack is locked");
    const later = await s.put("put once the lock is free");
    assert.ok(!existsSync(s.pathFor(later)), "back in the pack");
    assert.deepEqual(await s.compact(), { packed: 2, readerHeld: false });
    assert.ok(!existsSync(s.pathFor(single)) && !existsSync(s.pathFor(batched)));
    assert.equal(await s.getText(single), "put while the pack is locked");
  });

  it("gc's delete removes a blob that is both a row and a file (a put that found the pack locked wrote the file)", async () => {
    const s = make();
    await s.put("first");
    const { loadSqlite } = await import("../../src/store/sqlite-open.ts");
    const { DatabaseSync } = await loadSqlite();
    const writer = new DatabaseSync(join(s.root, PACK_FILE));
    writer.exec("BEGIN IMMEDIATE");
    let ref: string;
    try {
      ref = await s.put("twice over");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    await s.put("twice over"); // the lock is free: now a row too
    assert.ok(existsSync(s.pathFor(ref)) && (await s.stat(ref)));
    const gone = await s.deleteIfOlder(ref, { olderThanMs: 0, now: Date.now() + 60_000 });
    assert.equal(typeof gone, "number");
    assert.ok(!existsSync(s.pathFor(ref)), "the file went with the row");
    assert.equal(await s.get(ref), undefined);
  });

  it("processes putting at once lose no blob, even while one holds the write lock past the busy timeout", async () => {
    const s = make();
    await s.put("first");
    await s.close();
    const { loadSqlite } = await import("../../src/store/sqlite-open.ts");
    const { DatabaseSync } = await loadSqlite();
    const module = pathToFileURL(join(import.meta.dirname, "../../src/store/fs-blobs.ts")).href;
    // Each process: says it is ready, puts one by one, then in a batch; prints its error count and refs.
    const src = `import { FsBlobStore } from ${JSON.stringify(module)};
      const s = new FsBlobStore(process.argv[1]); const refs = []; let errors = 0; console.log("ready");
      for (let i = 0; i < 120; i++) { try { refs.push(await s.put("p" + process.pid + "-" + i)); } catch (e) { errors++; console.error(String(e)); } }
      const b = s.batch(); for (let i = 0; i < 50; i++) refs.push(await b.put("b" + process.pid + "-" + i));
      try { await b.flush(); } catch (e) { errors++; console.error(String(e)); }
      await s.close(); console.log(JSON.stringify({ errors, refs }));`;
    const writer = new DatabaseSync(join(s.root, PACK_FILE)); // a long transaction in another process
    writer.exec("BEGIN IMMEDIATE");
    const ready: Promise<void>[] = [];
    const runs = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, [...tsNodeArgs(), "--input-type=module", "-e", src, s.root], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => (out += d));
      ready.push(new Promise((res) => child.stdout.on("data", () => out.startsWith("ready") && res())));
      child.stderr.on("data", (d: Buffer) => (err += d));
      return new Promise<{ errors: number; refs: string[] }>((res, rej) =>
        child.once("exit", (code) => (code === 0 ? res(JSON.parse(out.trim().split("\n").pop()!)) : rej(new Error(`exit ${code}: ${err}`)))),
      );
    });
    try {
      await Promise.race([Promise.all(ready), Promise.all(runs)]);
      await new Promise((r) => setTimeout(r, 5500)); // past the 5 s busy timeout a put used to wait before it failed
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    const results = await Promise.all(runs);
    assert.deepEqual(results.map((r) => r.errors), [0, 0, 0, 0]);
    const refs = results.flatMap((r) => r.refs);
    assert.equal(refs.length, 4 * 170);
    assert.deepEqual(await s.has(refs), refs.map(() => true));
    for (const ref of refs) assert.ok(await s.get(ref), `${ref} reads back`);
  });
});
