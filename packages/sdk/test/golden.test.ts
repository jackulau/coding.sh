// Golden parity (docs/PRODUCTION.md §4): the same mock conversation sent
// through the SDK and through OTel (gen_ai semconv spans, mapped by the core
// package's real OTLP mapper) must build equal Session.stats.
//
// The OTel side is what a GenAI OTel instrumentation would emit for the very
// same calls: one span per SDK span, with the SDK's own timestamps, model,
// usage, ttft and texts as gen_ai.* attributes. The SDK clock is set to whole
// milliseconds so both paths see identical times.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent } from "../../coding.sh/src/schema/index.ts";
import { mapTraces } from "../../coding.sh/src/otel/map.ts";
import type { ResourceSpans, OtelSpan, Attrs } from "../../coding.sh/src/otel/model.ts";
import { buildSession } from "../../coding.sh/src/core/sessions.ts";
import { flush, init, observe, span, trace, withSession } from "../src/index.ts";
import { _setClock } from "../src/util.ts";
import { type FakeServe, startFakeServe } from "./helpers/fake-serve.ts";
import { type MockLlm, startMockLlm } from "./helpers/mock-llm.ts";

let llm: MockLlm;
let serve: FakeServe;

before(async () => {
  llm = await startMockLlm({ delayMs: 3 });
  serve = await startFakeServe();
  _setClock(() => Date.now());
  init({ url: serve.url, flushIntervalMs: 10, service: "golden-app" });
});
after(async () => {
  assert.deepEqual(serve.rejected, [], "the real server parser accepts every SDK event");
  _setClock(undefined);
  await llm.close();
  await serve.close();
});

const ns = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();
const msgs = (role: string, text: string) => JSON.stringify([{ role, parts: [{ type: "text", content: text }] }]);

