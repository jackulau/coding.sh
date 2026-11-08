import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { EvalTask } from "../../src/core/types.ts";
import { compare, formatCompare, runExperiment } from "../../src/runner/experiment.ts";
import type { RepairOpts } from "../../src/runner/repair.ts";
import { FIXED, cleanupWorlds, fakeAdapter, toyWorld } from "../helpers-eval.ts";

after(cleanupWorlds);

type Files = Record<string, string> | undefined;
const FIX: Files = { "src/add.js": FIXED["src/add.js"] as string, "src/mul.js": FIXED["src/mul.js"] as string };
const HALF: Files = { "src/add.js": FIXED["src/add.js"] as string };
const WRONG: Files = { "src/mul.js": "export function mul(a, b) {\n  return a - b;\n}\n" };

/** An agent scripted per task: plan[task](n) is what its n-th call in a run writes (1 = the first attempt). */
const scripted = (plan: Record<string, (n: number) => Files>, costUsd = 0.1) => {
  const taskOf = new Map<string, string>();
  const calls = new Map<string, number>();
  return fakeAdapter({
    canResume: true,
    usage: { costUsd },
    act: (spec) => {
      if (!spec.resumeSessionId) taskOf.set(spec.runId, spec.instruction);
      const n = (calls.get(spec.runId) ?? 0) + 1;
      calls.set(spec.runId, n);
      return plan[taskOf.get(spec.runId) ?? ""]?.(n);
    },
  });
};

const tasksOf = (base: EvalTask) => ["t1", "t2", "t3"].map((id) => ({ ...base, id, name: id, instruction: id }));

// t1 passes first; t2 after round 1; t3 never, and changes nothing in round 2.
const CURVE: Record<string, (n: number) => Files> = {
  t1: () => FIX,
  t2: (n) => (n === 1 ? HALF : FIX),
  t3: (n) => (n === 1 ? HALF : n === 2 ? WRONG : undefined),
};

async function experiment(plans: Record<string, (n: number) => Files>[], repair: RepairOpts | RepairOpts[], k = 1) {
  const w = await toyWorld();
  const tasks = tasksOf(w.task);
  const bundles = await Promise.all(plans.map((_, i) => w.mkBundle(`arm${i}`, `arm${i}`)));
  const results = [];
  for (const [i, b] of bundles.entries()) {
    const adapter = scripted(plans[i]!);
    const res = await runExperiment({ tasks, bundles: [b], adapterFor: () => adapter, blobs: w.blobs, index: w.index, git: w.git, runsDir: w.runsDir, k, repair: Array.isArray(repair) ? repair[i] : repair });
    results.push(...res.results);
  }
  return { results, ids: bundles.map((b) => b.id) };
}

