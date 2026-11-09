import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { decodeLogsJson, decodeTraceJson } from "../../src/otel/json.ts";
import { childSessionId, classifySpan, detectAgent, kebab, type MapContext, mapLogs, mapTraces, spanEventId, SpanTree, TraceSessionMap } from "../../src/otel/map.ts";
import { fixture, iAttr, otlpSpan, otlpTraces, sAttr } from "./_encode.ts";
import { MemBlobs } from "./_memstore.ts";

function ctx(blobs = new MemBlobs(), maxInlineBytes = 4096): MapContext {
  return { maxInlineBytes, blob: (d) => blobs.put(d), traceSessions: new TraceSessionMap() };
}

async function traces(name: string, c = ctx()) {
  return (await mapTraces(decodeTraceJson(fixture(name)), c)).events;
}

const kinds = (events: AgentEvent[]) => events.map((e) => e.kind).sort();
const ofKind = (events: AgentEvent[], kind: string) => events.filter((e) => e.kind === kind);

describe("OTel GenAI semconv", () => {
  it("maps invoke_agent / chat / execute_tool to session, llm.call and tool events", async () => {
    const blobs = new MemBlobs();
    const events = await traces("genai-semconv.json", ctx(blobs));
    assert.deepEqual(kinds(events), [
      "assistant.message",
      "error",
      "llm.call",
      "llm.call",
      "session.end",
      "session.start",
      "tool.end",
      "tool.end",
      "tool.start",
      "tool.start",
      "turn.end",
      "user.message",
    ]);
    const traceId = "5b8efff798038103d269b633813fc60c";
    assert.ok(events.every((e) => e.sessionId === traceId && e.traceId === traceId && e.agent === "weather-bot" && e.agentVersion === "1.4.0"));

    const [chat1, chat2] = ofKind(events, "llm.call").sort((a, b) => a.ts - b.ts);
    assert.equal(chat1!.model, "gpt-4o-2024-08-06");
    // input_tokens 120 includes the 20 cached: inputTokens holds the uncached part.
    assert.deepEqual(chat1!.usage, { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20 });
    assert.equal(chat1!.durationMs, 1000);
    assert.equal(chat1!.payload.provider, "openai");
    assert.equal(chat1!.payload.requestModel, "gpt-4o");
    assert.equal(chat1!.payload.stopReason, "tool_calls");
    assert.equal(chat1!.payload.ok, true);
    assert.equal(chat1!.payload.tokensPerSec, 30);
    assert.equal(chat2!.payload.stopReason, "stop");
    // Parent link: the chat span's parent is the root, whose anchor event is session.start.
    assert.equal(chat1!.parentId, ofKind(events, "session.start")[0]!.id);

    assert.equal(ofKind(events, "assistant.message")[0]!.payload.text, "Sunny, 22°C.");
    assert.equal(ofKind(events, "user.message")[0]!.payload.text, "What's the weather in Paris?");

    const starts = ofKind(events, "tool.start");
    const weather = starts.find((e) => e.payload.tool === "get_weather")!;
    assert.deepEqual(weather.payload.input, { city: "Paris" });
    assert.equal(weather.payload.toolUseId, "call_1");
    const failed = ofKind(events, "tool.end").find((e) => e.payload.tool === "get_forecast")!;
    assert.equal(failed.payload.ok, false);
    assert.equal(failed.payload.error, "upstream timeout");
    const err = ofKind(events, "error")[0]!;
    assert.equal(err.payload.type, "TimeoutError");
    assert.match(String(err.payload.stacktrace), /forecast\.py/);

    // The root's aggregate usage is informational only, never double-counted.
    const turnEnd = ofKind(events, "turn.end")[0]!;
    assert.equal(turnEnd.usage, undefined);
    assert.deepEqual(turnEnd.payload.reportedUsage, { inputTokens: 320, outputTokens: 45 });
    assert.equal(turnEnd.payload.output, "Sunny, 22°C.");

    const session = buildSession(events);
    assert.equal(session.id, traceId);
    assert.equal(session.title, "What's the weather in Paris?");
    assert.deepEqual(session.stats.usage, { inputTokens: 300, outputTokens: 45, cacheReadTokens: 20 });
    assert.equal(session.stats.toolCalls, 2);
    assert.equal(session.stats.toolErrors, 1);
    assert.equal(session.stats.turns, 1);
    assert.equal(session.endedAt, 1767225605000);
    assert.equal(session.stats.latency?.llmCalls, 2);

    // Raw span is blobs[0] and re-normalizable.
    const raw = JSON.parse((await blobs.getText(chat1!.blobs![0]!))!);
    assert.equal(raw.format, "otlp.span");
    assert.equal(raw.span.spanId, chat1!.spanId);
    assert.equal(raw.resource["service.name"], "weather_bot");
  });

  it("groups traces by gen_ai.conversation.id, one turn per trace", async () => {
    const req = fixture("genai-semconv.json");
    const second = structuredClone(req.resourceSpans[0].scopeSpans[0].spans);
    for (const s of second) s.traceId = "6b8efff798038103d269b633813fc60c";
    req.resourceSpans[0].scopeSpans[0].spans.push(...second);
    // Only one span of each trace carries the conversation id.
    for (const s of req.resourceSpans[0].scopeSpans[0].spans.filter((s: any) => !s.parentSpanId)) {
      s.attributes.push({ key: "gen_ai.conversation.id", value: { stringValue: "conv-7" } });
    }
    const events = (await mapTraces(decodeTraceJson(req), ctx())).events;
    assert.ok(events.every((e) => e.sessionId === "conv-7"));
    assert.equal(ofKind(events, "session.end").length, 0);
    assert.equal(ofKind(events, "turn.end").length, 2);
    assert.deepEqual(new Set(events.map((e) => e.turnId)), new Set(["5b8efff798038103d269b633813fc60c", "6b8efff798038103d269b633813fc60c"]));
    const session = buildSession(events);
    assert.equal(session.stats.turns, 2);
    assert.equal(session.stats.usage?.inputTokens, 600);
  });

  it("remembers a trace's conversation across batches", async () => {
    const c = ctx();
    const req = fixture("genai-semconv.json");
    const spans = req.resourceSpans[0].scopeSpans[0].spans;
    const root = spans.pop();
    root.attributes.push({ key: "session.id", value: { stringValue: "chat-1" } });
    const rootOnly = { resourceSpans: [{ ...req.resourceSpans[0], scopeSpans: [{ ...req.resourceSpans[0].scopeSpans[0], spans: [root] }] }] };
    const first = await mapTraces(decodeTraceJson(rootOnly), c);
    const rest = await mapTraces(decodeTraceJson(req), c);
    assert.ok([...first.events, ...rest.events].every((e) => e.sessionId === "chat-1"));
  });

  it("reads legacy gen_ai.prompt/completion span events and flattened attributes", async () => {
    const req = fixture("genai-semconv.json");
    const spans = req.resourceSpans[0].scopeSpans[0].spans;
    const chat = spans.find((s: any) => s.spanId === "aaaaaaaaaaaaaaa3");
    chat.attributes = chat.attributes.filter((a: any) => a.key !== "gen_ai.output.messages");
    chat.events = [{ timeUnixNano: chat.endTimeUnixNano, name: "gen_ai.content.completion", attributes: [{ key: "gen_ai.completion", value: { stringValue: '[{"role":"assistant","content":"legacy answer"}]' } }] }];
    const tool = spans.find((s: any) => s.spanId === "aaaaaaaaaaaaaaa1");
    tool.attributes = [
      { key: "gen_ai.system", value: { stringValue: "openai" } },
      { key: "gen_ai.request.model", value: { stringValue: "gpt-4" } },
      { key: "gen_ai.usage.prompt_tokens", value: { intValue: "11" } },
      { key: "gen_ai.usage.completion_tokens", value: { intValue: "3" } },
      { key: "gen_ai.completion.0.role", value: { stringValue: "assistant" } },
      { key: "gen_ai.completion.0.content", value: { stringValue: "flattened answer" } },
    ];
    const events = (await mapTraces(decodeTraceJson(req), ctx())).events;
    const texts = ofKind(events, "assistant.message").map((e) => e.payload.text).sort();
    assert.deepEqual(texts, ["flattened answer", "legacy answer"]);
    const legacy = ofKind(events, "llm.call").find((e) => e.spanId === "aaaaaaaaaaaaaaa1")!;
    assert.deepEqual(legacy.usage, { inputTokens: 11, outputTokens: 3 });
    assert.equal(legacy.payload.provider, "openai");
  });
});

