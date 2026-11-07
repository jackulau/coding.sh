import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Hex } from "../../../src/core/ids.ts";
import { buildSession } from "../../../src/core/sessions.ts";
import { decodeTraceJson } from "../../../src/otel/json.ts";
import { mapTraces, type MapContext, type SpanEnricher, TraceSessionMap } from "../../../src/otel/map.ts";
import type { OtelSpan, ResourceSpans } from "../../../src/otel/model.ts";
import type { AgentEvent } from "../../../src/schema/index.ts";
import { enrichFromEve, EVE_AGENT_ID, eveSessionId, isEveSpan, isWorkflowInfraSpan } from "../../../src/integrations/eve/index.ts";
import { bySession, CHILD_A0, CHILD_A1, ofKind, OTLP_EXPORT, readJson, ROOT_A, ROOT_B } from "./helpers.ts";

// The hook contract src/otel exposes: enrichFromEve plugs in as-is.
const hook: SpanEnricher = enrichFromEve;

function ctx(enrich: SpanEnricher | null): MapContext {
  const c: MapContext = { maxInlineBytes: 16 * 1024, blob: async (d) => sha256Hex(d), keepRaw: false, traceSessions: new TraceSessionMap() };
  if (enrich) c.enrichSpan = enrich;
  return c;
}

/** The OTLP/JSON request bodies eve's exporter POSTed, in order (as the receiver would see them). */
function exportBatches(): ResourceSpans[][] {
  return (readJson(OTLP_EXPORT) as unknown[]).map((body) => decodeTraceJson(body));
}

async function mapAll(enrich: SpanEnricher | null = hook): Promise<AgentEvent[]> {
  const c = ctx(enrich);
  const out: AgentEvent[] = [];
  for (const batch of exportBatches()) {
    const r = await mapTraces(batch, c);
    assert.deepEqual(r.errors, []);
    out.push(...r.events);
  }
  return out;
}

const span = (attributes: Record<string, unknown>, name = "x"): OtelSpan => ({
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  name,
  kind: 1,
  startTimeUnixNano: "1000000000",
  endTimeUnixNano: "2000000000",
  attributes: attributes as OtelSpan["attributes"],
  events: [],
  links: [],
  status: { code: 0 },
});

describe("eve span classification", () => {
  it("recognizes eve spans by scope or by attributes", () => {
    assert.equal(isEveSpan(span({}), { name: "eve.agent" }), true);
    assert.equal(isEveSpan(span({ "agent.framework.name": "eve" })), true);
    assert.equal(isEveSpan(span({ "agent.trace.schema.version": 4, "agent.run.id": "wrun_1" })), true);
    assert.equal(isEveSpan(span({ "gen_ai.operation.name": "chat" })), false);
    assert.equal(eveSessionId(span({ "agent.run.id": "wrun_1" })), "wrun_1");
  });

  it("drops Workflow SDK infrastructure spans unless asked to keep them", () => {
    const wf = span({ "workflow.run.id": "x" }, "workflow.stream.read");
    const evs: AgentEvent[] = [{ id: "1", v: 0, sessionId: "t", ts: 1, agent: "unknown", kind: "notification", payload: {} }];
    assert.equal(isWorkflowInfraSpan(wf, { name: "workflow" }), true);
    assert.deepEqual(enrichFromEve(wf, evs, { scope: { name: "workflow" } }), []);
    assert.equal(enrichFromEve(wf, evs, {}, { keepWorkflowSpans: true }), evs);
  });

  it("passes other frameworks' spans through untouched", () => {
    const other = span({ "gen_ai.operation.name": "chat" }, "chat gpt");
    const evs: AgentEvent[] = [{ id: "1", v: 0, sessionId: "t", ts: 1, agent: "unknown", kind: "llm.call", payload: {} }];
    assert.equal(enrichFromEve(other, evs, { scope: { name: "ai" } }), evs);
  });
});

