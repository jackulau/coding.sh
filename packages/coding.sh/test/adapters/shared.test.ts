// Unit tests for the shared adapter toolkit (src/adapters/_shared).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseToml } from "../../src/core/toml.ts";
import {
  buildHookCommand,
  editStats,
  ensureTomlKey,
  fileChangesOf,
  hasTomlBlock,
  isCodingShCommand,
  isTestCommand,
  mergeFlatHooks,
  mergeNestedHooks,
  openaiUsage,
  anthropicUsage,
  parseHookCommand,
  parsePatch,
  parseTestOutput,
  removeTomlBlock,
  revertTomlKey,
  shellCommandOf,
  stripNestedHooks,
  upsertTomlBlock,
} from "../../src/adapters/_shared/index.ts";

describe("test-output heuristics", () => {
  const cases: [string, string, string | undefined, [number, number, number?]][] = [
    ["vitest", " ✓ a.test.ts (3)\n Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 12 passed | 1 skipped (15)\n", "npx vitest run", [12, 2, 1]],
    ["jest", "Tests:       1 failed, 2 skipped, 10 passed, 13 total\nSnapshots:   0 total\n", "npm test", [10, 1, 2]],
    ["pytest", "....F\n=========== 1 failed, 4 passed, 1 skipped, 1 error in 0.42s ===========\n", "pytest -q", [4, 2, 1]],
    ["go", "=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\n--- SKIP: TestC (0.00s)\nFAIL\n", "go test -v ./...", [1, 1, 1]],
    ["go", "ok  \texample.com/a\t0.012s\nFAIL\texample.com/b\t0.020s\n", "go test ./...", [1, 1]],
    ["cargo", "test result: ok. 10 passed; 0 failed; 1 ignored; 0 measured\ntest result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured\n", "cargo test", [12, 1, 1]],
    ["node:test", "# tests 5\n# pass 4\n# fail 1\n# skipped 0\n", "node --test", [4, 1]],
    ["node:test", "ℹ tests 3\nℹ pass 3\nℹ fail 0\n", "node --test test/", [3, 0]],
    ["mocha", "  10 passing (20ms)\n  2 failing\n  1 pending\n", "npx mocha", [10, 2, 1]],
  ];
  for (const [runner, out, cmd, [passed, failed, skipped]] of cases) {
    it(`${runner}: ${cmd}`, () => {
      const s = parseTestOutput(out, cmd)!;
      assert.ok(s, "parsed");
      assert.deepEqual([s.runner, s.passed, s.failed, s.skipped], [runner, passed, failed, skipped]);
    });
  }

  it("strips ANSI colors", () => {
    assert.equal(parseTestOutput("\u001b[32m      Tests  \u001b[1m3 passed\u001b[22m (3)\u001b[39m\n", "vitest")?.passed, 3);
  });

  it("weak signals (mocha/go) need a test command; noise is ignored", () => {
    assert.equal(parseTestOutput("  10 passing (20ms)\n", "cat log.txt"), undefined);
    assert.equal(parseTestOutput("--- PASS: TestA (0.00s)\n", "grep PASS out"), undefined);
    assert.equal(parseTestOutput("hello world", "npm test"), undefined);
    assert.equal(parseTestOutput(undefined, "npm test"), undefined);
  });

  it("recognizes test commands", () => {
    for (const c of ["npm test", "pnpm run test:unit", "bun test", "python -m pytest -x", "go test ./...", "cargo nextest run", "node --test", "cd pkg && npx vitest run"]) assert.ok(isTestCommand(c), c);
    for (const c of ["ls", "npm install", "git status", "echo latest"]) assert.ok(!isTestCommand(c), c);
  });
});

