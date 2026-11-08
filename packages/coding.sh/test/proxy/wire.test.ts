import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claudeSessionFromUserId, detectClient, linkCall, namedSession, ResponseSessions } from "../../src/proxy/link.ts";
import { errorClass, rateLimits } from "../../src/proxy/record.ts";
import { SseParser } from "../../src/proxy/sse.ts";
import { anthropicAccumulator, chatAccumulator, classify, compacted, firstAction, parseJsonResponse, parseRequest } from "../../src/proxy/wire.ts";
import { anthropicStream } from "./_helpers.ts";

describe("SseParser", () => {
  it("parses events split at any byte, with CRLF line ends and multi-byte text", () => {
    const text = 'event: a\r\ndata: {"t":"héllo 👋"}\r\n\r\n: comment\n\ndata: line1\ndata: line2\n\n';
    const bytes = Buffer.from(text);
    for (let cut = 1; cut < bytes.length; cut++) {
      const p = new SseParser();
      const evs = [...p.push(bytes.subarray(0, cut)), ...p.push(bytes.subarray(cut)), ...p.end()];
      assert.deepEqual(evs, [{ event: "a", data: '{"t":"héllo 👋"}' }, { data: "line1\nline2" }], `cut at ${cut}`);
    }
  });

  it("flushes a last event with no blank line", () => {
    const p = new SseParser();
    assert.deepEqual(p.push("data: [DONE]"), []);
    assert.deepEqual(p.end(), [{ data: "[DONE]" }]);
  });
});

describe("accumulators", () => {
  it("rebuilds an Anthropic message from its stream", () => {
    const acc = anthropicAccumulator();
    const p = new SseParser();
    for (const s of anthropicStream({ tool: { name: "Read", input: { path: "a.ts" } } })) for (const ev of p.push(s)) acc.feed(ev, 5);
    const r = acc.result();
    assert.equal(r.id, "msg_test_1");
    assert.equal(r.stopReason, "tool_use");
    assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 42, cacheReadTokens: 5000, cacheWriteTokens: 300 });
    assert.equal(r.firstTokenAt, 5);
    assert.deepEqual(firstAction("messages", r.body), { type: "tool", name: "Read", input: { path: "a.ts" } });
  });

  it("joins Chat Completions tool-call deltas and reads the final usage chunk", () => {
    const acc = chatAccumulator();
    const chunks = [
      { id: "c1", model: "gpt-4.1", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_", arguments: '{"ci' } }] } }] },
      { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "weather", arguments: 'ty":"Oslo"}' } }] }, finish_reason: "tool_calls" }] },
      { id: "c1", choices: [], usage: { prompt_tokens: 30, completion_tokens: 9 } },
    ];
    for (const c of chunks) acc.feed({ data: JSON.stringify(c) }, 1);
    acc.feed({ data: "[DONE]" }, 2);
    const r = acc.result();
    assert.equal(r.stopReason, "tool_calls");
    assert.deepEqual(r.usage, { inputTokens: 30, outputTokens: 9 });
    assert.deepEqual(firstAction("chat", r.body), { type: "tool", name: "get_weather", input: { city: "Oslo" } });
  });

  it("reads errors from JSON bodies and SSE error events", () => {
    const r = parseJsonResponse("messages", JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    assert.deepEqual(r.error, { type: "overloaded_error", message: "Overloaded" });
    const acc = anthropicAccumulator();
    acc.feed({ event: "error", data: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) }, 1);
    assert.equal(acc.result().error?.type, "overloaded_error");
    assert.equal(errorClass(529, "overloaded_error"), "overloaded");
    assert.equal(errorClass(undefined, undefined, "ECONNRESET: socket hang up"), "network");
  });
});