describe("enrichFromEve over a real eve OTLP export", async () => {
  const events = await mapAll();
  const sessions = bySession(events);

  it("keys sessions on agent.run.id and drops the workflow spans", async () => {
    assert.deepEqual([...sessions.keys()].sort(), [ROOT_A, CHILD_A0, CHILD_A1, ROOT_B].sort());
    assert.ok(events.every((e) => e.agent === EVE_AGENT_ID));
    // agent.framework.version is on activation, step and tool spans (not on chat spans).
    assert.ok(ofKind(events, "session.start").every((e) => e.agentVersion === "1.0.0-rc.6"));
    // Without the hook, workflow spans become junk sessions keyed by trace id,
    // and both turns of a forecaster child collapse into synthetic otel-sub-* sessions.
    const plain = [...bySession(await mapAll(null)).keys()];
    assert.ok(plain.some((s) => /^[0-9a-f]{32}$/.test(s)));
    assert.ok(plain.some((s) => s.startsWith("otel-sub-")));
  });

  it("emits one session.start per eve session, even across turns", () => {
    for (const [sid, evs] of sessions) assert.equal(ofKind(evs, "session.start").length, 1, sid);
    const root = sessions.get(ROOT_A)!;
    assert.equal(ofKind(root, "turn.end").length, 2);
    assert.deepEqual(
      ofKind(root, "user.message").map((e) => e.payload.text),
      ["What is the weather in Paris?", "And the weather in London?"],
    );
    assert.deepEqual(
      ofKind(root, "turn.end").map((e) => e.payload.output),
      ["Paris: Sunny, 21°C. Outlook: staying clear through tomorrow.", "London: Rain, 14°C. Outlook: showers easing by evening."],
    );
    assert.equal(ofKind(root, "session.end").length, 0, "an eve session stays open after a turn");
  });

  it("maps subagent calls to subagent.start/end and links child sessions to the parent", () => {
    const root = sessions.get(ROOT_A)!;
    const starts = ofKind(root, "subagent.start");
    const ends = ofKind(root, "subagent.end");
    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2);
    assert.ok(starts.every((e) => e.payload.type === "forecaster"));
    assert.match(String(starts[0]!.payload.prompt), /^Outlook for Paris\./);
    assert.deepEqual(
      ends.map((e) => [e.payload.ok, e.payload.result]),
      [
        [true, "staying clear through tomorrow."],
        [true, "showers easing by evening."],
      ],
    );
    assert.deepEqual(ends[0]!.payload.reportedUsage, { inputTokens: 137, outputTokens: 8 });

    for (const [child, start] of [
      [CHILD_A0, starts[0]!],
      [CHILD_A1, starts[1]!],
    ] as const) {
      const s = buildSession(sessions.get(child)!);
      assert.equal(s.parent?.sessionId, ROOT_A);
      assert.equal(s.parent?.type, "forecaster");
      assert.equal(s.parent?.subagentId, start.payload.subagentId);
      // parentEventId points at the parent's execute_tool span (its tool.start).
      const parentEvent = root.find((e) => e.id === s.parent?.eventId);
      assert.equal(parentEvent?.kind, "tool.start");
      assert.equal(parentEvent?.payload.tool, "forecaster");
      assert.equal(ofKind(sessions.get(child)!, "user.message")[0]?.payload.text, start.payload.prompt);
    }
  });

  it("maps model calls to llm.call with latency, model and usage", () => {
    const calls = ofKind(events, "llm.call");
    assert.equal(calls.length, 4 * 2 + 1 + 1 + 2); // root A: 4 per turn; each child: 1; root B: 2
    for (const c of calls) {
      assert.equal(typeof c.durationMs, "number");
      assert.ok(c.usage && c.usage.inputTokens! > 0 && c.usage.outputTokens! > 0, c.id);
      assert.equal(c.payload.provider, "eve-mock");
      assert.ok(c.turnId, "llm.call belongs to a turn");
    }
    // Turn/step totals are reported, never summed into usage (no double counting).
    const usageEvents = events.filter((e) => e.usage);
    assert.ok(usageEvents.every((e) => e.kind === "llm.call"));
    const root = sessions.get(ROOT_A)!;
    const total = ofKind(root, "llm.call").reduce((n, e) => n + e.usage!.inputTokens!, 0);
    const reported = ofKind(root, "turn.end").reduce((n, e) => n + (e.payload.reportedUsage as { inputTokens: number }).inputTokens, 0);
    // eve's turn total covers the turn's own model calls; the child sessions own the forecaster's tokens.
    assert.equal(reported, total);
  });

  it("maps tools with latency and marks a failed tool", () => {
    const weather = ofKind(events, "tool.end").filter((e) => e.payload.tool === "get_weather");
    assert.equal(weather.length, 3);
    assert.ok(weather.every((e) => typeof e.durationMs === "number"));
    const failed = ofKind(sessions.get(ROOT_B)!, "tool.end")[0]!;
    assert.equal(failed.payload.ok, false);
    assert.equal(failed.payload.errorType, "ACTION_RESULT_FAILED");
    assert.match(String(failed.payload.error), /No weather data for Atlantis/);
    assert.equal(ofKind(sessions.get(ROOT_B)!, "error").length, 1);
    const s = buildSession(sessions.get(ROOT_B)!);
    assert.equal(s.stats.toolErrors, 1);
    assert.equal(s.stats.toolCalls, 1);
  });

  it("marks eve's framework tools", () => {
    const wait = ofKind(events, "tool.start").filter((e) => e.payload.tool === "eve__task_wait");
    assert.equal(wait.length, 2);
    assert.ok(wait.every((e) => e.payload.framework === true));
  });

  it("is deterministic: re-mapping the same spans yields the same ids", async () => {
    const again = await mapAll();
    assert.deepEqual(
      again.map((e) => e.id),
      events.map((e) => e.id),
    );
    assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  });
});
