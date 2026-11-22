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

  it("says what failed: a setup step, a refused login read from the agent's output, an agent that could not start, redacted", () => {
    const t = { id: "t1", name: "fix-add" } as EvalTask;
    const agent = (a: Partial<RunResult["agent"]>): RunResult["agent"] => ({ exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "", ...a });
    const run = (attempt: number, extra: Partial<RunResult>) => ({ id: `r${attempt}`, taskId: "t1", attempt, pass: false, verifierExit: 1, agent: agent({}), ...extra }) as RunResult;
    const key = ["sk-ant-", "api03-", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("");
    const [row] = trialsFromRuns(
      [t],
      [
        run(1, { infra: "setup", verifierExit: null, error: `setup \`npm ci\` exited 1: \x1b[31mnpm ERR!\x1b[0m token ${key}\n` }),
        run(2, { infra: "auth", agent: agent({ exitCode: 1, stderrTail: "Invalid API key · Please run /login\n" }) }),
        run(3, { infra: "auth", agent: agent({ exitCode: 1, stdoutTail: `${JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" })}\n` }) }),
        run(4, { agent: agent({ exitCode: 127, stderrTail: "\nspawn claude ENOENT" }) }),
        run(5, { agent: agent({ exitCode: 1, stderrTail: "Error: --dangerously-skip-permissions cannot be used with root\nhint: run it as a normal user\n" }) }),
        run(6, { agent: agent({ exitCode: null, timedOut: true }), error: "agent timed out" }),
      ],
    );
    assert.deepEqual(
      row!.trials.map((x) => [x.unknown ?? false, x.reason]),
      [
        [true, "setup `npm ci` exited 1: npm ERR! token [redacted:anthropic-key]"],
        [true, "agent login failed: Invalid API key · Please run /login"],
        [true, "agent login failed: Not logged in · Please run /login"],
        [false, "agent exited 127: spawn claude ENOENT"],
        [false, "agent exited 1: Error: --dangerously-skip-permissions cannot be used with root"],
        [false, "agent timed out"],
      ],
    );
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
