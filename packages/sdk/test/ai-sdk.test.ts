// aiSdkTracer() with the real AI SDK: v7 through @ai-sdk/otel's OpenTelemetry
// integration (gen_ai.* spans) and v6 through experimental_telemetry.tracer
// (ai.* spans). Spans go to the fake serve's /v1/traces, which maps them with
// the core package's real OTLP mapper.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { generateText, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { OpenTelemetry } from "@ai-sdk/otel";
import { generateText as generateTextV6 } from "ai-v6";
import { MockLanguageModelV3 } from "ai-v6/test";
import { aiSdkTracer, flush, init, trace, withSession } from "../src/index.ts";
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
  init({ url: serve.url, flushIntervalMs: 10, service: "ai-app" });
});

const model = () => createOpenAI({ apiKey: "mock", baseURL: `${llm.url}/v1` }).chat("mock-gpt");
const v6Model = () =>
  new MockLanguageModelV3({
    modelId: "mock-gpt",
    doGenerate: async () => ({
      content: [{ type: "text", text: "pong" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 500, text: 500, reasoning: undefined } },
      warnings: [],
    }),
  });

test("AI SDK 7: generateText via @ai-sdk/otel OpenTelemetry({ tracer }) lands in the withSession session", async () => {
  const telemetry = { integrations: new OpenTelemetry({ tracer: aiSdkTracer() }) };
  const r = await withSession("j3-sdk", () => generateText({ model: model(), prompt: "ping", telemetry }));
  assert.equal(r.text, "pong");
  await flush();
  const s = serve.session("j3-sdk");
  assert.ok(s, `sessions: ${[...serve.sessions().keys()].join(", ")}`);
  assert.equal(s.stats.latency?.llmCalls, 1);
  // (the v7 integration reports cache reads of 0, which the server mapper keeps as cacheReadTokens: 0)
  assert.equal(s.stats.usage?.inputTokens, 1000);
  assert.equal(s.stats.usage?.outputTokens, 500);
  assert.equal(s.agent, "ai-app");
  assert.equal(s.title, "ping");
  const call = serve.events().find((e) => e.sessionId === "j3-sdk" && e.kind === "llm.call")!;
  assert.equal(call.model, "mock-gpt");
  const spans = serve.requests.filter((q) => q.path === "/v1/traces");
  assert.ok(spans.length >= 1);
});

test("AI SDK 7: streamText, and a tracer-level sessionId; parents chain from the context argument", async () => {
  const tracer = aiSdkTracer({ sessionId: "j3-stream" });
  const r = streamText({ model: model(), prompt: "ping", telemetry: { integrations: new OpenTelemetry({ tracer }) } });
  assert.equal(await r.text, "pong");
  await flush();
  const s = serve.session("j3-stream")!;
  assert.equal(s.stats.latency?.llmCalls, 1);
  assert.equal(s.stats.usage?.inputTokens, 1000);
  assert.equal(s.stats.usage?.outputTokens, 500);
  // one trace, one root: every span but the root has a parent in the same trace
  const evs = serve.events().filter((e) => e.sessionId === "j3-stream");
  const traces = new Set(evs.map((e) => e.traceId));
  assert.equal(traces.size, 1);
  assert.equal(evs.filter((e) => e.kind === "session.start").length, 1);
});

test("AI SDK 6: experimental_telemetry.tracer with metadata.sessionId", async () => {
  const r = await generateTextV6({
    model: v6Model(),
    prompt: "ping",
    experimental_telemetry: { isEnabled: true, tracer: aiSdkTracer() as never, functionId: "j3", metadata: { sessionId: "j3-v6" } },
  });
  assert.equal(r.text, "pong");
  await flush();
  const s = serve.session("j3-v6")!;
  assert.ok(s, `sessions: ${[...serve.sessions().keys()].join(", ")}`);
  assert.equal(s.stats.latency?.llmCalls, 1, "doGenerate counted once, not the wrapper span");
  assert.deepEqual(s.stats.usage, { inputTokens: 1000, outputTokens: 500 });
});

test("AI SDK spans inside trace() join that trace's session", async () => {
  const sid = await trace("handler", async (t) => {
    await generateText({ model: model(), prompt: "ping", telemetry: { integrations: new OpenTelemetry({ tracer: aiSdkTracer() }) } });
    return t.sessionId;
  });
  await flush();
  const s = serve.session(sid)!;
  assert.equal(s.stats.latency?.llmCalls, 1);
  assert.equal(s.stats.usage?.inputTokens, 1000);
});

test("metadata capture mode drops prompt and response text from spans", async () => {
  _reset();
  init({ url: serve.url, flushIntervalMs: 10, capture: "metadata" });
  await withSession("j3-meta", () => generateText({ model: model(), prompt: "secret prompt", telemetry: { integrations: new OpenTelemetry({ tracer: aiSdkTracer() }) } }));
  await flush();
  const body = JSON.stringify(serve.requests.filter((q) => q.path === "/v1/traces").at(-1)!.body);
  assert.doesNotMatch(body, /secret prompt/);
  assert.doesNotMatch(body, /pong/);
  const s = serve.session("j3-meta")!;
  assert.equal(s.stats.latency?.llmCalls, 1);
  assert.equal(s.stats.usage?.outputTokens, 500);
});