describe("OpenInference", () => {
  it("maps CHAIN/AGENT/LLM/TOOL spans with flattened messages and session.id", async () => {
    const all = await traces("openinference.json");
    const childId = childSessionId("0af7651916cd43dd8448eb211c80319c", "c000000000000001");
    const events = all.filter((e) => e.sessionId !== childId);
    assert.ok(events.every((e) => e.sessionId === "thread-42"), "session.id on the root applies to the whole trace");
    assert.ok(events.every((e) => e.agent === "langgraph-researcher"));
    assert.equal(ofKind(events, "session.end").length, 0, "conversation sessions don't end with one trace");

    // The researcher's model calls and tool ran inside the AGENT span: they live in its child session.
    assert.equal(ofKind(events, "llm.call").length, 0);
    assert.equal(ofKind(events, "tool.start").length, 0);
    const childEvents = all.filter((e) => e.sessionId === childId);
    const llm = ofKind(childEvents, "llm.call");
    assert.equal(llm.length, 2);
    assert.ok(llm.every((e) => e.model === "gpt-4o-mini" && e.payload.provider === "openai"));
    // prompt 50 includes the 5 cached tokens.
    assert.deepEqual(llm.find((e) => e.spanId === "c000000000000002")!.usage, { inputTokens: 45, outputTokens: 10, cacheReadTokens: 5 });
    // The first call only produced a tool call: no assistant text (the subagent's result is its own reply).
    const answers = ofKind(childEvents, "assistant.message").filter((e) => e.spanId !== "c000000000000001");
    assert.deepEqual(answers.map((e) => e.payload.text), ["README describes coding.sh."]);

    const start = ofKind(childEvents, "tool.start")[0]!;
    assert.equal(start.payload.tool, "read_file");
    assert.deepEqual(start.payload.input, { path: "README.md" });
    assert.equal(start.payload.description, "Read a file");
    assert.equal(ofKind(childEvents, "tool.end")[0]!.payload.output, "# coding.sh\nLocal-first observability.");

    const sub = ofKind(events, "subagent.start")[0]!;
    assert.equal(sub.subagentId, "c000000000000001");
    assert.equal(sub.payload.type, "researcher");
    assert.equal(sub.payload.prompt, "Summarize README.md");
    assert.equal(ofKind(events, "subagent.end")[0]!.payload.result, "README describes coding.sh.");
    // Children of the agent span point at subagent.start.
    assert.ok(llm.every((e) => e.parentId === sub.id));

    assert.equal(ofKind(events, "user.message")[0]!.payload.text, "Summarize README.md");
    const note = ofKind(events, "span")[0]!;
    assert.equal(note.payload.name, "should_continue");
    assert.equal(note.source, "otel-span");
    assert.ok(events.every((e) => e.source === "otel-span"));

    const session = buildSession(events);
    assert.equal(session.title, "Summarize README.md");
    assert.equal(session.stats.latency?.subagents, 1);
    assert.equal(sub.payload.childSessionId, childId);

    // The nested agent span's own session, linked to its parent, holds the subagent's work.
    assert.deepEqual(kinds(childEvents), [
      "assistant.message",
      "assistant.message",
      "llm.call",
      "llm.call",
      "session.end",
      "session.start",
      "tool.end",
      "tool.start",
      "user.message",
    ]);
    assert.ok(childEvents.every((e) => e.subagentId === "c000000000000001" && e.traceId));
    const child = buildSession(childEvents);
    assert.equal(child.stats.toolCalls, 1);
    assert.equal(child.stats.latency?.llmCalls, 2);
    assert.deepEqual(child.stats.usage, { inputTokens: 135, outputTokens: 22, cacheReadTokens: 5 });
    assert.deepEqual(child.parent, { sessionId: "thread-42", eventId: sub.id, subagentId: "c000000000000001", type: "researcher" });
    assert.equal(child.title, "Summarize README.md");
    assert.ok(child.endedAt);
  });
});

