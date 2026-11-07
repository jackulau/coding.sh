import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Split } from "../../src/datasets/types.ts";
import { calibrate, InSampleError, labelsFromCore, withCalibration, type HumanLabel, type JudgedCase } from "../../src/judge/calibrate.ts";
import { judgeVersionFor } from "../../src/judge/judge.ts";
import { renderCalibration } from "../../src/judge/render.ts";
import { cohenKappa } from "../../src/stats/agreement.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/** Build cases from confusion counts ("fail" is positive): tp both fail, fp judge-only fail, fn judge-only pass, tn both pass. */
function block(prefix: string, split: Split, c: { tp: number; fp: number; fn: number; tn: number }) {
  const labels: HumanLabel[] = [];
  const verdicts: JudgedCase[] = [];
  const splits: Record<string, Split> = {};
  const add = (kind: string, n: number, human: boolean, judge: boolean) => {
    for (let i = 0; i < n; i++) {
      const id = `${prefix}-${kind}-${i}`;
      labels.push({ caseId: id, criterion: "correct", value: human ? "pass" : "fail", by: "alice" });
      // Moderate confidence so these never count as "confidently opposite".
      verdicts.push({ caseId: id, pass: judge, score: judge ? 0.7 : 0.3, confidence: 0.4 });
      splits[id] = split;
    }
  };
  add("tp", c.tp, false, false);
  add("fp", c.fp, true, false);
  add("fn", c.fn, false, true);
  add("tn", c.tn, true, true);
  return { labels, verdicts, splits };
}

function merge(...bs: ReturnType<typeof block>[]) {
  return {
    labels: bs.flatMap((b) => b.labels),
    verdicts: bs.flatMap((b) => b.verdicts),
    splits: Object.assign({}, ...bs.map((b) => b.splits)) as Record<string, Split>,
  };
}

const judge = { id: "correct@abc", tunedOn: ["train", "dev"] as Split[], criterion: "correct" };

describe("calibrate: metrics", () => {
  it("matches hand-computed κ, confusion, precision and recall on the held-out split", () => {
    // n = 20: p_o = 17/20 = 0.85; judge fail 8/20, human fail 7/20
    // p_e = 0.4·0.35 + 0.6·0.65 = 0.53; κ = (0.85 − 0.53) / 0.47 = 0.680851…
    const d = merge(block("t", "test", { tp: 6, fp: 2, fn: 1, tn: 11 }), block("tr", "train", { tp: 5, fp: 0, fn: 0, tn: 5 }));
    const r = calibrate({ judge, ...d, seed: 1 });
    assert.equal(r.n, 20);
    close(r.agreement, 0.85);
    close(r.kappa, 0.32 / 0.47);
    assert.deepEqual(r.confusion, { tp: 6, fp: 2, fn: 1, tn: 11 });
    close(r.failPrecision, 6 / 8);
    close(r.failRecall, 6 / 7);
    close(r.failF1, (2 * 0.75 * (6 / 7)) / (0.75 + 6 / 7));
    close(r.humanFailRate, 0.35);
    close(r.judgeFailRate, 0.4);
    assert.equal(r.heldOut, true);
    assert.equal(r.state, "calibrated");
    assert.equal(r.status.state, "calibrated");
    close(r.status.kappa as number, 0.32 / 0.47);
    // Point estimate agrees with the shared stats implementation.
    const k = cohenKappa(
      d.verdicts.filter((v) => d.splits[v.caseId] === "test").map((v) => (v.pass ? "pass" : "fail")),
      d.labels.filter((l) => d.splits[l.caseId] === "test").map((l) => l.value),
    );
    close(k.kappa, r.kappa);
    // Train cases are reported separately, as in-sample diagnostics only.
    assert.equal(r.inSample?.n, 10);
    assert.equal(r.inSample?.kappa, 1);
    assert.deepEqual(r.inSample?.splits, ["train", "dev"]);
  });

  it("second textbook table: κ = 0.4 is uncalibrated at the 0.6 threshold", () => {
    // 50 items: both fail 20, judge-only fail 5, human-only fail 10, both pass 15.
    // p_o = 0.7, p_e = 0.5·0.6 + 0.5·0.4 = 0.5 → κ = 0.4
    const d = block("t", "test", { tp: 20, fp: 5, fn: 10, tn: 15 });
    const r = calibrate({ judge, ...d });
    close(r.kappa, 0.4);
    assert.equal(r.state, "uncalibrated");
    assert.match(r.reasons[0] ?? "", /κ = 0\.40 is below the 0\.6 threshold/);
    assert.equal(calibrate({ judge, ...d, kappaThreshold: 0.35 }).state, "calibrated");
  });

  it("bootstrap CI brackets κ and is reproducible for a seed", () => {
    const d = block("t", "test", { tp: 20, fp: 5, fn: 10, tn: 15 });
    const a = calibrate({ judge, ...d, seed: 42, bootstrapIters: 1000 });
    const b = calibrate({ judge, ...d, seed: 42, bootstrapIters: 1000 });
    assert.deepEqual(a.kappaCI, b.kappaCI);
    assert.ok(a.kappaCI.lo < a.kappa && a.kappa < a.kappaCI.hi, JSON.stringify(a.kappaCI));
    assert.ok(a.kappaCI.lo > 0 && a.kappaCI.hi < 0.75, JSON.stringify(a.kappaCI));
    assert.equal(a.kappaCI.iters, 1000);
    assert.notDeepEqual(calibrate({ judge, ...d, seed: 7, bootstrapIters: 1000 }).kappaCI, a.kappaCI);
  });

  it("insufficient data: too few cases, or one class only", () => {
    const few = calibrate({ judge, ...block("t", "test", { tp: 3, fp: 0, fn: 0, tn: 3 }) });
    assert.equal(few.state, "insufficient-data");
    assert.match(few.reasons[0] ?? "", /only 6 held-out/);
    const oneClass = calibrate({ judge, ...block("t", "test", { tp: 0, fp: 0, fn: 0, tn: 30 }) });
    assert.ok(Number.isNaN(oneClass.kappa));
    assert.equal(oneClass.state, "insufficient-data");
    assert.match(oneClass.reasons.join(" "), /κ is undefined/);
    assert.match(oneClass.reasons.join(" "), /recall on failures is unknown/);
  });
});

