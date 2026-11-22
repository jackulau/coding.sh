// A sink's `since`: a session that started before it is never sent, including its later events;
// openSink applies it to any sink kind, built-in or registered.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import type { OpenSession, Sink, SinkAck } from "../../src/core/types.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { sinceSink } from "../../src/sinks/since.ts";
import { openSink, registerSink } from "../../src/store/factory.ts";
import { MemoryBlobStore } from "../../src/store/memory.ts";

const SINCE = 1_800_000_000_000;
const blobs = new MemoryBlobStore();
const ev = (sessionId: string, ts: number): AgentEvent => ({ id: `${sessionId}@${ts}`, v: 0, sessionId, ts, agent: "claude-code", kind: "notification", payload: {} });
const row = (id: string, startedAt: number): Session => ({ id, agent: "claude-code", startedAt, stats: { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] });

/** A sink that records what reached it, and acks with `ack`. */
function recorder(ack: SinkAck = { ok: true }) {
  const got: { events: string[]; sessions: string[]; open: string[] } = { events: [], sessions: [], open: [] };
  const sink: Sink = {
    name: "team",
    mode: "metadata",
    write: async (batch, sessions) => {
      got.events.push(...batch.map((e) => e.id));
      got.sessions.push(...sessions.map((s) => s.id));
      return ack;
    },
    writeOpenSessions: async (open: OpenSession[]) => {
      got.open.push(...open.map((o) => o.session.id));
      return { ok: true };
    },
  };
  return { sink, got };
}

describe("sinceSink", () => {
  test("sends a session that started at or after since, and none of one that started before", async () => {
    const { sink, got } = recorder();
    const s = sinceSink(sink, SINCE);
    assert.equal(s.name, "team");
    assert.equal(s.mode, "metadata");
    // "old" started before since and goes on after it; "new" started after.
    const ack = await s.write([ev("old", SINCE - 5), ev("old", SINCE + 5), ev("new", SINCE), ev("new", SINCE + 1)], [row("old", SINCE - 5), row("new", SINCE)], blobs);
    assert.deepEqual(ack, { ok: true, skipped: 2 });
    assert.deepEqual(got, { events: [`new@${SINCE}`, `new@${SINCE + 1}`], sessions: ["new"], open: [] });
  });

  test("decides by the row when there is one, and by the earliest event without one", async () => {
    const { sink, got } = recorder();
    const s = sinceSink(sink, SINCE);
    // A row that started before since keeps out an event after it.
    assert.deepEqual(await s.write([ev("a", SINCE + 9)], [row("a", SINCE - 1)], blobs), { ok: true, skipped: 1 });
    // No row: the batch's earliest event decides, for every event of that session.
    assert.deepEqual(await s.write([ev("b", SINCE + 9), ev("b", SINCE - 1)], [], blobs), { ok: true, skipped: 2 });
    // A later batch of "b" with no row and only newer events stays out too.
    assert.deepEqual(await s.write([ev("b", SINCE + 20)], [], blobs), { ok: true, skipped: 1 });
    assert.deepEqual(got.events, [], "nothing reached the sink");
    assert.deepEqual(await s.write([ev("c", SINCE + 1)], [], blobs), { ok: true });
    assert.deepEqual(got.events, [`c@${SINCE + 1}`]);
  });

  test("a failed write is returned as it is, and rows alone are filtered too", async () => {
    const failing = recorder({ ok: false, error: "down", retryAfterMs: 5 });
    const s = sinceSink(failing.sink, SINCE);
    assert.deepEqual(await s.write([ev("old", SINCE - 1), ev("new", SINCE + 1)], [], blobs), { ok: false, error: "down", retryAfterMs: 5 });
    const { sink, got } = recorder();
    const r = sinceSink(sink, SINCE);
    assert.deepEqual(await r.write([], [row("old", SINCE - 1)], blobs), { ok: true });
    assert.deepEqual(await r.write([], [row("old", SINCE - 1), row("new", SINCE + 1)], blobs), { ok: true });
    assert.deepEqual(got.sessions, ["new"]);
  });

  test("open sessions that started before since are not sent", async () => {
    const { sink, got } = recorder();
    const s = sinceSink(sink, SINCE);
    assert.deepEqual(await s.writeOpenSessions!([{ session: row("old", SINCE - 1), lastEventAt: SINCE + 1 }], blobs), { ok: true });
    await s.writeOpenSessions!([{ session: row("old", SINCE - 1), lastEventAt: SINCE + 1 }, { session: row("new", SINCE + 1), lastEventAt: SINCE + 2 }], blobs);
    assert.deepEqual(got.open, ["new"]);
    // A sink without writeOpenSessions keeps none.
    assert.equal(sinceSink({ name: "x", mode: "full", write: async () => ({ ok: true }) }, SINCE).writeOpenSessions, undefined);
  });
});

describe("openSink", () => {
  test("applies since to any sink kind, and leaves a sink without it as it is", async () => {
    const { sink, got } = recorder();
    registerSink("since-test", () => sink);
    const config = defaultConfig({ CODING_SH_HOME: "/nowhere" });
    assert.equal(await openSink({ kind: "since-test", endpoint: "x", mode: "metadata" }, config), sink);
    const wrapped = await openSink({ kind: "since-test", endpoint: "x", mode: "metadata", since: SINCE }, config);
    assert.notEqual(wrapped, sink);
    await wrapped.write([ev("old", SINCE - 1), ev("new", SINCE + 1)], [], blobs);
    assert.deepEqual(got.events, [`new@${SINCE + 1}`]);
  });
});