describe("file-change derivation", () => {
  it("parses apply_patch envelopes", () => {
    const p = "*** Begin Patch\n*** Add File: a.txt\n+one\n+two\n*** Update File: b.ts\n*** Move to: c.ts\n@@\n-x\n+y\n+z\n*** Delete File: d.md\n*** End Patch\n";
    assert.deepEqual(parsePatch(p), [
      { path: "a.txt", op: "add", additions: 2, deletions: 0 },
      { path: "b.ts", op: "modify", additions: 2, deletions: 1, movedTo: "c.ts" },
      { path: "d.md", op: "delete" },
    ]);
  });

  it("parses git diffs", () => {
    const d = "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,2 +1,2 @@\n-a\n+b\n c\ndiff --git a/n.js b/n.js\nnew file mode 100644\n--- /dev/null\n+++ b/n.js\n@@ -0,0 +1 @@\n+hi\n";
    const changes = parsePatch(d);
    assert.deepEqual(changes.map((c) => [c.path, c.op, c.additions, c.deletions]), [["x.js", "modify", 1, 1], ["n.js", "add", 1, 0]]);
  });

  it("edit tools across agents → relative paths and line stats", () => {
    assert.deepEqual(editStats("a\nb\nc", "a\nB\nc\nd"), { additions: 2, deletions: 1 });
    assert.deepEqual(fileChangesOf("Edit", { file_path: "/w/src/a.ts", old_string: "x", new_string: "y\nz" }, undefined, "/w"), [{ path: "src/a.ts", op: "modify", additions: 2, deletions: 1, diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-x\n+y\n+z\n" }]);
    assert.deepEqual(fileChangesOf("Write", { file_path: "/w/n.md", content: "# t\n\nx\n" }, { type: "create" }, "/w"), [{ path: "n.md", op: "add", additions: 3, deletions: 0, diff: "--- /dev/null\n+++ b/n.md\n@@ -0,0 +1,3 @@\n+# t\n+\n+x\n" }]);
    assert.deepEqual(fileChangesOf("apply_patch", { command: "*** Begin Patch\n*** Delete File: z\n*** End Patch" }), [{ path: "z", op: "delete" }], "Codex hook input");
    assert.deepEqual(fileChangesOf("Read", { file_path: "/w/a" }), []);
  });

  it("Claude Code Bash edits (toolUseResult.bashEditDiff) → one change per file", () => {
    const diff = {
      files: [
        { filePath: "/w/notes.txt", hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["-alpha", "+beta", " bravo"] }] },
        { filePath: "/w/gen.txt", created: true, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+one", "+two"] }] },
        { filePath: "/w/old.txt", deleted: true, hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-x"] }] },
      ],
      moreFiles: 1,
      changedFiles: ["/w/notes.txt", "/w/gen.txt", "/w/old.txt", "/w/big.bin"],
    };
    assert.deepEqual(fileChangesOf("Bash", { command: "sh edit.sh" }, { stdout: "", bashEditDiff: diff }, "/w"), [
      { path: "notes.txt", op: "modify", additions: 1, deletions: 1, diff: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n-alpha\n+beta\n bravo\n" },
      { path: "gen.txt", op: "add", additions: 2, deletions: 0, diff: "--- /dev/null\n+++ b/gen.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n" },
      { path: "old.txt", op: "delete", additions: 0, deletions: 1, diff: "--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n" },
      { path: "big.bin", op: "modify" },
    ]);
    assert.deepEqual(fileChangesOf("Bash", { command: "x" }, { bashEditDiff: { unavailable: true, files: [] } }, "/w"), []);
    assert.deepEqual(fileChangesOf("Bash", { command: "ls" }, { stdout: "a" }, "/w"), [], "no diff, no change");
  });

  it("unwraps shell commands", () => {
    assert.equal(shellCommandOf("shell", { command: ["bash", "-lc", "npm test"] }), "npm test");
    assert.equal(shellCommandOf("Bash", { command: "ls -la" }), "ls -la");
    assert.equal(shellCommandOf("exec_command", { cmd: "pytest" }), "pytest");
    assert.equal(shellCommandOf("Read", { command: "x" }), undefined);
  });
});

describe("usage mapping", () => {
  it("OpenAI input includes cached tokens; normalized input excludes them", () => {
    assert.deepEqual(openaiUsage({ input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 }), { inputTokens: 200, cacheReadTokens: 800, outputTokens: 50 });
    assert.deepEqual(openaiUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } }), { inputTokens: 6, cacheReadTokens: 4, outputTokens: 2 });
  });
  it("Anthropic usage maps cache fields", () => {
    assert.deepEqual(anthropicUsage({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }), { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 20 });
  });
});

describe("hook command + merge", () => {
  const hook = "/home/u/.coding.sh/bin/hook.mjs";
  it("builds and recognizes our command", () => {
    const cmd = buildHookCommand("/p a/$x/hook.mjs", "codex", "Stop", ["--echo-continue"]);
    assert.equal(cmd, 'node "/p a/\\$x/hook.mjs" codex Stop --echo-continue');
    assert.deepEqual(parseHookCommand(cmd), { hookPath: "/p a/$x/hook.mjs", agent: "codex" });
    assert.ok(isCodingShCommand(buildHookCommand(hook, "codex", "Stop"), "codex"));
    assert.ok(!isCodingShCommand(buildHookCommand(hook, "codex", "Stop"), "claude-code"), "agent-specific");
    assert.ok(!isCodingShCommand("node ./my-hook.mjs codex Stop", "codex"));
  });

  it("nested merge appends after user entries, is idempotent, and strips cleanly", () => {
    const user = { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] };
    const specs = [{ event: "Stop", hook: { type: "command", command: buildHookCommand(hook, "x", "Stop") } }];
    const merged = mergeNestedHooks(structuredClone(user), specs, { agent: "x", marker: true });
    assert.equal((merged.Stop as unknown[]).length, 2);
    assert.equal(((merged.Stop as Record<string, unknown>[])[0]!.hooks as Record<string, unknown>[])[0]!.command, "say done");
    assert.deepEqual(mergeNestedHooks(structuredClone(merged), specs, { agent: "x", marker: true }), merged);
    assert.deepEqual(stripNestedHooks(merged, { agent: "x" }), user);
  });

  it("flat merge (Cursor/Copilot layout)", () => {
    const merged = mergeFlatHooks({ stop: [{ command: "mine" }] }, [{ event: "stop", entry: { command: buildHookCommand(hook, "cursor", "stop") } }], { agent: "cursor", marker: false });
    assert.deepEqual((merged.stop as Record<string, unknown>[]).map((e) => e.command), ["mine", `node "${hook}" cursor stop`]);
  });
});

