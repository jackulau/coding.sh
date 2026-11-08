// X-21: grader versions are pinned in a comparison (a changed or one-sided
// grader is a new measurement, not an agent change), and a regrade reports the
// exact runs whose outcome flipped.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { regradeDiff, renderRegradeDiff } from "../../src/experiments/regrade.ts";
import { renderComparison } from "../../src/experiments/render.ts";
import { regradeExperiment, runExperiment } from "../../src/experiments/run.ts";
import { exactGrader } from "../../src/graders/builtin.ts";

const cases = ["a", "b", "c", "d", "e", "f"].map((q) => ({ id: q, input: { q }, expected: q.toUpperCase() }));
const ds = createDataset({ name: "upper", createdAt: 1, cases });
const agent = (wrong: string[]) => ({
  kind: "function" as const,
  name: "agent",
  fn: (input: unknown) => {
    const q = (input as { q: string }).q;
    return wrong.includes(q) ? "nope" : q.toUpperCase();
  },
});
/** The exact grader under another version that also fails the cases in `bad`. */
const strict = (bad: string[], id = "exact"): Grader => ({ id, version: "strict-v2", kind: "exact", grade: async (ctx) => ({ pass: !bad.includes(ctx.caseId!) && ctx.output === ctx.expected, score: 0 }) });

describe("compare pins grader versions", () => {
  it("is silent when both sides use the same graders", async () => {
    const a = await runExperiment({ name: "a", dataset: ds, task: agent(["f"]), graders: [exactGrader()] });
    const b = await runExperiment({ name: "b", dataset: ds, task: agent([]), graders: [exactGrader()] });
    const c = compareExperiments(a, b);
    assert.equal(c.instrumentWarning, undefined);
    assert.equal(c.gradersOnlyIn, undefined);
    assert.equal(c.graders[0]!.versionChanged, undefined);
    assert.equal(c.ungradedCases, undefined);
  });

  it("warns when a grader changed version, and says so above the verdict", async () => {
    const a = await runExperiment({ name: "a", dataset: ds, task: agent([]), graders: [exactGrader()] });
    const b = await runExperiment({ name: "b", dataset: ds, task: agent([]), graders: [strict(["a"])] });
    const c = compareExperiments(a, b, { gate: { lambda: 2, alpha: 0.05, tau: 0.1 } });
    assert.deepEqual(c.graders[0]!.versionChanged, { a: a.graders[0]!.version, b: "strict-v2" });
    assert.match(c.instrumentWarning!, /exact \(A .+, B strict-v2\) changed version/);
    assert.match(c.instrumentWarning!, /exp regrade/);
    assert.match(c.gate!.note!, /different graders/);
    const text = renderComparison(c, { color: false });
    assert.ok(text.indexOf("not graded alike") < text.indexOf("verdict"), "the warning comes before the verdict");
  });

  it("lists graders present on one side only", async () => {
    const a = await runExperiment({ name: "a", dataset: ds, task: agent([]), graders: [exactGrader()] });
    const b = await runExperiment({ name: "b", dataset: ds, task: agent([]), graders: [exactGrader(), strict([], "extra")] });
    const c = compareExperiments(a, b);
    assert.deepEqual(c.gradersOnlyIn, { a: [], b: ["extra"] });
    assert.match(c.instrumentWarning!, /extra graded only B/);
    assert.deepEqual(c.graders.map((g) => g.id), ["exact"]);
  });

  it("names cases that ran on both sides but are ungraded on one", async () => {
    const a = await runExperiment({ name: "a", dataset: ds, task: agent([]), graders: [exactGrader()] });
    const flaky: Grader = { ...exactGrader(), grade: async (ctx) => { if (ctx.caseId === "c") throw new Error("judge down"); return { pass: true, score: 1 }; } };
    const b = await runExperiment({ name: "b", dataset: ds, task: agent([]), graders: [flaky] });
    const c = compareExperiments(a, b);
    assert.deepEqual(c.ungradedCases, ["c"]);
    assert.equal(c.paired, 5);
    assert.deepEqual(c.onlyInA, [], "ungraded is not 'only in A'");
    assert.equal(b.summary.passRate.p, 1, "the grader error is not a failure");
  });
});

