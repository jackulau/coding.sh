import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DROID_HOOK_EVENTS, droidAdapter, droidHookTarget } from "../../../src/adapters/more/droid.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import type { TmpEnv } from "../_helpers.ts";
import { assertGolden, assertInstallRoundTrip, assertRunOk, assertWellFormed, collect, fakeBinary, FIXTURES, HOOK, loadSpool, moreEnv, readArgv, runSpec, summarize, testCtx, writeFile } from "./_helpers.ts";

describe("droid normalize", () => {
  it("maps hook payloads to golden events (model from the session sidecar)", async () => {
    // The raw payloads carry the machine-specific fixture path (transcript_path), so key ids on
    // the spool position instead of a raw hash; otherwise the golden only matches one checkout.
    const { ctx } = testCtx();
    const events: AgentEvent[] = [];
    for (const [offset, line] of loadSpool("droid/hooks.spool.jsonl").entries()) {
      events.push(...(await droidAdapter.normalize(line, { ...ctx, source: { file: join(FIXTURES, "droid/hooks.spool.jsonl"), offset } })));
    }
    assertWellFormed(events);
    assertGolden("droid/golden/hooks.golden.json", summarize(events));
    assert.equal(events[0]!.model, "claude-opus-4-1");
    const changes = events.filter((e) => e.kind === "file.change").map((e) => [e.payload.path, e.payload.op]);
    assert.deepEqual(changes, [["hello.py", "add"], ["hello.py", "modify"], ["old.py", "delete"]]);
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.runner, tr.payload.passed, tr.payload.failed], ["pytest", 2, 1]);
    const read = events.find((e) => e.kind === "tool.end" && e.payload.tool === "Read")!;
    assert.equal(read.payload.ok, false);
    const sub = events.find((e) => e.kind === "subagent.end")!;
    assert.equal(sub.subagentId, "code-reviewer");
    const start = events.find((e) => e.kind === "subagent.start")!;
    assert.deepEqual([start.payload.subagentId, start.payload.toolUseId], ["code-reviewer", "toolu_d5"], "the Task call stands in for the missing SubagentStart");
    assert.equal(events.find((e) => e.kind === "session.end")!.durationMs, 10000);
    assert.equal(events.find((e) => e.kind === "context.compact")!.payload.trigger, "manual");
  });
});

describe("droid backfill", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
    process.env.HOME = join(FIXTURES, "droid", "home");
  });
  after(() => env.restore());

  it("imports session JSONL + sidecar totals to golden events", async () => {
    const { ctx } = testCtx();
    const events = await collect(droidAdapter.backfill!(ctx));
    assertWellFormed(events);
    assertGolden("droid/golden/backfill.golden.json", summarize(events));
    assert.equal(events.filter((e) => e.kind === "assistant.message").length, 2, "a re-streamed message id is kept once");
    assert.equal(events.find((e) => e.kind === "assistant.message")!.payload.text, "Creating the file.");
    const withUsage = events.filter((e) => e.usage);
    assert.equal(withUsage.length, 1);
    assert.deepEqual(withUsage[0]!.usage, { inputTokens: 4200, outputTokens: 350, cacheReadTokens: 2600, cacheWriteTokens: 800 });
    assert.equal(withUsage[0]!.payload.kind, "usage.total");
    assert.ok(events.every((e) => e.model === "claude-opus-4-1" && e.cwd === "/work/demo"));
  });
});

describe("droid install", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("creates ~/.factory/hooks.json with top-level events and round-trips", async () => {
    const { installed } = await assertInstallRoundTrip(droidAdapter, env.root);
    const h = JSON.parse(installed[".factory/hooks.json"]!);
    assert.deepEqual(Object.keys(h), [...DROID_HOOK_EVENTS]);
    assert.equal(h.hooks, undefined, "no hooks wrapper in hooks.json");
    assert.deepEqual(h.PostToolUse, [{ matcher: "*", hooks: [{ type: "command", command: `node "${HOOK}" droid PostToolUse`, timeout: 10 }] }]);
    assert.ok(!existsSync(join(env.home, ".factory", "hooks.json")));
  });

  it("writes into settings.json when that is where the user's hooks live", async () => {
    const settings = join(env.home, ".factory", "settings.json");
    const user = { model: "claude-opus-4-1", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
    writeFile(settings, `${JSON.stringify(user, null, 2)}\n`);
    assert.equal(droidHookTarget({ scope: "user" }).form, "settings.json");
    await assertInstallRoundTrip(droidAdapter, env.root);
    await droidAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: false });
    assert.ok(!existsSync(join(env.home, ".factory", "hooks.json")), "never shadows settings.json hooks with a new hooks.json");
    const s = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(s.model, "claude-opus-4-1");
    assert.equal(s.hooks.Stop.length, 2);
    assert.equal((await droidAdapter.detect()).hooked, true);
    await droidAdapter.uninstall({ scope: "user", dryRun: false });
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), user);
  });

  it("prefers an existing hooks.json and keeps its other hooks", async () => {
    const hooksJson = join(env.home, ".factory", "hooks.json");
    const user = { PreToolUse: [{ matcher: "Execute", hooks: [{ type: "command", command: "./guard.sh" }] }] };
    writeFile(hooksJson, `${JSON.stringify(user, null, 2)}\n`);
    assert.equal(droidHookTarget({ scope: "user" }).form, "hooks.json");
    await assertInstallRoundTrip(droidAdapter, env.root);
    assert.deepEqual(JSON.parse(readFileSync(hooksJson, "utf8")), user);
  });
});

describe("droid run", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("drives `droid exec -o json` (pretty-printed result too)", async () => {
    const bin = join(env.root, "bin");
    fakeBinary(bin, "droid", `console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"done",session_id:"droid-run-1",usage:{input_tokens:100,output_tokens:7,cache_read_input_tokens:50}}, null, 2));`);
    const cwd = join(env.root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = await droidAdapter.run!(runSpec(cwd, bin, { model: "claude-opus-4-1" }));
    assertRunOk(r);
    assert.equal(r.sessionId, "droid-run-1");
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 7, cacheReadTokens: 50 });
    assert.deepEqual(readArgv(bin, "droid").argv, ["exec", "fix the bug", "-o", "json", "--auto", "high", "--cwd", cwd, "-m", "claude-opus-4-1"]);
  });
});
