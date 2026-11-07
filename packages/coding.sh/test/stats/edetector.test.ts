// X-17: restart e-detector for iteration loops (Yin, Liu, Qi, arXiv 2610.04756).
//
// Reference values come from an independent float (not log-space) Python
// reimplementation of Alg. 1, run once on 2026-11-07 (Python 3, no packages):
//   zeros 10 × 200, ε .01:  aGRAPA alarm 4, ν̂ 1, M 29.729072502327707
//                           mixture alarm 5, ν̂ 1, M 21.418498561007606
//   degrading n 12, ε .05:  aGRAPA alarm 6, ν̂ 3, M 42.66969143798015
//                           mixture alarm 7, ν̂ 3, M 34.755870246048
// Hand check of the zeros case: round 1 bets λ0 0.2 → 200·log(1.002) = 0.3996;
// later rounds see X̄ 0 and σ̂² 0, so λ clips to 1/2 → 200·log(1.005) = 0.9975
// per round; log 20 = 2.9957 is crossed at round 4 by the restart from round 1.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEDetector, eDetector, mulberry32, plateauRoundsNeeded, type EBet } from "../../src/stats/index.ts";

const mk = (wins: number, losses: number, n: number) => [...Array(wins).fill(1), ...Array(losses).fill(-1), ...Array(n - wins - losses).fill(0)] as number[];
const near = (got: number, want: number, tol: number, what = "") => assert.ok(Math.abs(got - want) <= tol, `${what} ${got} vs ${want} ± ${tol}`);

const zeros = Array.from({ length: 10 }, () => mk(0, 0, 200));
// Two improving rounds (3 of 12 fixed), then every candidate breaks 2 of 12.
const degrading = [mk(3, 0, 12), mk(3, 0, 12), ...Array.from({ length: 10 }, () => mk(0, 2, 12))];

describe("eDetector: Alg. 1 known values", () => {
  it("a flat plateau of 200 items: aGRAPA alarms at round 4, mixture at 5, both return version 0", () => {
    const a = eDetector(zeros);
    assert.equal(a.alarmRound, 4);
    assert.equal(a.changePoint, 1);
    assert.equal(a.returnIndex, 0);
    near(Math.exp(a.logWealth), 29.729072502327707, 1e-9, "M");
    assert.equal(a.rounds, 4);
    assert.equal(a.ignored, 6);
    const m = eDetector(zeros, { bet: "mixture" });
    assert.equal(m.alarmRound, 5);
    assert.equal(m.changePoint, 1);
    assert.equal(m.returnIndex, 0);
    near(Math.exp(m.logWealth), 21.418498561007606, 1e-9, "M");
  });

  it("the n = 12, ε = 0.05 degrading series: alarm at 6 (aGRAPA) and 7 (mixture), return version 2", () => {
    const a = eDetector(degrading, { eps: 0.05 });
    assert.deepEqual([a.alarmRound, a.changePoint, a.returnIndex], [6, 3, 2]);
    near(Math.exp(a.logWealth), 42.66969143798015, 1e-9, "M");
    const m = eDetector(degrading, { eps: 0.05, bet: "mixture" });
    assert.deepEqual([m.alarmRound, m.changePoint, m.returnIndex], [7, 3, 2]);
    near(Math.exp(m.logWealth), 34.755870246048, 1e-9, "M");
  });

  it("steady gains never alarm", () => {
    for (const bet of ["agrapa", "mixture"] as EBet[]) {
      const r = eDetector(
        Array.from({ length: 60 }, () => mk(3, 1, 12)),
        { eps: 0.05, bet },
      );
      assert.equal(r.alarm, false, bet);
      assert.equal(r.rounds, 60);
      assert.ok(r.logWealth < r.logThreshold);
      assert.equal(r.returnIndex, undefined);
    }
  });

  it("incremental and batch agree round by round, and the detector freezes at the alarm", () => {
    for (const bet of ["agrapa", "mixture"] as EBet[]) {
      const d = createEDetector({ eps: 0.05, bet });
      degrading.forEach((round, i) => {
        const inc = d.push(round);
        const batch = eDetector(degrading.slice(0, i + 1), { eps: 0.05, bet });
        assert.deepEqual(inc, batch, `${bet} round ${i + 1}`);
      });
      const frozen = d.result();
      assert.equal(frozen.rounds, bet === "agrapa" ? 6 : 7);
      assert.equal(frozen.ignored, degrading.length - frozen.rounds);
    }
  });

  it("fractional diffs are allowed (e.g. per-item pass rates over trials)", () => {
    const r = eDetector(Array.from({ length: 30 }, () => Array(50).fill(-0.25)), { eps: 0.05 });
    assert.equal(r.alarm, true);
    assert.equal(r.changePoint, 1);
  });
});

describe("eDetector: average run length on a loop that still helps", () => {
  it("at E[X] = ε (the boundary), simulated mean run length is ≥ 1/δ = 20", () => {
    // n 12; each item +1 w.p. 0.15, −1 w.p. 0.10 → E[X] = 0.05 = ε. Runs are capped
    // at 150 rounds, which only lowers the estimate.
    for (const bet of ["agrapa", "mixture"] as EBet[]) {
      const rand = mulberry32(bet === "agrapa" ? 17 : 18);
      const runs = 100;
      let total = 0;
      for (let k = 0; k < runs; k++) {
        const d = createEDetector({ eps: 0.05, bet });
        let t = 0;
        while (t < 150 && !d.result().alarm) {
          d.push(
            Array.from({ length: 12 }, (): number => {
              const u = rand();
              return u < 0.15 ? 1 : u < 0.25 ? -1 : 0;
            }),
          );
          t++;
        }
        total += t;
      }
      assert.ok(total / runs >= 20, `${bet} mean run length ${total / runs}`);
    }
  });
});

describe("plateauRoundsNeeded (App. B)", () => {
  it("51 at n 12 and ε 0.01, 4 at n 200, 11 at n 12 and ε 0.05", () => {
    assert.equal(plateauRoundsNeeded(12, 0.01), 51);
    assert.equal(plateauRoundsNeeded(200, 0.01), 4);
    assert.equal(plateauRoundsNeeded(12, 0.05), 11);
  });
  it("is a floor: at n 12 and ε 0.01 a flat plateau of 50 rounds never alarms", () => {
    const r = eDetector(
      Array.from({ length: 50 }, () => mk(0, 0, 12)),
      { eps: 0.01 },
    );
    assert.equal(r.alarm, false);
  });
});

describe("eDetector: input checks", () => {
  it("throws RangeError on diffs outside [−1, 1] and bad options", () => {
    assert.throws(() => createEDetector().push([0, 2]), RangeError);
    assert.throws(() => createEDetector().push([-1.5]), RangeError);
    assert.throws(() => createEDetector().push([Number.NaN]), RangeError);
    assert.throws(() => createEDetector({ eps: 0 }), RangeError);
    assert.throws(() => createEDetector({ delta: 1 }), RangeError);
    assert.throws(() => createEDetector({ lambda0: 0.6 }), RangeError);
    assert.throws(() => createEDetector({ bet: "mixture", grid: [0.1, 0.7] }), RangeError);
    assert.throws(() => plateauRoundsNeeded(0, 0.01), RangeError);
  });
});
