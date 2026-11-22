// Regression from round-7 hands-on QA of worktrees: session_get, session_current and
// sessions_list gave a linked worktree's session only its worktree root as repo, with
// no repoMain, while show --json and sessions --json name the main checkout.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { cleanup, makeWorld, type World } from "./helpers.ts";

type Obj = Record<string, unknown>;
type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Obj };

const WT = "r7rm-worktree";
const MAIN = "r7rm-main";

let w: World;
let wt: string;
let mcp: CodingShMcp;

let n = 0;
function events(sessionId: string, cwd: string, repo: AgentEvent["repo"], t0: number): AgentEvent[] {
  const ev = (ts: number, kind: AgentEvent["kind"], payload: Obj = {}): AgentEvent => {
    const e: AgentEvent = { id: `${sessionId}-${n++}`, v: 0, sessionId, agent: "claude-code", ts, kind, payload, cwd };
    if (kind === "session.start") e.repo = repo;
    return e;
  };
  return [ev(t0, "session.start"), ev(t0 + 1, "user.message", { text: "list the files" }), ev(t0 + 2, "assistant.message", { text: "done" }), ev(t0 + 3, "session.end", { reason: "exit" })];
}

async function call(name: string, args: Obj = {}): Promise<Obj> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const res = r!.result as Result;
  assert.notEqual(res.isError, true, `${name}: ${res.content[0]?.text.slice(0, 300)}`);
  return res.structuredContent!;
}

before(async () => {
  w = makeWorld();
  wt = join(w.root, "repos", "parser-wt");
  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    const a = events(WT, wt, { root: wt, head: "", branch: "feature", main: w.repo }, w.now - 60e3);
    const b = events(MAIN, w.repo, { root: w.repo, head: "", branch: "main" }, w.now - 120e3);
    await ctx.index.putEvents([...a, ...b]);
    await ctx.index.upsertSession(buildSession(a));
    await ctx.index.upsertSession(buildSession(b));
  } finally {
    await ctx.close();
  }
  mcp = createCodingShMcp({ env: w.env, cwd: w.repo, log: () => {}, now: () => w.now });
});

after(async () => {
  await mcp?.close();
  cleanup();
});

describe("a linked worktree's session over MCP names its main checkout", () => {
  it("session_get gives repoMain", async () => {
    const s = (await call("session_get", { sessionId: WT })).session as Obj;
    assert.equal(s.repo, wt);
    assert.equal(s.repoMain, w.repo);
  });

  it("session_current gives repoMain", async () => {
    const s = (await call("session_current", { cwd: wt })).session as Obj;
    assert.equal(s.id, WT);
    assert.equal(s.repoMain, w.repo);
  });

  it("sessions_list gives repoMain for the worktree's session only", async () => {
    const rows = (await call("sessions_list", {})).sessions as Obj[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(WT)?.repoMain, w.repo, JSON.stringify(rows).slice(0, 800));
    assert.ok(byId.has(MAIN), "the main checkout's session is listed");
    assert.equal(byId.get(MAIN)!.repoMain, undefined, "absent outside a worktree");
  });

  it("the session resource's markdown names the main checkout", async () => {
    const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: `codingsh://session/${WT}` } });
    const text = ((r!.result as Obj).contents as { text: string }[])[0]!.text;
    assert.ok(text.includes(`a worktree of ${w.repo}`), text.slice(0, 400));
  });
});
