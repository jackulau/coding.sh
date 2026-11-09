// Forking a session at a step (coding.sh replay --step N --fork): the harness
// rewrite of a stored request, the splice --run puts in front of the proxy,
// Claude Code's stream-json read back as actions, the next-action grader, and
// the CLI end to end against a stub API: a proxied call whose CLAUDE.md says
// "npm test", forked with a CLAUDE.md that says "node --test", saved as a case
// and run with eval run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/core/config.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { caseExpectation } from "../../src/experiments/fork-case.ts";
import { firstPrompt, spliceMessages, streamActions } from "../../src/experiments/fork-run.ts";
import { actionLabel, changeLabel, emptyChange, isContextPath, parseWith, requestContextFiles, rewriteHarness, type ForkResult } from "../../src/experiments/fork.ts";
import { nextActionGrader } from "../../src/graders/next-action.ts";
import { recorderFor } from "../../src/proxy/index.ts";
import { startProxy } from "../../src/proxy/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { openStores } from "../../src/store/factory.ts";
import { anthropicStream, call, startUpstream, type Upstream } from "../proxy/_helpers.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const SESSION = "5f0e9d8c-7b6a-4c5d-8e9f-0a1b2c3d4e5f";
const USER_KEY = "sk-ant-api03-FORKKEYFORKKEYFORKKEYFORK-abcdefAA";
const OAUTH = "sk-ant-oat01-FORKLOGINFORKLOGINFORKLOGIN-abcdefAA";

const reminder = (claudeMd: string) =>
  "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\nCodebase and user instructions are shown below.\n\n" +
  `Contents of /work/demo/CLAUDE.md (project instructions, checked into the codebase):\n\n${claudeMd}\n\n` +
  "Contents of /home/user/.claude/CLAUDE.md (user's private global instructions for all projects):\n\nBe brief.\n" +
  "# currentDate\nToday's date is 2026-11-07.\n</system-reminder>";

