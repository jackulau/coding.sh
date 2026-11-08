// The calls check (toolevals) and grader (exp): must, mustNot, max, order and
// partial argument matches, over a model-driver trial's tap, a CLI tap and a
// real Claude Code trace.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { createGrader } from "../../src/graders/index.ts";
import { runChecks } from "../../src/toolevals/checks.ts";
import { callsFromEvents, callsFromTap, checkCalls, cliArgs, type CallsSpec, type ToolCall } from "../../src/toolevals/calls.ts";
import { parseTask, ToolEvalsConfigError } from "../../src/toolevals/config.ts";
import { runModelTrial } from "../../src/toolevals/drivers/model.ts";
import { prepareSandbox } from "../../src/toolevals/sandbox.ts";
import { McpTap, startMcpProxy } from "../../src/toolevals/tap/mcp-proxy.ts";
import type { Check, Driver, McpTarget, TapRecord } from "../../src/toolevals/types.ts";
import { parseToml } from "../../src/core/toml.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { FIXTURES, collect, testCtx, tmpEnv } from "../adapters/_helpers.ts";
import { startFakeProvider } from "./fixtures/fake-provider.mjs";
import { cleanup, cliTarget, FAKE_MCP, task, tmp } from "./helpers.ts";

after(cleanup);

const calls: ToolCall[] = [
  { tool: "sessions_list", args: { limit: 5, where: { agent: "claude-code" }, query: "agent:claude-code since:7d" } },
  { tool: "session_get", args: { sessionId: "s_1" } },
  { tool: "usage", args: { groupBy: "day" } },
];
const check = (spec: CallsSpec) => checkCalls(spec, calls);

describe("checkCalls", () => {
  it("must: passes when a call matches, names the first unmet match", () => {
    assert.deepEqual(check({ must: [{ tool: "sessions_list" }, { tool: "usage" }] }), { pass: true });
    assert.deepEqual(check({ must: [{ tool: "sessions_list" }, { tool: "search" }] }), { pass: false, detail: "no call to search" });
  });

  it("mustNot: fails on the first forbidden call", () => {
    assert.deepEqual(check({ mustNot: [{ tool: "search" }] }), { pass: true });
    assert.deepEqual(check({ mustNot: [{ tool: "usage", args: { groupBy: "day" } }] }), { pass: false, detail: 'call 3 is usage with {"groupBy":"day"}, which mustNot forbids' });
    assert.deepEqual(check({ mustNot: [{ tool: "usage", args: { groupBy: "agent" } }] }), { pass: true });
  });

  it("max: counts every call", () => {
    assert.deepEqual(check({ max: 3 }), { pass: true });
    assert.deepEqual(check({ max: 2 }), { pass: false, detail: "3 calls, max 2" });
    assert.deepEqual(checkCalls({ max: 0 }, []), { pass: true });
  });

  it("order: a subsequence, other calls may come between", () => {
    assert.deepEqual(check({ order: ["sessions_list", "usage"] }), { pass: true });
    assert.deepEqual(check({ order: ["session_get", "sessions_list"] }), { pass: false, detail: "order: no call to sessions_list after session_get" });
    assert.deepEqual(check({ order: ["search"] }), { pass: false, detail: "order: no call to search" });
  });

  it("args match partially: ~substring, numeric bounds, dotted paths, nested tables", () => {
    const ok = (args: Record<string, unknown>) => check({ must: [{ tool: "sessions_list", args }] }).pass;
    assert.equal(ok({ limit: 5 }), true);
    assert.equal(ok({ limit: "<=5" }), true);
    assert.equal(ok({ limit: "<5" }), false);
    assert.equal(ok({ limit: ">=1" }), true);
    assert.equal(ok({ limit: ">5" }), false);
    assert.equal(ok({ query: "~since:7d" }), true);
    assert.equal(ok({ query: "~since:30d" }), false);
    assert.equal(ok({ "where.agent": "claude-code" }), true);
    assert.equal(ok({ "where.agent": "~claude" }), true);
    assert.equal(ok({ where: { agent: "codex" } }), false);
    assert.equal(ok({ where: { agent: "claude-code" } }), true);
    assert.equal(ok({ missing: "~x" }), false);
    assert.equal(ok({ limit: "<=x" }), false, "not a bound: compared as a plain string");
  });

  it("the detail says when calls to the tool exist with other arguments, or with none recorded", () => {
    assert.deepEqual(check({ must: [{ tool: "session_get", args: { sessionId: "s_2" } }] }), { pass: false, detail: 'no call to session_get with {"sessionId":"s_2"} (1 call to session_get with other arguments)' });
    assert.deepEqual(checkCalls({ must: [{ tool: "GET /x", args: { a: 1 } }] }, [{ tool: "GET /x" }]), { pass: false, detail: 'no call to GET /x with {"a":1} (calls to GET /x carry no arguments here)' });
  });
});

