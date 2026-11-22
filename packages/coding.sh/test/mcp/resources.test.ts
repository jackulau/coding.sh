// resources/list pages with a keyset cursor: sessions ingested or deleted
// between pages never repeat or skip an entry (VWR-8). resources/read takes
// the session ids the tools take, and a URI that names nothing stays not found.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context } from "../../src/core/context.ts";
import { buildResources, LATEST_URI, sessionUri } from "../../src/mcp/resources.ts";
import { McpServer, RpcFailure } from "../../src/mcp/protocol.ts";
import type { Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { mkSession } from "../cli/_cmd.ts";

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

describe("MCP resources/read takes the session ids the tools take", () => {
  // Two sessions share their first 8 characters, as in short-ids.test.ts.
  const TWIN_A = "7c3e9d10-aaaa-4000-8000-000000000001";
  const TWIN_B = "7c3e9d10-bbbb-4000-8000-000000000002";
  const PARSER = "36d2966a-1c53-47f1-891d-aae1827d0e95";
  const META = "io.modelcontextprotocol/";
  const modernMeta = { [`${META}protocolVersion`]: "2026-07-28", [`${META}clientCapabilities`]: {} };

  async function server(): Promise<McpServer<unknown>> {
    const index = new MemoryIndexStore();
    await index.upsertSession(mkSession(TWIN_A, T, { title: "first twin" }));
    await index.upsertSession(mkSession(TWIN_B, T + 1000, { title: "second twin" }));
    await index.upsertSession(mkSession(PARSER, T + 2000, { agent: "codex", title: "Fix the parser" }));
    const resources = buildResources(async () => ({ index }) as unknown as Context);
    return new McpServer({ serverInfo: { name: "t", version: "0" }, instructions: () => "", tools: [], resources, context: () => ({}) });
  }
  /** resources/read in the legacy era (no _meta) or the modern one. */
  async function read(s: McpServer<unknown>, uri: string, modern = false) {
    const r = await s.handle({ jsonrpc: "2.0", id: 1, method: "resources/read", params: modern ? { uri, _meta: modernMeta } : { uri } });
    return r as { result?: { contents: { uri: string; mimeType: string; text: string }[] }; error?: { code: number; message: string; data?: any } };
  }

  it("reads a session by a unique prefix of its id, and codingsh://session/latest as the tools' latest", async () => {
    const s = await server();
    for (const [id, title] of [
      [PARSER.slice(0, 4), "Fix the parser"],
      ["7c3e9d10-a", "first twin"],
      ["latest", "Fix the parser"],
    ]) {
      for (const modern of [false, true]) {
        const uri = sessionUri(id!);
        const r = await read(s, uri, modern);
        assert.equal(r.error, undefined, `${uri}: ${JSON.stringify(r.error)}`);
        const c = r.result!.contents[0]!;
        assert.equal(c.uri, uri, "the URI asked for");
        assert.equal(c.mimeType, "text/markdown");
        assert.match(c.text, new RegExp(`^# ${title}\n`), uri);
      }
    }
  });

  it("an ambiguous prefix fails with invalid params in both eras, listing each session as the tools do", async () => {
    const s = await server();
    const uri = sessionUri(TWIN_A.slice(0, 8));
    for (const modern of [false, true]) {
      const r = await read(s, uri, modern);
      assert.equal(r.error?.code, -32602, JSON.stringify(r));
      assert.match(r.error!.message, /^Session id prefix "7c3e9d10" matches more than one session: 7c3e9d10-b \(claude-code, [^)]*, "second twin"\); 7c3e9d10-a \(claude-code, [^)]*, "first twin"\)\. Pass one of these ids, or more of the id\.$/);
      const data = r.error!.data;
      assert.equal(data.uri, uri);
      assert.equal(data.reason, "ambiguous");
      assert.deepEqual(
        data.candidates.map((c: { sessionId: string; shortId: string; uri: string; agent: string; title: string }) => [c.sessionId, c.shortId, c.uri, c.agent, c.title]),
        [
          [TWIN_B, "7c3e9d10-b", sessionUri(TWIN_B), "claude-code", "second twin"],
          [TWIN_A, "7c3e9d10-a", sessionUri(TWIN_A), "claude-code", "first twin"],
        ],
      );
      assert.equal(data.more, undefined);
    }
  });

  it("a URI that names no session stays not found: -32002 in the legacy era, -32602 in the modern one", async () => {
    const s = await server();
    // An unknown id, a prefix under 4 characters that both twins start with, and an id that only starts like one.
    for (const id of ["zzzzzzzz", "7c3", `${PARSER}-nope`]) {
      const uri = sessionUri(id);
      const legacy = await read(s, uri);
      assert.equal(legacy.error?.code, -32002, uri);
      assert.equal(legacy.error?.message, `Resource not found: ${uri}`);
      const modern = await read(s, uri, true);
      assert.equal(modern.error?.code, -32602, uri);
      assert.equal(modern.error?.message, `Resource not found: ${uri}`);
    }
  });
});