describe("regradeDiff", () => {
  it("an identical regrade gives 0 flips", async () => {
    const first = await runExperiment({ name: "base", dataset: ds, task: agent(["f"]), graders: [exactGrader()] });
    const same = await regradeExperiment({ result: first, dataset: ds, graders: [exactGrader()] });
    const d = regradeDiff(first, same);
    assert.equal(d.flips.length, 0);
    assert.equal(d.paired, 6);
    assert.deepEqual(d.graders.map((g) => g.changed), [false]);
    assert.equal(d.before.passRate, d.after.passRate);
  });

  it("a stricter grader gives exact flip counts and a version change", async () => {
    const first = await runExperiment({ name: "base", dataset: ds, task: agent(["f"]), graders: [exactGrader()] });
    const r = await regradeExperiment({ result: first, dataset: ds, graders: [strict(["a", "b"])] });
    const d = regradeDiff(first, r);
    assert.deepEqual(d.flips.map((x) => `${x.caseId}:${x.before}->${x.after}`), ["a:pass->fail", "b:pass->fail"]);
    assert.equal(d.toFail, 2);
    assert.equal(d.toPass, 0);
    assert.deepEqual(d.graders, [{ id: "exact", before: first.graders[0]!.version, after: "strict-v2", changed: true }]);
    assert.equal(d.before.passed, 5);
    assert.equal(d.after.passed, 3);
    const text = renderRegradeDiff(d, { color: false });
    assert.match(text, /flips {3}2 of 6 runs: 2 pass → fail, 0 fail → pass/);
    assert.match(text, /\(changed\)/);
    assert.match(text, /83\.3% → 50\.0%/);
    // Comparing a regrade with its original: the grader change is all B − A measures, and timing is moot.
    const c = compareExperiments(first, r);
    assert.match(c.instrumentWarning!, /regrade of the other's outputs .* the grader change alone/);
    assert.equal(c.timing.warning, undefined);
  });

  it("a throwing grader leaves runs ungraded: counted apart, pass rate over graded runs", async () => {
    const first = await runExperiment({ name: "base", dataset: ds, task: agent([]), graders: [exactGrader()] });
    const throwing: Grader = { id: "exact", version: "t", kind: "exact", grade: async (ctx) => { if (ctx.caseId === "a") throw new Error("judge down"); return { pass: ctx.output === ctx.expected, score: 1 }; } };
    const r = await regradeExperiment({ result: first, dataset: ds, graders: [throwing] });
    const d = regradeDiff(first, r);
    assert.equal(d.toUngraded, 1);
    assert.equal(d.toFail, 0);
    assert.equal(d.after.passRate, 1, "5 of 5 graded runs pass");
    assert.match(renderRegradeDiff(d, { color: false }), /a grader errored on a/);
  });
  it("a throwing grader next to a failing one leaves the run a failure", async () => {
    const first = await runExperiment({ name: "base", dataset: ds, task: agent([]), graders: [exactGrader()] });
    const throwing: Grader = { id: "judge", version: "t", kind: "custom", grade: async () => { throw new Error("judge down"); } };
    const never: Grader = { id: "never", version: "t", kind: "custom", grade: async (ctx) => ({ pass: ctx.caseId !== "a", score: 1 }) };
    const r = await regradeExperiment({ result: first, dataset: ds, graders: [never, throwing] });
    const a = r.runs.find((x) => x.caseId === "a")!;
    assert.equal(a.pass, false);
    assert.equal(a.ungraded, undefined);
    assert.equal(r.summary.ungraded, r.runs.length - 1);
  });
});
