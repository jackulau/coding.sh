import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Label } from "../../src/core/types.ts";
import { calibrate, humanTruth, judgeId, runJudge, type JudgeSpec, type Verdict } from "../../src/eval/judge.ts";
import { blockOverlap } from "../../src/eval/leakage.ts";
import { MemIndex } from "../helpers-eval.ts";

const spec: JudgeSpec = { id: "solved", version: "1", criterion: "outcome", rubric: "Did the agent solve the task?", model: "m-1" };

let n = 0;
const label = (sessionId: string, value: Label["value"], criterion = "outcome"): Label => ({ id: `l${n++}`, sessionId, criterion, value, by: "h", ts: n });

describe("judgeId", () => {
  it("is stable and changes with version, rubric, model or criterion", () => {
    assert.equal(judgeId(spec), judgeId({ ...spec }));
    assert.match(judgeId(spec), /^solved@[0-9a-f]{12}$/);
    const ids = new Set([
      judgeId(spec),
      judgeId({ ...spec, version: "2" }),
      judgeId({ ...spec, rubric: "Did it pass the tests?" }),
      judgeId({ ...spec, model: "m-2" }),
      judgeId({ ...spec, model: undefined }),
      judgeId({ ...spec, criterion: "style" }),
    ]);
    assert.equal(ids.size, 6);
  });
});

describe("calibrate", () => {
  // Same table as the Wikipedia κ example: 20 pp, 5 pf, 10 fp, 15 ff → κ = 0.4.
  function build(pp: number, pf: number, fp: number, ff: number) {
    const verdicts = new Map<string, Verdict>();
    const labels: Label[] = [];
    let i = 0;
    const add = (j: Verdict, h: Verdict, k: number) => {
      for (let x = 0; x < k; x++, i++) {
        verdicts.set(`s${i}`, j);
        labels.push(label(`s${i}`, h));
      }
    };
    add("pass", "pass", pp);
    add("pass", "fail", pf);
    add("fail", "pass", fp);
    add("fail", "fail", ff);
    return { verdicts, labels };
  }
  it("matches the textbook κ and fails the default threshold", () => {
    const { verdicts, labels } = build(20, 5, 10, 15);
    const c = calibrate({ judgeVerdicts: verdicts, labels });
    assert.equal(c.n, 50);
    assert.ok(Math.abs(c.kappa - 0.4) < 1e-12);
    assert.equal(c.agreement, 0.7);
    assert.deepEqual(c.confusion, { tp: 20, fp: 5, fn: 10, tn: 15 });
    assert.equal(c.ok, false);
    assert.match(c.reason ?? "", /below the 0.6 threshold/);
  });
  it("passes a good judge", () => {
    const { verdicts, labels } = build(24, 1, 1, 24);
    const c = calibrate({ judgeVerdicts: verdicts, labels });
    assert.ok(c.kappa > 0.9);
    assert.equal(c.ok, true);
  });
  it("needs enough overlap and both classes", () => {
    const few = build(3, 0, 0, 3);
    assert.match(calibrate({ judgeVerdicts: few.verdicts, labels: few.labels }).reason ?? "", /only 6/);
    const one = build(24, 0, 0, 0);
    const c = calibrate({ judgeVerdicts: one.verdicts, labels: one.labels });
    assert.ok(Number.isNaN(c.kappa));
    assert.equal(c.ok, false);
    assert.match(c.reason ?? "", /undefined/);
  });
  it("ignores skips, other criteria, unjudged sessions; majority-votes multiple labels", () => {
    const labels = [
      label("a", "pass"),
      label("a", "pass"),
      label("a", "fail"), // majority pass, contested
      label("b", "pass"),
      label("b", "fail"), // tie → dropped
      label("c", "skip"),
      label("d", "fail", "style"),
      label("e", "fail"), // no verdict
    ];
    const { truth, contested } = humanTruth(labels, "outcome");
    assert.deepEqual([...truth], [["a", "pass"], ["e", "fail"]]);
    assert.equal(contested, 2);
    const c = calibrate({ judgeVerdicts: new Map([["a", "pass"], ["d", "pass"]]), labels, criterion: "outcome", minN: 1 });
    assert.equal(c.n, 1);
    assert.equal(c.unjudged, 1);
  });
});

describe("runJudge", () => {
  it("runs a pluggable judge and records failures", async () => {
    const index = new MemIndex();
    await index.putEvents([{ id: "e1", v: 0, sessionId: "s1", ts: 1, agent: "x", kind: "user.message", payload: { text: "hi" } }]);
    const { verdicts, errors } = await runJudge({
      spec,
      index,
      sessionIds: ["s1", "boom"],
      judge: async ({ sessionId, events }) => {
        if (sessionId === "boom") throw new Error("rate limited");
        return events.length > 0 ? "pass" : "fail";
      },
    });
    assert.equal(verdicts.get("s1"), "pass");
    assert.equal(errors.get("boom"), "rate limited");
  });
});

describe("blockOverlap", () => {
  it("does not form n-grams across separate blocks and skips tiny ones", () => {
    const o = blockOverlap(["return a + b;", "return a * b;"], "return a + b; return a * b;", 8);
    assert.equal(o.total, 0);
    const big = "const total = items.reduce((s, x) => s + x.price, 0);";
    assert.equal(blockOverlap([big], `do this: ${big}`).fraction, 1);
  });
});
