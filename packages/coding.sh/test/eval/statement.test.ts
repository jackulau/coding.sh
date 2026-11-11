import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "../../src/core/types.ts";
import { deterministicLedger, renderStatement, requirementCandidates } from "../../src/eval/statement.ts";

let seq = 0;
function ev(kind: AgentEvent["kind"], text: string, id: string): AgentEvent {
  seq++;
  return { id, v: 0, sessionId: "s1", ts: 1000 + seq, agent: "claude-code", kind, payload: { text } };
}
const user = (text: string, id: string) => ev("user.message", text, id);
const says = (text: string, id: string) => ev("assistant.message", text, id);

const PROPOSAL = "Added greet.js. I propose to also add a farewell(name) function that returns 'Bye, <name>!' in the same file. Shall I?";
/** [ask, proposal, reply] */
const session = (reply: string): AgentEvent[] => [
  user("Add greet.js exporting greet(name) that returns 'Hello, <name>!'.", "u1"),
  says(PROPOSAL, "a1"),
  user(reply, "u2"),
];
const shape = (reply: string) => requirementCandidates(session(reply)).map((c) => [c.eventId, c.kind]);

describe("requirementCandidates: approvals", () => {
  it("keeps the user's words when an approval goes on to change the proposal", () => {
    const cands = requirementCandidates(session("yes, but call it goodbye instead"));
    assert.deepEqual(cands.map((c) => [c.eventId, c.kind]), [["u1", "user"], ["a1", "approved-proposal"], ["u2", "user"]]);
    assert.match(cands[2]!.text, /goodbye/);
    const ledger = deterministicLedger(cands);
    assert.deepEqual(ledger.at(-1)!.evidence, ["u2"]);
    assert.match(ledger.at(-1)!.text, /goodbye/);
    // The amendment reads in context: the proposal it changes comes right before it.
    const lines = renderStatement(ledger).split("\n");
    assert.match(lines[1]!, /farewell\(name\)/);
    assert.equal(lines[2], "- yes, but call it goodbye instead");
  });

  it("keeps an amendment of any length, not only a short tail", () => {
    const reply = "Sounds good, but name the function goodbye, export it from index.js as well, and make it take an optional greeting argument that defaults to 'Bye'.";
    const cands = requirementCandidates(session(reply));
    assert.deepEqual(cands.map((c) => [c.eventId, c.kind]), [["u1", "user"], ["a1", "approved-proposal"], ["u2", "user"]]);
    assert.equal(cands[2]!.text, reply);
  });

  it("a bare approval still yields only the approved proposal", () => {
    for (const reply of ["yes, do it.", "sounds good, thanks!", "sounds good", "Yes please", "ok, go ahead", "ship it!", "sounds good to me", "yes, continue"]) {
      assert.deepEqual(shape(reply), [["u1", "user"], ["a1", "approved-proposal"]], reply);
    }
  });

  it("ok and thanks are still acknowledgements, not approvals", () => {
    for (const reply of ["ok", "thanks", "ok thanks"]) assert.deepEqual(shape(reply), [["u1", "user"]], reply);
  });

  it("a word that only starts like an approval is the user's own turn", () => {
    assert.deepEqual(shape("yesterday's build broke: fix the import in greet.js"), [["u1", "user"], ["u2", "user"]]);
    // "do it" opens an instruction of its own here; the assistant's last message is not a proposal.
    assert.deepEqual(shape("do it again for shout(s) in shout.js"), [["u1", "user"], ["u2", "user"]]);
    assert.deepEqual(shape("go ahead, and add a test for it too"), [["u1", "user"], ["a1", "approved-proposal"], ["u2", "user"]]);
    // Without a proposal before it there is nothing to approve.
    const cands = requirementCandidates([user("yes, but call it goodbye instead", "u1")]);
    assert.deepEqual(cands.map((c) => [c.eventId, c.kind]), [["u1", "user"]]);
  });
});
