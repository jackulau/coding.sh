// Runs answered by a model other than the one their arm asked for (Claude Code's fallback after a refusal).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, RunResult } from "../../src/core/types.ts";
import { fixtureBundle, fixtureEvent } from "../../src/store/conformance.ts";
import { compare, formatCompare } from "../../src/runner/experiment.ts";
import { answeredBy, modelKey, modelMix, modelNote } from "../../src/runner/model-mix.ts";

function run(taskId: string, bundleId: string, pass: boolean): RunResult {
  return {
    id: `${bundleId}-${taskId}`,
    taskId,
    bundleId,
    attempt: 1,
    pass,
    verifierExit: pass ? 0 : 1,
    agent: { exitCode: 0, timedOut: false, durationMs: 1000, stdoutTail: "", stderrTail: "", usage: { costUsd: 0.1 } },
    startedAt: 0,
    endedAt: 2000,
  };
}

const call = (responseModel: string, extra: Partial<AgentEvent> = {}): AgentEvent => fixtureEvent({ kind: "llm.call", payload: { responseModel, ok: true }, ...extra });

const sonnet = { baseline: fixtureBundle({ id: "A", name: "no-skill", files: {}, model: "claude-sonnet-5-5" }), candidate: fixtureBundle({ id: "B", name: "with-skill", files: {}, model: "claude-sonnet-5-5" }) };

/** 6 tasks per arm. A-t1 switches to the older model mid-run, B-t2 and B-t3 answer only from it. */
function world() {
  const rs: RunResult[] = [];
  const events = new Map<string, AgentEvent[]>();
  for (let t = 0; t < 6; t++) {
    for (const b of ["A", "B"]) {
      const r = run(`t${t}`, b, b === "B" && t < 4);
      rs.push(r);
      // A subagent on a small model is not a fallback.
      events.set(r.id, [call("claude-sonnet-5-5-20261001"), call("claude-haiku-5", { subagentId: "sub-1" })]);
    }
  }
  events.get("A-t1")!.push(call("claude-sonnet-5"), call("claude-sonnet-5"));
  events.set("B-t2", [call("claude-sonnet-5")]);
  events.set("B-t3", [call("claude-sonnet-5")]);
  return { rs, events };
}

describe("modelKey", () => {
  it("drops the provider prefix, date, Bedrock version and context tag", () => {
    assert.equal(modelKey("claude-sonnet-5-5-20261001"), "claude-sonnet-5-5");
    assert.equal(modelKey("us.anthropic.claude-sonnet-5-5-v1:0"), "claude-sonnet-5-5");
    assert.equal(modelKey("anthropic/claude-sonnet-5-5"), "claude-sonnet-5-5");
    assert.equal(modelKey("claude-sonnet-5-5[1m]"), "claude-sonnet-5-5");
    assert.notEqual(modelKey("claude-sonnet-5"), modelKey("claude-sonnet-5-5"));
  });
});

describe("modelMix", () => {
  it("counts each arm's runs with a call answered by another model, leaving subagents out", () => {
    const { rs, events } = world();
    assert.deepEqual(answeredBy(events.get("A-t0")!), ["claude-sonnet-5-5-20261001"]);
    const m = modelMix(rs.filter((r) => r.bundleId === "A"), rs.filter((r) => r.bundleId === "B"), events, sonnet);
    assert.deepEqual(m, {
      requested: { baseline: "claude-sonnet-5-5", candidate: "claude-sonnet-5-5" },
      off: { baseline: 1, candidate: 2 },
      models: { "claude-sonnet-5": 4 },
      tasks: 3,
    });
    assert.equal(
      modelNote(m),
      "1 run of baseline and 2 runs of candidate, over 3 tasks, had model calls answered by claude-sonnet-5 (4 calls), not claude-sonnet-5-5: the agent fell back to another model (Claude Code retries on an older model after a refusal). Those runs measure the other model; leave them out or rerun those tasks",
    );
  });

  it("says nothing when every run stayed on the model, the bundle names none, or names an alias", () => {
    const { rs, events } = world();
    const A = rs.filter((r) => r.bundleId === "A" && r.taskId !== "t1");
    const clean = modelMix(A, [], events, sonnet);
    assert.deepEqual(clean?.off, { baseline: 0, candidate: 0 });
    assert.equal(modelNote(clean), undefined);
    const bare = { baseline: fixtureBundle({ id: "A", files: {} }), candidate: fixtureBundle({ id: "B", files: {} }) };
    assert.equal(modelMix(rs, rs, events, bare), undefined);
    // No call answered by "sonnet" itself: the name can't be checked, so no run is counted.
    const alias = { baseline: fixtureBundle({ id: "A", files: {}, model: "sonnet" }) };
    assert.equal(modelMix(rs.filter((r) => r.bundleId === "A"), [], events, alias), undefined);
    assert.equal(modelMix(rs, rs, undefined, sonnet), undefined);
  });
});

describe("compare: model fallback", () => {
  it("reports modelMix and a note when runs were answered by another model", () => {
    const { rs, events } = world();
    const r = compare(rs, { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: sonnet, events });
    assert.deepEqual(r.modelMix?.off, { baseline: 1, candidate: 2 });
    assert.match(formatCompare(r), /^note: 1 run of baseline and 2 runs of candidate, over 3 tasks, had model calls answered by claude-sonnet-5 \(4 calls\)/m);
    const quiet = compare(rs, { baseline: "A", candidate: "B", iters: 200, seed: 1, bundles: sonnet });
    assert.equal(quiet.modelMix, undefined);
    assert.ok(!quiet.notes.some((n) => n.includes("answered by")));
  });
});
