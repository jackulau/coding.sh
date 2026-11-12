// Tool answers stay under the 25,000-character limit by returning fewer rows
// (never by cutting text), the cursor still walks every row, and errors that
// quote a huge argument stay short.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { CHARACTER_LIMIT } from "../../src/mcp/tools.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { RawClient, cleanup, makeWorld, seed, type World } from "./helpers.ts";

const BIG = "sess-big";
const CALLS = 600;

let w: World;
let c: RawClient;

type Result = { structuredContent?: Record<string, unknown>; content: { type: string; text: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const r = await c.call(name, args);
  assert.notEqual(r.isError, true, `${name}: ${r.content[0]?.text.slice(0, 300)}`);
  return r;
}

before(async () => {
  w = makeWorld();
  await seed(w);
  // One long session: CALLS Bash calls with 4 KB outputs.
  const ctx = await openContext({ env: w.env, cwd: w.root });
  const t0 = w.now - 3 * 3600e3;
  const base = { v: 0 as const, sessionId: BIG, agent: "claude-code", cwd: w.repo, model: "claude-opus-4-5" };
  const evs: AgentEvent[] = [
    { ...base, id: "big-0", ts: t0, kind: "session.start", payload: {} },
    { ...base, id: "big-1", ts: t0 + 1, kind: "user.message", payload: { text: "Run the migration" } },
  ];
  for (let i = 0; i < CALLS; i++) {
    evs.push({ ...base, id: `big-s${i}`, ts: t0 + 10 + i * 10, kind: "tool.start", payload: { tool: "Bash", toolUseId: `b${i}`, input: { command: `echo needle-${i} ${"y".repeat(2000)}` } } });
    evs.push({ ...base, id: `big-e${i}`, ts: t0 + 15 + i * 10, kind: "tool.end", payload: { tool: "Bash", toolUseId: `b${i}`, ok: true, output: `needle out ${i} ${"z".repeat(4000)}` }, durationMs: 5 });
  }
  evs.push({ ...base, id: "big-end", ts: t0 + 20 * CALLS, kind: "session.end", payload: {} });
  await ctx.index.putEvents(evs);
  await ctx.index.upsertSession(buildSession(evs));
  await ctx.close();
  c = new RawClient(w.env, w.repo);
  await c.initialize();
});

after(async () => {
  await c?.close();
  cleanup();
});

describe("the 25,000-character limit", () => {
  it("session_get returns fewer timeline entries, and the cursor walks all of them", async () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      const args: Record<string, unknown> = { sessionId: BIG, limit: 200 };
      if (cursor) args.cursor = cursor;
      const r = await call("session_get", args);
      assert.ok(r.content[0]!.text.length <= CHARACTER_LIMIT, `page ${page} is ${r.content[0]!.text.length} chars`);
      const sc = r.structuredContent!;
      for (const e of sc.timeline as { at: number }[]) seen.push(e.at);
      cursor = sc.nextCursor as string | undefined;
      if (!cursor) break;
      assert.ok((sc.limitUsed as number) < 200, "a shortened page says which limit it used");
    }
    assert.equal(cursor, undefined, "the cursor reached the end");
    assert.equal(new Set(seen).size, seen.length, "no entry is repeated");
    const all = await call("session_get", { sessionId: BIG, limit: 200, tail: true });
    assert.ok(all.content[0]!.text.length <= CHARACTER_LIMIT);
    assert.ok(seen.length > CALLS, `every tool call is in the walk (${seen.length})`);
  });

  it("session_replay pages its step list under the limit", async () => {
    let cursor: string | undefined;
    let steps = 0;
    let total = 0;
    for (let page = 0; page < 200; page++) {
      const args: Record<string, unknown> = { sessionId: BIG, limit: 1000 };
      if (cursor) args.cursor = cursor;
      const r = await call("session_replay", args);
      assert.ok(r.content[0]!.text.length <= CHARACTER_LIMIT, `page ${page} is ${r.content[0]!.text.length} chars`);
      const sc = r.structuredContent!;
      steps += (sc.steps as unknown[]).length;
      total = sc.total as number;
      cursor = sc.nextCursor as string | undefined;
      if (!cursor) break;
    }
    assert.ok(total > 0);
    assert.equal(steps, total, "the pages hold every step once");
  });

  it("search, sessions_list and session_current stay under the limit", async () => {
    for (const [name, args] of [
      ["search", { query: "needle", limit: 50 }],
      ["sessions_list", { limit: 100, includeSubagents: true }],
      ["session_current", { limit: 100 }],
    ] as const) {
      const r = await call(name, args);
      assert.ok(r.content[0]!.text.length <= CHARACTER_LIMIT, `${name} is ${r.content[0]!.text.length} chars`);
    }
  });

  it("eval_candidates returns at most limit rejected sessions", async () => {
    const r = await call("eval_candidates", { limit: 1, includeRejected: true, repo: "all", since: "30d" });
    const sc = r.structuredContent as { candidates: { eligible: boolean }[]; considered: number; eligible: number };
    assert.ok(sc.considered - sc.eligible > 1, `the seed has more than one rejected session (${sc.considered - sc.eligible})`);
    assert.ok(sc.candidates.filter((x) => !x.eligible).length <= 1, `${sc.candidates.filter((x) => !x.eligible).length} rejected sessions for limit 1`);
  });
});

describe("tool errors", () => {
  it("quote a huge argument in a short message", async () => {
    const huge = "h".repeat(1_000_000);
    for (const [name, args] of [
      ["session_get", { sessionId: huge }],
      ["benchmarks", { name: huge }],
      ["harness_compare", { experiment: huge }],
    ] as const) {
      const r = await c.call(name, args);
      assert.equal(r.isError, true, name);
      assert.ok(r.content[0]!.text.length < 5000, `${name} error is ${r.content[0]!.text.length} chars`);
    }
  });
});