describe("llm.call timing", () => {
  const T0 = 1767225600000000000n;
  const llmSpan = (attributes: Record<string, unknown>[], events: Record<string, unknown>[] = []) => ({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
        scopeSpans: [
          {
            scope: { name: "t" },
            spans: [
              {
                traceId: "0102030405060708090a0b0c0d0e0f10",
                spanId: "0000000000000002",
                parentSpanId: "0000000000000001",
                name: "chat gpt-4o",
                startTimeUnixNano: String(T0),
                endTimeUnixNano: String(T0 + 1_500_000_000n),
                attributes: [{ key: "gen_ai.operation.name", value: { stringValue: "chat" } }, ...attributes],
                events,
              },
            ],
          },
        ],
      },
    ],
  });
  const call = async (req: Record<string, unknown>) => ofKind((await mapTraces(decodeTraceJson(req), ctx())).events, "llm.call")[0]!;

  it("sets durationMs = end - start and span ids on the event", async () => {
    const e = await call(llmSpan([]));
    assert.equal(e.durationMs, 1500);
    assert.equal(e.traceId, "0102030405060708090a0b0c0d0e0f10");
    assert.equal(e.spanId, "0000000000000002");
    assert.equal(e.parentSpanId, "0000000000000001");
    assert.equal(e.payload.ttftMs, undefined);
  });

  it("reads ttftMs from ai.response.msToFirstChunk, semconv seconds, or a first-chunk span event", async () => {
    assert.equal((await call(llmSpan([{ key: "ai.response.msToFirstChunk", value: { doubleValue: 212.5 } }]))).payload.ttftMs, 212.5);
    assert.equal((await call(llmSpan([{ key: "gen_ai.response.time_to_first_chunk", value: { doubleValue: 0.34 } }]))).payload.ttftMs, 340);
    const ev = await call(llmSpan([], [{ name: "ai.stream.firstChunk", timeUnixNano: String(T0 + 420_000_000n) }]));
    assert.equal(ev.payload.ttftMs, 420);
    const evAttr = await call(llmSpan([], [{ name: "ai.stream.firstChunk", timeUnixNano: String(T0 + 9n), attributes: [{ key: "ai.response.msToFirstChunk", value: { intValue: "77" } }] }]));
    assert.equal(evAttr.payload.ttftMs, 77);
    const session = buildSession([ev]);
    assert.equal(session.stats.latency?.ttftP50Ms, 420);
    assert.equal(session.stats.latency?.llmP50Ms, 1500);
  });
});

describe("enrichSpan hook", () => {
  it("passes each span and its events; a returned list replaces them, a throw rejects the span", async () => {
    const seen: string[] = [];
    const c = ctx();
    c.enrichSpan = (span, events, info) => {
      seen.push(span.name);
      assert.ok(events.every((e) => e.spanId === span.spanId));
      assert.equal(info.agent, "my-vercel-app");
      if (span.name === "ai.toolCall") throw new Error("nope");
      if (span.name === "ai.generateText") {
        const tag: AgentEvent = { ...events[0]!, id: spanEventId(span.traceId!, span.spanId!, 500), kind: "notification", payload: { type: "eve" } };
        return [...events, tag];
      }
    };
    const r = await mapTraces(decodeTraceJson(fixture("vercel-ai.json")), c);
    assert.equal(seen.length, 4);
    assert.equal(r.rejected, 1);
    assert.match(r.errors[0]!, /nope/);
    assert.equal(r.events.filter((e) => e.payload.type === "eve").length, 1);
    assert.equal(ofKind(r.events, "tool.start").length, 0);
  });
});

describe("Vercel AI SDK", () => {
  it("counts usage from doGenerate spans only and maps ai.toolCall", async () => {
    const events = await traces("vercel-ai.json");
    assert.ok(events.every((e) => e.agent === "my-vercel-app" && e.sessionId === "4bf92f3577b34da6a3ce929d0e0e4736"));
    const llm = ofKind(events, "llm.call");
    assert.equal(llm.length, 2);
    assert.deepEqual(llm.map((e) => e.usage).sort((a, b) => a!.inputTokens! - b!.inputTokens!), [
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 150, outputTokens: 20 },
    ]);
    assert.ok(llm.every((e) => e.model === "gpt-4o-2024-08-06"));
    const tool = ofKind(events, "tool.start")[0]!;
    assert.equal(tool.payload.tool, "listFiles");
    assert.equal(tool.payload.toolUseId, "call_x");
    assert.deepEqual(ofKind(events, "tool.end")[0]!.payload.output, ["a.txt", "b.txt"]);
    assert.equal(ofKind(events, "user.message")[0]!.payload.text, "List files");
    assert.equal(ofKind(events, "assistant.message")[0]!.payload.text, "Done: a.txt, b.txt");
    const session = buildSession(events);
    assert.deepEqual(session.stats.usage, { inputTokens: 250, outputTokens: 40 });
    assert.equal(session.title, "List files");
  });
});

