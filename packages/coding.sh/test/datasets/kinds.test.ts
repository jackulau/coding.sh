// TB-12: case kinds. A bad case fails on the old version and passes on the new
// one; guards and controls pass on both, and a broken control is overcorrection.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { casesFromCsv, createDataset, datasetToCsv, datasetToJsonl, DatasetError, normalizeCase, parseJsonl } from "../../src/datasets/dataset.ts";
import { checkAgainst, compareKinds, kindMap, stampKinds, summarizeKinds } from "../../src/datasets/kinds.ts";
import type { CaseKind } from "../../src/datasets/types.ts";
import { exactGrader } from "../../src/graders/builtin.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { renderComparison, renderExperiment } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";
import { wilson } from "../../src/stats/interval.ts";

describe("case kinds in datasets", () => {
  it("parses kind, rejects unknown kinds, and keeps the id independent of it", () => {
    const c = normalizeCase({ input: "x", expected: "y", kind: "bad" });
    assert.equal(c.kind, "bad");
    assert.equal(c.id, normalizeCase({ input: "x", expected: "y" }).id);
    assert.equal(normalizeCase({ input: "x", kind: "" }).kind, undefined);
    assert.equal(normalizeCase({ input: "x", kind: null }).kind, undefined);
    assert.throws(() => normalizeCase({ input: "x", kind: "regression" }, "case 3"), (e: Error) => e instanceof DatasetError && /case 3: "kind" must be one of bad, guard, control/.test(e.message));
  });

  it("a kind changes the dataset version; dedupe keeps the first kind and adopts one when the kept case has none", () => {
    const a = createDataset({ name: "k", cases: [{ id: "1", input: "x" }] });
    const b = createDataset({ name: "k", cases: [{ id: "1", input: "x", kind: "guard" }] });
    assert.notEqual(a.version, b.version);
    const d = createDataset({ name: "k", cases: [{ input: "x" }, { input: "x", kind: "control" }, { input: "y", kind: "bad" }, { input: "y", kind: "guard" }] });
    assert.deepEqual(
      d.cases.map((c) => c.kind),
      ["control", "bad"],
    );
    assert.equal(d.duplicates.length, 2);
  });

  it("round-trips kind through JSONL and CSV; CSV has no kind column when no case has a kind", () => {
    const ds = createDataset({ name: "k", cases: [{ id: "a", input: "1", kind: "bad", split: "test" }, { id: "b", input: "2" }] });
    const jsonl = datasetToJsonl(ds);
    assert.match(jsonl.split("\n")[0]!, /^\{"id":"a","input":"1","split":"test","kind":"bad"\}$/);
    assert.deepEqual(
      createDataset({ name: "k", cases: parseJsonl(jsonl) }).cases.map((c) => c.kind),
      ["bad", undefined],
    );
    const csv = datasetToCsv(ds);
    assert.equal(csv.split(/\r?\n/)[0], "id,input,expected,split,kind,tags,sourceSessionId");
    assert.deepEqual(
      createDataset({ name: "k", cases: casesFromCsv(csv) }).cases.map((c) => c.kind),
      ["bad", undefined],
    );
    const plain = datasetToCsv(createDataset({ name: "p", cases: [{ id: "a", input: "1" }] }));
    assert.equal(plain.split(/\r?\n/)[0], "id,input,expected,split,tags,sourceSessionId");
    assert.throws(() => createDataset({ name: "k", cases: casesFromCsv("input,kind\nx,bogus\n") }), /"kind" must be one of/);
  });

  it("stamps kinds onto runs without touching ordinary cases", () => {
    const runs = [{ caseId: "a" }, { caseId: "b" }];
    const out = stampKinds(runs, [{ id: "a", kind: "control" }, { id: "b" }]);
    assert.deepEqual(out, [{ caseId: "a", kind: "control" }, { caseId: "b" }]);
    assert.equal(stampKinds(runs, [{ id: "a" }]), runs, "no kinds: same array back");
    assert.deepEqual([...kindMap([{ id: "a", kind: "bad" }, { id: "b" }])], [["a", "bad"]]);
  });
});

