// resources/list pages with a keyset cursor: sessions ingested or deleted
// between pages never repeat or skip an entry (VWR-8).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "../../src/core/context.ts";
import { buildResources, LATEST_URI } from "../../src/mcp/resources.ts";
import { RpcFailure } from "../../src/mcp/protocol.ts";
import type { Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";

const T = 1_700_000_000_000;
const session = (id: string, startedAt: number): Session => ({ id, agent: "claude-code", startedAt, title: id }) as Session;
const ids = (r: { resources: { uri: string; name: string }[] }) => r.resources.filter((x) => x.uri !== LATEST_URI).map((x) => x.name);

async function world(n: number) {
  const index = new MemoryIndexStore();
  // Two sessions share each millisecond so the id tie-break is exercised.
  for (let i = 0; i < n; i++) await index.upsertSession(session(`s${String(i).padStart(3, "0")}`, T + Math.floor(i / 2)));
  return { index, res: buildResources(async () => ({ index }) as unknown as Context) };
}

describe("MCP resources/list cursor", () => {
  it("never repeats a session when newer sessions are ingested between pages", async () => {
    const { index, res } = await world(45);
    const before = (await index.listSessions({ parentSessionId: null })).map((s) => s.id);
    const p1 = await res.list(undefined);
    for (let i = 0; i < 5; i++) await index.upsertSession(session(`new${i}`, T + 1000 + i)); // store() ingests before every read
    const p2 = await res.list(p1.nextCursor);
    const p3 = await res.list(p2.nextCursor);
    assert.equal(p3.nextCursor, undefined);
    const seen = [...ids(p1), ...ids(p2), ...ids(p3)];
    assert.equal(new Set(seen).size, seen.length, `duplicates: ${seen.filter((x, i) => seen.indexOf(x) !== i)}`);
    assert.deepEqual(seen, before, "every session listed once, in order");
  });

  it("never skips a session when a listed session is deleted between pages", async () => {
    const { index, res } = await world(45);
    const before = (await index.listSessions({ parentSessionId: null })).map((s) => s.id);
    const p1 = await res.list(undefined);
    // Retention or a user delete removes a session already shown on page 1.
    const sessions = (index as unknown as { sessions: Map<string, Session> }).sessions;
    sessions.delete(ids(p1)[0]!);
    const p2 = await res.list(p1.nextCursor);
    const p3 = await res.list(p2.nextCursor);
    const rest = [...ids(p2), ...ids(p3)];
    const expected = before.slice(20).filter((id) => sessions.has(id));
    assert.deepEqual(rest, expected, "no gap after page 1");
  });

  it("rejects a cursor it did not issue with invalid params", async () => {
    const { res } = await world(3);
    await assert.rejects(res.list("20"), (e: unknown) => e instanceof RpcFailure && e.code === -32602);
    await assert.rejects(res.list("not base64 !"), (e: unknown) => e instanceof RpcFailure && e.code === -32602);
  });
});
