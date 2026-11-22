// Regressions from round-4 QA of the MCP server against a real backfilled
// store: search filtered and labeled hits by the event's agent, so a Claude
// Code session hosted by T3 Code (session agent t3code, events claude-code)
// was missed by agent "t3code" and its hits said claude-code.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { Session } from "../../src/core/types.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { schemaViolations } from "../../src/toolevals/jsonschema.ts";
import { cleanup, makeWorld, type World } from "./helpers.ts";

const H = 3600e3;
let n = 0;
function ev(sessionId: string, agent: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown> = {}): AgentEvent {
  return { id: `${sessionId}-r4${n++}`, v: 0, sessionId, agent, ts, kind, payload, source: "transcript" };
}

let w: World;
let mcp: CodingShMcp;
let tools: { name: string; outputSchema: Record<string, unknown> }[];
const IDS = { t3: "r4-t3-hosted", cc: "r4-claude", cx: "r4-codex" };
/** The shortId a search hit gives beside its session's full id: the shortest id that resolves, at least 8 characters (core/session-ref.ts). */
const HIT = { t3: "r4-t3-ho", cc: "r4-claud", cx: "r4-codex" };

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const res = r!.result as { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] };
  assert.notEqual(res.isError, true, `${name}: ${res.content?.[0]?.text}`);
  const sc = JSON.parse(JSON.stringify(res.structuredContent)) as Record<string, unknown>;
  assert.deepEqual(schemaViolations(sc, tools.find((t) => t.name === name)!.outputSchema), [], `${name} output matches its outputSchema`);
  return sc;
}

type Hit = { sessionId: string; shortId: string; agent: string };
const hitsOf = (r: Record<string, unknown>) => r.hits as Hit[];

before(async () => {
  w = makeWorld();
  const now = w.now;
  const session = (id: string, eventAgent: string, t0: number, sessionAgent?: string): { evs: AgentEvent[]; s: Session } => {
    const evs = [
      ev(id, eventAgent, t0, "session.start"),
      ev(id, eventAgent, t0 + 1, "user.message", { text: "make a worktree for the fix" }),
      ev(id, eventAgent, t0 + 2, "assistant.message", { text: "created the worktree" }),
      ev(id, eventAgent, t0 + 3, "turn.end"),
    ];
    const s = buildSession(evs);
    return { evs, s: sessionAgent ? { ...s, agent: sessionAgent } : s };
  };
  // T3 Code hosts Claude Code: the session is t3code, its transcript events carry claude-code.
  const all = [session(IDS.t3, "claude-code", now - H, "t3code"), session(IDS.cc, "claude-code", now - 2 * H), session(IDS.cx, "codex", now - 3 * H)];
  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    for (const { evs, s } of all) {
      await ctx.index.putEvents(evs);
      await ctx.index.upsertSession(s);
    }
  } finally {
    await ctx.close();
  }
  mcp = createCodingShMcp({ env: w.env, cwd: w.root, log: () => {}, now: () => w.now });
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 0, method: "tools/list" });
  tools = (r!.result as { tools: typeof tools }).tools;
});

after(async () => {
  await mcp?.close();
  cleanup();
});

describe("search picks and labels hits by the session's agent", () => {
  it("agent t3code finds the T3 Code session's hits, labeled t3code", async () => {
    const hits = hitsOf(await call("search", { query: "worktree", agent: "t3code" }));
    assert.ok(hits.length > 0, "the t3code session matches");
    // The full id, as an agent keeps and compares it; shortId beside it resolves too.
    assert.deepEqual([...new Set(hits.map((h) => h.sessionId))], [IDS.t3]);
    assert.deepEqual([...new Set(hits.map((h) => h.shortId))], [HIT.t3]);
    assert.deepEqual([...new Set(hits.map((h) => h.agent))], ["t3code"]);
  });

  it("agent claude-code leaves out the T3 Code session, as sessions_list does", async () => {
    const hits = hitsOf(await call("search", { query: "worktree", agent: "claude-code" }));
    assert.deepEqual([...new Set(hits.map((h) => h.sessionId))], [IDS.cc]);
    const listed = (await call("sessions_list", { agent: "claude-code", since: "30d" })).sessions as { id: string }[];
    assert.deepEqual(listed.map((s) => s.id), [IDS.cc]);
  });

  it("agent and where combine, and where agent: hits carry the session's agent", async () => {
    const both = hitsOf(await call("search", { query: "worktree", agent: "t3code", where: "kind:assistant.message" }));
    assert.deepEqual(both.map((h) => [h.sessionId, h.shortId, h.agent]), [[IDS.t3, HIT.t3, "t3code"]]);
    const viaWhere = hitsOf(await call("search", { query: "worktree", where: "agent:t3code" }));
    assert.ok(viaWhere.length > 0);
    assert.deepEqual([...new Set(viaWhere.map((h) => h.agent))], ["t3code"]);
  });

  it("unfiltered hits carry each session's agent", async () => {
    const hits = hitsOf(await call("search", { query: "worktree", limit: 50 }));
    const bySession = new Map(hits.map((h) => [h.sessionId, h.agent]));
    assert.deepEqual(Object.fromEntries(bySession), { [IDS.t3]: "t3code", [IDS.cc]: "claude-code", [IDS.cx]: "codex" });
  });
});
