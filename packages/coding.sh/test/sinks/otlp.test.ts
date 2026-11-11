// The otlp sink's token attributes follow the GenAI gen_ai.usage.* conventions: input_tokens is
// the whole prompt (uncached + cache reads + cache writes), while Usage.inputTokens holds only the
// uncached part. The receiver (src/otel/map.ts) subtracts the cache parts again, so a span that
// leaves the sink comes back as the same Usage.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, Session, Usage } from "../../src/schema/index.ts";
import { type KeyValue, OtlpSink, toOtlpRequest, toOtlpSpans } from "../../src/sinks/otlp.ts";
import { decodeTraceJson } from "../../src/otel/json.ts";
import { mapTraces, TraceSessionMap } from "../../src/otel/map.ts";
import { startReceiver } from "../../src/otel/receiver.ts";
import { MemBlobs, MemIndex } from "../otel/_memstore.ts";

const T0 = 1_800_000_000_000;

function llmCall(id: string, usage: Usage | undefined, payload: Record<string, unknown> = {}): AgentEvent {
  return { id, v: 0, sessionId: "otlp-sink-s1", ts: T0 + 1_000, agent: "claude-code", kind: "llm.call", durationMs: 800, model: "claude-sonnet-4-5", ...(usage ? { usage } : {}), payload: { provider: "anthropic", requestModel: "claude-sonnet-4-5", ok: true, ...payload } } as AgentEvent;
}

function session(usage?: Usage): Session {
  return {
    id: "otlp-sink-s1",
    agent: "claude-code",
    model: "claude-sonnet-4-5",
    startedAt: T0,
    endedAt: T0 + 5_000,
    stats: { events: 3, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, ...(usage ? { usage } : {}) },
    flags: [],
  } as Session;
}

/** The span's attributes as a plain object; ints come back as numbers. */
function attrsOf(list: KeyValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of list) out[key] = "intValue" in value ? Number(value.intValue) : "doubleValue" in value ? value.doubleValue : "stringValue" in value ? value.stringValue : "boolValue" in value ? value.boolValue : value;
  return out;
}

const usageKeys = (a: Record<string, unknown>) => Object.fromEntries(Object.entries(a).filter(([k]) => k.startsWith("gen_ai.usage.") || k.startsWith("coding_sh.usage.") || k === "coding_sh.cost_usd"));

function chatAttrs(e: AgentEvent, mode: "full" | "metadata" = "metadata") {
  const spans = toOtlpSpans([e], [], mode);
  assert.equal(spans.length, 1);
  return attrsOf(spans[0]!.attributes);
}

describe("otlp sink: gen_ai.usage attributes", () => {
  it("input_tokens counts uncached input plus cache reads and writes (golden)", () => {
    const a = chatAttrs(llmCall("e1", { inputTokens: 10, outputTokens: 30, cacheReadTokens: 90, cacheWriteTokens: 20, costUsd: 0.05 }));
    assert.deepEqual(usageKeys(a), {
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
      "gen_ai.usage.cache_read.input_tokens": 90,
      "gen_ai.usage.cache_write.input_tokens": 20,
      "gen_ai.usage.cache_creation.input_tokens": 20,
      "coding_sh.usage.uncached_input_tokens": 10,
      "coding_sh.cost_usd": 0.05,
    });
  });

  it("the queue's example: in 100, cache read 20, cache write 5, out 30", () => {
    const a = chatAttrs(llmCall("e2", { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 30 }));
    assert.equal(a["gen_ai.usage.input_tokens"], 125);
    assert.equal(a["gen_ai.usage.cache_read.input_tokens"], 20);
    assert.equal(a["gen_ai.usage.cache_write.input_tokens"], 5);
    assert.equal(a["gen_ai.usage.output_tokens"], 30);
    assert.equal(a["coding_sh.usage.uncached_input_tokens"], 100);
  });

  it("cache parts alone still give a total; no cache keys when there was no cache", () => {
    const cacheOnly = chatAttrs(llmCall("e3", { cacheReadTokens: 400 }));
    assert.equal(cacheOnly["gen_ai.usage.input_tokens"], 400);
    assert.equal(cacheOnly["coding_sh.usage.uncached_input_tokens"], undefined);
    const plain = chatAttrs(llmCall("e4", { inputTokens: 7, outputTokens: 3 }));
    assert.deepEqual(usageKeys(plain), { "gen_ai.usage.input_tokens": 7, "gen_ai.usage.output_tokens": 3, "coding_sh.usage.uncached_input_tokens": 7 });
  });

  it("output-only usage sends no input_tokens", () => {
    const a = chatAttrs(llmCall("e5", { outputTokens: 12 }));
    assert.deepEqual(usageKeys(a), { "gen_ai.usage.output_tokens": 12 });
  });

  it("an llm.call's reasoningTokens become reasoning.output_tokens", () => {
    assert.equal(chatAttrs(llmCall("e6", { outputTokens: 40 }, { reasoningTokens: 7 }))["gen_ai.usage.reasoning.output_tokens"], 7);
    assert.equal(chatAttrs(llmCall("e7", { outputTokens: 40 }, { reasoningTokens: "7" }))["gen_ai.usage.reasoning.output_tokens"], undefined);
    assert.equal(chatAttrs(llmCall("e8", { outputTokens: 40 }))["gen_ai.usage.reasoning.output_tokens"], undefined);
  });

  it("the assistant.message fallback span uses the same totals", () => {
    const e = { ...llmCall("e9", { inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 20 }), kind: "assistant.message", payload: {} } as AgentEvent;
    const a = chatAttrs(e);
    assert.equal(a["gen_ai.usage.input_tokens"], 120);
    assert.equal(a["gen_ai.usage.cache_write.input_tokens"], 20);
  });

  it("the invoke_agent span applies the same rule to the session's usage", () => {
    const end = { id: "end", v: 0, sessionId: "otlp-sink-s1", ts: T0 + 5_000, agent: "claude-code", kind: "session.end", payload: {} } as AgentEvent;
    const spans = toOtlpSpans([end], [session({ inputTokens: 12_000, outputTokens: 1_500, cacheReadTokens: 8_000, cacheWriteTokens: 2_000, costUsd: 0.42 })], "metadata");
    const a = attrsOf(spans.find((s) => s.name.startsWith("invoke_agent"))!.attributes);
    assert.equal(a["gen_ai.usage.input_tokens"], 22_000);
    assert.equal(a["gen_ai.usage.cache_read.input_tokens"], 8_000);
    assert.equal(a["gen_ai.usage.cache_write.input_tokens"], 2_000);
    assert.equal(a["coding_sh.usage.uncached_input_tokens"], 12_000);
    const none = toOtlpSpans([end], [session()], "metadata");
    assert.deepEqual(usageKeys(attrsOf(none[0]!.attributes)), {});
  });
});

