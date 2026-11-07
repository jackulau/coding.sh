import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { piAdapter, piExtensionSource } from "../../../src/adapters/more/pi.ts";
import type { TmpEnv } from "../_helpers.ts";
import { fakeHook, fire, hookCalls, loadPlugin, waitFor } from "./_plugin-host.ts";
import { assertGolden, assertInstallRoundTrip, assertRunOk, assertWellFormed, collect, fakeBinary, FIXTURES, HOOK, moreEnv, normalizeFixture, readArgv, runSpec, summarize, testCtx, writeFile } from "./_helpers.ts";

describe("pi normalize", () => {
  it("maps extension events to golden events", async () => {
    const events = await normalizeFixture(piAdapter, "pi/extension.spool.jsonl");
    assertWellFormed(events);
    assertGolden("pi/golden/extension.golden.json", summarize(events));
    const call = events.find((e) => e.kind === "llm.call")!;
    assert.deepEqual(call.usage, { inputTokens: 2100, outputTokens: 60, cacheReadTokens: 1800, cacheWriteTokens: 200, costUsd: 0.0085 });
    assert.equal(call.payload.provider, "anthropic");
    assert.equal(call.durationMs, 100, "message_end time minus the message's stream start");
    const edit = events.find((e) => e.kind === "tool.end" && e.payload.tool === "edit")!;
    assert.equal(edit.durationMs, 12);
    assert.deepEqual(events.find((e) => e.kind === "file.change")!.payload, { path: "src/lib.rs", op: "modify", tool: "edit", toolUseId: "call_1" });
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.runner, tr.payload.passed, tr.payload.failed, tr.payload.skipped], ["cargo", 7, 0, 1]);
    assert.deepEqual(
      events.filter((e) => ["context.compact", "turn.end", "session.end"].includes(e.kind)).map((e) => e.kind),
      ["context.compact", "turn.end", "session.end"],
    );
  });
});

describe("pi backfill", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
    process.env.PI_CODING_AGENT_DIR = join(FIXTURES, "pi", "agent");
  });
  after(() => env.restore());

  it("imports v3 session files to golden events", async () => {
    const { ctx } = testCtx();
    const events = await collect(piAdapter.backfill!(ctx));
    assertWellFormed(events);
    assertGolden("pi/golden/backfill.golden.json", summarize(events));
    assert.ok(events.every((e) => e.sessionId === "pi-sess-1" && e.cwd === "/work/demo"));
    const ends = events.filter((e) => e.kind === "tool.end");
    assert.deepEqual(
      ends.map((e) => [e.payload.tool, e.payload.ok]),
      [["edit", true], ["bash", false], ["user_bash", true]],
    );
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.passed, tr.payload.failed], [6, 1]);
    assert.deepEqual(events.filter((e) => e.kind === "llm.call").map((e) => e.durationMs), [800, 700]);
    assert.equal(events.filter((e) => e.kind === "turn.end").length, 1, "toolUse stops don't end the turn");
  });
});

