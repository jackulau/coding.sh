import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { toMetadata } from "../../src/core/redact.ts";
import { buildSession, failureFlags, isEmptySession } from "../../src/core/sessions.ts";
import { weightEditsText, weightsEditText } from "../../src/core/weights.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
let t = 0;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e${++t}`, v: 0, sessionId: "s", ts: 1000 + t * 10, agent: "sdk", kind, payload, ...o,
});
const edit = (o: Record<string, unknown> = {}): AgentEvent =>
  ev("notification", { kind: "weights.edit", tensor: "layers.3.mlp.down_proj.weight", shape: [4096, 11008], changed: 1204, l2: 0.0183, maxAbs: 0.004, baseSha256: A, editedSha256: B, ...o });

describe("weight edits in a session", () => {
  it("two edits give the stat and the tag, and the tag is not a failure", () => {
    const s = buildSession([ev("session.start"), edit(), edit({ tensor: "layers.4.mlp.down_proj.weight", changed: 96 }), edit({ changed: 1 }), ev("session.end")]);
    assert.deepEqual(s.stats.weightEdits, { events: 3, tensors: 2, weightsChanged: 1301 });
    assert.ok(s.flags.includes("weights:edited"));
    assert.deepEqual(failureFlags(s.flags), []);
  });

  it("a session with no weight edit has neither the stat nor the tag", () => {
    const s = buildSession([ev("session.start"), ev("notification", { kind: "hook.context", text: "x", tokens: 1 }), ev("notification", { message: "weights.edit" }), ev("session.end")]);
    assert.equal(Object.hasOwn(s.stats, "weightEdits"), false);
    assert.equal(s.flags.some((f) => f.startsWith("weights:")), false);
  });

  it("metadata capture keeps the counts and drops the tensor names", () => {
    const stripped = toMetadata(edit());
    assert.equal(Object.hasOwn(stripped.payload, "tensor"), false, "the test's premise: metadata mode drops the name");
    const s = buildSession([ev("session.start"), stripped, ev("session.end")]);
    assert.deepEqual(s.stats.weightEdits, { events: 1, weightsChanged: 1204 });
    assert.equal(Object.hasOwn(s.stats.weightEdits!, "tensors"), false);
    assert.equal(weightsEditText(stripped.payload), "1,204 weights · L2 0.0183 · max 0.004");
  });

  it("an edit whose numbers are not numbers still counts as an edit", () => {
    const s = buildSession([ev("session.start"), edit({ changed: "many", tensor: 7 }), edit({ changed: -3 }), edit({ changed: 1.5 })]);
    assert.deepEqual(s.stats.weightEdits, { events: 3, tensors: 1, weightsChanged: 0 });
  });

  it("a session that holds only a weight edit is not hidden as empty", () => {
    const own = buildSession([ev("session.start", { name: "weights.edit" }), edit(), ev("session.end")]);
    assert.equal(own.stats.turns, 0, "the test's premise: nothing else makes this session count");
    assert.equal(isEmptySession(own), false);
    assert.equal(isEmptySession(buildSession([ev("session.start"), ev("session.end")])), true);
  });
});

describe("weightsEditText", () => {
  it("names the tensor, its shape, the share of weights changed, both norms and both hashes", () => {
    assert.equal(
      weightsEditText(edit().payload),
      "layers.3.mlp.down_proj.weight [4096×11008] · 1,204 of 45,088,768 weights · L2 0.0183 · max 0.004 · aaaaaaaa → bbbbbbbb",
    );
  });

  it("leaves out what the payload does not have", () => {
    assert.equal(weightsEditText({ kind: "weights.edit" }), "");
    assert.equal(weightsEditText({ tensor: "w", changed: 1 }), "w · 1 weight");
    assert.equal(weightsEditText({ tensor: "w", shape: [2, 3], changed: 1 }), "w [2×3] · 1 of 6 weights");
    assert.equal(weightsEditText({ tensor: "bias", shape: [], changed: 0, l2: 0, maxAbs: 0 }), "bias · 0 weights · L2 0 · max 0");
    assert.equal(weightsEditText({ tensor: "w", baseSha256: A }), "w", "one hash alone says nothing about the change");
    assert.equal(weightsEditText({ tensor: "w", shape: [2, "x"], changed: 2 }), "w · 2 weights", "a shape that is not all counts is not shown");
  });

  it("says `of` the tensor's size only when the count fits in it, and reads no shape of more than 16 dimensions", () => {
    assert.equal(weightsEditText({ tensor: "w", shape: [0, 5], changed: 3 }), "w [0×5] · 3 weights");
    assert.equal(weightsEditText({ tensor: "w", shape: [2, 3], changed: 7 }), "w [2×3] · 7 weights");
    assert.equal(weightsEditText({ tensor: "w", shape: Array.from({ length: 17 }, () => 2), changed: 4 }), "w · 4 weights");
    assert.equal(weightsEditText({ l2: Number.MAX_VALUE }), `L2 ${Number.MAX_VALUE}`, "never Infinity");
  });

  it("keeps four significant digits of a norm", () => {
    assert.equal(weightsEditText({ l2: 0.018300000000000004, maxAbs: 1234.5678 }), "L2 0.0183 · max 1235");
    assert.equal(weightsEditText({ l2: 1e-9 }), "L2 1e-9");
  });
});

describe("weightEditsText", () => {
  it("counts edits, tensors and weights", () => {
    assert.equal(weightEditsText({ events: 2, tensors: 2, weightsChanged: 66560 }), "2 edits, 2 tensors, 66,560 weights changed");
    assert.equal(weightEditsText({ events: 1, weightsChanged: 1 }), "1 edit, 1 weight changed");
  });
});
