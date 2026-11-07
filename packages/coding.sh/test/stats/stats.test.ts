import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  binomCdfHalf,
  cohenKappa,
  mcnemar,
  mcnemarPaired,
  mean,
  median,
  mulberry32,
  p90,
  pairedBootstrap,
  percentAgreement,
  quantile,
  roganGladen,
  stddev,
  summarize,
  wilson,
} from "../../src/stats/index.ts";

const close = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b} (±${eps})`);

describe("wilson", () => {
  // Newcombe (1998), "Two-sided confidence intervals for the single proportion", Table I, method 3.
  const table: [number, number, number, number][] = [
    [81, 263, 0.2553, 0.3662],
    [15, 148, 0.0624, 0.1605],
    [0, 20, 0, 0.1611],
    [1, 29, 0.0061, 0.1718],
  ];
  for (const [x, n, lo, hi] of table) {
    it(`${x}/${n} → [${lo}, ${hi}]`, () => {
      const r = wilson(x, n);
      close(r.p, x / n, 1e-12);
      close(r.lo, lo, 1e-4);
      close(r.hi, hi, 1e-4);
    });
  }
  it("n/n stays inside [0,1] and is symmetric with 0/n", () => {
    const a = wilson(20, 20);
    const b = wilson(0, 20);
    close(a.hi, 1, 1e-12);
    close(a.lo, 1 - b.hi, 1e-12);
  });
  it("n = 0 is uninformative", () => {
    const r = wilson(0, 0);
    assert.ok(Number.isNaN(r.p));
    assert.equal(r.lo, 0);
    assert.equal(r.hi, 1);
  });
  it("rejects impossible counts", () => {
    assert.throws(() => wilson(5, 3), RangeError);
  });
});

describe("mcnemar (exact)", () => {
  it("b=0, c=5 → p = 2/32", () => close(mcnemar(0, 5).p, 0.0625, 1e-12));
  it("b=1, c=9 → p = 22/1024", () => close(mcnemar(1, 9).p, 22 / 1024, 1e-12));
  it("symmetric in b and c", () => assert.equal(mcnemar(9, 1).p, mcnemar(1, 9).p));
  it("no discordant pairs → p = 1", () => assert.equal(mcnemar(0, 0).p, 1));
  it("balanced discordance → p = 1", () => assert.equal(mcnemar(7, 7).p, 1));
  it("b=2, c=12 (n=14) → 2·(1+14+91)/16384", () => close(mcnemar(2, 12).p, (2 * 106) / 16384, 1e-12));
  it("large n stays finite and tiny", () => {
    const p = mcnemar(400, 600).p;
    assert.ok(p > 0 && p < 1e-9, String(p));
  });
  it("binomial CDF sanity", () => {
    close(binomCdfHalf(5, 10), 638 / 1024, 1e-12);
    assert.equal(binomCdfHalf(-1, 10), 0);
    assert.equal(binomCdfHalf(10, 10), 1);
  });
  it("from paired arrays", () => {
    const base = [true, true, false, false, true, false];
    const cand = [true, false, true, true, true, true];
    const r = mcnemarPaired(base, cand);
    assert.equal(r.b, 1);
    assert.equal(r.c, 3);
  });
  it("rejects non-integer counts", () => assert.throws(() => mcnemar(1.5, 2), RangeError));
});

describe("cohenKappa", () => {
  // Wikipedia "Cohen's kappa" worked examples.
  function expand(yy: number, yn: number, ny: number, nn: number): [string[], string[]] {
    const a: string[] = [];
    const b: string[] = [];
    const push = (x: string, y: string, k: number) => {
      for (let i = 0; i < k; i++) {
        a.push(x);
        b.push(y);
      }
    };
    push("yes", "yes", yy);
    push("yes", "no", yn);
    push("no", "yes", ny);
    push("no", "no", nn);
    return [a, b];
  }
  it("20/5/10/15 → κ = 0.4, p_o = 0.7", () => {
    const [a, b] = expand(20, 5, 10, 15);
    const r = cohenKappa(a, b);
    close(r.kappa, 0.4, 1e-12);
    close(r.agreement, 0.7, 1e-12);
    close(r.expected, 0.5, 1e-12);
    assert.equal(r.confusion.yes?.no, 5);
    assert.equal(r.confusion.no?.yes, 10);
  });
  it("45/15/25/15 → κ ≈ 0.1304", () => {
    const [a, b] = expand(45, 15, 25, 15);
    close(cohenKappa(a, b).kappa, 0.1304, 1e-4);
  });
  it("25/35/5/35 → κ ≈ 0.2593", () => {
    const [a, b] = expand(25, 35, 5, 35);
    close(cohenKappa(a, b).kappa, 0.2593, 1e-4);
  });
  it("perfect agreement over two classes → κ = 1", () => {
    assert.equal(cohenKappa(["a", "b", "a"], ["a", "b", "a"]).kappa, 1);
  });
  it("single-category degenerate case → NaN, not a fake 1", () => {
    const r = cohenKappa(["pass", "pass"], ["pass", "pass"]);
    assert.ok(Number.isNaN(r.kappa));
    assert.equal(r.agreement, 1);
  });
  it("three categories", () => {
    // Fleiss-style 3x3; computed by hand: po = 0.6, pe = 0.34 → κ = 0.3939…
    const a = ["x", "x", "x", "x", "y", "y", "y", "z", "z", "z"];
    const b = ["x", "x", "x", "y", "y", "y", "z", "z", "x", "y"];
    const r = cohenKappa(a, b);
    close(r.agreement, 0.6, 1e-12);
    close(r.expected, (0.4 * 0.4 + 0.3 * 0.4 + 0.3 * 0.2), 1e-12);
    close(r.kappa, (0.6 - 0.34) / 0.66, 1e-12);
  });
  it("percentAgreement", () => {
    close(percentAgreement(["a", "b", "c", "d"], ["a", "b", "x", "x"]), 0.5, 1e-12);
    assert.throws(() => percentAgreement(["a"], []), RangeError);
  });
});

describe("summary", () => {
  it("mean / median / p90 (type 7)", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(mean(xs), 5.5);
    assert.equal(median(xs), 5.5);
    close(p90(xs), 9.1, 1e-12);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    close(quantile([10, 20, 30], 0.25), 15, 1e-12);
  });
  it("stddev matches textbook (2,4,4,4,5,5,7,9 → s = 2.138)", () => {
    close(stddev([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7), 1e-12);
  });
  it("empty input is NaN, not a throw", () => {
    assert.ok(Number.isNaN(mean([])));
    assert.ok(Number.isNaN(median([])));
    const s = summarize([]);
    assert.equal(s.n, 0);
    assert.ok(Number.isNaN(s.p90));
  });
  it("summarize", () => {
    const s = summarize([3, 1, 2]);
    assert.deepEqual([s.n, s.min, s.max, s.sum, s.median], [3, 1, 3, 6, 2]);
  });
});

describe("pairedBootstrap", () => {
  it("constant differences → degenerate CI", () => {
    const r = pairedBootstrap([0.2, 0.2, 0.2, 0.2], { iters: 500 });
    close(r.mean, 0.2, 1e-12);
    close(r.lo, 0.2, 1e-12);
    close(r.hi, 0.2, 1e-12);
  });
  it("deterministic for a given seed, different across seeds", () => {
    const d = [0.13, -0.41, 0.77, 0.05, 0.29, -0.18, 0.62, 0.31, -0.07, 0.44, 0.91, -0.33];
    assert.deepEqual(pairedBootstrap(d, { seed: 7, iters: 2000 }), pairedBootstrap(d, { seed: 7, iters: 2000 }));
    assert.notDeepEqual(pairedBootstrap(d, { seed: 7, iters: 2000 }), pairedBootstrap(d, { seed: 8, iters: 2000 }));
  });
  it("approximates the normal-theory CI for a large sample", () => {
    const rand = mulberry32(42);
    const d: number[] = [];
    for (let i = 0; i < 400; i++) d.push(rand() < 0.6 ? 1 : 0); // Bernoulli(0.6)
    const r = pairedBootstrap(d, { iters: 10_000 });
    const se = stddev(d) / Math.sqrt(d.length);
    close(r.lo, r.mean - 1.96 * se, 0.01);
    close(r.hi, r.mean + 1.96 * se, 0.01);
    assert.ok(r.lo < r.mean && r.mean < r.hi);
  });
  it("empty input", () => {
    const r = pairedBootstrap([]);
    assert.ok(Number.isNaN(r.mean));
    assert.equal(r.n, 0);
  });
});

describe("mulberry32", () => {
  it("is in [0,1) and reproducible", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      assert.equal(x, b());
      assert.ok(x >= 0 && x < 1);
    }
  });
});

describe("roganGladen", () => {
  // Hand-computed: J = q0 + q1 - 1, theta = (p + q0 - 1) / J,
  // Var = [p(1-p)/n + (1-theta)^2 q0(1-q0)/m0 + theta^2 q1(1-q1)/m1] / J^2, CI = theta +/- 1.96 se.
  it("p=0.7, sens=0.9, spec=0.8, n=500, m1=m0=100", () => {
    // J = 0.7; theta = 0.5/0.7 = 0.714286
    // Var = (0.00042 + 0.000130612 + 0.000459184) / 0.49 = 0.002060808; se = 0.045396
    const r = roganGladen(0.7, 0.9, 0.8, 500, { positives: 100, negatives: 100 });
    assert.equal(r.corrected, true);
    close(r.raw, 0.7, 1e-12);
    close(r.youden, 0.7, 1e-12);
    close(r.p, 0.714286, 1e-6);
    close(r.se, 0.045396, 1e-6);
    close(r.lo, 0.625311, 1e-6);
    close(r.hi, 0.80326, 1e-5);
  });
  it("imbalanced calibration: p=0.4, sens=0.85, spec=0.9, n=200, m1=60, m0=140", () => {
    // J = 0.75; theta = 0.3/0.75 = 0.4
    // Var = (0.0012 + 0.000231429 + 0.00034) / 0.5625 = 0.003149206; se = 0.056118
    const r = roganGladen(0.4, 0.85, 0.9, 200, { positives: 60, negatives: 140 });
    close(r.p, 0.4, 1e-12);
    close(r.se, 0.056118, 1e-6);
    close(r.lo, 0.290011, 1e-6);
    close(r.hi, 0.509989, 1e-6);
  });
  it("a scalar nCal is split evenly between positives and negatives", () => {
    const a = roganGladen(0.7, 0.9, 0.8, 500, 200);
    const b = roganGladen(0.7, 0.9, 0.8, 500, { positives: 100, negatives: 100 });
    assert.deepEqual(a, b);
  });
  it("a perfect judge reduces to the Wald interval on the raw rate", () => {
    const r = roganGladen(0.3, 1, 1, 100, 50);
    const se = Math.sqrt((0.3 * 0.7) / 100);
    close(r.p, 0.3, 1e-12);
    close(r.se, se, 1e-12);
    close(r.lo, 0.3 - 1.959963984540054 * se, 1e-12);
    close(r.hi, 0.3 + 1.959963984540054 * se, 1e-12);
  });
  it("more calibration labels narrow the CI", () => {
    const small = roganGladen(0.6, 0.85, 0.85, 400, 40);
    const big = roganGladen(0.6, 0.85, 0.85, 400, 4000);
    assert.ok(big.hi - big.lo < small.hi - small.lo);
    close(big.p, small.p, 1e-12);
  });
  it("clamps the point estimate and CI to [0, 1]", () => {
    // theta = (0.05 + 0.9 - 1) / 0.7 = -0.0714 -> 0
    const low = roganGladen(0.05, 0.8, 0.9, 100, 100);
    assert.equal(low.p, 0);
    assert.equal(low.lo, 0);
    assert.ok(low.hi > 0 && low.hi <= 1);
    // theta = (0.98 + 0.9 - 1) / 0.75 = 1.173 -> 1
    const high = roganGladen(0.98, 0.85, 0.9, 100, 100);
    assert.equal(high.p, 1);
    assert.equal(high.hi, 1);
    assert.ok(high.lo < 1 && high.lo >= 0);
  });
  it("refuses the correction when sens + spec <= 1", () => {
    for (const [sens, spec] of [
      [0.5, 0.5],
      [0.4, 0.3],
    ] as const) {
      const r = roganGladen(0.6, sens, spec, 100, 100);
      assert.equal(r.corrected, false);
      assert.ok(Number.isNaN(r.p));
      assert.ok(Number.isNaN(r.se));
      assert.equal(r.lo, 0);
      assert.equal(r.hi, 1);
      close(r.raw, 0.6, 1e-12);
    }
  });
  it("no test or calibration labels for a class gives an uninformative CI", () => {
    const r = roganGladen(0.7, 0.9, 0.8, 500, { positives: 0, negatives: 100 });
    close(r.p, 0.714286, 1e-6);
    assert.ok(Number.isNaN(r.se));
    assert.equal(r.lo, 0);
    assert.equal(r.hi, 1);
    assert.equal(roganGladen(0.7, 0.9, 0.8, 0, 200).hi, 1);
  });
  it("rejects rates outside [0, 1] and negative counts", () => {
    assert.throws(() => roganGladen(1.2, 0.9, 0.8, 10, 10), RangeError);
    assert.throws(() => roganGladen(0.5, Number.NaN, 0.8, 10, 10), RangeError);
    assert.throws(() => roganGladen(0.5, 0.9, -0.1, 10, 10), RangeError);
    assert.throws(() => roganGladen(0.5, 0.9, 0.8, -1, 10), RangeError);
    assert.throws(() => roganGladen(0.5, 0.9, 0.8, 10, { positives: 5, negatives: -1 }), RangeError);
  });
});
