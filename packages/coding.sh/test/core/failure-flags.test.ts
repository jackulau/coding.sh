// The one rule for failures (src/core/failure-flags.ts): a tag (a colon in the name) and a note
// (compaction, step-retried, resumed) are not failures; every other flag is.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_FLAGS, failureFlags, isFailureFlag } from "../../src/core/failure-flags.ts";
import { FLAGS } from "../../src/core/sessions.ts";

test("the notes are compaction, step-retried and resumed", () => {
  assert.deepEqual([...CONTEXT_FLAGS].sort(), ["compaction", "resumed", "step-retried"]);
});

test("of the flags coding.sh sets, the failures are the ones with no colon that are not notes", () => {
  // The derails (core/derail.ts: looping, churn, stalled, ...) are failures too.
  assert.deepEqual(Object.values(FLAGS).filter(isFailureFlag).sort(), [
    "api-stall",
    "churn",
    "context-thrash",
    "duplicate-fetch",
    "failure-streak",
    "llm-error",
    "looping",
    "no-progress",
    "no-verification",
    "premature-completion",
    "refusal",
    "repeated-tool-failure",
    "skill-copy-conflict",
    "stalled",
    "test-tamper",
    "text-tool-call",
    "unapproved-action",
  ]);
  // A flag this version does not know is a failure unless it is a tag.
  assert.equal(isFailureFlag("a-newer-flag"), true);
  assert.equal(isFailureFlag("skill:pdf"), false);
});

test("failureFlags keeps the failures in their order", () => {
  assert.deepEqual(failureFlags(["compaction", "no-verification", "skill:pdf", "resumed", "api-stall", "step-retried"]), ["no-verification", "api-stall"]);
  assert.deepEqual(failureFlags(["compaction"]), []);
});
