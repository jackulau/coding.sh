// MCP reads of a session longer than the digest reads at once (DIGEST_EVENT_CAP):
// the tail and the last turn come from the session's end, not from the middle,
// with turns numbered as in the whole session, and derails in the summary.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import { DIGEST_EVENT_CAP, sessionDigest } from "../../src/mcp/digest.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";

describe("a session past the digest cap", () => {
  it("reads its tail and last turn from the end", async () => {
    const events: AgentEvent[] = [];
    let ts = Date.UTC(2026, 10, 3, 16);
    let n = 0;
    const ev = (kind: AgentEvent["kind"], payload: Record<string, unknown>) => events.push({ id: `e${++n}`, v: 0, sessionId: "long", agent: "claude-code", ts: (ts += 1000), kind, payload });
    ev("session.start", { source: "startup" });
    let turn = 0;
    while (events.length < DIGEST_EVENT_CAP + 2000) {
      ev("user.message", { text: `Step ${++turn}` });
      for (let i = 0; i < 49; i++) {
        ev("tool.start", { tool: "Read", toolUseId: `t${n}`, input: { file_path: `src/f${i}.ts` } });
        ev("tool.end", { tool: "Read", toolUseId: `t${n - 1}`, ok: true, output: `v${n}` });
      }
    }
    const index = new MemoryIndexStore();
    await index.putEvents(events);
    const s = buildSession(events);
    await index.upsertSession(s);
    assert.equal(s.stats.turns, turn);

    const tail = await sessionDigest(index, s, { limit: 5, offset: 0, from: "tail", now: ts });
    assert.equal(tail.turnCount, turn, "turns counted over the whole session");
    assert.equal(tail.turns.at(-1)!.turn, turn);
    assert.equal(tail.turns.at(-1)!.prompt, `Step ${turn}`);
    assert.equal(tail.timeline.at(-1)!.at, events.at(-1)!.ts - s.startedAt, "the last entry is the session's last event");

    const last = await sessionDigest(index, s, { turn: -1, limit: 5, offset: 0, from: "head", now: ts });
    assert.equal(last.turn, turn);

    const head = await sessionDigest(index, s, { limit: 5, offset: 0, from: "head", now: ts });
    assert.equal(head.turns[0]!.turn, 1);
    assert.ok(head.timeline[0]!.at <= 1000, "the head starts at the beginning");
  });
});
