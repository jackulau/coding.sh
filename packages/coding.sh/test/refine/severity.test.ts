// Y-4: deterministic signal severity (Signals, arXiv 2611.04507v2 §3.3).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConsequence, defaultWasteFactor, levelOf, natureScore, scopeBand, signalSeverity } from "../../src/refine/severity.ts";

describe("scopeBand", () => {
  it("uses the count bands: 1 → 0, 2-3 → 3, 4-10 → 7, 11-100 → 12, > 100 → 15", () => {
    assert.deepEqual([1, 2, 3, 4, 10].map((a) => scopeBand(a, 19).points), [0, 3, 3, 7, 7]);
    // Above 19 affected the share bands are on; a huge population keeps the share under 1%, so the count rule decides.
    for (const [a, p] of [
      [11, 12],
      [100, 12],
      [101, 15],
    ] as const) {
      const s = scopeBand(a, 100_000);
      assert.equal(s.points, p, `affected ${a}`);
      assert.equal(s.via, "count");
    }
    assert.equal(scopeBand(0, 0).points, 0);
  });

  it("applies the share bands only at ≥ 20 analyzed; the higher band wins", () => {
    assert.equal(scopeBand(1, 19).points, 0);
    assert.deepEqual(scopeBand(1, 20), { band: "limited", points: 3, via: "share" });
    assert.deepEqual(scopeBand(5, 30), { band: "repeated", points: 7, via: "count" });
    assert.deepEqual(scopeBand(12, 20), { band: "widespread", points: 15, via: "share" });
    assert.equal(scopeBand(2, 1000).points, 3); // count beats a 0.2% share
  });

  it("rejects bad counts", () => {
    assert.throws(() => scopeBand(3, 2), RangeError);
    assert.throws(() => scopeBand(-1, 2), RangeError);
    assert.throws(() => scopeBand(1.5, 2), RangeError);
  });
});

describe("natureScore", () => {
  it("reproduces the paper's worked example: a task failure in 5 of 30 sessions = 47, high", () => {
    const d = natureScore({ nature: "defect", factor: 40, affected: 5, analyzed: 30 });
    assert.equal(d.score, 47);
    assert.equal(levelOf(d.score), "high");
  });

  it("ceils Cp·R for a risk", () => {
    assert.equal(natureScore({ nature: "risk", factor: 65, reach: 0.6, affected: 1, analyzed: 1 }).score, 39);
    assert.equal(levelOf(39), "low");
    assert.equal(natureScore({ nature: "risk", factor: 25, reach: 0.4, affected: 1, analyzed: 1 }).score, 10);
    assert.equal(natureScore({ nature: "risk", factor: 65, reach: 0.4, affected: 1, analyzed: 1 }).score, 26);
    assert.equal(natureScore({ nature: "risk", factor: 10, reach: 0.6, affected: 1, analyzed: 1 }).score, 6);
  });

  it("caps at 100", () => {
    assert.equal(natureScore({ nature: "defect", factor: 85, affected: 200, analyzed: 200 }).score, 100);
    assert.equal(natureScore({ nature: "inefficiency", factor: 90, affected: 200, analyzed: 200 }).score, 100);
  });

  it("throws when reach is missing for a risk or present otherwise", () => {
    assert.throws(() => natureScore({ nature: "risk", factor: 40, affected: 1, analyzed: 1 }), /needs reach/);
    assert.throws(() => natureScore({ nature: "defect", factor: 40, reach: 0.8, affected: 1, analyzed: 1 }), /risk only/);
    assert.throws(() => natureScore({ nature: "risk", factor: 40, reach: 0.5, affected: 1, analyzed: 1 }), /reach must be/);
    assert.throws(() => natureScore({ nature: "defect", factor: 140, affected: 1, analyzed: 1 }), /factor/);
  });
});

describe("levelOf and signalSeverity", () => {
  it("level boundaries 39/40/79/80", () => {
    assert.deepEqual([1, 39, 40, 79, 80, 100].map(levelOf), ["low", "low", "high", "high", "critical", "critical"]);
    assert.throws(() => levelOf(101), RangeError);
  });

  it("takes the max across natures, never the sum or mean", () => {
    const defect = natureScore({ nature: "defect", factor: 40, affected: 5, analyzed: 30 });
    const waste = natureScore({ nature: "inefficiency", factor: 25, affected: 2, analyzed: 30 });
    assert.equal(waste.score, 28);
    const s = signalSeverity([waste, defect]);
    assert.equal(s.score, 47);
    assert.equal(s.level, "high");
    assert.equal(s.drivingNature, "defect");
    assert.deepEqual(s.population, { affected: 5, analyzed: 30 });
    assert.equal(s.parts.length, 2);
  });

  it("breaks a tie toward defect, then risk", () => {
    const r = natureScore({ nature: "risk", factor: 40, reach: 1.0, affected: 1, analyzed: 1 });
    const i = natureScore({ nature: "inefficiency", factor: 40, affected: 1, analyzed: 1 });
    assert.equal(signalSeverity([i, r]).drivingNature, "risk");
    assert.throws(() => signalSeverity([]), RangeError);
  });
});

describe("default factors", () => {
  it("waste from counts", () => {
    assert.equal(defaultWasteFactor({ wastedCalls: 2 }), 10);
    assert.equal(defaultWasteFactor({ wastedCalls: 3 }), 25);
    assert.equal(defaultWasteFactor({ wastedCalls: 5 }), 25);
    assert.equal(defaultWasteFactor({ wastedCalls: 6 }), 40);
    assert.equal(defaultWasteFactor({ wastedCalls: 20 }), 40);
    assert.equal(defaultWasteFactor({ wastedCalls: 21 }), 65);
    assert.equal(defaultWasteFactor({ wastedCalls: 6, sessionToolCalls: 10 }), 65);
    assert.equal(defaultWasteFactor({ wastedCalls: 5, sessionToolCalls: 10 }), 25);
    assert.equal(defaultWasteFactor({ wastedCalls: 1, hitLimit: true }), 85);
  });

  it("consequence: known failure 40, else 25", () => {
    assert.equal(defaultConsequence({ outcome: "fail" }), 40);
    assert.equal(defaultConsequence({ outcome: "pass" }), 25);
    assert.equal(defaultConsequence(), 25);
  });
});