describe("pi install + extension", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("round-trips the extension under ~/.pi/agent/extensions", async () => {
    const { installed } = await assertInstallRoundTrip(piAdapter, env.root);
    const src = installed[".pi/agent/extensions/coding-sh.ts"]!;
    assert.match(src, /@codingsh-pi-extension/);
    for (const blocking of ['"tool_call"', '"input"', '"before_agent_start"']) assert.ok(!src.includes(`pi.on(${blocking}`), `never registers ${blocking}`);
  });

  it("embeds the node found on PATH at install time, else the running node", async () => {
    const saved = process.env.PATH;
    try {
      const bin = join(env.root, "node-bin");
      let node = fakeBinary(bin, "node", "");
      // Windows: the plugin spawns node without a shell, so only node.exe counts (not the .cmd shim).
      if (process.platform === "win32") writeFile((node = join(bin, "node.exe")), "");
      process.env.PATH = bin;
      const [onPath] = await piAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: true });
      assert.ok(onPath?.after?.includes(`const NODE = ${JSON.stringify(node)};`), "uses node from PATH");
      process.env.PATH = join(env.root, "empty-bin");
      const [fallback] = await piAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: true });
      assert.ok(fallback?.after?.includes(`const NODE = ${JSON.stringify(process.execPath)};`), "falls back to process.execPath");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("honours PI_CODING_AGENT_DIR and project scope", async () => {
    process.env.PI_CODING_AGENT_DIR = join(env.root, "pi-agent");
    try {
      const [c] = await piAdapter.install({ hookCommand: "/x/hook.mjs", scope: "user", dryRun: true });
      assert.equal(c!.path, join(env.root, "pi-agent", "extensions", "coding-sh.ts"));
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    const project = join(env.root, "proj");
    writeFile(join(project, "AGENTS.md"), "x");
    const changes = await piAdapter.install({ hookCommand: "/x/hook.mjs", scope: "project", projectDir: project, dryRun: true });
    assert.equal(changes[0]!.path, join(project, ".pi", "extensions", "coding-sh.ts"));
    assert.match(changes[0]!.summary, /--approve/);
  });

  it("the generated extension forwards events with session context and cached tool args", async () => {
    const dir = join(env.root, "ext-run");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "coding-sh.ts");
    writeFileSync(file, piExtensionSource(fakeHook(dir)));
    const handlers = await loadPlugin(file, {});
    const ctx = { cwd: "/work/demo", mode: "json", model: { provider: "anthropic", id: "m1" }, sessionManager: { getSessionId: () => "pi-sess-9", getSessionFile: () => "/s.jsonl" } };
    await fire(handlers, "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "ls" } }, ctx);
    await fire(handlers, "tool_execution_end", { toolCallId: "c1", toolName: "bash", result: { content: [] }, isError: false }, ctx);
    await fire(handlers, "message_end", { message: { role: "toolResult" } }, ctx);
    await fire(handlers, "agent_settled", { aborted: false }, ctx);
    await waitFor(() => hookCalls(dir).length >= 3);
    const calls = hookCalls(dir);
    assert.equal(calls.length, 3, "toolResult message_end is not forwarded");
    const end = calls.find((c) => c.argv[1] === "tool_execution_end")!;
    assert.deepEqual(end.argv, ["pi", "tool_execution_end"]);
    assert.deepEqual(end.stdin.args, { command: "ls" });
    assert.equal(end.stdin.sessionId, "pi-sess-9");
    assert.deepEqual(end.stdin.model, { provider: "anthropic", id: "m1" });
  });
});

describe("pi run + overlay", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("drives `pi --mode json` and sums assistant usage", async () => {
    const bin = join(env.root, "bin");
    fakeBinary(
      bin,
      "pi",
      `for (const o of [{type:"session",version:3,id:"pi-run-1"},{type:"message_end",message:{role:"assistant",usage:{input:10,output:2,cost:{total:0.001}}}},{type:"message_end",message:{role:"assistant",usage:{input:20,output:3,cost:{total:0.002}}}},{type:"message_end",message:{role:"user"}}]) console.log(JSON.stringify(o));`,
    );
    const cwd = join(env.root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = await piAdapter.run!(runSpec(cwd, bin, { model: "anthropic/claude-sonnet-4-5" }));
    assertRunOk(r);
    assert.equal(r.sessionId, "pi-run-1");
    assert.equal(r.usage!.inputTokens, 30);
    assert.equal(r.usage!.outputTokens, 5);
    assert.ok(Math.abs(r.usage!.costUsd! - 0.003) < 1e-9);
    assert.deepEqual(readArgv(bin, "pi").argv, ["--mode", "json", "--model", "anthropic/claude-sonnet-4-5", "--approve", "fix the bug"]);
  });

  it("overlay isolates the agent dir and copies auth.json privately", async () => {
    writeFile(join(env.home, ".pi", "agent", "auth.json"), '{"anthropic":{}}');
    const runDir = join(env.root, "run");
    const o = await piAdapter.overlay!({ files: {}, flags: [] } as never, runDir);
    assert.equal(o.env.PI_CODING_AGENT_DIR, join(runDir, "home", ".pi", "agent"));
    assert.equal(o.env.PI_CODING_AGENT_SESSION_DIR, join(runDir, "pi-sessions"));
    assert.equal(readFileSync(join(runDir, "home", ".pi", "agent", "auth.json"), "utf8"), '{"anthropic":{}}');
  });
});
