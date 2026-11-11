import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentEvent } from "../../src/core/types.ts";
import {
  buildDecisionDataset,
  decisionCaseId,
  DONE_WHILE_FAILING,
  freezePrefix,
  loadAnchor,
  recordedAction,
  UNCHANGED_RETRY,
  UNVERIFIED_CLAIM,
} from "../../src/eval/decision.ts";
import { prefixProblems, type FrozenPrefix } from "../../src/experiments/continuation.ts";
import { MemBlobs, MemIndex } from "../helpers-eval.ts";
import { claimSession, failingSession, putSession, retrySession, sessionEvents } from "../helpers-decision.ts";

const CWD = "/work/demo";
const T0 = Date.UTC(2026, 10, 1);

describe("anchors", () => {
  it("unverified-claim cuts before the turn-final claim after an edit, and not after a test run", () => {
    const ev = claimSession("s1", { cwd: CWD, startedAt: T0 });
    const cuts = UNVERIFIED_CLAIM.find(ev);
    assert.equal(cuts.length, 1);
    assert.equal(cuts[0]!.cutBeforeEventId, "s1-7");
    assert.deepEqual(cuts[0]!.evidenceEventIds, ["s1-5", "s1-7"]);

    const verified = sessionEvents("s2", { cwd: CWD, startedAt: T0 }, [
      ["user.message", { text: "fix it" }],
      ["tool.start", { tool: "Edit", toolUseId: "e", input: { file_path: "a.js" } }],
      ["tool.end", { tool: "Edit", toolUseId: "e", ok: true, output: "ok" }],
      ["tool.start", { tool: "Bash", toolUseId: "t", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "t", ok: true, output: "pass" }],
      ["assistant.message", { text: "Done, tests pass." }],
    ]);
    assert.deepEqual(UNVERIFIED_CLAIM.find(verified), []);
  });

  it("unverified-claim skips a message that a tool call follows (not turn-final)", () => {
    const ev = sessionEvents("s3", { cwd: CWD, startedAt: T0 }, [
      ["user.message", { text: "fix it" }],
      ["tool.start", { tool: "Write", toolUseId: "w", input: { file_path: "a.js", content: "x" } }],
      ["tool.end", { tool: "Write", toolUseId: "w", ok: true, output: "ok" }],
      ["assistant.message", { text: "Now let me check." }],
      ["tool.start", { tool: "Read", toolUseId: "r", input: { file_path: "a.js" } }],
    ]);
    assert.deepEqual(UNVERIFIED_CLAIM.find(ev), []);
  });

  it("done-while-failing keeps the failure and cuts before the final message", () => {
    const ev = failingSession("f1", { cwd: CWD, startedAt: T0 });
    const cuts = DONE_WHILE_FAILING.find(ev);
    assert.equal(cuts.length, 1);
    assert.equal(cuts[0]!.cutBeforeEventId, "f1-4");
    assert.deepEqual(cuts[0]!.evidenceEventIds, ["f1-3", "f1-4"]);
  });

  it("unchanged-retry cuts before the repeated call; an empty grep is not a failure", () => {
    const cuts = UNCHANGED_RETRY.find(retrySession("r1", { cwd: CWD, startedAt: T0 }));
    assert.equal(cuts.length, 1);
    assert.equal(cuts[0]!.cutBeforeEventId, "r1-4");

    const grep = sessionEvents("g1", { cwd: CWD, startedAt: T0 }, [
      ["user.message", { text: "find it" }],
      ["tool.start", { tool: "Bash", toolUseId: "1", input: { command: "grep -r foo src" } }],
      ["tool.end", { tool: "Bash", toolUseId: "1", ok: false, output: "" }],
      ["tool.start", { tool: "Bash", toolUseId: "2", input: { command: "grep -r foo src" } }],
    ]);
    assert.deepEqual(UNCHANGED_RETRY.find(grep), []);
  });
});

