import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { normalizePi, piAdapter, piExtensionSource, piSessionEvents } from "../../../src/adapters/more/pi.ts";
import { buildSession } from "../../../src/core/sessions.ts";
import type { SpoolLine } from "../../../src/core/types.ts";
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

describe("pi aborted calls", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-abort-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const result = (id: string, callId: string, tool: string, text: string, isError: boolean, sec: number) => ({
    type: "message",
    id,
    timestamp: `2026-09-21T10:00:0${sec}.000Z`,
    message: { role: "toolResult", toolCallId: callId, toolName: tool, content: [{ type: "text", text }], isError, timestamp: Date.parse(`2026-09-21T10:00:0${sec}.000Z`) },
  });
  const transcript = (name: string, results: object[]): string => {
    const lines = [
      { type: "session", version: 3, id: `pi-${name}`, timestamp: "2026-09-21T10:00:00.000Z", cwd: "/work/demo" },
      { type: "message", id: "b1", timestamp: "2026-09-21T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Check the build" }], timestamp: 1789984801000 } },
      {
        type: "message",
        id: "b2",
        timestamp: "2026-09-21T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } },
            { type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm run build" } },
            { type: "toolCall", id: "c3", name: "bash", arguments: { command: "npm test" } },
          ],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          stopReason: "toolUse",
          timestamp: 1789984801500,
        },
      },
      ...results,
    ];
    const file = join(dir, `${name}.jsonl`);
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  };

  it("a call Esc skipped (isError \"Operation aborted\") is an interruption, not a tool error", async () => {
    const file = transcript("esc", [result("b3", "c1", "read", "# demo", false, 3), result("b4", "c2", "bash", "Operation aborted", true, 4), result("b5", "c3", "bash", "Operation aborted", true, 5)]);
    const { ctx } = testCtx();
    const events = await collect(piSessionEvents(file, ctx));
    assertWellFormed(events);
    const ends = events.filter((e) => e.kind === "tool.end");
    assert.deepEqual(
      ends.map((e) => [e.payload.toolUseId, e.payload.ok, e.payload.interrupted]),
      [["c1", true, undefined], ["c2", false, true], ["c3", false, true]],
    );
    const s = buildSession(events);
    assert.equal(s.stats.interruptedToolCalls, 2);
    assert.ok(!s.stats.toolErrors, "no tool errors");
    assert.ok(!s.flags.includes("repeated-tool-failure"));
  });

  it("other text naming \"aborted\" stays a tool error", async () => {
    const file = transcript("server", [result("b3", "c1", "read", "# demo", false, 3), result("b4", "c2", "bash", "Request aborted by server: 500", true, 4), result("b5", "c3", "bash", "Aborted.", false, 5)]);
    const { ctx } = testCtx();
    const events = await collect(piSessionEvents(file, ctx));
    const ends = events.filter((e) => e.kind === "tool.end");
    assert.deepEqual(
      ends.map((e) => [e.payload.toolUseId, e.payload.ok, e.payload.interrupted]),
      [["c1", true, undefined], ["c2", false, undefined], ["c3", true, undefined]],
    );
    const s = buildSession(events);
    assert.equal(s.stats.toolErrors, 1);
    assert.ok(!s.stats.interruptedToolCalls);
  });

  it("the extension's tool_execution_end marks an aborted call interrupted", async () => {
    const line = (callId: string, text: string): SpoolLine =>
      ({ v: 0, agent: "pi", event: "tool_execution_end", ts: 1790000001000, pid: 7401, cwd: "/work/demo", raw: { sessionId: "pi-hook-1", cwd: "/work/demo", toolCallId: callId, toolName: "bash", args: { command: "npm test" }, result: { content: [{ type: "text", text }] }, isError: true } }) as SpoolLine;
    const { ctx } = testCtx();
    const [aborted] = (await normalizePi(line("h1", "Aborted"), ctx)).filter((e) => e.kind === "tool.end");
    const [real] = (await normalizePi(line("h2", "Request aborted by server: 500"), ctx)).filter((e) => e.kind === "tool.end");
    assert.deepEqual([aborted!.payload.ok, aborted!.payload.interrupted], [false, true]);
    assert.deepEqual([real!.payload.ok, real!.payload.interrupted], [false, undefined]);
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
    await waitFor(() => hookCalls(dir).length >= 3, 5000, dir);
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
      `try { fs.writeFileSync(${JSON.stringify(join(env.root, "bin", "pi.stdin"))}, fs.readFileSync(0, "utf8")); } catch {}
for (const o of [{type:"session",version:3,id:"pi-run-1"},{type:"message_end",message:{role:"assistant",usage:{input:10,output:2,cost:{total:0.001}}}},{type:"message_end",message:{role:"assistant",usage:{input:20,output:3,cost:{total:0.002}}}},{type:"message_end",message:{role:"user"}}]) console.log(JSON.stringify(o));`,
    );
    const cwd = join(env.root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = await piAdapter.run!(runSpec(cwd, bin, { model: "anthropic/claude-sonnet-4-5" }));
    assertRunOk(r);
    assert.equal(r.sessionId, "pi-run-1");
    assert.equal(r.usage!.inputTokens, 30);
    assert.equal(r.usage!.outputTokens, 5);
    assert.ok(Math.abs(r.usage!.costUsd! - 0.003) < 1e-9);
    // The instruction goes on stdin, so one that starts with "-" is never read as an option.
    assert.deepEqual(readArgv(bin, "pi").argv, ["--print", "--mode", "json", "--model", "anthropic/claude-sonnet-4-5", "--approve"]);
    assert.equal(readFileSync(join(bin, "pi.stdin"), "utf8"), "fix the bug");
    assertRunOk(await piAdapter.run!(runSpec(cwd, bin, { instruction: "- fix the bug" })));
    assert.deepEqual(readArgv(bin, "pi").argv, ["--print", "--mode", "json", "--approve"]);
    assert.equal(readFileSync(join(bin, "pi.stdin"), "utf8"), "- fix the bug");
  });

  it("overlay isolates the agent dir and copies auth.json privately", async () => {
    writeFile(join(env.home, ".pi", "agent", "auth.json"), '{"anthropic":{}}');
    const runDir = join(env.root, "run", "work");
    const home = join(env.root, "run", "home");
    const o = await piAdapter.overlay!({ files: {}, flags: [] } as never, runDir);
    assert.equal(o.env.PI_CODING_AGENT_DIR, join(home, ".pi", "agent"));
    assert.equal(o.env.PI_CODING_AGENT_SESSION_DIR, join(home, "pi-sessions"));
    assert.equal(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"), '{"anthropic":{}}');
    assert.equal(existsSync(runDir), false, "nothing is written into the work tree");
  });
});