describe("Claude Code", () => {
  it("maps log events (short event.name, string numbers, redacted content)", async () => {
    const events = (await mapLogs(decodeLogsJson(fixture("claude-code-logs.json")), ctx())).events;
    assert.ok(events.every((e) => e.sessionId === "cc-session-1" && e.agent === "claude-code" && e.agentVersion === "2.1.0" && e.turnId === "p1"));
    assert.deepEqual(kinds(events), ["assistant.message", "llm.call", "llm.call", "notification", "tool.end", "tool.end", "tool.start", "tool.start", "user.message"]);
    const [call1] = ofKind(events, "llm.call").sort((a, b) => a.ts - b.ts);
    assert.deepEqual(call1!.usage, { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 100, costUsd: 0.0125 });
    assert.equal(call1!.model, "claude-sonnet-4-5");
    assert.equal(call1!.durationMs, 2300);
    assert.equal(call1!.ts, 1767225603000 - 2300, "llm.call ts is the request start");
    assert.equal(call1!.payload.provider, "anthropic");

    const bash = ofKind(events, "tool.end").find((e) => e.payload.tool === "Bash")!;
    assert.equal(bash.payload.ok, false);
    assert.equal(bash.payload.error, "exit code 1");
    const bashStart = ofKind(events, "tool.start").find((e) => e.payload.tool === "Bash")!;
    assert.equal((bashStart.payload.input as Record<string, unknown>).command, "npm test");
    assert.equal(bashStart.ts, 1767225606000 - 1500);
    assert.equal(ofKind(events, "assistant.message")[0]!.payload.text, undefined, "<REDACTED> is not content");
    assert.equal(ofKind(events, "notification")[0]!.payload.type, "tool_decision");
    assert.ok(events.every((e) => e.source === "otel-log"));

    const session = buildSession(events);
    assert.equal(session.title, "fix the failing test");
    assert.equal(session.stats.toolCalls, 2);
    assert.equal(session.stats.toolErrors, 1);
    assert.equal(session.stats.usage?.inputTokens, 2500);
    assert.ok(Math.abs(session.stats.usage!.costUsd! - 0.02) < 1e-9);
  });

  it("de-duplicates model and tool calls exported as both logs and beta spans", async () => {
    const c = ctx();
    const logs = (await mapLogs(decodeLogsJson(fixture("claude-code-logs.json")), c)).events;
    const spans = (await mapTraces(decodeTraceJson(fixture("claude-code-traces.json")), c)).events;
    const ids = (es: AgentEvent[], kind: string) => new Set(ofKind(es, kind).map((e) => e.id));
    for (const id of ids(spans, "llm.call")) assert.ok(ids(logs, "llm.call").has(id), "llm_request span shares the api_request event id");
    for (const kind of ["tool.start", "tool.end"]) {
      const fromSpans = ofKind(spans, kind).filter((e) => e.payload.tool === "Bash");
      assert.equal(fromSpans.length, 1);
      assert.ok(ids(logs, kind).has(fromSpans[0]!.id));
    }
    assert.ok(ids(logs, "user.message").has(ofKind(spans, "user.message")[0]!.id), "prompt.id joins the interaction span and user_prompt log");

    // What a store would keep: first write wins per id.
    const byId = new Map<string, AgentEvent>();
    for (const e of [...logs, ...spans]) if (!byId.has(e.id)) byId.set(e.id, e);
    const session = buildSession([...byId.values()]);
    assert.equal(session.stats.latency?.llmCalls, 2);
    assert.equal(session.stats.toolCalls, 2);
    assert.equal(session.stats.usage?.inputTokens, 2500);

    const llmSpan = ofKind(spans, "llm.call")[0]!;
    assert.equal(llmSpan.payload.ttftMs, 400);
    assert.equal(llmSpan.payload.stopReason, "tool_use");
    assert.ok(spans.every((e) => e.sessionId === "cc-session-1"));
    assert.equal(classifySpan(decodeTraceJson(fixture("claude-code-traces.json"))[0]!.scopeSpans[0]!.spans[3]!), "other");
  });
});

describe("ids, blobs and agent detection", () => {
  it("event ids are deterministic across runs and encodings", async () => {
    const a = await traces("genai-semconv.json");
    const b = await traces("genai-semconv.json");
    assert.deepEqual(a.map((e) => e.id).sort(), b.map((e) => e.id).sort());
    assert.equal(new Set(a.map((e) => e.id)).size, a.length, "ids are unique");
    const l1 = (await mapLogs(decodeLogsJson(fixture("claude-code-logs.json")), ctx())).events.map((e) => e.id);
    const l2 = (await mapLogs(decodeLogsJson(fixture("claude-code-logs.json")), ctx())).events.map((e) => e.id);
    assert.deepEqual(l1, l2);
  });

  it("moves values over maxInlineBytes to blobs with a preview", async () => {
    const blobs = new MemBlobs();
    const req = fixture("genai-semconv.json");
    const tool = req.resourceSpans[0].scopeSpans[0].spans.find((s: any) => s.spanId === "aaaaaaaaaaaaaaa2");
    const big = "x".repeat(10_000);
    tool.attributes.find((a: any) => a.key === "gen_ai.tool.call.result").value = { stringValue: big };
    tool.attributes.push({ key: "custom.big", value: { stringValue: big } });
    tool.attributes.find((a: any) => a.key === "gen_ai.operation.name").value = { stringValue: "something_else" };
    tool.attributes = tool.attributes.filter((a: any) => a.key !== "gen_ai.tool.name");
    const events = (await mapTraces(decodeTraceJson(req), ctx(blobs, 1024))).events;
    const note = events.find((e) => e.spanId === "aaaaaaaaaaaaaaa2" && e.kind === "span")!;
    const attrs = note.payload.attributes as Record<string, any>;
    assert.equal(attrs["custom.big"].bytes, 10_000);
    assert.equal(await blobs.getText(attrs["custom.big"].blob), big);
    assert.ok(note.blobs!.includes(attrs["custom.big"].blob));
    assert.ok(JSON.stringify(note.payload).length < 4096);

    // A real tool span with a huge result keeps a preview and the full text in a blob.
    const req2 = fixture("genai-semconv.json");
    const t2 = req2.resourceSpans[0].scopeSpans[0].spans.find((s: any) => s.spanId === "aaaaaaaaaaaaaaa2");
    t2.attributes.find((a: any) => a.key === "gen_ai.tool.call.result").value = { stringValue: big };
    const end = (await mapTraces(decodeTraceJson(req2), ctx(blobs, 1024))).events.find((e) => e.kind === "tool.end" && e.spanId === "aaaaaaaaaaaaaaa2")!;
    assert.equal(end.payload.truncated, true);
    assert.ok(String(end.payload.output).length <= 513);
    assert.equal(await blobs.getText(end.payload.outputBlob as string), big);
    assert.equal(end.blobs!.length, 2, "raw span + output");
  });

  it("rejects spans without ids instead of failing the batch", async () => {
    const req = fixture("vercel-ai.json");
    delete req.resourceSpans[0].scopeSpans[0].spans[0].spanId;
    const r = await mapTraces(decodeTraceJson(req), ctx());
    assert.equal(r.rejected, 1);
    assert.match(r.errors[0]!, /no valid traceId\/spanId/);
    assert.ok(r.events.length > 0);
  });

  it("detects agents from service.name, scope and event names", () => {
    assert.equal(detectAgent({ "service.name": "claude-code" }), "claude-code");
    assert.equal(detectAgent({ "service.name": "claude-code-desktop" }), "claude-code");
    assert.equal(detectAgent({ "service.name": "codex_cli_rs" }), "codex");
    assert.equal(detectAgent({ "service.name": "gemini-cli" }), "gemini-cli");
    assert.equal(detectAgent({ "service.name": "unknown_service:node" }), "otel");
    assert.equal(detectAgent({}, undefined, "claude_code.api_request"), "claude-code");
    assert.equal(detectAgent({ "service.name": "My Cool_Agent v2" }), "my-cool-agent-v2");
    assert.equal(kebab("--A__b--"), "a-b");
  });
});

