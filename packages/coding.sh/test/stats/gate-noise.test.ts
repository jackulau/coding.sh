// The gate says "Don't ship" only when B's losses beat chance: an exact
// one-sided binomial test of the losses among the cases that changed outcome.
// A/A noise and real gains that break a few cases hold or ship instead.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptanceGate, acceptanceGatePaired, binomUpperTail, gateHeadline, gateVerdict, mulberry32 } from "../../src/stats/index.ts";

describe("gate: don't ship needs losses beyond noise", () => {
  it("losses close to wins hold (the QA repro numbers)", () => {
    assert.equal(gateVerdict(acceptanceGate({ wins: 47, losses: 57, solved: 103 })), "hold");
    assert.equal(gateVerdict(acceptanceGate({ wins: 49, losses: 22, solved: 106 })), "hold");
  });

  it("a real regression is still don't ship", () => {
    const g = acceptanceGate({ wins: 2, losses: 30, solved: 60 });
    assert.equal(gateVerdict(g), "dont-ship");
    assert.equal(gateHeadline(g, "case"), "Don't ship: B breaks 30 cases A solved (and wins 2)");
    // breakP = P(Bin(32, 1/2) ≥ 30)
    assert.ok(Math.abs(g.breakP - binomUpperTail(30, 32, 0.5)) < 1e-15);
  });

  it("five losses and no wins is the smallest don't ship at α 0.05", () => {
    assert.equal(gateVerdict(acceptanceGate({ wins: 0, losses: 4, solved: 10 })), "hold");
    assert.equal(gateVerdict(acceptanceGate({ wins: 0, losses: 5, solved: 10 })), "dont-ship");
  });

  it("no case changed outcome holds, it is not don't ship", () => {
    const g = acceptanceGate({ wins: 0, losses: 0, solved: 10 });
    assert.equal(gateVerdict(g), "hold");
    assert.equal(gateHeadline(g, "case"), "Hold: not enough evidence (no case changed outcome)");
  });

  it("the hold line for losses within noise does not ask for clean wins", () => {
    assert.equal(
      gateHeadline(acceptanceGate({ wins: 47, losses: 57, solved: 103 }), "case"),
      "Hold: not enough evidence (B wins 47, loses 57; within chance)",
    );
  });

  it("A/A noise: don't ship in at most about α of 200 seeded runs", () => {
    const rnd = mulberry32(20261111);
    let dont = 0;
    const reps = 200;
    for (let r = 0; r < reps; r++) {
      const p = Array.from({ length: 200 }, () => 0.2 + 0.6 * rnd());
      const a = p.map((x) => rnd() < x);
      const b = p.map((x) => rnd() < x);
      if (gateVerdict(acceptanceGatePaired(a, b)) === "dont-ship") dont++;
    }
    // α = 0.05 of 200 is 10; the exact test is conservative.
    assert.ok(dont <= 12, `A/A said don't ship in ${dont} of ${reps}`);
  });

  it("a true gain of about 14 points is never don't ship", () => {
    const rnd = mulberry32(7);
    for (let r = 0; r < 60; r++) {
      const p = Array.from({ length: 200 }, () => 0.15 + 0.5 * rnd());
      const a = p.map((x) => rnd() < x);
      const b = p.map((x) => rnd() < x + 0.14);
      assert.notEqual(gateVerdict(acceptanceGatePaired(a, b)), "dont-ship");
    }
  });
});
