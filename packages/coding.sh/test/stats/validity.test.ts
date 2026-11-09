// Z-11: signal validity, pooled vs within-task vs within-task-and-arm AUROC (arXiv 2611.08285).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSignalValidity, hasRepeatedAttempts, mulberry32, signalRows, signalValidity, type SignalRow, type SignalValidity } from "../../src/stats/index.ts";

const close = (a: number, b: number, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const get = (v: SignalValidity[], s: string) => v.find((r) => r.signal === s)!;

/** 10 tasks × 2 arms × 3 attempts; task t fails with a probability that rises with t. */
function fixture(seed = 7): SignalRow[] {
  const rand = mulberry32(seed);
  const rows: SignalRow[] = [];
  for (let t = 0; t < 10; t++) {
    const pFail = 0.05 + 0.09 * t;
    for (const arm of ["A", "B"]) {
      for (let a = 0; a < 3; a++) {
        const pass = rand() >= pFail;
        rows.push({
          runId: `t${t}-${arm}-${a}`,
          taskId: `t${t}`,
          arm,
          pass,
          scores: {
            // Constant within a task, high on hard tasks: tracks difficulty only.
            taskLevel: t,
            // Marks exactly the failed attempts.
            planted: pass ? 0 : 1,
            // Seeded noise unrelated to the outcome.
            noise: rand(),
          },
        });
      }
    }
  }
  return rows;
}

describe("signalValidity", () => {
  it("a within-task-constant score: 0.5 within task and arm, tracks-difficulty when pooled ≥ 0.6", () => {
    const v = signalValidity(fixture());
    const r = get(v, "taskLevel");
    assert.ok(r.pooled >= 0.6, `pooled ${r.pooled}`);
    assert.equal(r.withinTask.auroc, 0.5);
    assert.equal(r.withinTaskArm.auroc, 0.5);
    assert.deepEqual(r.withinTaskArm.ci, [0.5, 0.5]);
    assert.equal(r.verdict, "tracks-difficulty");
    assert.ok(r.withinTaskArm.pairs >= 20);
  });

  it("a score marking exactly the failed attempts gets 1.0 everywhere and adds-run-signal", () => {
    const r = get(signalValidity(fixture()), "planted");
    assert.equal(r.pooled, 1);
    assert.equal(r.withinTask.auroc, 1);
    assert.equal(r.withinTaskArm.auroc, 1);
    assert.deepEqual(r.withinTaskArm.ci, [1, 1]);
    assert.equal(r.verdict, "adds-run-signal");
  });

  it("seeded noise is no-signal", () => {
    const r = get(signalValidity(fixture()), "noise");
    assert.equal(r.verdict, "no-signal");
    assert.ok(r.withinTaskArm.ci[0] <= 0.5 && r.withinTaskArm.ci[1] >= 0.5);
  });

  it("difficulty(loo) is high pooled and exactly 0.5 within a task; reference rows come first", () => {
    const v = signalValidity(fixture());
    assert.deepEqual(
      v.slice(0, 2).map((r) => r.signal),
      ["difficulty(loo)", "arm(loo)"],
    );
    const d = get(v, "difficulty(loo)");
    assert.equal(d.reference, true);
    assert.ok(d.pooled >= 0.6, `pooled ${d.pooled}`);
    assert.equal(d.withinTask.auroc, 0.5);
    assert.equal(d.withinTaskArm.auroc, 0.5);
    assert.equal(d.verdict, "tracks-difficulty");
    assert.equal(get(v, "planted").reference, undefined);
  });

  it("is deterministic per seed and the seed moves only the CI", () => {
    const rows = fixture();
    assert.deepEqual(signalValidity(rows, { seed: 3 }), signalValidity(rows, { seed: 3 }));
    const a = get(signalValidity(rows, { seed: 3 }), "noise");
    const b = get(signalValidity(rows, { seed: 4 }), "noise");
    assert.equal(a.pooled, b.pooled);
    assert.equal(a.withinTaskArm.auroc, b.withinTaskArm.auroc);
  });

  it("all-tied scores give 0.5", () => {
    const rows = fixture().map((r) => ({ ...r, scores: { flat: 1 } }));
    const r = get(signalValidity(rows), "flat");
    assert.equal(r.pooled, 0.5);
    assert.equal(r.withinTask.auroc, 0.5);
    assert.equal(r.withinTaskArm.auroc, 0.5);
  });

  it("hand-checked pairs, ties at 0.5, and an undefined score drops its pairs", () => {
    const rows: SignalRow[] = [
      { runId: "1", taskId: "x", arm: "A", pass: false, scores: { s: 3 } },
      { runId: "2", taskId: "x", arm: "A", pass: true, scores: { s: 1 } },
      { runId: "3", taskId: "x", arm: "B", pass: true, scores: { s: 3 } },
      { runId: "4", taskId: "y", arm: "A", pass: false, scores: { s: 0 } },
      { runId: "5", taskId: "y", arm: "A", pass: true, scores: { s: undefined } },
    ];
    const r = get(signalValidity(rows, { minPairs: 1 }), "s");
    // Failed {1:3, 4:0} × passed {2:1, 3:3} (5 has no score): 1>2 win, 1=3 tie, 4<2, 4<3 → 1.5/4.
    close(r.pooled, 1.5 / 4);
    assert.equal(r.n, 4);
    // Same task: (1,2) win, (1,3) tie → 1.5/2. Same task and arm: (1,2) → 1.
    assert.deepEqual(r.withinTask, { auroc: 0.75, pairs: 2 });
    assert.equal(r.withinTaskArm.auroc, 1);
    assert.equal(r.withinTaskArm.pairs, 1);
  });

  it("difficulty(loo) leaves out both runs of the pair (no run sees its own outcome)", () => {
    const rows: SignalRow[] = [
      // Task x: 1 fail of 3. Task y: 2 fails of 3.
      { runId: "x1", taskId: "x", arm: "A", pass: false, scores: {} },
      { runId: "x2", taskId: "x", arm: "A", pass: true, scores: {} },
      { runId: "x3", taskId: "x", arm: "A", pass: true, scores: {} },
      { runId: "y1", taskId: "y", arm: "A", pass: false, scores: {} },
      { runId: "y2", taskId: "y", arm: "A", pass: false, scores: {} },
      { runId: "y3", taskId: "y", arm: "A", pass: true, scores: {} },
    ];
    const d = get(signalValidity(rows, { minPairs: 1 }), "difficulty(loo)");
    // Cross-task pairs: x1 (others in x: 0/2 = 0) vs y3 (others in y: 2/2 = 1) → loss, ×1;
    // y1, y2 (others in y: 1/2) vs x2, x3 (others in x: 1/2) → ties, ×4. Same-task pairs tie: x1-x2, x1-x3, y1-y3, y2-y3.
    // Wins: 8 ties × 0.5 + 1 loss = 4 over 9 pairs.
    close(d.pooled, 4 / 9);
    assert.equal(d.withinTask.auroc, 0.5);
    assert.equal(d.withinTask.pairs, 4);
  });

  it("runs whose task has no other run are dropped from every row", () => {
    const rows = [...fixture(), { runId: "solo", taskId: "solo", arm: "A", pass: false, scores: { planted: 1, taskLevel: 99, noise: 0.5 } }];
    const base = signalValidity(fixture());
    const v = signalValidity(rows);
    assert.deepEqual(v, base);
  });

  it("too-few-pairs below minPairs", () => {
    const v = signalValidity(fixture(), { minPairs: 10_000 });
    assert.ok(v.every((r) => r.verdict === "too-few-pairs"));
  });

  it("no task with two runs → empty", () => {
    assert.deepEqual(signalValidity([{ runId: "a", taskId: "t", arm: "A", pass: true, scores: { s: 1 } }]), []);
  });
});

describe("signalRows", () => {
  const stats = (o: Partial<{ turns: number; toolErrors: number }> = {}) => ({ events: 1, turns: o.turns ?? 4, toolCalls: 2, toolErrors: o.toolErrors ?? 0, filesChanged: 0, usage: { inputTokens: 10, outputTokens: 5 } });
  it("flags as 1/0 (tags and gateway ignored), tool errors, turns and tokens; skips cancelled, superseded and infra runs", () => {
    const results = [
      { id: "r1", taskId: "t", bundleId: "A", pass: false },
      { id: "r2", taskId: "t", bundleId: "A", pass: true },
      { id: "r3", taskId: "t", bundleId: "A", pass: true, cancelled: true as const },
      { id: "r4", taskId: "t", bundleId: "A", pass: false, infra: "network" },
      { id: "r5", taskId: "t", bundleId: "B", pass: true },
    ];
    const sessions = new Map([
      ["r1", { flags: ["no-verification", "gateway:vercel", "skill:pdf"], stats: stats({ toolErrors: 3, turns: 9 }) }],
      ["r2", { flags: [], stats: stats() }],
    ]);
    const rows = signalRows(results, sessions as never);
    assert.deepEqual(
      rows.map((r) => r.runId),
      ["r1", "r2", "r5"],
    );
    assert.deepEqual(rows[0]!.scores, { toolErrors: 3, "no-verification": 1, turns: 9, tokens: 15 });
    assert.deepEqual(rows[1]!.scores, { toolErrors: 0, "no-verification": 0, turns: 4, tokens: 15 });
    assert.deepEqual(rows[2]!.scores, {});
    assert.equal(rows[0]!.arm, "A");
    const v = signalValidity(rows, { minPairs: 1 });
    assert.equal(get(v, "turns").reference, true);
    assert.equal(get(v, "no-verification").reference, undefined);
  });

  it("hasRepeatedAttempts", () => {
    assert.equal(hasRepeatedAttempts([{ taskId: "t", arm: "A" }, { taskId: "t", arm: "B" }]), false);
    assert.equal(hasRepeatedAttempts([{ taskId: "t", arm: "A" }, { taskId: "t", arm: "A" }]), true);
  });
});

describe("formatSignalValidity", () => {
  it("prints the caption, reference rows first and the k ≥ 2 hint", () => {
    const text = formatSignalValidity(signalValidity(fixture()), { repeated: false });
    assert.match(text, /pooled AUROC mostly measures task difficulty/);
    assert.match(text, /needs k>=2/);
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.trim().startsWith("signal "));
    assert.match(lines[at + 1]!, /difficulty\(loo\) \(ref\)/);
    assert.match(text, /planted .* adds-run-signal/);
  });
});
