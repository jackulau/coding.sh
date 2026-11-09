// AG-17: REUSE certified-promotion budget (arXiv 2609.33180v2).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clopperPearsonLower,
  minCleanWins,
  mulberry32,
  pairedLcb,
  passFailLcb,
  reuseDelta,
  reuseDirect,
  reuseLogDelta,
  reuseMde,
  reuseRound,
  reuseRoundWeight,
  reusePromotionWeight,
  reuseSchedule,
  signP,
  type ReuseState,
  type ReuseWeights,
} from "../../src/stats/index.ts";

const rel = (a: number, b: number, eps: number) => assert.ok(Math.abs(a - b) <= eps * Math.abs(b), `${a} ≉ ${b} (rel ${eps})`);
const abs = (a: number, b: number, eps: number) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b} (±${eps})`);
const H: ReuseWeights = { kind: "harmonic" };

function lchoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

describe("reuseDelta", () => {
  it("matches the hand-computed budget (α 0.05, K 1)", () => {
    rel(reuseDelta({ alpha: 0.05, t: 1, p: 0, K: 1, weights: H }), 0.0125, 1e-12);
    rel(reuseDelta({ alpha: 0.05, t: 3, p: 1, K: 1, weights: H }), 0.05 / 144, 1e-12);
    abs(reuseDelta({ alpha: 0.05, t: 3, p: 1, K: 1, weights: H }), 3.4722e-4, 1e-8);
    abs(reuseDelta({ alpha: 0.05, t: 5, p: 2, K: 1, weights: H }), 2.3148e-5, 1e-9);
    const T5: ReuseWeights = { kind: "horizon", rounds: 5 };
    abs(reuseDelta({ alpha: 0.05, t: 5, p: 2, K: 1, weights: T5 }), 1.3889e-4, 1e-8);
    assert.equal(reuseDelta({ alpha: 0.05, t: 6, p: 2, K: 1, weights: T5 }), 0);
  });

  it("minCleanWins at ρ 0.5: 8, 13, 17", () => {
    assert.equal(minCleanWins(0.5 * reuseDelta({ alpha: 0.05, t: 1, p: 0, K: 1, weights: H })), 8);
    assert.equal(minCleanWins(0.5 * reuseDelta({ alpha: 0.05, t: 3, p: 1, K: 1, weights: H })), 13);
    assert.equal(minCleanWins(0.5 * reuseDelta({ alpha: 0.05, t: 5, p: 2, K: 1, weights: H })), 17);
    // n clean wins give signP = 2^-n, which passes exactly when n ≥ minCleanWins.
    const th = 0.5 * reuseDelta({ alpha: 0.05, t: 3, p: 1, K: 1, weights: H });
    assert.ok(signP(13, 13) <= th && signP(12, 12) > th);
  });

  it("the weights sum to ≤ 1 and the union bound spends exactly α·Σ w_t·Σ v_p ≤ α (K 1, 2, 8; t ≤ 300)", () => {
    let wsum = 0;
    for (let t = 1; t <= 300; t++) wsum += reuseRoundWeight(t, H);
    assert.ok(wsum <= 1);
    let vsum = 0;
    for (let p = 0; p < 300; p++) vsum += reusePromotionWeight(p);
    assert.ok(vsum <= 1);
    const T: ReuseWeights = { kind: "horizon", rounds: 40 };
    let hsum = 0;
    for (let t = 1; t <= 300; t++) hsum += reuseRoundWeight(t, T);
    rel(hsum, 1, 1e-12);
    for (const K of [1, 2, 8]) {
      let spent = 0;
      let want = 0;
      for (let t = 1; t <= 300; t++) {
        let inner = 0;
        for (let p = 0; p < t; p++) {
          spent += Math.exp(lchoose(t - 1, p) + (p + 1) * Math.log(K) + reuseLogDelta({ alpha: 0.05, t, p, K, weights: H }));
          inner += reusePromotionWeight(p);
        }
        want += 0.05 * reuseRoundWeight(t, H) * inner;
      }
      rel(spent, want, 1e-12);
      assert.ok(spent <= 0.05);
    }
  });

  it("t = 500 does not overflow", () => {
    const l = reuseLogDelta({ alpha: 0.05, t: 500, p: 250, K: 8, weights: H });
    assert.ok(Number.isFinite(l) && l < 0);
    assert.ok(reuseDelta({ alpha: 0.05, t: 500, p: 3, K: 2, weights: H }) > 0);
  });

  it("RangeError on bad inputs", () => {
    assert.throws(() => reuseDelta({ alpha: 0, t: 1, p: 0, K: 1, weights: H }), RangeError);
    assert.throws(() => reuseDelta({ alpha: 0.05, t: 0, p: 0, K: 1, weights: H }), RangeError);
    assert.throws(() => reuseDelta({ alpha: 0.05, t: 2, p: 2, K: 1, weights: H }), RangeError);
    assert.throws(() => reuseDelta({ alpha: 0.05, t: 2, p: 0, K: 1.5, weights: H }), RangeError);
    assert.throws(() => reuseRound({ alpha: 0.05, rho: 1, K: 1, weights: H, t: 1, p: 0, C: 0 }, []), RangeError);
    assert.throws(() => passFailLcb({ nPlus: 3, nMinus: 3, n: 5 }, 0.05), RangeError);
  });
});

describe("sign test and bounds", () => {
  it("signP", () => {
    assert.equal(signP(0, 0), 1);
    assert.equal(signP(5, 5), 1 / 32);
    rel(signP(4, 5), 6 / 32, 1e-12);
  });

  it("Clopper-Pearson lower bounds", () => {
    abs(clopperPearsonLower(5, 10, 0.025), 0.1871, 1e-4);
    abs(clopperPearsonLower(10, 10, 0.05), 0.05 ** 0.1, 1e-9);
    abs(clopperPearsonLower(10, 10, 0.05), 0.7411, 1e-4);
    assert.equal(clopperPearsonLower(0, 7, 0.05), 0);
  });

  it("pairedLcb ≤ mean(z), ≤ 0 for all-zero z, −∞ when empty", () => {
    const rand = mulberry32(3);
    for (let r = 0; r < 50; r++) {
      const z = Array.from({ length: 5 + Math.floor(rand() * 80) }, () => [-1, 0, 0, 1, 1][Math.floor(rand() * 5)]!);
      const m = z.reduce((s, x) => s + x, 0) / z.length;
      assert.ok(pairedLcb(z, Math.log(80)) <= m);
    }
    assert.ok(pairedLcb(Array(40).fill(0), Math.log(80)) <= 0);
    assert.equal(pairedLcb([], 1), -Infinity);
  });

  it("passFailLcb with M = 0 is ≤ 0, and clean wins give a positive bound at large n", () => {
    assert.ok(passFailLcb({ nPlus: 0, nMinus: 0, n: 50 }, 0.05) <= 0);
    assert.ok(passFailLcb({ nPlus: 60, nMinus: 0, n: 200 }, 0.05) > 0);
    // The sign bound wins when discordance is low: (2·q_lo − 1)·d_lo.
    const qLo = clopperPearsonLower(60, 60, 0.0125);
    const dLo = clopperPearsonLower(60, 200, 0.0125);
    assert.ok(passFailLcb({ nPlus: 60, nMinus: 0, n: 200 }, 0.05) >= (2 * qLo - 1) * dLo - 1e-12);
  });

  it("Monte Carlo: the sign test holds its level (Δ 0, d 0.3, n 50, 20k draws)", () => {
    const rand = mulberry32(11);
    const draws = 20_000;
    let rejects = 0;
    for (let r = 0; r < draws; r++) {
      let np = 0;
      let nm = 0;
      for (let i = 0; i < 50; i++) {
        const u = rand();
        if (u < 0.15) np++;
        else if (u < 0.3) nm++;
      }
      if (signP(np, np + nm) <= 0.01) rejects++;
    }
    const se = Math.sqrt((0.01 * 0.99) / draws);
    assert.ok(rejects / draws <= 0.01 + 3 * se, `${rejects / draws}`);
  });

  it("Monte Carlo: the certificate covers the true gain (μ 0.1, d 0.4, n 100, δc 0.05, 20k draws)", () => {
    const rand = mulberry32(12);
    const draws = 20_000;
    const memo = new Map<number, number>();
    let misses = 0;
    for (let r = 0; r < draws; r++) {
      let np = 0;
      let nm = 0;
      for (let i = 0; i < 100; i++) {
        const u = rand();
        if (u < 0.25) np++;
        else if (u < 0.4) nm++;
      }
      const key = np * 1000 + nm;
      let ell = memo.get(key);
      if (ell === undefined) memo.set(key, (ell = passFailLcb({ nPlus: np, nMinus: nm, n: 100 }, 0.05)));
      if (0.1 < ell) misses++;
    }
    const se = Math.sqrt((0.05 * 0.95) / draws);
    assert.ok(misses / draws <= 0.05 + 3 * se, `${misses / draws}`);
  });
});

describe("reuseRound and certificates", () => {
  const start: ReuseState = { alpha: 0.05, rho: 0.5, K: 2, weights: H, t: 1, p: 0, C: 0 };

  it("promotes the passing candidate with the largest z̄ (ties by id) and certifies it", () => {
    const r = reuseRound(start, [
      { id: "b", nPlus: 30, nMinus: 0, n: 100 },
      { id: "a", nPlus: 30, nMinus: 0, n: 100 },
    ]);
    rel(r.delta, 0.05 / 2 / 2 / 2, 1e-12);
    assert.equal(r.threshold, r.delta / 2);
    assert.equal(r.minCleanWins, minCleanWins(r.threshold));
    assert.equal(r.promoted, "a");
    assert.ok(r.rows.every((x) => x.pass));
    rel(r.ell!, passFailLcb({ nPlus: 30, nMinus: 0, n: 100 }, 0.5 * r.delta), 1e-12);
    assert.equal(r.C, Math.max(r.ell!, 0));
    assert.deepEqual({ t: r.next.t, p: r.next.p, C: r.next.C }, { t: 2, p: 1, C: r.C });
  });

  it("leaves the state as it was (but for t) when no candidate passes", () => {
    const r = reuseRound(start, [{ id: "a", nPlus: 6, nMinus: 1, n: 100 }]);
    assert.equal(r.promoted, undefined);
    assert.equal(r.ell, undefined);
    assert.equal(r.C, 0);
    assert.deepEqual({ t: r.next.t, p: r.next.p }, { t: 2, p: 0 });
  });

  it("reuseDirect: 0 at p = 0, −∞ past the horizon, screened is looser", () => {
    const c = { nPlus: 40, nMinus: 5, n: 200 };
    assert.equal(reuseDirect({ alphaC: 0.05, t: 3, p: 0, K: 2, weights: H, ...c }), 0);
    assert.equal(reuseDirect({ alphaC: 0.05, t: 6, p: 1, K: 2, weights: { kind: "horizon", rounds: 5 }, ...c }), -Infinity);
    const d = reuseDirect({ alphaC: 0.05, t: 3, p: 2, K: 2, weights: H, ...c });
    const ds = reuseDirect({ alphaC: 0.05, t: 3, p: 2, K: 2, weights: H, ...c, screened: true });
    // δc = 0.05·(1/12)·(1/12) / (C(3,2)·2²).
    rel(d, passFailLcb(c, (0.05 / 144) / 12), 1e-12);
    assert.ok(ds >= d && d > 0);
  });

  it("reuseMde and reuseSchedule", () => {
    rel(reuseMde({ n: 2000, d: 0.2, delta: 0.0125 }), Math.sqrt((0.4 * Math.log(160)) / 2000), 1e-12);
    const s = reuseSchedule({ alpha: 0.05, K: 1, weights: H, rounds: 5 });
    assert.deepEqual(s.find((x) => x.t === 1 && x.p === 0)!.minCleanWins, 8);
    assert.deepEqual(s.find((x) => x.t === 5 && x.p === 2)!.minCleanWins, 17);
    assert.equal(s.filter((x) => x.t === 5).length, 4); // p = 0..3 (maxP 3)
    assert.equal(reuseSchedule({ alpha: 0.05, K: 1, weights: { kind: "horizon", rounds: 5 }, rounds: 5 }).find((x) => x.t === 5 && x.p === 2)!.minCleanWins, 14);
  });

  it("adaptive adversary: REUSE keeps the family-wise false-promotion rate ≤ α; a fixed per-round test does not", () => {
    // 1000 runs × 100 rounds × K = 2 null candidates on one fixed eval set S (n = 100).
    // Every config has the same true per-case success rates, so every promotion is false.
    // The proposer sees only past decisions: after a rejection it redraws every case,
    // after a promotion only half, so its proposals depend on the history.
    const runs = 1000;
    const rounds = 100;
    const n = 100;
    const rand = mulberry32(2024);
    let reuseBad = 0;
    let naiveBad = 0;
    for (let run = 0; run < runs; run++) {
      const pr = Float64Array.from({ length: n }, () => rand());
      const draw = (base: Uint8Array | undefined, share: number) => {
        const y = new Uint8Array(n);
        for (let i = 0; i < n; i++) y[i] = base && share < 1 && rand() >= share ? base[i]! : rand() < pr[i]! ? 1 : 0;
        return y;
      };
      let inc = draw(undefined, 1);
      let state: ReuseState = { alpha: 0.05, rho: 0.5, K: 2, weights: H, t: 1, p: 0, C: 0 };
      let naiveInc = inc;
      let lastPromoted = false;
      let anyReuse = false;
      let anyNaive = false;
      for (let t = 1; t <= rounds; t++) {
        const share = lastPromoted ? 0.5 : 1;
        const cands = [0, 1].map((k) => {
          const y = draw(inc, share);
          let np = 0;
          let nm = 0;
          for (let i = 0; i < n; i++) {
            if (y[i]! > inc[i]!) np++;
            else if (y[i]! < inc[i]!) nm++;
          }
          return { id: `c${k}`, y, nPlus: np, nMinus: nm, n };
        });
        const r = reuseRound(state, cands);
        state = r.next;
        lastPromoted = !!r.promoted;
        if (r.promoted) {
          anyReuse = true;
          inc = cands.find((c) => c.id === r.promoted)!.y;
        }
        if (!anyNaive) {
          for (const c of cands) {
            let np = 0;
            let nm = 0;
            for (let i = 0; i < n; i++) {
              if (c.y[i]! > naiveInc[i]!) np++;
              else if (c.y[i]! < naiveInc[i]!) nm++;
            }
            if (signP(np, np + nm) < 0.05) {
              anyNaive = true;
              naiveInc = c.y;
              break;
            }
          }
        }
      }
      if (anyReuse) reuseBad++;
      if (anyNaive) naiveBad++;
    }
    const se = Math.sqrt((0.05 * 0.95) / runs);
    assert.ok(reuseBad / runs <= 0.05 + 3 * se, `REUSE ${reuseBad / runs}`);
    // Kept to document why a budget is needed: testing each round at 0.05 promotes noise.
    assert.ok(naiveBad / runs > 0.3, `naive ${naiveBad / runs}`);
  });
});