/** Rebuilds the OTel spans an instrumentation would have exported for these SDK events. */
function toOtlp(events: AgentEvent[], conversation: string | undefined): ResourceSpans[] {
  const bySpan = new Map<string, AgentEvent[]>();
  for (const e of events) {
    const list = bySpan.get(e.spanId!) ?? [];
    list.push(e);
    bySpan.set(e.spanId!, list);
  }
  const spans: OtelSpan[] = [];
  for (const [spanId, evs] of bySpan) {
    const k = (kind: string) => evs.find((e) => e.kind === kind);
    const first = evs[0]!;
    const a: Attrs = {};
    let start: number;
    let end: number;
    let name: string;
    const llmCall = k("llm.call");
    if (llmCall) {
      const p = llmCall.payload;
      Object.assign(a, {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": p.provider as string,
        "gen_ai.request.model": p.requestModel as string,
        "gen_ai.response.model": p.responseModel as string,
        "gen_ai.usage.input_tokens": (llmCall.usage?.inputTokens ?? 0) + (llmCall.usage?.cacheReadTokens ?? 0),
        "gen_ai.usage.output_tokens": llmCall.usage?.outputTokens ?? 0,
        "gen_ai.response.finish_reasons": [p.stopReason as string],
      });
      if (typeof p.ttftMs === "number") a["gen_ai.response.time_to_first_chunk"] = p.ttftMs / 1000;
      const reply = k("assistant.message");
      if (reply) a["gen_ai.output.messages"] = msgs("assistant", reply.payload.text as string);
      start = llmCall.ts;
      end = llmCall.ts + llmCall.durationMs!;
      name = `chat ${p.requestModel}`;
    } else if (k("tool.start")) {
      const s = k("tool.start")!;
      const e = k("tool.end")!;
      Object.assign(a, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": s.payload.tool as string, "gen_ai.tool.call.id": s.payload.toolUseId as string });
      start = s.ts;
      end = e.ts;
      name = `execute_tool ${s.payload.tool}`;
    } else if (k("span")) {
      const s = k("span")!;
      start = s.ts;
      end = s.ts + s.durationMs!;
      name = s.payload.name as string;
    } else {
      start = k("session.start")!.ts;
      end = k("turn.end")!.ts;
      name = k("session.start")!.payload.name as string;
    }
    if (k("session.start")) {
      start = k("session.start")!.ts;
      end = k("turn.end")!.ts;
      if (conversation) a["gen_ai.conversation.id"] = conversation;
      const prompt = k("user.message");
      if (prompt) a["gen_ai.input.messages"] = msgs("user", prompt.payload.text as string);
    }
    spans.push({
      traceId: first.traceId!,
      spanId,
      ...(first.parentSpanId ? { parentSpanId: first.parentSpanId } : {}),
      name,
      kind: 1,
      startTimeUnixNano: ns(start),
      endTimeUnixNano: ns(end),
      attributes: a,
      events: [],
      links: [],
      status: { code: 0 },
    });
  }
  return [{ resource: { attributes: { "service.name": "golden-app" } }, scopeSpans: [{ scope: { name: "genai", attributes: {} }, spans }] }];
}

async function viaOtel(events: AgentEvent[], conversation: string | undefined) {
  const r = await mapTraces(toOtlp(events, conversation), { maxInlineBytes: 1 << 20, blob: async () => "0".repeat(64), keepRaw: false });
  assert.equal(r.rejected, 0, r.errors.join("; "));
  return r.events;
}

test("a multi-turn conversation: SDK and OTel build equal Session.stats", async () => {
  const openai = observe(new OpenAI({ apiKey: "mock", baseURL: `${llm.url}/v1`, maxRetries: 0 }));
  const anthropic = observe(new Anthropic({ apiKey: "mock", baseURL: llm.url, maxRetries: 0 }));
  await trace(
    "turn 1",
    async () => {
      await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "where is order 42" }] });
      await span("tool", "lookup_order", async () => ({ status: "shipped" }), { input: { id: "42" } });
      const stream = await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "summarize" }], stream: true });
      for await (const _ of stream) void _;
      await span("step", "rank", async () => 1);
    },
    { sessionId: "golden", input: "where is order 42" },
  );
  // turn 2: an untraced call in the same conversation
  await withSession("golden", () => anthropic.messages.create({ model: "mock-claude", max_tokens: 16, messages: [{ role: "user", content: "thanks" }] }));
  await flush();

  const sdk = serve.events().filter((e) => e.sessionId === "golden");
  const otel = await viaOtel(sdk, "golden");
  const a = buildSession(sdk);
  const b = buildSession(otel);
  assert.deepEqual(a.stats, b.stats);
  // and the shape is what we expect
  assert.equal(a.stats.turns, 2);
  assert.equal(a.stats.toolCalls, 1);
  assert.equal(a.stats.latency?.llmCalls, 3);
  assert.deepEqual(a.stats.usage, { inputTokens: 3000, outputTokens: 1500 });
  assert.equal(a.stats.events, b.stats.events);
  assert.equal(a.title, b.title);
});

test("a one-call trace (session = trace) matches too, including session.end", async () => {
  const openai = observe(new OpenAI({ apiKey: "mock", baseURL: `${llm.url}/v1`, maxRetries: 0 }));
  const sid = await trace("solo", async (t) => {
    await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "ping" }] });
    return t.sessionId;
  }, { input: "ping" });
  // and an untraced root call (its own session)
  const before = new Set(serve.events().map((e) => e.sessionId));
  await openai.chat.completions.create({ model: "mock-gpt", messages: [{ role: "user", content: "pong?" }] });
  await flush();
  const rootSid = serve.events().find((e) => !before.has(e.sessionId))!.sessionId;

  for (const id of [sid, rootSid]) {
    const sdk = serve.events().filter((e) => e.sessionId === id);
    const otel = await viaOtel(sdk, undefined);
    assert.equal(otel[0]!.sessionId, id, "OTel session = trace id = SDK session id");
    const a = buildSession(sdk);
    const b = buildSession(otel);
    assert.deepEqual(a.stats, b.stats, id);
    assert.equal(a.endedAt, b.endedAt);
    assert.ok(sdk.some((e) => e.kind === "session.end"));
  }
});
