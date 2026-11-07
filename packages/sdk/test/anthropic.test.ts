import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { flush, init, observe, withSession } from "../src/index.ts";
import { _reset } from "../src/client.ts";
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

const client = () => new Anthropic({ apiKey: "mock", baseURL: llm.url, maxRetries: 0 });
const calls = (sid: string) => serve.events().filter((e) => e.sessionId === sid && e.kind === "llm.call");
const msg = { model: "mock-claude", max_tokens: 64, messages: [{ role: "user" as const, content: "ping" }] };

test("messages.create: same result, usage and stop reason recorded", async () => {
  const raw = await client().messages.create(msg);
  const anthropic = observe(client());
  const res = await withSession("a-plain", () => anthropic.messages.create(msg));
  assert.deepEqual(res, raw);
  await flush();
  const [c] = calls("a-plain");
  assert.equal(c!.payload.provider, "anthropic");
  assert.deepEqual(c!.usage, { inputTokens: 1000, outputTokens: 500 });
  assert.equal(c!.payload.stopReason, "end_turn");
  assert.equal(c!.model, "mock-claude");
  const s = serve.session("a-plain")!;
  assert.equal(s.title, "ping");
  assert.equal(s.stats.turns, 1);
});

test("messages.create({ stream: true }) records usage from message_start + message_delta", async () => {
  const anthropic = observe(client());
  let text = "";
  await withSession("a-stream", async () => {
    const stream = await anthropic.messages.create({ ...msg, stream: true });
    for await (const ev of stream) if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") text += ev.delta.text;
  });
  assert.equal(text, "pong");
  await flush();
  const [c] = calls("a-stream");
  assert.deepEqual(c!.usage, { inputTokens: 1000, outputTokens: 500 });
  assert.ok((c!.payload.ttftMs as number) > 0);
  assert.equal(serve.events().find((e) => e.sessionId === "a-stream" && e.kind === "assistant.message")?.payload.text, "pong");
});

test("messages.stream() is recorded once, events and finalMessage unchanged", async () => {
  const anthropic = observe(client());
  const texts: string[] = [];
  const final = await withSession("a-helper", async () => {
    const stream = anthropic.messages.stream(msg);
    stream.on("text", (t) => texts.push(t));
    return stream.finalMessage();
  });
  assert.equal(texts.join(""), "pong");
  assert.equal(final.content[0]!.type === "text" && final.content[0]!.text, "pong");
  assert.equal(final.usage.output_tokens, 500);
  await flush();
  const cs = calls("a-helper");
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0]!.usage, { inputTokens: 1000, outputTokens: 500 });
});

test("tool_use blocks are listed; errors are rethrown and recorded", async () => {
  const anthropic = observe(client());
  await withSession("a-tool", () => anthropic.messages.create({ ...msg, model: "tool-claude" }));
  let err: unknown;
  await withSession("a-err", async () => {
    try {
      await anthropic.messages.create({ ...msg, model: "fail-claude" });
    } catch (e) {
      err = e;
    }
  });
  assert.ok(err instanceof Anthropic.APIError);
  await flush();
  assert.deepEqual(calls("a-tool")[0]!.payload.toolCalls, [{ name: "lookup_order", id: "toolu_1", arguments: '{"id":"42"}' }]);
  assert.equal(calls("a-tool")[0]!.payload.stopReason, "tool_use");
  const [e] = calls("a-err");
  assert.equal(e!.payload.ok, false);
  assert.match(String(e!.payload.error), /mock failure/);
});
