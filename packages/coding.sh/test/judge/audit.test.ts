// AB-16 / AB-17: confidence-stratified label plans and the human-audited pass
// rate (Choi et al., arXiv 2610.35698).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditedPassRate, parseAuditPlan, planAudit } from "../../src/judge/audit.ts";
import { calibrate, type HumanLabel, type JudgedCase } from "../../src/judge/calibrate.ts";
import { renderAuditPlan, renderCalibration } from "../../src/judge/render.ts";
import { allocateProportional, mulberry32, roganGladen } from "../../src/stats/index.ts";

const id = (i: number) => `c${String(i).padStart(3, "0")}`;

/** 300 cases: 80% judge-pass, confidence skewed to 0.9-1.0. */
function synthetic(seed = 1) {
  const rand = mulberry32(seed);
  const verdicts = new Map<string, JudgedCase>();
  const population: string[] = [];
  for (let i = 0; i < 300; i++) {
    const pass = rand() < 0.8;
    const u = rand();
    const confidence = u < 0.6 ? 0.9 + rand() * 0.1 : u < 0.85 ? 0.6 + rand() * 0.3 : rand() * 0.6;
    verdicts.set(id(i), { caseId: id(i), pass, confidence });
    population.push(id(i));
  }
  return { verdicts, population };
}

