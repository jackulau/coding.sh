import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import type { ChatProvider } from "../../src/judge/providers.ts";
import {
  deterministicLedger,
  draftStatement,
  renderStatement,
  requirementCandidates,
  StatementError,
  validateLedger,
  type Ledger,
} from "../../src/eval/statement.ts";
import { draftTaskFromSession, exportTaskDir, importTaskDir } from "../../src/eval/task.ts";
import { BUGGY, FIXED, FakeSnapshots, MemBlobs, MemIndex, tempDir } from "../helpers-eval.ts";

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

let seq = 0;
function ev(kind: AgentEvent["kind"], payload: Record<string, unknown>, extra: Partial<AgentEvent> = {}): AgentEvent {
  seq++;
  return { id: `e${seq}`, v: 0, sessionId: "s1", ts: 1000 + seq, agent: "claude-code", kind, payload, ...extra };
}
const user = (text: string, id: string) => ev("user.message", { text }, { id });
const says = (text: string, id: string) => ev("assistant.message", { text }, { id });

/** [ask A, 'ok', add B, 'actually change A to A′'] */
const TURNS: AgentEvent[] = [
  user("Make add() return the sum of its two arguments", "u1"),
  says("Done, add() now sums its arguments.", "a1"),
  user("ok", "u2"),
  user("Also make mul() return the product of its arguments", "u3"),
  user("actually change add() so it also accepts a third optional argument and sums all three", "u4"),
];

/** A ChatProvider that replies with `replies` in order and records every prompt. */
function scripted(replies: string[]): ChatProvider & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    name: "fake",
    model: "scripted",
    params: {},
    prompts,
    async complete(req) {
      prompts.push(req.user);
      const text = replies[Math.min(prompts.length - 1, replies.length - 1)]!;
      return { text, model: "scripted" };
    },
  } as ChatProvider & { prompts: string[] };
}

const GOOD: Ledger = {
  obligations: [
    { id: "R1", text: "add() returns the sum of its two arguments", evidence: ["u1"], status: "superseded", supersededBy: "R3" },
    { id: "R2", text: "mul() returns the product of its arguments", evidence: ["u3"], status: "surviving" },
    { id: "R3", text: "add() accepts an optional third argument and returns the sum of all of them", evidence: ["u1", "u4"], status: "surviving" },
  ],
  notImplemented: [],
};

describe("requirementCandidates / deterministicLedger", () => {
  it("drops acknowledgements and keeps every requirement turn: 3 obligations", () => {
    const cands = requirementCandidates(TURNS);
    assert.deepEqual(cands.map((c) => c.eventId), ["u1", "u3", "u4"]);
    assert.ok(cands.every((c) => c.kind === "user"));
    const ledger = deterministicLedger(cands);
    assert.equal(ledger.length, 3);
    assert.deepEqual(ledger.map((o) => [o.id, o.evidence, o.status]), [["R1", ["u1"], "surviving"], ["R2", ["u3"], "surviving"], ["R3", ["u4"], "surviving"]]);
    assert.ok(!renderStatement(ledger).includes("ok\n"));
  });

  it("drops harness text, keeps long messages that start with ok, and turns an approved proposal into a candidate", () => {
    const cands = requirementCandidates([
      user("<command-name>/clear</command-name>", "c1"),
      user("This session is being continued from a previous conversation that ran out of context.", "c2"),
      user("ok so the parser also needs to reject empty input with a clear error message", "u1"),
      says("I could cache the parsed config in memory so repeated calls skip the disk. Want me to?", "a1"),
      user("sounds good", "u2"),
      says("Should I also rename the module?", "a2"),
      user("thanks", "u3"),
    ]);
    assert.deepEqual(cands.map((c) => [c.eventId, c.kind]), [["u1", "user"], ["a1", "approved-proposal"]]);
    assert.match(cands[1]!.text, /cache the parsed config/);
  });
});

