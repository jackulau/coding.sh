import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseGitAiNote, parseRangeSpec } from "../../src/attribution/gitai.ts";
import { filePatchId, isTrivial, lineKey, normalizeLine, parseUnifiedDiff, unquoteGitPath } from "../../src/attribution/lines.ts";

describe("line keys", () => {
  test("whitespace does not change a key; the class says how much a line can prove", () => {
    assert.equal(lineKey("  return a + b;\r"), lineKey("return  a + b;"));
    assert.equal(normalizeLine("\t a \t b "), "a b");
    for (const t of ["}", "", "  ", "});", "else", "} else {", "*/", ")", "];"]) assert.ok(isTrivial(normalizeLine(t)), t);
    for (const t of ["x = 1;", "return value;", "import x"]) assert.ok(!isTrivial(normalizeLine(t)), t);
    assert.ok(lineKey("}").startsWith("t"));
    assert.ok(lineKey("x = 1;").startsWith("s"));
    assert.ok(lineKey("export function longEnoughName() {").startsWith("l"));
  });

  test("patch id ignores line numbers and whitespace, not content", () => {
    const a = parseUnifiedDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,0 +4,2 @@\n+one\n+two\n")[0]!;
    const b = parseUnifiedDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -9,0 +10,2 @@\n+one\n+  two\n")[0]!;
    const c = parseUnifiedDiff("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -9,0 +10,2 @@\n+one\n+three\n")[0]!;
    assert.equal(filePatchId(a), filePatchId(b));
    assert.notEqual(filePatchId(a), filePatchId(c));
    assert.equal(filePatchId({ added: [], removed: [] }), undefined);
  });
});

describe("parseUnifiedDiff", () => {
  test("hunks, new line numbers, context, deletes, binaries, quoted paths", () => {
    const diff = [
      "\x01abc header line",
      "",
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,2 @@",
      "-old",
      "+new one",
      "+new two",
      "@@ -10,0 +12 @@ function x() {",
      "+added at 12",
      "\\ No newline at end of file",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/img.png b/img.png",
      "new file mode 100644",
      "Binary files /dev/null and b/img.png differ",
      'diff --git "a/sp ace\\tt\\303\\251.ts" "b/sp ace\\tt\\303\\251.ts"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/sp ace\\tt\\303\\251.ts"',
      "@@ -0,0 +1,3 @@",
      "+x",
      " ctx",
      "+y",
      "",
      "\x01next record",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    assert.deepEqual(
      files.map((f) => [f.path, f.added.map((a) => a.line), f.removed.length, !!f.deleted, !!f.binary]),
      [
        ["src/a.ts", [1, 2, 12], 1, false, false],
        ["gone.ts", [], 1, true, false],
        ["img.png", [], 0, false, true],
        ["sp ace\tté.ts", [1, 3], 0, false, false],
      ],
    );
    assert.equal(files[0]!.added[2]!.key, lineKey("added at 12"));
  });

  test("unquoteGitPath", () => {
    assert.equal(unquoteGitPath('"a\\"b\\\\c"'), 'a"b\\c');
    assert.equal(unquoteGitPath("plain"), "plain");
  });
});

describe("git-ai notes", () => {
  test("ranges", () => {
    assert.deepEqual(parseRangeSpec("1-10,15,20-22"), [[1, 10], [15, 15], [20, 22]]);
    assert.equal(parseRangeSpec("3-1"), undefined);
    assert.equal(parseRangeSpec("a"), undefined);
  });

  test("the v3 example: agents kept, humans skipped, legacy prompts resolved", () => {
    const note = [
      "src/main.rs",
      "  s_c9883b05a2487d::t_9f8e7d6c5b4a32 1-10,15-20",
      "  h_31dce776f88375 42-50",
      '"src/with space.rs"',
      "  0123456789abcdef 7",
      "---",
      JSON.stringify({
        schema_version: "authorship/3.0.0",
        base_commit_sha: "x",
        prompts: { "0123456789abcdef": { agent_id: { tool: "claude", id: "conv_abc", model: "claude-sonnet-4-5" } } },
        humans: { h_31dce776f88375: { author: "Dev <d@example.invalid>" } },
        sessions: { s_c9883b05a2487d: { agent_id: { tool: "cursor", id: "6ef2", model: "gpt-5" } } },
      }),
    ].join("\n");
    assert.deepEqual(parseGitAiNote(note), [
      { path: "src/main.rs", ranges: [[1, 10], [15, 20]], sessionId: "6ef2", tool: "cursor", model: "gpt-5" },
      { path: "src/with space.rs", ranges: [[7, 7]], sessionId: "conv_abc", tool: "claude", model: "claude-sonnet-4-5" },
    ]);
    assert.deepEqual(parseGitAiNote("no separator"), []);
    assert.deepEqual(parseGitAiNote("a\n  k 1\n---\nnot json"), []);
  });
});
