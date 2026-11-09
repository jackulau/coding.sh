// (10) llmCallKey: what changes the key and what does not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiOf, canonicalRequest, llmCallKey } from "../../src/llmcache/key.ts";

const base = {
  model: "claude-test",
  max_tokens: 100,
  system: "sys",
  messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] },
  ],
  tools: [{ name: "Read", input_schema: { type: "object" } }],
};
const k = (b: unknown, o = {}) => llmCallKey("anthropic-messages", b, o);

test("the key ignores the system prompt, stream, metadata, user and cache_control", () => {
  const key = k(base);
  assert.equal(k({ ...base, system: [{ type: "text", text: "other", cache_control: { type: "ephemeral" } }] }), key);
  assert.equal(k({ ...base, stream: true, stream_options: { include_usage: true }, metadata: { user_id: "u1" }, user: "x" }), key);
  const moved = structuredClone(base) as typeof base & { messages: { content: unknown }[] };
  moved.messages[2]!.content = [{ type: "text", text: "next" }];
  moved.messages[0]!.content = [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }];
  assert.equal(k(moved), key);
});

test("key order and string-vs-block content do not matter; content, model and tools do", () => {
  const key = k(base);
  const reordered = Object.fromEntries(Object.entries(base).reverse());
  assert.equal(k(reordered), key);
  assert.notEqual(k({ ...base, messages: [...base.messages.slice(0, 2), { role: "user", content: "changed" }] }), key);
  assert.notEqual(k({ ...base, model: "other" }), key);
  assert.equal(k({ ...base, model: "other" }, { excludeModel: true }), k(base, { excludeModel: true }));
  assert.notEqual(k({ ...base, tools: [] }), key);
  assert.equal(k({ ...base, tools: [] }, { excludeTools: true }), k(base, { excludeTools: true }));
});

test("run-specific strings become placeholders", () => {
  const mk = (cwd: string, run: string) => ({ ...base, messages: [{ role: "user", content: `cd ${cwd}/src and tag ${run}` }] });
  const a = k(mk("/tmp/work-aaaa", "exp_01"), { normalize: { CWD: "/tmp/work-aaaa", RUN: "exp_01" } });
  const b = k(mk("/tmp/work-bbbb", "exp_02"), { normalize: { CWD: "/tmp/work-bbbb", RUN: "exp_02" } });
  assert.equal(a, b);
  // Longest value first: a cwd under HOME becomes <CWD>, not <HOME>/….
  const view = canonicalRequest("anthropic-messages", mk("/home/u/proj", "r"), { normalize: { HOME: "/home/u", CWD: "/home/u/proj" } });
  assert.match(view, /cd <CWD>\/src/);
  // Too-short values are ignored (HOME "/" would rewrite every path).
  assert.match(canonicalRequest("anthropic-messages", mk("/x/y", "r"), { normalize: { HOME: "/" } }), /cd \/x\/y\/src/);
});

test("OpenAI system/developer messages and Responses instructions are dropped", () => {
  const chat = (sys: string) => ({ model: "gpt", messages: [{ role: "system", content: sys }, { role: "developer", content: sys }, { role: "user", content: "hi" }] });
  assert.equal(llmCallKey("openai-chat", chat("a")), llmCallKey("openai-chat", chat("b")));
  assert.equal(llmCallKey("openai-chat", chat("a")), llmCallKey("openai-chat", { model: "gpt", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }));
  const resp = (ins: string) => ({ model: "gpt", instructions: ins, input: [{ role: "developer", content: ins }, { role: "user", content: "hi" }] });
  assert.equal(llmCallKey("openai-responses", resp("a")), llmCallKey("openai-responses", resp("b")));
  assert.equal(llmCallKey("openai-responses", resp("a")), llmCallKey("openai-responses", { model: "gpt", input: "hi" }));
  // Different APIs never share a key.
  assert.notEqual(llmCallKey("openai-chat", { model: "gpt", messages: [] }), llmCallKey("anthropic-messages", { model: "gpt", messages: [] }));
});

test("raw bodies are keyed by their bytes; a JSON string parses first", () => {
  assert.equal(k(JSON.stringify(base)), k(base));
  assert.equal(k(Buffer.from(JSON.stringify(base))), k(base));
  assert.notEqual(k("not json"), k("not json!"));
});

test("only POSTs to the three model paths are cached", () => {
  assert.equal(apiOf("POST", "/v1/messages"), "anthropic-messages");
  assert.equal(apiOf("POST", "/v1/messages?beta=true"), "anthropic-messages");
  assert.equal(apiOf("POST", "/v1/chat/completions"), "openai-chat");
  assert.equal(apiOf("POST", "/v1/responses"), "openai-responses");
  assert.equal(apiOf("POST", "/v1/messages/count_tokens"), undefined);
  assert.equal(apiOf("GET", "/v1/messages"), undefined);
  assert.equal(apiOf("POST", "/v1/models"), undefined);
});