describe("validateLedger", () => {
  const cands = requirementCandidates(TURNS);
  const assistantIds = new Set(["a1"]);

  it("accepts a well-formed ledger", () => {
    assert.deepEqual(validateLedger(GOOD, cands, undefined, assistantIds), []);
  });

  it("names unknown ids, unapproved assistant text, dangling supersededBy and duplicates", () => {
    const bad: Ledger = {
      obligations: [
        { id: "R1", text: "x", evidence: ["nope"], status: "superseded", supersededBy: "R9" },
        { id: "R1", text: "y", evidence: ["a1"], status: "surviving" },
        { id: "R2", text: "z", evidence: [], status: "surviving" },
      ],
      notImplemented: ["R7"],
    };
    const p = validateLedger(bad, cands, undefined, assistantIds).join("\n");
    assert.match(p, /duplicate obligation id R1/);
    assert.match(p, /R1 cites unknown event id nope/);
    assert.match(p, /R1 cites a1, assistant text the user never approved/);
    assert.match(p, /R2 cites no evidence/);
    assert.match(p, /superseded by R9, which is not in the ledger/);
    assert.match(p, /notImplemented names R7/);
  });

  it("lets an approved proposal be cited", () => {
    const events = [user("speed up config loading", "u1"), says("I could cache the parsed config in memory. OK?", "a1"), user("sounds good", "u2")];
    const c = requirementCandidates(events);
    const l: Ledger = { obligations: [{ id: "R1", text: "the parsed config is cached in memory", evidence: ["a1"], status: "surviving" }], notImplemented: [] };
    assert.deepEqual(validateLedger(l, c, undefined, new Set(["a1"])), []);
  });

  it("rejects a statement that copies ≥30% of the reference patch's 8-grams", () => {
    const code = "export function add(a, b, c = 0) { return a + b + c; }";
    const patch = ["diff --git a/src/add.js b/src/add.js", "--- a/src/add.js", "+++ b/src/add.js", "@@ -1,1 +1,1 @@", "-export function add(a, b) { return a - b; }", `+${code}`, ""].join("\n");
    const leaky: Ledger = { obligations: [{ id: "R1", text: `write ${code}`, evidence: ["u1"], status: "surviving" }], notImplemented: [] };
    assert.match(validateLedger(leaky, cands, patch).join("\n"), /repeats \d+% of the reference patch/);
    assert.deepEqual(validateLedger(GOOD, cands, patch, assistantIds), []);
  });
});

describe("draftStatement", () => {
  const cands = requirementCandidates(TURNS);

  it("renders B and A′ but not A when the model marks R1 superseded by R3", async () => {
    const p = scripted([JSON.stringify(GOOD)]);
    const d = await draftStatement({ candidates: cands, provider: p, assistantIds: new Set(["a1"]) });
    assert.equal(d.submissions, 1);
    assert.equal(d.statement, "- mul() returns the product of its arguments\n- add() accepts an optional third argument and returns the sum of all of them");
    assert.ok(!d.statement.includes("two arguments"));
    assert.ok(!/R\d/.test(d.statement), "no ids in agent-visible text");
    assert.match(p.prompts[0]!, /\[u4\] developer:/);
  });

  it("re-requests a ledger that cites an unknown event id, echoing the problem", async () => {
    const bad = { ...GOOD, obligations: [...GOOD.obligations.slice(0, 2), { ...GOOD.obligations[2]!, evidence: ["u9"] }] };
    const p = scripted([JSON.stringify(bad), "```json\n" + JSON.stringify(GOOD) + "\n```"]);
    const d = await draftStatement({ candidates: cands, provider: p });
    assert.equal(d.submissions, 2);
    assert.equal(p.prompts.length, 2);
    assert.match(p.prompts[1]!, /previous ledger was rejected[\s\S]*R3 cites unknown event id u9/);
    assert.deepEqual(d.rejected, [["R3 cites unknown event id u9"]]);
  });

  it("throws StatementError after three bad submissions", async () => {
    const bad = { obligations: [{ id: "R1", text: "x", evidence: ["zzz"], status: "surviving" }], notImplemented: [] };
    const p = scripted(["not json", JSON.stringify(bad), JSON.stringify(bad), JSON.stringify(GOOD)]);
    await assert.rejects(
      draftStatement({ candidates: cands, provider: p }),
      (e: unknown) => e instanceof StatementError && /no valid ledger in 3 submissions/.test(e.message) && e.problems.some((x) => /unknown event id zzz/.test(x)),
    );
    assert.equal(p.prompts.length, 3);
  });

  it("leaves notImplemented obligations out of the statement", () => {
    assert.equal(renderStatement({ ...GOOD, notImplemented: ["R2"] }), "- add() accepts an optional third argument and returns the sum of all of them");
  });
});

