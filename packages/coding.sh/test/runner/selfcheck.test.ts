import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, RunResult, Session } from "../../src/core/types.ts";
import { compare, formatCompare } from "../../src/runner/experiment.ts";
import { classifySelfCheck, selfCheckSummary } from "../../src/runner/selfcheck.ts";

function run(taskId: string, bundleId: string, attempt: number, pass: boolean, extra: Partial<RunResult> = {}): RunResult {
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
    ...extra,
  };
}

const session = (stats: Partial<Session["stats"]> = {}): Session => ({ id: "s", agent: "claude-code", startedAt: 0, stats: { ...stats } }) as unknown as Session;
let n = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}): AgentEvent => ({ id: `e${++n}`, v: 1, sessionId: "s", ts: n, agent: "claude-code", kind, payload }) as unknown as AgentEvent;
const tests = (passed: number, failed: number) => ev("test.result", { runner: "node", passed, failed });

describe("classifySelfCheck", () => {
  const r = run("t", "A", 1, false);
  it("last test result: 3 passed / 0 failed → green; 1 failed → red; green then a file change → stale", () => {
    assert.equal(classifySelfCheck(r, session(), [tests(0, 2), ev("file.change", { path: "a.ts" }), tests(3, 0)]), "green");
    assert.equal(classifySelfCheck(r, session(), [tests(3, 0), tests(2, 1)]), "red");
    assert.equal(classifySelfCheck(r, session(), [tests(3, 0), ev("file.change", { path: "a.ts" })]), "stale");
    // Out-of-order events are sorted by time.
    const late = tests(3, 0);
    const early = ev("file.change", { path: "a.ts" });
    early.ts = 0;
    assert.equal(classifySelfCheck(r, session(), [late, early]), "green");
  });
  it("no test result → none; a run of zero tests → none; no session → unknown", () => {
    assert.equal(classifySelfCheck(r, session(), [ev("tool.start", { tool: "Bash" })]), "none");
    assert.equal(classifySelfCheck(r, session(), [tests(0, 0)]), "none");
    assert.equal(classifySelfCheck(r, undefined, [tests(3, 0)]), "unknown");
  });
  it("without events, falls back to the session's last test stats (no stale)", () => {
    assert.equal(classifySelfCheck(r, session({ testsPassed: 3, testsFailed: 0 })), "green");
    assert.equal(classifySelfCheck(r, session({ testsPassed: 3, testsFailed: 1 }), []), "red");
    assert.equal(classifySelfCheck(r, session()), "none");
  });
});

describe("selfCheckSummary", () => {
  it("counts sum to fails; green pass rate is over all green runs, passes included", () => {
    const rs = [run("t1", "A", 1, false), run("t2", "A", 1, false), run("t3", "A", 1, false), run("t4", "A", 1, false), run("t5", "A", 1, true), run("t6", "A", 1, true)];
    const sessions = new Map(rs.filter((r) => r.taskId !== "t4").map((r) => [r.id, session()]));
    const events = new Map<string, AgentEvent[]>([
      ["A-t1-1", [tests(3, 0)]],
      ["A-t2-1", [tests(1, 1)]],
      ["A-t3-1", [tests(3, 0), ev("file.change")]],
      ["A-t5-1", [tests(4, 0)]],
      ["A-t6-1", []],
    ]);
    const s = selfCheckSummary(rs, sessions, events);
    assert.deepEqual([s.fails, s.green, s.red, s.stale, s.none, s.unknown], [4, 1, 1, 1, 0, 1]);
    assert.equal(s.green + s.red + s.stale + s.none + s.unknown, s.fails);
    assert.deepEqual([s.greenRuns, s.greenPasses], [2, 1]);
    assert.equal(s.greenPassRate.p, 0.5);
    // Other: t2 (red), t3 (stale), t6 (none, passed). t4 has no session.
    assert.deepEqual([s.otherRuns, s.otherPasses], [3, 1]);
  });
});

describe("compare: own tests (AB-10)", () => {
  /** n failed runs per arm with green own tests, plus passes. */
  const build = (green: number, other: number) => {
    const rs: RunResult[] = [];
    const sessions = new Map<string, Session>();
    const events = new Map<string, AgentEvent[]>();
    for (let i = 0; i < green + other; i++) {
      for (const arm of ["A", "B"]) {
        const r = run(`t${i}`, arm, 1, i % 3 === 0);
        rs.push(r);
        sessions.set(r.id, session());
        events.set(r.id, i < green ? [tests(5, 0)] : [tests(4, 1)]);
      }
    }
    return { rs, sessions, events };
  };

  it("ArmSummary.selfCheck and one line per arm; the comparison line needs ≥ 5 runs per group", () => {
    const { rs, sessions, events } = build(6, 6);
    const r = compare(rs, { baseline: "A", candidate: "B", iters: 200, seed: 1, sessions, events });
    const s = r.baseline.selfCheck;
    assert.deepEqual([s.fails, s.green, s.red, s.greenRuns, s.greenPasses, s.otherRuns, s.otherPasses], [8, 4, 4, 6, 2, 6, 2]);
    const text = formatCompare(r);
    assert.match(text, /^own tests {9}A fails 8: own tests green 4 \(50%\), red 4$/m);
    assert.match(text, /^ {18}B fails 8: own tests green 4 \(50%\), red 4$/m);
    assert.match(text, /^ {20}own-green runs passed the verifier 33% \[10–70%\] vs 33% \[10–70%\] otherwise$/m);

    const small = build(4, 6);
    const t2 = formatCompare(compare(small.rs, { baseline: "A", candidate: "B", iters: 200, seed: 1, sessions: small.sessions, events: small.events }));
    assert.match(t2, /A fails \d+: own tests green/);
    assert.doesNotMatch(t2, /own-green runs passed/);
  });

  it("no sessions: fields present (all unknown), no text line", () => {
    const rs = [run("t1", "A", 1, false), run("t1", "B", 1, true)];
    const r = compare(rs, { baseline: "A", candidate: "B", iters: 200, seed: 1 });
    assert.deepEqual([r.baseline.selfCheck.fails, r.baseline.selfCheck.unknown], [1, 1]);
    assert.ok(Number.isNaN(r.baseline.selfCheck.greenPassRate.p));
    assert.doesNotMatch(formatCompare(r), /own tests/);
  });

  it("cancelled runs are left out", () => {
    const rs = [run("t1", "A", 1, false), run("t1", "A", 2, false, { cancelled: true }), run("t1", "B", 1, true)];
    const sessions = new Map(rs.map((r) => [r.id, session({ testsPassed: 2, testsFailed: 0 })]));
    const r = compare(rs, { baseline: "A", candidate: "B", iters: 200, seed: 1, sessions });
    assert.deepEqual([r.baseline.selfCheck.fails, r.baseline.selfCheck.green], [1, 1]);
  });
});