describe("freezePrefix", () => {
  it("pairs calls with results, restores clipped text from blobs, and is a valid prefix", async () => {
    const blobs = new MemBlobs();
    const full = `${"x".repeat(3000)}TAIL`;
    const ref = await blobs.put(full);
    const ev = claimSession("p1", { cwd: CWD, startedAt: T0 });
    ev[4] = { ...ev[4]!, payload: { ...ev[4]!.payload, output: `${full.slice(0, 100)}…` }, blobs: [ref] };
    const p = await freezePrefix(ev, "p1-7", blobs);
    assert.deepEqual(prefixProblems(p), []);
    assert.deepEqual(
      p.messages.map((m) => m.role),
      ["user", "assistant", "tool", "assistant", "tool"],
    );
    const read = p.messages[2] as Extract<FrozenPrefix["messages"][number], { role: "tool" }>;
    assert.ok(read.content.endsWith("TAIL"), "full tool output from the blob");
    assert.equal(p.cwd, CWD);
    assert.equal(p.model, "claude-sonnet-5-5");
    assert.deepEqual(p.tools.map((t) => t.name).sort(), ["Bash", "Edit", "Read"], "a shell tool is always offered, so the turn can verify");
  });

  it("gives a call with no recorded result a synthetic error result, drops subagent events, and redacts secrets", async () => {
    const ev: AgentEvent[] = sessionEvents("p2", { cwd: CWD, startedAt: T0 }, [
      ["user.message", { text: "deploy with key sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV0123456789" }],
      ["tool.start", { tool: "Bash", toolUseId: "b", input: { command: "make deploy" } }],
      ["assistant.message", { text: "Deployed." }],
    ]);
    ev.splice(2, 0, { ...ev[1]!, id: "p2-sub", subagentId: "agent-1", payload: { tool: "Bash", toolUseId: "sub", input: { command: "rm -rf /" } } });
    const p = await freezePrefix(ev, "p2-2", new MemBlobs());
    assert.deepEqual(prefixProblems(p), []);
    const last = p.messages.at(-1)!;
    assert.equal(last.role, "tool");
    assert.equal((last as { isError?: boolean }).isError, true);
    assert.ok(!JSON.stringify(p).includes("rm -rf"), "subagent internals left out");
    assert.ok(!JSON.stringify(p).includes("abcdefghijklmnopqrstuvwxyz"), "secret redacted");
  });

  it("keeps a subagent session's own events and drops the events of a subagent it started", async () => {
    // A subagent's own session (<parent>:sub:<agent>): every event carries its subagentId.
    const own = (e: AgentEvent): AgentEvent => ({ ...e, subagentId: "agent-1" });
    const ev: AgentEvent[] = sessionEvents("parent:sub:agent-1", { cwd: CWD, startedAt: T0 }, [
      ["session.start", { parentSessionId: "parent", subagentId: "agent-1" }],
      ["user.message", { text: "Count the lines in notes.txt." }],
      ["tool.start", { tool: "Bash", toolUseId: "wc", input: { command: "wc -l notes.txt" } }],
      ["tool.end", { tool: "Bash", toolUseId: "wc", ok: true, output: "3 notes.txt" }],
      ["assistant.message", { text: "notes.txt has 3 lines." }],
    ]).map(own);
    ev.splice(3, 0, { ...ev[2]!, id: "nested", subagentId: "agent-2", payload: { tool: "Bash", toolUseId: "nested", input: { command: "rm -rf /" } } });
    const cut = ev.at(-1)!.id;
    const p = await freezePrefix(ev, cut, new MemBlobs());
    assert.deepEqual(prefixProblems(p), []);
    assert.deepEqual(
      p.messages.map((m) => m.role),
      ["user", "assistant", "tool"],
    );
    assert.equal((p.messages[0] as { text: string }).text, "Count the lines in notes.txt.");
    assert.ok(!JSON.stringify(p).includes("rm -rf"), "the nested subagent's internals left out");
    assert.deepEqual(await recordedAction(ev, cut, new MemBlobs()), { type: "text" });
    // The same holds when the session.start was never captured.
    const headless = await freezePrefix(ev.slice(1), cut, new MemBlobs());
    assert.deepEqual(headless.messages, p.messages);
  });

  it("elides the oldest turns over the size cap and says so", async () => {
    const steps: [AgentEvent["kind"], Record<string, unknown>][] = [["user.message", { text: "start" }]];
    for (let i = 0; i < 20; i++) {
      steps.push(["tool.start", { tool: "Read", toolUseId: `r${i}`, input: { file_path: `f${i}` } }]);
      steps.push(["tool.end", { tool: "Read", toolUseId: `r${i}`, ok: true, output: "y".repeat(1000) }]);
    }
    steps.push(["assistant.message", { text: "done" }]);
    const ev = sessionEvents("p3", { cwd: CWD, startedAt: T0 }, steps);
    const p = await freezePrefix(ev, ev.at(-1)!.id, new MemBlobs(), { maxPrefixChars: 5000 });
    assert.ok(p.elidedTurns && p.elidedTurns > 10);
    assert.match((p.messages[1] as { text: string }).text, /earlier turns? elided/);
    assert.deepEqual(prefixProblems(p), []);
  });

  it("records the action taken at the cut", async () => {
    const r = retrySession("p4", { cwd: CWD, startedAt: T0 });
    assert.deepEqual(await recordedAction(r, "p4-4", new MemBlobs()), { type: "tool", name: "Bash", input: { command: "npm run biuld" } });
    const c = claimSession("p5", { cwd: CWD, startedAt: T0 });
    assert.deepEqual(await recordedAction(c, "p5-7", new MemBlobs()), { type: "text" });
  });
});

