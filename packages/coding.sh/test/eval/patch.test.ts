import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ngramOverlap, tokenize } from "../../src/eval/leakage.ts";
import { addedLines, dropHunk, filterPatch, formatPatch, hunkCount, nearMissMutations, parsePatch, patchPaths } from "../../src/eval/patch.ts";
import { applyPatch } from "../../src/runner/git.ts";
import { matchGlob, staticPrefix } from "../../src/runner/glob.ts";
import { tempDir } from "../helpers-eval.ts";

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";
const ORIG = lines(40, (i) => `line ${i}`);
const NEW = lines(40, (i) => (i === 3 ? "line 3 changed\nline 3b added" : i === 30 ? "line 30 changed" : `line ${i}`));

async function gitDiff(a: string, b: string): Promise<{ patch: string; dir: string }> {
  const dir = await tempDir("csh-patch-test-");
  await mkdir(join(dir, "a"), { recursive: true });
  await writeFile(join(dir, "a", "f.txt"), a);
  await writeFile(join(dir, "b.txt"), b);
  const { execFileSync } = await import("node:child_process");
  let patch = "";
  try {
    execFileSync("git", ["diff", "--no-index", "a/f.txt", "b.txt"], { cwd: dir });
  } catch (e) {
    patch = String((e as { stdout: Buffer }).stdout);
  }
  // Rewrite to a normal a/ b/ patch for path f.txt.
  patch = patch.replace(/a\/a\/f\.txt/g, "a/f.txt").replace(/b\/b\.txt/g, "b/f.txt");
  await rm(join(dir, "b.txt"));
  await rm(join(dir, "a"), { recursive: true });
  await writeFile(join(dir, "f.txt"), a);
  return { patch, dir };
}

const MULTI = `diff --git a/src/x.js b/src/x.js
index 1111111..2222222 100644
--- a/src/x.js
+++ b/src/x.js
@@ -1,3 +1,3 @@ function x() {
 a
-b
+B
 c
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
diff --git a/img.png b/img.png
index 4444444..5555555 100644
GIT binary patch
literal 3
Kcmb=Z<NyEyg8&8r

literal 0
HcmV?d00001

`;

describe("parsePatch / formatPatch", () => {
  it("round-trips a multi-file patch with a binary section and no-newline marker", () => {
    const p = parsePatch(MULTI);
    assert.equal(p.files.length, 3);
    assert.deepEqual(p.files.map((f) => f.newPath), ["src/x.js", "new.txt", "img.png"]);
    assert.equal(p.files[1]?.oldPath, undefined);
    assert.equal(p.files[2]?.opaque, true);
    assert.equal(hunkCount(p), 2);
    assert.equal(formatPatch(p), MULTI);
  });
  it("addedLines / patchPaths / filterPatch", () => {
    assert.deepEqual(addedLines(MULTI), ["B", "hello", "world"]);
    assert.deepEqual(patchPaths(MULTI), ["src/x.js", "new.txt", "img.png"]);
    assert.deepEqual(patchPaths(filterPatch(MULTI, (p) => p === "new.txt")), ["src/x.js", "img.png"]);
  });
  it("parses plain (non-git) unified diffs", () => {
    const p = parsePatch("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-p\n+q\n");
    assert.deepEqual(p.files.map((f) => f.newPath), ["f", "g"]);
    assert.equal(hunkCount(p), 2);
  });
  it("keeps a removed line that looks like a header inside a hunk", () => {
    const t = "--- a/f\n+++ b/f\n@@ -1,2 +1 @@\n--- not a header\n keep\n";
    const p = parsePatch(t);
    assert.equal(p.files.length, 1);
    assert.equal(formatPatch(p), t);
  });
});

describe("dropHunk / nearMissMutations", () => {
  it("each dropped-hunk patch still applies with git apply", async () => {
    const { patch, dir } = await gitDiff(ORIG, NEW);
    try {
      const p = parsePatch(patch);
      assert.equal(hunkCount(p), 2);
      const muts = nearMissMutations(patch);
      assert.equal(muts.length, 2);
      for (const m of muts) {
        await writeFile(join(dir, "f.txt"), ORIG);
        const r = await applyPatch(dir, m.patch);
        assert.ok(r.ok, `${m.label}: ${r.error}`);
      }
      // Dropping the first hunk (which adds a line) must shift the second's new start back by one.
      const second = dropHunk(p, 0, 0).files[0]?.hunks[0];
      const orig2 = p.files[0]?.hunks[1];
      assert.equal(second?.newStart, (orig2?.newStart ?? 0) - 1);
      await writeFile(join(dir, "f.txt"), ORIG);
      assert.ok((await applyPatch(dir, formatPatch(dropHunk(p, 0, 0)))).ok);
      const text = await readFile(join(dir, "f.txt"), "utf8");
      assert.match(text, /line 30 changed/);
      assert.doesNotMatch(text, /line 3 changed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("single-hunk patches produce no mutations; max is respected; whole new-file section dropped", () => {
    assert.deepEqual(nearMissMutations("--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y\n"), []);
    assert.equal(nearMissMutations(MULTI, { max: 1 }).length, 1);
    const m = nearMissMutations(MULTI);
    assert.equal(m.length, 2);
    assert.match(m[1]?.label ?? "", /skip creating in new\.txt/);
    assert.deepEqual(patchPaths(m[1]?.patch ?? ""), ["src/x.js", "img.png"]);
  });
});

describe("leakage n-grams", () => {
  it("tokenizes code", () => {
    assert.deepEqual(tokenize("return a+b;"), ["return", "a", "+", "b", ";"]);
  });
  it("prose mentioning identifiers does not trip; pasted code does", () => {
    const code = "export function add(a, b) {\n  return a + b;\n}\n";
    assert.equal(ngramOverlap(code, "The add function returns the wrong result for a and b").fraction, 0);
    const pasted = ngramOverlap(code, `Please make it look like:\n${code}`);
    assert.equal(pasted.fraction, 1);
    assert.equal(ngramOverlap("tiny", "tiny").total, 0);
  });
});

describe("glob", () => {
  it("matches", () => {
    assert.ok(matchGlob(".claude/settings.json", ".claude/**"));
    assert.ok(matchGlob(".claude/a/b.md", ".claude"));
    assert.ok(matchGlob("x.test.ts", "**/*.test.ts"));
    assert.ok(matchGlob("a/b/x.test.ts", "**/*.test.ts"));
    assert.ok(matchGlob("src/x.js", "src/*.{ts,js}"));
    assert.ok(!matchGlob("src/a/x.ts", "src/*.ts"));
    assert.ok(!matchGlob("CLAUDE.md.bak", "CLAUDE.md"));
    assert.equal(staticPrefix(".claude/**/x"), ".claude");
    assert.equal(staticPrefix("**/*.ts"), "");
  });
});
