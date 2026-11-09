// AB-13: cross-judge replication over pairwise summaries (pure, synthetic PairCase arrays).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CalibrationStatus } from "../../src/datasets/types.ts";
import type { PairWinner } from "../../src/judge/pairwise.ts";
import { summarizePairwise, type PairCase, type PairwiseSummary } from "../../src/experiments/pairwise.ts";
import { judgeHold, replicatePairwise } from "../../src/experiments/replicate.ts";
import { renderReplication } from "../../src/experiments/render.ts";
import { cohenKappa } from "../../src/stats/agreement.ts";

const pc = (caseId: string, winner: PairWinner): PairCase => ({ caseId, winner, orders: [winner, winner], consistent: true, reasons: [undefined, undefined], cached: false });
/** n cases; pick(i) decides each winner. */
const judge = (id: string, n: number, pick: (i: number) => PairWinner, calibration?: CalibrationStatus, from = 0): PairwiseSummary =>
  summarizePairwise(
    Array.from({ length: n }, (_, i) => pc(`c${String(from + i).padStart(3, "0")}`, pick(from + i))),
    { id, ...(calibration ? { calibration } : {}) },
    undefined,
    { iters: 1000 },
  );
const better = (i: number): PairWinner => (i % 4 === 3 ? "tie" : i % 10 === 0 ? "a" : "b");
const worse = (i: number): PairWinner => (i % 4 === 3 ? "tie" : i % 10 === 0 ? "b" : "a");
const coin = (i: number): PairWinner => (i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "tie");
const meta = (id: string, provider = id) => ({ id, provider, model: `${id}-model` });
const calibrated: CalibrationStatus = { state: "calibrated", kappa: 0.7, n: 40 };
const failed: CalibrationStatus = { state: "uncalibrated", kappa: 0.1, n: 40 };

describe("replicatePairwise", () => {
  it("two judges that both find B better: replicated-better, no hold", () => {
    const r = replicatePairwise([judge("j1", 60, better, calibrated), judge("j2", 60, better)], [meta("j1", "openai"), meta("j2", "anthropic")]);
    assert.equal(r.judges[0]!.verdict, "better");
    assert.equal(r.conclusion, "replicated-better");
    assert.deepEqual(r.providers, ["openai", "anthropic"]);
    assert.deepEqual(r.screened, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.agreement.length, 1);
    assert.equal(r.agreement[0]!.kappa, 1);
    assert.equal(judgeHold(r), undefined);
    const text = renderReplication(r, { color: false });
    assert.match(text, /^judges {2}2 pairwise judges, 2 providers$/m);
    assert.match(text, /^agree {3}j1 vs j2: κ 1\.00, 100\.0% same winner \(60 shared cases\)$/m);
    assert.match(text, /^judges {2}replicated-better$/m);
  });

  it("one better and one worse: judges-disagree, and the gate holds naming both", () => {
    const r = replicatePairwise([judge("j1", 60, better), judge("j2", 60, worse)], [meta("j1", "openai"), meta("j2", "anthropic")]);
    assert.equal(r.conclusion, "judges-disagree");
    const h = judgeHold(r)!;
    assert.equal(h.conclusion, "judges-disagree");
    assert.equal(h.detail, "j1 prefers B, j2 prefers A");
    assert.ok(r.warnings.some((w) => /agree poorly case by case \(κ -?\d\.\d\d < 0\.4 over 60 shared cases\)/.test(w)));
    assert.ok(r.warnings.some((w) => /no judge is calibrated/.test(w)));
  });

  it("better + inconclusive is unresolved and holds; all worse is replicated-worse", () => {
    const u = replicatePairwise([judge("j1", 60, better), judge("j2", 60, coin)], [meta("j1", "x"), meta("j2", "y")]);
    assert.equal(u.judges[1]!.verdict, "inconclusive");
    assert.equal(u.conclusion, "unresolved");
    assert.equal(judgeHold(u)?.detail, "1 of 2 judges found B better; replication needs every one");
    const w = replicatePairwise([judge("j1", 60, worse), judge("j2", 60, worse)], [meta("j1", "x"), meta("j2", "y")]);
    assert.equal(w.conclusion, "replicated-worse");
    assert.equal(judgeHold(w)?.detail, "j1, j2 prefer A");
  });

  it("a judge whose calibration failed is screened out of the conclusion", () => {
    const r = replicatePairwise([judge("j1", 60, better, calibrated), judge("j2", 60, worse, failed), judge("j3", 60, better)], [meta("j1", "a"), meta("j2", "b"), meta("j3", "c")]);
    assert.deepEqual(r.screened, ["j2"]);
    assert.equal(r.judges[1]!.calibration, "failed");
    assert.equal(r.conclusion, "replicated-better");
    assert.equal(judgeHold(r), undefined);
    assert.ok(r.warnings.some((w) => /judge j2 failed its calibration/.test(w)));
    assert.match(renderReplication(r, { color: false }), /worse \(screened out\)/);
    // Never measured is not failed.
    assert.equal(replicatePairwise([judge("j", 10, better, { state: "uncalibrated", reason: "never" })], [meta("j")]).screened.length, 0);
  });

  it("same-provider judges always warn, even when they agree", () => {
    const r = replicatePairwise([judge("j1", 60, better, calibrated), judge("j2", 60, better, calibrated)], [meta("j1", "openai"), meta("j2", "openai")]);
    assert.equal(r.conclusion, "replicated-better");
    assert.deepEqual(r.providers, ["openai"]);
    assert.deepEqual(r.warnings, ["judges j1, j2 share provider openai: they can share its blind spots, so their agreement is weaker evidence than two providers'"]);
  });

  it("κ equals cohenKappa over the shared cases only (partial overlap: n is the intersection)", () => {
    const s1 = judge("j1", 50, better);
    const s2 = judge("j2", 50, coin, undefined, 20); // c020..c069; shares c020..c049
    const r = replicatePairwise([s1, s2], [meta("j1"), meta("j2")]);
    const shared = s1.cases.filter((c) => s2.cases.some((d) => d.caseId === c.caseId));
    assert.equal(r.agreement[0]!.n, 30);
    const k = cohenKappa(
      shared.map((c) => c.winner),
      shared.map((c) => s2.cases.find((d) => d.caseId === c.caseId)!.winner),
      ["a", "b", "tie"],
    );
    assert.equal(r.agreement[0]!.kappa, k.kappa);
    assert.equal(r.agreement[0]!.percentAgreement, k.agreement);
  });

  it("one judge: unresolved, no warnings of its own; only a worse verdict holds", () => {
    const one = replicatePairwise([judge("j1", 60, better)], [meta("j1")]);
    assert.equal(one.conclusion, "unresolved");
    assert.deepEqual(one.warnings, []);
    assert.equal(judgeHold(one), undefined);
    assert.equal(judgeHold(replicatePairwise([judge("j1", 60, worse)], [meta("j1")]))?.detail, "j1 prefers A");
    assert.throws(() => replicatePairwise([judge("j1", 5, better)], []), RangeError);
  });
});
