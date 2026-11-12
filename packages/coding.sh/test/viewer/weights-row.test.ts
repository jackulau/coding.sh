// A weight edit in the viewer: the page's own weightsEditText (run straight from index.html) gives
// the same line as core/weights.ts, the rows route labels the event with it, and a fold of routine
// events never hides one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { weightsEditText } from "../../src/core/weights.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { buildModel, FOLD_MIN, layoutRows, rowLabel } from "../../src/viewer/model.ts";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
const from = html.indexOf("function weightsEditText(");
const to = html.indexOf("function eventView(", from);
assert.ok(from >= 0 && to > from, "the page defines weightsEditText just before eventView");
const page: (p: Record<string, unknown>) => string = runInNewContext(`${html.slice(from, to)}\nweightsEditText`, { Number, String, Array });

const A = "a".repeat(64);
const B = "b".repeat(64);
const FULL = { kind: "weights.edit", tensor: "layers.3.mlp.down_proj.weight", shape: [4096, 11008], changed: 1204, l2: 0.0183, maxAbs: 0.004, baseSha256: A, editedSha256: B };

test("the page and the CLI write the same line for a weight edit", () => {
  const payloads: Record<string, unknown>[] = [
    FULL,
    { ...FULL, note: "rank-1 edit" },
    { kind: "weights.edit", changed: 1204, l2: 0.0183, maxAbs: 0.004 },
    { kind: "weights.edit" },
    { tensor: "w", changed: 1 },
    { tensor: "w", shape: [2, 3], changed: 1 },
    { tensor: "bias", shape: [], changed: 0, l2: 0, maxAbs: 0 },
    { tensor: "w", baseSha256: A },
    { tensor: "w", shape: [2, "x"], changed: 2 },
    { tensor: 7, shape: "no", changed: -1, l2: Number.NaN, maxAbs: "big", baseSha256: 1, editedSha256: null },
    { tensor: "w", shape: [1e9, 1e9], changed: 5 },
    { l2: 0.018300000000000004, maxAbs: 1234.5678 },
    { l2: 1e-9, changed: 1234567 },
    { l2: Number.MAX_VALUE, maxAbs: Number.MAX_VALUE },
    { tensor: "w", shape: [0, 5], changed: 3 },
    { tensor: "w", shape: [2, 3], changed: 7 },
    { tensor: "w", shape: [1], changed: 1 },
    { tensor: "w", shape: Array.from({ length: 16 }, () => 1), changed: 1 },
    { tensor: "w", shape: Array.from({ length: 17 }, () => 1), changed: 1 },
  ];
  for (const p of payloads) assert.equal(page(p), weightsEditText(p), JSON.stringify(p));
  assert.equal(page(FULL), "layers.3.mlp.down_proj.weight [4096×11008] · 1,204 of 45,088,768 weights · L2 0.0183 · max 0.004 · aaaaaaaa → bbbbbbbb");
});

const base = { v: 0, sessionId: "w-1", agent: "sdk" } as const;
const ev = (i: number, kind: AgentEvent["kind"], payload: Record<string, unknown> = {}): AgentEvent => ({ ...base, id: `e${i}`, ts: 1000 + i, kind, payload });

test("the rows route labels a weight edit with that line", () => {
  assert.equal(rowLabel(ev(0, "notification", FULL)), weightsEditText(FULL));
  assert.equal(rowLabel(ev(2, "notification", { kind: "weights.edit" })), "weights.edit", "an edit with no readable field still has a label");
  assert.equal(rowLabel(ev(1, "notification", { kind: "hook.context", text: "x" })), "notification");
});

test("a fold of routine events never hides a weight edit", () => {
  // One turn: a long run of plain notifications with one weight edit in the middle.
  const n = FOLD_MIN * 6;
  const mid = n / 2;
  const evs = [ev(0, "session.start"), ev(1, "user.message", { text: "edit the weights" })];
  for (let i = 0; i < n; i++) evs.push(ev(2 + i, "notification", i === mid ? FULL : { message: `tick ${i}` }));
  const m = buildModel(evs);
  const { slots } = layoutRows(m, m.turns[0]!, m.turns[0]!.start, 10_000);
  const folds = slots.filter((s): s is { from: number; to: number } => "from" in s);
  assert.ok(folds.length >= 2, `the runs on both sides fold: ${JSON.stringify(slots)}`);
  const at = 2 + mid;
  assert.ok(slots.some((s) => "i" in s && s.i === at), "the weight edit is a row of its own");
  assert.ok(folds.every((f) => at < f.from || at > f.to));
});
