import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDataset } from "../../src/datasets/dataset.ts";
import type { Grader } from "../../src/datasets/types.ts";
import { compareExperiments, isInfraError, isTimeoutError } from "../../src/experiments/compare.ts";
import { renderComparison } from "../../src/experiments/render.ts";
import { runExperiment } from "../../src/experiments/run.ts";

const ids = Array.from({ length: 20 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
const ds = createDataset({ name: "timeouts", createdAt: 1, cases: ids.map((id) => ({ id, input: id })) });
const all: Grader = { id: "ok", version: "1", kind: "custom", grade: async () => ({ score: 1, pass: true }) };

/** An arm whose task throws `fail(i)` for the cases it returns a message for, and echoes the rest. */
const arm = (name: string, fail: (i: number) => string | undefined) =>
  runExperiment({
    name,
    dataset: ds,
    task: (input) => {
      const m = fail(ids.indexOf(String(input)));
      if (m) throw new Error(m);
      return input;
    },
    graders: [all],
  });

describe("compare: agent timeouts per arm (R6-12)", () => {
  it("tells a trial timeout from an infrastructure timeout", () => {
    for (const m of ["timed out after 600000 ms (trial timeout)", "./agent: agent timed out", "node a.mjs: timed out after 120000 ms"]) {
      assert.ok(isTimeoutError(m), m);
      assert.ok(!isInfraError(m), m);
    }
    for (const m of ["connect ETIMEDOUT 10.0.0.1:443", "https://api/: HTTP 504: gateway timeout", "provider request timed out", "read ETIMEDOUT after timed out after 3000 ms"]) {
      assert.ok(!isTimeoutError(m), m);
      assert.ok(isInfraError(m), m);
    }
  });

  it("counts B's timeouts on cases A passes as timeouts, not infra, and names them", async () => {
    const a = await arm("a", () => undefined);
    const b = await arm("b", (i) => (i < 4 ? "timed out after 600000 ms (trial timeout)" : undefined));
    const c = compareExperiments(a, b);
    assert.equal(c.attrition.b.timedOut, 4);
    assert.equal(c.attrition.b.infra, 0);
    assert.equal(c.attrition.b.agent, 0);
    assert.equal(c.attrition.b.errored, 4);
    assert.equal(c.attrition.a.timedOut, undefined, "absent when none");
    assert.deepEqual(c.attrition.timeouts?.b, ["c01", "c02", "c03", "c04"]);
    assert.deepEqual(c.attrition.timeouts?.a, []);
    const note = c.attrition.timeouts?.note ?? "";
    assert.match(note, /c01, c02, c03, c04/);
    assert.match(note, /depends on the time limit/);
    assert.match(note, /--trial-timeout/);
    // Not called infrastructure and given no re-run hint.
    assert.doesNotMatch(c.attrition.warning ?? "", /infrastructure/);
    const text = renderComparison(c, { color: false });
    assert.match(text, /^lost {4}A 0\/20 {2}B 4\/20 \(4 timeouts\)/m);
    assert.match(text, /^! timeouts differ by arm: .*c01, c02, c03, c04/m);
    const json = JSON.parse(JSON.stringify(c));
    assert.equal(json.attrition.b.timedOut, 4);
    assert.equal(json.attrition.timeouts.note, note);
  });

  it("an ETIMEDOUT error stays infra, and even timeouts give no note", async () => {
    const a = await arm("a", (i) => (i < 2 ? "timed out after 1000 ms (trial timeout)" : undefined));
    const b = await arm("b", (i) => (i < 2 ? "timed out after 1000 ms (trial timeout)" : i < 6 ? "connect ETIMEDOUT 10.0.0.1:443" : undefined));
    const c = compareExperiments(a, b);
    assert.equal(c.attrition.b.infra, 4);
    assert.equal(c.attrition.b.timedOut, 2);
    assert.equal(c.attrition.a.timedOut, 2);
    assert.equal(c.attrition.timeouts, undefined);
    assert.doesNotMatch(renderComparison(c, { color: false }), /timeouts differ/);
  });

  it("2 against 0 is no note; 3 against 0 is", async () => {
    const a = await arm("a", () => undefined);
    const two = await arm("b", (i) => (i < 2 ? "agent timed out" : undefined));
    assert.equal(compareExperiments(a, two).attrition.timeouts, undefined);
    const three = await arm("b", (i) => (i < 3 ? "agent timed out" : undefined));
    assert.deepEqual(compareExperiments(a, three).attrition.timeouts?.b, ["c01", "c02", "c03"]);
  });
});
