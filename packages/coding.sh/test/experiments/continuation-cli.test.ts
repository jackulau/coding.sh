// The next turn through a subscription CLI (`claude -p`, `codex exec`): the
// replayed context must carry what the API path sends. The prefix is frozen
// from the real Claude Code capture (test/fixtures/adapters/claude-code/real,
// from scripts/e2e/claude-transcript-capture.mjs) the way exp ab freezes one,
// then sent both ways: to a fake Messages API and to a fake CLI. Claude Code
// gets the session's built-in tools natively; MCP tools and Codex fall back to
// the structured turn with the tools listed in the prompt.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import type { AgentEvent } from "../../src/core/types.ts";
import { freezePrefix } from "../../src/eval/decision.ts";
import {
  CLI_NATIVE_ASK,
  CLI_NATIVE_PROTOCOL,
  CLI_TURN_ASK,
  CLI_TURN_PROTOCOL,
  CLI_TURN_SCHEMA,
  continuationTask,
  type ContinuationProvider,
  type ContinuationTask,
  type FrozenPrefix,
} from "../../src/experiments/continuation.ts";
import { CliLimiter } from "../../src/judge/subscription.ts";
import { nodeBin, pathOf } from "../_bin.ts";
import { collect, FIXTURES, testCtx, tmpEnv } from "../adapters/_helpers.ts";
import { MemBlobs } from "../helpers-eval.ts";

const HARNESS = "HARNESS-MARKER: run the tests before you say you are done.";

