import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CaseRun } from "../../src/datasets/types.ts";
import {
  actionsDiffer,
  continuationRef,
  continuationTask,
  injectContext,
  parseResponse,
  planContinuation,
  prefixProblems,
  replayNoise,
  validatePrefix,
  type ContinuationTask,
  type FrozenPrefix,
} from "../../src/experiments/continuation.ts";

const PREFIX: FrozenPrefix = {
  v: 1,
  cwd: "/work/demo",
  tools: [{ name: "Bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
  messages: [
    { role: "user", text: "Fix the range bug." },
    { role: "assistant", text: "Editing.", toolCalls: [{ id: "toolu_1", name: "Bash", input: { command: "sed -i s/a/b/ range.js" } }] },
    { role: "tool", toolUseId: "toolu_1", name: "Bash", content: "" },
  ],
};

/** A fetch that records request bodies and answers with `reply(body)`. */
function fakeFetch(reply: (body: Record<string, unknown>) => unknown) {
  const bodies: Record<string, unknown>[] = [];
  const f = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return new Response(JSON.stringify(reply(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: f as unknown as typeof fetch, bodies };
}

const textReply = (text: string) => ({ model: "claude-sonnet-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 10 } });
const toolReply = (command: string) => ({
  model: "claude-sonnet-5-5",
  content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command } }],
  stop_reason: "tool_use",
  usage: { input_tokens: 100, output_tokens: 20 },
});

function task(extra: Partial<ContinuationTask> = {}): ContinuationTask {
  return { kind: "continuation", provider: "anthropic", model: "claude-sonnet-5-5", baseURL: "http://127.0.0.1:9", cacheDir: mkdtempSync(join(tmpdir(), "cont-")), env: {}, ...extra };
}

const ctx = (trial = 1) => ({ runId: "r", caseId: "c1", trial });

describe("continuation prefixes", () => {
  it("rejects a prefix that ends on the assistant, a call without its result, an orphan result and a bad version", () => {
    assert.deepEqual(prefixProblems(PREFIX), []);
    const endsAssistant = { ...PREFIX, messages: [...PREFIX.messages, { role: "assistant", text: "done" }] };
    assert.ok(prefixProblems(endsAssistant).length);
    const noResult = { ...PREFIX, messages: [PREFIX.messages[0], PREFIX.messages[1], { role: "user", text: "and?" }] };
    assert.ok(prefixProblems(noResult).length);
    const orphan = { ...PREFIX, messages: [PREFIX.messages[0], { role: "tool", toolUseId: "zzz", name: "Bash", content: "x" }] };
    assert.ok(prefixProblems(orphan).length);
    assert.ok(prefixProblems({ ...PREFIX, v: 2 }).length);
    assert.throws(() => validatePrefix({ ...PREFIX, messages: [] }));
  });

  it("injects always-on files in full, a path rule only when the prefix touched its paths, and lists an unopened skill", () => {
    const files = [
      { path: "CLAUDE.md", text: "Run the tests before saying done." },
      { path: ".claude/rules/py.md", text: "---\npaths: ['**/*.py']\n---\nUse ruff." },
      { path: ".claude/skills/release/SKILL.md", text: "---\nname: release\ndescription: Cut a release\n---\nSteps…" },
    ];
    const got = injectContext(files, PREFIX);
    assert.deepEqual(
      got.map((f) => [f.path, f.how]),
      [
        ["CLAUDE.md", "full"],
        [".claude/skills/release/SKILL.md", "listed"],
      ],
    );
  });
});

describe("continuation requests", () => {
  it("puts the context in a system-reminder before the first user message (default) or in the system prompt", async () => {
    const files = [{ path: "CLAUDE.md", text: "MARKER: always run npm test." }];
    const a = fakeFetch(() => textReply("ok"));
    await continuationTask(task({ context: { files }, fetch: a.fetch, cache: false })).run(PREFIX, ctx());
    const msgs = a.bodies[0]!.messages as { role: string; content: { type: string; text?: string }[] }[];
    assert.match(msgs[0]!.content[0]!.text!, /^<system-reminder>\nAs you answer the user's questions, you can use the following context:\n\nContents of CLAUDE\.md:\n\nMARKER/);
    assert.match(msgs[0]!.content[0]!.text!, /Fix the range bug\.$/);
    assert.equal(a.bodies[0]!.temperature, undefined, "the Anthropic API rejects sampling parameters");
    // The tool result follows the assistant's tool_use, empty output made explicit.
    assert.deepEqual(msgs[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "(no output)" }] });

    const s = fakeFetch(() => textReply("ok"));
    await continuationTask(task({ context: { files, placement: "system" }, fetch: s.fetch, cache: false })).run(PREFIX, ctx());
    assert.match(String(s.bodies[0]!.system), /Contents of CLAUDE\.md:\n\nMARKER/);
    assert.equal((s.bodies[0]!.messages as { content: { text: string }[] }[])[0]!.content[0]!.text, "Fix the range bug.");
  });

  it("parses a tool_use turn into the first action, with cost", async () => {
    const f = fakeFetch(() => toolReply("npm test"));
    const out = (await continuationTask(task({ fetch: f.fetch, cache: false })).run(PREFIX, ctx())) as { output: Record<string, unknown>; trace: unknown[] };
    assert.deepEqual(out.output.firstAction, { type: "tool", name: "Bash", input: { command: "npm test" } });
    assert.ok(((out.output.usage as { costUsd?: number }).costUsd ?? 0) > 0);
    assert.equal(out.trace.length, 3);
  });

  it("answers a repeated request from the cache with no fetch; another trial is a new request", async () => {
    const f = fakeFetch(() => textReply("Done."));
    const calls: boolean[] = [];
    const t = task({ fetch: f.fetch, onCall: (i) => calls.push(i.cached) });
    const r = continuationTask(t);
    const one = await r.run(PREFIX, ctx(1));
    const two = await r.run(PREFIX, ctx(1));
    assert.equal(f.bodies.length, 1);
    assert.deepEqual(one, two, "a cached response gives the same output");
    await r.run(PREFIX, ctx(2));
    assert.equal(f.bodies.length, 2);
    assert.deepEqual(calls, [false, true, false]);
    const plan = planContinuation(t);
    assert.equal(plan(PREFIX, 1).cached, true);
    assert.equal(plan(PREFIX, 3).cached, false);
  });

  it("builds Responses and chat-completions bodies and parses their tool calls", () => {
    const chat = parseResponse("openai-compatible", { choices: [{ message: { content: null, tool_calls: [{ id: "c", function: { name: "Bash", arguments: '{"command":"npm test"}' } }] }, finish_reason: "tool_calls" }] }, "m");
    assert.deepEqual(chat.toolCalls, [{ id: "c", name: "Bash", input: { command: "npm test" } }]);
    const resp = parseResponse("openai", { output: [{ type: "function_call", call_id: "x", name: "Bash", arguments: '{"command":"ls"}' }], usage: { input_tokens: 5, output_tokens: 1 } }, "m");
    assert.deepEqual(resp.toolCalls[0]!.input, { command: "ls" });
    assert.equal(resp.usage.inputTokens, 5);
  });

  it("has a ref that changes with the context files and not with their order", () => {
    const f1 = { path: "CLAUDE.md", text: "a" };
    const f2 = { path: "AGENTS.md", text: "b" };
    const r = (files: { path: string; text: string }[]) => continuationRef("anthropic", "m", "sys", files, "recorded", "first-user");
    assert.equal(r([f1, f2]), r([f2, f1]));
    assert.notEqual(r([f1]), r([{ ...f1, text: "a2" }]));
  });
});

describe("replay noise (EM-19)", () => {
  it("counts control trials whose first action differs from the recorded turn, and text turns by graded outcome", () => {
    const run = (caseId: string, firstAction: unknown, pass: boolean) => ({ caseId, trial: 1, pass, output: { firstAction } }) as unknown as CaseRun;
    const cases = new Map([
      ["a", { metadata: { recorded: { type: "tool", name: "Bash", input: { command: "npm  run biuld" } }, recordedPass: false } }],
      ["b", { metadata: { recorded: { type: "tool", name: "Bash", input: { command: "npm run biuld" } }, recordedPass: false } }],
      ["c", { metadata: { recorded: { type: "text" }, recordedPass: false } }],
      ["d", { metadata: { recorded: { type: "text" }, recordedPass: false } }],
    ]);
    const noise = replayNoise(
      {
        runs: [
          run("a", { type: "tool", name: "Bash", input: { command: "npm run biuld" } }, false),
          run("b", { type: "tool", name: "Bash", input: { command: "npm run build" } }, true),
          run("c", { type: "text" }, false),
          run("d", { type: "text" }, true),
        ],
      },
      cases,
    )!;
    assert.deepEqual([noise.n, noise.diverged, noise.byAction, noise.byRubric], [4, 2, 2, 2]);
    assert.equal(noise.rate, 0.5);
    assert.ok(noise.lo < 0.5 && noise.hi > 0.5);
    assert.equal(actionsDiffer({ type: "text" }, { type: "text" }), undefined);
    assert.equal(replayNoise({ runs: [] }, cases), undefined);
  });
});
