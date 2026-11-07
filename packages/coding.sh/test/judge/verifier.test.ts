// Verifier precision audit (EM-11): false accepts of a deterministic grader against human labels.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExperimentResult } from "../../src/datasets/types.ts";
import { compareExperiments } from "../../src/experiments/compare.ts";
import { renderComparison, renderExperiment } from "../../src/experiments/render.ts";
import {
  auditVerifier,
  formatVerifierAudit,
  humanValues,
  parseCaseLabels,
  renderVerifierAudit,
  samplePasses,
  verifierCorrected,
  type HumanLabel,
  type JudgedCase,
  type VerifierAudit,
} from "../../src/judge/index.ts";

const verdicts = (passes: number, fails: number) => {
  const m = new Map<string, JudgedCase>();
  for (let i = 0; i < passes; i++) m.set(`p${String(i).padStart(2, "0")}`, { caseId: `p${String(i).padStart(2, "0")}`, pass: true });
  for (let i = 0; i < fails; i++) m.set(`f${String(i).padStart(2, "0")}`, { caseId: `f${String(i).padStart(2, "0")}`, pass: false });
  return m;
};
const base = { graderId: "tests", graderVersion: "abc123", experimentId: "exp1", now: 1 };

describe("auditVerifier", () => {
  it("measures precision on labelled passes, false accepts and false rejects, in the shared cross-check shape", () => {
    const v = verdicts(10, 4);
    const labels: HumanLabel[] = [
      ...[...v.keys()].filter((id) => id.startsWith("p")).map((caseId, i) => ({ caseId, value: i < 8 ? ("pass" as const) : ("fail" as const) })),
      { caseId: "f00", value: "pass" },
      { caseId: "f01", value: "fail" },
    ];
    const a = auditVerifier({ ...base, verdicts: v, labels, minPasses: 10 });
    assert.equal(a.source, "human");
    assert.deepEqual([a.checked, a.agree, a.falseAccepts, a.falseRejects], [12, 9, 2, 1]);
    assert.deepEqual([a.passes, a.fails, a.state], [10, 2, "audited"]);
    assert.equal(a.precision, 0.8);
    assert.ok(a.precisionLo! < 0.8 && a.precisionHi! > 0.8 && a.precisionLo! > 0.4, "Wilson interval around 0.8");
    assert.equal(a.failPassRate, 0.5);
    assert.deepEqual(a.falseAcceptIds, ["p08", "p09"]);
    assert.deepEqual(a.falseRejectIds, ["f00"]);
    assert.equal(formatVerifierAudit(a).startsWith("verifier precision 0.80 ["), true);
    assert.match(formatVerifierAudit(a), /\(n=10\); 2 false accepts$/);
  });

  it("flags too few labelled passes and says how many more to label", () => {
    const a = auditVerifier({ ...base, verdicts: verdicts(5, 0), labels: [{ caseId: "p00", value: "pass" }] });
    assert.equal(a.state, "insufficient-data");
    assert.equal(a.failPassRate, undefined);
    const text = renderVerifierAudit(a);
    assert.match(text, /only 1 labelled pass\(es\); label at least 20 \(--sample-passes 19\)/);
    assert.match(text, /assume the verifier never rejects good work/);
    assert.equal(auditVerifier({ ...base, verdicts: verdicts(3, 0), labels: [] }).precision, undefined);
  });

  it("drops skips, other criteria and cases whose labellers disagree", () => {
    const labels: HumanLabel[] = [
      { caseId: "a", value: "pass", by: "x" },
      { caseId: "a", value: "fail", by: "y" },
      { caseId: "b", value: "skip" },
      { caseId: "c", value: "fail", criterion: "style" },
      { caseId: "d", value: "pass", criterion: "outcome" },
      { caseId: "e", value: "fail" },
    ];
    assert.deepEqual([...humanValues(labels, "outcome")], [
      ["d", "pass"],
      ["e", "fail"],
    ]);
  });
});

describe("verifierCorrected", () => {
  const audit = (precision: number, passes: number, failPassRate?: number, fails = 0) => ({ precision, passes, fails, ...(failPassRate !== undefined ? { failPassRate } : {}) }) as VerifierAudit;

  it("multiplies the pass rate by precision and adds back accepted fails", () => {
    const v = verifierCorrected(0.6, 100, audit(0.75, 40))!;
    assert.ok(Math.abs(v.p - 0.45) < 1e-12);
    assert.equal(v.assumesNoFalseRejects, true);
    assert.ok(v.lo < 0.45 && v.hi > 0.45);
    const w = verifierCorrected(0.6, 100, audit(0.75, 40, 0.1, 20))!;
    assert.ok(Math.abs(w.p - (0.45 + 0.04)) < 1e-12);
    assert.equal(w.assumesNoFalseRejects, false);
    assert.equal(verifierCorrected(0.6, 100, { passes: 0, fails: 0 } as unknown as VerifierAudit), undefined);
  });
});

