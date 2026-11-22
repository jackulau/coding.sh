// What replay, replay --fork and exp replay print, with each command as the user's shell runs it
// (cliCommand, envLine): a session captured through the proxy, forked against a stub API, and a
// session the proxy logged alone. Every forked call goes to the stub, and each test checks how
// many it got.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cliCommand, envLine } from "../../src/cli/next-steps.ts";
import { loadConfig } from "../../src/core/config.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { recorderFor } from "../../src/proxy/index.ts";
import { startProxy } from "../../src/proxy/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { openStores } from "../../src/store/factory.ts";
import { anthropicStream, call, sleep, startUpstream, type Upstream } from "../proxy/_helpers.ts";
import { CLI } from "../_cli.ts";

const SESSION = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const PROXY_ONLY = "8d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";
const USER_KEY = ["sk-ant-api03-", "NEXTSTEPNEXTSTEPNEXTSTEP", "-abcdefAA"].join("");
const AGENT_KEY = ["sk-ant-api03-", "AGENTKEYAGENTKEYAGENTKEY", "-abcdefAA"].join("");

const reminder = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\nCodebase and user instructions are shown below.\n\nContents of /work/demo/CLAUDE.md (project instructions, checked into the codebase):\n\nRun the tests with npm test.\n</system-reminder>";
const first = { role: "user", content: [{ type: "text", text: reminder }, { type: "text", text: "fix the failing test" }] };
const toolUse = { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] };

