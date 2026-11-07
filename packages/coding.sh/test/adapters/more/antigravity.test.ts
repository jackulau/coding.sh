import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AGY_HOOK_EVENTS, antigravityAdapter } from "../../../src/adapters/more/antigravity.ts";
import type { TmpEnv } from "../_helpers.ts";
import { assertGolden, assertInstallRoundTrip, assertRunOk, assertWellFormed, collect, fakeBinary, FIXTURES, HOOK, moreEnv, normalizeFixture, readArgv, runSpec, summarize, testCtx, writeFile } from "./_helpers.ts";

describe("antigravity normalize", () => {
  it("maps hook payloads to golden events", async () => {
    const events = await normalizeFixture(antigravityAdapter, "antigravity/hooks.spool.jsonl");
    assertWellFormed(events);
    assertGolden("antigravity/golden/hooks.golden.json", summarize(events));
    assert.equal(events.filter((e) => e.kind === "user.message").length, 1, "only invocation 0 carries a new prompt");
    assert.deepEqual(events.find((e) => e.kind === "file.change")!.payload, { path: "src/parse.ts", op: "modify", tool: "replace_file_content", toolUseId: "step-4" });
    const cmd = events.find((e) => e.kind === "tool.end" && e.payload.tool === "run_command")!;
    assert.equal(cmd.payload.ok, false);
    assert.equal(events.find((e) => e.kind === "tool.start" && e.payload.tool === "run_command")!.payload.verify, true);
    assert.ok(events.every((e) => e.model === "gemini-3-pro" && e.cwd === "/work/demo"));
    const subs = events.filter((e) => e.kind.startsWith("subagent."));
    assert.deepEqual(subs.map((e) => [e.kind, e.payload.subagentId, e.payload.type]), [["subagent.start", "step-6", "researcher"], ["subagent.end", "step-6", "researcher"]]);
  });
});

describe("antigravity backfill", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
    process.env.HOME = join(FIXTURES, "antigravity", "home");
  });
  after(() => env.restore());

  it("imports brain transcripts to golden events", async () => {
    const events = await collect(antigravityAdapter.backfill!(testCtx().ctx));
    assertWellFormed(events);
    assertGolden("antigravity/golden/backfill.golden.json", summarize(events));
    assert.ok(events.every((e) => e.sessionId === "agy-conv-1"));
    assert.equal(events.filter((e) => e.kind === "turn.end").length, 2);
    assert.equal(events.filter((e) => e.kind === "llm.call").length, 4, "one per planner step");
    const ends = events.filter((e) => e.kind === "tool.end");
    assert.deepEqual(ends.map((e) => [e.payload.tool, e.payload.toolUseId, e.durationMs]), [["write_to_file", "step-1-0", 500], ["run_command", "step-3-0", 2000], ["invoke_subagent", "step-8-0", 3000]]);
    const subEnd = events.find((e) => e.kind === "subagent.end")!;
    assert.deepEqual([subEnd.payload.subagentId, subEnd.payload.type, subEnd.payload.ok, subEnd.durationMs], ["step-8-0", "researcher", true, 3000]);
    assert.equal(events.find((e) => e.kind === "file.change")!.payload.path, "/work/demo/src/parse.ts");
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.passed, tr.payload.failed], [2, 1]);
    assert.ok(events.some((e) => e.kind === "context.compact"));
  });
});

describe("antigravity install", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("owns one named hook in ~/.gemini/config/hooks.json and round-trips", async () => {
    const path = join(env.home, ".gemini", "config", "hooks.json");
    const user = { "my-guard": { PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "./guard.sh" }] }] } };
    writeFile(path, `${JSON.stringify(user, null, 2)}\n`);
    const { installed } = await assertInstallRoundTrip(antigravityAdapter, env.root);
    const h = JSON.parse(installed[".gemini/config/hooks.json"]!);
    assert.deepEqual(h["my-guard"], user["my-guard"]);
    assert.deepEqual(Object.keys(h["coding-sh"]), [...AGY_HOOK_EVENTS]);
    assert.ok(!("PreToolUse" in h["coding-sh"]), "PreToolUse requires a decision; never installed");
    assert.deepEqual(h["coding-sh"].PostToolUse, [{ matcher: "*", hooks: [{ type: "command", command: `node "${HOOK}" antigravity PostToolUse`, timeout: 10 }] }]);
    assert.deepEqual(h["coding-sh"].Stop, [{ type: "command", command: `node "${HOOK}" antigravity Stop`, timeout: 10 }]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), user);
  });

  it("refuses to replace a foreign hook named coding-sh", async () => {
    const path = join(env.home, ".gemini", "config", "hooks.json");
    writeFile(path, JSON.stringify({ "coding-sh": { Stop: [{ type: "command", command: "echo hi" }] } }));
    await assert.rejects(antigravityAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: false }), /refusing/);
    assert.deepEqual(await antigravityAdapter.uninstall({ scope: "user", dryRun: false }), []);
  });

  it("installs workspace hooks under .agents/hooks.json", async () => {
    const project = join(env.root, "proj");
    mkdirSync(project, { recursive: true });
    await assertInstallRoundTrip(antigravityAdapter, env.root, { scope: "project", projectDir: project });
  });
});

describe("antigravity run", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("drives `agy -p --output-format stream-json`", async () => {
    const bin = join(env.root, "bin");
    fakeBinary(bin, "agy", `console.log(JSON.stringify({type:"init",session_id:"agy-run-1"}));console.log(JSON.stringify({type:"result",usage:{input_tokens:50,output_tokens:5,cache_read_tokens:10}}));`);
    const cwd = join(env.root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = await antigravityAdapter.run!(runSpec(cwd, bin, { model: "gemini-3-pro" }));
    assertRunOk(r);
    assert.equal(r.sessionId, "agy-run-1");
    assert.deepEqual(r.usage, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 10 });
    assert.deepEqual(readArgv(bin, "agy").argv, ["-p", "fix the bug", "--output-format", "stream-json", "--dangerously-skip-permissions", "--model", "gemini-3-pro"]);
  });
});
