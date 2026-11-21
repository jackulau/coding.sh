// Claim calibration per arm: claim rate, claim precision and silent failures,
// from each run's final answer and the verifier's verdict.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../../src/core/types.ts";
import { claimCalibration, claimKind } from "../../src/runner/claims.ts";
import { compare, formatCompare } from "../../src/runner/experiment.ts";

let n = 0;
function run(bundleId: string, taskId: string, pass: boolean, finalText: string | undefined, extra: Partial<RunResult> = {}): RunResult {
  n++;
  const agent: RunResult["agent"] = { exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "" };
  if (finalText !== undefined) agent.finalText = finalText;
  return {
    id: `${bundleId}-${n}`,
    taskId,
    bundleId,
    attempt: 1,
    pass,
    verifierExit: pass ? 0 : 1,
    agent,
    startedAt: 0,
    endedAt: 1000,
    ...extra,
  };
}

const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-3, `${a} ≠ ${b}`);

// A: three "Done, tests pass" (pass, pass, fail) and one "I could not fix it" (fail).
const A = [run("A", "t1", true, "Done, tests pass"), run("A", "t2", true, "Done, tests pass"), run("A", "t3", false, "Done, tests pass"), run("A", "t4", false, "I could not fix it")];
// B: no claims at all.
const B = [run("B", "t1", true, "I could not fix it"), run("B", "t2", false, undefined), run("B", "t3", false, "I could not fix it"), run("B", "t4", true, "")];

describe("claimCalibration", () => {
  it("classifies final answers", () => {
    assert.equal(claimKind("Done, tests pass"), "claim");
    assert.notEqual(claimKind("I could not fix it"), "claim");
    assert.equal(claimKind("One test still fails: test_div"), "failure-report");
    assert.equal(claimKind(undefined), "none");
  });

  it("claim rate, precision and silent failures per arm", () => {
    const a = claimCalibration(A).get("A")!;
    assert.equal(a.runs, 4);
    assert.equal(a.claims, 3);
    close(a.claimRate, 0.75);
    close(a.claimPrecision, 0.667);
    assert.equal(a.silentFailures, 1);
    close(a.silentFailureRate, 0.25);
  });

  it("an arm with no claims has no precision", () => {
    const b = claimCalibration(B).get("B")!;
    assert.equal(b.claims, 0);
    assert.equal(b.claimRate, 0);
    assert.equal("claimPrecision" in b, false);
    assert.equal(b.silentFailureRate, 0);
  });

  it("leaves out runs lost to infrastructure", () => {
    const lost = [
      run("A", "t5", false, "Done, tests pass", { infra: "rate-limit" }),
      run("A", "t6", false, "Done, tests pass", { error: "agent failed: 529 overloaded_error" }),
      run("A", "t7", false, "Done, tests pass", { cancelled: true }),
    ];
    const a = claimCalibration([...A, ...lost]).get("A")!;
    assert.equal(a.runs, 4);
    close(a.claimRate, 0.75);
    close(a.silentFailureRate, 0.25);
  });
});

describe("compare: claims block", () => {
  it("reports claims per arm in the report and the text", () => {
    const r = compare([...A, ...B], { baseline: "A", candidate: "B", iters: 200 });
    assert.ok(r.claims);
    close(r.claims.baseline.claimPrecision, 0.667);
    assert.equal(r.claims.candidate.claimPrecision, undefined);
    const json = JSON.parse(JSON.stringify(r));
    assert.equal(json.claims.baseline.claims, 3);
    const text = formatCompare(r);
    assert.match(text, /claim rate\s+75% \(3\/4\)\s+0% \(0\/4\)/);
    assert.match(text, /claim precision\s+67% \(2\/3\)\s+—/);
    assert.match(text, /silent failures\s+25% \(1\/4\)\s+0% \(0\/4\)/);
  });

  it("prints no claims line when no arm claims", () => {
    const r = compare([...B, ...B.map((x) => ({ ...x, id: `${x.id}a`, bundleId: "C" }))], { baseline: "B", candidate: "C", iters: 200 });
    assert.equal(r.claims, undefined);
    assert.equal("claims" in JSON.parse(JSON.stringify(r)), false);
    assert.doesNotMatch(formatCompare(r), /claim/);
  });
});
