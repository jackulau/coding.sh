// coding.sh usage --by mcp, --by skill and --by subagent: what each MCP server, skill and
// subagent type costs. Real captures (codex/code-mode, codex/skill, claude-code/subagents)
// backfilled into a throwaway store, then hand-written sessions for the edges.
import assert from "node:assert/strict";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { attributedUsage } from "../../src/cli/commands/usage.ts";
import { mcpCallsOf } from "../../src/core/mcp-usage.ts";
import { pricesFor } from "../../src/core/pricing.ts";
import { TOTALS_SCAN_CAP } from "../../src/mcp/data.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { FIXTURES, tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, session } from "../query/_seed.ts";

interface Row {
  key: string;
  basis: string;
  [k: string]: unknown;
}
const json = (args: string[], env: NodeJS.ProcessEnv = {}) => JSON.parse(ok([...args, "--json"], env).stdout) as { groups: Row[]; total: Record<string, unknown>; basis: string; attribution: string; rowsOverlap?: boolean };

describe("usage --by mcp|skill|subagent over real captures", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
    const codex = join(env.root, "codex");
    const claude = join(env.root, "claude");
    mkdirSync(join(codex, "sessions", "2026", "11", "01"), { recursive: true });
    cpSync(join(FIXTURES, "codex", "code-mode", "rollout-2026-11-01T10-00-00-0193dddd-1111-7222-8333-444455556666.jsonl"), join(codex, "sessions", "2026", "11", "01", "rollout-2026-11-01T10-00-00-0193dddd-1111-7222-8333-444455556666.jsonl"));
    cpSync(join(FIXTURES, "codex", "skill", "sessions"), join(codex, "sessions"), { recursive: true });
    cpSync(join(FIXTURES, "claude-code", "subagents", "config"), claude, { recursive: true });
    const homes = { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude };
    ok(["ingest", "--backfill", "--since", "3650d"], homes);
    process.env.CODEX_HOME = codex;
    process.env.CLAUDE_CONFIG_DIR = claude;
  });
  after(() => env.restore());

  test("--by mcp lists the code-mode cell's MCP server with its calls", () => {
    const r = json(["usage", "--by", "mcp", "--since", "3650d"]);
    const docs = r.groups.find((g) => g.key === "docs");
    assert.ok(docs, JSON.stringify(r.groups));
    assert.ok((docs.calls as number) > 0);
    assert.equal(docs.failedCalls, 1, "the search the cell caught failed");
    assert.equal(docs.resultBytes, Buffer.byteLength('{"message":"search unavailable"}'));
    assert.equal(docs.resultTokens, 8, "32 bytes / 4");
    assert.equal(docs.estimatedResultTokens, 8, "no stored count: estimated");
    assert.equal(typeof docs.costUsd, "number", "gpt-5.5 has an input price");
    assert.equal(r.basis, "attributed");
    assert.ok(r.groups.every((g) => g.basis === "attributed"));
  });

  test("--by subagent lists the subagent type with the children's cost, not the parent's", () => {
    const r = json(["usage", "--by", "subagent", "--since", "3650d"]);
    assert.deepEqual(r.groups.map((g) => g.key), ["general-purpose"]);
    const g = r.groups[0]!;
    assert.equal(g.sessions, 2);
    // The two children cost 0.033915 and 0.03834; the parent's own 0.06207 is left out.
    assert.equal(g.costUsd, 0.0723);
    assert.equal(g.totalTokens, 8000 + 8100 + 140 + 9000 + 9200 + 140);
    assert.equal(typeof g.medianDurationMs, "number");
    assert.equal(g.basis, "attributed");
  });

  test("--by skill lists the skill of the skill session", () => {
    const r = json(["usage", "--by", "skill", "--since", "3650d"]);
    const g = r.groups.find((x) => x.key === "release-notes");
    assert.ok(g, JSON.stringify(r.groups));
    assert.equal(g.sessions, 1);
    assert.equal(g.totalTokens, 450);
    assert.equal(r.rowsOverlap, true);
    assert.match(r.attribution, /counts in both rows, so the rows do not add up to the total/);
    assert.equal(r.total.sessions, 5, "the total is every session in the window");
  });

  test("the human table says how each column is attributed, in one line under it", () => {
    const m = ok(["usage", "--by", "mcp", "--since", "3650d"]);
    assert.match(m.stdout, /^SERVER\s+CALLS\s+FAILED\s+RESULT\s+TOKENS\s+COST/m);
    assert.match(m.stdout, /^docs\s+1\s+1\s+32 B\s+~8\s+~/m);
    assert.match(m.stderr, /Attributed per call: .*TOKENS = the stored token count, else RESULT \/ 4 \(~\); COST = those tokens at the input price of the session's model/);
    const s = ok(["usage", "--by", "subagent", "--since", "3650d"]);
    assert.match(s.stdout, /^SUBAGENT\s+COUNT\s+TOKENS\s+COST\s+MEDIAN TIME/m);
    assert.match(s.stderr, /Their parents' own tokens and cost are left out/);
    const k = ok(["usage", "--by", "skill", "--since", "3650d"]);
    assert.match(k.stderr, /A session with two skills counts in both rows/);
    assert.match(k.stderr, /All 5 sessions in the window/);
  });

  test("--cache and --baseline keep working with the old groups and reject the new ones (exit 2)", () => {
    for (const by of ["mcp", "skill", "subagent"]) {
      const c = cli(["usage", "--by", by, "--cache", "--since", "3650d"]);
      assert.equal(c.status, 2, c.stderr);
      assert.match(c.stderr, /--cache reads each session's prompt-cache tokens .*use --cache with --by agent, model, agent-model, day or repo/);
      const b = cli(["usage", "--by", by, "--baseline", "--since", "3650d"]);
      assert.equal(b.status, 2, b.stderr);
      assert.match(b.stderr, /--baseline compares agents/);
    }
    assert.match(ok(["usage", "--by", "model", "--cache", "--since", "3650d"]).stdout, /CACHED/);
    assert.match(ok(["usage", "--baseline", "--since", "3650d"]).stdout, /VS PUBLISHED/);
  });
});

describe("usage --by mcp|skill|subagent edges", () => {
  let env: TmpEnv;
  const now = Date.now() - 3_600_000;
  const usage = (inputTokens: number, costUsd?: number): Session["stats"] => {
    const u: NonNullable<Session["stats"]["usage"]> = { inputTokens, outputTokens: 0 };
    if (costUsd !== undefined) u.costUsd = costUsd;
    return { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: u };
  };
  let n = 0;
  const ev = (sessionId: string, kind: AgentEvent["kind"], payload: Record<string, unknown>, over: Partial<AgentEvent> = {}): AgentEvent => ({ id: `${sessionId}-${n++}`, v: 0, sessionId, ts: now + n, agent: "claude-code", kind, payload, ...over } as AgentEvent);
  const call = (sid: string, server: string, id: string, end?: Record<string, unknown>, over: Partial<AgentEvent> = {}) => {
    const events = [ev(sid, "tool.start", { tool: `mcp__${server}__q`, toolUseId: id, input: {}, server })];
    if (end) events.push(ev(sid, "tool.end", { tool: `mcp__${server}__q`, toolUseId: id, ...end }, over));
    return events;
  };
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, {
      sessions: [
        session("both", { startedAt: now, endedAt: now + 1000, model: "claude-opus-4-5", flags: ["skill:pdf", "skill:docx"], stats: usage(1000, 0.5) }),
        session("one", { startedAt: now, endedAt: now + 1000, model: "mystery-model-1", flags: ["skill:pdf"], stats: usage(200) }),
        session("kid1", { startedAt: now, endedAt: now + 4000, parent: { sessionId: "both" }, stats: usage(300, 0.1) }),
        session("kid2", { startedAt: now, endedAt: now + 2000, parent: { sessionId: "both", type: "Explore" }, stats: usage(50, 0.02) }),
        session("kid3", { startedAt: now, endedAt: now + 6000, parent: { sessionId: "both", type: "Explore" }, stats: usage(70, 0.03) }),
      ],
      events: [
        // 4000 bytes, no count: 1000 estimated tokens; a stored count wins over the bytes.
        ...call("both", "github", "g1", { ok: true, output: "x".repeat(4000) }),
        ...call("both", "github", "g2", { ok: false, output: "nope", outputTokens: 7 }),
        // The cut's deliveredBytes is what the model got; a clipped output is a lower bound.
        ...call("both", "linear", "l1", { ok: true, output: "short", cut: { by: "middle", deliveredBytes: 800 } }),
        ...call("both", "linear", "l2", { ok: true, output: `${"y".repeat(96)}…` }, { blobs: ["sha256-0000"] }),
        // No end yet: a call, no result. On an unpriced model: no cost.
        ...call("one", "github", "g3"),
        ...call("one", "github", "g4", { ok: true, output: "z".repeat(40) }),
        // Not an MCP call.
        ev("both", "tool.start", { tool: "Bash", toolUseId: "b1", input: { command: "ls" } }),
      ],
    });
  });
  after(() => env.restore());

  test("mcp: stored counts, estimates, failures, cuts, clips and unpriced models", () => {
    const r = json(["usage", "--by", "mcp"]);
    const gh = r.groups.find((g) => g.key === "github")!;
    assert.deepEqual([gh.calls, gh.failedCalls, gh.resultBytes, gh.resultTokens, gh.estimatedResultTokens, gh.sessions], [4, 1, 4044, 1000 + 7 + 10, 1010, 2]);
    // claude-opus-4-5 input is $5 per 1M: 1007 tokens priced; the 10 on mystery-model-1 are not.
    assert.equal(gh.costUsd, 0.005035);
    assert.equal(gh.costPartial, true);
    assert.equal(gh.unpricedCalls, 1);
    const li = r.groups.find((g) => g.key === "linear")!;
    assert.deepEqual([li.calls, li.resultBytes, li.resultBytesPartial, li.clippedResults], [2, 800 + 99, true, 1]);
    assert.deepEqual(r.groups.map((g) => g.key), ["github", "linear"], "costliest first");
    assert.equal(r.total.calls, 6);
    const h = ok(["usage", "--by", "mcp"]);
    assert.match(h.stdout, /^linear\s+2\s+-\s+≥899 B/m);
    assert.match(h.stderr, /some results were clipped/);
    assert.match(h.stderr, /some calls ran on a model with no price/);
  });

  test("skill: a session with two skills counts in both rows", () => {
    const r = json(["usage", "--by", "skill"]);
    const pdf = r.groups.find((g) => g.key === "pdf")!;
    const docx = r.groups.find((g) => g.key === "docx")!;
    assert.deepEqual([pdf.sessions, pdf.totalTokens, pdf.costUsd, pdf.costPartial], [2, 1200, 0.5, true]);
    assert.deepEqual([docx.sessions, docx.totalTokens, docx.costUsd], [1, 1000, 0.5]);
    assert.equal(r.rowsOverlap, true);
  });

  test("subagent: by type, untyped children are unnamed, median duration", () => {
    const r = json(["usage", "--by", "subagent"]);
    assert.deepEqual(r.groups.map((g) => [g.key, g.sessions, g.totalTokens, g.costUsd, g.medianDurationMs]), [
      ["unnamed", 1, 300, 0.1, 4000],
      ["Explore", 2, 120, 0.05, 4000],
    ]);
    assert.equal(r.total.sessions, 3, "the parents are not counted");
  });

  test("--limit caps the rows; an empty window says what it looked for", () => {
    assert.equal(json(["usage", "--by", "mcp", "--limit", "1"]).groups.length, 1);
    const e = ok(["usage", "--by", "mcp", "--agent", "codex"]);
    assert.match(e.stderr, /No MCP tool calls in this window/);
  });
});