describe("calibrate: held-out discipline", () => {
  const d = merge(block("dv", "dev", { tp: 10, fp: 0, fn: 0, tn: 10 }), block("t", "test", { tp: 10, fp: 0, fn: 0, tn: 10 }));

  it("flags κ on a tuning split as in-sample, never calibrated", () => {
    const r = calibrate({ judge, ...d, reportSplit: "dev" });
    assert.equal(r.kappa, 1);
    assert.equal(r.heldOut, false);
    assert.equal(r.state, "in-sample");
    assert.equal(r.status.state, "in-sample");
    assert.match(r.reasons[0] ?? "", /in-sample/);
    const text = renderCalibration(r, { color: false });
    assert.match(text, /IN-SAMPLE/);
  });

  it("strict mode refuses outright", () => {
    assert.throws(() => calibrate({ judge, ...d, reportSplit: "dev", strict: true }), InSampleError);
  });

  it("a judge tuned on test cannot be calibrated on test", () => {
    const r = calibrate({ judge: { ...judge, tunedOn: ["test"] }, ...d });
    assert.equal(r.state, "in-sample");
  });
});

describe("calibrate: noisy labels and exclusions", () => {
  it("surfaces labeler disagreement and confidently-opposite verdicts", () => {
    const d = block("t", "test", { tp: 10, fp: 0, fn: 0, tn: 10 });
    const labels: HumanLabel[] = [
      ...d.labels,
      // disagreement resolved by majority (2 fail vs 1 pass)
      { caseId: "m1", criterion: "correct", value: "fail", by: "a" },
      { caseId: "m1", criterion: "correct", value: "fail", by: "b" },
      { caseId: "m1", criterion: "correct", value: "pass", by: "c" },
      // tie: excluded from metrics, still surfaced
      { caseId: "tie", criterion: "correct", value: "fail", by: "a" },
      { caseId: "tie", criterion: "correct", value: "pass", by: "b" },
      // unanimous pass but the judge is sure it failed
      { caseId: "opp", criterion: "correct", value: "pass", by: "a" },
      { caseId: "opp", criterion: "correct", value: "pass", by: "b" },
      // other criteria and skips are ignored
      { caseId: "opp", criterion: "style", value: "fail", by: "z" },
      { caseId: "opp", criterion: "correct", value: "skip", by: "z" },
      // labelled but never judged; and no split
      { caseId: "unjudged", criterion: "correct", value: "pass" },
      { caseId: "nosplit", value: "fail" },
    ];
    const verdicts: JudgedCase[] = [
      ...d.verdicts,
      { caseId: "m1", pass: false, score: 0.1 },
      { caseId: "tie", pass: true, score: 0.9 },
      { caseId: "opp", pass: false, score: 0.02, reason: "deleted files" },
      { caseId: "nosplit", pass: false, score: 0.2 },
      { caseId: "unlabelled", pass: true },
    ];
    const splits = { ...d.splits, m1: "test", tie: "test", opp: "test", unjudged: "test" } as Record<string, Split>;
    const r = calibrate({ judge, labels, verdicts, splits });
    assert.deepEqual(r.excluded, { noVerdict: 1, noLabel: 1, tied: 1, noSplit: 1 });
    assert.equal(r.n, 22); // 20 + m1 + opp
    const kinds = r.noisy.map((n) => [n.caseId, n.kind]);
    assert.deepEqual(kinds, [
      ["m1", "labeler-disagreement"],
      ["tie", "labeler-disagreement"],
      ["opp", "judge-confident-opposite"],
    ]);
    const opp = r.noisy[2];
    close(opp?.judge?.confidence as number, 0.96);
    assert.match(opp?.detail ?? "", /humans say pass \(2\/2\), judge says fail at confidence 0\.96/);
    const text = renderCalibration(r, { color: false });
    assert.match(text, /relabel 3 case\(s\)/);
    assert.match(text, /judge-confident-opposite/);
    assert.match(text, /excluded: 1 tied human vote\(s\), 1 labelled but unjudged, 1 judged but unlabelled, 1 without a split/);
  });

  it("accepts a Dataset or Map for splits and core labels by session", () => {
    const labels = labelsFromCore(
      [
        { id: "l1", sessionId: "s1", criterion: "correct", value: "fail", by: "me", ts: 1 },
        { id: "l2", sessionId: "s2", criterion: "correct", value: "pass", by: "me", ts: 1 },
      ],
      (s) => (s === "s1" ? "case-1" : undefined),
    );
    assert.deepEqual(labels, [{ caseId: "case-1", criterion: "correct", value: "fail", by: "me" }]);
    const r = calibrate({
      judge,
      labels,
      verdicts: new Map([["case-1", { caseId: "case-1", pass: false }]]),
      splits: { id: "d", name: "d", version: "v", cases: [{ id: "case-1", input: 1, split: "test" }] },
      minN: 1,
    });
    assert.equal(r.n, 1);
    assert.deepEqual(r.confusion, { tp: 1, fp: 0, fn: 0, tn: 0 });
  });
});

