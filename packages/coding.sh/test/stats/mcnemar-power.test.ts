import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mcnemar, mcnemarCasesFor, mcnemarMinDiscordant, mcnemarPlan, mcnemarPower, mulberry32 } from "../../src/stats/index.ts";
import { cpuMs, median } from "../helpers-timing.ts";

const near = (x: number, y: number, eps: number, what = "") => assert.ok(Math.abs(x - y) <= eps, `${what} ${x} ≉ ${y} ±${eps}`);

// Reference values: arXiv 2610.04433 §4 and its power appendix (analysis/figA_mde.py), which sums
// K ~ Bin(n, d) and C | K ~ Bin(K, (d + δ) / 2d) against the exact two-sided McNemar test.
describe("mcnemarMinDiscordant", () => {
  it("is the smallest k with 2 / 2^k ≤ α", () => {
    assert.equal(mcnemarMinDiscordant(0.05), 6); // 2/64 = 0.031; 2/32 = 0.0625
    assert.equal(mcnemarMinDiscordant(0.01), 8); // 2/256 = 0.0078; 2/128 = 0.0156
    assert.equal(mcnemarMinDiscordant(0.0625), 5);
    assert.equal(mcnemarMinDiscordant(), 6);
    assert.throws(() => mcnemarMinDiscordant(0), RangeError);
  });

  it("agrees with the exact test: k − 1 discordant cases never reject, k all one way do", () => {
    for (const alpha of [0.05, 0.01, 0.1]) {
      const k = mcnemarMinDiscordant(alpha);
      assert.ok(mcnemar(0, k).p <= alpha, `k=${k} rejects at ${alpha}`);
      assert.ok(mcnemar(0, k - 1).p > alpha, `k−1=${k - 1} never rejects at ${alpha}`);
    }
  });
});

describe("mcnemarPlan / mcnemarPower: paper values", () => {
  it("45 tasks at 14% discordance: ceiling 62%, no gap reaches 80%", () => {
    const p = mcnemarPlan(45, 0.14);
    near(p.ceiling, 0.616, 0.005, "ceiling");
    assert.ok(Number.isNaN(p.mde));
    assert.equal(p.minDiscordant, 6);
    assert.deepEqual([p.n, p.discordance, p.alpha, p.power], [45, 0.14, 0.05, 0.8]);
    // A 12.9-point gap is found about half the time.
    near(mcnemarPower(45, 0.14, 0.129), 0.5, 0.01, "power(12.9pp)");
  });

  it("55 tasks reach the 80% ceiling; 447 resolve ~5.1 points, above the normal 4.96", () => {
    near(mcnemarPlan(55, 0.14).ceiling, 0.8, 0.01, "ceiling(55)");
    const big = mcnemarPlan(447, 0.14);
    near(big.mde, 0.051, 0.002, "mde(447)");
    assert.ok(big.mde >= 0.0496, "exact MDE is not below the normal approximation");
    near(mcnemarPlan(100, 0.14).mde, 0.106, 0.003, "mde(100)");
  });

  it("the MDE is the smallest gap with the target power", () => {
    const p = mcnemarPlan(100, 0.14);
    assert.ok(mcnemarPower(100, 0.14, p.mde) >= 0.8);
    assert.ok(mcnemarPower(100, 0.14, p.mde - 1e-3) < 0.8);
  });
});