describe("usage --by mcp reads the store narrowly", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
  });
  after(() => env.restore());

  test("the SQLite query gives the rows of the reference (mcpCallsOf)", async () => {
    const sid = "p1";
    const t = Date.now() - 60_000;
    let i = 0;
    const e = (kind: AgentEvent["kind"], payload: Record<string, unknown>, over: Partial<AgentEvent> = {}): AgentEvent => ({ id: `p-${i++}`, v: 0, sessionId: sid, ts: t + i, agent: "claude-code", kind, payload, ...over } as AgentEvent);
    const events: AgentEvent[] = [
      e("tool.start", { tool: "mcp__a__x", toolUseId: "1", input: {}, server: "a" }),
      e("tool.end", { tool: "mcp__a__x", toolUseId: "1", ok: true, output: "héllo wörld" }),
      e("tool.start", { tool: "mcp__a__x", toolUseId: "2", input: {}, server: "a" }),
      e("tool.end", { tool: "mcp__a__x", toolUseId: "2", ok: false, output: { error: "no", n: [1, 2] }, outputTokens: 12 }),
      e("tool.start", { tool: "mcp__b__y", toolUseId: "3", input: {}, server: "b" }),
      e("tool.end", { tool: "mcp__b__y", toolUseId: "3", output: `${"q".repeat(10)}…` }, { blobs: ["sha256-1111"] }),
      e("tool.start", { tool: "mcp__b__y", toolUseId: "4", input: {}, server: "b" }),
      e("tool.end", { tool: "mcp__b__y", toolUseId: "4", ok: true, output: `${"q".repeat(10)}…`, outputBytes: 5000 }, { blobs: ["sha256-2222"] }),
      e("tool.start", { tool: "mcp__b__y", toolUseId: "5", input: {}, server: "b" }),
      e("tool.end", { tool: "mcp__b__y", toolUseId: "5", ok: true, output: "abc", cut: { by: "head", deliveredBytes: 70 } }),
      e("tool.start", { tool: "mcp__b__y", toolUseId: "6", input: {}, server: "b" }),
      e("tool.end", { tool: "mcp__b__y", toolUseId: "6", ok: true }),
      e("tool.start", { tool: "mcp__b__y", toolUseId: "7", input: {}, server: "b" }),
      e("tool.start", { tool: "Read", toolUseId: "8", input: { path: "x" } }),
      e("tool.end", { tool: "Read", toolUseId: "8", ok: true, output: "file" }),
    ];
    const path = await seed(env.dataHome, { sessions: [session(sid, { startedAt: t, endedAt: t + 100, model: "claude-opus-4-5" })], events });
    const store = await SqliteIndexStore.open(path);
    try {
      const got = await store.mcpCalls({});
      const want = mcpCallsOf(events, "claude-opus-4-5");
      assert.equal(want.length, 7);
      assert.deepEqual(got, want);
    } finally {
      await store.close();
    }
  });

  test("over 100,000 events it reads the MCP rows, not each session's events", async (t) => {
    const SESSIONS = 1000;
    const t0Day = Date.now() - 86_400_000;
    const sessions: Session[] = [];
    const events: AgentEvent[] = [];
    for (let s = 0; s < SESSIONS; s++) {
      const sid = `perf-${s}`;
      sessions.push(session(sid, { startedAt: t0Day + s, endedAt: t0Day + s + 60_000, model: s % 2 ? "claude-opus-4-5" : "gpt-5.5" }));
      // Per session: 40 MCP calls over 8 servers and 10 shell calls, each a start and an end.
      for (let c = 0; c < 50; c++) {
        const mcp = c < 40;
        const server = `srv${c % 8}`;
        const tool = mcp ? `mcp__${server}__call${c % 3}` : "Bash";
        const base = { id: "", v: 0 as const, sessionId: sid, agent: "claude-code" as const };
        events.push({ ...base, id: `${sid}-${c}s`, ts: t0Day + s + c * 2, kind: "tool.start", payload: mcp ? { tool, toolUseId: `u${c}`, input: {}, server } : { tool, toolUseId: `u${c}`, input: {} } } as AgentEvent);
        events.push({ ...base, id: `${sid}-${c}e`, ts: t0Day + s + c * 2 + 1, kind: "tool.end", payload: { tool, toolUseId: `u${c}`, ok: c % 7 !== 0, output: "r".repeat(200 + c) } } as AgentEvent);
      }
    }
    assert.equal(events.length, 100_000);
    const path = await seed(env.dataHome, { sessions, events });
    // The CLI's answer, not timed: on busy CI runners this run took 2.2 to 2.4 s, against 0.6 to
    // 0.8 s when the file ran alone.
    const r = JSON.parse(ok(["usage", "--by", "mcp", "--json", "--since", "30d"]).stdout) as { groups: Row[]; total: Row; window: { truncated?: boolean } };
    const srv = r.groups.filter((g) => g.key.startsWith("srv"));
    assert.equal(srv.length, 8);
    assert.equal(srv.reduce((n, g) => n + (g.calls as number), 0), SESSIONS * 40);
    assert.equal(r.window.truncated, undefined);
    // The same query in this process, on a store that throws if usage reads each session's events,
    // as it does on a store without mcpCalls. Reading each session's events took 1.7 times as long
    // on a developer machine: too close for a time budget to tell the two apart.
    const store = await SqliteIndexStore.open(path);
    try {
      let narrow = 0;
      const index = new Proxy(store, {
        get(target, k) {
          if (k === "listEvents") throw new Error("usage --by mcp read each session's events, not the MCP rows");
          if (k === "mcpCalls") narrow++;
          const v = Reflect.get(target, k, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const t0 = performance.now();
      const got = await attributedUsage(index, { since: Date.now() - 30 * 86_400_000, topLevel: false }, "mcp", 20, TOTALS_SCAN_CAP, pricesFor(undefined));
      const ms = performance.now() - t0;
      assert.ok(narrow > 0, "usage --by mcp did not call the store's mcpCalls");
      assert.deepEqual(JSON.parse(JSON.stringify(got.groups)), r.groups);
      assert.deepEqual(JSON.parse(JSON.stringify(got.total)), r.total);
      t.diagnostic(`usage --by mcp over 100,000 events, in this process: ${Math.round(ms)} ms`);
      // A coarse budget: the query takes about 0.5 s on a developer machine, so only a large
      // slowdown fails it.
      assert.ok(ms < 5000, `usage --by mcp over 100,000 events took ${Math.round(ms)} ms`);
    } finally {
      await store.close();
    }
  });
});
