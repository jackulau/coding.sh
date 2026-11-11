// The start state `eval new` drafts a task from. A hooked session's start is
// HEAD-only (the hook does no git work). Under `coding.sh run --`, the wrapper
// snapshotted the whole tree just before it started the agent: the task starts
// from that snapshot, with no "start snapshot is partial" warning. Without a
// wrapper the warning stays, since uncommitted files may be missing.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { draftTaskFromSession } from "../../src/eval/task.ts";
import { BUGGY, FakeSnapshots, FIXED, HIDDEN_TEST, MemBlobs, MemIndex } from "../helpers-eval.ts";

const ROOT = "/work/toy";
const PARTIAL = /start snapshot is partial or HEAD-only/;

async function hooked(withWrapper: { head?: string; endedAt?: number } | undefined) {
  const index = new MemIndex();
  const blobs = new MemBlobs();
  const git = new FakeSnapshots().add("wrap-start", BUGGY).add("abc123", BUGGY).add("end", { ...FIXED, "test/add.test.js": HIDDEN_TEST });
  // As ingest stores a hooked Claude Code session: a HEAD-only repo state, an end snapshot from the Stop hook.
  const agent: Session = { id: "cc1", agent: "claude-code", repo: { root: ROOT, head: "abc123", partial: false }, startedAt: 2000, endedAt: 9000, stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 1 }, flags: [], endSnapshot: "end" };
  await index.upsertSession(agent);
  let n = 0;
  const ev = (kind: AgentEvent["kind"], payload: Record<string, unknown>): AgentEvent => ({ id: `e${++n}`, v: 0, sessionId: "cc1", ts: 2000 + n, agent: "claude-code", kind, payload });
  await index.putEvents([ev("session.start", {}), ev("user.message", { text: "fix add" }), ev("tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "node test/add.test.js" } })]);
  if (withWrapper) {
    await index.upsertSession({ id: "wrap1", agent: "wrapper", repo: { root: ROOT, head: withWrapper.head ?? "abc123", snapshot: "wrap-start", partial: false }, startedAt: 1500, endedAt: withWrapper.endedAt ?? 9500, stats: { events: 2, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 1 }, flags: [], endSnapshot: "end" });
  }
  return draftTaskFromSession({ index, blobs, git, sessionId: "cc1", now: 5 });
}

describe("draftTaskFromSession: start of a hooked session", () => {
  it("under a run wrapper: starts from the wrapper's snapshot, no partial warning", async () => {
    const t = await hooked({});
    assert.equal(t.start.snapshot, "wrap-start");
    assert.equal(t.meta.notes.some((x) => PARTIAL.test(x)), false, t.meta.notes.join("\n"));
  });

  it("with no wrapper: HEAD-only, and says so", async () => {
    const t = await hooked(undefined);
    assert.equal(t.start.snapshot, "abc123");
    assert.ok(t.meta.notes.some((x) => PARTIAL.test(x)));
  });

  it("a wrapper at another HEAD, or one that ended before the session, is not used", async () => {
    for (const w of [{ head: "other" }, { endedAt: 1800 }]) {
      const t = await hooked(w);
      assert.equal(t.start.snapshot, "abc123", JSON.stringify(w));
      assert.ok(t.meta.notes.some((x) => PARTIAL.test(x)));
    }
  });
});
