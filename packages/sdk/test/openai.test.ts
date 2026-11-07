import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import OpenAI from "openai";
import { flush, init, observe, span, stats, trace, withSession } from "../src/index.ts";
import { _reset } from "../src/client.ts";
import { type FakeServe, startFakeServe } from "./helpers/fake-serve.ts";
import { type MockLlm, sameIds, startMockLlm } from "./helpers/mock-llm.ts";

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
  init({ url: serve.url, flushIntervalMs: 10, service: "checkout-api" });
});

const client = () => new OpenAI({ apiKey: "mock", baseURL: `${llm.url}/v1`, maxRetries: 0 });
const llmCalls = (sessionId: string) => serve.events().filter((e) => e.sessionId === sessionId && e.kind === "llm.call");

test("chat.completions.create: same result, one llm.call with usage, model and timing", async () => {
  const raw = await client().chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "ping" }] });
  const openai = observe(client());
  let sessionId = "";
  const res = await trace("plain", async (t) => {
    sessionId = t.sessionId;
    return openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "ping" }] });
  });
  assert.deepEqual(sameIds(res), sameIds(raw));
  assert.equal(res.choices[0]!.message.content, "pong");
  await flush();
  const [call] = llmCalls(sessionId);
  assert.ok(call);
  assert.deepEqual(call.usage, { inputTokens: 1000, outputTokens: 500 });
  assert.equal(call.model, "mock-gpt");
  assert.equal(call.agent, "checkout-api");
  assert.equal(call.payload.provider, "openai");
  assert.equal(call.payload.requestModel, "mock-gpt");
  assert.equal(call.payload.stopReason, "stop");
  assert.equal(call.payload.ok, true);
  assert.ok(typeof call.durationMs === "number" && call.durationMs > 0);
  const s = serve.session(sessionId)!;
  assert.equal(s.stats.latency?.llmCalls, 1);
  assert.equal(s.title, undefined); // trace without input: no user.message
  const reply = serve.events().find((e) => e.sessionId === sessionId && e.kind === "assistant.message");
  assert.equal(reply?.payload.text, "pong");
});

test("observe is idempotent and leaves unknown objects untouched", () => {
  const c = client();
  assert.equal(observe(c), c);
  const create = c.chat.completions.create;
  observe(c);
  assert.equal(c.chat.completions.create, create);
  const other = { foo: 1 };
  assert.equal(observe(other), other);
  assert.deepEqual(other, { foo: 1 });
  assert.equal(observe(null), null);
  assert.equal(observe(42), 42);
});

test("stream without stream_options: usage is captured and the app sees exactly the chunks it would have", async () => {
  const params = { model: "mock-gpt", messages: [{ role: "user" as const, content: "ping" }], stream: true as const };
  const plain: unknown[] = [];
  for await (const ch of await client().chat.completions.create(params)) plain.push(ch);

  const openai = observe(client());
  const seen: unknown[] = [];
  const sid = await trace(
    "stream",
    async (t) => {
      const stream = await openai.chat.completions.create(params);
      for await (const ch of stream) seen.push(ch);
      return t.sessionId;
    },
    { input: "ping" },
  );
  assert.deepEqual(sameIds(seen), sameIds(plain));
  assert.equal(seen.map((c) => (c as { choices: { delta: { content?: string } }[] }).choices[0]?.delta.content ?? "").join(""), "pong");
  // The SDK asked for usage on the wire…
  const sent = llm.requests.at(-1)!.body;
  assert.deepEqual(sent.stream_options, { include_usage: true });
  // …but the caller's params object was not modified.
  assert.equal((params as Record<string, unknown>).stream_options, undefined);
  await flush();
  const [call] = llmCalls(sid);
  assert.deepEqual(call!.usage, { inputTokens: 1000, outputTokens: 500 });
  assert.ok((call!.payload.ttftMs as number) > 0);
  assert.equal(serve.events().find((e) => e.sessionId === sid && e.kind === "assistant.message")?.payload.text, "pong");
  assert.equal(serve.session(sid)!.title, "ping");
});

test("stream with stream_options.include_usage set by the app keeps the usage chunk", async () => {
  const openai = observe(client());
  const chunks: { choices: unknown[]; usage?: unknown }[] = [];
  await withSession("keep-usage", async () => {
    const stream = await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "hi" }], stream: true, stream_options: { include_usage: true } });
    for await (const ch of stream) chunks.push(ch);
  });
  assert.ok(chunks.some((c) => c.choices.length === 0 && c.usage));
  await flush();
  assert.deepEqual(llmCalls("keep-usage")[0]!.usage, { inputTokens: 1000, outputTokens: 500 });
});

test("tee() and toReadableStream() are observed once", async () => {
  const openai = observe(client());
  await withSession("tee", async () => {
    const stream = await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "hi" }], stream: true });
    const [a, b] = stream.tee();
    const ta: string[] = [];
    const tb: string[] = [];
    for await (const ch of a) ta.push(ch.choices[0]?.delta.content ?? "");
    for await (const ch of b) tb.push(ch.choices[0]?.delta.content ?? "");
    assert.equal(ta.join(""), "pong");
    assert.deepEqual(ta, tb);
  });
  await flush();
  assert.equal(llmCalls("tee").length, 1);
});

