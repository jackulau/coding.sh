// exp run --replay from a source that stored no task spec (a function task, or a replay made
// before 0.1.8): the usage error's suggestion is one command a shell can run, and the message
// names the other way out, --no-control.
import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageError } from "../../src/cli/args.ts";
import { replayWithControl } from "../../src/cli/commands/exp-llm.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import type { LlmPlan } from "../../src/cli/commands/exp-llm.ts";
import type { FileEvalStore } from "../../src/datasets/store.ts";
import type { ExperimentResult } from "../../src/datasets/types.ts";

test("no stored task spec: the suggestion is one command, and the message names --no-control", async () => {
  // A replay of exp_01REC made before replays stored their task spec.
  const source: ExperimentResult = {
    id: "exp_01OLD",
    name: "old-replay",
    dataset: { id: "ds_1", name: "triage", version: "1" },
    task: { kind: "command", ref: "node triage.mjs" },
    graders: [],
    trials: 1,
    createdAt: 0,
    finishedAt: 0,
    runs: [],
    summary: { n: 0, cases: 0, passed: 0, errors: 0, passRate: { p: 0, lo: 0, hi: 0 }, ciMethod: "wilson", graders: [], latencyMs: { mean: 0, median: 0, p90: 0, max: 0 } },
    metadata: { llm: { mode: "replay", source: "exp_01REC" } },
  };
  const plan: LlmPlan = { opts: { mode: "replay" }, source, control: true };
  await assert.rejects(replayWithControl({} as CommandContext, {} as FileEvalStore, plan, undefined, undefined), (e: unknown) => {
    assert.ok(e instanceof UsageError);
    assert.equal(e.reason, "no_control");
    // exp run with arms needs a dataset and a grader: the recording's dataset, and a grader to fill in.
    assert.equal(e.suggestion, "coding.sh exp run -d ds_1 -g <GRADER> --arm control=recorded.json --arm cand=cand.json --replay exp_01OLD");
    assert.match(e.message, /^exp_01OLD did not record a command or http task spec, so there is no control arm to replay\. .*--no-control/);
    return true;
  });
  // With a spec file, the suggestion runs that file, which names the dataset and graders.
  await assert.rejects(replayWithControl({} as CommandContext, {} as FileEvalStore, plan, "my spec.json", undefined), (e: unknown) => {
    assert.ok(e instanceof UsageError);
    assert.equal(e.suggestion, "coding.sh exp run 'my spec.json' --arm control=recorded.json --arm cand=cand.json --replay exp_01OLD");
    return true;
  });
});
