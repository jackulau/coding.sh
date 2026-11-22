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

test("no stored task spec: the suggestion is one command, and the message names --no-control", async () => {
  const plan = { opts: { mode: "replay" }, source: { id: "exp_01OLD", metadata: { llm: { mode: "replay", source: "exp_01REC" } } }, control: true } as unknown as LlmPlan;
  await assert.rejects(replayWithControl({} as CommandContext, {} as FileEvalStore, plan, undefined, undefined), (e: unknown) => {
    assert.ok(e instanceof UsageError);
    assert.equal(e.reason, "no_control");
    assert.equal(e.suggestion, "coding.sh exp run --arm control=recorded.json --arm cand=cand.json --replay exp_01OLD");
    assert.match(e.message, /^exp_01OLD did not record a command or http task spec, so there is no control arm to replay\. .*--no-control/);
    return true;
  });
});