describe("draftTaskFromSession statement: ledger", () => {
  const ROOT = "/work/toy";
  async function fixture() {
    const index = new MemIndex();
    const blobs = new MemBlobs();
    const git = new FakeSnapshots().add("start", BUGGY).add("end", FIXED);
    const session: Session = {
      id: "s1",
      agent: "claude-code",
      repo: { root: ROOT, head: "abc123", snapshot: "start" },
      startedAt: 1000,
      stats: { events: 0, turns: 3, toolCalls: 0, toolErrors: 0, filesChanged: 2 },
      flags: [],
      endSnapshot: "end",
    };
    await index.upsertSession(session);
    await index.putEvents([ev("session.start", {}, { id: "s0", repo: { root: ROOT, head: "abc123", snapshot: "start" } }), ...TURNS]);
    return { index, blobs, git };
  }

  it("keeps the default path unchanged", async () => {
    const f = await fixture();
    const a = await draftTaskFromSession({ ...f, sessionId: "s1", verifierCommand: "npm test", now: 1 });
    const b = await draftTaskFromSession({ ...f, sessionId: "s1", verifierCommand: "npm test", statement: "first-prompt", now: 1 });
    assert.deepEqual(a, b);
    assert.equal(a.instruction, "Make add() return the sum of its two arguments");
    assert.equal(a.meta.instructionSource, "session");
    assert.equal("obligations" in a.meta, false);
  });

  it("without a provider: one obligation per turn, with a note", async () => {
    const f = await fixture();
    const t = await draftTaskFromSession({ ...f, sessionId: "s1", verifierCommand: "npm test", statement: "ledger", now: 1 });
    assert.equal(t.meta.instructionSource, "ledger");
    assert.deepEqual(t.meta.followUps, []);
    assert.equal(t.meta.obligations?.length, 3);
    assert.equal(t.instruction.split("\n").length, 3);
    assert.ok(t.meta.notes.includes("ledger is unmerged user turns; review superseded requirements"));
  });

  it("with a provider: the merged statement, the reference patch in the prompt, and an export/import round trip", async () => {
    const f = await fixture();
    const p = scripted([JSON.stringify(GOOD)]);
    const t = await draftTaskFromSession({ ...f, sessionId: "s1", verifierCommand: "npm test", statement: "ledger", provider: p, now: 1 });
    assert.equal(t.instruction, renderStatement(GOOD));
    assert.deepEqual(t.meta.obligations, GOOD.obligations);
    assert.match(p.prompts[0]!, /Reference patch \(use only to decide/);
    const explicit = await draftTaskFromSession({ ...f, sessionId: "s1", verifierCommand: "npm test", statement: "ledger", provider: p, instruction: "do it", now: 1 });
    assert.equal(explicit.instruction, "do it");
    assert.equal(explicit.meta.instructionSource, "given");
    assert.equal(p.prompts.length, 1, "an explicit instruction wins without a model call");

    const dir = await tempDir("csh-ledger-");
    dirs.push(dir);
    await exportTaskDir(t, dir, f.blobs);
    const back = await importTaskDir(dir, new MemBlobs());
    assert.deepEqual((back.meta as Record<string, unknown>).obligations, GOOD.obligations);
  });
});
