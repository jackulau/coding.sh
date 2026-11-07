import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../../src/core/types.ts";
import { failureAnatomy, nestedVarianceShares } from "../../src/runner/anatomy.ts";

function run(taskId: string, bundleId: string, attempt: number, pass: boolean): RunResult {
  return {
    id: `${bundleId}-${taskId}-${attempt}`,
    taskId,
    bundleId,
    attempt,
    pass,
    verifierExit: pass ? 0 : 1,
    agent: { exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "" },
    startedAt: 0,
    endedAt: 2000,
  };
}

/** outcomes: { t1: ["110", "111"] } = t1 baseline pass,pass,fail; candidate pass×3. */
function arms(outcomes: Record<string, [string, string]>) {
  const ta = new Map<string, RunResult[]>();
  const tb = new Map<string, RunResult[]>();
  for (const [t, [a, b]] of Object.entries(outcomes)) {
    ta.set(t, [...a].map((c, i) => run(t, "A", i + 1, c === "1")));
    tb.set(t, [...b].map((c, i) => run(t, "B", i + 1, c === "1")));
  }
  return { ta, tb };
}

const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-12, `${msg ?? ""} ${a} vs ${b}`);

describe("failureAnatomy", () => {
  it("splits failed runs into bad-run, beyond-arm and unsolved-by-all", () => {
    const { ta, tb } = arms({ t1: ["100", "111"], t2: ["000", "011"], t3: ["000", "000"], t4: ["111", "111"] });
    const r = failureAnatomy(ta, tb, ["t4", "t3", "t2", "t1", "t1"]);
    assert.deepEqual(r.baseline, { fails: 8, badRun: 2, beyondArm: 3, unsolvedByAll: 3, infra: 0, tasks: { badRun: ["t1"], beyondArm: ["t2"], unsolvedByAll: ["t3"] } });
    assert.deepEqual(r.candidate, { fails: 4, badRun: 1, beyondArm: 0, unsolvedByAll: 3, infra: 0, tasks: { badRun: ["t2"], beyondArm: [], unsolvedByAll: ["t3"] } });
    for (const a of [r.baseline, r.candidate]) assert.equal(a.badRun + a.beyondArm + a.unsolvedByAll + a.infra, a.fails);
    assert.deepEqual(failureAnatomy(ta, tb, ["t1", "t2", "t3", "t4"]), r, "deterministic");
  });

  it("counts paired tasks only", () => {
    const { ta, tb } = arms({ t1: ["00", "00"], t2: ["00", "11"] });
    const r = failureAnatomy(ta, tb, ["t2"]);
    assert.equal(r.baseline.fails, 2);
    assert.equal(r.baseline.unsolvedByAll, 0);
  });
});

describe("nestedVarianceShares", () => {
  const cells = (outcomes: Record<string, [string, string]>) =>
    Object.entries(outcomes).flatMap(([t, [a, b]]) => [...[...a].map((c) => ({ group: t, sub: "A", y: Number(c) })), ...[...b].map((c) => ({ group: t, sub: "B", y: Number(c) }))]);

  it("identical outcomes within each task: all variance is between tasks", () => {
    const v = nestedVarianceShares(cells({ t1: ["11", "11"], t2: ["00", "00"] }));
    assert.deepEqual(v, { task: 1, arm: 0, run: 0, n: 8 });
  });

  it("one task, both arms alternating: all variance is run-to-run", () => {
    const v = nestedVarianceShares(cells({ t1: ["1010", "0101"] }));
    assert.deepEqual(v, { task: 0, arm: 0, run: 1, n: 8 });
  });

  it("planted arm effect matches the hand-computed sums of squares", () => {
    // grand 2/3; SS_task 2/3, SS_arm 1, SS_run 1, SS_total 8/3.
    const v = nestedVarianceShares(cells({ t1: ["11", "00"], t2: ["10", "10"], t3: ["11", "11"] }));
    close(v.task, 0.25, "task");
    close(v.arm, 0.375, "arm");
    close(v.run, 0.375, "run");
    close(v.task + v.arm + v.run, 1, "sum");
    assert.deepEqual(nestedVarianceShares(cells({ t1: ["11", "00"], t2: ["10", "10"], t3: ["11", "11"] })), v, "byte-identical across calls");
  });

  it("no variance: NaN shares", () => {
    const v = nestedVarianceShares(cells({ t1: ["11", "11"] }));
    assert.ok(Number.isNaN(v.task) && Number.isNaN(v.arm) && Number.isNaN(v.run));
    assert.equal(nestedVarianceShares([]).n, 0);
  });
});
