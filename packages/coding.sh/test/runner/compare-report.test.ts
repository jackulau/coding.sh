// R1-10: per arm, cost and tokens per solved task, unbiased pass@k and pass^k,
// flaky tasks, and the paired tasks needed at 80% power. Values below are
// worked by hand from the fixture; the text report is a golden
// (UPDATE_GOLDEN=1 rewrites it).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunResult } from "../../src/core/types.ts";
import { armEfficiency, compare, formatCompare, tasksNeeded } from "../../src/runner/experiment.ts";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/runner/compare-k3.txt");

function run(taskId: string, bundleId: string, attempt: number, pass: boolean, usd: number, tokens: number): RunResult {
  return {
    id: `${bundleId}-${taskId}-${attempt}`,
    taskId,
    bundleId,
    attempt,
    pass,
    verifierExit: pass ? 0 : 1,
    agent: { exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "", usage: { costUsd: usd, inputTokens: tokens - 100, outputTokens: 100 } },
    startedAt: 0,
    endedAt: 2000,
  };
}

/** Outcomes per task, one letter per attempt. */
function arm(bundleId: string, outcomes: Record<string, string>, usd: number, tokens: number): RunResult[] {
  return Object.entries(outcomes).flatMap(([t, s]) => [...s].map((ch, i) => run(t, bundleId, i + 1, ch === "P", usd, tokens)));
}

// k = 3 attempts per task.
// A: t1 PPP, t2 PFF, t3 FFF, t4 PPF → 6/12 passes, $0.10 and 1000 tokens a run.
// B: t1 PPP, t2 PPP, t3 PFF, t4 PPP → 10/12 passes, $0.20 and 1500 tokens a run.
const K3 = [...arm("A", { t1: "PPP", t2: "PFF", t3: "FFF", t4: "PPF" }, 0.1, 1000), ...arm("B", { t1: "PPP", t2: "PPP", t3: "PFF", t4: "PPP" }, 0.2, 1500)];

const close = (a: number | null | undefined, b: number, msg?: string) => assert.ok(typeof a === "number" && Math.abs(a - b) < 1e-9, `${msg ?? ""} ${a} ≠ ${b}`);