test("withResponse() and asResponse() still work; asResponse leaves the body unread", async () => {
  const openai = observe(client());
  const { data, response } = await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "hi" }] }).withResponse();
  assert.equal(data.choices[0]!.message.content, "pong");
  assert.equal(response.status, 200);
  const raw = await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "hi" }] }).asResponse();
  const body = (await raw.json()) as { choices: { message: { content: string } }[] };
  assert.equal(body.choices[0]!.message.content, "pong");
});

test("errors are rethrown unchanged and recorded as a failed call", async () => {
  const openai = observe(client());
  let plainErr: unknown;
  try {
    await client().chat.completions.create({ model: "fail-gpt", messages: [{ role: "user", content: "x" }] });
  } catch (e) {
    plainErr = e;
  }
  let err: unknown;
  await withSession("errors", async () => {
    try {
      await openai.chat.completions.create({ model: "fail-gpt", messages: [{ role: "user", content: "x" }] });
    } catch (e) {
      err = e;
    }
  });
  assert.ok(err instanceof OpenAI.APIError);
  assert.equal((err as InstanceType<typeof OpenAI.APIError>).status, (plainErr as InstanceType<typeof OpenAI.APIError>).status);
  assert.equal((err as Error).message, (plainErr as Error).message);
  await flush();
  const [call] = llmCalls("errors");
  assert.equal(call!.payload.ok, false);
  assert.match(String(call!.payload.error), /mock failure/);
  assert.equal(call!.usage, undefined);
});

test("responses.create, plain and streaming", async () => {
  const openai = observe(client());
  await withSession("responses", async () => {
    const r = await openai.responses.create({ model: "mock-gpt", input: "ping" });
    assert.equal(r.output_text, "pong");
    const stream = await openai.responses.create({ model: "mock-gpt", input: [{ role: "user", content: "ping" }], stream: true });
    let text = "";
    for await (const ev of stream) if (ev.type === "response.output_text.delta") text += ev.delta;
    assert.equal(text, "pong");
  });
  await flush();
  const calls = llmCalls("responses");
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.deepEqual(c.usage, { inputTokens: 1000, outputTokens: 500 });
    assert.equal(c.payload.stopReason, "completed");
  }
  const s = serve.session("responses")!;
  assert.equal(s.stats.turns, 2);
  assert.equal(s.title, "ping");
});

test("tool calls are listed on llm.call; tool spans emit tool.start/tool.end", async () => {
  const openai = observe(client());
  const sid = await trace("agent", async (t) => {
    const r = await openai.chat.completions.create({ model: "tool-gpt", messages: [{ role: "user", content: "where is my order" }] });
    const tc = r.choices[0]!.message.tool_calls![0]!;
    const out = await span("tool", "lookup_order", async () => ({ status: "shipped" }), { input: JSON.parse((tc as { function: { arguments: string } }).function.arguments) });
    assert.deepEqual(out, { status: "shipped" });
    return t.sessionId;
  });
  await flush();
  const evs = serve.events().filter((e) => e.sessionId === sid);
  const call = evs.find((e) => e.kind === "llm.call")!;
  assert.deepEqual(call.payload.toolCalls, [{ name: "lookup_order", id: "call_1", arguments: '{"id":"42"}' }]);
  const start = evs.find((e) => e.kind === "tool.start")!;
  const end = evs.find((e) => e.kind === "tool.end")!;
  assert.deepEqual(start.payload.input, { id: "42" });
  assert.deepEqual(end.payload.output, { status: "shipped" });
  assert.equal(start.payload.toolUseId, end.payload.toolUseId);
  assert.equal(end.payload.ok, true);
  const s = serve.session(sid)!;
  assert.equal(s.stats.toolCalls, 1);
  assert.equal(s.stats.turns, 1);
  assert.ok(evs.some((e) => e.kind === "session.end"));
});

test("untraced calls are their own sessions; withSession groups them", async () => {
  const openai = observe(client());
  const before = new Set(serve.sessions().keys());
  await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "one" }] });
  await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "two" }] });
  await flush();
  const fresh = [...serve.sessions()].filter(([id]) => !before.has(id));
  assert.equal(fresh.length, 2);
  for (const [, s] of fresh) {
    assert.equal(s.stats.turns, 1);
    assert.equal(s.stats.latency?.llmCalls, 1);
    assert.ok(s.endedAt);
  }
  await withSession("chat-1", async () => {
    await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "a" }] });
    await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "b" }] });
  });
  await flush();
  const s = serve.session("chat-1")!;
  assert.equal(s.stats.turns, 2);
  assert.equal(s.stats.latency?.llmCalls, 2);
  assert.equal(s.title, "a");
  assert.equal(s.stats.usage?.inputTokens, 2000);
  assert.equal(stats().dropped, 0);
});
