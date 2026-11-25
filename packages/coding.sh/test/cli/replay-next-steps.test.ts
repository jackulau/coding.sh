// What replay, replay --fork and exp replay print, with each command as the user's shell runs it
// (cliCommand, envLine): a session captured through the proxy, forked against a stub API, a
// session the proxy logged alone, and one that wrote a file whose path needs quotes. Every forked
// call goes to the stub, and each test checks how many it got.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { cliCommand, envLine, envRef } from "../../src/cli/next-steps.ts";
import { loadConfig } from "../../src/core/config.ts";
import { wholeRef } from "../../src/core/session-ref.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { recorderFor } from "../../src/proxy/index.ts";
import { startProxy } from "../../src/proxy/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { openStores } from "../../src/store/factory.ts";
import { anthropicStream, call, sleep, startUpstream, type Upstream } from "../proxy/_helpers.ts";
import { CLI } from "../_cli.ts";

const SESSION = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const PROXY_ONLY = "8d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";
const WRITER = "9e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b";
const LATEST = "latest";
/** The reference replay prints for SESSION, PROXY_ONLY and WRITER: 8 characters, which no other id here starts with. */
const short = (id: string) => id.slice(0, 8);
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
    // Step 1: the prompt. Its call replies with Bash, step 2. Step 3: "thanks", replied to in text.
    // Returns the time of step 2.
    const record = async (session: string, ids: string, start: number) => {
      const at = (n: number, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown>): AgentEvent => ({ ...hook(`${ids}${n}`, ts, kind, payload), sessionId: session });
      await stores.index.putEvents([at(1, start, "user.message", { text: "fix the failing test" })]);
      await proxied([first], session);
      await sleep(20);
      const t = Date.now();
      await stores.index.putEvents([
        at(2, t, "tool.start", { tool: "Bash", toolUseId: "toolu_1", input: { command: "npm test" } }),
        at(3, t + 1, "tool.end", { tool: "Bash", toolUseId: "toolu_1", ok: false, output: "npm ERR! Missing script: test" }),
        at(4, t + 2, "user.message", { text: "thanks" }),
      ]);
      await sleep(20);
      await proxied([first, toolUse, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "npm ERR! Missing script: test" }, { type: "text", text: "thanks" }] }], session);
      await stores.index.upsertSession(buildSession(await stores.index.listEvents(session)));
      return t;
    };
    try {
      // A session named latest, older than the rest: typed as is, `latest` opens the newest session.
      await record(LATEST, "next-hook-020", Date.now() - 120_000);
      const t = await record(SESSION, "next-hook-000", Date.now() - 60_000);
      // A session the proxy logged alone (no hooks): model calls, but no prompts or tool calls of its own.
      await proxied([first], PROXY_ONLY);
      await stores.index.upsertSession(buildSession(await stores.index.listEvents(PROXY_ONLY)));
      // A session that writes a file in a route group: parentheses a shell reads as syntax.
      const w = t - 30_000;
      const write = { tool: "Write", toolUseId: "toolu_w", input: { file_path: "/work/demo/app/(auth)/login/page.tsx", content: "export default function Page() {}\n" } };
      await stores.index.putEvents([
        { ...hook("next-hook-0101", w, "user.message", { text: "add a login page" }), sessionId: WRITER },
        { ...hook("next-hook-0102", w + 1, "tool.start", write), sessionId: WRITER },
        { ...hook("next-hook-0103", w + 2, "tool.end", { tool: "Write", toolUseId: "toolu_w", ok: true }), sessionId: WRITER },
      ]);
      await stores.index.upsertSession(buildSession(await stores.index.listEvents(WRITER)));
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
  const steps = async (ref = SESSION) => {
    const r = await cli(["replay", ref, "--json"]);
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
    const keep = cliCommand(env, ["replay", short(SESSION), ...args.slice(2), "--save-case", "forks"]);
    assert.ok(lines(r.stderr).includes(`    ${keep}`), `expected "${keep}" in:\n${r.stderr}`);
  });

  it("nothing to check: the retry it suggests keeps the change flags", async () => {
    const { thanks } = await steps();
    const before = sent.length;
    const r = await cli(["replay", SESSION, "--step", String(thanks), "--fork", "--with", "CLAUDE.md=my fixed.md", "--save-case", "forks"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(sent.length - before, 1);
    assert.match(r.stderr, /recorded reply was text, and the fork gave no single tool call/);
    const retry = cliCommand(env, ["replay", short(SESSION), "--step", String(thanks), "--fork", "--with", "CLAUDE.md=my fixed.md", "-k", "3", "--save-case", "forks"]);
    assert.ok(lines(r.stderr).includes(`    ${retry}`), `expected "${retry}" in:\n${r.stderr}`);
  });

  it("no key: --fork prints the line that sets it in the user's shell, and sends nothing", async () => {
    const { tool } = await steps();
    const before = up.seen.length;
    const r = await cli(["replay", SESSION, "--step", String(tool), "--fork", "--with", "CLAUDE.md=my fixed.md"]);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(up.seen.length, before, "no key: no request");
    // The message and the note name each variable as the user's shell reads it: `$env:NAME` in PowerShell or cmd.
    assert.ok(r.stderr.includes(`API, and ${envRef(env, "ANTHROPIC_API_KEY")} is not set`), r.stderr);
    const set = `${envLine(env, "ANTHROPIC_API_KEY", "...")}   # or a subscription token in ${envRef(env, "CLAUDE_CODE_OAUTH_TOKEN")}`;
    assert.ok(lines(r.stderr).includes(`    ${set}`), `expected "${set}" in:\n${r.stderr}`);
  });

  it("no key: exp replay prints the line that sets it in the user's shell, and sends nothing", async () => {
    const before = up.seen.length;
    const args = ["exp", "replay", `${SESSION}#-1`, "--vary", "model=claude-haiku-4-5", "--n", "1"];
    const r = await cli(args);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.equal(up.seen.length, before, "no key: no request");
    assert.ok(r.stderr.includes(`with your own key, and ${envRef(env, "ANTHROPIC_API_KEY")} is not set`), r.stderr);
    const dry = cliCommand(env, [...args, "--dry-run"]);
    assert.ok(lines(r.stderr).includes(`    See the cost first: ${dry}`), `expected "See the cost first: ${dry}" in:\n${r.stderr}`);
    const set = `${envLine(env, "ANTHROPIC_API_KEY", "...")}   # the agent's own login is never stored, so it can't be reused; a subscription token in ${envRef(env, "CLAUDE_CODE_OAUTH_TOKEN")} works too`;
    assert.ok(lines(r.stderr).includes(`    ${set}`), `expected "${set}" in:\n${r.stderr}`);
  });

  it("a session the proxy logged alone: replay says why it has no steps, and --fork stops before any call", async () => {
    const r = await cli(["replay", PROXY_ONLY]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^0 steps, 0 files touched$/m);
    assert.match(r.stdout, /^This session has no steps to replay: it came from a source that records model calls only \(the proxy, or an SDK call outside trace\(\)\), and steps come from the agent's prompts and tool calls\.$/m, r.stdout);
    const show = cliCommand(env, ["show", short(PROXY_ONLY)]);
    assert.ok(lines(r.stderr).includes(`    ${show}`), `expected "${show}" in:\n${r.stderr}`);
    const before = up.seen.length;
    const f = await cli(["replay", PROXY_ONLY, "--step", "1", "--fork"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(f.status, 2, f.stderr);
    assert.equal(up.seen.length, before, "no step to fork: no request");
    assert.match(f.stderr, /This session has no steps to replay: it came from a source that records model calls only/);
  });

  it("a step's see-the-whole-file command quotes the path, so a route group's parentheses stay one argument", async () => {
    const path = "app/(auth)/login/page.tsx";
    const r = await cli(["replay", WRITER, "--step", "2"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ {2}[AM] app\/\(auth\)\/login\/page\.tsx {2}← this step$/m, r.stdout);
    const file = cliCommand(env, ["replay", short(WRITER), "--step", "2", "--file", path]);
    assert.notEqual(file.endsWith(` ${path}`), true, "the path is quoted");
    assert.ok(lines(r.stderr).includes(`    ${file}`), `expected "${file}" in:\n${r.stderr}`);
    const idx = await cli(["replay", WRITER]);
    assert.equal(idx.status, 0, idx.stderr);
    const step = cliCommand(env, ["replay", short(WRITER), "--step", "2"]);
    assert.ok(lines(idx.stderr).includes(`    ${step}`), `expected "${step}" in:\n${idx.stderr}`);
    const shown = await cli(["replay", WRITER, "--step", "2", "--file", path]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^export default function Page\(\) \{\}$/m);
  });

  it("a session named latest: the step list and the fork's commands name it by a reference that opens it", async () => {
    // Typed as is, `latest` opens the newest session. The reference coding.sh sessions lists it by opens this one.
    const ref = wholeRef(LATEST);
    const opened = await cli(["show", ref, "--json", "--fields", "session.id"]);
    assert.equal(opened.status, 0, opened.stderr);
    assert.equal(JSON.parse(opened.stdout).session.id, LATEST);
    const { tool, thanks } = await steps(ref);
    const idx = await cli(["replay", ref]);
    assert.equal(idx.status, 0, idx.stderr);
    const step = cliCommand(env, ["replay", ref, "--step", "1"]);
    assert.ok(lines(idx.stderr).includes(`    ${step}`), `expected "${step}" in:\n${idx.stderr}`);
    const before = sent.length;
    const change = ["--fork", "--with", "CLAUDE.md=my fixed.md"];
    const r = await cli(["replay", ref, "--step", String(tool), ...change], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const keep = cliCommand(env, ["replay", ref, "--step", String(tool), ...change, "--save-case", "forks"]);
    assert.ok(lines(r.stderr).includes(`    ${keep}`), `expected "${keep}" in:\n${r.stderr}`);
    const t = await cli(["replay", ref, "--step", String(thanks), ...change, "--save-case", "forks"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(t.status, 1, t.stderr + t.stdout);
    const retry = cliCommand(env, ["replay", ref, "--step", String(thanks), ...change, "-k", "3", "--save-case", "forks"]);
    assert.ok(lines(t.stderr).includes(`    ${retry}`), `expected "${retry}" in:\n${t.stderr}`);
    assert.equal(sent.length - before, 2, "one forked call each, both to the stub");
  });

  it("exp replay with no calls named: the example in the message runs in the user's shell", async () => {
    const r = await cli(["exp", "replay", "--vary", "model=claude-haiku-4-5"]);
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.ok(r.stderr.includes(`e.g. ${cliCommand(env, ["exp", "replay", "latest#-1"])}, or --session <id>`), r.stderr);
  });
});
