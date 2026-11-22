// AI SDK calls inside trace() are steps of that trace's one turn, as trace()'s
// doc comment says. The spans go to a coding.sh server run from source
// (src/server/serve.ts) with a temp home, and the test reads the session back
// from its store. The spans are AI SDK-shaped fakes, so no model runs: AI SDK 6
// nests through startActiveSpan, AI SDK 7 through the context argument
// (trace.setSpan contexts).
// The server imports the viewer page as a module; this declares it for this package's typecheck.
/// <reference path="../../coding.sh/src/viewer/ui/html.d.ts" />
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AgentEvent, Session } from "../../coding.sh/src/schema/index.ts";
import { resolveServeConfig } from "../../coding.sh/src/server/config.ts";
import { createLogger } from "../../coding.sh/src/server/log.ts";
import { type ServeHandle, startServe } from "../../coding.sh/src/server/serve.ts";
import { type AiSdkTracer, aiSdkTracer, flush, init, span, trace, withSession } from "../src/index.ts";
import { _reset } from "../src/client.ts";

const SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");

let dir: string;
let h: ServeHandle;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "csh-sdk-turns-"));
  const env = { HOME: join(dir, "home"), CODING_SH_HOME: join(dir, "data") };
  h = await startServe(resolveServeConfig({ port: 0 }, env), { log: createLogger({ format: "json", write: () => {} }), enrichSpan: false, alerts: false });
});
after(async () => {
  await h.shutdown();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
beforeEach(() => {
  _reset();
  init({ url: h.url, flushIntervalMs: 10, service: "ai-app" });
});

/** One AI SDK 6 generateText: ai.generateText around ai.generateText.doGenerate, nested by startActiveSpan. */
async function v6Call(tracer: AiSdkTracer, prompt: string, inputTokens: number): Promise<void> {
  const model = { "ai.model.id": "gpt-4o", "ai.model.provider": "openai.chat" };
  await tracer.startActiveSpan("ai.generateText", { attributes: { ...model, "ai.operationId": "ai.generateText", "ai.prompt": JSON.stringify({ prompt }) } }, async (outer) => {
    await tracer.startActiveSpan(
      "ai.generateText.doGenerate",
      { attributes: { ...model, "ai.operationId": "ai.generateText.doGenerate", "ai.prompt.messages": JSON.stringify([{ role: "user", content: [{ type: "text", text: prompt }] }]) } },
      async (inner) => {
        inner.setAttributes({ "ai.response.text": "done", "ai.usage.inputTokens": inputTokens, "ai.usage.outputTokens": 10 });
        inner.end();
      },
    );
    outer.setAttributes({ "ai.response.text": "done", "ai.usage.inputTokens": inputTokens, "ai.usage.outputTokens": 10 });
    outer.end();
  });
}

/** One AI SDK 7 call: invoke_agent (no context) > chat and execute_tool, each started with the parent's context. */
function v7Call(tracer: AiSdkTracer, prompt: string, inputTokens: number): void {
  const within = (s: { spanContext(): unknown }) => ({ getValue: (k: symbol) => (k === SPAN_KEY ? s : undefined) });
  const agent = tracer.startSpan("invoke_agent gpt-4o", { attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: prompt }] }]) } });
  const chat = tracer.startSpan("chat gpt-4o", { attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4o", "gen_ai.provider.name": "openai" } }, within(agent));
  chat.setAttributes({ "gen_ai.usage.input_tokens": inputTokens, "gen_ai.usage.output_tokens": 10, "gen_ai.response.model": "gpt-4o" });
  chat.end();
  const tool = tracer.startSpan("execute_tool lookup", { attributes: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "lookup" } }, within(agent));
  tool.end();
  agent.end();
}

const session = (id: string): Promise<Session | undefined> => h.index.getSession(id);
const events = (id: string): Promise<AgentEvent[]> => h.index.listEvents(id, { limit: 1000 });
const kinds = (evs: AgentEvent[], kind: string) => evs.filter((e) => e.kind === kind);

