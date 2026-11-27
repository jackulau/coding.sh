import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateCases } from "../../src/bench/sources.ts";
import { MAX_DATE_MS } from "../../src/core/dates.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const FAR = MAX_DATE_MS + 1;

describe("bench/sources date range handling", () => {
  it("leaves createdAt out for a session outside the Date range and keeps valid cases intact", async () => {
    const index = new MemoryIndexStore();
    const sOk: Session = {
      id: "s-ok",
      agent: "claude-code",
      startedAt: NOW - 3600_000,
      flags: ["looping"],
      stats: { events: 2, turns: 1, toolCalls: 1, toolErrors: 1, filesChanged: 0 },
    };
    const sFar: Session = {
      id: "s-far",
      agent: "claude-code",
      startedAt: FAR,
      flags: ["looping"],
      stats: { events: 2, turns: 1, toolCalls: 1, toolErrors: 1, filesChanged: 0 },
    };
    await index.upsertSession(sOk);
    await index.upsertSession(sFar);
    const evs: AgentEvent[] = [
      { id: "ok-1", v: 0, sessionId: sOk.id, ts: sOk.startedAt, agent: "claude-code", kind: "user.message", payload: { text: "Fix the build" } },
      { id: "far-1", v: 0, sessionId: sFar.id, ts: FAR, agent: "claude-code", kind: "user.message", payload: { text: "Fix the far build" } },
    ];
    await index.putEvents(evs);

    const cases = await generateCases({
      def: { name: "b", source: { kind: "sessions", since: "7d" }, contenders: [], graders: [] } as never,
      seed: "s",
      date: "2026-11-10",
      runId: "r1",
      env: {},
      now: NOW,
      index,
    });
    assert.equal(cases.length, 2);
    const farCase = cases.find((c) => c.input && JSON.stringify(c.input).includes("far build"))!;
    const okCase = cases.find((c) => c.input && JSON.stringify(c.input).includes("Fix the build"))!;
    assert.equal("createdAt" in (farCase.metadata ?? {}), false);
    assert.equal(okCase.metadata?.createdAt, new Date(sOk.startedAt).toISOString());
  });
});
