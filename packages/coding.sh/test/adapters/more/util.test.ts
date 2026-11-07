import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileTouches, isOurCommand, parseJsonc, parseTestSummary, spawnAgent, toMs, usageFrom } from "../../../src/adapters/more/_util.ts";
import type { TmpEnv } from "../_helpers.ts";
import { fakeBinary, moreEnv } from "./_helpers.ts";

describe("parseTestSummary", () => {
  const cases: [string, string, unknown][] = [
    ["cargo", "test result: FAILED. 5 passed; 1 failed; 2 ignored; 0 measured", { runner: "cargo", passed: 5, failed: 1, skipped: 2 }],
    ["jest", "Tests:       1 failed, 2 skipped, 5 passed, 8 total", { runner: "jest", passed: 5, failed: 1, skipped: 2 }],
    ["vitest", "      Tests  2 failed | 10 passed | 1 skipped (13)", { runner: "vitest", passed: 10, failed: 2, skipped: 1 }],
    ["node:test", "# tests 6\n# pass 5\n# fail 1\n# skipped 0", { runner: "node", passed: 5, failed: 1, skipped: 0 }],
    ["node spec", "ℹ pass 3\nℹ fail 0", { runner: "node", passed: 3, failed: 0 }],
    ["pytest", "===== 3 failed, 10 passed, 1 skipped, 2 errors in 0.52s =====", { runner: "pytest", passed: 10, failed: 5, skipped: 1 }],
    ["mocha", "  5 passing (20ms)\n  2 pending\n  1 failing", { runner: "mocha", passed: 5, failed: 1, skipped: 2 }],
    ["go", "--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n--- PASS: TestC (0.00s)", { runner: "go", passed: 2, failed: 1 }],
    ["go pkgs", "ok  \texample.com/a\t0.01s\nFAIL\texample.com/b\t0.02s", { runner: "go", passed: 1, failed: 1 }],
  ];
  for (const [name, text, want] of cases) it(name, () => assert.deepEqual(parseTestSummary(text), want));
  it("takes the last summary and ignores ANSI colour", () => {
    assert.deepEqual(parseTestSummary("Tests:  1 failed, 1 total\n\x1b[1mTests:\x1b[22m  2 passed, 2 total"), { runner: "jest", passed: 2, failed: 0, skipped: 0 });
  });
  it("returns undefined for non-test output", () => assert.equal(parseTestSummary("compiled successfully"), undefined));
});

describe("fileTouches", () => {
  it("reads apply_patch bodies", () => {
    const patch = "*** Begin Patch\n*** Add File: /r/a.ts\n+x\n*** Update File: b.ts\n*** Delete File: /r/c.ts\n*** End Patch";
    assert.deepEqual(fileTouches("apply_patch", { input: patch }, "/r"), [
      { path: "a.ts", op: "add" },
      { path: "b.ts", op: "modify" },
      { path: "c.ts", op: "delete" },
    ]);
  });
  it("maps edit-like tools by name and path keys", () => {
    assert.deepEqual(fileTouches("Create", { file_path: "/r/x.py" }, "/r"), [{ path: "x.py", op: "add" }]);
    assert.deepEqual(fileTouches("delete_file", { path: "/r/y" }, "/r"), [{ path: "y", op: "delete" }]);
    assert.deepEqual(fileTouches("MultiEdit", { edits: [{ file_path: "/r/a" }, { file_path: "/r/a" }, { file_path: "/elsewhere/b" }] }, "/r"), [
      { path: "a", op: "modify" },
      { path: "/elsewhere/b", op: "modify" },
    ]);
  });
  it("ignores read-only tools", () => {
    assert.deepEqual(fileTouches("read_file", { path: "/r/a" }, "/r"), []);
    assert.deepEqual(fileTouches("Bash", { command: "rm -rf x" }, "/r"), []);
  });
});

describe("small parsers", () => {
  it("toMs accepts ISO, seconds and ms", () => {
    assert.equal(toMs("2026-09-21T10:00:00.000Z"), Date.parse("2026-09-21T10:00:00.000Z"));
    assert.equal(toMs(1790000000), 1790000000000);
    assert.equal(toMs(1790000000123), 1790000000123);
    assert.equal(toMs("1790000000"), 1790000000000);
    assert.equal(toMs("nope"), undefined);
  });
  it("usageFrom reads the common shapes", () => {
    assert.deepEqual(usageFrom({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, total_cost_usd: 0.5 }), { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 });
    assert.deepEqual(usageFrom({ promptTokenCount: 5, candidatesTokenCount: 6, cachedContentTokenCount: 1 }), { inputTokens: 5, outputTokens: 6, cacheReadTokens: 1 });
    assert.deepEqual(usageFrom({ input: 7, output: 8, cacheRead: 2, cacheWrite: 1, cost: { total: 0.1 } }), { inputTokens: 7, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1, costUsd: 0.1 });
    assert.equal(usageFrom({}), undefined);
  });
  it("parseJsonc tolerates comments and trailing commas", () => {
    assert.deepEqual(parseJsonc('{\n // c\n "a": "http://x", /* b */ "b": [1,2,],\n}'), { a: "http://x", b: [1, 2] });
  });
  it("isOurCommand recognises our hook for the right agent only", () => {
    assert.ok(isOurCommand('node "/x/hook.mjs" gemini-cli AfterTool', "gemini-cli"));
    assert.ok(!isOurCommand('node "/x/hook.mjs" gemini-cli AfterTool', "gemini"));
    assert.ok(!isOurCommand("./guard.sh gemini-cli x", "gemini-cli"));
  });
});

describe("spawnAgent", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("times out, kills the process group and keeps output tails", async () => {
    const bin = join(env.root, "bin");
    mkdirSync(bin, { recursive: true });
    // A sh script, not node: it prints at once, so "started" is out long before the
    // timeout even on a loaded machine (a node binary's startup alone can take
    // seconds there). The background sleeper checks the whole group is killed.
    const p = join(bin, "slow");
    const pidFile = join(env.root, "slow.bg.pid");
    writeFileSync(p, `#!/bin/sh\necho started\nsleep 60 &\necho $! > ${JSON.stringify(pidFile)}\nwait\n`);
    chmodSync(p, 0o755);
    mkdirSync(join(env.root, "w"), { recursive: true });
    const r = await spawnAgent({ bin: p, args: [], cwd: join(env.root, "w"), env: { ...process.env }, timeoutMs: 2000 });
    assert.equal(r.timedOut, true);
    assert.match(r.stdoutTail, /started/);
    assert.ok(r.durationMs < 30_000, `took ${r.durationMs}ms`);
    const bg = Number(readFileSync(pidFile, "utf8").trim());
    let alive = true;
    try {
      process.kill(bg, 0);
    } catch {
      alive = false;
    }
    if (alive) process.kill(bg, "SIGKILL");
    assert.equal(alive, false, "background child of the agent killed with its group");
  });

  it("reports a missing binary instead of throwing", async () => {
    const r = await spawnAgent({ bin: join(env.root, "nope"), args: [], cwd: env.root, env: { ...process.env }, timeoutMs: 1000 });
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });

  it("keeps only the last tailBytes of output", async () => {
    const p = fakeBinary(join(env.root, "bin"), "loud", `for (let i = 0; i < 2000; i++) console.log("line " + i);`);
    const r = await spawnAgent({ bin: p, args: [], cwd: env.root, env: { ...process.env }, timeoutMs: 120_000, tailBytes: 256 }); // a ceiling, not a timing: node startup is slow under load
    assert.ok(r.stdoutTail.length <= 256);
    assert.match(r.stdoutTail, /line 1999/);
  });
});