describe("calibration → judge version", () => {
  it("attaches status to the version and renders a report", () => {
    const v = judgeVersionFor({ name: "correct", rubric: "r", provider: { name: "fake", model: "m", params: {}, complete: async () => ({ text: "", model: "m" }) } });
    const r = calibrate({ judge: v, ...block("t", "test", { tp: 6, fp: 2, fn: 1, tn: 11 }), now: 123 });
    const next = withCalibration(v, r);
    assert.equal(next.calibration?.state, "calibrated");
    assert.equal(next.calibration?.ts, 123);
    assert.equal(next.id, v.id);
    const text = renderCalibration(r, { color: false });
    assert.match(text, /status {2}calibrated κ=0\.68/);
    assert.match(text, /cohen κ {8}0\.68 \[/);
    assert.match(text, /fail precision 75\.0%/);
    assert.match(text, /human fail\s+6\s+1/);
    assert.ok(!/\u001b\[/.test(text), "no ANSI without color");
    assert.ok(/\u001b\[/.test(renderCalibration(r, { color: true })));
  });
});

// AB-17: label efficiency η and the cost break-even (Choi et al., arXiv 2610.35698, Eq.6-8).
describe("calibrate: label efficiency", () => {
  const weakJudge = { tp: 299, fp: 312, fn: 201, tn: 1688 };

  it("the paper's pooled point (s 0.844, α 0.402, θ 0.8): η ≈ 0.207, a reason, status untouched", () => {
    // pass recall 1688/2000 = 0.844; false-pass 201/500 = 0.402; judge pass 1889/2500 → Rogan–Gladen θ = 0.8.
    const r = calibrate({ judge, ...block("t", "test", weakJudge), kappaThreshold: 0.3, bootstrapIters: 200 });
    const e = r.efficiency!;
    close(e.sensitivity, 0.844);
    close(e.alpha, 0.402);
    close(e.gap, 0.442);
    close(e.theta, 0.8);
    assert.equal(e.thetaFrom, "corrected-judge");
    assert.equal(e.judged, 2500);
    close(e.eta!, 0.2073, 1e-3);
    assert.equal(r.state, "calibrated");
    assert.equal(r.status.state, "calibrated");
    assert.ok(r.reasons.some((x) => /label efficiency η = 0\.21 < 1: auditing outputs directly needs ~4\.8x fewer/.test(x)), r.reasons.join("\n"));
    assert.equal(e.judgeCost, undefined);
    const text = renderCalibration(r, { color: false });
    assert.match(text, /discrimination gap 0\.44 \(pass-recall 0\.84, false-pass 0\.40\)/);
    assert.match(text, /label efficiency η 0\.21 · auditing outputs directly needs ~4\.8x fewer human labels for the same precision \(at pass rate 0\.80, corrected over 2500 judged test cases\)/);
  });

  it("a sharp judge (s = sp = 0.95, θ 0.5): η ≈ 4.26, no reason, break-even ≈ $0.0046 at $0.001 per call", () => {
    const r = calibrate({ judge, ...block("t", "test", { tp: 190, fp: 10, fn: 10, tn: 190 }), judgeCost: 0.001, bootstrapIters: 200 });
    const e = r.efficiency!;
    close(e.theta, 0.5);
    close(e.eta!, 4.263, 1e-3);
    close(e.n1Share!, 0.5);
    close(e.breakEvenHumanCost!, 0.004643, 1e-5);
    assert.ok(!r.reasons.some((x) => /efficiency|discrimination/.test(x)));
    const text = renderCalibration(r, { color: false });
    assert.match(text, /label efficiency η 4\.26 · calibrating this judge needs ~0\.23x the labels a direct audit would/);
    assert.match(text, /judge pays off when a human label costs more than \$0\.0046 \(judge call \$0\.001\)/);
    // η < 1 never breaks even.
    const weak = calibrate({ judge, ...block("t", "test", weakJudge), judgeCost: 0.001, bootstrapIters: 200 });
    assert.equal(weak.efficiency!.breakEvenHumanCost, null);
    assert.match(renderCalibration(weak, { color: false }), /no break-even: the judge never saves labels at this accuracy/);
  });

  it("no discrimination (gap 0): no η, θ from human labels, a reason, no throw", () => {
    const r = calibrate({ judge, ...block("t", "test", { tp: 20, fp: 20, fn: 20, tn: 20 }), judgeCost: 0.001, bootstrapIters: 200 });
    const e = r.efficiency!;
    close(e.gap, 0);
    assert.equal(e.eta, undefined);
    assert.equal(e.thetaFrom, "human-labels");
    close(e.theta, 0.5);
    assert.equal(e.breakEvenHumanCost, null);
    assert.ok(r.reasons.some((x) => /gap ≤ 0/.test(x)));
    assert.match(renderCalibration(r, { color: false }), /discrimination gap 0\.00/);
  });

  it("a small gap adds a discrimination reason", () => {
    // s = 30/40 = 0.75, α = 25/40 = 0.625 → gap 0.125.
    const r = calibrate({ judge, ...block("t", "test", { tp: 15, fp: 10, fn: 25, tn: 30 }), kappaThreshold: 0, bootstrapIters: 200 });
    close(r.efficiency!.gap, 0.125);
    assert.ok(r.reasons.some((x) => /discrimination gap 0\.13 < 0\.2/.test(x)), r.reasons.join("\n"));
  });

  it("in-sample reports carry no efficiency (in-sample rates flatter the judge)", () => {
    const r = calibrate({ judge, ...block("d", "dev", { tp: 190, fp: 10, fn: 10, tn: 190 }), reportSplit: "dev", bootstrapIters: 200 });
    assert.equal(r.efficiency, undefined);
    assert.ok(!/label efficiency/.test(renderCalibration(r, { color: false })));
  });
});