describe("summarizeKinds", () => {
  it("is undefined with no kinded run, Wilson for one trial, a case bootstrap for several, and leaves ungraded runs out", () => {
    assert.equal(summarizeKinds([{ caseId: "a", pass: true }], 1), undefined);
    const one = summarizeKinds(
      [
        { caseId: "a", kind: "bad", pass: false },
        { caseId: "b", kind: "bad", pass: true },
        { caseId: "c", kind: "control", pass: true },
        { caseId: "d", kind: "control", pass: false, ungraded: true },
        { caseId: "e", pass: true },
      ],
      1,
    )!;
    assert.deepEqual(Object.keys(one), ["bad", "control"]);
    assert.deepEqual(one.bad, { cases: 2, n: 2, passed: 1, passRate: wilson(1, 2) });
    assert.deepEqual(one.control, { cases: 2, n: 2, passed: 1, ungraded: 1, passRate: wilson(1, 1) });
    const multi = summarizeKinds(
      [
        { caseId: "a", kind: "guard", pass: true },
        { caseId: "a", kind: "guard", pass: true },
        { caseId: "b", kind: "guard", pass: false },
        { caseId: "b", kind: "guard", pass: true },
      ],
      2,
    )!;
    assert.equal(multi.guard!.passRate.p, 0.75);
    assert.ok(multi.guard!.passRate.lo >= 0.5 && multi.guard!.passRate.hi <= 1, JSON.stringify(multi.guard));
  });
});

