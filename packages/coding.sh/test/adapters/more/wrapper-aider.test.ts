import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { aiderAdapter, parseAiderUsage } from "../../../src/adapters/more/aider.ts";
import { wrapperAdapter } from "../../../src/adapters/more/wrapper.ts";
import type { TmpEnv } from "../_helpers.ts";
import { assertGolden, assertRunOk, assertWellFormed, fakeBinary, loadSpool, moreEnv, normalizeFixture, readArgv, runSpec, summarize, testCtx } from "./_helpers.ts";

describe("wrapper normalize", () => {
  it("maps capture-wrapper spool lines to golden events", async () => {
    const events = await normalizeFixture(wrapperAdapter, "wrapper/wrapper.spool.jsonl");
    assertWellFormed(events);
    assertGolden("wrapper/golden/wrapper.golden.json", summarize(events));
    const start = events.find((e) => e.kind === "session.start" && e.sessionId === "wrap-sess-1")!;
    assert.deepEqual(start.payload, { source: "wrapper", cmd: "my-agent", args: ["--yes", "fix the tests"] });
    assert.equal(start.repo!.branch, "main");
    assert.equal(start.runId, "run-123");
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.runner, tr.payload.passed, tr.payload.failed], ["pytest", 4, 1]);
    assert.deepEqual(
      events.filter((e) => e.kind === "file.change").map((e) => e.payload),
      [
        { path: "src/app.py", op: "modify", additions: 3, deletions: 1 },
        { path: "assets/logo.png", op: "add", additions: 0, deletions: 0, binary: true },
      ],
    );
    const end = events.find((e) => e.kind === "session.end")!;
    assert.equal(end.durationMs, 3000);
    assert.equal(end.payload.reason, "exit:1");
    assert.equal(end.payload.patch, true);
    assert.equal(end.blobs!.length, 1, "the patch blob (the raw payload rides on the error event before it)");
    const err = events.find((e) => e.kind === "error")!;
    assert.ok(events.indexOf(err) < events.indexOf(end));
    assert.equal(err.blobs!.length, 1);
    const anon = events.filter((e) => e.agent === "aider");
    assert.equal(anon.length, 1);
    assert.match(anon[0]!.sessionId, /^wrapper-[0-9a-f]{24}$/, "stable fallback session id without a sessionId");
  });

  it("aider normalizes through the wrapper, plus the prompt from its argv", async () => {
    const line = loadSpool("wrapper/wrapper.spool.jsonl").find((l) => l.agent === "aider")!;
    const { ctx } = testCtx();
    const events = await aiderAdapter.normalize(line, ctx);
    const wrapped = await wrapperAdapter.normalize(line, ctx);
    assert.deepEqual(events.slice(0, wrapped.length), wrapped);
    assert.deepEqual(events.slice(wrapped.length).map((e) => [e.kind, e.payload.text]), [["user.message", "hi"]]);
  });
});

describe("aider usage", () => {
  it("sums Tokens lines (k suffixes, cache parts) and keeps the last session cost", () => {
    const out = [
      "Tokens: 2.1k sent, 1.2k cache write, 3k cache hit, 345 received. Cost: $0.01 message, $0.01 session.",
      "\x1b[32mApplied edit to src/app.py\x1b[0m",
      "Tokens: 12k sent, 1,024 received. Cost: $0.04 message, $0.05 session.",
    ].join("\n");
    assert.deepEqual(parseAiderUsage(out), { inputTokens: 14100, outputTokens: 1369, cacheWriteTokens: 1200, cacheReadTokens: 3000, costUsd: 0.05 });
    assert.deepEqual(parseAiderUsage("Tokens: 10 sent, 2 received."), { inputTokens: 10, outputTokens: 2 });
    assert.equal(parseAiderUsage("no usage here"), undefined);
  });
});

describe("wrapper + aider run", () => {
  let env: TmpEnv;
  let cwd: string;
  let bin: string;
  before(() => {
    env = moreEnv();
    cwd = join(env.root, "work");
    bin = join(env.root, "bin");
    mkdirSync(cwd, { recursive: true });
  });
  after(() => env.restore());

  it("aider: scripted flags, usage from stdout", async () => {
    fakeBinary(bin, "aider", `console.log("Tokens: 1.5k sent, 200 received. Cost: $0.02 message, $0.02 session.");`);
    const r = await aiderAdapter.run!(runSpec(cwd, bin, { model: "sonnet", flags: ["--auto-commits"] }));
    assertRunOk(r);
    assert.deepEqual(r.usage, { inputTokens: 1500, outputTokens: 200, costUsd: 0.02 });
    const a = readArgv(bin, "aider");
    assert.deepEqual(a.argv.slice(0, 2), ["--message", "fix the bug"]);
    assert.ok(a.argv.includes("--yes-always") && a.argv.includes("--no-analytics") && a.argv.includes("--no-check-update"));
    assert.ok(!a.argv.includes("--analytics-disable"), "never the permanent opt-out");
    assert.ok(a.argv.includes("--no-show-release-notes"), "--yes-always would open the release notes in a browser");
    assert.ok(!a.argv.includes("--no-auto-commits"), "a harness flag overrides our default");
    assert.deepEqual(a.argv.slice(-3), ["--model", "sonnet", "--auto-commits"]);
  });

  it("wrapper: the command comes from flags; {instruction} is substituted", async () => {
    fakeBinary(bin, "my-agent", `process.exit(0);`);
    const r = await wrapperAdapter.run!(runSpec(cwd, bin, { flags: ["my-agent --task '{instruction}' --yes"] }));
    assertRunOk(r);
    assert.deepEqual(readArgv(bin, "my-agent").argv, ["--task", "fix the bug", "--yes"]);
    await wrapperAdapter.run!(runSpec(cwd, bin, { flags: [join(bin, "my-agent"), "-q"] }));
    assert.deepEqual(readArgv(bin, "my-agent").argv, ["-q", "fix the bug"]);
    const none = await wrapperAdapter.run!(runSpec(cwd, bin));
    assert.equal(none.exitCode, 127);
  });
});