describe("classify and parseRequest", () => {
  it("routes by path, with prefixes", () => {
    assert.deepEqual(classify("POST", "/v1/messages?beta=true", {}), { provider: "anthropic", api: "messages" });
    assert.deepEqual(classify("POST", "/v1/messages/count_tokens", {}), { provider: "anthropic", api: "count_tokens" });
    assert.deepEqual(classify("POST", "/openai/v1/chat/completions", {}), { provider: "openai", api: "chat" });
    assert.deepEqual(classify("POST", "/v1/responses", {}), { provider: "openai", api: "responses" });
    assert.deepEqual(classify("GET", "/v1/models", { "anthropic-version": "2023-06-01" }), { provider: "anthropic", api: "other" });
    assert.deepEqual(classify("GET", "/v1/models", {}), { provider: "openai", api: "other" });
    assert.deepEqual(classify("POST", "/v1/responses/compact", {}), { provider: "openai", api: "responses", compaction: true });
  });

  it("compacted: Codex's compact endpoint, or a compaction block or item in the reply", () => {
    const messages = { provider: "anthropic", api: "messages" } as const;
    const responses = { provider: "openai", api: "responses" } as const;
    assert.equal(compacted({ ...responses, compaction: true }, undefined), true);
    assert.equal(compacted(messages, { content: [{ type: "compaction", content: "summary" }, { type: "text", text: "ok" }] }), true);
    assert.equal(compacted(responses, { output: [{ type: "compaction_summary" }] }), true);
    assert.equal(compacted(messages, { content: [{ type: "text", text: "compaction" }] }), false);
    assert.equal(compacted(responses, undefined), false);
  });

  it("finds the system prompt, tools and prompts per API, skipping tool results", () => {
    const a = parseRequest("messages", {
      model: "m",
      system: "S",
      tools: [{ name: "Bash" }],
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] },
      ],
      temperature: 0,
    });
    assert.equal(a.system, "S");
    assert.deepEqual(a.toolNames, ["Bash"]);
    assert.equal(a.prompt, "first");
    assert.equal(a.params.temperature, 0);
    const c = parseRequest("chat", { messages: [{ role: "developer", content: "D" }, { role: "user", content: [{ type: "text", text: "q" }] }], tools: [{ type: "function", function: { name: "f" } }] });
    assert.equal(c.system, "D");
    assert.equal(c.messages.length, 1);
    assert.deepEqual(c.toolNames, ["f"]);
    const r = parseRequest("responses", { instructions: "I", input: "hi", previous_response_id: "resp_0" });
    assert.equal(r.system, "I");
    assert.equal(r.prompt, "hi");
    assert.equal(r.previousResponseId, "resp_0");
    // Codex: no instructions; the system prompt is the leading developer items, later ones are turns.
    const dev = (t: string) => ({ type: "message", role: "developer", content: [{ type: "input_text", text: t }] });
    const user = { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] };
    const x = parseRequest("responses", { input: [dev("D1"), dev("D2"), user] });
    const y = parseRequest("responses", { input: [dev("D1"), dev("D2"), user, dev("later")] });
    assert.deepEqual(x.systemRaw, [dev("D1"), dev("D2")]);
    assert.deepEqual(y.systemRaw, x.systemRaw);
    assert.equal(parseRequest("responses", { input: [user] }).systemRaw, undefined);
  });
});

describe("link", () => {
  it("reads Claude Code's session from the header or metadata.user_id (both forms)", () => {
    const sid = "4f1c2a9e-8d7b-4c1a-9e2f-0a1b2c3d4e5f";
    assert.equal(claudeSessionFromUserId(JSON.stringify({ session_id: sid })), sid);
    assert.equal(claudeSessionFromUserId(`user_abc_account_11111111-2222-3333-4444-555555555555_session_${sid}`), sid);
    assert.equal(claudeSessionFromUserId("user_x"), undefined);
    const client = detectClient({ "user-agent": "claude-cli/2.1.0 (external, cli)" });
    assert.deepEqual(client, { id: "claude-code", version: "2.1.0" });
    assert.deepEqual(namedSession({}, client, parseRequest("messages", { metadata: { user_id: JSON.stringify({ session_id: sid }) } })), { id: sid, by: "metadata" });
  });

  it("ignores unsafe session ids and honors x-coding-sh-session", () => {
    const client = detectClient({ "user-agent": "claude-cli/2.1.0" });
    assert.equal(namedSession({ "x-claude-code-session-id": "../../etc" }, client, undefined), undefined);
    assert.deepEqual(namedSession({ "x-coding-sh-session": "my-app-run-7" }, {}, undefined), { id: "my-app-run-7", by: "header" });
  });

  it("joins Responses calls that continue a response", () => {
    const rs = new ResponseSessions(2);
    rs.set("resp_1", "proxy-a");
    const l = linkCall({}, {}, parseRequest("responses", { input: "next", previous_response_id: "resp_1" }), undefined, rs);
    assert.deepEqual(l, { sessionId: "proxy-a", agent: "proxy", linkedBy: "previous-response" });
    rs.set("resp_2", "b");
    rs.set("resp_3", "c");
    assert.equal(rs.get("resp_1"), undefined, "bounded");
  });

  it("flattens rate-limit headers", () => {
    assert.deepEqual(rateLimits({ "x-ratelimit-remaining-tokens": "100", "retry-after-ms": "250", "x-ratelimit-reset-tokens": "1s" }), { rlTokensRemaining: 100, retryAfterMs: 250 });
  });
});
