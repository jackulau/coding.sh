// Regressions from round-3 QA of the MCP server against a real backfilled store:
// turns started by background-task notifications, and the session resource's
// subagent list.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { splitTurns } from "../../src/mcp/data.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { schemaViolations } from "../../src/toolevals/jsonschema.ts";
import { cleanup, makeWorld, type World } from "./helpers.ts";

const H = 3600e3;
let n = 0;
function ev(sessionId: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown> = {}, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `${sessionId}-r${n++}`, v: 0, sessionId, agent: "claude-code", ts, kind, payload, source: "transcript", ...extra };
}

let w: World;
let mcp: CodingShMcp;
let tools: { name: string; outputSchema: Record<string, unknown> }[];
const IDS = { notified: "r3-notified", fan: "r3-fanout" };

async function raw(name: string, args: Record<string, unknown> = {}) {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r!.result as { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await raw(name, args);
  assert.notEqual(res.isError, true, `${name}: ${res.content?.[0]?.text}`);
  const sc = JSON.parse(JSON.stringify(res.structuredContent)) as Record<string, unknown>;
  assert.deepEqual(schemaViolations(sc, tools.find((t) => t.name === name)!.outputSchema), [], `${name} output matches its outputSchema`);
  return sc;
}

/** A prompt, then `k` background-task notifications that each start a turn, as a transcript records them. */
function notifiedSession(id: string, t0: number, k: number): AgentEvent[] {
  const out = [ev(id, t0, "session.start"), ev(id, t0, "user.message", { text: "run the checks in the background" }, { turnId: "t0" })];
  out.push(ev(id, t0 + 10, "tool.start", { tool: "Bash", toolUseId: "b0", input: { command: "npm test", run_in_background: true } }, { turnId: "t0" }));
  out.push(ev(id, t0 + 20, "tool.end", { tool: "Bash", toolUseId: "b0", ok: true }, { turnId: "t0", durationMs: 10 }));
  out.push(ev(id, t0 + 100, "turn.end", { synthesized: true }, { turnId: "t0" }));
  for (let i = 1; i <= k; i++) {
    const t = t0 + i * 1000;
    out.push(ev(id, t, "notification", { kind: "task-notification", text: `<task-notification>\n<task-id>b${i}</task-id>\n<status>completed</status>\n</task-notification>` }, { turnId: `t${i}` }));
    out.push(ev(id, t + 10, "assistant.message", { text: `check ${i} passed` }, { turnId: `t${i}` }));
    out.push(ev(id, t + 100, "turn.end", { synthesized: true }, { turnId: `t${i}` }));
  }
  // A background subagent still running after the last turn ends is not a turn.
  out.push(ev(id, t0 + (k + 1) * 1000, "subagent.start", { subagentId: "late", type: "Explore" }));
  out.push(ev(id, t0 + (k + 1) * 1000 + 5, "session.end", { reason: "idle" }));
  return out;
}

before(async () => {
  w = makeWorld();
  Object.assign(process.env, { HOME: w.env.HOME, USERPROFILE: w.env.HOME });
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.T3CODE_HOME;
  delete process.env.CODEX_HOME;
  const now = w.now;
  const sessions: AgentEvent[][] = [notifiedSession(IDS.notified, now - 2 * H, 3)];

  // A parent with 120 subagents, each with a long brief, and a long timeline.
  const F = IDS.fan;
  const f0 = now - 3 * H;
  const fan: AgentEvent[] = [ev(F, f0, "session.start", {}, { cwd: w.repo }), ev(F, f0 + 1, "user.message", { text: "fan out" })];
  for (let i = 0; i < 120; i++) {
    const sub = `sub${i}`;
    fan.push(ev(F, f0 + 10 + i * 10, "subagent.start", { subagentId: sub, type: "general-purpose", description: `Review part ${i} of the brief: ${"read every file under the module and report what each one does ".repeat(3)}` }));
    fan.push(ev(F, f0 + 15 + i * 10, "subagent.end", { subagentId: sub, ok: true }, { durationMs: 5 }));
  }
  for (let i = 0; i < 200; i++) fan.push(ev(F, f0 + 5000 + i, "assistant.message", { text: `step ${i}: ${"x".repeat(220)}` }));
  sessions.push(fan);

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

describe("turns a background-task notification starts", () => {
  it("session_get's turnCount agrees with session.turns, and every turn opens", async () => {
    const d = await call("session_get", { sessionId: IDS.notified, limit: 1 });
    const turns = (d.session as { turns: number }).turns;
    assert.equal(turns, 4, "stats count the prompt's turn and three notification turns");
    assert.equal(d.turnCount, turns);
    assert.equal((d.turns as unknown[]).length, turns);
    for (let t = 1; t <= turns; t++) {
      const one = await call("session_get", { sessionId: IDS.notified, turn: t });
      assert.equal(one.turn, t);
    }
    const last = await call("session_get", { sessionId: IDS.notified, turn: 4 });
    const kinds = (last.timeline as { kind: string }[]).map((e) => e.kind);
    assert.ok(kinds.includes("notification"), `turn 4 opens on its notification: ${kinds.join(",")}`);
  });

  it("prompts sent while a turn runs stay in it, as stats.turns counts it", () => {
    const S = "steer";
    const evs = [
      ev(S, 0, "user.message", { text: "do it" }),
      ev(S, 1, "user.message", { text: "and this too" }),
      ev(S, 2, "turn.end", {}),
      ev(S, 3, "user.message", { text: "next" }),
      ev(S, 4, "turn.end", {}),
    ];
    assert.equal(buildSession(evs).stats.turns, 2);
    assert.equal(splitTurns(evs).length, 2);
  });

  it("a session seen live and from its transcript still splits at each prompt", () => {
    const S = "dual";
    const live = { source: "hook" } as const;
    const evs = [
      ev(S, 0, "user.message", { text: "one" }),
      ev(S, 2, "turn.end", {}, live),
      ev(S, 2, "turn.end", {}),
      ev(S, 3, "user.message", { text: "two" }),
      ev(S, 4, "turn.end", {}, live),
      ev(S, 4, "turn.end", {}),
    ];
    assert.equal(buildSession(evs).stats.turns, 2);
    assert.equal(splitTurns(evs).length, 2);
  });
});

describe("codingsh://session/<id> resource", () => {
  it("stays under 25,000 characters and caps the subagent list with a pointer to the tools", async () => {
    const r = await mcp.server.handle({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: `codingsh://session/${IDS.fan}` } });
    const text = (r!.result as { contents: { text: string }[] }).contents[0]!.text;
    assert.ok(text.length < 25_000, `resource text is ${text.length} chars`);
    assert.match(text, /## Subagents \(120\)/);
    assert.match(text, /… \d+ more \(use the subagents or session_tree tool/);
    assert.match(text, /more entries \(use the session_get tool with a cursor\)/);
  });
});