// A fake `claude -p` that appends one log line per call. With tools (--tools not empty) it answers
// like `--output-format stream-json`: the turn, the refused call's result, a second turn that must
// not count, then the result line. Without, a structured turn like `--output-format json`.
const FAKE_CLAUDE = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, input }) + "\\n");
  const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
  const usage = { input_tokens: 2000, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (argv[argv.indexOf("--tools") + 1]) {
    say({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
    say({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "Running the tests first." }, { type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "npm test" } }] } });
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_a", is_error: true, content: "blocked by hook" }] } });
    say({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "The hook blocked it." }] } });
    say({ type: "result", subtype: "error_max_turns", is_error: true, usage, total_cost_usd: 0.01 });
    process.exitCode = 1;
    return;
  }
  say({
    type: "result", is_error: false, stop_reason: "end_turn", result: "",
    structured_output: { text: "Running the tests first.", tool_calls: [{ name: "Bash", input_json: JSON.stringify({ command: "npm test" }) }] },
    usage, modelUsage: { "claude-sonnet-5-5": { inputTokens: 2000 } },
  });
});
`;

// A fake `codex exec` that logs its stdin and instructions and writes a structured turn to -o.
const FAKE_CODEX = `
const fs = require("node:fs");
const argv = process.argv.slice(2);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const instr = argv.find((a) => a.startsWith("model_instructions_file="));
  const system = fs.readFileSync(JSON.parse(instr.slice("model_instructions_file=".length)), "utf8");
  const schema = argv.includes("--output-schema") ? JSON.parse(fs.readFileSync(argv[argv.indexOf("--output-schema") + 1], "utf8")) : undefined;
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, input, system, schema }) + "\\n");
  const turn = JSON.stringify({ text: "", tool_calls: [{ name: "Bash", input_json: JSON.stringify({ command: "npm test" }) }] });
  fs.writeFileSync(argv[argv.indexOf("-o") + 1], turn);
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: turn } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 0, output_tokens: 40 } }) + "\\n");
});
`;

let root: string;
let prefix: FrozenPrefix;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "csh-cont-cli-"));
  const t = tmpEnv();
  let events: AgentEvent[];
  const { ctx, blobs } = testCtx();
  try {
    process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-code", "real", "config");
    events = await collect(claudeCode.backfill!(ctx));
  } finally {
    t.restore();
  }
  const store = new MemBlobs();
  for (const text of blobs.values()) await store.put(text);
  const top = events.filter((e) => !e.sessionId.includes(":sub:")).sort((a, b) => a.ts - b.ts);
  const cut = top.findLast((e) => e.kind === "assistant.message");
  assert.ok(cut, "the capture ends on an assistant message");
  prefix = await freezePrefix(top, cut.id, store);
});
after(() => rmSync(root, { recursive: true, force: true }));

type Block = { type: string; text?: string; name?: string; input?: unknown; content?: string };
type ApiBody = { system: string; messages: { role: string; content: Block[] }[]; tools: { name: string }[] };
type Call = { argv: string[]; input: string; system?: string; schema?: unknown };

const count = (s: string, x: string) => s.split(x).length - 1;
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] ?? "";

let dirs = 0;
/** A temp dir with a fake `claude` and `codex` on PATH, and its env. */
function world(): { env: NodeJS.ProcessEnv; calls: () => Call[] } {
  const dir = join(root, `w${++dirs}`);
  mkdirSync(dir);
  nodeBin(join(dir, "bin"), "claude", FAKE_CLAUDE);
  nodeBin(join(dir, "bin"), "codex", FAKE_CODEX);
  mkdirSync(join(dir, ".codex"));
  const log = join(dir, "log.jsonl");
  return {
    env: { HOME: dir, USERPROFILE: dir, PATH: pathOf(join(dir, "bin"), process.env.PATH), FAKE_LOG: log, CLAUDE_CODE_OAUTH_TOKEN: "fake", CODEX_API_KEY: "fake" },
    calls: () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Call),
  };
}

/** The Messages API body and the CLI call for the same prefix, harness and model. */
async function both(p: FrozenPrefix, provider: ContinuationProvider): Promise<{ api: ApiBody; call: Call }> {
  let api: ApiBody | undefined;
  const fetch = (async (_u: unknown, init?: RequestInit) => {
    api = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const w = world();
  const base: ContinuationTask = { kind: "continuation", provider: "anthropic", model: "claude-sonnet-5-5", cache: false, context: { files: [{ path: "CLAUDE.md", text: HARNESS }] }, env: w.env };
  const ctx = { runId: "r", caseId: "c1", trial: 1 };
  await continuationTask({ ...base, baseURL: "http://127.0.0.1:9", fetch }).run(p, ctx);
  await continuationTask({ ...base, provider, limiter: new CliLimiter() }).run(p, ctx);
  assert.ok(api);
  const calls = w.calls();
  assert.equal(calls.length, 1);
  return { api, call: calls[0]! };
}

/** Every text, tool call and tool result of the API body is in the CLI prompt, once per block, and the harness goes in once. */
function sameParts(api: ApiBody, system: string, user: string): void {
  assert.equal(count(JSON.stringify(api), HARNESS), 1);
  assert.equal(count(system + user, HARNESS), 1, "the harness file goes in once, as in the API body");
  assert.ok(user.indexOf(HARNESS) < user.indexOf("<user>\n") + 400, "in front of the first user message");
  let uses = 0;
  let results = 0;
  for (const m of api.messages) {
    for (const b of m.content) {
      if (b.type === "text") assert.ok(user.includes(b.text!), `text: ${b.text!.slice(0, 80)}`);
      else if (b.type === "tool_use") {
        uses++;
        assert.ok(user.includes(` name="${b.name}">${JSON.stringify(b.input)}</tool_call>`), `tool call ${b.name} ${JSON.stringify(b.input).slice(0, 80)}`);
      } else if (b.type === "tool_result") {
        results++;
        assert.ok(user.includes(`>\n${b.content}\n</tool_result>`), `tool result: ${String(b.content).slice(0, 80)}`);
      } else assert.fail(`unexpected block ${b.type}`);
    }
  }
  assert.ok(uses >= 5 && results === uses);
  assert.equal(count(user, "<tool_call "), uses);
  assert.equal(count(user, "<tool_result "), results);
}

describe("continuation through a subscription CLI", () => {
  it("the frozen prefix is a real multi-turn session with Claude Code's built-in tools", () => {
    assert.ok(prefix.messages.filter((m) => m.role === "tool").length >= 5);
    assert.deepEqual(new Set(prefix.tools.map((t) => t.name)), new Set(["Read", "Bash", "Skill"]));
  });

  it("tells the model it can call the listed tools, never that it has none", () => {
    // On a real subscription replay, "gives you no tools to run" made the model say it could not run
    // the tests instead of calling them, so the edit under test never got its chance.
    for (const p of [CLI_TURN_PROTOCOL, CLI_NATIVE_PROTOCOL]) assert.doesNotMatch(p, /\bno tools?\b|can(?:no|')t (?:run|call)|not available|(?<!none is )disabled/i);
    assert.match(CLI_TURN_PROTOCOL, /every tool in <tools> works and none is disabled/);
    assert.match(CLI_TURN_PROTOCOL, /tool_calls/);
    assert.match(CLI_TURN_PROTOCOL, /the calls run after you answer/);
    assert.doesNotMatch(CLI_NATIVE_PROTOCOL, /tool_calls|<tools>/, "native tools need no JSON protocol");
  });

  it("claude-code with built-in tools: the session's tools natively, the same system prompt, harness, messages, calls and results as the API body", async () => {
    const { api, call } = await both(prefix, "claude-code");
    const system = flag(call.argv, "--system-prompt");
    assert.equal(system, `${api.system}\n\n${CLI_NATIVE_PROTOCOL}`, "the API system prompt, then the protocol");
    sameParts(api, system, call.input);
    assert.deepEqual(flag(call.argv, "--tools").split(","), api.tools.map((t) => t.name), "the API body's tools, by name");
    assert.equal(count(call.input, "<tools>"), 0, "no tool list in the prompt: the model has them");
    assert.ok(call.input.endsWith(`</conversation>\n\n${CLI_NATIVE_ASK}`));
    assert.equal(flag(call.argv, "--output-format"), "stream-json");
    assert.equal(flag(call.argv, "--max-turns"), "1");
    assert.match(flag(call.argv, "--settings"), /"PreToolUse".*"exit 2"/);
    assert.ok(!call.argv.includes("--json-schema"));
  });

  it("a tool Claude Code doesn't have (MCP) falls back to the structured turn, with the tools listed in the prompt", async () => {
    const mcp: FrozenPrefix = { ...prefix, tools: [...prefix.tools, { name: "mcp__github__create_issue", description: "Open an issue", inputSchema: { type: "object", properties: { title: { type: "string" } } } }] };
    const { api, call } = await both(mcp, "claude-code");
    const system = flag(call.argv, "--system-prompt");
    assert.equal(system, `${api.system}\n\n${CLI_TURN_PROTOCOL}`);
    sameParts(api, system, call.input);
    for (const t of api.tools) assert.ok(call.input.includes(`<tool name="${t.name}">`), `tool ${t.name}`);
    assert.ok(call.input.endsWith(`</conversation>\n\n${CLI_TURN_ASK}`));
    assert.equal(flag(call.argv, "--tools"), "", "no native tools");
    assert.deepEqual(JSON.parse(flag(call.argv, "--json-schema")), CLI_TURN_SCHEMA);
  });

  it("codex: the structured turn, the tools listed in the prompt, the schema as --output-schema", async () => {
    const { api, call } = await both(prefix, "codex");
    assert.equal(call.system, `${api.system}\n\n${CLI_TURN_PROTOCOL}`);
    sameParts(api, call.system!, call.input);
    for (const t of api.tools) assert.ok(call.input.includes(`<tool name="${t.name}">`), `tool ${t.name}`);
    assert.deepEqual(call.schema, CLI_TURN_SCHEMA);
  });

  for (const [what, provider, p] of [
    ["native", "claude-code", () => prefix],
    ["structured", "claude-code", () => ({ ...prefix, tools: [...prefix.tools, { name: "mcp__x__y" }] })],
    ["codex", "codex", () => prefix],
  ] as const) {
    it(`${what}: reads the turn as text and tool calls, prices it, and answers a rerun from the cache`, async () => {
      const w = world();
      const calls: { cached: boolean; costUsd?: number }[] = [];
      const spec: ContinuationTask = {
        kind: "continuation",
        provider,
        model: "claude-sonnet-5-5",
        cacheDir: join(root, `cache-${what}`),
        env: w.env,
        limiter: new CliLimiter(),
        onCall: (i) => calls.push({ cached: i.cached, ...(i.costUsd !== undefined ? { costUsd: i.costUsd } : {}) }),
      };
      const ctx = { runId: "r", caseId: "c1", trial: 1 };
      const first = (await continuationTask(spec).run(p(), ctx)) as { output: { text: string; toolCalls: { name: string; input: unknown }[]; firstAction: unknown; usage: { inputTokens?: number; costUsd?: number } } };
      assert.equal(first.output.text, provider === "codex" ? "" : "Running the tests first.", "only the first turn counts");
      assert.deepEqual(first.output.toolCalls.map((c) => [c.name, c.input]), [["Bash", { command: "npm test" }]]);
      assert.deepEqual(first.output.firstAction, { type: "tool", name: "Bash", input: { command: "npm test" } });
      assert.equal(first.output.usage.inputTokens, 2000);
      assert.ok((first.output.usage.costUsd ?? 0) > 0, "priced at the API rate (API-equivalent)");
      const again = (await continuationTask(spec).run(p(), ctx)) as typeof first;
      assert.deepEqual(again.output.toolCalls, first.output.toolCalls);
      assert.equal(w.calls().length, 1, "the rerun made no CLI call");
      assert.deepEqual(
        calls.map((c) => c.cached),
        [false, true],
      );
      assert.equal(calls[1]!.costUsd, 0);
    });
  }
});
