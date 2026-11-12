// With one trial per case every changed case moves by the same amount, so the
// sign-flip test is the exact binomial on the changed cases: its p equals
// McNemar's at any size, not only up to the 20 units it enumerates.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { binomUpperTail, clusterSignFlip, mcnemar, pairedPermutation } from "../../src/stats/index.ts";

const diffs = (up: number, down: number, ties = 0) => [...Array(up).fill(1), ...Array(down).fill(-1), ...Array(ties).fill(0)];

describe("sign-flip at k=1 equals McNemar", () => {
  it("30 changed cases: the same p as McNemar, exact", () => {
    for (const [up, down] of [[20, 10], [19, 11], [15, 15], [27, 3], [0, 30]] as const) {
      const r = clusterSignFlip(diffs(up, down, 40));
      assert.equal(r.method, "exact");
      assert.ok(Math.abs(r.p - mcnemar(down, up).p) < 1e-12, `${up}/${down}: ${r.p} vs ${mcnemar(down, up).p}`);
    }
  });

  it("one-sided alternatives are the binomial tails", () => {
    const d = diffs(20, 10, 5);
    assert.ok(Math.abs(pairedPermutation(d, { alternative: "greater" }).p - binomUpperTail(20, 30, 0.5)) < 1e-12);
    assert.ok(Math.abs(pairedPermutation(d, { alternative: "less" }).p - (1 - binomUpperTail(21, 30, 0.5))) < 1e-12);
  });

  it("unequal magnitudes still use the permutation", () => {
    const r = pairedPermutation([...diffs(15, 10), 0.5, ...Array(5).fill(0.25)]);
    assert.equal(r.method, "monte-carlo");
  });
});
