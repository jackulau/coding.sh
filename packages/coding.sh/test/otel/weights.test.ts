// A weight edit over OTLP: a span or a log record named `weights.edit` with coding_sh.weights.*
// attributes becomes the notification the SDKs' weights_edit helpers send, so the session gets
// the same stat, tag and line whichever way the edit arrived.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { isWeightsEdit, weightsEditText } from "../../src/core/weights.ts";
import { decodeLogsJson, decodeTraceJson } from "../../src/otel/json.ts";
import { type MapContext, mapLogs, mapTraces, TraceSessionMap } from "../../src/otel/map.ts";
import { iAttr, otlpLogs, otlpSpan, otlpTraces, sAttr } from "./_encode.ts";
import { MemBlobs } from "./_memstore.ts";

type J = Record<string, unknown>;
const A = "a".repeat(64);
const B = "b".repeat(64);
const TRACE = "5b8efff798038103d269b633813fc60c";
const dAttr = (key: string, v: number): J => ({ key, value: { doubleValue: v } });
const shapeAttr = (dims: number[]): J => ({ key: "coding_sh.weights.shape", value: { arrayValue: { values: dims.map((d) => ({ intValue: String(d) })) } } });
const FULL: J[] = [
  sAttr("coding_sh.weights.tensor", "layers.3.mlp.down_proj.weight"),
  shapeAttr([4096, 11008]),
  iAttr("coding_sh.weights.changed", 1204),
  dAttr("coding_sh.weights.l2", 0.0183),
  dAttr("coding_sh.weights.max_abs", 0.004),
  sAttr("coding_sh.weights.base_sha256", A),
  sAttr("coding_sh.weights.edited_sha256", B),
  sAttr("coding_sh.weights.note", "rank-1 edit"),
];
const PAYLOAD = { kind: "weights.edit", tensor: "layers.3.mlp.down_proj.weight", shape: [4096, 11008], changed: 1204, l2: 0.0183, maxAbs: 0.004, baseSha256: A, editedSha256: B, note: "rank-1 edit" };
const LINE = "layers.3.mlp.down_proj.weight [4096×11008] · 1,204 of 45,088,768 weights · L2 0.0183 · max 0.004 · aaaaaaaa → bbbbbbbb";

const ctx = (): MapContext => {
  const blobs = new MemBlobs();
  return { maxInlineBytes: 4096, blob: (d) => blobs.put(d), traceSessions: new TraceSessionMap() };
};
const spans = async (...list: J[]): Promise<AgentEvent[]> => (await mapTraces(decodeTraceJson(otlpTraces("trainer", list)), ctx())).events;
const edits = (events: AgentEvent[]) => events.filter(isWeightsEdit);

describe("a weights.edit span", () => {
  it("under a parent span becomes the weight edit notification, and nothing else", async () => {
    const events = await spans(
      otlpSpan(TRACE, "1111111111111111", undefined, "edit run", [], 0, 5000),
      otlpSpan(TRACE, "2222222222222222", "1111111111111111", "weights.edit", FULL, 1000, 1200),
    );
    const own = events.filter((e) => e.spanId === "2222222222222222");
    assert.deepEqual(own.map((e) => e.kind), ["notification"]);
    assert.deepEqual(own[0]!.payload, PAYLOAD);
    assert.equal(own[0]!.durationMs, 200);
    assert.equal(weightsEditText(own[0]!.payload), LINE);
    const s = buildSession(events);
    assert.deepEqual(s.stats.weightEdits, { events: 1, tensors: 1, weightsChanged: 1204 });
    assert.ok(s.flags.includes("weights:edited"));
  });

  it("as the root span of its trace still records the edit", async () => {
    const events = await spans(otlpSpan(TRACE, "1111111111111111", undefined, "weights.edit", FULL, 0, 200));
    assert.deepEqual(edits(events).map((e) => e.payload), [PAYLOAD]);
    assert.ok(events.some((e) => e.kind === "session.start"), "the root span still opens the session");
    assert.deepEqual(buildSession(events).stats.weightEdits, { events: 1, tensors: 1, weightsChanged: 1204 });
  });

  it("keeps a scalar's empty shape and a zero, reads numbers sent as strings, and drops what is malformed", async () => {
    const one = async (attrs: J[]) => edits(await spans(otlpSpan(TRACE, "1111111111111111", undefined, "run", [], 0, 9), otlpSpan(TRACE, "3333333333333333", "1111111111111111", "weights.edit", attrs, 1, 2)))[0]!.payload;
    assert.deepEqual(await one([sAttr("coding_sh.weights.tensor", "bias"), shapeAttr([]), iAttr("coding_sh.weights.changed", 0), iAttr("coding_sh.weights.l2", 0)]), { kind: "weights.edit", tensor: "bias", shape: [], changed: 0, l2: 0 });
    assert.deepEqual(await one([sAttr("coding_sh.weights.shape", "[2, 3]"), sAttr("coding_sh.weights.changed", "6")]), { kind: "weights.edit", shape: [2, 3], changed: 6 });
    assert.deepEqual(await one([sAttr("coding_sh.weights.shape", "wide"), iAttr("coding_sh.weights.changed", -4), dAttr("coding_sh.weights.l2", -1)]), { kind: "weights.edit" });
    assert.deepEqual(await one([]), { kind: "weights.edit" }, "an edit with no attributes still counts as an edit");
  });

  it("a span with another name is not a weight edit, whatever its attributes", async () => {
    const events = await spans(otlpSpan(TRACE, "1111111111111111", undefined, "run", [], 0, 9), otlpSpan(TRACE, "4444444444444444", "1111111111111111", "weights.load", FULL, 1, 2));
    assert.deepEqual(edits(events), []);
    assert.equal(Object.hasOwn(buildSession(events).stats, "weightEdits"), false);
  });
});

describe("a weights.edit log record", () => {
  it("becomes the same notification", async () => {
    const events = (await mapLogs(decodeLogsJson(otlpLogs("trainer", "weights.edit", [sAttr("session.id", "run-7"), ...FULL])), ctx())).events;
    assert.deepEqual(events.map((e) => [e.kind, e.sessionId]), [["notification", "run-7"]]);
    assert.deepEqual(events[0]!.payload, PAYLOAD);
  });

  it("named by its event.name attribute too", async () => {
    const req = otlpLogs("trainer", "edited one tensor", [sAttr("event.name", "weights.edit"), iAttr("coding_sh.weights.changed", 12)]);
    const events = (await mapLogs(decodeLogsJson(req), ctx())).events;
    assert.deepEqual(events.map((e) => e.payload), [{ kind: "weights.edit", changed: 12 }]);
  });
});
