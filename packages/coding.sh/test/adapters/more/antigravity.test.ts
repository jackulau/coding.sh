import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AGY_HOOK_EVENTS, agyHookDef, agyResultMeta, antigravityAdapter } from "../../../src/adapters/more/antigravity.ts";
import type { Json } from "../../../src/adapters/more/_util.ts";
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
    // write_to_file: its header says 0 s, so the steps time it; run_command: its header's Created/Completed At.
    assert.deepEqual(ends.map((e) => [e.payload.tool, e.payload.toolUseId, e.durationMs]), [["write_to_file", "step-2", 500], ["run_command", "step-4", 3000], ["invoke_subagent", "step-9", 3000]]);
    // "The command exited with code 2." fails the call.
    assert.deepEqual(ends.map((e) => [e.payload.ok, e.payload.exitCode, e.payload.error]), [[true, undefined, undefined], [false, 2, "exit code 2"], [true, undefined, undefined]]);
    const subEnd = events.find((e) => e.kind === "subagent.end")!;
    assert.deepEqual([subEnd.payload.subagentId, subEnd.payload.type, subEnd.payload.ok, subEnd.durationMs], ["step-9", "researcher", true, 3000]);
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
    // Outside Windows the sh fast path (hook.sh beside hook.mjs) answers {} itself: no node start.
    const run = process.platform === "win32" ? `node "${HOOK}"` : `/bin/sh "${HOOK.replace(/\.mjs$/, ".sh")}"`;
    assert.deepEqual(h["coding-sh"].PostToolUse, [{ matcher: "*", hooks: [{ type: "command", command: `${run} antigravity PostToolUse --reply={}`, timeout: 10 }] }]);
    assert.deepEqual(h["coding-sh"].Stop, [{ type: "command", command: `${run} antigravity Stop --reply={}`, timeout: 10 }]);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), user);
  });

  it("installs on hook.sh outside Windows and hook.mjs on Windows; an install of either form is ours to update and remove", async () => {
    assert.equal((agyHookDef(HOOK, "linux").Stop as Json[])[0]!.command, `/bin/sh "/opt/coding.sh/hook.sh" antigravity Stop --reply={}`);
    assert.equal((agyHookDef(HOOK, "win32").Stop as Json[])[0]!.command, `node "${HOOK}" antigravity Stop --reply={}`);
    const path = join(env.home, ".gemini", "config", "hooks.json");
    for (const platform of ["linux", "win32"] as const) {
      writeFile(path, JSON.stringify({ "coding-sh": agyHookDef(HOOK, platform) }));
      assert.equal((await antigravityAdapter.detect()).hooked, true, platform);
      assert.deepEqual((await antigravityAdapter.uninstall({ scope: "user", dryRun: false })).length > 0, true, platform);
      assert.equal(existsSync(path) ? JSON.parse(readFileSync(path, "utf8"))["coding-sh"] : undefined, undefined);
    }
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

describe("antigravity tool result header", () => {
  it("reads exit code and Created/Completed At", () => {
    const head = (a: string, b: string, rest: string) => `Created At: ${a}\nCompleted At: ${b}\n\n${rest}`;
    assert.deepEqual(agyResultMeta(head("2026-09-21T18:10:21-05:00", "2026-09-21T18:10:23-05:00", "The command exited with code 1.\nStdout:\n\nStderr:\n\n")), { durationMs: 2000, exitCode: 1 });
    assert.deepEqual(agyResultMeta(head("2026-09-14T11:47:19-05:00", "2026-09-14T11:47:19-05:00", "The command exited with code 0.\nOutput:\nok\n")), { durationMs: 0, exitCode: 0 });
    assert.deepEqual(agyResultMeta("The command exited with code -1.\n"), { exitCode: -1 });
    // Only the header counts: an exit line inside the output is not the call's.
    assert.deepEqual(agyResultMeta(head("2026-09-14T11:47:19-05:00", "x", `Output:\n${"y".repeat(600)}\nThe command exited with code 3.`)), {});
    assert.deepEqual(agyResultMeta("Created file /work/demo/a.ts"), {});
  });
});
