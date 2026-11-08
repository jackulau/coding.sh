// Multi-objective acceptance for `refine run --suite` (src/refine/objectives.ts):
// keep on quality, keep on efficiency with quality held, and never keep a
// cheaper or faster candidate whose pass rate fell beyond the margin.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { climbFront, climbPlateau, frontKey, judgeObjectives, parseObjectives, parseShare, taskGains, type ClimbRound, type RunPoint, type TaskPair } from "../../src/refine/objectives.ts";

/** k runs of one arm: `passes` of them pass, each with this cost and wall time. */
const runs = (k: number, passes: number, m: Omit<RunPoint, "pass"> = {}): RunPoint[] => Array.from({ length: k }, (_, i) => ({ pass: i < passes, ...m }));

/** n tasks, both arms 3 runs. */
function suite(n: number, base: (i: number) => RunPoint[], cand: (i: number) => RunPoint[]): TaskPair[] {
  return Array.from({ length: n }, (_, i) => ({ task: `t${i}`, base: base(i), cand: cand(i) }));
}

const opts = { margin: 0.05, minGain: 0.1, seed: 7 };

describe("judgeObjectives", () => {
  it("keeps a cheaper and faster candidate whose pass rate holds (efficiency branch)", () => {
    const pairs = suite(8, (i) => runs(3, 3, { cost: 0.1 + i * 0.01, wall: 20_000 }), (i) => runs(3, 3, { cost: (0.1 + i * 0.01) * 0.6, wall: 14_000 }));
    const d = judgeObjectives(pairs, { ...opts, objectives: ["cost", "wall"] });
    assert.equal(d.verdict, "keep");
    assert.equal(d.branch, "efficiency");
    const cost = d.metrics.find((m) => m.objective === "cost")!;
    assert.ok(Math.abs(cost.relative + 0.4) < 1e-9, `relative ${cost.relative}`);
    assert.ok(cost.better && !cost.worse);
    assert.ok(cost.p! < 0.05);
    assert.equal(d.quality.nonInferior, true);
    assert.match(d.reasons[0]!, /^cost \/ run -40%/);
    assert.deepEqual(d.warnings, []);
    // The e-detector's per-task gains are the primary objective's relative cut.
    for (const g of d.gains) assert.ok(Math.abs(g - 0.4) < 1e-9);
  });

  it("rejects a much cheaper candidate that loses quality beyond the margin", () => {
    // Half the cost, but 4 of 8 tasks go from 3/3 to 2/3: pass rate falls ~17 pts.
    const pairs = suite(8, () => runs(3, 3, { cost: 0.2 }), (i) => runs(3, i < 4 ? 2 : 3, { cost: 0.1 }));
    const d = judgeObjectives(pairs, { ...opts, objectives: ["cost"] });
    assert.equal(d.verdict, "reject");
    assert.equal(d.branch, undefined);
    assert.equal(d.quality.nonInferior, false);
    assert.ok(d.metrics[0]!.better, "the cost cut itself is significant");
    assert.match(d.reasons[0]!, /^quality fell/);
    assert.match(d.reasons[1]!, /but a gain that costs quality is not kept/);
    // The gains are capped by the pass-rate drop, so the climb does not count it as progress.
    assert.ok(d.gains.slice(0, 4).every((g) => g < 0));
  });

  it("holds a cheaper candidate whose quality is even on average but unproven, and says so", () => {
    // Base 2/3 on every task; candidate 3/3 on half and 1/3 on half: the mean
    // pass-rate difference is 0, but the spread is wide, so the lower bound
    // dips past the margin. The cost cut is real; the hold is a data problem.
    const pairs = suite(8, () => runs(3, 2, { cost: 0.2 }), (i) => runs(3, i < 4 ? 3 : 1, { cost: 0.1 }));
    const d = judgeObjectives(pairs, { ...opts, objectives: ["cost"] });
    assert.equal(d.verdict, "inconclusive");
    assert.equal(d.branch, undefined);
    assert.ok(d.quality.mean >= 0, `mean ${d.quality.mean}`);
    assert.equal(d.quality.nonInferior, false);
    assert.ok(d.metrics[0]!.better, "the cost cut itself is significant");
    assert.deepEqual(d.quality.regressions, []);
    // Not framed as a quality loss: the real reason is the wide interval.
    assert.match(d.reasons[0]!, /^quality not shown to hold/);
    assert.ok(!d.reasons.some((r) => /a gain that costs quality is not kept/.test(r)), "does not claim the gain cost quality");
    assert.match(d.reasons[1]!, /quality interval is too wide to adopt it within the margin at 8 tasks: add tasks or trials/);
    assert.match(d.warnings.join("\n"), /quality lower bound .* below the −5\.0 pt margin.*add tasks or trials/);
  });

  it("rejects on a hard regression even when everything else improves", () => {
    const pairs = suite(8, () => runs(3, 3, { cost: 0.2 }), (i) => runs(3, i === 0 ? 0 : 3, { cost: 0.1 }));
    const d = judgeObjectives(pairs, { ...opts, objectives: ["cost"], margin: 0.5 });
    assert.equal(d.verdict, "reject");
    assert.deepEqual(d.quality.regressions, ["t0"]);
    assert.match(d.reasons[0]!, /hard regression/);
  });

  it("rejects when a listed objective gets significantly worse", () => {
    const pairs = suite(8, () => runs(3, 3, { cost: 0.1, wall: 10_000 }), () => runs(3, 3, { cost: 0.05, wall: 20_000 }));
    const d = judgeObjectives(pairs, { ...opts, objectives: ["cost", "wall"] });
    assert.equal(d.verdict, "reject");
    assert.match(d.reasons[0]!, /^worse on wall time \/ run/);
  });

  it("keeps on quality when the pass rate is significantly better", () => {
    const pairs = suite(8, () => runs(3, 1), () => runs(3, 3));
    const d = judgeObjectives(pairs, { ...opts, objectives: ["pass"] });
    assert.equal(d.verdict, "keep");
    assert.equal(d.branch, "quality");
    assert.ok(d.quality.p < 0.05);
  });

  it("follows the acceptance gate: don't-ship rejects, ship keeps", () => {
    const same = suite(8, () => runs(3, 2), () => runs(3, 2));
    assert.equal(judgeObjectives(same, { ...opts, objectives: ["pass"], gate: "dont-ship" }).verdict, "reject");
    const kept = judgeObjectives(same, { ...opts, objectives: ["pass"], gate: "ship" });
    assert.equal(kept.verdict, "keep");
    assert.equal(kept.branch, "quality");
  });

  it("is inconclusive when quality holds and nothing got cheaper by the minimum gain", () => {
    const pairs = suite(8, () => runs(3, 3, { cost: 0.1 }), () => runs(3, 3, { cost: 0.095 }));
    const d = judgeObjectives(pairs, { ...opts, objectives: ["cost"] });
    assert.equal(d.verdict, "inconclusive");
    assert.match(d.reasons[0]!, /nothing listed got significantly better by 10%/);
  });

  it("warns below 5 tasks, where no one-sided test can reach significance", () => {
    const pairs = suite(4, () => runs(3, 3, { cost: 0.2 }), () => runs(3, 3, { cost: 0.1 }));
    const d = judgeObjectives(pairs, { ...opts, objectives: ["cost"] });
    assert.equal(d.verdict, "inconclusive");
    assert.match(d.warnings[0]!, /^4 paired tasks: below 5/);
    assert.equal(d.metrics[0]!.better, false);
  });

  it("does not decide on a measure most runs did not report", () => {
    const pairs = suite(8, () => runs(3, 3, { wall: 10_000 }), () => runs(3, 3, { wall: 5_000 }));
    const d = judgeObjectives(pairs, { ...opts, objectives: ["cost"] });
    assert.equal(d.verdict, "inconclusive");
    assert.match(d.warnings.join("\n"), /cost \/ run: reported by 0% \/ 0% of runs/);
  });

  it("judges size from the byte counts and keeps a smaller file of equal quality", () => {
    const pairs = suite(6, () => runs(2, 2), () => runs(2, 2));
    const d = judgeObjectives(pairs, { ...opts, objectives: ["size"], size: { base: 4000, cand: 1000 } });
    assert.equal(d.verdict, "keep");
    assert.equal(d.branch, "efficiency");
    assert.equal(d.metrics[0]!.relative, -0.75);
    assert.deepEqual(taskGains(pairs, "size", { base: 4000, cand: 1000 }), Array(6).fill(0.75));
  });

  it("is inconclusive when no task ran in both arms", () => {
    const d = judgeObjectives([{ task: "a", base: runs(2, 2), cand: [] }], { ...opts, objectives: ["cost"] });
    assert.equal(d.verdict, "inconclusive");
    assert.deepEqual(d.reasons, ["no task ran in both arms"]);
  });
});