const claudeBody = () => ({
  model: "claude-sonnet-4-5",
  messages: [
    { role: "user", content: [{ type: "text", text: reminder("Run the tests with npm test.") }, { type: "text", text: "fix the failing test", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_0", name: "Read", input: { file_path: "/work/demo/a.js" } }] },
  ],
});

describe("the harness change", () => {
  it("--with: DEST=SRC, a bare path, and DEST= to drop", () => {
    const read = (p: string) => `text of ${p}`;
    const c = parseWith(["CLAUDE.md=fixed.md", "AGENTS.md", "~/.claude/CLAUDE.md="], read);
    assert.deepEqual(c.files, [
      { path: "CLAUDE.md", text: "text of fixed.md" },
      { path: "AGENTS.md", text: "text of AGENTS.md" },
    ]);
    assert.deepEqual(c.remove, ["~/.claude/CLAUDE.md"]);
    assert.throws(() => parseWith(["=x.md"], read), /DEST=SRC/);
    c.set.model = "claude-haiku-4-5";
    assert.equal(changeLabel(c), "CLAUDE.md changed, AGENTS.md changed, without ~/.claude/CLAUDE.md, model=claude-haiku-4-5");
    assert.equal(changeLabel(emptyChange()), "recorded harness");
  });

  it("context paths are CLAUDE.md, AGENTS.md, rules and skills", () => {
    for (const p of ["CLAUDE.md", "sub/AGENTS.md", "CLAUDE.local.md", ".claude/rules/tests.md", ".claude/skills/pdf/SKILL.md", "~/.claude/CLAUDE.md"]) assert.ok(isContextPath(p), p);
    for (const p of ["README.md", "src/CLAUDE.ts", "skills/SKILL.md"]) assert.ok(!isContextPath(p), p);
  });
});

describe("rewriteHarness", () => {
  it("replaces CLAUDE.md where Claude Code put it, and leaves the rest and the original body alone", () => {
    const body = claudeBody();
    const before = JSON.stringify(body);
    const { body: out, edits } = rewriteHarness("messages", body, { files: [{ path: "CLAUDE.md", text: "Run the tests with node --test.\n" }], remove: [] }, "/work/demo");
    assert.deepEqual(edits, [{ path: "CLAUDE.md", how: "replaced" }]);
    const text = ((out.messages as { content: { text: string }[] }[])[0]!.content[0]!).text;
    assert.equal(text, reminder("Run the tests with node --test."));
    assert.equal(JSON.stringify(body), before, "the stored body is copied, not changed");
    assert.deepEqual((out.messages as unknown[])[1], body.messages[1]);
  });

  it("drops a file's whole section, and adds a file the request did not carry next to the others", () => {
    const { body: out, edits } = rewriteHarness("messages", claudeBody(), { files: [{ path: ".claude/rules/tests.md", text: "Never skip tests." }], remove: ["~/.claude/CLAUDE.md", "AGENTS.md"] }, "/work/demo");
    assert.deepEqual(edits, [
      { path: ".claude/rules/tests.md", how: "added" },
      { path: "~/.claude/CLAUDE.md", how: "removed" },
      { path: "AGENTS.md", how: "absent" },
    ]);
    const text = ((out.messages as { content: { text: string }[] }[])[0]!.content[0]!).text;
    assert.ok(!text.includes("Be brief."));
    assert.ok(!text.includes("/home/user/.claude/CLAUDE.md"));
    assert.match(text, /Contents of \/work\/demo\/\.claude\/rules\/tests\.md \(project instructions, checked into the codebase\):\n\nNever skip tests\.\n\nContents of \/work\/demo\/CLAUDE\.md/);
    assert.match(text, /npm test\.\n# currentDate/);
  });

  it("with no context in the request, puts a claudeMd reminder before the prompt", () => {
    const { body: out, edits } = rewriteHarness("messages", { messages: [{ role: "user", content: "fix it" }] }, { files: [{ path: "CLAUDE.md", text: "Use pnpm." }], remove: [] }, "/work/demo");
    assert.deepEqual(edits, [{ path: "CLAUDE.md", how: "added" }]);
    const content = (out.messages as { content: string }[])[0]!.content;
    assert.match(content, /^<system-reminder>\n[\s\S]*# claudeMd\n[\s\S]*Contents of \/work\/demo\/CLAUDE\.md \(project instructions, checked into the codebase\):\n\nUse pnpm\.\n<\/system-reminder>\n\nfix it$/);
  });

  it("replaces Codex's AGENTS.md block in a Responses request", () => {
    const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /work/demo\n\n<INSTRUCTIONS>\nUse npm.\n</INSTRUCTIONS>" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] }] };
    const { body: out, edits } = rewriteHarness("responses", body, { files: [{ path: "AGENTS.md", text: "Use node --test." }], remove: [] }, "/work/demo");
    assert.deepEqual(edits, [{ path: "AGENTS.md", how: "replaced" }]);
    assert.equal((out.input as { content: { text: string }[] }[])[0]!.content[0]!.text, "# AGENTS.md instructions for /work/demo\n\n<INSTRUCTIONS>\nUse node --test.\n</INSTRUCTIONS>");
  });

  it("lists the project context files a request carries", () => {
    assert.deepEqual(requestContextFiles("messages", claudeBody(), "/work/demo"), ["CLAUDE.md"]);
    assert.deepEqual(requestContextFiles("messages", claudeBody(), undefined), []);
  });
});

describe("the --run splice and stream", () => {
  it("firstPrompt is the first user message without its reminders", () => {
    assert.equal(firstPrompt("messages", claudeBody()), "fix the failing test");
    assert.equal(firstPrompt("messages", { messages: [{ role: "user", content: "hi" }] }), "hi");
    assert.equal(firstPrompt("messages", { messages: [] }), undefined);
  });

  it("puts the stored history after the live first message, cache markers dropped and the directory moved", () => {
    const live = [{ role: "user", content: "fix the failing test" }, { role: "assistant", content: "live" }];
    const stored = claudeBody().messages;
    const out = spliceMessages(live, stored, "/work/demo", "/tmp/fork/work");
    assert.equal(out.length, 3);
    assert.equal(out[0], live[0]);
    assert.deepEqual(out[1], { role: "assistant", content: [{ type: "tool_use", id: "toolu_0", name: "Read", input: { file_path: "/tmp/fork/work/a.js" } }] });
    assert.equal(out[2], live[1]);
    assert.ok(!JSON.stringify(spliceMessages(live, [{ role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] }, stored[0]!])).includes("cache_control"));
    assert.deepEqual(spliceMessages(live, stored.slice(0, 1)), live, "nothing to splice");
  });

  it("reads Claude Code's stream-json into actions with their results", () => {
    const lines = [
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "assistant", message: { content: [{ type: "text", text: "Running the tests." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "fail" }] } },
      { type: "assistant", parent_tool_use_id: "t9", message: { content: [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "x" } }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: "a.js" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "ok" }] } },
      { type: "result", result: "Fixed.", is_error: false, session_id: "s-1" },
    ];
    const r = streamActions(`${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`);
    assert.deepEqual(r.actions, [{ label: 'text: "Running the tests."' }, { label: "Bash: npm test", ok: false }, { label: "Edit a.js", ok: true }]);
    assert.equal(r.result, "Fixed.");
    assert.equal(r.isError, false);
    assert.equal(r.sessionId, "s-1");
  });

  it("labels actions", () => {
    assert.equal(actionLabel(undefined), "nothing");
    assert.equal(actionLabel({ type: "tool", name: "Bash", input: { command: "npm   test" } }), "Bash: npm test");
    assert.equal(actionLabel({ type: "text", text: "Done." }), 'text: "Done."');
  });
});