// Usage.inputTokens is the uncached part (adapters/_shared/normalize.ts openaiUsage):
// GenAI semconv, OpenInference and AI SDK report totals that include cached tokens.
describe("token usage: cached input is not counted twice", () => {
  const T = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
  const usageOfSpan = async (attrs: ReturnType<typeof iAttr>[], kind: ReturnType<typeof sAttr>) => {
    const req = otlpTraces("usage-test", [otlpSpan(T, "d000000000000001", "d000000000000000", "llm", [kind, ...attrs], 0, 1000)]);
    return ofKind((await mapTraces(decodeTraceJson(req), ctx())).events, "llm.call")[0]!.usage;
  };
  const genai = sAttr("gen_ai.operation.name", "chat");
  const oi = sAttr("openinference.span.kind", "LLM");
  const ai = sAttr("ai.operationId", "ai.generateText.doGenerate");

  it("OpenInference: prompt 1200 with 1000 cache reads is 200 uncached", async () => {
    const u = await usageOfSpan([iAttr("llm.token_count.prompt", 1200), iAttr("llm.token_count.completion", 40), iAttr("llm.token_count.prompt_details.cache_read", 1000)], oi);
    assert.deepEqual(u, { inputTokens: 200, outputTokens: 40, cacheReadTokens: 1000 });
  });

  it("GenAI semconv: input_tokens minus cache reads and writes", async () => {
    const cases: [number, number, number][] = [
      [500, 400, 100],
      [300, 0, 300],
      [700, 200, 500],
      [900, 800, 100],
    ];
    let inSum = 0;
    let cacheSum = 0;
    for (const [input, cached, expected] of cases) {
      const u = await usageOfSpan([iAttr("gen_ai.usage.input_tokens", input), iAttr("gen_ai.usage.output_tokens", 10), iAttr("gen_ai.usage.cache_read.input_tokens", cached)], genai);
      assert.equal(u?.inputTokens, expected);
      inSum += u!.inputTokens!;
      cacheSum += u!.cacheReadTokens ?? 0;
    }
    assert.deepEqual([inSum, cacheSum], [1000, 1400]);
    const w = await usageOfSpan(
      [iAttr("gen_ai.usage.input_tokens", 1000), iAttr("gen_ai.usage.cache_read.input_tokens", 600), iAttr("gen_ai.usage.cache_creation.input_tokens", 300)],
      genai,
    );
    assert.deepEqual(w, { inputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 300 });
    // Never negative, whatever an exporter sends.
    const clamp = await usageOfSpan([iAttr("gen_ai.usage.input_tokens", 10), iAttr("gen_ai.usage.cache_read.input_tokens", 50)], genai);
    assert.equal(clamp?.inputTokens, 0);
  });

  it("AI SDK: inputTokens minus cachedInputTokens / inputTokenDetails, or noCacheTokens when given", async () => {
    const v5 = await usageOfSpan([iAttr("ai.usage.inputTokens", 800), iAttr("ai.usage.outputTokens", 5), iAttr("ai.usage.cachedInputTokens", 600)], ai);
    assert.deepEqual(v5, { inputTokens: 200, outputTokens: 5, cacheReadTokens: 600 });
    const v6 = await usageOfSpan(
      [iAttr("ai.usage.inputTokens", 800), iAttr("ai.usage.inputTokenDetails.cacheReadTokens", 500), iAttr("ai.usage.inputTokenDetails.cacheWriteTokens", 100)],
      ai,
    );
    assert.deepEqual(v6, { inputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 100 });
    const noCache = await usageOfSpan([iAttr("ai.usage.inputTokens", 800), iAttr("ai.usage.inputTokenDetails.noCacheTokens", 150), iAttr("ai.usage.inputTokenDetails.cacheReadTokens", 650)], ai);
    assert.equal(noCache?.inputTokens, 150);
  });

  it("Claude Code log attributes already exclude cache and are kept as is", async () => {
    const log = {
      resourceLogs: [
        {
          resource: { attributes: [sAttr("service.name", "claude-code")] },
          scopeLogs: [
            {
              scope: { name: "com.anthropic.claude_code.events" },
              logRecords: [
                {
                  timeUnixNano: "1767225600000000000",
                  body: { stringValue: "claude_code.api_request" },
                  attributes: [sAttr("event.name", "api_request"), sAttr("session.id", "cc-1"), iAttr("input_tokens", 15), iAttr("output_tokens", 9), iAttr("cache_read_tokens", 40500)],
                },
              ],
            },
          ],
        },
      ],
    };
    const call = ofKind((await mapLogs(decodeLogsJson(log), ctx())).events, "llm.call")[0]!;
    assert.deepEqual(call.usage, { inputTokens: 15, outputTokens: 9, cacheReadTokens: 40500 });
  });
});