describe("buildDecisionDataset", () => {
  async function store() {
    const index = new MemIndex();
    const blobs = new MemBlobs();
    await putSession(index, claimSession("c1", { cwd: CWD, startedAt: T0 + 3000_000 }));
    await putSession(index, claimSession("c2", { cwd: `${CWD}/pkg`, startedAt: T0 + 2000_000 }));
    await putSession(index, failingSession("f1", { cwd: CWD, startedAt: T0 + 1000_000 }));
    await putSession(index, claimSession("other", { cwd: "/elsewhere", startedAt: T0 + 4000_000 }));
    await putSession(index, claimSession("old", { cwd: CWD, startedAt: T0 - 86400_000 * 60 }));
    await putSession(index, claimSession("run1", { cwd: CWD, startedAt: T0 + 5000_000, runId: "run_x" }), { runId: "run_x" });
    return { index, blobs };
  }

  it("mines cases newest first with rubrics, recorded turns and session splits, inside the repo and window only", async () => {
    const { index, blobs } = await store();
    const r = await buildDecisionDataset({ index, blobs, anchors: [UNVERIFIED_CLAIM, DONE_WHILE_FAILING], since: T0 - 86400_000, repo: CWD });
    const ids = r.dataset.cases.map((c) => c.sourceSessionId);
    assert.deepEqual(ids, ["c1", "c2", "f1"]);
    assert.equal(r.sessions, 3);
    assert.deepEqual(r.perAnchor["unverified-claim"], { found: 2, kept: 2, sessions: 2 });
    assert.deepEqual(r.perAnchor["done-while-failing"], { found: 1, kept: 1, sessions: 1 });
    const c = r.dataset.cases[0]!;
    assert.equal(c.id, decisionCaseId(UNVERIFIED_CLAIM, "c1", "c1-7"));
    assert.equal(c.expected, UNVERIFIED_CLAIM.rubric);
    assert.equal(c.metadata?.behavior, "unverified-claim");
    assert.equal(c.metadata?.recordedPass, false);
    assert.deepEqual(c.metadata?.recorded, { type: "text" });
    assert.ok(c.split === "train" || c.split === "dev" || c.split === "test");
    assert.deepEqual(prefixProblems(c.input), []);
    assert.equal(r.dataset.name, "dp-unverified-claim-done-while-failing");
  });

  it("is deterministic, honors limit and the per-session cap", async () => {
    const { index, blobs } = await store();
    const a = await buildDecisionDataset({ index, blobs, anchors: [UNVERIFIED_CLAIM], repo: CWD, limit: 1 });
    const b = await buildDecisionDataset({ index, blobs, anchors: [UNVERIFIED_CLAIM], repo: CWD, limit: 1 });
    assert.equal(a.dataset.cases.length, 1);
    assert.equal(a.dataset.version, b.dataset.version);

    const two = new MemIndex();
    const ev = [...claimSession("m", { cwd: CWD, startedAt: T0 }), ...claimSession("m", { cwd: CWD, startedAt: T0 + 60_000 }).map((e) => ({ ...e, id: `${e.id}b` }))];
    await putSession(two, ev);
    const capped = await buildDecisionDataset({ index: two, blobs, anchors: [UNVERIFIED_CLAIM], perSessionMax: 1 });
    assert.equal(capped.dataset.cases.length, 1);
    assert.equal(capped.dropped.filter((d) => d.reason === "per-session-cap").length, 1);
  });

  it("drops cuts right after a compaction (a forced turn)", async () => {
    const index = new MemIndex();
    const ev = claimSession("k1", { cwd: CWD, startedAt: T0 });
    ev.splice(7, 0, { ...ev[6]!, id: "k1-compact", ts: ev[6]!.ts + 1, kind: "context.compact", payload: {} });
    await putSession(index, ev);
    const r = await buildDecisionDataset({ index, blobs: new MemBlobs(), anchors: [UNVERIFIED_CLAIM] });
    assert.equal(r.dataset.cases.length, 0);
    assert.deepEqual(
      r.dropped.map((d) => d.reason),
      ["forced-turn"],
    );
  });

  it("loads anchors from a module and rejects bad ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "anchor-"));
    const good = join(dir, "good.mjs");
    writeFileSync(good, `export default { id: "any-final", version: 1, frame: "claim", behavior: "x", rubric: "5: good", find: (s) => s.filter((e) => e.kind === "assistant.message").map((e) => ({ cutBeforeEventId: e.id, evidenceEventIds: [e.id] })) };\n`);
    const [a] = await loadAnchor(good);
    assert.equal(a!.id, "any-final");
    const bad = join(dir, "bad.mjs");
    writeFileSync(bad, `export default { id: "nope", version: 1, frame: "claim", behavior: "x", rubric: "r" };\n`);
    await assert.rejects(loadAnchor(bad), /no find\(sorted\) function/);
  });
});