describe("replay and exp replay: what they print", () => {
  let up: Upstream;
  let root = "";
  let proj = "";
  let env: NodeJS.ProcessEnv = {};
  /** The forked calls the stub got (the proxied calls the fixture made are not counted). */
  const sent: { key?: string; text: string }[] = [];

  before(async () => {
    // A prompt that the agent answers with a tool call, then "thanks", answered in text.
    up = await startUpstream((req, res) => {
      const text = req.body.toString("utf8");
      const body = JSON.parse(text) as { model: string; stream?: boolean };
      const thanks = text.includes("thanks");
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const s of anthropicStream(thanks ? { text: "Done." } : { tool: { name: "Bash", input: { command: "npm test" } } })) res.write(s);
        res.end();
        return;
      }
      sent.push({ key: req.headers["x-api-key"] as string | undefined, text });
      const content = thanks ? [{ type: "text", text: "You're welcome." }] : [{ type: "tool_use", id: "toolu_f", name: "Bash", input: { command: "node --test" } }];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `msg_n${sent.length}`, type: "message", role: "assistant", model: body.model, content, stop_reason: thanks ? "end_turn" : "tool_use", usage: { input_tokens: 900, output_tokens: 20 } }));
    });
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-replay-next-")));
    proj = join(root, "proj");
    const data = join(root, "data");
    mkdirSync(proj, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.toml"), `[proxy]\nanthropic_upstream = "${up.url}"\nopenai_upstream = "${up.url}"\n`);
    env = { PATH: process.env.PATH, HOME: join(root, "home"), USERPROFILE: join(root, "home"), CODING_SH_HOME: data, CLAUDE_CONFIG_DIR: join(root, "claude"), CODEX_HOME: join(root, "codex"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1" };
    const config = loadConfig(env);
    const stores = await openStores(config);
    const recorder = recorderFor({ config, index: stores.index, blobs: stores.blobs, env: {} });
    const proxy = await startProxy({ port: 0, upstreams: { anthropic: up.url, openai: up.url }, recorder });
    const hook = (id: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown>): AgentEvent => ({ id, v: 0, sessionId: SESSION, ts, agent: "claude-code", source: "hook", kind, cwd: "/work/demo", payload });
    const proxied = async (messages: unknown[], session = SESSION) => {
      const r = await call(proxy.url, {
        method: "POST",
        path: "/v1/messages?beta=true",
        headers: { "content-type": "application/json", "x-api-key": AGENT_KEY, "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.319 (external, cli)", "x-claude-code-session-id": session },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1024, stream: true, system: [{ type: "text", text: "You are Claude Code." }], tools: [{ name: "Bash", input_schema: { type: "object" } }], messages }),
      });
      assert.equal(r.status, 200);
      await recorder.flush();
    };
    try {
      // Step 1: the prompt. Its call replies with Bash, step 2. Step 3: "thanks", replied to in text.
      await stores.index.putEvents([hook("next-hook-0001", Date.now() - 60_000, "user.message", { text: "fix the failing test" })]);
      await proxied([first]);
      await sleep(20);
      const t = Date.now();
      await stores.index.putEvents([
        hook("next-hook-0002", t, "tool.start", { tool: "Bash", toolUseId: "toolu_1", input: { command: "npm test" } }),
        hook("next-hook-0003", t + 1, "tool.end", { tool: "Bash", toolUseId: "toolu_1", ok: false, output: "npm ERR! Missing script: test" }),
        hook("next-hook-0004", t + 2, "user.message", { text: "thanks" }),
      ]);
      await sleep(20);
      await proxied([first, toolUse, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "npm ERR! Missing script: test" }, { type: "text", text: "thanks" }] }]);
      await stores.index.upsertSession(buildSession(await stores.index.listEvents(SESSION)));
      // A session the proxy logged alone (no hooks): model calls, but no prompts or tool calls of its own.
      await proxied([first], PROXY_ONLY);
      await stores.index.upsertSession(buildSession(await stores.index.listEvents(PROXY_ONLY)));
    } finally {
      await proxy.close();
      await stores.index.close();
      await stores.blobs.close?.();
    }
    writeFileSync(join(proj, "my fixed.md"), "Run the tests with node --test.\n");
    writeFileSync(join(proj, "sys.md"), "You are a careful agent.\n");
  });
  after(async () => {
    await up?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const p = spawn(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...env, ...extra }, cwd: proj, timeout: 120_000 });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d: Buffer) => (stdout += d));
      p.stderr.on("data", (d: Buffer) => (stderr += d));
      p.on("error", reject);
      p.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const lines = (s: string) => s.split(/\r?\n/);
  const steps = async () => {
    const r = await cli(["replay", SESSION, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const all = (JSON.parse(r.stdout) as { steps: { n: number; kind: string; tool?: string }[] }).steps;
    const tool = all.find((x) => x.tool === "Bash")?.n;
    const [prompt, thanks] = all.filter((x) => x.kind === "prompt").map((x) => x.n);
    assert.ok(tool && prompt && thanks, JSON.stringify(all));
    return { tool, prompt, thanks };
  };

  it("the call line says which call the fork starts from: a prompt step's is the agent's first call after the prompt", async () => {
    const { prompt, tool } = await steps();
    const before = sent.length;
    const r = await cli(["replay", SESSION, "--step", String(prompt), "--fork", "--with", "CLAUDE.md=my fixed.md"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(sent.length - before, 1);
    assert.match(r.stdout, / · the agent's first call after the prompt$/m, r.stdout);
    assert.doesNotMatch(r.stdout, /last call before the step/);
    // A tool step's call is the one whose reply made the tool call.
    const t = await cli(["replay", SESSION, "--step", String(tool), "--fork", "--with", "CLAUDE.md=my fixed.md"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(t.status, 0, t.stderr + t.stdout);
    assert.equal(sent.length - before, 2);
    assert.match(t.stdout, / · made the step's tool call$/m, t.stdout);
  });

  it("keep this step: the command repeats every change flag and -k, each argument quoted for the user's shell", async () => {
    const { tool } = await steps();
    const before = sent.length;
    const args = ["replay", SESSION, "--step", String(tool), "--fork", "--with", "CLAUDE.md=my fixed.md", "--system", "@sys.md", "-k", "2"];
    const r = await cli(args, { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(sent.length - before, 2, "-k 2: two forked calls, both to the stub");
    for (const s of sent.slice(before)) {
      assert.equal(s.key, USER_KEY);
      assert.ok(s.text.includes("node --test") && s.text.includes("You are a careful agent."), "the fork carried both changes");
    }
    const keep = cliCommand(env, [...args, "--save-case", "forks"]);
    assert.ok(lines(r.stderr).includes(`    ${keep}`), `expected "${keep}" in:\n${r.stderr}`);
  });

  it("nothing to check: the retry it suggests keeps the change flags", async () => {
    const { thanks } = await steps();
    const before = sent.length;
    const r = await cli(["replay", SESSION, "--step", String(thanks), "--fork", "--with", "CLAUDE.md=my fixed.md", "--save-case", "forks"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(sent.length - before, 1);
    assert.match(r.stderr, /recorded reply was text, and the fork gave no single tool call/);
    const retry = cliCommand(env, ["replay", SESSION, "--step", String(thanks), "--fork", "--with", "CLAUDE.md=my fixed.md", "-k", "3", "--save-case", "forks"]);
    assert.ok(lines(r.stderr).includes(`    ${retry}`), `expected "${retry}" in:\n${r.stderr}`);
  });

  it("no key: --fork prints the line that sets it in the user's shell, and sends nothing", async () => {
    const { tool } = await steps();
    const before = up.seen.length;
    const r = await cli(["replay", SESSION, "--step", String(tool), "--fork", "--with", "CLAUDE.md=my fixed.md"]);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(up.seen.length, before, "no key: no request");
    assert.match(r.stderr, /\$ANTHROPIC_API_KEY is not set/);
    const set = envLine(env, "ANTHROPIC_API_KEY", "…");
    assert.ok(lines(r.stderr).includes(`    ${set}`), `expected "${set}" in:\n${r.stderr}`);
  });

  it("no key: exp replay prints the line that sets it in the user's shell, and sends nothing", async () => {
    const before = up.seen.length;
    const r = await cli(["exp", "replay", `${SESSION}#-1`, "--vary", "model=claude-haiku-4-5", "--n", "1"]);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(up.seen.length, before, "no key: no request");
    assert.match(r.stderr, /\$ANTHROPIC_API_KEY is not set/);
    assert.match(r.stderr, /add --dry-run to see the cost first:$/m);
    const set = envLine(env, "ANTHROPIC_API_KEY", "…");
    assert.ok(lines(r.stderr).includes(`    ${set}`), `expected "${set}" in:\n${r.stderr}`);
  });

  it("a session the proxy logged alone: replay says why it has no steps, and --fork stops before any call", async () => {
    const r = await cli(["replay", PROXY_ONLY]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^0 steps, 0 files touched$/m);
    assert.match(r.stdout, /^This session has no steps to replay: it came from a source that records model calls only \(the proxy, or an SDK call outside trace\(\)\), and steps come from the agent's prompts and tool calls\.$/m, r.stdout);
    const show = cliCommand(env, ["show", PROXY_ONLY]);
    assert.ok(lines(r.stderr).includes(`    ${show}`), `expected "${show}" in:\n${r.stderr}`);
    const before = up.seen.length;
    const f = await cli(["replay", PROXY_ONLY, "--step", "1", "--fork"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(f.status, 2, f.stderr);
    assert.equal(up.seen.length, before, "no step to fork: no request");
    assert.match(f.stderr, /This session has no steps to replay: it came from a source that records model calls only/);
  });

  it("exp replay with no calls named: the example in the message runs in the user's shell", async () => {
    const r = await cli(["exp", "replay", "--vary", "model=claude-haiku-4-5"]);
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.ok(r.stderr.includes(`e.g. ${cliCommand(env, ["exp", "replay", "latest#-1"])}, or --session <id>`), r.stderr);
  });
});
