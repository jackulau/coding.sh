import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import OpenAI from "openai";
import { flush, init, observe, observeFetch, withSession } from "../src/index.ts";
import { _reset } from "../src/client.ts";
import { matchShape } from "../src/fetch.ts";
import { gatewayOf } from "../src/observe.ts";
import { type FakeServe, startFakeServe } from "./helpers/fake-serve.ts";
import { type MockLlm, startMockLlm } from "./helpers/mock-llm.ts";

let llm: MockLlm;
let serve: FakeServe;

before(async () => {
  llm = await startMockLlm();
  serve = await startFakeServe();
});
after(async () => {
  assert.deepEqual(serve.rejected, [], "the real server parser accepts every SDK event");
  await llm.close();
  await serve.close();
});
beforeEach(() => {
  _reset();
  init({ url: serve.url, flushIntervalMs: 10 });
});

const calls = (sid: string) => serve.events().filter((e) => e.sessionId === sid && e.kind === "llm.call");
const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("path matching and gateway detection", () => {
  assert.equal(matchShape("https://api.openai.com/v1/chat/completions"), "chat");
  assert.equal(matchShape("https://api.openai.com/v1/responses"), "responses");
  assert.equal(matchShape("https://api.anthropic.com/v1/messages?beta=true"), "messages");
  assert.equal(matchShape("https://ai-gateway.vercel.sh/v1/chat/completions"), "chat");
  assert.equal(matchShape("https://api.anthropic.com/v1/messages/count_tokens"), undefined);
  assert.equal(matchShape("https://api.openai.com/v1/embeddings"), undefined);
  assert.equal(gatewayOf("https://ai-gateway.vercel.sh/v1"), "vercel");
  assert.equal(gatewayOf("https://api.openai.com/v1"), undefined);
});

test("records chat, responses and messages calls, plain and streaming; returns the same Response", async () => {
  const f = observeFetch();
  await withSession("f-all", async () => {
    const r1 = await f(`${llm.url}/v1/chat/completions`, post({ model: "mock-gpt", messages: [{ role: "user", content: "ping" }] }));
    assert.equal(((await r1.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content, "pong");
    const r2 = await f(`${llm.url}/v1/chat/completions`, post({ model: "mock-gpt", messages: [{ role: "user", content: "ping" }], stream: true, stream_options: { include_usage: true } }));
    const text = await r2.text();
    assert.match(text, /\[DONE\]/);
    const r3 = await f(`${llm.url}/v1/responses`, post({ model: "mock-gpt", input: "ping", stream: true }));
    await r3.text();
    const r4 = await f(new Request(`${llm.url}/v1/messages`, post({ model: "mock-claude", max_tokens: 8, messages: [{ role: "user", content: "ping" }] })));
    assert.equal(((await r4.json()) as { content: { text: string }[] }).content[0]!.text, "pong");
    const r5 = await f(`${llm.url}/v1/messages`, post({ model: "mock-claude", max_tokens: 8, stream: true, messages: [{ role: "user", content: "ping" }] }));
    await r5.text();
  });
  await flush();
  const cs = calls("f-all");
  assert.equal(cs.length, 5);
  for (const c of cs) assert.deepEqual(c.usage, { inputTokens: 1000, outputTokens: 500 }, `${c.payload.provider} ${c.payload.requestModel}`);
  assert.deepEqual(
    cs.map((c) => c.payload.provider),
    ["openai", "openai", "openai", "anthropic", "anthropic"],
  );
  assert.ok(cs.slice(1, 3).every((c) => (c.payload.ttftMs as number) > 0));
  const texts = serve.events().filter((e) => e.sessionId === "f-all" && e.kind === "assistant.message");
  assert.ok(texts.length === 5 && texts.every((e) => e.payload.text === "pong"));
});

test("non-LLM requests pass straight through and HTTP errors are recorded", async () => {
  let seen = 0;
  const inner = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen++;
    return fetch(input, init);
  }) as typeof fetch;
  const f = observeFetch(inner);
  await withSession("f-err", async () => {
    const r = await f(`${llm.url}/v1/models`);
    assert.equal(r.status, 404);
    const e = await f(`${llm.url}/v1/chat/completions`, post({ model: "fail-gpt", messages: [] }));
    assert.equal(e.status, 500);
    assert.match(await e.text(), /mock failure/); // the app can still read the body
  });
  assert.equal(seen, 2);
  await flush();
  const cs = calls("f-err");
  assert.equal(cs.length, 1);
  assert.equal(cs[0]!.payload.ok, false);
  assert.match(String(cs[0]!.payload.error), /HTTP 500: mock failure/);
});

test("Vercel AI Gateway calls are tagged", async () => {
  const inner = (async (_input: RequestInfo | URL, init?: RequestInit) => fetch(`${llm.url}/v1/chat/completions`, init)) as typeof fetch;
  const f = observeFetch(inner);
  await withSession("f-gw", () => f("https://ai-gateway.vercel.sh/v1/chat/completions", post({ model: "openai/gpt-5", messages: [{ role: "user", content: "hi" }] })));
  await flush();
  const [c] = calls("f-gw");
  assert.equal(c!.payload.gateway, "vercel");
  assert.equal(c!.payload.requestModel, "openai/gpt-5");
});

test("a client wrapped with observe() and an observed fetch records each call once", async () => {
  const openai = observe(new OpenAI({ apiKey: "mock", baseURL: `${llm.url}/v1`, maxRetries: 0, fetch: observeFetch() }));
  await withSession("f-once", () => openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "hi" }] }));
  await flush();
  assert.equal(calls("f-once").length, 1);
  const of = observeFetch();
  assert.equal(observeFetch(of), of); // wrapping twice is a no-op
});
