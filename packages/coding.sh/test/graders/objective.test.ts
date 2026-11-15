import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exactGrader, objectiveGrader } from "../../src/graders/builtin.ts";
import { createGrader } from "../../src/graders/index.ts";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);
const grade = (g: Awaited<ReturnType<typeof createGrader>>, output: unknown) => g.grade({ input: "", output });
const ANCHORS = { base: 10, ref: 2, anchoredAt: "2026-11-14" };

describe("objective grader", () => {
  it("scores lower-is-better on a log scale", async () => {
    const g = objectiveGrader(ANCHORS);
    near((await grade(g, 2)).score, 1);
    assert.equal((await grade(g, 2)).pass, true);
    assert.equal((await grade(g, 10)).score, 0);
    assert.equal((await grade(g, 20)).score, 0);
    assert.equal((await grade(g, 20)).pass, false);
    near((await grade(g, Math.sqrt(20))).score, 0.5);
    const top = await grade(g, 0.08);
    assert.equal(top.score, 3);
    assert.match(top.reason ?? "", /clipped/);
    assert.match(top.reason ?? "", /2026-11-14/);
    assert.doesNotMatch((await grade(g, 5)).reason ?? "", /clipped/);
  });

  it("scores higher-is-better and honors clip", async () => {
    const g = objectiveGrader({ base: 100, ref: 200, anchoredAt: "2026-11-14" });
    near((await grade(g, 400)).score, 2);
    assert.equal((await grade(objectiveGrader({ base: 100, ref: 200, anchoredAt: "x", clip: 1.5 }), 400)).score, 1.5);
  });

  it("scores on a linear scale", async () => {
    const g = objectiveGrader({ base: 0.5, ref: 0.9, anchoredAt: "2026-11-14", scale: "linear" });
    near((await grade(g, 0.7)).score, 0.5);
    assert.equal((await grade(g, 0.3)).score, 0);
    assert.equal((await objectiveGrader({ base: -5, ref: 5, anchoredAt: "x", scale: "linear" }).grade({ input: "", output: 0 })).score, 0.5);
  });

  it("reads J from a JSON path or text", async () => {
    const g = objectiveGrader({ ...ANCHORS, path: "$.ms" });
    near((await grade(g, '{"ms": 2}')).score, 1);
    assert.equal((await grade(g, { other: 1 })).pass, false);
    near((await grade(objectiveGrader(ANCHORS), "took 2 ms")).score, 1);
    assert.equal((await grade(objectiveGrader(ANCHORS), "no digits")).score, 0);
    assert.equal((await grade(objectiveGrader(ANCHORS), 0)).score, 0);
  });

  it("scores 0 with the gate's reason when the gate fails", async () => {
    const gate = exactGrader({ value: "ok" });
    const g = objectiveGrader({ ...ANCHORS, gate });
    const bad = await g.grade({ input: "", output: 2 });
    assert.equal(bad.score, 0);
    assert.equal(bad.pass, false);
    assert.match(bad.reason ?? "", /gate/);
    const viaSpec = await createGrader({ kind: "objective", ...ANCHORS, path: "$.ms", gate: { kind: "json-path", path: "$.ok", equals: true } });
    assert.equal((await grade(viaSpec, { ok: false, ms: 2 })).score, 0);
    near((await grade(viaSpec, { ok: true, ms: 2 })).score, 1);
  });

  it("rejects bad anchors at validation", async () => {
    assert.throws(() => objectiveGrader({ base: 5, ref: 5, anchoredAt: "x" }), /differ/);
    assert.throws(() => objectiveGrader({ base: 0, ref: 5, anchoredAt: "x" }), /greater than 0/);
    assert.throws(() => objectiveGrader({ base: 5, ref: -1, anchoredAt: "x" }), /greater than 0/);
    assert.throws(() => objectiveGrader({ base: 5, ref: 6, anchoredAt: "" }), /anchoredAt/);
    await assert.rejects(async () => createGrader({ kind: "objective", base: 3, ref: 3, anchoredAt: "x" }), /differ/);
    assert.doesNotThrow(() => objectiveGrader({ base: 0, ref: 5, anchoredAt: "x", scale: "linear" }));
  });

  it("changes version when an anchor changes", () => {
    assert.notEqual(objectiveGrader(ANCHORS).version, objectiveGrader({ ...ANCHORS, ref: 3 }).version);
  });
});
