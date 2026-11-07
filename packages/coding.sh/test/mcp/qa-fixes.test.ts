// Regressions from hands-on QA of the MCP server against a real backfilled
// store: subagent durations, subagents paging, wait tools in latency, stale
// "running" sessions, unknown cost reported as $0, and Ctrl-C on `coding.sh mcp`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { schemaViolations } from "../../src/toolevals/jsonschema.ts";
import { PKG, cleanup, makeWorld, type World } from "./helpers.ts";

const H = 3600e3;
const M = 60e3;
let n = 0;
function ev(sessionId: string, agent: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown> = {}, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `${sessionId}-q${n++}`, v: 0, sessionId, agent, ts, kind, payload, ...extra };
}

let w: World;
let mcp: CodingShMcp;
let tools: { name: string; outputSchema: Record<string, unknown> }[];
const stale = () => join(w.root, "repos", "stale");
const IDS = { parent: "qa-parent", cc: "qa-parent:sub:a66d", cx: "qa-codex-child", bySub: "qa-bysub-child", many: "qa-many", stale: "qa-stale", live: "qa-live", noCost: "qa-nocost" };

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const res = r!.result as { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] };
  assert.notEqual(res.isError, true, `${name}: ${res.content?.[0]?.text}`);
  // What goes over the wire: undefined fields are dropped.
  const sc = JSON.parse(JSON.stringify(res.structuredContent)) as Record<string, unknown>;
  const schema = tools.find((t) => t.name === name)!.outputSchema;
  assert.deepEqual(schemaViolations(sc, schema), [], `${name} output matches its outputSchema`);
  return sc;
}

before(async () => {
  w = makeWorld();
  mkdirSync(stale(), { recursive: true });
  const now = w.now;
  const sessions: AgentEvent[][] = [];

  // A parent whose subagents each have their own (backfilled: no session.end) child session.
  const p0 = now - 3 * H;
  const P = IDS.parent;
  const ctxP = { cwd: w.repo, model: "claude-opus-5-5" };
  sessions.push([
    ev(P, "claude-code", p0, "session.start", {}, ctxP),
    ev(P, "claude-code", p0 + 100, "user.message", { text: "Review the sources" }, ctxP),
    // claude-code: the parent measured the run (durationMs) and named the child.
    ev(P, "claude-code", p0 + 1000, "subagent.start", { subagentId: "a66d", type: "general-purpose", description: "Independent source review", childSessionId: IDS.cc }, ctxP),
    ev(P, "claude-code", p0 + 625_716, "subagent.end", { subagentId: "a66d", ok: true, childSessionId: IDS.cc }, { ...ctxP, durationMs: 624_716 }),
    // codex: start/end without durationMs; the child's own activity is the duration.
    ev(P, "claude-code", p0 + 2000, "subagent.start", { subagentId: IDS.cx, type: "explorer", description: "/root/audit", childSessionId: IDS.cx }, ctxP),
    ev(P, "claude-code", p0 + 900_000, "subagent.end", { subagentId: IDS.cx, ok: false, childSessionId: IDS.cx }, ctxP),
    // Linked only by subagentId (the child's session.start names it).
    ev(P, "claude-code", p0 + 3000, "subagent.start", { subagentId: "s3", type: "Explore", description: "Find callers" }, ctxP),
    ev(P, "claude-code", p0 + 13_000, "subagent.end", { subagentId: "s3", ok: true }, { ...ctxP, durationMs: 10_000 }),
  ]);
  sessions.push([
    ev(IDS.cc, "claude-code", p0 + 1100, "session.start", { parentSessionId: P }, ctxP),
    ev(IDS.cc, "claude-code", p0 + 1200, "user.message", { text: "You are the independent source reviewer for a long brief…" }, ctxP),
    ev(IDS.cc, "claude-code", p0 + 600_000, "assistant.message", { text: "done" }, ctxP),
  ]);
  sessions.push([
    ev(IDS.cx, "codex", p0 + 2100, "session.start", { parentSessionId: P }, ctxP),
    ev(IDS.cx, "codex", p0 + 2200, "user.message", { text: "audit" }, ctxP),
    ev(IDS.cx, "codex", p0 + 2100 + 700_000, "assistant.message", { text: "found it" }, ctxP),
  ]);
  sessions.push([
    ev(IDS.bySub, "claude-code", p0 + 3100, "session.start", { parentSessionId: P, subagentId: "s3" }, ctxP),
    ev(IDS.bySub, "claude-code", p0 + 3200, "user.message", { text: "Find every caller" }, ctxP),
  ]);

  // 25 in-session subagents, to page.
  const m0 = now - 4 * H;
  const many: AgentEvent[] = [ev(IDS.many, "claude-code", m0, "session.start", {}, ctxP)];
  for (let i = 0; i < 25; i++) {
    many.push(ev(IDS.many, "claude-code", m0 + 1000 + i * 10, "subagent.start", { subagentId: `m${i}`, type: "Explore", description: `task ${i}` }, ctxP));
    many.push(ev(IDS.many, "claude-code", m0 + 2000 + i * 10, "subagent.end", { subagentId: `m${i}`, ok: true }, { ...ctxP, durationMs: 1000 }));
  }
  sessions.push(many);

  // Latency: a human wait, a subagent wait, and real tools.
  const ctxS = { cwd: stale(), model: "claude-opus-5-5" };
  const s0 = now - 5 * H;
  const S = IDS.stale;
  const tool = (id: string, name: string, at: number, ms: number) => [
    ev(S, "claude-code", at, "tool.start", { tool: name, toolUseId: id, input: { command: name } }, ctxS),
    ev(S, "claude-code", at + ms, "tool.end", { tool: name, toolUseId: id, ok: true }, { ...ctxS, durationMs: ms }),
  ];
  sessions.push([
    ev(S, "claude-code", s0, "session.start", {}, ctxS),
    ev(S, "claude-code", s0 + 100, "user.message", { text: "Plan the migration" }, ctxS),
    ...tool("u1", "AskUserQuestion", s0 + 1000, 2 * H),
    ...tool("t1", "Agent", s0 + 2 * H + 2000, 2 * M),
    ...tool("w1", "wait_agent", s0 + 2 * H + 3 * M, 30_000),
    ...tool("f1", "WebFetch", s0 + 2 * H + 4 * M, 6000),
    ...tool("b1", "Bash", s0 + 2 * H + 5 * M, 3000),
    // Tokens but no cost (what Claude Code / Codex transcripts carry).
    ev(S, "claude-code", s0 + 2 * H + 6 * M, "llm.call", { ok: true }, { ...ctxS, durationMs: 1000, usage: { inputTokens: 10, outputTokens: 5000, cacheReadTokens: 100_000 } }),
  ]);
  // Still being written: last event a minute ago, no session.end.
  sessions.push([ev(IDS.live, "codex", now - 10 * M, "session.start", {}, { cwd: join(w.root, "repos", "docs") }), ev(IDS.live, "codex", now - M, "user.message", { text: "Keep going" }, { cwd: join(w.root, "repos", "docs") })]);
  // Another unpriced session with fewer output tokens.
  sessions.push([
    ev(IDS.noCost, "codex", now - 6 * H, "session.start", {}, { cwd: stale(), model: "zz-unpriced-model" }),
    ev(IDS.noCost, "codex", now - 6 * H + 1000, "llm.call", { ok: true }, { cwd: stale(), model: "zz-unpriced-model", durationMs: 800, usage: { inputTokens: 900, outputTokens: 300 } }),
    ev(IDS.noCost, "codex", now - 6 * H + 2000, "session.end", {}, { cwd: stale() }),
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
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 0, method: "tools/list" });
  tools = (r!.result as { tools: typeof tools }).tools;
});

