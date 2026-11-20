// Regressions from round-4 QA of the MCP server: sessions_list's where that names
// subagents (is:child, parent:, id:) came back empty without includeSubagents, and
// on Windows cwd and repo matching counted case and slash direction.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { pathKey, pathUnder } from "../../src/mcp/data.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { cleanup, makeWorld, type World } from "./helpers.ts";

const H = 3600e3;
const WIN = process.platform === "win32";
let n = 0;
function ev(sessionId: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown> = {}, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `${sessionId}-r4-${n++}`, v: 0, sessionId, agent: "claude-code", ts, kind, payload, source: "transcript", ...extra };
}

let w: World;
let mcp: CodingShMcp;
const PARENT = "r4-parent";
const CHILD = `${PARENT}:sub:a1b2c3`;
const SLASHED = "r4-slashed";
/** w.repo as a VS Code-based agent reports it on Windows: lower-case drive, forward slashes. */
let slashedRepo: string;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r!.result as { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] };
}

const ids = (r: Awaited<ReturnType<typeof call>>) => {
  assert.notEqual(r.isError, true, r.content?.[0]?.text);
  return (r.structuredContent.sessions as { id: string }[]).map((s) => s.id);
};

before(async () => {
  w = makeWorld();
  slashedRepo = w.repo.replace(/\\/g, "/").replace(/^[A-Z]:/, (d) => d.toLowerCase());
  const now = w.now;
  const sessions: AgentEvent[][] = [
    [ev(PARENT, now - 3 * H, "session.start", {}, { cwd: w.root }), ev(PARENT, now - 3 * H + 1, "user.message", { text: "fan out" }), ev(PARENT, now - 3 * H + 2, "turn.end")],
    [ev(CHILD, now - 3 * H + 10, "user.message", { text: "look around" }, { cwd: w.root }), ev(CHILD, now - 3 * H + 20, "turn.end")],
    [ev(SLASHED, now - 2 * H, "session.start", {}, { cwd: slashedRepo }), ev(SLASHED, now - 2 * H + 1, "user.message", { text: "fix the parser" }), ev(SLASHED, now - 2 * H + 2, "turn.end")],
  ];
  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    for (const evs of sessions) {
      await ctx.index.putEvents(evs);
      await ctx.index.upsertSession(buildSession(evs));
    }
  } finally {
    await ctx.close();
  }
  mcp = createCodingShMcp({ env: w.env, cwd: w.repo, log: () => {}, now: () => w.now });
});

after(async () => {
  await mcp?.close();
  cleanup();
});

describe("sessions_list where that names subagents", () => {
  it("is:child, parent: and id: of a child list it without includeSubagents, as the CLI's --where does", async () => {
    assert.deepEqual(ids(await call("sessions_list", { where: "is:child" })), [CHILD]);
    assert.deepEqual(ids(await call("sessions_list", { where: `parent:${PARENT}` })), [CHILD]);
    assert.deepEqual(ids(await call("sessions_list", { where: `id:${CHILD}` })), [CHILD]);
  });

  it("a where that names none still lists top-level sessions only", async () => {
    const got = ids(await call("sessions_list", { where: "agent:claude-code" }));
    assert.ok(got.includes(PARENT));
    assert.ok(!got.includes(CHILD), "no subagent without includeSubagents");
    assert.ok(!ids(await call("sessions_list", { where: `-id:${CHILD}` })).includes(CHILD));
  });
});

describe("path matching on Windows", () => {
  it("pathKey and pathUnder ignore case and slash direction on win32 only", () => {
    assert.equal(pathKey("c:/Projects/Rodev", "win32"), pathKey("C:\\Projects\\rodev", "win32"));
    assert.ok(pathUnder("D:/cs/sg/qa/mcp", "d:\\CS\\sg", "win32"));
    assert.ok(pathUnder("C:\\Projects\\rodev", "c:/projects/rodev/", "win32"));
    assert.ok(!pathUnder("C:\\Projects\\rodev2", "c:/projects/rodev", "win32"), "a sibling with the same prefix is not inside");
    assert.ok(!pathUnder("/Work/demo", "/work/demo", "linux"), "case counts off Windows");
    assert.ok(pathUnder("/work/demo/src", "/work/demo", "linux"));
  });

  it("session_current finds a session stored with a lower-case, forward-slash cwd from the server's own cwd", { skip: !WIN && "Windows paths" }, async () => {
    const def = await call("session_current", { limit: 1 });
    assert.notEqual(def.isError, true, def.content?.[0]?.text);
    assert.equal((def.structuredContent.session as { id: string }).id, SLASHED);
    const upper = await call("session_current", { cwd: w.repo.toUpperCase(), limit: 1 });
    assert.notEqual(upper.isError, true, upper.content?.[0]?.text);
    assert.equal((upper.structuredContent.session as { id: string }).id, SLASHED);
  });

  it("the repo filter ignores case and slash direction", { skip: !WIN && "Windows paths" }, async () => {
    assert.deepEqual(ids(await call("sessions_list", { repo: w.repo })), [SLASHED]);
    assert.deepEqual(ids(await call("sessions_list", { repo: w.repo.toLowerCase() })), [SLASHED]);
    assert.deepEqual(ids(await call("sessions_list", { repo: "PARSER" })), [SLASHED]);
  });
});