describe("cliArgs", () => {
  it("subcommand words are the tool; flags are args, strings as given; argv is kept", () => {
    assert.deepEqual(cliArgs(["sessions", "list", "--limit", "5", "--json", "--agent=codex"]), { tool: "sessions list", args: { argv: ["sessions", "list", "--limit", "5", "--json", "--agent=codex"], limit: "5", json: true, agent: "codex" } });
    const c = cliArgs(["usage", "--since", "7d"]);
    assert.equal(checkCalls({ must: [{ tool: "usage", args: { since: "~d", argv: "~--since 7d" } }] }, [c]).pass, true);
    assert.equal(checkCalls({ must: [{ tool: "sessions list", args: { limit: 5 } }] }, [cliArgs(["sessions", "list", "--limit", "5"])]).pass, true, "a number matches the flag's string");
  });
});

describe("calls check config", () => {
  const parse = (toml: string) => parseTask(parseToml(`id = "t"\ntarget = "x"\ninstruction = "do it"\n${toml}`), "t.toml");

  it("parses must, mustNot, max and order with inline arg tables", () => {
    const t = parse(`[[check]]
kind = "calls"
max = 4
order = ["sessions_list", "session_get"]
must = [{ tool = "sessions_list", args = { limit = "<=10", "where.agent" = "~claude" } }]
mustNot = [{ tool = "purge" }]
`);
    assert.deepEqual(t.checks, [{ kind: "calls", must: [{ tool: "sessions_list", args: { limit: "<=10", "where.agent": "~claude" } }], mustNot: [{ tool: "purge" }], max: 4, order: ["sessions_list", "session_get"] }]);
  });

  it("rejects an empty or malformed calls check", () => {
    assert.throws(() => parse(`[[check]]\nkind = "calls"\n`), (e: unknown) => e instanceof ToolEvalsConfigError && /needs must, mustNot, max or order/.test(e.message));
    assert.throws(() => parse(`[[check]]\nkind = "calls"\nmust = [{ args = { a = 1 } }]\n`), /must\[0\] needs tool/);
    assert.throws(() => parse(`[[check]]\nkind = "calls"\nmax = -1\n`), /max must be a whole number/);
  });
});

describe("calls from the tap", () => {
  it("the MCP tap records tools/call arguments, with secrets redacted", () => {
    const recs: TapRecord[] = [];
    const tap = new McpTap({ record: (r) => recs.push(r) });
    tap.fromClient({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "hi", api_key: "abc123secretvalue" } } });
    tap.fromServer({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "hi" }] } });
    tap.fromClient({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { text: "x".repeat(5000) } } });
    tap.fromServer({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "x" }] } });
    assert.equal(recs[0]!.args!.text, "hi");
    assert.match(String(recs[0]!.args!.api_key), /^\[redacted:/);
    assert.equal(recs[1]!.args, undefined, "arguments above 4 KB are left out");
    assert.deepEqual(callsFromTap(recs).map((c) => c.tool), ["echo", "echo"]);
  });

  const driver = (baseUrl: string): Extract<Driver, { kind: "model" }> => ({ kind: "model", provider: "anthropic", model: "fake-model", baseUrl, apiKeyEnv: "FAKE_KEY" });

  it("a model-driver trial against an MCP target passes and fails calls checks on its tap", async () => {
    const p = await startFakeProvider([{ toolCalls: [{ name: "echo", input: { text: "ping" } }] }, { toolCalls: [{ name: "add", input: { a: 2, b: 3 } }] }, { text: "5" }]);
    const target: McpTarget = { name: "fake", kind: "mcp", transport: "stdio", command: [process.execPath, FAKE_MCP.modern] };
    const good: Check = { kind: "calls", must: [{ tool: "add", args: { a: "<=2", b: 3 } }, { tool: "echo", args: { text: "~pin" } }], mustNot: [{ tool: "fail" }], max: 2, order: ["echo", "add"] };
    const t = task({ target: "fake", checks: [good, { kind: "calls", order: ["add", "echo"] }, { kind: "calls", max: 1 }, { kind: "calls", mustNot: [{ tool: "add", args: { a: 2 } }] }] });
    const sb = await prepareSandbox(t, target, { name: "base" }, "trial_calls", tmp());
    const proxy = await startMcpProxy({ target, variant: { name: "base" }, tapLog: sb.tapLog, binDir: sb.bin, graceMs: 500 });
    try {
      const out = await runModelTrial({ driver: driver(p.url), task: t, target, sandbox: sb, index: new MemoryIndexStore(), trialId: "trial_calls", env: { FAKE_KEY: "k" }, mcp: { stdio: proxy.stdio! } });
      assert.equal(out.finalText, "5");
    } finally {
      await proxy.close();
      await p.close();
    }
    const tap = readFileSync(sb.tapLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TapRecord);
    assert.deepEqual(
      callsFromTap(tap).map((c) => [c.tool, c.args]),
      [
        ["echo", { text: "ping" }],
        ["add", { a: 2, b: 3 }],
      ],
    );
    const r = await runChecks(t, sb, "5", undefined, tap);
    assert.deepEqual(
      r.map((x) => [x.pass, x.detail]),
      [
        [true, undefined],
        [false, "order: no call to echo after add"],
        [false, "2 calls, max 1"],
        [false, 'call 2 is add with {"a":2}, which mustNot forbids'],
      ],
    );
    assert.deepEqual(await runChecks(task({ checks: [good] }), sb, ""), [{ kind: "calls", pass: false, detail: 'no call to add with {"a":"<=2","b":3}' }], "a no-op trial has no calls");
  });

  it("a model-driver trial against a CLI target matches subcommands and flags", async () => {
    const p = await startFakeProvider([{ toolCalls: [{ name: "shell", input: { command: "fake-cli greet --name bob" } }] }, { text: "hello bob" }]);
    const target = cliTarget();
    const t = task({ checks: [{ kind: "calls", must: [{ tool: "greet", args: { name: "bob" } }], mustNot: [{ tool: "fail" }], max: 1 }] });
    const sb = await prepareSandbox(t, target, { name: "base" }, "trial_cli_calls", tmp());
    try {
      await runModelTrial({ driver: driver(p.url), task: t, target, sandbox: sb, index: new MemoryIndexStore(), trialId: "trial_cli_calls", env: { FAKE_KEY: "k" } });
    } finally {
      await p.close();
    }
    const tap = readFileSync(sb.tapLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TapRecord);
    assert.deepEqual(await runChecks(t, sb, "hello bob", undefined, tap), [{ kind: "calls", pass: true }]);
  });
});

