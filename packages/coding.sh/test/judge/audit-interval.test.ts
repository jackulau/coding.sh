// judge calibrate --plan on a judge that agrees with every label: each stratum
// is all pass or all fail, so the plug-in variance is 0. The interval must
// still have width at 10 labels, and the η line (unbounded here) is left out.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditedPassRate, planAudit } from "../../src/judge/audit.ts";
import { calibrate, type HumanLabel, type JudgedCase } from "../../src/judge/calibrate.ts";
import { renderCalibration } from "../../src/judge/render.ts";

const id = (i: number) => `c${String(i).padStart(3, "0")}`;

function perfectJudge(n: number) {
  const verdicts = new Map<string, JudgedCase>();
  const population: string[] = [];
  const human = new Map<string, boolean>();
  for (let i = 0; i < n; i++) {
    const pass = i % 2 === 0;
    verdicts.set(id(i), { caseId: id(i), pass, confidence: 0.5 + (i % 5) / 10 });
    human.set(id(i), pass);
    population.push(id(i));
  }
  return { verdicts, population, human };
}

describe("audited pass rate with pure strata", () => {
  it("10 labels give an interval with width, not [p, p]", () => {
    const { verdicts, population, human } = perfectJudge(40);
    const plan = planAudit({ verdicts, population, labelled: new Set(), budget: 10, seed: 1, split: "test" });
    const labels: HumanLabel[] = plan.picks.map((p) => ({ caseId: p.caseId, value: human.get(p.caseId) ? "pass" : "fail" }));
    const a = auditedPassRate(plan, labels);
    assert.equal(a.labelled, 10);
    assert.ok(a.lo < a.p && a.p < a.hi, `[${a.lo}, ${a.hi}] around ${a.p}`);
    assert.ok(a.hi - a.lo > 0.1, `width ${a.hi - a.lo}`);
  });

  it("a census (every case labelled) keeps a zero-width interval", () => {
    const { verdicts, population, human } = perfectJudge(10);
    const plan = planAudit({ verdicts, population, labelled: new Set(), budget: 10, seed: 1, split: "test" });
    const a = auditedPassRate(plan, plan.picks.map((p) => ({ caseId: p.caseId, value: human.get(p.caseId) ? "pass" : "fail" })));
    assert.equal(a.lo, a.p);
    assert.equal(a.hi, a.p);
  });

  it("calibrate --plan renders no 'η —' and no '0.00x the labels' for a perfect judge", () => {
    const { verdicts, population, human } = perfectJudge(40);
    const plan = planAudit({ verdicts, population, labelled: new Set(), budget: 10, seed: 1, split: "test" });
    const labels: HumanLabel[] = population.map((c) => ({ caseId: c, value: human.get(c) ? "pass" : "fail" }));
    const splits = Object.fromEntries(population.map((x) => [x, "test" as const]));
    const r = calibrate({ judge: { id: "j", tunedOn: ["dev"] }, labels, verdicts, splits, plan, now: 1 });
    const text = renderCalibration(r, { color: false });
    assert.doesNotMatch(text, /η —/);
    assert.doesNotMatch(text, /0\.00x/);
    const m = /human-audited pass rate (\d\.\d\d) \[(\d\.\d\d), (\d\.\d\d)\]/.exec(text);
    assert.ok(m, text);
    assert.notEqual(m[2], m[3], text);
  });
});