// core/pricing.ts callTier prices a call at batch/flex/priority/fast rates from payload.serviceTier and payload.speed.
describe("service tier on model calls", () => {
  const T = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
  const callOfSpan = async (attrs: ReturnType<typeof sAttr>[]) => {
    const req = otlpTraces("tier-test", [otlpSpan(T, "d100000000000001", "d100000000000000", "chat gpt-6", [sAttr("gen_ai.operation.name", "chat"), iAttr("gen_ai.usage.input_tokens", 10), ...attrs], 0, 1000)]);
    return ofKind((await mapTraces(decodeTraceJson(req), ctx())).events, "llm.call")[0]!;
  };

  it("reads the response's service tier, lowercased", async () => {
    assert.equal((await callOfSpan([sAttr("openai.response.service_tier", "Flex")])).payload.serviceTier, "flex");
    assert.equal((await callOfSpan([sAttr("gen_ai.openai.response.service_tier", "priority")])).payload.serviceTier, "priority");
  });

  it("the tier the response says it ran at beats the one requested; standard tiers are left out", async () => {
    const c = await callOfSpan([sAttr("openai.request.service_tier", "flex"), sAttr("openai.response.service_tier", "default")]);
    assert.equal(c.payload.serviceTier, undefined);
    assert.equal((await callOfSpan([sAttr("gen_ai.openai.request.service_tier", "flex")])).payload.serviceTier, "flex");
    assert.equal((await callOfSpan([])).payload.serviceTier, undefined);
  });

  it("AI SDK provider metadata: OpenAI serviceTier and Anthropic usage.service_tier", async () => {
    const meta = (m: unknown) => sAttr("ai.response.providerMetadata", JSON.stringify(m));
    assert.equal((await callOfSpan([meta({ openai: { serviceTier: "flex" } })])).payload.serviceTier, "flex");
    assert.equal((await callOfSpan([meta({ anthropic: { usage: { service_tier: "batch" } } })])).payload.serviceTier, "batch");
    assert.equal((await callOfSpan([meta({ openai: { serviceTier: "auto" } })])).payload.serviceTier, undefined);
  });

  it("Claude Code api_request logs carry speed for fast mode", async () => {
    const log = {
      resourceLogs: [
        {
          resource: { attributes: [sAttr("service.name", "claude-code")] },
          scopeLogs: [
            {
              scope: { name: "com.anthropic.claude_code.events" },
              logRecords: [
                {
                  timeUnixNano: "1767225600000000000",
                  body: { stringValue: "claude_code.api_request" },
                  attributes: [sAttr("event.name", "api_request"), sAttr("session.id", "cc-2"), sAttr("model", "claude-opus-5-5"), iAttr("input_tokens", 15), sAttr("speed", "fast")],
                },
              ],
            },
          ],
        },
      ],
    };
    const call = ofKind((await mapLogs(decodeLogsJson(log), ctx())).events, "llm.call")[0]!;
    assert.equal(call.payload.speed, "fast");
    assert.equal(call.payload.serviceTier, undefined);
  });

  it("Claude Code api_request logs: the 1-hour cache writes, and the 5m + 1h split as the total when that is all there is", async () => {
    const callOfLog = async (attrs: ReturnType<typeof sAttr>[]) => {
      const log = { resourceLogs: [{ resource: { attributes: [sAttr("service.name", "claude-code")] }, scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords: [{ timeUnixNano: "1767225600000000000", body: { stringValue: "claude_code.api_request" }, attributes: [sAttr("event.name", "api_request"), sAttr("session.id", "cc-3"), sAttr("model", "claude-opus-5-5"), iAttr("input_tokens", 15), ...attrs] }] }] }] };
      return ofKind((await mapLogs(decodeLogsJson(log), ctx())).events, "llm.call")[0]!;
    };
    let c = await callOfLog([iAttr("cache_creation_tokens", 300), iAttr("cache_creation_5m_tokens", 100), iAttr("cache_creation_1h_tokens", 200)]);
    assert.deepEqual([c.usage?.cacheWriteTokens, c.payload.cacheWrite1hTokens], [300, 200]);
    c = await callOfLog([iAttr("cache_creation_5m_tokens", 100), iAttr("cache_creation_1h_tokens", 200)]);
    assert.deepEqual([c.usage?.cacheWriteTokens, c.payload.cacheWrite1hTokens], [300, 200]);
    // Both 0 when the response doesn't report the split.
    c = await callOfLog([iAttr("cache_creation_tokens", 300), iAttr("cache_creation_5m_tokens", 0), iAttr("cache_creation_1h_tokens", 0)]);
    assert.deepEqual([c.usage?.cacheWriteTokens, c.payload.cacheWrite1hTokens], [300, undefined]);
  });

  it("AI SDK Anthropic metadata: the 1-hour cache writes and the inference geography", async () => {
    const meta = sAttr("ai.response.providerMetadata", JSON.stringify({ anthropic: { usage: { cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 90 }, inference_geo: "us" } } }));
    const c = await callOfSpan([meta]);
    assert.deepEqual([c.payload.cacheWrite1hTokens, c.payload.inferenceGeo], [90, "us"]);
  });
});