describe("Seq@K over repair rounds", () => {
  it("curve, gain shares, unchanged rounds and cost to solve; no pass@k or front with one attempt", async () => {
    const { results, ids } = await experiment([CURVE, CURVE], { rounds: 2, signal: "bit" });
    const t3 = results.find((r) => r.taskId === "t3" && r.bundleId === ids[0]);
    assert.equal(t3?.repair?.rounds[0]?.unchanged, undefined, "a round that edits is not unchanged");
    assert.equal(t3?.repair?.rounds[1]?.unchanged, true, "an empty round is");
    assert.equal(results.find((r) => r.taskId === "t2")?.repair?.rounds[0]?.unchanged, undefined);

    const r = compare(results, { baseline: ids[0]!, candidate: ids[1]!, iters: 200, seed: 1 });
    const s = r.baseline.seq!;
    assert.equal(s.k, 3);
    assert.deepEqual(
      s.curve.map((p) => p.rate),
      [1 / 3, 2 / 3, 2 / 3],
    );
    assert.ok(s.curve.every((p) => p.lo <= p.rate && p.rate <= p.hi));
    assert.equal(s.egs, 1);
    assert.equal(s.lgs, 0);
    assert.equal(s.unchanged, 1);
    assert.equal(s.unchangedRate, 1 / 3);
    // $0.10 + $0.20 + $0.30 over 2 solved runs.
    assert.ok(Math.abs((s.costToSolve ?? 0) - 0.3) < 1e-9);
    assert.equal(s.passAtK, undefined);
    assert.equal(s.front, undefined);
    assert.deepEqual(r.seqRanking?.flipped, []);
    assert.ok(!r.notes.some((n) => n.startsWith("ranking changes")), "no flip, no note");

    const text = formatCompare(r);
    assert.match(text, /^seq@1 \(first\) +33\.3% \[[\d.]+–[\d.]+%\] +33\.3% .* \+0\.0 pp$/m);
    assert.match(text, /^seq@3 +66\.7% /m);
    assert.match(text, /^gain shares +EGS 1\.00 · LGS 0\.00 +EGS 1\.00 · LGS 0\.00/m);
    assert.match(text, /^unchanged +1\/3 \(33%\) +1\/3 \(33%\) +rounds that changed no file$/m);
    assert.match(text, /^cost to solve +\$0\.300 +\$0\.300/m);
    assert.doesNotMatch(text, /^front /m);
    assert.doesNotMatch(text, /^after repair/m, "only with false alarms");
  });

  it("notes a ranking that flips with verifier feedback, and only then", async () => {
    // A solves t1 first and never repairs; B solves nothing first and everything after one round.
    const firstOnly = { t1: () => FIX, t2: () => HALF, t3: () => HALF };
    const repairs = { t1: (n: number) => (n === 1 ? HALF : FIX), t2: (n: number) => (n === 1 ? HALF : FIX), t3: (n: number) => (n === 1 ? HALF : FIX) };
    const { results, ids } = await experiment([firstOnly, repairs], { rounds: 1, signal: "bit" });
    const r = compare(results, { baseline: ids[0]!, candidate: ids[1]!, iters: 200, seed: 1 });
    assert.equal(r.seqRanking?.k, 2);
    assert.deepEqual(r.seqRanking?.byPass1, { baseline: 1 / 3, candidate: 0 });
    assert.deepEqual(r.seqRanking?.bySeqK, { baseline: 1 / 3, candidate: 1 });
    assert.equal(r.seqRanking?.kendallTau, -1);
    assert.ok(r.notes.includes("ranking changes with verifier feedback: baseline beats candidate on first pass, candidate beats baseline within 2 attempts"));
    assert.equal(r.baseline.seq?.unchangedRate, 1, "rewriting the same file is no change");

    const both = await experiment([{ ...firstOnly, t2: repairs.t2, t3: repairs.t3 }, repairs], { rounds: 1, signal: "bit" });
    const n = compare(both.results, { baseline: both.ids[0]!, candidate: both.ids[1]!, iters: 200, seed: 1 });
    assert.deepEqual(n.seqRanking?.flipped, []);
    assert.ok(!n.notes.some((x) => x.startsWith("ranking changes")));
  });

  it("several attempts per task add pass@k and the cost front", async () => {
    const { results, ids } = await experiment([CURVE, CURVE], { rounds: 2, signal: "bit" }, 3);
    const r = compare(results, { baseline: ids[0]!, candidate: ids[1]!, iters: 200, seed: 1 });
    const s = r.baseline.seq!;
    assert.deepEqual(
      s.passAtK?.map((p) => [p.k, p.rate]),
      [
        [1, 1 / 3],
        [2, 1 / 3],
        [3, 1 / 3],
      ],
    );
    assert.ok(s.front?.length);
    // pass@1 and seq@1 are the same point; seq@2 buys t2 for less than pass@2 buys nothing.
    const seq2 = s.front!.find((p) => p.protocol === "seq@k" && p.k === 2);
    assert.ok(seq2?.overall);
    assert.ok(Math.abs(seq2!.cost - (0.1 + 0.2 + 0.2) / 3) < 1e-9);
    // pass@k gains nothing here: pass@2 leads its own protocol but no point overall, pass@3 not even that.
    assert.deepEqual(
      s.front!.filter((p) => p.protocol === "pass@k").map((p) => [p.k, p.overall]),
      [[2, false]],
    );
    const text = formatCompare(r);
    assert.match(text, /^front A +pass@2 \$0\.200 33\.3% · seq@1 \$0\.100 33\.3%\* · seq@2 \$0\.167 66\.7%\*$/m);
    assert.match(text, /\* = no protocol does better at that cost/);
  });

  it("arms with different repair settings are not ranked", async () => {
    const { results, ids } = await experiment([CURVE, CURVE], [{ rounds: 1, signal: "bit" }, { rounds: 2, signal: "bit" }]);
    const r = compare(results, { baseline: ids[0]!, candidate: ids[1]!, iters: 200, seed: 1 });
    assert.equal(r.seqRanking, undefined);
    assert.ok(r.notes.some((n) => n.startsWith("the arms ran different repair settings") && n.endsWith("not ranked by Seq@K")));
    assert.equal(r.baseline.seq?.k, 2);
    assert.equal(r.candidate.seq?.k, 3);
    assert.match(formatCompare(r), /^seq@3 +— +66\.7%/m);
  });

  it("false alarms add the after-repair row", async () => {
    const { results, ids } = await experiment([CURVE, CURVE], { rounds: 1, signal: "bit", falseAlarm: 1 });
    const r = compare(results, { baseline: ids[0]!, candidate: ids[1]!, iters: 200, seed: 1 });
    assert.equal(r.baseline.repair?.falseAlarm?.fired, 1);
    assert.match(formatCompare(r), /^after repair +/m);
  });
});