describe("calls grader (exp)", () => {
  // scripts/e2e/claude-transcript-capture.mjs: a real Claude Code 2.1.319 session.
  let events: AgentEvent[] = [];
  it("reads a real Claude Code trace", async () => {
    const env = tmpEnv();
    try {
      process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "real", "config");
      events = await collect(claudeCode.backfill!(testCtx().ctx));
    } finally {
      env.restore();
    }
    assert.deepEqual(callsFromEvents(events).map((c) => c.tool), ["Read", "Read", "Bash", "Bash", "Bash", "Read", "Skill", "Bash", "Read", "Read"]);
    const grade = async (spec: Record<string, unknown>) => (await createGrader({ kind: "calls", ...spec } as never)).grade({ input: null, output: null, trace: events as never });
    const pass = await grade({ must: [{ tool: "Skill", args: { skill: "greet" } }, { tool: "Bash", args: { command: "~tee out.txt" } }], order: ["Skill", "Bash"], max: 10 });
    assert.deepEqual([pass.pass, pass.score, pass.reason], [true, 1, "10 calls as expected"]);
    const fail = await grade({ mustNot: [{ tool: "Read", args: { file_path: "~/skills/hello/" } }] });
    assert.deepEqual([fail.pass, fail.score, fail.reason], [false, 0, 'call 9 is Read with {"file_path":"~/skills/hello/"}, which mustNot forbids']);
    const none = await (await createGrader({ kind: "calls", max: 1 } as never)).grade({ input: null, output: null });
    assert.deepEqual([none.pass, none.reason], [false, "no timed trace to check tool calls on"]);
  });

  it("an MCP tool matches by its own name or the agent's", () => {
    const ev = (tool: string, input: unknown): AgentEvent => ({ id: tool, v: 0, sessionId: "s", ts: 1, agent: "claude-code", kind: "tool.start", payload: { tool, input } });
    const c = callsFromEvents([ev("mcp__github__create_issue", { title: "Bug: x" })]);
    assert.deepEqual(c, [{ tool: "create_issue", alias: "mcp__github__create_issue", args: { title: "Bug: x" } }]);
    assert.equal(checkCalls({ must: [{ tool: "create_issue", args: { title: "~Bug" } }] }, c).pass, true);
    assert.equal(checkCalls({ must: [{ tool: "mcp__github__create_issue" }] }, c).pass, true);
  });

  it("rejects a bad spec when built", async () => {
    await assert.rejects(() => createGrader({ kind: "calls" } as never), /calls grader needs must, mustNot, max or order/);
  });
});