describe("GenAI semconv nested invoke_agent", () => {
  const T = "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a";
  const ROOT = "e000000000000001";
  const READER = "e000000000000002";
  const WRITER = "e000000000000003";
  const agentSpan = (id: string, parent: string | undefined, name: string, s: number, e: number) =>
    otlpSpan(T, id, parent, `invoke_agent ${name}`, [sAttr("gen_ai.operation.name", "invoke_agent"), sAttr("gen_ai.agent.name", name)], s, e);
  const chat = (id: string, parent: string, input: number, output: number, s: number, e: number) =>
    otlpSpan(
      T,
      id,
      parent,
      "chat gpt-5-mini",
      [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.request.model", "gpt-5-mini"), iAttr("gen_ai.usage.input_tokens", input), iAttr("gen_ai.usage.output_tokens", output)],
      s,
      e,
    );
  const tool = (id: string, parent: string, s: number, e: number) =>
    otlpSpan(T, id, parent, "execute_tool read_file", [sAttr("gen_ai.operation.name", "execute_tool"), sAttr("gen_ai.tool.name", "read_file")], s, e);
  /** orchestrator → reader (chat + read_file) and writer (chat); children listed before their parents, as exporters send them. */
  const conversation = () => [
    chat("e000000000000011", READER, 300, 30, 200, 2000),
    tool("e000000000000012", READER, 2100, 2500),
    chat("e000000000000021", WRITER, 400, 50, 5100, 9000),
    agentSpan(READER, ROOT, "reader", 100, 4900),
    agentSpan(WRITER, ROOT, "writer", 5000, 13900),
    agentSpan(ROOT, undefined, "orchestrator", 0, 14000),
  ];
  const readerSession = childSessionId(T, READER);
  const writerSession = childSessionId(T, WRITER);

  it("credits a subagent's model calls and tools to its child session", async () => {
    const events = (await mapTraces(decodeTraceJson(otlpTraces("orchestrator", conversation())), ctx())).events;
    const reader = events.filter((e) => e.sessionId === readerSession);
    const llm = ofKind(reader, "llm.call");
    assert.equal(llm.length, 1);
    assert.deepEqual(llm[0]!.usage, { inputTokens: 300, outputTokens: 30 });
    assert.ok([...llm, ...ofKind(reader, "tool.start"), ...ofKind(reader, "tool.end")].every((e) => e.subagentId === READER));
    const rs = buildSession(reader);
    assert.equal(rs.stats.toolCalls, 1);
    assert.equal(rs.stats.latency?.llmCalls, 1);
    assert.deepEqual(rs.stats.usage, { inputTokens: 300, outputTokens: 30 });
    assert.equal(rs.parent?.sessionId, T);

    const ws = buildSession(events.filter((e) => e.sessionId === writerSession));
    assert.deepEqual(ws.stats.usage, { inputTokens: 400, outputTokens: 50 });
    assert.equal(ws.stats.toolCalls, 0);

    // The parent keeps the subagent markers but none of their work.
    const parent = events.filter((e) => e.sessionId === T);
    assert.equal(ofKind(parent, "llm.call").length + ofKind(parent, "tool.start").length, 0);
    assert.equal(buildSession(parent).stats.latency?.subagents, 2);
  });

  it("nests a subagent of a subagent under its caller's session", async () => {
    const INNER = "e000000000000031";
    const spans = [chat("e000000000000032", INNER, 100, 10, 300, 600), agentSpan(INNER, READER, "grep", 250, 700), ...conversation()];
    const events = (await mapTraces(decodeTraceJson(otlpTraces("orchestrator", spans)), ctx())).events;
    const innerSession = childSessionId(T, INNER);
    const start = ofKind(events, "subagent.start").find((e) => e.subagentId === INNER)!;
    assert.equal(start.sessionId, readerSession, "the inner subagent was dispatched by the reader");
    const inner = buildSession(events.filter((e) => e.sessionId === innerSession));
    assert.equal(inner.parent?.sessionId, readerSession);
    assert.deepEqual(inner.stats.usage, { inputTokens: 100, outputTokens: 10 });
    assert.equal(ofKind(events.filter((e) => e.sessionId === readerSession), "llm.call").length, 1);
  });

  it("routes descendants that arrive after their subagent span in a later batch (spanTree)", async () => {
    const c = { ...ctx(), spanTree: new SpanTree() };
    const all = conversation();
    const agents = all.filter((s) => s.name.startsWith("invoke_agent"));
    const work = all.filter((s) => !s.name.startsWith("invoke_agent"));
    await mapTraces(decodeTraceJson(otlpTraces("orchestrator", agents)), c);
    const later = (await mapTraces(decodeTraceJson(otlpTraces("orchestrator", work)), c)).events;
    assert.ok(ofKind(later, "llm.call").every((e) => e.sessionId === childSessionId(T, e.parentSpanId!)));
    assert.equal(later.filter((e) => e.sessionId === readerSession && e.kind === "tool.end").length, 1);
  });
});

describe("agent attributes: reasoning, skills, compaction, main agent and subagents", () => {
  it("GenAI semconv: reasoning tokens, skills, compaction and the main agent's name", async () => {
    const events = await traces("genai-semconv-agents.json");
    // gen_ai.main_agent.name names the agent, over service.name.
    assert.ok(events.every((e) => e.agent === "research-assistant"));
    const [first, second] = ofKind(events, "llm.call").sort((a, b) => a.ts - b.ts);
    assert.equal(first!.payload.reasoningTokens, 64);
    assert.equal(first!.payload.compacted, true);
    // A reported cache read of 0 is left out; reasoning is part of the output, not added to usage.
    assert.deepEqual(first!.usage, { inputTokens: 900, outputTokens: 120 });
    assert.equal(second!.payload.reasoningTokens, undefined);
    assert.deepEqual(second!.usage, { inputTokens: 700, outputTokens: 80, cacheReadTokens: 800 });

    const load = ofKind(events, "tool.start").find((e) => e.payload.tool === "load_skill")!;
    assert.equal(load.payload.skill, "pdf-processing");
    assert.equal(load.payload.skillSource, "file:///opt/skills/pdf-processing");
    const run = ofKind(events, "tool.start").find((e) => e.payload.tool === "run_skill_script")!;
    assert.equal(run.payload.skillResource, "scripts/extract.py");
    const runEnd = ofKind(events, "tool.end").find((e) => e.payload.tool === "run_skill_script")!;
    assert.equal(runEnd.payload.exitCode, 2);
    assert.equal(runEnd.payload.ok, false);
    const plain = ofKind(events, "tool.start").find((e) => e.payload.tool === "search")!;
    assert.equal(plain.payload.skill, undefined);
    assert.equal(ofKind(events, "tool.end").find((e) => e.payload.tool === "search")!.payload.exitCode, undefined);

    // Two compacted spans, one context.compact for the session, at the first.
    const compacts = ofKind(events, "context.compact");
    assert.equal(compacts.length, 1);
    assert.equal(compacts[0]!.ts, first!.ts);
    assert.equal(compacts[0]!.payload.source, "gen_ai.conversation.compacted");

    const session = buildSession(events);
    assert.equal(session.agent, "research-assistant");
    assert.ok(session.flags.includes("skill:pdf-processing"), session.flags.join(","));
    assert.ok(session.flags.includes("compaction"));
    // Posting the same spans again in another batch adds the same compaction id.
    const again = await traces("genai-semconv-agents.json");
    assert.equal(ofKind(again, "context.compact")[0]!.id, compacts[0]!.id);
  });

  it("Claude Code logs: skill_activated, compaction details, subagent attribution", async () => {
    const events = (await mapLogs(decodeLogsJson(fixture("claude-code-agents-logs.json")), ctx())).events;
    const loaded = ofKind(events, "notification").filter((e) => e.payload.kind === "harness.loaded");
    // The custom_skill placeholder (OTEL_LOG_TOOL_DETAILS off) names no skill: it stays a plain notification.
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0]!.payload.skills, ["pdf"]);
    assert.equal(loaded[0]!.payload.loadedBy, "invoked_skills");
    assert.equal(loaded[0]!.payload.trigger, "claude-proactive");
    assert.equal(loaded[0]!.payload.scope, "projectSettings");

    const call = ofKind(events, "llm.call")[0]!;
    assert.equal(call.subagentId, "a1b2c3");
    assert.equal(call.payload.parentAgentId, "a0a0a0");
    assert.equal(call.payload.skill, "pdf");
    // Zero cache counts are left out (cost unchanged).
    assert.deepEqual(call.usage, { inputTokens: 12, outputTokens: 40, costUsd: 0.0012 });

    const [auto, manual] = ofKind(events, "context.compact").sort((a, b) => a.ts - b.ts);
    assert.deepEqual(
      { trigger: auto!.payload.trigger, before: auto!.payload.tokensBefore, after: auto!.payload.tokensAfter, ok: auto!.payload.ok, ms: auto!.durationMs },
      { trigger: "auto", before: 155000, after: 21000, ok: true, ms: 4200 },
    );
    assert.equal(manual!.payload.ok, false);
    assert.equal(manual!.payload.error, "summary request failed");

    const session = buildSession(events);
    assert.ok(session.flags.includes("skill:pdf"), session.flags.join(","));
    assert.ok(!session.flags.some((f) => f.includes("custom_skill")));
  });

  it("Claude Code beta spans: agent_id tags the subagent, parent_agent_id is kept", async () => {
    const T = "cc0000000000000000000000000000aa";
    const span = otlpSpan(T, "cc00000000000001", undefined, "claude_code.llm_request", [
      sAttr("span.type", "claude_code.llm_request"),
      sAttr("session.id", "cc-agents-2"),
      sAttr("model", "claude-sonnet-4-5"),
      sAttr("agent_id", "sub-9"),
      sAttr("parent_agent_id", "sub-1"),
      iAttr("input_tokens", 5),
      iAttr("output_tokens", 6),
    ], 0, 500);
    const req = otlpTraces("claude-code", [{ ...span, parentSpanId: "cc00000000000000" }]);
    const call = ofKind((await mapTraces(decodeTraceJson(req), ctx())).events, "llm.call")[0]!;
    assert.equal(call.sessionId, "cc-agents-2");
    assert.equal(call.subagentId, "sub-9");
    assert.equal(call.payload.parentAgentId, "sub-1");
  });

  it("Codex logs: reasoning tokens, skill_invocation, and a subagent's thread linked to its parent", async () => {
    const events = (await mapLogs(decodeLogsJson(fixture("codex-agents-logs.json")), ctx())).events;
    const parent = "019a0000-0000-7000-8000-00000000c0de";
    const child = "019a0000-0000-7000-8000-00000000c1d0";
    const call = ofKind(events, "llm.call")[0]!;
    assert.equal(call.agent, "codex");
    assert.equal(call.payload.reasoningTokens, 192);
    assert.deepEqual(call.usage, { inputTokens: 2400, outputTokens: 300 });

    const skill = ofKind(events, "notification").find((e) => e.payload.kind === "harness.loaded")!;
    assert.deepEqual(skill.payload.skills, ["release-notes"]);
    assert.equal(skill.payload.trigger, "explicit");
    assert.equal(skill.sessionId, parent);

    const replies = ofKind(events, "assistant.message");
    assert.deepEqual(replies.map((e) => [e.sessionId, e.payload.text]).sort(), [
      [parent, "Done: release notes drafted."],
      [child, "The changelog has 3 entries."],
    ]);
    const start = ofKind(events, "session.start");
    assert.equal(start.length, 1, "only the subagent's thread gets a parent link");
    assert.equal(start[0]!.sessionId, child);
    assert.equal(start[0]!.payload.parentSessionId, parent);

    const sub = buildSession(events.filter((e) => e.sessionId === child));
    assert.equal(sub.parent?.sessionId, parent);
    const main = buildSession(events.filter((e) => e.sessionId === parent));
    assert.ok(main.flags.includes("skill:release-notes"), main.flags.join(","));
  });

  it("AI SDK 7: a cache read of 0 is no cacheReadTokens; non-zero values and cost are unchanged", async () => {
    const T = "a5d7a5d7a5d7a5d7a5d7a5d7a5d7a5d7";
    const call = (cacheRead: number) =>
      otlpTraces("ai-sdk-app", [
        otlpSpan(T, cacheRead ? "a5d7000000000002" : "a5d7000000000001", undefined, "ai.streamText.doStream", [
          sAttr("ai.operationId", "ai.streamText.doStream"),
          sAttr("ai.model.id", "claude-sonnet-4-5"),
          sAttr("ai.model.provider", "anthropic.messages"),
          iAttr("ai.usage.inputTokens", 1000),
          iAttr("ai.usage.outputTokens", 50),
          iAttr("ai.usage.inputTokenDetails.noCacheTokens", 1000 - cacheRead),
          iAttr("ai.usage.inputTokenDetails.cacheReadTokens", cacheRead),
          iAttr("ai.usage.inputTokenDetails.cacheWriteTokens", 0),
          iAttr("ai.usage.outputTokenDetails.reasoningTokens", 0),
        ], 0, 1000),
      ]);
    const zero = ofKind((await mapTraces(decodeTraceJson(call(0)), ctx())).events, "llm.call")[0]!;
    assert.deepEqual(zero.usage, { inputTokens: 1000, outputTokens: 50 });
    assert.equal(zero.payload.reasoningTokens, undefined);
    const some = ofKind((await mapTraces(decodeTraceJson(call(400)), ctx())).events, "llm.call")[0]!;
    assert.deepEqual(some.usage, { inputTokens: 600, outputTokens: 50, cacheReadTokens: 400 });
    // Cost: the same as a usage with an explicit 0 cache read.
    const { applyPricing, pricesFor } = await import("../../src/core/pricing.ts");
    const prices = pricesFor();
    const [priced] = applyPricing([zero], prices);
    const [explicit] = applyPricing([{ ...zero, usage: { ...zero.usage, cacheReadTokens: 0, cacheWriteTokens: 0 } }], prices);
    assert.ok(priced!.usage?.costUsd! > 0);
    assert.equal(priced!.usage?.costUsd, explicit!.usage?.costUsd);
  });
});
