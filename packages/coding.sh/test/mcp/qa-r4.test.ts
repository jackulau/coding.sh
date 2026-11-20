// Regressions from round-4 QA of the MCP server against a real backfilled store:
// search paging that repeated and skipped hits tied in rank, and session_get and
// the session resource leaving out failed model calls (stats.llmErrors).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { cleanup, makeWorld, type World } from "./helpers.ts";

const H = 3600e3;
let n = 0;
function ev(sessionId: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown> = {}): AgentEvent {
  return { id: `${sessionId}-r${n++}`, v: 0, sessionId, agent: "claude-code", ts, kind, payload, source: "transcript" };
}

let w: World;
let mcp: CodingShMcp;
const TIED = 83;
const ERR = "r4-llm-errors";

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const res = r!.result as { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] };
  assert.notEqual(res.isError, true, `${name}: ${res.content?.[0]?.text}`);
  return res.structuredContent;
}

before(async () => {
  w = makeWorld();
  const now = w.now;
  const sessions: AgentEvent[][] = [];
  // Hits with the same text rank the same; their times run in a different order than they were stored.
  for (let i = 0; i < TIED; i++) {
    const id = `r4-tied-${String(i).padStart(3, "0")}`;
    const t0 = now - 2 * H + ((i * 37) % TIED) * 1000;
    sessions.push([ev(id, t0, "session.start"), ev(id, t0 + 1, "user.message", { text: "rebuild the gizmo cache" })]);
  }
  const t0 = now - H;
  sessions.push([
    ev(ERR, t0, "session.start"),
    ev(ERR, t0 + 1, "user.message", { text: "refactor the parser" }),
    ev(ERR, t0 + 2, "llm.call", { model: "claude-x", ok: false, statusCode: 400, error: "API Error: the request was refused" }),
    ev(ERR, t0 + 3, "llm.call", { model: "claude-x", ok: false, statusCode: 400, error: "API Error: the request was refused" }),
    ev(ERR, t0 + 4, "turn.end", {}),
  ]);
  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    for (const evs of sessions) {
      await ctx.index.putEvents(evs);
      await ctx.index.upsertSession(buildSession(evs));
    }
  } finally {
    await ctx.close();
  }
  mcp = createCodingShMcp({ env: w.env, cwd: w.root, log: () => {}, now: () => w.now });
});

after(async () => {
  await mcp?.close();
  cleanup();
});

describe("search paging", () => {
  it("following nextCursor returns every hit once, in the order of one long page", async () => {
    const all = ((await call("search", { query: "gizmo cache", limit: 50, cursor: "0" })).hits as { eventId: string }[]).map((h) => h.eventId);
    const ctx = await openContext({ env: w.env, cwd: w.root });
    let full: string[];
    try {
      full = (await ctx.index.search("gizmo cache", { limit: 100_000 })).map((h) => h.event.id);
    } finally {
      await ctx.close();
    }
    assert.equal(full.length, TIED);
    assert.deepEqual(all, full.slice(0, 50), "a page is a prefix of the full ranked list");
    const paged: string[] = [];
    let cursor: string | undefined;
    do {
      const args: Record<string, unknown> = { query: "gizmo cache", limit: 7 };
      if (cursor) args.cursor = cursor;
      const r = await call("search", args);
      paged.push(...(r.hits as { eventId: string }[]).map((h) => h.eventId));
      cursor = r.nextCursor as string | undefined;
    } while (cursor);
    assert.equal(new Set(paged).size, paged.length, "no hit repeats");
    assert.deepEqual(paged, full);
  });
});

describe("failed model calls", () => {
  it("session_get's summary carries stats.llmErrors", async () => {
    const d = await call("session_get", { sessionId: ERR, limit: 1 });
    const le = (d.session as { llmErrors?: { count: number; statusCode?: number; error?: string } }).llmErrors;
    assert.equal(le?.count, 2);
    assert.equal(le?.statusCode, 400);
    assert.match(le?.error ?? "", /request was refused/);
  });

  it("the session resource digest has a line for them", async () => {
    const r = await mcp.server.handle({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: `codingsh://session/${ERR}` } });
    const text = (r!.result as { contents: { text: string }[] }).contents[0]!.text;
    assert.match(text, /\*\*Model errors:\*\* 2 failed model calls, first HTTP 400: "API Error: the request was refused"/);
  });

  it("a session without failed calls has neither", async () => {
    const d = await call("session_get", { sessionId: "r4-tied-000", limit: 1 });
    assert.equal((d.session as Record<string, unknown>).llmErrors, undefined);
    const r = await mcp.server.handle({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "codingsh://session/r4-tied-000" } });
    assert.doesNotMatch((r!.result as { contents: { text: string }[] }).contents[0]!.text, /Model errors/);
  });
});