describe("compare: efficiency, reliability and tasks needed", () => {
  const r = compare(K3, { baseline: "A", candidate: "B", iters: 400 });

  it("cost and tokens per solved task, by hand", () => {
    const { baseline: a, candidate: b } = r.efficiency;
    // A: 12 runs × $0.10 = $1.20 over 6 solved; 12 × 1000 tokens over 6.
    assert.equal(a.solved, 6);
    assert.equal(a.costRuns, 12);
    close(a.costUsd, 1.2);
    close(a.costPerSolved, 0.2);
    close(a.tokensPerSolved, 2000);
    // B: 12 × $0.20 = $2.40 over 10 solved; 12 × 1500 over 10.
    assert.equal(b.solved, 10);
    close(b.costPerSolved, 0.24);
    close(b.tokensPerSolved, 1800);
  });

  it("pass@3, pass^3 and flaky tasks, by hand", () => {
    const { baseline: a, candidate: b } = r.reliability;
    assert.equal(a.k, 3);
    // A per task c/n: 3/3, 1/3, 0/3, 2/3.
    close(a.passAt1, (1 + 1 / 3 + 0 + 2 / 3) / 4);
    close(a.passAnyK, (1 + 1 + 0 + 1) / 4, "pass@3 A");
    close(a.passAllK, (1 + 0 + 0 + 0) / 4, "pass^3 A");
    assert.deepEqual(a.flaky, ["t2", "t4"]);
    close(a.flakeRate, 0.5);
    // B per task: 3/3, 3/3, 1/3, 3/3.
    close(b.passAt1, (1 + 1 + 1 / 3 + 1) / 4);
    close(b.passAnyK, 1, "pass@3 B");
    close(b.passAllK, 3 / 4, "pass^3 B");
    assert.deepEqual(b.flaky, ["t3"]);
    close(b.flakeRate, 0.25);
  });

  it("unbiased pass@k and pass^k when a task has more runs than k", () => {
    // n = 4, c = 2, k = 3 for t1 (A has 3 runs elsewhere, so k is 4 overall — use reliability on its own).
    const rs = [...arm("A", { t1: "PPFF", t2: "PPPF" }, 0.1, 100), ...arm("B", { t1: "PPPP", t2: "PPPP" }, 0.1, 100)];
    const rel = compare(rs, { baseline: "A", candidate: "B", iters: 100 }).reliability.baseline;
    assert.equal(rel.k, 4);
    // k = n = 4: pass@4 = any, pass^4 = all.
    close(rel.passAnyK, 1);
    close(rel.passAllK, 0);
  });

  it("tasks needed: Connor's McNemar sample size, by hand", () => {
    // Majority outcomes: A passes t1, t4; B passes t1, t2, t4. b = 0, c = 1, 4 paired.
    // pd = 0.25, δ = 0.25: n = ⌈(1.95996·0.5 + 0.84162·√0.1875)² / 0.0625⌉ = ⌈28.92⌉ = 29.
    assert.deepEqual(r.plan.discordant, { b: 0, c: 1 });
    assert.equal(r.plan.paired, 4);
    close(r.plan.effect, 0.25);
    assert.equal(r.plan.tasksNeeded, 29);
    // b = 4, c = 8 of 60: pd = 0.2, δ = 1/15 → ⌈350.8⌉.
    assert.equal(tasksNeeded(4, 8, 60).tasksNeeded, 351);
    assert.equal(tasksNeeded(0, 0, 10).tasksNeeded, null);
    assert.match(tasksNeeded(0, 0, 10).reason ?? "", /no discordant/);
    assert.equal(tasksNeeded(3, 3, 10).tasksNeeded, null);
    assert.match(tasksNeeded(3, 3, 10).reason ?? "", /no observed effect/);
    assert.equal(tasksNeeded(0, 0, 0).tasksNeeded, null);
  });

  it("nothing solved or no cost known gives null, shown as —", () => {
    const none = armEfficiency(arm("A", { t1: "FF" }, 0.1, 100));
    assert.equal(none.costPerSolved, null);
    assert.equal(none.tokensPerSolved, null);
    const unpriced = armEfficiency([{ ...run("t1", "A", 1, true, 0, 0), agent: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" } }]);
    assert.equal(unpriced.costPerSolved, null);
    assert.equal(unpriced.costRuns, 0);
    const rs = [...arm("A", { t1: "F", t2: "F" }, 0.1, 100), ...arm("B", { t1: "P", t2: "F" }, 0.1, 100)];
    assert.match(formatCompare(compare(rs, { baseline: "A", candidate: "B", iters: 100 })), /^cost \/ solved +— +\$0\.200$/m);
  });

  it("k = 1: no pass@k, pass^k or flaky rows", () => {
    const rs = [...arm("A", { t1: "P", t2: "F", t3: "P" }, 0.1, 100), ...arm("B", { t1: "P", t2: "P", t3: "P" }, 0.1, 100)];
    const r1 = compare(rs, { baseline: "A", candidate: "B", iters: 100 });
    assert.equal(r1.reliability.baseline.passAnyK, undefined);
    assert.equal(r1.reliability.baseline.passAllK, undefined);
    const text = formatCompare(r1);
    assert.doesNotMatch(text, /pass@|pass\^|flaky tasks/);
    assert.match(text, /^cost \/ solved /m);
    assert.match(text, /^tasks needed /m);
  });

  it("a cost per solved task 25% apart under a tie gets a note", () => {
    // Same outcomes, the candidate costs twice as much a run.
    const rs = [...arm("A", { t1: "PF", t2: "PF" }, 0.1, 100), ...arm("B", { t1: "PF", t2: "PF" }, 0.2, 100)];
    const r2 = compare(rs, { baseline: "A", candidate: "B", iters: 100 });
    assert.ok(r2.notes.some((n) => /costs 100% more per solved task/.test(n)), r2.notes.join("\n"));
  });

  it("the k = 3 text report matches its golden", () => {
    const text = formatCompare(r, { color: false });
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, text + "\n");
    }
    assert.equal(text + "\n", readFileSync(GOLDEN, "utf8"), "golden mismatch: test/fixtures/runner/compare-k3.txt (UPDATE_GOLDEN=1 to accept)");
    for (const re of [/^pass@3 +75\.0% +100\.0%/m, /^pass\^3 +25\.0% +75\.0%/m, /^flaky tasks +2\/4 +1\/4/m, /^cost \/ solved +\$0\.20\d* +\$0\.24/m, /^tasks needed 29 /m]) assert.match(text, re);
  });
});

describe("compare: one task", () => {
  // 1 of 10 against 7 of 10 on a single task (the ticket's example, candidate better).
  const one = [...arm("A", { t1: "PFFFFFFFFF" }, 0.1, 1000), ...arm("B", { t1: "PPPPPPPFFF" }, 0.1, 1000)];
  const r = compare(one, { baseline: "A", candidate: "B", iters: 400 });
  const text = formatCompare(r);

  it("reads the runs: Newcombe interval about 17 to 81 points and Fisher p about 0.02", () => {
    assert.ok(r.oneTask);
    close(r.oneTask.diff.p, 0.6);
    assert.ok(Math.abs(r.oneTask.diff.lo - 0.17) < 0.005 && Math.abs(r.oneTask.diff.hi - 0.81) < 0.005, `${r.oneTask.diff.lo} ${r.oneTask.diff.hi}`);
    assert.ok(Math.abs(r.oneTask.fisherP - 0.0198) < 0.001);
    assert.notEqual(r.oneTask.diff.lo, r.oneTask.diff.hi);
  });

  it("prints no task bootstrap, McNemar, tasks-needed line or trust-the-bootstrap note, and says what the numbers are", () => {
    assert.match(text, /\+60\.0 pp \[\+17\.\d, \+80\.\d pp\]/);
    assert.match(text, /Fisher p = 0\.020/);
    assert.match(text, /runs of one task.*says nothing about other tasks/);
    assert.doesNotMatch(text, /McNemar|tasks needed|the one to trust|\[\+?60\.0, \+?60\.0/);
    assert.ok(!r.notes.some((n) => /one to trust/.test(n)));
  });

  it("the verdict agrees with the interval and is never better or worse from one task", () => {
    assert.equal(r.verdict.kind, "inconclusive");
    assert.match(r.verdict.text, /\+60\.0 pp pass rate on this task.*CI \[\+17\.\d pp, \+80\.\d pp\] \(Newcombe\), Fisher p = 0\.020; says nothing about other tasks/);
    assert.doesNotMatch(r.verdict.text, /McNemar|bootstrap|underpowered/);
  });

  it("keeps the existing JSON fields and plans no task count", () => {
    assert.equal(r.diff.lo, r.diff.hi, "the task bootstrap field is unchanged");
    assert.equal(r.plan.tasksNeeded, null);
    assert.ok("mcnemar" in r);
  });

  it("an even split on one task is no difference, with an interval that spans 0", () => {
    const even = compare([...arm("A", { t1: "PPPPPFFFFF" }, 0.1, 1000), ...arm("B", { t1: "PPPPFFFFFF" }, 0.1, 1000)], { baseline: "A", candidate: "B", iters: 400 });
    assert.equal(even.verdict.kind, "no-difference");
    assert.ok(even.oneTask && even.oneTask.diff.lo < 0 && even.oneTask.diff.hi > 0);
  });

  it("two tasks keep the task bootstrap, McNemar and the note", () => {
    const two = compare([...arm("A", { t1: "PPP", t2: "FFF" }, 0.1, 1000), ...arm("B", { t1: "PPP", t2: "PPP" }, 0.1, 1000)], { baseline: "A", candidate: "B", iters: 400 });
    assert.equal(two.oneTask, undefined);
    assert.match(formatCompare(two), /McNemar/);
    assert.ok(two.notes.some((n) => /one to trust/.test(n)));
  });
});