describe("samplePasses", () => {
  it("returns a seeded, repeatable sample of unlabelled passes only", () => {
    const v = verdicts(30, 5);
    const labels: HumanLabel[] = [{ caseId: "p00", value: "pass" }];
    const a = samplePasses(v, labels, 10, { seed: 7 });
    assert.equal(a.length, 10);
    assert.deepEqual(samplePasses(v, labels, 10, { seed: 7 }), a);
    assert.notDeepEqual(samplePasses(v, labels, 10, { seed: 8 }), a);
    assert.ok(a.every((id) => id.startsWith("p") && id !== "p00"));
    assert.equal(samplePasses(v, labels, 100).length, 29);
  });
});

describe("parseCaseLabels", () => {
  it("accepts caseId/value rows and rejects bad ones with the row number", () => {
    assert.deepEqual(parseCaseLabels([{ caseId: "a", value: "pass", criterion: "outcome" }]), [{ caseId: "a", value: "pass", criterion: "outcome" }]);
    assert.throws(() => parseCaseLabels([{ caseId: "a", value: "maybe" }]), /row 1: value/);
    assert.throws(() => parseCaseLabels([{ value: "pass" }]), /row 1: caseId/);
  });
});

describe("compare and show with a verifier audit", () => {
  const exp = (id: string, passed: number): ExperimentResult =>
    ({
      id,
      name: id,
      createdAt: 1,
      dataset: { id: "ds", name: "ds", version: "v1" },
      task: { kind: "command", ref: "x" },
      trials: 1,
      graders: [{ id: "tests", version: "abc123", kind: "command" }],
      runs: Array.from({ length: 10 }, (_, i) => ({
        caseId: `c${i}`,
        trial: 0,
        pass: i < passed,
        latencyMs: 1,
        grades: [{ graderId: "tests", result: { pass: i < passed, score: i < passed ? 1 : 0 } }],
      })),
      summary: {
        n: 10,
        cases: 10,
        passed,
        errors: 0,
        passRate: { p: passed / 10, lo: 0, hi: 1 },
        ciMethod: "wilson",
        latencyMs: { median: 1, p90: 1, max: 1 },
        graders: [{ id: "tests", kind: "command", n: 10, passed, errors: 0, passRate: { p: passed / 10, lo: 0, hi: 1 }, meanScore: passed / 10 }],
      },
    }) as unknown as ExperimentResult;
  const a = auditVerifier({ ...base, verdicts: verdicts(8, 0), labels: ["p00", "p01", "p02", "p03", "p04", "p05", "p06", "p07"].map((caseId, i) => ({ caseId, value: i < 6 ? ("pass" as const) : ("fail" as const) })), minPasses: 5 });

  it("adds a verifier-corrected pass rate per side to the grader delta", () => {
    const cmp = compareExperiments(exp("A", 6), exp("B", 8), { iters: 200, verifiers: new Map([["abc123", a]]) });
    const g = cmp.graders.find((x) => x.id === "tests")!;
    assert.ok(Math.abs(g.verifier!.a!.p - 0.45) < 1e-12);
    assert.ok(Math.abs(g.verifier!.b!.p - 0.6) < 1e-12);
    assert.equal(g.verifier!.a!.n, 8);
    assert.match(renderComparison(cmp, { color: false }), /tests verifier-corrected pass {2}A 45\.0% .*\(precision 0\.75, n=8\) {2}B 60\.0% .*assumes no false rejects/);
    assert.equal(compareExperiments(exp("A", 6), exp("B", 8), { iters: 200 }).graders[0]!.verifier, undefined);
  });

  it("exp show puts the precision in the trust column and prints the corrected rate", () => {
    const text = renderExperiment(exp("A", 6), { color: false, verifiers: new Map([["abc123", a]]) });
    assert.match(text, /precision 0\.75 \(n=8\)/);
    assert.match(text, /tests verifier-corrected pass 45\.0% /);
    assert.doesNotMatch(renderExperiment(exp("A", 6), { color: false }), /verifier-corrected/);
  });
});
