import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
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

  it("reports corrupt blobs clearly and ignores foreign files in list()", async () => {
    const s = fresh();
    const ref = await s.put("data");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    writeFileSync(s.pathFor(ref), "not zstd");
    await assert.rejects(() => s.get(ref), /is corrupt/);
    mkdirSync(join(s.root, "zz"), { recursive: true });
    writeFileSync(join(s.root, "README"), "x");
    const listed: string[] = [];
    for await (const r of s.list()) listed.push(r);
    assert.deepEqual(listed, [ref]);
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
