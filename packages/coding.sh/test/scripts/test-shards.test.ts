import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeDurations, readDurations, shardFiles, testFiles } from "../../scripts/test-shards.ts";

const PKG = fileURLToPath(new URL("../../", import.meta.url));
const RUNNER = fileURLToPath(new URL("../../scripts/test-ci.mjs", import.meta.url));

describe("scripts/test-shards.ts", () => {
  it("puts every test file in exactly one shard, for any shard count", () => {
    const files = testFiles(PKG);
    assert.ok(files.length > 100, `found only ${files.length} test files`);
    const durations = readDurations();
    for (let n = 1; n <= 6; n++) {
      const shards = Array.from({ length: n }, (_, i) => shardFiles(files, durations, i + 1, n));
      const all = shards.flat();
      assert.equal(all.length, files.length, `n=${n}: a file is in two shards or none`);
      assert.deepEqual([...all].sort(), files, `n=${n}`);
      for (const s of shards) assert.ok(s.length > 0, `n=${n}: an empty shard`);
    }
  });

  it("finds the same files as the test glob", () => {
    const globbed = globSync("test/**/*.test.ts", { cwd: PKG })
      .map((f) => f.replaceAll("\\", "/"))
      .sort();
    assert.deepEqual(testFiles(PKG), globbed);
  });

  it("splits by time, not by count", () => {
    const files = ["a", "b", "c", "d", "e", "f"];
    const durations = { a: 60, b: 10, c: 10, d: 10, e: 10, f: 10 };
    assert.deepEqual(shardFiles(files, durations, 1, 2), ["a"]);
    assert.deepEqual(shardFiles(files, durations, 2, 2), ["b", "c", "d", "e", "f"]);
  });

  it("counts a file with no recorded time as the median file", () => {
    const files = ["a", "b", "c", "new"];
    const durations = { a: 100, b: 5, c: 5 };
    // new weighs 5: a alone, then b, c and new on the other shard.
    assert.deepEqual(shardFiles(files, durations, 1, 2), ["a"]);
    assert.deepEqual(shardFiles(files, durations, 2, 2), ["b", "c", "new"]);
  });

  it("splits files with no times at all by name, the same way every time", () => {
    const files = ["d", "a", "c", "b"];
    assert.deepEqual(shardFiles(files, {}, 1, 2), ["a", "c"]);
    assert.deepEqual(shardFiles(files, {}, 2, 2), ["b", "d"]);
  });

  it("merges reporter outputs, keeping the higher time", () => {
    assert.deepEqual(mergeDurations([{ b: 1.4, a: 3 }, { a: 7 }]), { a: 7, b: 1 });
  });
});

describe("scripts/test-ci.mjs with SHARD", () => {
  function run(dir: string, env: Record<string, string>) {
    const e: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete e.NODE_TEST_CONTEXT; // else the inner node --test reports to this test run
    const r = spawnSync(process.execPath, [RUNNER], { cwd: dir, encoding: "utf8", env: e, timeout: 60_000 });
    return { code: r.status, out: r.stdout + r.stderr };
  }

  it("runs each file in one shard only, and writes the files' times", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-shards-"));
    try {
      mkdirSync(join(dir, "test", "sub"), { recursive: true });
      for (const f of ["test/a.test.ts", "test/b.test.ts", "test/sub/c.test.ts"]) {
        writeFileSync(join(dir, f), `import { it } from "node:test"; it("ran ${f}", () => {});`);
      }
      writeFileSync(join(dir, "test", "helper.ts"), "export {};");
      const ran: string[] = [];
      for (const shard of ["1/2", "2/2"]) {
        const out = join(dir, `times-${shard[0]}.json`);
        const r = run(dir, { SHARD: shard, TEST_DURATIONS_OUT: out });
        assert.equal(r.code, 0, r.out);
        for (const m of r.out.matchAll(/ran (test\/\S+)/g)) if (m[1]) ran.push(m[1]);
        for (const f of Object.keys(JSON.parse(readFileSync(out, "utf8")))) assert.match(f, /^test\/.+\.test\.ts$/);
      }
      assert.deepEqual(ran.sort(), ["test/a.test.ts", "test/b.test.ts", "test/sub/c.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed SHARD", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-shards-"));
    try {
      mkdirSync(join(dir, "test"));
      const r = run(dir, { SHARD: "3/2" });
      assert.notEqual(r.code, 0);
      assert.match(r.out, /SHARD must be i\/n/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
