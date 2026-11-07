import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSession } from "../../../src/core/sessions.ts";
import { EveStreamMapper, mapEveStream, parseEveStream } from "../../../src/integrations/eve/index.ts";
import { CHILD_A0, CHILD_A1, ofKind, ROOT_A, ROOT_B, STREAM_2TURNS, STREAM_TOOL_ERROR } from "./helpers.ts";

const twoTurns = readFileSync(STREAM_2TURNS, "utf8");

describe("mapEveStream (real eve session stream v27)", () => {
  const events = mapEveStream(twoTurns, { sessionId: ROOT_A });

  it("maps a 2-turn session with a subagent", () => {
    assert.ok(events.every((e) => e.sessionId === ROOT_A && e.agent === "eve" && e.agentVersion === "1.0.0-rc.6"));
    assert.equal(ofKind(events, "session.start").length, 1);
    assert.deepEqual(
      ofKind(events, "user.message").map((e) => [e.turnId, e.payload.text]),
      [
        ["turn_0", "What is the weather in Paris?"],
        ["turn_1", "And the weather in London?"],
      ],
    );
    const turns = ofKind(events, "turn.end");
    assert.deepEqual(
      turns.map((e) => e.payload.output),
      ["Paris: Sunny, 21°C. Outlook: staying clear through tomorrow.", "London: Rain, 14°C. Outlook: showers easing by evening."],
    );
    assert.ok(turns.every((e) => e.durationMs! > 0 && e.traceId));
    const s = buildSession(events);
    assert.equal(s.stats.turns, 2);
  });

  it("turns agent calls into subagent.start/end with the child session id", () => {
    const starts = ofKind(events, "subagent.start");
    const ends = ofKind(events, "subagent.end");
    assert.deepEqual(
      starts.map((e) => e.payload.type),
      ["forecaster", "forecaster"],
    );
    assert.deepEqual(
      ends.map((e) => [e.payload.childSessionId, e.payload.result, e.payload.ok]),
      [
        [CHILD_A0, "staying clear through tomorrow.", true],
        [CHILD_A1, "showers easing by evening.", true],
      ],
    );
    assert.deepEqual(ends[0]!.payload.reportedUsage, { inputTokens: 137, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 });
    // On the stream the call settles when the child replies, so this covers the child's whole run.
    assert.ok(ends.every((e) => e.durationMs! > 100));
    assert.equal(starts[0]!.parentId, ofKind(events, "tool.start").find((e) => e.payload.tool === "forecaster")!.id);
  });

  it("maps model runs to llm.call with latency and usage", () => {
    const calls = ofKind(events, "llm.call");
    assert.equal(calls.length, 8);
    assert.ok(calls.every((e) => e.model === "eve-mock/weather-script" && e.payload.provider === "eve-mock" && typeof e.durationMs === "number" && e.usage!.inputTokens! > 0));
    assert.equal(calls[0]!.payload.stopReason, "tool-calls");
    assert.equal(calls.at(-1)!.payload.stopReason, "stop");
  });

  it("reports a failed tool", () => {
    const evs = mapEveStream(readFileSync(STREAM_TOOL_ERROR, "utf8"), { sessionId: ROOT_B });
    const end = ofKind(evs, "tool.end")[0]!;
    assert.equal(end.payload.ok, false);
    assert.equal((end.payload.error as { code: string }).code, "ACTION_RESULT_FAILED");
    assert.equal(buildSession(evs).stats.toolErrors, 1);
    assert.equal(ofKind(evs, "turn.end")[0]!.payload.output, "Sorry, I have no weather data for Atlantis.");
  });

  it("ids are stream positions: stable, unique, and unaffected by heartbeats", () => {
    assert.equal(new Set(events.map((e) => e.id)).size, events.length);
    const withHeartbeats = twoTurns.replace(/\n/g, '\n{"$eve":"heartbeat"}\n');
    assert.deepEqual(
      mapEveStream(withHeartbeats, { sessionId: ROOT_A }).map((e) => e.id),
      events.map((e) => e.id),
    );
  });

  it("resumes from its cursor", () => {
    const lines = parseEveStream(twoTurns);
    const m = new EveStreamMapper({ sessionId: ROOT_A });
    const first = lines.slice(0, 10).flatMap((l) => m.push(l));
    assert.equal(m.position, 10);
    const rest = lines.slice(m.position).flatMap((l) => m.push(l));
    assert.deepEqual(
      [...first, ...rest].map((e) => e.id),
      events.map((e) => e.id),
    );
    assert.equal(m.replies.get("turn_1"), "London: Rain, 14°C. Outlook: showers easing by evening.");
  });

  it("links a child stream to its parent", () => {
    const child = mapEveStream('{"at":"2026-01-01T00:00:00.000Z","facts":[{"type":"session.started","data":{"runtime":{"agentName":"forecaster","eveVersion":"1.0.0-rc.6"}}}]}', {
      sessionId: CHILD_A0,
      parentSessionId: ROOT_A,
      subagentId: "call-1",
      subagentType: "forecaster",
    });
    assert.deepEqual(buildSession(child).parent, { sessionId: ROOT_A, subagentId: "call-1", type: "forecaster" });
  });
});
