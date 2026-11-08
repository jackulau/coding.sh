import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvalTask, RunResult } from "../../src/core/types.ts";
import { caseLabel, trialsFromRuns, trialsFromTriggers } from "../../src/eval/run-suite.ts";
import type { TriggerObservation } from "../../src/eval/trigger.ts";

describe("trialsFromRuns", () => {
  it("gives one trial per attempt, without cancelled or superseded runs, infra errors unknown", () => {
    const t = { id: "t1", name: "fix-add" } as EvalTask;
    const run = (attempt: number, extra: Partial<RunResult>) => ({ id: `r${attempt}`, taskId: "t1", attempt, pass: false, verifierExit: 1, ...extra }) as RunResult;
    const [row] = trialsFromRuns([t], [run(2, { pass: true, verifierExit: 0, sessionId: "s2" }), run(1, { sessionId: "s1" }), run(3, { infra: "rate-limit", error: "rate limited" }), run(4, { cancelled: true }), run(5, { superseded: true })]);
    assert.equal(row!.name, "fix-add");
    assert.deepEqual(row!.trials, [
      { pass: false, sessionId: "s1", reason: "verifier exit 1" },
      { pass: true, sessionId: "s2" },
      { pass: false, unknown: true, reason: "rate limited" },
    ]);
  });
});

describe("caseLabel", () => {
  it("uses a given id, else the start of the input", () => {
    assert.equal(caseLabel({ id: "refund-twice", input: "x" }), "refund-twice");
    assert.equal(caseLabel({ id: "c_0123456789abcdef", input: "I was\ncharged twice" }), "I was charged twice");
    assert.equal(caseLabel({ id: "c_0123456789abcdef", input: "x".repeat(60) }).length, 40);
    assert.equal(caseLabel({ id: "c_0123456789abcdef", input: { q: 1 } }), '{"q":1}');
  });
});

describe("trialsFromTriggers", () => {
  it("passes should prompts that loaded the skill and should_not prompts that didn't", () => {
    const spec = { should: [{ prompt: "merge two pdfs", weight: 1 }], shouldNot: [{ prompt: "clean a csv", weight: 1 }] };
    const ob = (side: "should" | "should_not", attempt: number, triggered: boolean, extra: Partial<TriggerObservation> = {}): TriggerObservation => ({ arm: 0, side, index: 0, attempt, triggered, status: "ok", skills: triggered ? ["pdf"] : [], ...extra });
    const rows = trialsFromTriggers(spec, [
      ob("should", 2, false, { sessionId: "s2" }),
      ob("should", 1, true),
      ob("should_not", 1, true),
      ob("should_not", 2, false, { status: "error", error: "timeout" }),
      ob("should_not", 1, false, { arm: 1 }),
    ]);
    assert.deepEqual(
      rows.map((r) => [r.id, r.name]),
      [
        ["should:0", "should: merge two pdfs"],
        ["should_not:0", "should not: clean a csv"],
      ],
    );
    assert.deepEqual(rows[0]!.trials, [{ pass: true }, { pass: false, sessionId: "s2", reason: "didn't load the skill" }]);
    assert.deepEqual(rows[1]!.trials, [{ pass: false, reason: "loaded the skill" }, { pass: false, unknown: true, reason: "timeout" }], "only the first arm counts");
  });
});
