// AB-14: direction stability and n* (arXiv 2611.04090, H3).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CalibrationStatus } from "../../src/datasets/types.ts";
import { summarizePairwise, type PairCase } from "../../src/experiments/pairwise.ts";
import { renderPairwise } from "../../src/experiments/render.ts";
import { directionStability, stabilityLine } from "../../src/experiments/stability.ts";

const vals = (b: number, a: number, ties = 0) => [...Array(b).fill(0.5), ...Array(a).fill(-0.5), ...Array(ties).fill(0)] as number[];

describe("directionStability", () => {
  it("is deterministic per seed", () => {
    const x = vals(60, 40, 20);
    assert.deepEqual(directionStability(x, { seed: 3 }), directionStability(x, { seed: 3 }));
    assert.notDeepEqual(directionStability(x, { seed: 3 }).bySize, directionStability(x, { seed: 4 }).bySize);
  });

  it("all B wins: share 1, n* the smallest size, stable", () => {
    const s = directionStability(vals(120, 0));
    assert.equal(s.direction, "b");
    assert.equal(s.share, 1);
    assert.equal(s.nStar, 25);
    assert.equal(s.stable, true);
    assert.deepEqual(
      s.bySize.map((x) => x.m),
      [25, 50, 100, 120],
    );
    assert.equal(stabilityLine(s), "stable  B better in 100% of resamples (n*=25)");
  });

  it("50/50: no direction, share ≈ 0.5, censored, unstable", () => {
    const s = directionStability(vals(100, 100));
    assert.equal(s.direction, "none");
    assert.ok(Math.abs(s.share - 0.5) < 0.06, `share ${s.share}`);
    assert.equal(s.nStar, "censored");
    assert.equal(s.stable, false);
    assert.match(stabilityLine(s), /^unstable {2}no direction in \d+% of resamples \(n\* censored\)$/);
  });

  it("a strong effect (win rate 0.65 vs 0.35 at n 200) settles by n* ≤ 50", () => {
    const s = directionStability(vals(130, 70));
    assert.equal(s.direction, "b");
    assert.ok(typeof s.nStar === "number" && s.nStar <= 50, `n* ${s.nStar}`);
    assert.equal(s.stable, true);
  });

  it("A ahead reads as direction a", () => {
    const s = directionStability(vals(10, 90));
    assert.equal(s.direction, "a");
    assert.equal(s.stable, true);
    assert.match(stabilityLine(s), /^stable {2}A better in 100% of resamples \(n\*=25\)$/);
  });

  it("sizes above n are skipped, and the full n always runs", () => {
    const s = directionStability(vals(30, 10), { sizes: [10, 25, 50, 100] });
    assert.deepEqual(
      s.bySize.map((x) => x.m),
      [10, 25, 40],
    );
  });

  it("empty input: no direction, share NaN, censored, unstable", () => {
    const s = directionStability([]);
    assert.deepEqual([s.direction, s.bySize.length, s.nStar, s.stable], ["none", 0, "censored", false]);
    assert.ok(Number.isNaN(s.share));
    assert.match(stabilityLine(s), /^unstable {2}no direction in — of resamples/);
  });

  it("cluster resampling keeps clusters whole: equal-valued clusters match one value per cluster", () => {
    // 40 clusters of 5 identical values vs the 40 values alone: same draws, same means, same shares.
    const one = vals(26, 14);
    const ids = one.flatMap((_, i) => Array(5).fill(`c${i}`) as string[]);
    const many = one.flatMap((v) => Array(5).fill(v) as number[]);
    const a = directionStability(one, { seed: 9 });
    const b = directionStability(many, { seed: 9, clusterIds: ids });
    assert.deepEqual(b.bySize, a.bySize);
    assert.equal(b.nStar, a.nStar);
    // Treating the 200 correlated values as independent overstates stability.
    const naive = directionStability(many, { seed: 9 });
    assert.ok(naive.share > b.share, `naive ${naive.share} vs clustered ${b.share}`);
  });

  it("rejects mismatched cluster ids", () => {
    assert.throws(() => directionStability([1, 2], { clusterIds: ["a"] }), RangeError);
  });
});

describe("summarizePairwise: stability and its warnings", () => {
  const pc = (i: number, winner: "a" | "b" | "tie"): PairCase => ({
    caseId: `c${String(i).padStart(3, "0")}`,
    winner,
    orders: [winner, winner],
    consistent: true,
    reasons: [undefined, undefined],
    cached: false,
  });
  const cases = (b: number, a: number, ties: number) => [
    ...Array.from({ length: b }, (_, i) => pc(i, "b")),
    ...Array.from({ length: a }, (_, i) => pc(b + i, "a")),
    ...Array.from({ length: ties }, (_, i) => pc(a + b + i, "tie")),
  ];
  const calibrated: CalibrationStatus = { state: "calibrated", kappa: 0.8, n: 40 };

  it("a calibrated judge with a clear winner: stable, no stability warnings, a dim line", () => {
    const s = summarizePairwise(cases(40, 5, 5), { id: "j", calibration: calibrated });
    assert.equal(s.stability.stable, true);
    assert.equal(s.warnings.length, 0, s.warnings.join("\n"));
    assert.match(renderPairwise(s, { color: false }), /^stable {2}B better in 100% of resamples \(n\*=25\)$/m);
  });

  it("a calibrated judge, inconclusive and unstable: 'more cases help', not 'unresolved'", () => {
    const s = summarizePairwise(cases(9, 6, 15), { id: "j", calibration: calibrated });
    assert.equal(s.verdict, "inconclusive");
    assert.equal(s.stability.stable, false);
    assert.match(s.warnings.join("\n"), /B's lead held in only \d+% of resamples at n=30; more cases help only if the judge is calibrated/);
    assert.ok(!/unresolved/.test(s.warnings.join("\n")));
  });

  it("an uncalibrated judge that never settles: 'unresolved'", () => {
    const s = summarizePairwise(cases(9, 6, 15), { id: "j", calibration: { state: "uncalibrated", kappa: 0.2 } });
    assert.match(s.warnings.join("\n"), /unresolved: pick or calibrate the judge before collecting more verdicts/);
  });

  it("clustered summaries resample clusters", () => {
    const cs = cases(20, 10, 0);
    const of = new Map(cs.map((c, i) => [c.caseId, `r${i % 6}`]));
    const s = summarizePairwise(cs, { id: "j", calibration: calibrated }, undefined, { cluster: { key: "repo", of } });
    assert.deepEqual(
      s.stability.bySize.map((x) => x.m),
      [6],
    );
  });
});
