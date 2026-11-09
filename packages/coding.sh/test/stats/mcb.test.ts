// EM-7: "plausibly best" set by paired-bootstrap multiple comparisons with the best.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bestSet, formatBestSet, mulberry32, type BestSetArm } from "../../src/stats/index.ts";

/** Per-case pass/fail for arms with these true rates; cases share a difficulty, so arms are correlated. */
function simulate(rates: readonly number[], n: number, rand: () => number): BestSetArm[] {
  const shift = Array.from({ length: n }, () => (rand() - 0.5) * 0.4);
  return rates.map((p, a) => ({ name: `c${a}`, scores: shift.map((s) => (rand() < Math.min(1, Math.max(0, p + s)) ? 1 : 0)) }));
}

describe("bestSet", () => {
  it("a seeded 5-arm simulation covers the true best at ≥ 95%", () => {
    const rand = mulberry32(42);
    const reps = 300;
    for (const rates of [
      [0.6, 0.56, 0.52, 0.48, 0.44],
      [0.5, 0.5, 0.45, 0.4, 0.3],
    ]) {
      const top = Math.max(...rates);
      let covered = 0;
      let checks = 0;
      for (let r = 0; r < reps; r++) {
        const s = bestSet(simulate(rates, 60, rand), { iters: 400, seed: r });
        rates.forEach((p, a) => {
          if (p !== top) return;
          checks++;
          if (s.best.includes(`c${a}`)) covered++;
        });
      }
      assert.ok(covered / checks >= 0.95, `coverage ${covered / checks} for ${rates}`);
    }
  });

  it("clear separation gives a singleton set", () => {
    const rand = mulberry32(5);
    const s = bestSet(simulate([0.9, 0.5, 0.45, 0.4, 0.3], 100, rand));
    assert.deepEqual(s.best, ["c0"]);
    assert.match(formatBestSet(s), /^best: c0 \(clearly ahead/);
  });

  it("identical arms all stay in the set", () => {
    const xs = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0];
    const s = bestSet([
      { name: "a", scores: xs },
      { name: "b", scores: xs },
      { name: "c", scores: xs },
    ]);
    assert.deepEqual(s.best, ["a", "b", "c"]);
    assert.match(formatBestSet(s), /^plausibly best \(95%, 10 shared cases\): a, b, c$/);
  });

  it("drops cases any arm is missing, orders by mean, and is deterministic per seed", () => {
    const arms = [
      { name: "low", scores: [0, 0, 1, NaN, 0, 0, 1, 0] },
      { name: "high", scores: [1, 1, 1, 1, 1, 0, 1, 1] },
    ];
    const s = bestSet(arms, { seed: 9 });
    assert.equal(s.n, 7);
    assert.equal(s.rows[0]!.mean, 2 / 7);
    assert.equal(s.best[0], "high");
    assert.deepEqual(s, bestSet(arms, { seed: 9 }));
    assert.ok(s.rows[1]!.gap < 0 && s.rows[1]!.inSet);
  });

  it("edge cases: no arms, one arm, no shared case", () => {
    assert.deepEqual(bestSet([]).best, []);
    assert.deepEqual(bestSet([{ name: "a", scores: [1] }]).best, ["a"]);
    const none = bestSet([
      { name: "a", scores: [1, NaN] },
      { name: "b", scores: [NaN, 0] },
    ]);
    assert.deepEqual(none.best, []);
    assert.match(formatBestSet(none), /none/);
    assert.throws(() => bestSet([{ name: "a", scores: [1] }], { alpha: 1 }), RangeError);
  });
});
