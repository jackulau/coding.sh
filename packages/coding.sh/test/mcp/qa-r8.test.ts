// Round 8 of the MCP server: a work tool that pages the queue `coding.sh work --json` prints;
// session_current finding a delegate that runs in a worktree (a child session); sessions_list
// saying how many child sessions it leaves out; eval_candidates on a session T3 Code hosted;
// a session_get tail cursor that holds still while a session past DIGEST_EVENT_CAP grows; an
// until-only window that ends at until; and the index's age in status.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openContext, type Context } from "../../src/core/context.ts";
import { recordLastIngest } from "../../src/core/ingest-health.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { DIGEST_EVENT_CAP } from "../../src/mcp/digest.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import { buildTools, type ToolCtx } from "../../src/mcp/tools.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { cleanup, makeWorld, seed, SEED, type World } from "./helpers.ts";

type Obj = Record<string, unknown>;
type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Obj };

const DAY = 86_400e3;
/** Sessions that each leave one review item: they changed a file and ended. */
const REVIEWS = 7;
const WORKTREE_CHILD = "r8-delegate";
const SAME_DIR_CHILD = "r8-subagent";
const HOSTED = "r8-t3-hosted";

let w: World;
let mcp: CodingShMcp;
let worktree: string;

let n = 0;
function ev(sessionId: string, agent: string, ts: number, kind: AgentEvent["kind"], payload: Obj = {}, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `${sessionId}-r8-${n++}`, v: 0, sessionId, agent, ts, kind, payload, ...extra };
}

async function call(name: string, args: Obj = {}): Promise<Result> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r!.result as Result;
}

async function ok(name: string, args: Obj = {}): Promise<Obj> {
  const r = await call(name, args);
  assert.notEqual(r.isError, true, `${name} ${JSON.stringify(args)}: ${r.content[0]?.text.slice(0, 400)}`);
  return r.structuredContent!;
}