after(async () => {
  await mcp?.close();
  cleanup();
});

type Node = { sessionId?: string; subagentId?: string; type?: string; description?: string; durationMs?: number; ok?: boolean };

describe("subagents", () => {
  it("keeps the parent's duration, ok and short description on nodes that have a child session", async () => {
    const r = await call("subagents", { sessionId: IDS.parent });
    assert.equal(r.count, 3);
    const nodes = r.subagents as Node[];
    const byId = Object.fromEntries(nodes.map((x) => [x.sessionId, x]));
    const cc = byId[IDS.cc]!;
    assert.deepEqual({ d: cc.durationMs, ok: cc.ok, desc: cc.description, type: cc.type, sub: cc.subagentId }, { d: 624_716, ok: true, desc: "Independent source review", type: "general-purpose", sub: "a66d" });
    // No durationMs from the parent and no end on the child: the child's last activity.
    assert.deepEqual({ d: byId[IDS.cx]!.durationMs, ok: byId[IDS.cx]!.ok, type: byId[IDS.cx]!.type }, { d: 700_000, ok: false, type: "explorer" });
    assert.deepEqual({ d: byId[IDS.bySub]!.durationMs, ok: byId[IDS.bySub]!.ok, desc: byId[IDS.bySub]!.description }, { d: 10_000, ok: true, desc: "Find callers" });
    assert.ok(!nodes.some((x) => !x.sessionId), "linked subagents are not listed twice as in-session nodes");
  });

  it("pages top-level subagents with limit/cursor and keeps count as the full total", async () => {
    const first = await call("subagents", { sessionId: IDS.many });
    assert.equal((first.subagents as Node[]).length, 20, "default cap 20");
    assert.deepEqual({ count: first.count, topLevel: first.topLevel, next: first.nextCursor, truncated: first.truncated }, { count: 25, topLevel: 25, next: "20", truncated: true });
    const rest = await call("subagents", { sessionId: IDS.many, cursor: "20" });
    assert.deepEqual((rest.subagents as Node[]).map((x) => x.description), ["task 20", "task 21", "task 22", "task 23", "task 24"]);
    assert.equal(rest.nextCursor, undefined);
    assert.equal(rest.truncated, undefined);
    const small = await call("subagents", { sessionId: IDS.many, limit: 3 });
    assert.deepEqual({ n: (small.subagents as Node[]).length, next: small.nextCursor }, { n: 3, next: "3" });
    const bad = await mcp.server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "subagents", arguments: { sessionId: IDS.many, limit: 101 } } });
    assert.equal((bad!.result as { isError?: boolean }).isError, true);
  });
});

