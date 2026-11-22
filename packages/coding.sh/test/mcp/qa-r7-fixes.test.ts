// Regressions from round-7 hands-on QA of the MCP server: session_get read the
// whole session again for every row count it tried while fitting a page to the
// answer limit; harness_changes with a missing repo path answered "no commits
// changed AGENTS.md"; exp_session_summary with an unknown id answered an empty
// timeline; eval_from_session asked for confirmation before it checked the
// session; and since equal to until was met with "Swap them".
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openContext, type Context } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import { buildTools, CHARACTER_LIMIT, type ToolCtx } from "../../src/mcp/tools.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { cleanup, makeWorld, seed, SEED, type World } from "./helpers.ts";

type Obj = Record<string, unknown>;
type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Obj };

const LONG = "r7f-long";
const ROUNDS = 300;

let w: World;
let mcp: CodingShMcp;

let n = 0;
function ev(sessionId: string, ts: number, kind: AgentEvent["kind"], payload: Obj = {}): AgentEvent {
  return { id: `${sessionId}-r7f-${n++}`, v: 0, sessionId, agent: "claude-code", ts, kind, payload, cwd: w.repo };
}

async function call(name: string, args: Obj = {}): Promise<Result> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r!.result as Result;
}

async function error(name: string, args: Obj): Promise<string> {
  const r = await call(name, args);
  assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} is an error: ${r.content[0]?.text.slice(0, 300)}`);
  return r.content[0]!.text;
}

before(async () => {
  w = makeWorld();
  await seed(w);
  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    // More rows than one answer holds: a page of 200 has to shrink.
    const t0 = w.now - 3 * 3600e3;
    const long: AgentEvent[] = [ev(LONG, t0, "session.start")];
    for (let i = 0; i < ROUNDS; i++) {
      long.push(ev(LONG, t0 + i * 100 + 1, "user.message", { text: `step ${i} `.padEnd(160, "x") }));
      long.push(ev(LONG, t0 + i * 100 + 50, "assistant.message", { text: `reply ${i} `.padEnd(160, "y") }));
    }
    long.push(ev(LONG, t0 + ROUNDS * 100 + 10, "session.end", { reason: "exit" }));
    await ctx.index.putEvents(long);
    await ctx.index.upsertSession(buildSession(long));
  } finally {
    await ctx.close();
  }
  mcp = createCodingShMcp({ env: w.env, cwd: w.repo, log: () => {}, now: () => w.now });
});

after(async () => {
  await mcp?.close();
  cleanup();
});

describe("session_get fitted to the answer limit", () => {
  // The tool as the server runs it, on a store whose event reads are counted.
  async function reads(args: Obj): Promise<{ page: Obj; reads: number }> {
    const ctx: Context = await openContext({ env: w.env, cwd: w.root });
    try {
      let count = 0;
      const listEvents = ctx.index.listEvents.bind(ctx.index);
      ctx.index.listEvents = ((...a: Parameters<typeof listEvents>) => {
        count++;
        return listEvents(...a);
      }) as typeof listEvents;
      const tool = buildTools().find((t) => t.name === "session_get")!;
      const c: ToolCtx = { env: w.env, cwd: w.repo, now: () => w.now, store: async () => ctx };
      const page = await tool.run(args, c);
      return { page, reads: count };
    } finally {
      await ctx.close();
    }
  }

  for (const args of [{ limit: 200 }, { limit: 200, cursor: "100" }, { tail: true, limit: 200 }, { tail: true, limit: 200, cursor: "500" }]) {
    it(`reads the session once for a page that shrinks: ${JSON.stringify(args)}`, async () => {
      const fit = await reads({ sessionId: LONG, limit: 20, tail: "tail" in args });
      assert.equal(fit.page.limitUsed, undefined, "a page of 20 fits");
      const shrunk = await reads({ sessionId: LONG, ...args });
      const used = shrunk.page.limitUsed as number;
      assert.ok(used > 1 && used < 200, `the page shrank: limitUsed ${used}`);
      assert.equal((shrunk.page.timeline as unknown[]).length, used);
      assert.ok(JSON.stringify(shrunk.page).length <= CHARACTER_LIMIT);
      assert.equal(shrunk.reads, fit.reads, "as many event reads as a page that fits");
    });
  }

  it("a shrunk page's nextCursor starts at the first row left out", async () => {
    const page = (await call("session_get", { sessionId: LONG, limit: 200, cursor: "100" })).structuredContent!;
    const used = page.limitUsed as number;
    assert.equal(page.nextCursor, String(100 + used));
    const next = (await call("session_get", { sessionId: LONG, limit: 1, cursor: page.nextCursor })).structuredContent!;
    const all = (await call("session_get", { sessionId: LONG, limit: 1, cursor: String(100 + used) })).structuredContent!;
    assert.deepEqual(next.timeline, all.timeline);
    // The last page has no nextCursor.
    const total = page.timelineTotal as number;
    const last = (await call("session_get", { sessionId: LONG, limit: 5, cursor: String(total - 3) })).structuredContent!;
    assert.equal((last.timeline as unknown[]).length, 3);
    assert.equal(last.nextCursor, undefined);
  });
});

describe("harness_changes with a repo that has no git history", () => {
  it("says the path does not exist", async () => {
    const missing = join(w.root, "no", "such", "repo");
    const text = await error("harness_changes", { repo: missing });
    assert.match(text, /does not exist/);
    assert.match(text, /folder name/);
    assert.doesNotMatch(text, /No commits changed/);
  });

  it("says a folder outside git is not in a git repo", async () => {
    const text = await error("harness_changes", { repo: join(w.root, "repos", "docs") });
    assert.match(text, /is not in a git repo/);
  });
});

describe("exp_session_summary with an unknown session", () => {
  it("is a not-found error that says how to start one", async () => {
    const text = await error("exp_session_summary", { session: "nope" });
    assert.match(text, /^No experiment session with id "nope"\./);
    assert.match(text, /coding\.sh exp session new --name <topic>/);
  });

  it("a session with a timeline still answers", async () => {
    const dir = join(w.env.CODING_SH_HOME!, "exp-sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "xs_known.jsonl"), `${JSON.stringify({ kind: "note", at: w.now, text: "hypothesis" })}\n`);
    const r = await call("exp_session_summary", { session: "xs_known" });
    assert.notEqual(r.isError, true, r.content[0]?.text);
    assert.equal(r.structuredContent!.total, 1);
  });

  it("the project's own session answers while its timeline is still empty", async () => {
    const proj = join(w.root, "proj");
    mkdirSync(join(proj, ".coding-sh"), { recursive: true });
    writeFileSync(join(proj, ".coding-sh", "session.json"), JSON.stringify({ id: "xs_fresh", createdAt: w.now }));
    const s = createCodingShMcp({ env: w.env, cwd: proj, log: () => {}, now: () => w.now });
    try {
      for (const args of [{}, { session: "xs_fresh" }]) {
        const r = (await s.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "exp_session_summary", arguments: args } }))!.result as Result;
        assert.notEqual(r.isError, true, r.content[0]?.text);
        assert.equal(r.structuredContent!.total, 0);
      }
    } finally {
      await s.close();
    }
  });
});

describe("eval_from_session with a missing session", () => {
  it("says the session does not exist before it asks for confirmation", async () => {
    const text = await error("eval_from_session", { sessionId: "nope", confirm: false });
    assert.match(text, /No session/);
    assert.match(text, /"nope"/);
    assert.doesNotMatch(text, /confirm/);
  });

  it("an existing session without confirm still asks the user", async () => {
    assert.match(await error("eval_from_session", { sessionId: SEED.a, confirm: false }), /confirm: true/);
  });
});

describe("since equal to until", () => {
  it("says the window is empty, without advising a swap", async () => {
    const t = "2026-11-20T10:00:00Z";
    const text = await error("sessions_list", { since: t, until: t });
    assert.match(text, /^since must be before until: /);
    assert.match(text, /The window is empty: make until later than since/);
    assert.doesNotMatch(text, /Swap/);
  });

  it("since after until still says to swap them", async () => {
    assert.match(await error("sessions_list", { since: "1d", until: "7d" }), /Swap them/);
  });
});
