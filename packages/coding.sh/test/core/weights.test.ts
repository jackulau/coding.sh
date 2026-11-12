import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { toMetadata } from "../../src/core/redact.ts";
import { buildSession, failureFlags, isEmptySession } from "../../src/core/sessions.ts";
import { CHECKPOINTS_MAX, weightEditsText, weightsCheckpointOf, weightsCheckpointText, weightsEditText, weightsEventText, weightsSummaryText } from "../../src/core/weights.ts";

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

// The SHA-256 of a weights file, as `shasum -a 256 model.safetensors` prints it: what `exp run --weights` takes.
const FILE = `58899f90572c${"0".repeat(52)}`;
const BASE = `0496e5111097${"1".repeat(52)}`;
const checkpoint = (o: Record<string, unknown> = {}): AgentEvent => ev("notification", { kind: "weights.checkpoint", sha256: FILE, baseSha256: BASE, ...o });

describe("a weights checkpoint in a session", () => {
  it("is kept next to the edits, with its own tag, which is not a failure", () => {
    const s = buildSession([ev("session.start"), edit(), edit({ tensor: "layers.4.mlp.down_proj.weight", changed: 96 }), checkpoint(), ev("session.end")]);
    assert.deepEqual(s.stats.weightEdits, { events: 2, tensors: 2, weightsChanged: 1300, checkpoints: [FILE] });
    assert.deepEqual(s.flags.filter((f) => f.startsWith("weights:")), ["weights:edited", "weights:checkpoint"]);
    assert.deepEqual(failureFlags(s.flags), []);
  });

  it("edits alone leave `checkpoints` unset", () => {
    const s = buildSession([ev("session.start"), edit(), ev("session.end")]);
    assert.equal(Object.hasOwn(s.stats.weightEdits!, "checkpoints"), false);
    assert.equal(s.flags.includes("weights:checkpoint"), false);
  });

  it("a session with a checkpoint and no edit has the stat with zero edits, is not tagged as edited and is not hidden as empty", () => {
    const s = buildSession([ev("session.start", { name: "weights.checkpoint" }), checkpoint(), ev("session.end")]);
    assert.deepEqual(s.stats.weightEdits, { events: 0, weightsChanged: 0, checkpoints: [FILE] });
    assert.deepEqual(s.flags, ["weights:checkpoint"]);
    assert.equal(s.stats.turns, 0, "the test's premise: nothing else makes this session count");
    assert.equal(isEmptySession(s), false);
  });

  it("keeps distinct hashes in arrival order, lowercased, and stops at the cap", () => {
    const h = (i: number) => i.toString(16).padStart(64, "0");
    const two = buildSession([ev("session.start"), checkpoint({ sha256: BASE }), checkpoint({ sha256: FILE.toUpperCase() }), checkpoint({ sha256: ` ${BASE} ` }), checkpoint()]);
    assert.deepEqual(two.stats.weightEdits!.checkpoints, [BASE, FILE]);
    const many = buildSession([ev("session.start"), ...Array.from({ length: CHECKPOINTS_MAX + 4 }, (_, i) => checkpoint({ sha256: h(i) }))]);
    assert.deepEqual(many.stats.weightEdits!.checkpoints, Array.from({ length: CHECKPOINTS_MAX }, (_, i) => h(i)));
    assert.equal(CHECKPOINTS_MAX, 16);
  });

  it("an event whose sha256 is not 64 hex characters is not read as a checkpoint", () => {
    for (const sha256 of [undefined, "", "58899f90572c", `${FILE}0`, `g${FILE.slice(1)}`, 7, null, [FILE]]) {
      const e = checkpoint({ sha256 });
      assert.equal(weightsCheckpointOf(e.payload), undefined, JSON.stringify(sha256));
      assert.equal(weightsEventText(e.payload), undefined);
      const s = buildSession([ev("session.start"), e, ev("session.end")]);
      assert.equal(Object.hasOwn(s.stats, "weightEdits"), false, JSON.stringify(sha256));
      assert.deepEqual(s.flags, []);
    }
    // The hash under another kind is not a checkpoint either.
    assert.equal(weightsCheckpointOf({ kind: "weights.edit", sha256: FILE }), undefined);
    assert.equal(weightsCheckpointOf({ sha256: FILE }), undefined);
  });

  it("a base hash that is not a SHA-256 is left out, and the checkpoint still counts", () => {
    assert.deepEqual(weightsCheckpointOf(checkpoint({ baseSha256: "0496e5111097" }).payload), { sha256: FILE });
    assert.deepEqual(weightsCheckpointOf(checkpoint({ baseSha256: BASE.toUpperCase(), note: "after the rank-1 patch" }).payload), { sha256: FILE, baseSha256: BASE, note: "after the rank-1 patch" });
    assert.deepEqual(weightsCheckpointOf(checkpoint({ note: 7 }).payload), { sha256: FILE, baseSha256: BASE });
  });

  it("metadata capture keeps both file hashes and drops the note; an edit still keeps only its numbers", () => {
    const full = checkpoint({ note: "after the rank-1 patch on layer 3" });
    assert.deepEqual(toMetadata(full).payload, { kind: "weights.checkpoint", sha256: FILE, baseSha256: BASE });
    assert.deepEqual(toMetadata(checkpoint({ sha256: FILE.toUpperCase(), baseSha256: undefined })).payload, { kind: "weights.checkpoint", sha256: FILE });
    // Not a checkpoint: nothing but the kind passes.
    assert.deepEqual(toMetadata(checkpoint({ sha256: "not-a-hash" })).payload, { kind: "weights.checkpoint" });
    // The same field names anywhere else are still dropped.
    assert.deepEqual(toMetadata(ev("notification", { kind: "other", sha256: FILE, baseSha256: BASE })).payload, { kind: "other" });
    assert.deepEqual(toMetadata(ev("tool.end", { tool: "Bash", sha256: FILE })).payload, { tool: "Bash" });
    assert.deepEqual(toMetadata(edit({ note: "x" })).payload, { kind: "weights.edit", changed: 1204, l2: 0.0183, maxAbs: 0.004 });

    // Full and metadata capture fold to the same checkpoints, so the join works in either mode.
    const events = [ev("session.start"), edit(), full, ev("session.end")];
    const a = buildSession(events);
    const b = buildSession(events.map(toMetadata));
    assert.deepEqual(a.stats.weightEdits, { events: 1, tensors: 1, weightsChanged: 1204, checkpoints: [FILE] });
    assert.deepEqual(b.stats.weightEdits, { events: 1, weightsChanged: 1204, checkpoints: [FILE] });
    assert.equal(weightsEventText(toMetadata(full).payload), weightsEventText(full.payload));
  });
});