describe("planAudit", () => {
  it("picks per stratum equal the proportional allocation, inside the population, seeded", () => {
    const { verdicts, population } = synthetic();
    const labelled = new Set([id(0), id(1), id(2), id(3), id(4)]);
    // A case outside the split carries a verdict but must never be picked.
    verdicts.set("other", { caseId: "other", pass: true, confidence: 0.95 });
    const plan = planAudit({ verdicts, population, labelled, budget: 30, seed: 7, experimentId: "e1", graderId: "j", split: "test" });
    assert.equal(plan.picks.length, 30);
    assert.equal(plan.population, 300);
    assert.equal(
      plan.strata.reduce((s, x) => s + x.N, 0),
      300,
    );
    assert.deepEqual(
      plan.strata.map((s) => s.n),
      allocateProportional(
        plan.strata.map((s) => s.N),
        30,
      ).n,
    );
    for (const s of plan.strata) assert.equal(plan.picks.filter((p) => p.stratum === s.key).length, s.n, s.key);
    const pop = new Set(population);
    assert.ok(plan.picks.every((p) => pop.has(p.caseId)));
    assert.equal(new Set(plan.picks.map((p) => p.caseId)).size, 30, "no case picked twice");
    for (const p of plan.picks) assert.equal(p.alreadyLabelled, labelled.has(p.caseId));
    // Strata are verdict × confidence bins, each at least the 25-case minimum.
    assert.ok(plan.strata.some((s) => s.verdict === "pass") && plan.strata.some((s) => s.verdict === "fail"));
    assert.ok(plan.strata.every((s) => s.N >= 25), JSON.stringify(plan.strata));
    // Same seed → byte-identical; another seed → other picks.
    assert.equal(JSON.stringify(planAudit({ verdicts, population, labelled, budget: 30, seed: 7, experimentId: "e1", graderId: "j", split: "test" })), JSON.stringify(plan));
    assert.notDeepEqual(planAudit({ verdicts, population, labelled, budget: 30, seed: 8 }).picks, plan.picks);
    // 30 labels is far from the 738 a ±5 pp worst case needs.
    assert.match(plan.warnings.join("\n"), /^±\d+\.\d pp at 95% worst-case with this budget \(±5 pp needs 738 labels\)$/m);
    const text = renderAuditPlan(plan, { color: false, calibrateCmd: "coding.sh judge calibrate e1 --plan plan.json" });
    assert.match(text, /audit plan j {2}split test {2}30 of 300 cases \(seed 7\); \d+ of 30 already labelled/);
    assert.match(text, /verdict\s+confidence\s+N\s+n/);
    assert.match(text, /Then: coding\.sh judge calibrate e1 --plan plan\.json/);
  });

  it("unjudged cases form their own stratum; missing confidence its own bin", () => {
    const verdicts = new Map<string, JudgedCase>();
    const population = Array.from({ length: 40 }, (_, i) => id(i));
    for (let i = 0; i < 30; i++) verdicts.set(id(i), { caseId: id(i), pass: i % 3 !== 0, ...(i < 20 ? { confidence: 0.9 } : {}) });
    const plan = planAudit({ verdicts, population, labelled: new Set(), budget: 10, minStratum: 1 });
    const keys = plan.strata.map((s) => s.key);
    assert.ok(keys.includes("unjudged"));
    assert.ok(keys.includes("pass no-confidence"));
    assert.equal(plan.strata.find((s) => s.key === "unjudged")?.N, 10);
  });

  it("a budget below the strata falls back to one random sample; above the population, everything", () => {
    const { verdicts, population } = synthetic();
    const tiny = planAudit({ verdicts, population, labelled: new Set(), budget: 2 });
    assert.deepEqual(
      tiny.strata.map((s) => [s.key, s.N, s.n]),
      [["all", 300, 2]],
    );
    assert.match(tiny.warnings[0]!, /budget 2 is below the \d+ strata/);
    const all = planAudit({ verdicts, population: population.slice(0, 20), labelled: new Set(), budget: 50, minStratum: 1 });
    assert.equal(all.picks.length, 20);
    assert.match(all.warnings.join("\n"), /budget 50 is above the 20 cases in the population: every case is picked/);
  });

  it("round-trips through JSON and rejects other files", () => {
    const { verdicts, population } = synthetic();
    const plan = planAudit({ verdicts, population, labelled: new Set(), budget: 20 });
    assert.deepEqual(parseAuditPlan(JSON.parse(JSON.stringify(plan))), plan);
    assert.throws(() => parseAuditPlan({ kind: "x" }), /not a coding\.sh audit plan/);
    assert.throws(() => parseAuditPlan({ ...plan, picks: [{ caseId: "a", stratum: "nope" }] }), /outside its strata/);
  });

  it("simulation (1000 reps): labelling the plan's picks is unbiased; labelling the least confident 60 is not", () => {
    // Population 500, true pass 0.7, judge s 0.85 and α 0.3. A correct verdict has confidence in
    // [0.2, 1), a wrong one in [0, 0.8): low confidence leans toward the judge's mistakes.
    const rand = mulberry32(2026);
    const reps = 1000;
    let biasPlanRG = 0;
    let biasPlanStrat = 0;
    let biasLowRG = 0;
    let lowRuns = 0;
    let lowRefused = 0;
    for (let r = 0; r < reps; r++) {
      const human = new Map<string, boolean>();
      const verdicts = new Map<string, JudgedCase>();
      const population: string[] = [];
      for (let i = 0; i < 500; i++) {
        const h = rand() < 0.7;
        const j = rand() < (h ? 0.85 : 0.3);
        const confidence = j === h ? 0.2 + rand() * 0.8 : rand() * 0.8;
        human.set(id(i), h);
        verdicts.set(id(i), { caseId: id(i), pass: j, confidence });
        population.push(id(i));
      }
      const truth = [...human.values()].filter(Boolean).length / 500;
      const judgeRate = [...verdicts.values()].filter((v) => v.pass).length / 500;
      const rg = (ids: readonly string[]) => {
        let hp = 0;
        let hpj = 0;
        let hf = 0;
        let hfj = 0;
        for (const x of ids) {
          if (human.get(x)) {
            hp++;
            if (verdicts.get(x)!.pass) hpj++;
          } else {
            hf++;
            if (!verdicts.get(x)!.pass) hfj++;
          }
        }
        return roganGladen(judgeRate, hpj / hp, hfj / hf, 500, { positives: hp, negatives: hf }).p;
      };
      const plan = planAudit({ verdicts, population, labelled: new Set(), budget: 60, seed: r });
      const picks = plan.picks.map((p) => p.caseId);
      biasPlanRG += rg(picks) - truth;
      const labels: HumanLabel[] = picks.map((x) => ({ caseId: x, value: human.get(x) ? "pass" : "fail" }));
      biasPlanStrat += auditedPassRate(plan, labels).p - truth;
      const lowest = [...population].sort((a, b) => verdicts.get(a)!.confidence! - verdicts.get(b)!.confidence!).slice(0, 60);
      const low = rg(lowest);
      // Labelling only the judge's doubtful cases makes s + sp − 1 ≤ 0 most of the time: the correction is refused.
      if (Number.isNaN(low)) lowRefused++;
      else {
        biasLowRG += low - truth;
        lowRuns++;
      }
    }
    assert.ok(Math.abs(biasPlanRG / reps) < 0.01, `plan + Rogan–Gladen bias ${biasPlanRG / reps}`);
    assert.ok(Math.abs(biasPlanStrat / reps) < 0.01, `plan stratified bias ${biasPlanStrat / reps}`);
    assert.ok(lowRefused / reps > 0.5, `least-confident refusals ${lowRefused}`);
    assert.ok(Math.abs(biasLowRG / lowRuns) > 0.03, `least-confident bias ${biasLowRG / lowRuns}`);
  });
});

