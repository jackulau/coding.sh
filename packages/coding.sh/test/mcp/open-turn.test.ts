// A turn still under way (a prompt after the last turn.end, as a transcript
// still being written has it) is listed by session_get but not counted:
// stats.turns counts closed turns, so turnCount, session.turns and the
// out-of-range error give one number, short or past the digest cap.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import { DIGEST_EVENT_CAP, sessionDigest, sessionMarkdown } from "../../src/mcp/digest.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";

function build(sessionId: string, closedTurns: number, toolsPerTurn: number) {
  const events: AgentEvent[] = [];
  let ts = Date.UTC(2026, 10, 3, 16);
  let n = 0;
  const ev = (kind: AgentEvent["kind"], payload: Record<string, unknown>, turnId?: string) => {
    const e: AgentEvent = { id: `${sessionId}-${++n}`, v: 0, sessionId, agent: "claude-code", ts: (ts += 1000), kind, payload, source: "transcript" };
    if (turnId) e.turnId = turnId;
    events.push(e);
  };
  ev("session.start", { source: "transcript" });
  const turn = (i: number, close: boolean) => {
    const id = `t${i}`;
    ev("user.message", { text: `Step ${i}` }, id);
    for (let k = 0; k < toolsPerTurn; k++) {
      ev("tool.start", { tool: "Read", toolUseId: `u${n}`, input: { file_path: `src/f${k}.ts` } }, id);
      ev("tool.end", { tool: "Read", toolUseId: `u${n - 1}`, ok: true, output: `v${n}` }, id);
    }
    if (close) ev("turn.end", { synthesized: true }, id);
  };
  for (let i = 1; i <= closedTurns; i++) turn(i, true);
  turn(closedTurns + 1, false);
  return { events, now: ts };
}

async function stored(events: AgentEvent[]) {
  const index = new MemoryIndexStore();
  await index.putEvents(events);
  const s = buildSession(events);
  await index.upsertSession(s);
  return { index, s };
}

describe("a turn still under way", () => {
  it("is listed and opens, but session.turns, turnCount and the error agree", async () => {
    const { events, now } = build("open", 3, 2);
    const { index, s } = await stored(events);
    assert.equal(s.stats.turns, 3, "stats count the closed turns");

    const d = await sessionDigest(index, s, { limit: 5, offset: 0, now });
    assert.equal((d.session as { turns: number }).turns, 3);
    assert.equal(d.turnCount, 3);
    assert.deepEqual(d.turns.map((t) => [t.turn, t.open ?? false]), [[1, false], [2, false], [3, false], [4, true]]);

    const last = await sessionDigest(index, s, { turn: -1, limit: 50, offset: 0, now });
    assert.equal(last.turn, 4);
    assert.equal(last.turns[0]!.prompt, "Step 4");
    assert.equal(last.turnCount, 3);

    await assert.rejects(sessionDigest(index, s, { turn: 5, limit: 5, offset: 0, now }), /has 3 turn\(s\) and turn 4 under way; turn 5 does not exist/);

    const md = await sessionMarkdown(index, s, 10, now);
    assert.match(md, /3 turns,/);
    assert.match(md, /^4\. .*"Step 4".* · under way$/m);
    assert.doesNotMatch(md, /^3\. .*under way/m);
  });

  it("past the digest cap, numbers the tail's turns as in the whole session", async () => {
    const { events, now } = build("open-long", Math.ceil((DIGEST_EVENT_CAP + 2000) / 100), 49);
    const { index, s } = await stored(events);
    const closed = s.stats.turns;
    const tail = await sessionDigest(index, s, { limit: 5, offset: 0, from: "tail", now });
    assert.equal(tail.turnCount, closed);
    assert.equal(tail.turns.at(-1)!.turn, closed + 1);
    assert.equal(tail.turns.at(-1)!.open, true);
    assert.equal(tail.turns.at(-1)!.prompt, `Step ${closed + 1}`);
    assert.equal(tail.turns.at(-2)!.turn, closed);
    assert.equal(tail.turns.at(-2)!.prompt, `Step ${closed}`);
  });

  it("is not marked when no turn ever closed: every prompt counts", async () => {
    const { events, now } = build("none", 0, 1);
    const { index, s } = await stored(events);
    const d = await sessionDigest(index, s, { limit: 5, offset: 0, now });
    assert.equal(s.stats.turns, 1);
    assert.equal(d.turnCount, 1);
    assert.equal(d.turns[0]!.open, undefined);
  });
});