describe("compareKinds", () => {
  const kinds = new Map<string, CaseKind>([
    ["bad-1", "bad"],
    ["bad-2", "bad"],
    ["bad-3", "bad"],
    ["guard-1", "guard"],
    ["guard-2", "guard"],
    ["ctl-1", "control"],
    ["ctl-2", "control"],
  ]);
  const a = new Map([
    ["bad-1", 0],
    ["bad-2", 0],
    ["bad-3", 1],
    ["guard-1", 1],
    ["guard-2", 1],
    ["ctl-1", 1],
    ["ctl-2", 1],
    ["plain", 1],
  ]);
  const b = new Map([
    ["bad-1", 1],
    ["bad-2", 0.5],
    ["bad-3", 1],
    ["guard-1", 1],
    ["guard-2", 0],
    ["ctl-1", 0],
    ["ctl-2", 2 / 3],
    ["plain", 0],
  ]);

  it("names fixed, still-failing and already-passing bad cases, broken guards and overcorrecting controls", () => {
    const r = compareKinds(kinds, a, b)!;
    const by = Object.fromEntries(r.kinds.map((k) => [k.kind, k]));
    assert.deepEqual(by.bad, { kind: "bad", paired: 3, a: 1 / 3, b: 2.5 / 3, fixed: ["bad-1"], stillFailing: ["bad-2"], passedBefore: ["bad-3"] });
    assert.deepEqual(by.guard!.broken, ["guard-2"]);
    assert.deepEqual(by.control!.broken, ["ctl-1"], "2/3 still passes by majority");
    assert.deepEqual(r.regressions, ["guard-2"]);
    assert.deepEqual(r.overcorrections, ["ctl-1"]);
    assert.ok(r.notes.some((n) => /^overcorrection: 1 control case\(s\) passed on A and fail on B: ctl-1$/.test(n)), r.notes.join("\n"));
    assert.ok(r.notes.some((n) => /^regression: 1 guard case\(s\)/.test(n)));
    assert.ok(r.notes.some((n) => /1 bad case\(s\) already passed on A, so they don't show the fix: bad-3/.test(n)));
    assert.ok(r.notes.some((n) => /1 of 3 bad case\(s\) still fail on B: bad-2/.test(n)));
  });

  it("is undefined when no paired case has a kind", () => {
    assert.equal(compareKinds(new Map([["x", "bad"]]), a, b), undefined);
  });
});

describe("checkAgainst", () => {
  it("reports a bad case that passes on the old variant and a guard or control that already fails there", () => {
    const r = checkAgainst(
      [
        { caseId: "bad-ok", kind: "bad", passes: 0, trials: 3 },
        { caseId: "bad-leaky", kind: "bad", passes: 1, trials: 3 },
        { caseId: "guard-ok", kind: "guard", passes: 1, trials: 1 },
        { caseId: "ctl-broken", kind: "control", passes: 2, trials: 3 },
        { caseId: "err", kind: "bad", passes: 0, trials: 0, error: "setup failed" },
      ],
      "old",
    );
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.cases.map((c) => [c.caseId, c.ok]),
      [
        ["bad-ok", true],
        ["bad-leaky", false],
        ["guard-ok", true],
        ["ctl-broken", false],
        ["err", false],
      ],
    );
    assert.match(r.cases[1]!.problem!, /^bad case passes on old \(1\/3\): it doesn't reproduce the failure it was written for$/);
    assert.match(r.cases[3]!.problem!, /^control case fails on old \(2\/3 pass\): it can't catch an overcorrection if it already fails$/);
    assert.match(r.cases[4]!.problem!, /couldn't run on old: setup failed/);
    assert.deepEqual(r.counts, { bad: { cases: 3, ok: 1 }, guard: { cases: 1, ok: 1 }, control: { cases: 1, ok: 0 } });
    assert.equal(checkAgainst([{ caseId: "x", kind: "bad", passes: 0, trials: 1 }], "old").ok, true);
  });
});

describe("exp run and exp compare split by kind", () => {
  // The old prompt answers literally; the new one "fixes" the bad cases by
  // always answering in words, which overcorrects on a control that wants digits.
  const ds = createDataset({
    name: "prompt-fix",
    cases: [
      { id: "bad-spell", input: { q: "spell 4", old: "4", fixed: "four" }, expected: "four", kind: "bad" },
      { id: "bad-spell-2", input: { q: "spell 7", old: "7", fixed: "seven" }, expected: "seven", kind: "bad" },
      { id: "guard-hello", input: { q: "hello", old: "hi", fixed: "hi" }, expected: "hi", kind: "guard" },
      { id: "ctl-digits", input: { q: "2+2 in digits", old: "4", fixed: "four" }, expected: "4", kind: "control" },
      { id: "plain", input: { q: "x", old: "x", fixed: "x" }, expected: "x" },
    ],
  });
  const oldTask = (input: unknown) => (input as { old: string }).old;
  const newTask = (input: unknown) => (input as { fixed: string }).fixed;

  it("stamps kinds on runs, splits the summary, and reports the overcorrection in compare", async () => {
    const A = await runExperiment({ name: "old", dataset: ds, task: oldTask, graders: [exactGrader()] });
    const B = await runExperiment({ name: "new", dataset: ds, task: newTask, graders: [exactGrader()] });
    assert.equal(A.runs.find((r) => r.caseId === "ctl-digits")!.kind, "control");
    assert.equal(A.runs.find((r) => r.caseId === "plain")!.kind, undefined);
    assert.equal(A.summary.kinds!.bad!.passed, 0);
    assert.equal(A.summary.kinds!.control!.passed, 1);
    assert.equal(B.summary.kinds!.bad!.passed, 2);
    assert.equal(B.summary.kinds!.control!.passed, 0);
    assert.match(renderExperiment(B, { color: false }), /^kinds {3}bad 100\.0% \(2\/2\) {2}guard 100\.0% \(1\/1\) {2}control 0\.0% \(0\/1\)$/m);

    const c = compareExperiments(A, B, { iters: 200 });
    assert.deepEqual(c.kinds!.overcorrections, ["ctl-digits"]);
    assert.deepEqual(c.kinds!.regressions, []);
    assert.deepEqual(c.kinds!.kinds.find((k) => k.kind === "bad")!.fixed, ["bad-spell", "bad-spell-2"]);
    const text = renderComparison(c, { color: false, a: A, b: B });
    assert.match(text, /kinds {3}bad 0\.0% → 100\.0% \(2\/2 fixed\) {2}guard 100\.0% → 100\.0% \(0\/1 broke\) {2}control 100\.0% → 0\.0% \(1\/1 broke\)/);
    assert.match(text, /! overcorrection: 1 control case\(s\) passed on A and fail on B: ctl-digits/);
  });

  it("leaves summaries and comparisons without kinds when no case has one", async () => {
    const plain = createDataset({ name: "plain", cases: [{ id: "a", input: { old: "x", fixed: "x" }, expected: "x" }] });
    const A = await runExperiment({ name: "a", dataset: plain, task: oldTask, graders: [exactGrader()] });
    assert.equal("kinds" in A.summary, false);
    assert.equal("kind" in A.runs[0]!, false);
    assert.equal("kinds" in compareExperiments(A, A, { iters: 50 }), false);
    assert.doesNotMatch(renderExperiment(A, { color: false }), /^kinds/m);
  });
});