before(async () => {
  w = makeWorld();
  await seed(w);
  // A linked worktree outside the main checkout: its .git is a file naming the main repo's gitdir.
  worktree = join(w.root, "worktrees", "parser-feature");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(w.repo, ".git", "worktrees", "parser-feature")}\n`);
  const ctx = await openContext({ env: w.env, cwd: w.root });
  try {
    const put = async (evs: AgentEvent[]) => {
      await ctx.index.putEvents(evs);
      await ctx.index.upsertSession(buildSession(evs));
    };
    for (let i = 0; i < REVIEWS; i++) {
      const id = `r8-review-${i}`;
      const t0 = w.now - (10 + i) * 3600e3;
      const c = { cwd: join(w.root, "repos", `svc${i}`) };
      await put([
        ev(id, "claude-code", t0, "session.start", {}, c),
        ev(id, "claude-code", t0 + 1000, "user.message", { text: `Change service ${i}` }, c),
        ev(id, "claude-code", t0 + 2000, "file.change", { path: `src/s${i}.ts`, op: "modify" }, c),
        ev(id, "claude-code", t0 + 60_000, "session.end", { reason: "exit" }, c),
      ]);
    }
    // sess-d runs in the main checkout; it delegated a task to an agent in the worktree, which is running too.
    const k0 = w.now - 4 * 60e3;
    const wt = { cwd: worktree, repo: { root: worktree, head: "abc1234", branch: "feature" } };
    await put([
      ev(WORKTREE_CHILD, "claude-code", k0, "session.start", { parentSessionId: SEED.d, subagentId: "wt1", subagentType: "worktree" }, wt),
      ev(WORKTREE_CHILD, "claude-code", k0 + 1000, "user.message", { text: "Split the tokenizer in the feature worktree" }, wt),
    ]);
    // An in-process subagent of sess-d, running in the main checkout: from there sess-d stays the current session.
    const main = { cwd: w.repo, repo: { root: w.repo, head: "abc1234", branch: "main" } };
    await put([
      ev(SAME_DIR_CHILD, "claude-code", k0 + 2000, "session.start", { parentSessionId: SEED.d, subagentId: "sub9", subagentType: "Explore" }, main),
      ev(SAME_DIR_CHILD, "claude-code", k0 + 3000, "user.message", { text: "Find the tokenizer's callers" }, main),
    ]);
    // A Claude Code session T3 Code ran: its host-link makes it a t3code session; the prompt is Claude Code's own.
    const h0 = w.now - 30 * 3600e3;
    const hosted = { cwd: w.repo, repo: { root: w.repo, head: "abc1234", branch: "main" } };
    await put([
      ev(HOSTED, "t3code", h0 - 10, "notification", { type: "host-link", via: "t3code", provider: "claude-code", t3ThreadId: "thread-1", title: "Fix the lexer" }, { cwd: w.repo }),
      ev(HOSTED, "claude-code", h0, "session.start", { source: "transcript" }, hosted),
      ev(HOSTED, "claude-code", h0 + 1000, "user.message", { text: "Fix the off-by-one in the lexer" }, hosted),
      ev(HOSTED, "claude-code", h0 + 2000, "tool.start", { tool: "Edit", toolUseId: "e1", input: { file_path: "src/lex.ts" } }, hosted),
      ev(HOSTED, "claude-code", h0 + 2100, "tool.end", { tool: "Edit", toolUseId: "e1", ok: true }, hosted),
      ev(HOSTED, "claude-code", h0 + 2200, "file.change", { path: "src/lex.ts", op: "modify" }, hosted),
      ev(HOSTED, "claude-code", h0 + 60_000, "session.end", { reason: "exit" }, hosted),
    ]);
  } finally {
    await ctx.close();
  }
  recordLastIngest(w.env.CODING_SH_HOME!, "test", w.now - 120e3);
  mcp = createCodingShMcp({ env: w.env, cwd: w.repo, log: () => {}, now: () => w.now });
});

after(async () => {
  await mcp?.close();
  cleanup();
});

describe("the work tool", () => {
  it("is listed, and pages the queue to its end with a cursor, no item twice", async () => {
    const list = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = (list!.result as { tools: { name: string; description: string }[] }).tools;
    const work = tools.find((t) => t.name === "work");
    assert.ok(work, "tools/list has work");
    assert.ok(!work.description.includes("\n"), "a one-line description");

    const whole = await ok("work", { limit: 100 });
    const all = (whole.items as Obj[]).map((i) => i.id as string);
    assert.ok(all.length >= REVIEWS, `the queue has the review items: ${all.length}`);
    assert.equal(whole.nextCursor, undefined);
    assert.ok(whole.counts && typeof whole.needYou === "number", "work --json's counts and needYou");

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await ok("work", cursor ? { limit: 2, cursor } : { limit: 2 });
      const items = r.items as Obj[];
      assert.ok(items.length <= 2);
      seen.push(...items.map((i) => i.id as string));
      cursor = r.nextCursor as string | undefined;
      if (!cursor) break;
    }
    assert.equal(cursor, undefined, "the last page has no nextCursor");
    assert.equal(new Set(seen).size, seen.length, `no item twice: ${seen.join(",")}`);
    assert.deepEqual(seen, all, "the pages put together are the whole queue, in order");
  });

  it("carries the index's age, and each item's stage, reason and next step as work --json has them", async () => {
    const r = await ok("work", { limit: 1 });
    const index = r.index as Obj;
    assert.equal(typeof index.updatedAt, "string");
    assert.equal(typeof index.ageMs, "number");
    const [item] = r.items as Obj[];
    assert.ok(item && typeof item.reason === "string" && typeof item.next === "string" && typeof item.stage === "string", JSON.stringify(item));
    const every = await ok("work", { all: true, limit: 100 });
    assert.ok((every.items as Obj[]).length > ((await ok("work", { limit: 100 })).items as Obj[]).length, "all: true lists running items too");
  });
});

describe("session_current", () => {
  it("from a worktree finds the running delegate there, a child session", async () => {
    const r = await ok("session_current", { cwd: worktree });
    assert.equal((r.session as Obj).id, WORKTREE_CHILD);
    assert.equal(r.matchedBy, "cwd-running");
  });

  it("from the main checkout still prefers the running top-level session over its subagent", async () => {
    const r = await ok("session_current", { cwd: w.repo });
    assert.equal((r.session as Obj).id, SEED.d);
  });
});

describe("sessions_list", () => {
  it("says how many child sessions it leaves out, and how to include them", async () => {
    const every = await ok("sessions_list", { includeSubagents: true, limit: 100 });
    const children = (every.sessions as Obj[]).filter((s) => s.parentSessionId).length;
    assert.ok(children >= 3);
    assert.equal(every.hiddenChildren, undefined, "nothing is hidden with includeSubagents");

    const top = await call("sessions_list", { limit: 100 });
    assert.equal(top.structuredContent!.hiddenChildren, children);
    assert.match(String(top.structuredContent!.note), /includeSubagents: true/);
    assert.match(top.content[0]!.text, /hiddenChildren/);

    // The same filters count: only claude-code here, and codex has no children.
    const codex = await ok("sessions_list", { agent: "codex" });
    assert.equal(codex.hiddenChildren, undefined);
  });
});

describe("eval_candidates", () => {
  it("does not reject a session T3 Code hosted that has a user prompt", async () => {
    const r = await ok("eval_candidates", { since: "7d", includeRejected: true, limit: 50 });
    const hosted = (r.candidates as Obj[]).find((x) => x.sessionId === HOSTED);
    assert.ok(hosted, `the hosted session is considered: ${JSON.stringify(r.candidates)}`);
    assert.equal(hosted.reject, undefined, `not rejected: ${String(hosted.reject)}`);
    assert.equal(hosted.eligible, true);
    assert.equal(hosted.agent, "t3code");
  });
});

describe("a window given only its end", () => {
  it("is the 7 days before until, not a window that starts after it", async () => {
    const r = await ok("failures", { until: "30d" });
    const win = r.window as Obj;
    assert.equal(Date.parse(win.until as string), w.now - 30 * DAY);
    assert.equal(Date.parse(win.until as string) - Date.parse(win.since as string), 7 * DAY);
    // since given too: as before.
    const both = await ok("failures", { since: "40d", until: "30d" });
    assert.equal(Date.parse((both.window as Obj).since as string), w.now - 40 * DAY);
  });
});

describe("sessions_list window", () => {
  it("says which window it read: until alone starts at the first session, a where clause narrows it", async () => {
    const r = await ok("sessions_list", { until: "25h", includeSubagents: true, limit: 100 });
    assert.deepEqual(r.window, { until: new Date(w.now - 25 * 3_600e3).toISOString() }, "no since: sessions_list reads all time before until");
    assert.ok((r.sessions as Obj[]).some((s) => s.id === SEED.b), "the session 26 hours old is listed");
    const both = await ok("sessions_list", { since: "40d", until: "1h", where: "until:25h", includeSubagents: true });
    assert.deepEqual(both.window, { since: new Date(w.now - 40 * DAY).toISOString(), until: new Date(w.now - 25 * 3_600e3).toISOString() });
    const plain = await ok("sessions_list", {});
    assert.equal(plain.window, undefined, "no bounds, no window");
  });
});

describe("status", () => {
  it("carries the index's age", async () => {
    const r = await ok("status");
    const index = r.index as Obj;
    assert.ok(index, "status has index");
    assert.ok(Number.isFinite(Date.parse(index.updatedAt as string)), String(index.updatedAt));
    assert.ok(typeof index.ageMs === "number" && index.ageMs >= 0);
  });
});

describe("session_get tail past DIGEST_EVENT_CAP", () => {
  it("pages back from where the last page left off while the session grows", async () => {
    const index = new MemoryIndexStore();
    const events: AgentEvent[] = [];
    let ts = Date.UTC(2026, 10, 3, 16);
    let k = 0;
    const add = (kind: AgentEvent["kind"], payload: Obj) => {
      const e: AgentEvent = { id: `t${++k}`, v: 0, sessionId: "long", agent: "claude-code", ts: (ts += 1000), kind, payload };
      events.push(e);
      return e;
    };
    add("session.start", {});
    add("user.message", { text: "Keep going" });
    while (events.length < DIGEST_EVENT_CAP + 2000) add("assistant.message", { text: `m${k}` });
    await index.putEvents(events);
    await index.upsertSession(buildSession(events));
    const tool = buildTools().find((t) => t.name === "session_get")!;
    const fake: Pick<Context, "index"> = { index };
    const ctx: ToolCtx = { env: {}, cwd: w.root, now: () => ts, store: async () => fake as Context };
    const get = async (a: Obj) => (await tool.run({ sessionId: "long", tail: true, limit: 50, ...a }, ctx)) as Obj & { timeline: { text: string }[] };
    const num = (e: { text: string }) => Number(e.text.slice(1));

    const first = await get({});
    assert.equal(first.timeline.length, 50);
    assert.equal(first.eventsTruncated, true);
    const cursor = first.nextCursor as string;
    assert.match(cursor, /^\d+@\d+:\d+$/, "the cursor carries its window");

    // The agent goes on: 700 more events while the reader pages back.
    const more: AgentEvent[] = [];
    for (let i = 0; i < 700; i++) more.push(add("assistant.message", { text: `m${k}` }));
    await index.putEvents(more);
    await index.upsertSession(buildSession(events));

    const second = await get({ cursor });
    assert.equal(second.timeline.length, 50);
    assert.equal(num(second.timeline.at(-1)!), num(first.timeline[0]!) - 1, "the page ends just before the last one began: nothing repeated or skipped");
    const third = await get({ cursor: second.nextCursor });
    assert.equal(num(third.timeline.at(-1)!), num(second.timeline[0]!) - 1);

    // Paging stops at the window's start, and says the session is longer.
    let c: string | undefined = third.nextCursor as string;
    let last = third;
    for (let i = 0; i < 1000 && c; i++) {
      last = await get({ cursor: c, limit: 200 });
      c = last.nextCursor as string | undefined;
    }
    assert.equal(c, undefined);
    assert.equal(last.eventsTruncated, true);
    assert.equal(num(last.timeline[0]!), events.length - 700 - DIGEST_EVENT_CAP, "the window's first event (event i says m<i>)");

    assert.equal((await tool.run({ sessionId: "long", tail: true, cursor: "12@x" }, ctx).catch((e: Error) => e)) instanceof Error, true, "a bad cursor is refused");
  });
});
