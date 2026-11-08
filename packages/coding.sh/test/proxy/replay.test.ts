// `coding.sh exp replay`: logged calls replayed against a stub API with one
// field varied, graded by "same first action", compared A vs B. The stub's
// Sonnet runs the tests (as the agent did); its Haiku answers in text.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/core/config.ts";
import { applyArm, parseVary, replayable, sameActionGrader } from "../../src/experiments/replay.ts";
import type { LoadedCall } from "../../src/proxy/calls.ts";
import { recorderFor } from "../../src/proxy/index.ts";
import { startProxy } from "../../src/proxy/server.ts";
import { openStores } from "../../src/store/factory.ts";
import { anthropicStream, call, startUpstream, type Upstream } from "./_helpers.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const AGENT_KEY = "sk-ant-oat01-AGENTLOGINAGENTLOGINAGENTLOGIN-abcdefAA";
const USER_KEY = "sk-ant-api03-REPLAYKEYREPLAYKEYREPLAYKEY-abcdefAA";
const SESSION = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";

describe("parseVary and applyArm", () => {
  const read = (p: string) => (p === "p.md" ? "Be terse." : p === "t.json" ? '[{"name":"Bash"}]' : "");

  it("one value varies B; two set A and B", () => {
    const [a, b] = parseVary(["model=claude-haiku-4-5", "temperature=0,1", "system=@p.md"], read);
    assert.deepEqual(a, { name: "a", label: "temperature=0", set: { temperature: 0 } });
    assert.deepEqual(b, { name: "b", label: "model=claude-haiku-4-5 temperature=1 system=@p.md", set: { model: "claude-haiku-4-5", temperature: 1, system: "Be terse." } });
    const [ra] = parseVary(["model=x"], read);
    assert.equal(ra.label, "recorded");
  });

  it("reads JSON values and files, and refuses three values or a missing =", () => {
    const [, b] = parseVary(['thinking={"type":"enabled","budget_tokens":1024}', "tools=@t.json", "output_config.effort=low"], read);
    assert.deepEqual(b.set, { thinking: { type: "enabled", budget_tokens: 1024 }, tools: [{ name: "Bash" }], "output_config.effort": "low" });
    assert.throws(() => parseVary(["model=a,b,c"], read), /not 3/);
    assert.throws(() => parseVary(["model"], read), /key=value/);
    assert.throws(() => parseVary([], read), /at least one --vary/);
  });

  it("puts the system prompt where each API keeps it, and asks for one JSON reply", () => {
    const set = { system: "S", "output_config.effort": "low" };
    const m = applyArm("messages", { model: "m", stream: true, system: [{ type: "text", text: "old" }], messages: [] }, set);
    assert.deepEqual(m, { model: "m", stream: false, system: "S", messages: [], output_config: { effort: "low" } });
    const r = applyArm("responses", { instructions: "old", input: [], stream: true }, { system: "S" });
    assert.equal(r.instructions, "S");
    const c = applyArm("chat", { messages: [{ role: "developer", content: "old" }, { role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } }, { system: "S" });
    assert.deepEqual(c, { messages: [{ role: "developer", content: "S" }, { role: "user", content: "hi" }], stream: false });
    const c2 = applyArm("chat", { messages: [{ role: "user", content: "hi" }] }, { system: "S" });
    assert.deepEqual((c2.messages as unknown[])[0], { role: "system", content: "S" });
  });

  it("same-action passes the recorded tool with the same input, or text for text", async () => {
    const g = sameActionGrader();
    const bash = { type: "tool", name: "Bash", input: { command: "npm  test" } };
    assert.equal((await g.grade({ input: {}, expected: { action: bash }, output: { action: { type: "tool", name: "Bash", input: { command: "npm test" } } } })).pass, true);
    assert.equal((await g.grade({ input: {}, expected: { action: bash }, output: { action: { type: "tool", name: "Bash", input: { command: "ls" } } } })).pass, false);
    const text = await g.grade({ input: {}, expected: { action: bash }, output: { action: { type: "text", text: "Done." } } });
    assert.equal(text.pass, false);
    assert.equal(text.reason, "text instead of Bash");
    assert.equal((await g.grade({ input: {}, expected: { action: { type: "text", text: "a" } }, output: { action: { type: "text", text: "b" } } })).pass, true);
  });

  it("a compaction call is not replayed", () => {
    const call = { event: { id: "0123456789abcdef", payload: { compaction: true } }, request: { provider: "openai", api: "responses", body: {} } } as unknown as LoadedCall;
    assert.match(String(replayable(call)), /compaction calls can't be replayed/);
  });
});

describe("CLI: exp replay", () => {
  let up: Upstream;
  let root = "";
  let env: NodeJS.ProcessEnv = {};
  const replays: { model: string; key?: string; auth?: string; stream: unknown; system: unknown; beta?: string }[] = [];

  before(async () => {
    up = await startUpstream((req, res) => {
      const body = JSON.parse(req.body.toString("utf8")) as { model: string; stream?: boolean; system?: unknown };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const s of anthropicStream({ tool: { name: "Bash", input: { command: "npm test" } } })) res.write(s);
        res.end();
        return;
      }
      replays.push({ model: body.model, key: req.headers["x-api-key"] as string | undefined, auth: req.headers.authorization as string | undefined, stream: body.stream, system: body.system, beta: req.headers["anthropic-beta"] as string | undefined });
      const haiku = body.model.includes("haiku");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_r${replays.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: haiku ? [{ type: "text", text: "The fix looks right." }] : [{ type: "tool_use", id: "toolu_r", name: "Bash", input: { command: "npm test" } }],
          stop_reason: haiku ? "end_turn" : "tool_use",
          usage: { input_tokens: 2000, output_tokens: haiku ? 12 : 30 },
        }),
      );
    });
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-replay-")));
    env = { PATH: process.env.PATH, HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
    const config = loadConfig(env);
    const stores = await openStores(config);
    const recorder = recorderFor({ config, index: stores.index, blobs: stores.blobs, env: {} });
    const proxy = await startProxy({ port: 0, upstreams: { anthropic: up.url, openai: up.url }, recorder });
    try {
      // Claude Code signed in with a subscription: an OAuth bearer and the oauth beta.
      const r = await call(proxy.url, {
        method: "POST",
        path: "/v1/messages?beta=true",
        headers: { "content-type": "application/json", authorization: `Bearer ${AGENT_KEY}`, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14", "user-agent": "claude-cli/2.1.319 (external, cli)", "x-claude-code-session-id": SESSION },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, stream: true, system: [{ type: "text", text: "You are a careful coding agent." }], tools: [{ name: "Bash", input_schema: { type: "object" } }], messages: [{ role: "user", content: "fix the failing test" }] }),
      });
      assert.equal(r.status, 200);
      await recorder.flush();
    } finally {
      await proxy.close();
      await stores.index.close();
    }
    writeFileSync(join(root, "prompt.md"), "You are a fast coding agent.");
  });
  after(async () => {
    await up?.close();
    rmSync(root, { recursive: true, force: true });
  });
  // Async: the stub API runs in this process, so the CLI must not block it.
  const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const p = spawn(process.execPath, ["--no-warnings", CLI, "exp", "replay", ...args], { env: { ...env, ...extra }, cwd: root, timeout: 120_000 });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d: Buffer) => (stdout += d));
      p.stderr.on("data", (d: Buffer) => (stderr += d));
      p.on("error", reject);
      p.on("close", (status) => resolve({ status, stdout, stderr }));
    });

  it("--dry-run estimates the cost without a key", async () => {
    const r = await cli([`${SESSION}#1`, "--vary", "model=claude-sonnet-4-5,claude-haiku-4-5", "--n", "3", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^1 call × 2 arms × 3: 6 model calls, ~[\d.]+k? input tokens, ~\$[\d.]+ /m);
    assert.match(r.stdout, /^A model=claude-sonnet-4-5$/m);
    assert.match(r.stdout, /^B model=claude-haiku-4-5$/m);
    assert.match(r.stdout, /needs \$ANTHROPIC_API_KEY to run/);
    assert.equal(replays.length, 0);
  });

  it("refuses to run without the user's own API key", async () => {
    const r = await cli([`${SESSION}#1`, "--vary", "model=claude-haiku-4-5"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\$ANTHROPIC_API_KEY is not set/);
    assert.equal(replays.length, 0);
  });

  it("refuses an estimate over --max-cost", async () => {
    const r = await cli([`${SESSION}#1`, "--vary", "model=claude-haiku-4-5", "--max-cost", "0.000001"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /over --max-cost/);
  });

  it("replays A and B n times with the user's key and compares them", async () => {
    const r = await cli([`${SESSION}#-1`, "--vary", "model=claude-sonnet-4-5,claude-haiku-4-5", "--n", "3", "--upstream", up.url], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(replays.length, 6);
    assert.deepEqual(replays.map((x) => x.model).sort(), ["claude-haiku-4-5", "claude-haiku-4-5", "claude-haiku-4-5", "claude-sonnet-4-5", "claude-sonnet-4-5", "claude-sonnet-4-5"]);
    for (const x of replays) {
      assert.equal(x.key, USER_KEY, "the user's key");
      assert.equal(x.auth, undefined, "never the agent's login");
      assert.equal(x.stream, false);
      assert.equal(x.beta, "interleaved-thinking-2025-05-14", "the oauth beta is dropped");
      assert.deepEqual(x.system, [{ type: "text", text: "You are a careful coding agent." }], "the recorded system prompt");
    }
    assert.match(r.stdout, /^A model=claude-sonnet-4-5 {3}B model=claude-haiku-4-5 {3}1 call × 3$/m);
    assert.match(r.stdout, /^A .* pass 100/m);
    assert.match(r.stdout, /^B .* pass 0/m);
    assert.match(r.stdout, /Bash → Bash ×3 \| text ×3/);
    assert.match(r.stdout, /Full comparison: coding\.sh exp compare /);
  });

  it("--vary system=@file with --json: B sends the file as the system prompt", async () => {
    replays.length = 0;
    const r = await cli([`${SESSION}#1`, "--vary", "system=@prompt.md", "--n", "2", "--upstream", up.url, "--json"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout) as { data?: Record<string, unknown> } & Record<string, unknown>;
    const d = (doc.data ?? doc) as { arms: { a: string; b: string }; comparison: { a: { passRate: number }; b: { passRate: number } } };
    assert.deepEqual(d.arms, { a: "recorded", b: "system=@prompt.md" });
    assert.equal(d.comparison.a.passRate, 1);
    assert.deepEqual(replays.map((x) => x.system).filter((s) => typeof s === "string"), ["You are a fast coding agent.", "You are a fast coding agent."]);
  });
});