describe("AI SDK calls inside trace() are steps of its one turn", () => {
  it("two AI SDK 6 calls: one turn, both calls priced inside it, the trace's input its only prompt", async () => {
    const tracer = aiSdkTracer();
    const sid = await trace(
      "job",
      async (t) => {
        await v6Call(tracer, "first prompt", 1000);
        await v6Call(tracer, "second prompt", 2000);
        return t.sessionId;
      },
      { input: "do the job" },
    );
    await flush();
    const s = await session(sid);
    assert.ok(s, "the trace's session is stored");
    const evs = await events(sid);
    const calls = kinds(evs, "llm.call");
    assert.equal(calls.length, 2, "both model calls are in the trace's session");
    assert.deepEqual(calls.map((e) => e.usage?.inputTokens).sort(), [1000, 2000]);
    for (const c of calls) {
      assert.equal(c.usage?.outputTokens, 10);
      assert.ok((c.usage?.costUsd ?? 0) > 0, `the call is priced: ${JSON.stringify(c.usage)}`);
    }
    assert.equal(s.stats.turns, 1, `one turn, not one per AI SDK call: ${kinds(evs, "turn.end").length} turn.end events`);
    assert.deepEqual(
      kinds(evs, "user.message").map((e) => e.payload.text),
      ["do the job"],
      "the trace's input is the turn's only user message",
    );
    assert.equal(kinds(evs, "session.start").length, 1);
    assert.deepEqual(new Set(evs.map((e) => e.traceId)), new Set([sid]), "every event is in the trace's own trace");
    assert.equal(s.stats.latency?.llmCalls, 2);
    assert.equal(s.stats.usage?.inputTokens, 3000);
    // The AI SDK's own nesting holds: each doGenerate sits under its ai.generateText span, and that span under the trace.
    const root = kinds(evs, "session.start")[0]!.spanId;
    const wrappers = evs.filter((e) => e.kind === "span" && e.payload.name === "ai.generateText");
    assert.equal(wrappers.length, 2);
    for (const w of wrappers) assert.equal(w.parentSpanId, root);
    assert.deepEqual(new Set(calls.map((c) => c.parentSpanId)), new Set(wrappers.map((w) => w.spanId)));
  });

  it("two AI SDK 7 calls: one turn, invoke_agent stays a step (no subagent), its children stay under it", async () => {
    const tracer = aiSdkTracer();
    const sid = await trace(
      "job",
      async (t) => {
        v7Call(tracer, "first prompt", 1000);
        await Promise.resolve();
        v7Call(tracer, "second prompt", 2000);
        return t.sessionId;
      },
      { input: "do the job" },
    );
    await flush();
    const s = (await session(sid))!;
    const evs = await events(sid);
    assert.equal(s.stats.turns, 1);
    assert.equal(kinds(evs, "llm.call").length, 2);
    assert.equal(kinds(evs, "tool.start").length, 2);
    assert.deepEqual(kinds(evs, "user.message").map((e) => e.payload.text), ["do the job"]);
    assert.equal(kinds(evs, "subagent.start").length, 0, "a joined invoke_agent span is not a subagent");
    assert.equal(s.stats.latency?.subagents, undefined);
    const root = kinds(evs, "session.start")[0]!.spanId;
    const agents = evs.filter((e) => e.kind === "span" && e.payload.name === "invoke_agent gpt-4o");
    assert.equal(agents.length, 2);
    for (const a of agents) assert.equal(a.parentSpanId, root);
    for (const e of [...kinds(evs, "llm.call"), ...kinds(evs, "tool.start")]) assert.ok(agents.some((a) => a.spanId === e.parentSpanId), `${e.kind} sits under its invoke_agent span`);
    assert.deepEqual(
      (await h.index.listSessions()).map((x) => x.id).filter((id) => id.startsWith("otel-sub-")),
      [],
      "no child session",
    );
  });

  it("a trace with a sessionId: the calls join that conversation's turn", async () => {
    const tracer = aiSdkTracer();
    let traceId = "";
    await trace(
      "job",
      async (t) => {
        traceId = t.traceId;
        await v6Call(tracer, "first prompt", 1000);
        await v6Call(tracer, "second prompt", 1000);
      },
      { sessionId: "conv-turns", input: "turn one" },
    );
    await flush();
    const s = (await session("conv-turns"))!;
    const evs = await events("conv-turns");
    assert.equal(s.stats.turns, 1);
    assert.equal(kinds(evs, "llm.call").length, 2);
    for (const e of kinds(evs, "llm.call")) assert.equal(e.turnId, traceId, "the calls carry the turn's id");
    assert.deepEqual(kinds(evs, "user.message").map((e) => e.payload.text), ["turn one"]);
  });

  it("a trace nested in a trace is a step, and its calls join the outer turn", async () => {
    const tracer = aiSdkTracer();
    const sid = await trace(
      "outer",
      async (t) => {
        await trace("inner", () => v6Call(tracer, "inner prompt", 1000));
        await span("step", "plain step", () => v6Call(tracer, "step prompt", 1000));
        return t.sessionId;
      },
      { input: "outer job" },
    );
    await flush();
    const s = (await session(sid))!;
    const evs = await events(sid);
    assert.equal(s.stats.turns, 1);
    assert.equal(kinds(evs, "llm.call").length, 2);
    const steps = evs.filter((e) => e.kind === "span" && (e.payload.name === "inner" || e.payload.name === "plain step"));
    assert.equal(steps.length, 2);
    const wrappers = evs.filter((e) => e.kind === "span" && e.payload.name === "ai.generateText");
    assert.deepEqual(new Set(wrappers.map((w) => w.parentSpanId)), new Set(steps.map((x) => x.spanId)), "each call sits under its step");
  });
});

describe("AI SDK calls outside trace() keep a turn each", () => {
  it("a call outside any trace is its own session and turn", async () => {
    await v6Call(aiSdkTracer(), "lonely prompt", 1000);
    await flush();
    const own = (await h.index.listSessions()).filter((x) => x.title === "lonely prompt");
    assert.equal(own.length, 1);
    assert.equal(own[0]!.stats.turns, 1);
    assert.equal(own[0]!.stats.latency?.llmCalls, 1);
  });

  it("inside withSession() alone, each call is a turn of that session", async () => {
    const tracer = aiSdkTracer();
    await withSession("ws-turns", async () => {
      await v6Call(tracer, "first prompt", 1000);
      await v6Call(tracer, "second prompt", 1000);
    });
    await flush();
    const s = (await session("ws-turns"))!;
    assert.equal(s.stats.turns, 2);
    assert.equal(s.stats.latency?.llmCalls, 2);
    assert.deepEqual(kinds(await events("ws-turns"), "user.message").map((e) => e.payload.text).sort(), ["first prompt", "second prompt"]);
  });

  it("aiSdkTracer({ sessionId }) naming another session keeps a turn per call there", async () => {
    const tracer = aiSdkTracer({ sessionId: "elsewhere-turns" });
    const sid = await trace("job", async (t) => {
      await v6Call(tracer, "routed prompt", 1000);
      return t.sessionId;
    });
    await flush();
    const s = (await session("elsewhere-turns"))!;
    assert.equal(s.stats.turns, 1);
    assert.equal(s.stats.latency?.llmCalls, 1);
    assert.equal(kinds(await events(sid), "llm.call").length, 0, "the call is not in the trace's session");
  });
});