describe("latency", () => {
  it("ranks real tool latency; user, subagent and wait tools are reported apart", async () => {
    const r = await call("latency", { since: "7d" });
    const slow = (r.slowestTools as { tool: string }[]).map((x) => x.tool);
    assert.equal(slow[0], "WebFetch");
    for (const t of ["AskUserQuestion", "Agent", "wait_agent"]) {
      assert.ok(!slow.includes(t), `${t} is not in slowestTools`);
      assert.ok(!(r.slowestCalls as { tool: string }[]).some((x) => x.tool === t), `${t} is not in slowestCalls`);
    }
    assert.equal((r.slowestCalls as { tool: string }[])[0]!.tool, "WebFetch");
    const waiting = Object.fromEntries((r.waitingTools as { tool: string; waitsOn: string; maxMs: number }[]).map((x) => [x.tool, x]));
    assert.deepEqual({ kind: waiting.AskUserQuestion!.waitsOn, ms: waiting.AskUserQuestion!.maxMs }, { kind: "human", ms: 2 * H });
    assert.equal(waiting.Agent!.waitsOn, "subagent");
    assert.equal(waiting.wait_agent!.waitsOn, "subagent");
    assert.match(String(r.note), /waitingTools/);
  });
});

describe("running", () => {
  it("a session idle for over 30 minutes with no end is not running; one active a minute ago is", async () => {
    const r = await call("sessions_list", { since: "7d", limit: 100 });
    const s = Object.fromEntries((r.sessions as { id: string; running: boolean; lastActivityAt?: string }[]).map((x) => [x.id, x]));
    assert.equal(s[IDS.stale]!.running, false);
    assert.equal(s[IDS.stale]!.lastActivityAt, new Date(w.now - 5 * H + 2 * H + 6 * M + 1000).toISOString());
    assert.equal(s[IDS.parent]!.running, false);
    assert.equal(s[IDS.live]!.running, true);
    assert.equal(s[IDS.noCost]!.running, false);
  });

  it("session_current does not call a stale session running, and the digest says idle", async () => {
    const cur = await call("session_current", { cwd: stale() });
    assert.equal(cur.matchedBy, "cwd-recent");
    assert.equal((cur.session as { running: boolean }).running, false);
    const live = await call("session_current", { cwd: join(w.root, "repos", "docs") });
    assert.equal(live.matchedBy, "cwd-running");
    assert.equal((live.session as { id: string }).id, IDS.live);
    const md = await mcp.server.handle({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: `codingsh://session/${IDS.stale}` } });
    const text = (md!.result as { contents: { text: string }[] }).contents[0]!.text;
    assert.match(text, /\*\*Duration:\*\* 2h06m \(no end seen; idle since /);
    assert.doesNotMatch(text, /running/);
  });
});

describe("usage", () => {
  it("omits costUsd when no session reported a cost, and says topSessions is ranked by tokens", async () => {
    const r = await call("usage", { since: "7d", groupBy: "model", repo: stale() });
    const total = r.total as Record<string, unknown>;
    assert.equal("costUsd" in total, false, "unknown cost is not $0");
    assert.equal(total.outputTokens, 5300);
    for (const g of r.groups as Record<string, unknown>[]) assert.equal("costUsd" in g, false, `${String(g.key)} has no costUsd`);
    assert.equal(r.topSessionsRankedBy, "outputTokens");
    assert.deepEqual((r.topSessions as { id: string }[]).map((x) => x.id), [IDS.stale, IDS.noCost]);
    assert.match((r.notes as string[])[0]!, /costUsd is omitted/);
  });
});

describe("coding.sh mcp (stdio serve)", () => {
  // On Windows process.kill(pid, "SIGINT") terminates the server outright: no handler runs.
  it("exits 130 on the first Ctrl-C", { timeout: 20_000, skip: process.platform === "win32" && "SIGINT can't be caught on Windows" }, async () => {
    const child = spawn(process.execPath, ["--no-warnings", join(PKG, "src", "cli", "main.ts"), "mcp"], { env: { ...w.env, CODING_SH_NO_UPDATE_CHECK: "1" }, cwd: w.root, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
    try {
      // Wait until the server answers, so SIGINT lands while it is serving.
      await new Promise<void>((resolve, reject) => {
        let buf = "";
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (c: string) => {
          buf += c;
          if (buf.includes('"id":1')) resolve();
        });
        child.on("exit", () => reject(new Error(`exited before answering: ${buf}`)));
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
      });
      child.kill("SIGINT");
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3000).unref());
      const res = await Promise.race([exited, timeout]);
      assert.notEqual(res, "timeout", "still running 3s after one SIGINT (stdin left open)");
      assert.deepEqual(res, { code: 130, signal: null });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});
