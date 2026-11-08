import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSuiteReport, suiteReport, type TaskTrials } from "../../src/eval/report.ts";

const P = { pass: true };
const F = { pass: false };
const U = { pass: false, unknown: true };
const task = (id: string, trials: TaskTrials["trials"]): TaskTrials => ({ id, name: id, trials });

describe("suiteReport", () => {
  it("gives pass@1, pass@k and pass^k from every trial", () => {
    const r = suiteReport("s", "capability", [task("a", [P, P, P]), task("b", [P, F, F]), task("c", [F, F, F])]);
    assert.equal(r.k, 3);
    assert.equal(r.passed, 4);
    assert.equal(r.trials, 9);
    assert.ok(Math.abs(r.passRate.p - 4 / 9) < 1e-12);
    // pass@3: a and b pass at least once; pass^3: only a passes every time.
    assert.ok(Math.abs(r.passAtK! - 2 / 3) < 1e-12);
    assert.ok(Math.abs(r.passHatK! - 1 / 3) < 1e-12);
    assert.deepEqual(r.flaky, ["b"]);
    assert.deepEqual(r.neverPassed, ["c"]);
    assert.deepEqual(r.failing, ["b", "c"]);
    assert.equal(r.ok, true, "a capability suite never fails on its score");
    assert.equal(r.saturated, false);
  });

  it("leaves pass@k and pass^k out with one trial per task, and says why", () => {
    const r = suiteReport("s", "capability", [task("a", [P]), task("b", [F])]);
    assert.equal(r.k, 1);
    assert.equal(r.passAtK, undefined);
    assert.equal(r.passHatK, undefined);
    assert.ok(r.notes.some((n) => /one trial per task/.test(n)));
    assert.ok(r.notes.some((n) => /2 tasks: a suite this small/.test(n)));
  });

  it("fails a regression suite when a task fails most of its trials, not when it is only flaky", () => {
    assert.equal(suiteReport("s", "regression", [task("a", [P, P, F]), task("b", [P, P, P])]).ok, true);
    const bad = suiteReport("s", "regression", [task("a", [P, F, F]), task("b", [P, P, P])]);
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.failing, ["a"]);
  });

  it("keeps unknown outcomes out of every rate, and fails a regression suite with an ungraded task", () => {
    const r = suiteReport("s", "regression", [task("a", [P, U, P]), task("b", [U, U])]);
    assert.equal(r.trials, 2);
    assert.equal(r.unknown, 3);
    assert.equal(r.k, 2, "k is the fewest known trials of a graded task");
    assert.equal(r.ok, false);
    assert.ok(r.notes.some((n) => /3 trials with an unknown outcome/.test(n)));
    assert.match(renderSuiteReport(r, { color: false }), /1 of 2 tasks have no graded trial/);
    const none = suiteReport("s", "regression", [task("a", [U])]);
    assert.equal(none.ok, false);
    assert.match(renderSuiteReport(none, { color: false }), /nothing was graded, so it can't pass/);
  });

  it("warns when a capability suite saturates", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, i === 0 ? [P, F] : [P, P]));
    assert.equal(suiteReport("s", "capability", tasks).saturated, true);
    assert.equal(suiteReport("s", "regression", tasks).saturated, false, "a regression suite is meant to pass");
    assert.match(renderSuiteReport(suiteReport("s", "capability", tasks), { color: false }), /saturated: 90% of tasks pass every trial/);
  });

  it("renders the transcript of a failed trial, else its reason", () => {
    const r = suiteReport("s", "capability", [
      task("agent-task", [P, { pass: false, sessionId: "0123456789abcdefXYZ" }]),
      task("case", [{ pass: false, reason: 'exact: expected "bug", got "other"' }]),
    ]);
    const text = renderSuiteReport(r, { color: false, transcript: (id) => `coding.sh show ${id.slice(0, 12)}` });
    assert.match(text, /pass@1  33\.3%/);
    assert.match(text, /agent-task\s+1\/2\s+flaky\s+coding\.sh show 0123456789ab/);
    assert.match(text, /case\s+0\/1\s+never\s+exact: expected "bug", got "other"/);
    assert.match(text, /never passed: case\. Read its transcript or output first/);
  });
});
