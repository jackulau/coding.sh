import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ampAdapter, ampPluginSource, ampStreamParser } from "../../../src/adapters/more/amp.ts";
import type { TmpEnv } from "../_helpers.ts";
import { fakeHook, fire, hookCalls, loadPlugin, waitFor } from "./_plugin-host.ts";
import { assertGolden, assertInstallRoundTrip, assertRunOk, assertWellFormed, fakeBinary, HOOK, moreEnv, normalizeFixture, readArgv, runSpec, summarize, writeFile } from "./_helpers.ts";

const TID = "T-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

describe("amp normalize", () => {
  it("maps plugin events to golden events", async () => {
    const events = await normalizeFixture(ampAdapter, "amp/plugin.spool.jsonl");
    assertWellFormed(events);
    assertGolden("amp/golden/plugin.golden.json", summarize(events));
    assert.ok(events.every((e) => e.sessionId === TID));
    assert.equal(events[0]!.kind, "session.start", "Amp's session.start is not mistaken for a wrapper line");
    const calls = events.filter((e) => e.kind === "llm.call");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.usage, { inputTokens: 900, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 100 });
    const end = events.find((e) => e.kind === "turn.end")!;
    assert.equal(end.usage, undefined, "turn.end carries no usage (no double counting)");
    assert.equal(end.turnId, "turn-1");
    const tr = events.find((e) => e.kind === "test.result")!;
    assert.deepEqual([tr.payload.runner, tr.payload.passed, tr.payload.failed], ["jest", 12, 0]);
    const sub = events.filter((e) => e.kind.startsWith("subagent."));
    assert.deepEqual(sub.map((e) => [e.kind, e.subagentId, e.payload.type]), [["subagent.start", "toolu_04", "oracle"], ["subagent.end", "toolu_04", "oracle"]]);
    const rejected = events.find((e) => e.kind === "tool.end" && e.payload.tool === "create_file")!;
    assert.equal(rejected.payload.ok, false);
    assert.ok(!events.some((e) => e.kind === "file.change" && e.payload.path === "secret.txt"), "no file.change for a rejected edit");
  });

  it("parses stream-json usage (result wins over summed assistant usage)", () => {
    const p = ampStreamParser();
    p.onLine(JSON.stringify({ type: "system", subtype: "init", session_id: TID }));
    p.onLine(JSON.stringify({ type: "assistant", session_id: TID, message: { usage: { input_tokens: 10, output_tokens: 2 } } }));
    p.onLine(JSON.stringify({ type: "assistant", session_id: TID, parent_tool_use_id: "x", message: { usage: { input_tokens: 99 } } }));
    assert.deepEqual(p.usage(), { inputTokens: 10, outputTokens: 2 });
    p.onLine(JSON.stringify({ type: "result", session_id: TID, usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 } }));
    assert.equal(p.sessionId(), TID);
    assert.deepEqual(p.usage(), { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 });
  });
});

describe("amp install + plugin", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("round-trips the plugin file under $XDG_CONFIG_HOME/amp/plugins", async () => {
    const { installed } = await assertInstallRoundTrip(ampAdapter, env.root);
    const src = installed[".config/amp/plugins/coding-sh.ts"]!;
    assert.match(src, /@codingsh-amp-plugin/);
    assert.ok(!/amp\.on\("tool\.call"/.test(src), "never subscribes to tool.call (which can block or modify)");
  });

  it("embeds the node found on PATH at install time, else the running node", async () => {
    const saved = process.env.PATH;
    try {
      const bin = join(env.root, "node-bin");
      let node = fakeBinary(bin, "node", "");
      // Windows: the plugin spawns node without a shell, so only node.exe counts (not the .cmd shim).
      if (process.platform === "win32") writeFile((node = join(bin, "node.exe")), "");
      process.env.PATH = bin;
      const [onPath] = await ampAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: true });
      assert.ok(onPath?.after?.includes(`const NODE = ${JSON.stringify(node)};`), "uses node from PATH");
      process.env.PATH = join(env.root, "empty-bin");
      const [fallback] = await ampAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: true });
      assert.ok(fallback?.after?.includes(`const NODE = ${JSON.stringify(process.execPath)};`), "falls back to process.execPath");
    } finally {
      process.env.PATH = saved;
    }
  });

  it("refuses to overwrite a plugin it did not write", async () => {
    const p = join(env.home, ".config", "amp", "plugins", "coding-sh.ts");
    writeFile(p, "export default function () {}\n");
    await assert.rejects(ampAdapter.install({ hookCommand: HOOK, scope: "user", dryRun: false }), /refusing/);
    assert.deepEqual(await ampAdapter.uninstall({ scope: "user", dryRun: false }), []);
    assert.equal(readFileSync(p, "utf8"), "export default function () {}\n");
  });

  it("the generated plugin forwards events to the hook with the payload on stdin", async () => {
    const dir = join(env.root, "plugin-run");
    mkdirSync(dir, { recursive: true });
    const hook = fakeHook(dir);
    const file = join(dir, "coding-sh.ts");
    writeFileSync(file, ampPluginSource(hook));
    const handlers = await loadPlugin(file, { system: { workspaceRoot: "file:///work/demo" } });
    assert.deepEqual([...handlers.keys()].sort(), ["agent.end", "agent.start", "session.start", "tool.result"]);
    await fire(handlers, "tool.result", { thread: { id: TID }, toolUseID: "t1", tool: "Bash", input: { cmd: "ls" }, status: "done" });
    const r = handlers.get("tool.result")![0]!({ thread: { id: TID } });
    assert.equal(r, undefined, "handlers return nothing, so Amp's behaviour is unchanged");
    await fire(handlers, "agent.end", { thread: { id: TID }, id: "turn-1", status: "done", messages: [] });
    await waitFor(() => hookCalls(dir).length >= 3);
    const calls = hookCalls(dir);
    const end = calls.find((c) => c.argv[1] === "agent.end")!;
    assert.deepEqual(end.argv, ["amp", "agent.end"]);
    assert.equal(end.stdin.hook_event_name, "agent.end");
    assert.equal(end.stdin.cwd, "/work/demo");
    assert.deepEqual(end.stdin.thread, { id: TID });
  });
});

describe("amp run", () => {
  let env: TmpEnv;
  before(() => {
    env = moreEnv();
  });
  after(() => env.restore());

  it("drives `amp -x --stream-json` and reads the thread id and usage", async () => {
    const bin = join(env.root, "bin");
    fakeBinary(bin, "amp", `console.log(JSON.stringify({type:"system",subtype:"init",session_id:${JSON.stringify(TID)}}));console.log(JSON.stringify({type:"result",session_id:${JSON.stringify(TID)},usage:{input_tokens:5,output_tokens:1}}));`);
    const cwd = join(env.root, "work");
    mkdirSync(cwd, { recursive: true });
    const r = await ampAdapter.run!(runSpec(cwd, bin, { model: "high" }));
    assertRunOk(r);
    assert.equal(r.sessionId, TID);
    assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 1 });
    const a = readArgv(bin, "amp");
    assert.deepEqual(a.argv, ["-x", "fix the bug", "--stream-json", "--mode", "high"]);
    assert.equal(a.runId, "run-42");
    const r2 = await ampAdapter.run!(runSpec(cwd, bin, { model: "claude-opus" }));
    assert.match(r2.stderrTail, /ignored/);
    assert.ok(!readArgv(bin, "amp").argv.includes("--mode"));
  });
});