describe("a forked step as a case", () => {
  // As a real Claude Code run records it: the description is prose that changes between samples.
  const recorded = { type: "tool" as const, name: "Bash", input: { command: "npm test", description: "Run the tests" } };

  it("expects the agent off the recorded tool call, or on the one every trial took after a text reply", () => {
    assert.deepEqual(caseExpectation(recorded, undefined), { mustNot: [{ tool: "Bash", args: { command: "~npm test" } }] });
    assert.deepEqual(caseExpectation({ type: "tool", name: "Read", input: { file_path: "/w/a.js" } }, undefined), { mustNot: [{ tool: "Read", args: { file_path: "/w/a.js" } }] });
    assert.deepEqual(caseExpectation({ type: "tool", name: "TodoWrite", input: { description: "x" } }, undefined), { mustNot: [{ tool: "TodoWrite" }] });
    const fork = (names: string[]) => ({ trials: names.map((name) => ({ label: name, action: { type: "tool", name, input: {} } })) }) as unknown as ForkResult;
    assert.deepEqual(caseExpectation({ type: "text", text: "Done." }, fork(["Bash", "Bash"])), { must: [{ tool: "Bash" }] });
    assert.equal(caseExpectation({ type: "text", text: "Done." }, fork(["Bash", "Edit"])), undefined);
    assert.equal(caseExpectation({ type: "text", text: "Done." }, undefined), undefined);
  });

  it("next-action grades a turn's tool calls against the case's calls spec", async () => {
    const g = nextActionGrader();
    const expected = caseExpectation(recorded, undefined);
    const same = await g.grade({ input: {}, expected, output: { toolCalls: [{ name: "Bash", input: { command: "npm test" } }] } });
    assert.equal(same.pass, false);
    // The same action sampled again, with another description and a pipe: still the recorded one.
    const again = await g.grade({ input: {}, expected, output: { toolCalls: [{ name: "Bash", input: { command: "npm test 2>&1", description: "Run the test suite" } }] } });
    assert.equal(again.pass, false);
    const other = await g.grade({ input: {}, expected, output: { toolCalls: [{ name: "Bash", input: { command: "node --test" } }] } });
    assert.equal(other.pass, true);
    assert.equal((await g.grade({ input: {}, expected, output: { toolCalls: [] } })).pass, true);
    const bad = await g.grade({ input: {}, expected: { nope: 1 }, output: {} });
    assert.equal(bad.pass, false);
    assert.match(bad.reason ?? "", /not a calls spec/);
  });
});