describe("mcnemarPower: shape", () => {
  it("is at most α at δ = 0", () => {
    for (const [n, d] of [[45, 0.14], [100, 0.3], [447, 0.14], [20, 1]] as const) {
      assert.ok(mcnemarPower(n, d, 0) <= 0.05 + 1e-12, `size at n=${n} d=${d}`);
    }
  });

  it("grows with δ and with n", () => {
    for (const d of [0.1, 0.3]) {
      let last = -1;
      for (let i = 0; i <= 10; i++) {
        const p = mcnemarPower(80, d, (d * i) / 10);
        assert.ok(p >= last - 1e-12, `δ monotone at d=${d}, i=${i}`);
        last = p;
      }
    }
    // Exact power saw-tooths a little in n; across a wide grid it rises.
    const grid = [20, 50, 100, 200, 400].map((n) => mcnemarPower(n, 0.2, 0.08));
    for (let i = 1; i < grid.length; i++) assert.ok((grid[i] as number) > (grid[i - 1] as number), `n monotone ${grid}`);
  });

  it("is symmetric in the sign of δ and rejects bad input", () => {
    assert.equal(mcnemarPower(60, 0.2, -0.1), mcnemarPower(60, 0.2, 0.1));
    assert.throws(() => mcnemarPower(60, 0.2, 0.3), RangeError);
    assert.throws(() => mcnemarPower(-1, 0.2, 0.1), RangeError);
    assert.throws(() => mcnemarPower(10, 1.5, 0.1), RangeError);
    assert.throws(() => mcnemarPlan(10, 0.2, { power: 1 }), RangeError);
  });

  it("edges: n = 0, d = 0, d = 1, δ = d", () => {
    assert.equal(mcnemarPower(0, 0.2, 0.1), 0);
    const zero = mcnemarPlan(0, 0.2);
    assert.equal(zero.ceiling, 0);
    assert.ok(Number.isNaN(zero.mde));
    assert.equal(mcnemarPower(50, 0, 0), 0);
    assert.ok(Number.isNaN(mcnemarPlan(50, 0).mde));
    // d = 1: every case is discordant, K = n. δ = d means B wins every one: rejects once n ≥ 6.
    assert.equal(mcnemarPower(5, 1, 1), 0);
    near(mcnemarPower(6, 1, 1), 1, 1e-12);
    // δ = d is the ceiling: P(K ≥ 6) for K ~ Bin(45, 0.14).
    near(mcnemarPower(45, 0.14, 0.14), mcnemarPlan(45, 0.14).ceiling, 1e-12);
  });

  it("matches a seeded 20k-draw simulation of the exact test", () => {
    const rand = mulberry32(20261107);
    const sims = 20000;
    const [n, d, delta] = [45, 0.14, 0.129];
    let rejected = 0;
    for (let s = 0; s < sims; s++) {
      let b = 0;
      let c = 0;
      for (let i = 0; i < n; i++) {
        const u = rand();
        if (u < (d - delta) / 2) b++;
        else if (u < d) c++;
      }
      if (mcnemar(b, c).p <= 0.05) rejected++;
    }
    near(rejected / sims, mcnemarPower(n, d, delta), 0.01, "simulated power");
  });

  it("plans 2000 cases at 30% discordance in under 50 ms of CPU", () => {
    mcnemarPlan(200, 0.3); // warm up
    // CPU time, not wall time: on a busy machine the wall clock also counts the time
    // this thread waits for a core. About 9 ms on an idle laptop; the median of 5
    // keeps one GC pause from deciding it.
    const runs = Array.from({ length: 5 }, () => cpuMs(() => mcnemarPlan(2000, 0.3)));
    assert.ok(median(runs) < 50, `took ${runs.map((x) => x.toFixed(1)).join(", ")} ms of CPU`);
  });
});

describe("mcnemarCasesFor", () => {
  it("finds where power first crosses the target", () => {
    const n = mcnemarCasesFor(0.129, 0.14);
    assert.ok(n > 45);
    assert.ok(mcnemarPower(n, 0.14, 0.129) >= 0.8);
    assert.ok(mcnemarPower(n - 1, 0.14, 0.129) < 0.8);
    // A 5-point gap at 14% discordance needs a few hundred cases, a bit more than the normal 439.
    const big = mcnemarCasesFor(0.05, 0.14);
    assert.ok(big >= 439 && big < 480, String(big));
  });

  it("is NaN for gaps outside (0, d] or beyond max", () => {
    assert.ok(Number.isNaN(mcnemarCasesFor(0, 0.14)));
    assert.ok(Number.isNaN(mcnemarCasesFor(0.2, 0.14)));
    assert.ok(Number.isNaN(mcnemarCasesFor(0.01, 0.3, { max: 1000 })));
  });
});
