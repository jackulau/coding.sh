// aiSdkTracer() in the coding.sh SDK puts the outermost span of an AI SDK call made inside
// trace() under the trace's root or step span, and marks it coding_sh.sdk_parent. That parent
// is sent as native events, never as a span, so the mapper keeps the call a step of the trace's
// turn: not a root, not a subagent, and nothing waits for the parent.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import { decodeTraceJson } from "../../src/otel/json.ts";
import { childSessionId, type MapContext, mapTraces, SpanTree, TraceSessionMap } from "../../src/otel/map.ts";
import { iAttr, otlpSpan, otlpTraces, sAttr } from "./_encode.ts";
import { MemBlobs } from "./_memstore.ts";

const T = "5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d";
/** The trace() span: the SDK sends it as session.start, user.message and turn.end events. */
const NATIVE = "d000000000000001";
const AGENT = "d000000000000002";
const CHAT = "d000000000000003";
const TOOL = "d000000000000004";
const sdkParent = { key: "coding_sh.sdk_parent", value: { boolValue: true } };

function ctx(): MapContext & { spanTree: SpanTree } {
  const blobs = new MemBlobs();
  return { maxInlineBytes: 4096, blob: (d) => blobs.put(d), traceSessions: new TraceSessionMap(), spanTree: new SpanTree() };
}
const map = async (c: MapContext, spans: ReturnType<typeof otlpSpan>[]) => mapTraces(decodeTraceJson(otlpTraces("ai-app", spans)), c);
const ofKind = (events: AgentEvent[], kind: string) => events.filter((e) => e.kind === kind);
const ROOT_KINDS = ["session.start", "user.message", "turn.end", "session.end"];

/** AI SDK 7: invoke_agent with chat and execute_tool under it. */
const prompt = JSON.stringify([{ role: "user", parts: [{ type: "text", content: "a prompt" }] }]);
const agent = (attrs = [sdkParent]) =>
  otlpSpan(T, AGENT, NATIVE, "invoke_agent gpt-4o", [sAttr("gen_ai.operation.name", "invoke_agent"), sAttr("gen_ai.input.messages", prompt), ...attrs], 0, 900);
const chat = () =>
  otlpSpan(
    T,
    CHAT,
    AGENT,
    "chat gpt-4o",
    [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.request.model", "gpt-4o"), sAttr("gen_ai.input.messages", prompt), iAttr("gen_ai.usage.input_tokens", 100), iAttr("gen_ai.usage.output_tokens", 10)],
    100,
    500,
  );
const tool = () => otlpSpan(T, TOOL, AGENT, "execute_tool lookup", [sAttr("gen_ai.operation.name", "execute_tool"), sAttr("gen_ai.tool.name", "lookup")], 600, 800);

describe("a span under a coding.sh SDK trace() (coding_sh.sdk_parent)", () => {
  it("an invoke_agent span is a step of the trace's turn, not a subagent", async () => {
    const c = ctx();
    const { events, rehome } = await map(c, [chat(), tool(), agent()]);
    assert.equal(ofKind(events, "subagent.start").length + ofKind(events, "subagent.end").length, 0);
    assert.ok(
      events.every((e) => e.sessionId === T && e.traceId === T),
      "every event is in the trace's session, none in a child session",
    );
    assert.deepEqual(
      ROOT_KINDS.flatMap((k) => ofKind(events, k)),
      [],
      "the trace's own events say where its turn starts and ends",
    );
    const step = events.find((e) => e.kind === "span" && e.spanId === AGENT);
    assert.equal(step?.parentSpanId, NATIVE, "the step sits under the trace() span");
    assert.equal(ofKind(events, "llm.call")[0]?.parentSpanId, AGENT, "the model call stays under its invoke_agent span");
    assert.equal(ofKind(events, "tool.start")[0]?.parentSpanId, AGENT);
    assert.equal(rehome, undefined);
    assert.equal(c.spanTree.takeWaiting(T, NATIVE), false, "nothing waits for the trace() span");
  });

  it("children exported before their invoke_agent span are not moved when it arrives", async () => {
    const c = ctx();
    const first = await map(c, [chat(), tool()]);
    assert.ok(first.events.every((e) => e.sessionId === T));
    const second = await map(c, [agent()]);
    assert.equal(second.rehome, undefined, "the children stay where they were stored");
    assert.equal(ofKind(second.events, "subagent.start").length, 0);
    assert.ok(second.events.every((e) => e.sessionId !== childSessionId(T, AGENT)));
    assert.equal(c.spanTree.takeWaiting(T, NATIVE), false);
  });

  it("an AI SDK 6 call is a model call of the trace, and nothing waits for the trace() span", async () => {
    const c = ctx();
    const WRAP = "d000000000000011";
    const GEN = "d000000000000012";
    const model = [sAttr("ai.model.id", "gpt-4o"), sAttr("ai.model.provider", "openai.chat")];
    const { events } = await map(c, [
      otlpSpan(T, GEN, WRAP, "ai.generateText.doGenerate", [...model, sAttr("ai.operationId", "ai.generateText.doGenerate"), iAttr("ai.usage.inputTokens", 100), iAttr("ai.usage.outputTokens", 10)], 100, 500),
      otlpSpan(T, WRAP, NATIVE, "ai.generateText", [...model, sAttr("ai.operationId", "ai.generateText"), sAttr("ai.prompt", JSON.stringify({ prompt: "a prompt" })), sdkParent], 0, 600),
    ]);
    assert.deepEqual(ROOT_KINDS.flatMap((k) => ofKind(events, k)), []);
    const calls = ofKind(events, "llm.call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.usage?.inputTokens, 100);
    assert.equal(c.spanTree.takeWaiting(T, NATIVE), false);
  });

  it("without the attribute, a span whose parent has not arrived waits for it, and an invoke_agent span under it is a subagent", async () => {
    const c = ctx();
    const { events } = await map(c, [chat(), agent([])]);
    assert.equal(ofKind(events, "subagent.start").length, 1);
    assert.equal(ofKind(events, "llm.call")[0]?.sessionId, childSessionId(T, AGENT));
    assert.equal(c.spanTree.takeWaiting(T, NATIVE), true);
  });

  it("the attribute on a span with no parent changes nothing: it is a root", async () => {
    const c = ctx();
    const root = otlpSpan(T, AGENT, undefined, "invoke_agent gpt-4o", [sAttr("gen_ai.operation.name", "invoke_agent"), sAttr("gen_ai.input.messages", prompt), sdkParent], 0, 900);
    const { events } = await map(c, [chat(), root]);
    assert.equal(ofKind(events, "session.start").length, 1);
    assert.equal(ofKind(events, "turn.end").length, 1);
    assert.deepEqual(
      ofKind(events, "user.message").map((e) => e.payload.text),
      ["a prompt"],
    );
  });
});