describe("otlp sink → OTLP receiver round-trip", () => {
  const cases: Usage[] = [
    { inputTokens: 10, outputTokens: 30, cacheReadTokens: 90, cacheWriteTokens: 20, costUsd: 0.05 },
    { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 5 },
    { inputTokens: 0, outputTokens: 4, cacheReadTokens: 9_000 },
    { inputTokens: 7, outputTokens: 3 },
    { outputTokens: 12 },
  ];

  it("mapTraces gives the same Usage back", async () => {
    for (const [i, usage] of cases.entries()) {
      const req = JSON.parse(JSON.stringify(toOtlpRequest([llmCall(`rt${i}`, usage)], [], "metadata")));
      const { events } = await mapTraces(decodeTraceJson(req), { maxInlineBytes: 4096, blob: (d) => new MemBlobs().put(d), traceSessions: new TraceSessionMap() });
      const calls = events.filter((e) => e.kind === "llm.call");
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.usage, usage, JSON.stringify(usage));
    }
  });

  it("OtlpSink posts to a live receiver and the stored llm.call keeps its Usage", async () => {
    const store = new MemIndex();
    const blobs = new MemBlobs();
    const errors: Error[] = [];
    const rx = await startReceiver({ port: 0, store, blobs, onError: (e) => void errors.push(e) });
    try {
      const sink = new OtlpSink({ kind: "otlp", name: "otlp", endpoint: rx.url, mode: "metadata" });
      const usage: Usage = { inputTokens: 10, outputTokens: 30, cacheReadTokens: 90, cacheWriteTokens: 20, costUsd: 0.05 };
      const ack = await sink.write([llmCall("live1", usage)], [], blobs);
      assert.equal(ack.ok, true, JSON.stringify(ack));
      const stored = store.all().filter((e) => e.kind === "llm.call");
      assert.equal(stored.length, 1);
      assert.deepEqual(stored[0]!.usage, usage);
      assert.deepEqual(errors, []);
    } finally {
      await rx.close();
    }
  });

  it("sends a model call once when its event is in the batch twice (a helper's events arrive with its parent's call and its own stop)", () => {
    const helper = { ...llmCall("helper-call", { inputTokens: 5, outputTokens: 7 }), sessionId: "otlp-sink-helper" } as AgentEvent;
    const parentCall = llmCall("parent-call", { inputTokens: 10, outputTokens: 20 });
    const sessions = [session(), { ...session(), id: "otlp-sink-helper", parent: { sessionId: "otlp-sink-s1" } } as Session];
    const spans = toOtlpSpans([parentCall, helper, helper, { ...helper }], sessions, "full").filter((s) => s.name.startsWith("chat"));
    assert.equal(spans.length, 2);
    assert.equal(new Set(spans.map((s) => s.spanId)).size, 2);
  });
});
