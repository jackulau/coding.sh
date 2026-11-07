// Y-3: preservation report, 'alternative' status and the tie-break among keeps
// (EvoAudit, arXiv 2611.07624 §6.3-6.4).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alternativeCheck, preservation, rankKeeps, regressedTasks, type ArmOutcomes, type KeepCandidate } from "../../src/refine/keep.ts";

/** "110" → [true, true, false]. */
const runs = (spec: Record<string, string>): Map<string, boolean[]> => new Map(Object.entries(spec).map(([id, s]) => [id, [...s].map((c) => c === "1")]));
const arms = (base: Record<string, string>, cand: Record<string, string>): ArmOutcomes => ({ base: runs(base), cand: runs(cand) });

describe("preservation", () => {
  it("candidate gains t3 and loses t7 (2/3 → 0/3): lost-coverage 1, R counts the rate drop", () => {
    const heldOut = arms({ t1: "111", t3: "000", t7: "110", t9: "100" }, { t1: "111", t3: "011", t7: "000", t9: "100" });
    const p = preservation({ dev: arms({ d1: "000" }, { d1: "111" }), heldOut });
    assert.deepEqual(p.dev, { gained: ["d1"], lost: [], keptCovered: 0 });
    assert.deepEqual(p.heldOut, { gained: ["t3"], lost: ["t7"], keptCovered: 2 });
    assert.equal(p.basis, "heldOut");
    assert.deepEqual(p.regressed, ["t7"]);
    assert.equal(p.R, 1);
    assert.deepEqual(p.reasons, ["lost-coverage: 1 task"]);
  });

  it("reads dev when there is no held-out set; a partial drop counts in R but is not lost coverage", () => {
    const p = preservation({ dev: arms({ a: "111", b: "110", c: "000" }, { a: "100", b: "110", c: "000" }) });
    assert.equal(p.basis, "dev");
    assert.equal(p.heldOut, undefined);
    assert.deepEqual(p.regressed, ["a"]);
    assert.deepEqual(p.reasons, []);
  });

  it("skips tasks missing from either arm", () => {
    assert.deepEqual(regressedTasks(arms({ a: "111", b: "111" }, { a: "000" })), ["a"]);
  });
});

describe("alternativeCheck", () => {
  const dev = arms({ d: "000" }, { d: "111" });

  it("a reject with a unique held-out gain and no hard regression is an alternative, until a kept candidate covers the gain", () => {
    const heldOut = arms({ t1: "111", t2: "000", t3: "110" }, { t1: "111", t2: "011", t3: "000" });
    const alt = alternativeCheck({ k1: true, dev, heldOut, covered: [] });
    assert.equal(alt.alternative, true);
    assert.deepEqual(alt.uniqueGains, ["t2"]);
    const after = alternativeCheck({ k1: true, dev, heldOut, covered: ["t2"] });
    assert.equal(after.alternative, false);
    assert.deepEqual(after.why, ["every gained task is covered by a kept candidate"]);
  });

  it("t7 3/3 → 0/3 is a hard regression: a reject, not an alternative", () => {
    const heldOut = arms({ t2: "000", t7: "111" }, { t2: "111", t7: "000" });
    const r = alternativeCheck({ k1: true, dev, heldOut, covered: [] });
    assert.equal(r.alternative, false);
    assert.deepEqual(r.hardRegressions, ["t7"]);
    assert.deepEqual(r.why, ["hard-regression: t7"]);
  });

  it("needs K1 and a gain", () => {
    const heldOut = arms({ t1: "111" }, { t1: "111" });
    assert.deepEqual(alternativeCheck({ k1: false, dev, heldOut, covered: [] }).why, ["K1 failed", "gained no task"]);
  });
});

describe("rankKeeps", () => {
  const cand = (id: string, mean: number, R: number, cost?: KeepCandidate["cost"]): KeepCandidate => ({ id, effect: { mean, lo: mean - 0.1, hi: mean + 0.1 }, R, ...(cost ? { cost } : {}) });
  const cost = (candUsd: number | undefined, solved = 10): KeepCandidate["cost"] => ({ base: { usd: 1, solved: 8 }, cand: { usd: candUsd, solved } });

  it("overlapping intervals with R=1 vs R=4: the R=1 candidate, even with the smaller effect", () => {
    const r = rankKeeps([cand("big", 0.35, 4), cand("small", 0.3, 1)]);
    assert.equal(r.winner, "small");
    assert.equal(r.reason, "tied on effect; fewer per-task regressions 1 vs 4");
    assert.deepEqual(r.tied, ["big"]);
    assert.deepEqual(r.hints, ["compose with big? needs its own trial (K6)"]);
  });

  it("equal R: lower cost per solved task; cost ignored when either arm lacks USD", () => {
    const r = rankKeeps([cand("a", 0.3, 1, cost(4)), cand("b", 0.32, 1, cost(2))]);
    assert.equal(r.winner, "b");
    assert.equal(r.reason, "tied on effect and regressions; lower cost per solved task $0.20 vs $0.40");
    const noUsd = rankKeeps([cand("a", 0.3, 1, cost(4)), cand("b", 0.32, 1, cost(undefined))]);
    assert.equal(noUsd.winner, "a", "falls through to id");
    assert.equal(noUsd.reason, "tied on effect, regressions; first by id");
  });

  it("separated intervals: the larger effect wins whatever R says", () => {
    const r = rankKeeps([cand("a", 0.1, 0), cand("b", 0.5, 5)]);
    assert.deepEqual(r.order, ["b", "a"]);
    assert.match(r.reason, /^largest dev effect 0\.50 vs 0\.10/);
    assert.deepEqual(r.tied, []);
  });

  it("is deterministic on full ties, whatever the input order", () => {
    const xs = [cand("c", 0.3, 1), cand("a", 0.3, 1), cand("b", 0.3, 1)];
    assert.deepEqual(rankKeeps(xs).order, ["a", "b", "c"]);
    assert.deepEqual(rankKeeps([...xs].reverse()).order, ["a", "b", "c"]);
    assert.equal(rankKeeps([cand("only", 0.2, 0)]).reason, "the only keep");
    assert.throws(() => rankKeeps([]), /no candidates/);
  });
});
