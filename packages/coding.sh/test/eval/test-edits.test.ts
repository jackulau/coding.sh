import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvalTask } from "../../src/core/types.ts";
import { patchDiff, referenceTestEdits } from "../../src/eval/test-edits.ts";
import { BUGGY, FakeSnapshots } from "../helpers-eval.ts";

const TEST = 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/add.js";\n\ntest("add sums", () => {\n  assert.equal(add(2, 3), 5);\n});\n';
const file = (path: string, body: string) => `diff --git a/${path} b/${path}\n${body}`;
/** Replaces the whole test with a no-op. */
const NOOP = file("test/add.test.js", `--- a/test/add.test.js\n+++ b/test/add.test.js\n@@ -1,7 +1 @@\n${TEST.trimEnd().split("\n").map((l) => `-${l}`).join("\n")}\n+console.log('ok');\n`);
/** Appends one test case, every existing line kept. */
const MORE = file("test/add.test.js", '--- a/test/add.test.js\n+++ b/test/add.test.js\n@@ -5,3 +5,7 @@\n test("add sums", () => {\n   assert.equal(add(2, 3), 5);\n });\n+\n+test("add sums negatives", () => {\n+  assert.equal(add(-2, -3), -5);\n+});\n');
const GONE = file("test/old.test.js", "deleted file mode 100644\n--- a/test/old.test.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-test();\n");
const NEW = file("test/new.test.js", "new file mode 100644\n--- /dev/null\n+++ b/test/new.test.js\n@@ -0,0 +1 @@\n+test();\n");
const FIX = file("src/add.js", "--- a/src/add.js\n+++ b/src/add.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }\n");

const task: EvalTask = {
  id: "t1",
  name: "toy",
  status: "draft",
  start: { repoRoot: "/work/toy", head: "abc", snapshot: "start" },
  instruction: "make the add test pass",
  setup: [],
  verifier: { command: "node test/add.test.js", hiddenFiles: {}, timeoutMs: 30_000 },
  tags: [],
  createdAt: 0,
};
const start = () => new FakeSnapshots().add("start", { ...BUGGY, "test/add.test.js": TEST });
const edits = async (patch: string, ops = start()) => (await referenceTestEdits(task, patch, ops)).map((f) => `${f.kind} ${f.path}`);

describe("patchDiff", () => {
  it("lists a patch's files as the runner's diff does", () => {
    assert.deepEqual(patchDiff(NOOP + GONE + NEW + FIX).files, [
      { path: "test/add.test.js", status: "modify", additions: 1, deletions: 7 },
      { path: "test/old.test.js", status: "delete", additions: 0, deletions: 1 },
      { path: "test/new.test.js", status: "add", additions: 1, deletions: 0 },
      { path: "src/add.js", status: "modify", additions: 1, deletions: 1 },
    ]);
  });
});

describe("referenceTestEdits", () => {
  it("names a rewritten or deleted test, and nothing for a fix, a new test file or added test cases", async () => {
    assert.deepEqual(await edits(FIX + NOOP), ["edit test/add.test.js"]);
    assert.deepEqual(await edits(FIX + GONE), ["delete test/old.test.js"]);
    assert.deepEqual(await edits(FIX + NEW), []);
    assert.deepEqual(await edits(FIX + MORE), []);
  });

  it("reads the start state only when the patch edits a test, and judges by path when there is none to read", async () => {
    const ops = start();
    await edits(FIX + NEW, ops);
    await edits(FIX + GONE, ops);
    assert.equal(ops.materialized, 0);
    await edits(FIX + MORE, ops);
    assert.equal(ops.materialized, 1);
    // A pruned start snapshot: the added test cases can't be told from a rewrite, so the edit stands.
    assert.deepEqual(await edits(FIX + MORE, new FakeSnapshots()), ["edit test/add.test.js"]);
  });
});