describe("parseObjectives and parseShare", () => {
  it("reads lists, aliases and duplicates", () => {
    assert.deepEqual(parseObjectives(["cost,time", "quality", "llm-time", "cost"]), ["cost", "wall", "pass", "llm"]);
    assert.throws(() => parseObjectives(["speed"]), /unknown objective "speed"/);
  });

  it("reads points, percents and fractions", () => {
    assert.equal(parseShare("2pp", "--margin"), 0.02);
    assert.equal(parseShare("10%", "--min-gain"), 0.1);
    assert.equal(parseShare("0.05", "--margin"), 0.05);
    assert.equal(parseShare("5", "--margin"), 0.05);
    assert.throws(() => parseShare("lots", "--margin"), /--margin must be a share/);
    assert.throws(() => parseShare("100%", "--margin"), /between 0 and 100%/);
  });
});

describe("the climb across rounds", () => {
  const round = (i: number, kept: boolean, pass: number, cost: number, gains: number[]): ClimbRound => ({ id: `r_${i}`, round: i, kept, base: { pass: 1, cost: 1 }, cand: { pass, cost }, gains });

  it("keeps undominated versions on the front", () => {
    const rounds = [round(1, true, 1, 0.6, []), round(2, false, 0.7, 0.3, []), round(3, false, 0.9, 0.7, [])];
    const { points, front } = climbFront(rounds, "cost");
    assert.deepEqual(points.map((p) => p.id), ["base", "r_1", "r_2", "r_3"]);
    // r_1 dominates the base (same pass, lower cost) and r_3; r_2 is cheaper but worse.
    assert.deepEqual(front.map((p) => p.id), ["r_1", "r_2"]);
    assert.equal(frontKey("pass", rounds), "cost");
    assert.equal(frontKey("wall", rounds), "wall");
  });

  it("alarms after a run of flat rounds and names the version to keep", () => {
    const flat = Array(8).fill(0);
    const rounds = [round(1, true, 1, 0.5, Array(8).fill(0.5)), ...Array.from({ length: 30 }, (_, i) => round(i + 2, false, 1, 0.5, flat))];
    const p = climbPlateau(rounds);
    assert.equal(p.status, "stop");
    assert.equal(p.keep, "r_1");
    assert.ok(p.floor && p.floor > 1);
    assert.equal(climbPlateau([]).status, "insufficient");
    assert.equal(climbPlateau(rounds.slice(0, 2)).status, "continue");
  });
});