describe("auditedPassRate and calibrate --plan", () => {
  const { verdicts, population } = synthetic(3);
  const plan = planAudit({ verdicts, population, labelled: new Set(), budget: 40, seed: 1, split: "test" });
  const humanOf = (caseId: string) => (Number(caseId.slice(1)) % 4 === 0 ? "fail" : "pass");

  it("all picks labelled: the stratified mean, no bounds warning", () => {
    const labels: HumanLabel[] = plan.picks.map((p) => ({ caseId: p.caseId, value: humanOf(p.caseId) }));
    const a = auditedPassRate(plan, labels);
    assert.equal(a.coverage, 1);
    assert.equal(a.labelled, 40);
    // Eq.1 by hand.
    const want = plan.strata.reduce((s, st) => {
      const ps = plan.picks.filter((p) => p.stratum === st.key);
      return s + (st.N / 300) * (ps.filter((p) => humanOf(p.caseId) === "pass").length / ps.length);
    }, 0);
    assert.ok(Math.abs(a.p - want) < 1e-12);
    assert.ok(Math.abs(a.bounds.lo - want) < 1e-12 && Math.abs(a.bounds.hi - want) < 1e-12);
  });

  it("partly labelled: bounds bracket every completion; ties and skips count as unlabelled", () => {
    const labels: HumanLabel[] = plan.picks.slice(0, 30).map((p) => ({ caseId: p.caseId, value: humanOf(p.caseId) }));
    const tie = plan.picks[30]!.caseId;
    labels.push({ caseId: tie, value: "pass", by: "a" }, { caseId: tie, value: "fail", by: "b" }, { caseId: plan.picks[31]!.caseId, value: "skip" });
    const a = auditedPassRate(plan, labels);
    assert.equal(a.labelled, 30);
    assert.equal(a.coverage, 30 / 40);
    const allPass = auditedPassRate(plan, [...labels, ...plan.picks.slice(30).map((p) => ({ caseId: p.caseId, value: "pass" as const, by: "z" }))]);
    const allFail = auditedPassRate(plan, [...labels, ...plan.picks.slice(30).map((p) => ({ caseId: p.caseId, value: "fail" as const, by: "z" }))]);
    // The tie case gets a third vote, so it resolves; the completions sit on the bounds.
    assert.ok(Math.abs(allPass.p - a.bounds.hi) < 1e-12, `${allPass.p} vs ${a.bounds.hi}`);
    assert.ok(Math.abs(allFail.p - a.bounds.lo) < 1e-12, `${allFail.p} vs ${a.bounds.lo}`);
  });

  it("calibrate reports `audited` and renders it; κ state and exit-relevant fields unchanged", () => {
    const labels: HumanLabel[] = plan.picks.slice(0, 35).map((p) => ({ caseId: p.caseId, criterion: "correct", value: humanOf(p.caseId) }));
    const splits = Object.fromEntries(population.map((x) => [x, "test" as const]));
    const base = calibrate({ judge: { id: "j", tunedOn: ["dev"] }, labels, verdicts, splits, now: 1 });
    const withPlan = calibrate({ judge: { id: "j", tunedOn: ["dev"] }, labels, verdicts, splits, plan, now: 1 });
    assert.equal(base.audited, undefined);
    const { audited, ...rest } = withPlan;
    assert.deepEqual(rest, base, "the plan only adds `audited`");
    assert.equal(audited?.labelled, 35);
    const text = renderCalibration(withPlan, { color: false });
    assert.match(text, /^human-audited pass rate (\d\.\d\d \[\d\.\d\d, \d\.\d\d\]|—) \(35\/40 of plan labelled; /m);
    assert.match(text, /between \d\.\d\d and \d\.\d\d if the unlabelled picks all fail or all pass/);
    assert.match(text, /unlabelled picks make this estimate optimistic or pessimistic; label them/);
  });
});