describe("CLI: replay --fork against a stub API", () => {
  let up: Upstream;
  let root = "";
  let proj = "";
  let env: NodeJS.ProcessEnv = {};
  const sent: { key?: string; auth?: string; beta?: string; stream?: unknown; fixed: boolean }[] = [];

  before(async () => {
    up = await startUpstream((req, res) => {
      const text = req.body.toString("utf8");
      const body = JSON.parse(text) as { model: string; stream?: boolean };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const s of anthropicStream({ tool: { name: "Bash", input: { command: "npm test", description: "Run the tests" } } })) res.write(s);
        res.end();
        return;
      }
      // The fixed CLAUDE.md gets node --test; anything else repeats the recorded npm test.
      const fixed = text.includes("node --test");
      sent.push({ key: req.headers["x-api-key"] as string | undefined, auth: req.headers.authorization as string | undefined, beta: req.headers["anthropic-beta"] as string | undefined, stream: body.stream, fixed });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `msg_f${sent.length}`, type: "message", role: "assistant", model: body.model, content: [{ type: "tool_use", id: "toolu_f", name: "Bash", input: fixed ? { command: "node --test" } : { command: "npm test", description: "Run the test suite" } }], stop_reason: "tool_use", usage: { input_tokens: 900, output_tokens: 20 } }));
    });
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-fork-")));
    proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    const data = join(root, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.toml"), `[proxy]\nanthropic_upstream = "${up.url}"\nopenai_upstream = "${up.url}"\n`);
    env = { PATH: process.env.PATH, HOME: join(root, "home"), USERPROFILE: join(root, "home"), CODING_SH_HOME: data, NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1" };
    const config = loadConfig(env);
    const stores = await openStores(config);
    const recorder = recorderFor({ config, index: stores.index, blobs: stores.blobs, env: {} });
    const proxy = await startProxy({ port: 0, upstreams: { anthropic: up.url, openai: up.url }, recorder });
    try {
      const t0 = Date.now() - 60_000;
      const hook = (id: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown>): AgentEvent => ({ id, v: 0, sessionId: SESSION, ts, agent: "claude-code", source: "hook", kind, cwd: "/work/demo", payload });
      await stores.index.putEvents([hook("fork-hook-0001", t0, "user.message", { text: "fix the failing test" })]);
      const r = await call(proxy.url, {
        method: "POST",
        path: "/v1/messages?beta=true",
        headers: { "content-type": "application/json", "x-api-key": "sk-ant-api03-AGENTKEYAGENTKEYAGENTKEY-abcdefAA", "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.319 (external, cli)", "x-claude-code-session-id": SESSION },
        body: JSON.stringify({ ...claudeBody(), max_tokens: 1024, stream: true, system: [{ type: "text", text: "You are Claude Code." }], tools: [{ name: "Bash", input_schema: { type: "object" } }] }),
      });
      assert.equal(r.status, 200);
      await recorder.flush();
      const t1 = Date.now() + 1000;
      await stores.index.putEvents([
        hook("fork-hook-0002", t1, "tool.start", { tool: "Bash", toolUseId: "toolu_1", input: { command: "npm test", description: "Run the tests" } }),
        hook("fork-hook-0003", t1 + 500, "tool.end", { tool: "Bash", toolUseId: "toolu_1", ok: false, output: "npm ERR! Missing script: test" }),
      ]);
      await stores.index.upsertSession(buildSession(await stores.index.listEvents(SESSION)));
    } finally {
      await proxy.close();
      await stores.index.close();
      await stores.blobs.close?.();
    }
    writeFileSync(join(proj, "CLAUDE.md"), "Run the tests with npm test.\n");
    writeFileSync(join(proj, "fixed.md"), "Run the tests with node --test.\n");
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
  const toolStep = async () => {
    const r = await cli(["replay", SESSION, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const steps = (JSON.parse(r.stdout) as { steps: { n: number; kind: string; tool?: string }[] }).steps;
    const s = steps.find((x) => x.tool === "Bash");
    assert.ok(s, JSON.stringify(steps));
    return s.n;
  };

  it("refuses fork flags without --fork, --fork without --step, and a fork without a key", async () => {
    assert.match((await cli(["replay", SESSION, "--with", "CLAUDE.md=fixed.md"])).stderr, /--with goes with --fork/);
    assert.match((await cli(["replay", SESSION, "--fork"])).stderr, /--fork needs --step/);
    const n = await toolStep();
    const r = await cli(["replay", SESSION, "--step", String(n), "--fork", "--with", "CLAUDE.md=fixed.md"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\$ANTHROPIC_API_KEY is not set/);
    assert.equal(sent.length, 0);
  });

  it("sends the step's stored call with the new CLAUDE.md and shows recorded vs forked", async () => {
    const n = await toolStep();
    const r = await cli(["replay", SESSION, "--step", String(n), "--fork", "--with", "CLAUDE.md=fixed.md", "-k", "2"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(sent.length, 2);
    for (const s of sent) {
      assert.equal(s.key, USER_KEY, "the user's key, never the agent's");
      assert.equal(s.stream, false);
      assert.equal(s.fixed, true, "the request carried the new CLAUDE.md");
    }
    assert.match(r.stdout, /made the step's tool call/);
    assert.match(r.stdout, /^harness: CLAUDE\.md replaced$/m);
    assert.match(r.stdout, /^recorded {2}Bash: npm test$/m);
    assert.match(r.stdout, /^forked 1 {2}Bash: node --test {2}different/m);
    assert.match(r.stdout, /^2 of 2 forked calls took another action than the recorded one\.$/m);
    assert.match(r.stderr, /--save-case forks/);
  });

  it("the recorded harness repeats the recorded action; a subscription token signs in as a bearer", async () => {
    sent.length = 0;
    const n = await toolStep();
    const r = await cli(["replay", SESSION, "--step", String(n), "--fork", "--json"], { CLAUDE_CODE_OAUTH_TOKEN: OAUTH });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout) as { differ: number; trials: { label: string; differs?: boolean }[]; call: { by: string } };
    assert.equal(d.call.by, "tool-use");
    assert.deepEqual(d.trials.map((t) => [t.label, t.differs]), [["Bash: npm test", false]]);
    assert.equal(d.differ, 0);
    assert.equal(sent[0]!.auth, `Bearer ${OAUTH}`);
    assert.equal(sent[0]!.key, undefined);
    assert.match(sent[0]!.beta ?? "", /oauth-2025-04-20/);
  });

  it("--save-case writes a suite that eval run fails on the old CLAUDE.md and passes on the fixed one", async () => {
    const n = await toolStep();
    const r = await cli(["replay", SESSION, "--step", String(n), "--fork", "--with", "CLAUDE.md=fixed.md", "--save-case", "forks"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const id = `fork-${SESSION.slice(0, 8)}-step${n}`;
    assert.match(r.stdout, new RegExp(`Saved case ${id} in .*forks \\(new suite\\)`));
    const dir = join(proj, "evals", "forks");
    const suite = JSON.parse(readFileSync(join(dir, "suite.json"), "utf8")) as { task: unknown; graders: unknown };
    assert.deepEqual(suite.task, { kind: "request", context: { files: ["CLAUDE.md"] } });
    assert.deepEqual(suite.graders, [{ kind: "next-action" }]);
    const line = JSON.parse(readFileSync(join(dir, "cases.jsonl"), "utf8").trim()) as { id: string; input: { request: string }; expected: unknown };
    assert.equal(line.id, id);
    assert.deepEqual(line.expected, { mustNot: [{ tool: "Bash", args: { command: "~npm test" } }] });
    const saved = readFileSync(join(dir, line.input.request), "utf8");
    assert.match(saved, /Run the tests with npm test\./, "the request as recorded");
    assert.ok(!saved.includes("sk-ant-api03-AGENTKEY"), "no key in the saved request");

    sent.length = 0;
    const fail = await cli(["eval", "run", "forks", "--trials", "1"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(sent.length, 1, fail.stderr + fail.stdout);
    assert.equal(sent[0]!.fixed, false, "CLAUDE.md as it is now: npm test");
    assert.equal(fail.status, 1, "a regression case that fails fails the run");
    assert.match(fail.stdout, /^pass@1 {2}0\.0% .*\(0\/1 trials/m);
    assert.match(fail.stdout, /next-action: call 1 is Bash with \{"command":"~npm test"\}/);

    writeFileSync(join(proj, "CLAUDE.md"), "Run the tests with node --test.\n");
    sent.length = 0;
    const pass = await cli(["eval", "run", "forks", "--trials", "1"], { ANTHROPIC_API_KEY: USER_KEY });
    assert.equal(pass.status, 0, pass.stderr + pass.stdout);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.fixed, true);
    assert.match(pass.stdout, /^pass@1 {2}100\.0% .*\(1\/1 trials/m);
  });
});
