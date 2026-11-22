// Regressions from round-6 QA of the MCP server: codingsh://latest listed but
// not readable on an empty store, session_get taking turn 0 as the whole
// session, and the markdown digest saying "1 turns".
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { cleanup, makeWorld, type World } from "./helpers.ts";

let n = 0;
function ev(sessionId: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown> = {}): AgentEvent {
  return { id: `${sessionId}-r6-${n++}`, v: 0, sessionId, agent: "claude-code", ts, kind, payload, source: "transcript" };
}

const ONE = "r6-one-turn";
let empty: CodingShMcp;
let full: CodingShMcp;

async function read(mcp: CodingShMcp, uri: string) {
  return (await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri } }))!;
}
async function tool(mcp: CodingShMcp, name: string, args: Record<string, unknown>) {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r!.result as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, unknown> };
}

before(async () => {
  const we: World = makeWorld();
  empty = createCodingShMcp({ env: we.env, cwd: we.root, log: () => {}, now: () => we.now });
  const w: World = makeWorld();
  const t0 = w.now - 60_000;
  const evs = [ev(ONE, t0, "session.start"), ev(ONE, t0 + 1, "user.message", { text: "hello" }), ev(ONE, t0 + 2, "turn.end", {})];
  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    await ctx.index.putEvents(evs);
    await ctx.index.upsertSession(buildSession(evs));
  } finally {
    await ctx.close();
  }
  full = createCodingShMcp({ env: w.env, cwd: w.root, log: () => {}, now: () => w.now });
});

after(async () => {
  await empty?.close();
  await full?.close();
  cleanup();
});

describe("codingsh://latest on an empty store", () => {
  it("is listed and reads as an empty state that names the next step", async () => {
    const list = (await empty.server.handle({ jsonrpc: "2.0", id: 1, method: "resources/list" }))!.result as { resources: { uri: string }[] };
    assert.ok(list.resources.some((r) => r.uri === "codingsh://latest"), "listed");
    const r = await read(empty, "codingsh://latest");
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    const text = (r.result as { contents: { text: string; mimeType: string }[] }).contents[0]!;
    assert.equal(text.mimeType, "text/markdown");
    assert.match(text.text, /No sessions captured yet/);
    // The world's env sets no MSYSTEM or SHELL: on Windows that is PowerShell or cmd, which run codingsh.
    assert.match(text.text, process.platform === "win32" ? /`codingsh init`/ : /`coding\.sh init`/);
  });

  it("still answers not found for a session id that does not exist", async () => {
    const r = await read(empty, "codingsh://session/nope");
    assert.equal(r.error?.code, -32002);
  });
});

describe("session_get turn", () => {
  it("refuses turn 0 instead of returning the whole session", async () => {
    const r = await tool(full, "session_get", { sessionId: "latest", turn: 0 });
    assert.equal(r.isError, true);
    assert.match(r.content[0]!.text, /turn must be 1\.\.N/);
  });

  it("still opens turn 1 and -1, and refuses a turn past the end", async () => {
    assert.equal((await tool(full, "session_get", { sessionId: "latest", turn: 1 })).structuredContent?.turn, 1);
    assert.equal((await tool(full, "session_get", { sessionId: "latest", turn: -1 })).structuredContent?.turn, 1);
    assert.equal((await tool(full, "session_get", { sessionId: "latest", turn: 2 })).isError, true);
  });
});

describe("markdown digest counts", () => {
  it("says 1 turn, not 1 turns", async () => {
    const r = await read(full, "codingsh://latest");
    const text = (r.result as { contents: { text: string }[] }).contents[0]!.text;
    assert.match(text, /\*\*Activity:\*\* 1 turn, 0 tool calls, 0 files changed/);
  });
});
