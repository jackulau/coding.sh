// `coding.sh compare` with too few tasks: the power line says so instead of an
// MDE over 100pp (a pass-rate difference cannot be larger than 100pp).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../../src/core/types.ts";
import { compare, formatCompare } from "../../src/runner/experiment.ts";

function run(taskId: string, bundleId: string, pass: boolean): RunResult {
  return {
    id: `${bundleId}-${taskId}`,
    taskId,
    bundleId,
    attempt: 1,
    pass,
    verifierExit: pass ? 0 : 1,
    agent: { exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "" },
    startedAt: 0,
    endedAt: 2000,
  };
}

describe("harness compare power line", () => {
  it("at 2 tasks prints no MDE over 100pp", () => {
    const rs = [run("t0", "A", true), run("t0", "B", false), run("t1", "A", false), run("t1", "B", true)];
    const r = compare(rs, { baseline: "A", candidate: "B", iters: 200, seed: 1 });
    assert.ok(r.power.mde > 1, `the analytic MDE is over 100pp here: ${r.power.mde}`);
    const line = formatCompare(r).split("\n").find((l) => l.startsWith("power"));
    assert.ok(line, formatCompare(r));
    assert.match(line, /^power {3}MDE — \(too few cases\)/);
    assert.doesNotMatch(line, /MDE \d{3,}(\.\d)?pp/);
  });
});