describe("toml edits", () => {
  const src = '# my config\nmodel = "o3"\n\n[features]\nweb = true # keep\n';
  it("ensureTomlKey adds/overrides with a tag and revertTomlKey restores the original", () => {
    const added = ensureTomlKey(src, "features", "hooks", "true");
    assert.equal(parseToml(added).features && (parseToml(added).features as Record<string, unknown>).hooks, true);
    assert.equal(ensureTomlKey(added, "features", "hooks", "true"), added, "idempotent");
    assert.equal(revertTomlKey(added, "features", "hooks"), src);

    const off = src.replace("web = true # keep", "web = true # keep\nhooks = false");
    const forced = ensureTomlKey(off, "features", "hooks", "true");
    assert.match(forced, /# coding\.sh \(was: false\)/);
    assert.equal(revertTomlKey(forced, "features", "hooks"), off);

    const fresh = ensureTomlKey(undefined, "features", "hooks", "true");
    assert.equal((parseToml(fresh).features as Record<string, unknown>).hooks, true);
  });

  it("marked blocks upsert/remove without touching user content", () => {
    const withBlock = upsertTomlBlock(src, "notify", 'notify = ["node", "x"]');
    assert.ok(hasTomlBlock(withBlock, "notify"));
    assert.deepEqual(parseToml(withBlock).notify, ["node", "x"]);
    assert.equal(upsertTomlBlock(withBlock, "notify", 'notify = ["node", "x"]'), withBlock);
    assert.equal(removeTomlBlock(withBlock, "notify"), src);
  });

  it("a marked block whose END moved below a foreign table is not removed (INS-3)", () => {
    const moved = '# >>> coding.sh:mcp-server (managed by coding.sh)\n[mcp_servers.coding-sh]\ncommand = "x"\n\n[mcp_servers.my-db]\ncommand = "db"\n# <<< coding.sh:mcp-server\n';
    assert.equal(hasTomlBlock(moved, "mcp-server"), false);
    assert.equal(removeTomlBlock(moved, "mcp-server"), moved);
  });
});