describe("weightsCheckpointText", () => {
  it("writes the saved file's hash and the base file's, 12 characters each", () => {
    assert.equal(weightsCheckpointText(checkpoint().payload), "checkpoint 58899f90572c ← 0496e5111097");
    assert.equal(weightsCheckpointText(checkpoint({ baseSha256: undefined }).payload), "checkpoint 58899f90572c");
    assert.equal(weightsCheckpointText(checkpoint({ note: "not shown" }).payload), "checkpoint 58899f90572c ← 0496e5111097");
    assert.equal(weightsCheckpointText({ kind: "weights.checkpoint" }), "");
  });

  it("weightsEventText is the line of either event, and undefined for anything else", () => {
    assert.equal(weightsEventText(checkpoint().payload), "checkpoint 58899f90572c ← 0496e5111097");
    assert.equal(weightsEventText(edit().payload), weightsEditText(edit().payload));
    assert.equal(weightsEventText({ kind: "weights.edit" }), "", "an edit with no readable field is still an edit");
    assert.equal(weightsEventText({ kind: "hook.context", text: "x" }), undefined);
    assert.equal(weightsEventText({}), undefined);
  });
});

describe("weightsEditText", () => {
  it("names the tensor, its shape, the share of weights changed, both norms and both hashes", () => {
    assert.equal(
      weightsEditText(edit().payload),
      "layers.3.mlp.down_proj.weight [4096×11008] · 1,204 of 45,088,768 weights · L2 0.0183 · max 0.004 · aaaaaaaaaaaa → bbbbbbbbbbbb",
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

describe("weightsSummaryText", () => {
  it("names the checkpoints after the edits", () => {
    assert.equal(weightsSummaryText({ events: 2, tensors: 2, weightsChanged: 66560 }), "2 edits, 2 tensors, 66,560 weights changed");
    assert.equal(weightsSummaryText({ events: 2, tensors: 2, weightsChanged: 66560, checkpoints: [FILE] }), "2 edits, 2 tensors, 66,560 weights changed, checkpoint 58899f90572c");
    assert.equal(weightsSummaryText({ events: 1, weightsChanged: 1, checkpoints: [BASE, FILE] }), "1 edit, 1 weight changed, checkpoints 0496e5111097, 58899f90572c");
  });

  it("a session with a checkpoint and no edit reads as the checkpoint alone", () => {
    assert.equal(weightsSummaryText({ events: 0, weightsChanged: 0, checkpoints: [FILE] }), "checkpoint 58899f90572c");
    assert.equal(weightEditsText({ events: 0, weightsChanged: 0, checkpoints: [FILE] }), "no edits");
  });
});
