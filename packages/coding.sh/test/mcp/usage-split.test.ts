// The MCP usage tool splits the estimate by token type: dollars to 4 decimals that add up to
// the estimate, shares that add up to 1, per group and in all, and a note that names what has
// no split. Sessions come from events priced as ingest prices them.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openContext } from "../../src/core/context.ts";
import { priceEvent, pricesFor, TOKEN_TYPES } from "../../src/core/pricing.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import type { AgentEvent, CostByTokenType } from "../../src/schema/index.ts";
import { schemaViolations } from "../../src/toolevals/jsonschema.ts";
import { cleanup, makeWorld, type World } from "./helpers.ts";

type Row = { key?: string; costUsd?: number; estimatedCostUsd?: number; estimatedCostByTokenType?: CostByTokenType; estimatedCostShareByTokenType?: CostByTokenType; estimatedCostUnsplitUsd?: number };

const AGENT_HOMES = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "T3CODE_HOME"];
const saved: Record<string, string | undefined> = {};
let w: World;
let mcp: CodingShMcp;
let tools: { name: string; outputSchema: Record<string, unknown> }[];
/** The calls' own parts, summed per agent and in all. */
const want: Record<string, CostByTokenType> = {};

let n = 0;
function ev(sessionId: string, agent: string, ts: number, kind: AgentEvent["kind"], extra: Partial<AgentEvent> = {}): AgentEvent {
  return { id: `${sessionId}-${n++}`, v: 0, sessionId, agent, ts, kind, payload: {}, source: "transcript", ...extra };
}

function session(id: string, agent: string, t0: number, calls: Partial<AgentEvent>[]): AgentEvent[] {
  const evs = [ev(id, agent, t0, "session.start"), ...calls.map((c, i) => priceEvent(ev(id, agent, t0 + 10 + i, "llm.call", c), pricesFor())), ev(id, agent, t0 + 100, "session.end")];
  for (const e of evs) {
    const parts = e.payload.costByTokenType as CostByTokenType | undefined;
    if (!parts) continue;
    for (const key of [agent, "total"]) {
      const sum = (want[key] ??= { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 });
      for (const k of TOKEN_TYPES) sum[k] += parts[k];
    }
  }
  return evs;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const res = r!.result as { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] };
  assert.notEqual(res.isError, true, `${name}: ${res.content?.[0]?.text}`);
  const sc = JSON.parse(JSON.stringify(res.structuredContent)) as Record<string, unknown>;
  assert.deepEqual(schemaViolations(sc, tools.find((t) => t.name === name)!.outputSchema), [], `${name} output matches its outputSchema`);
  return sc;
}

before(async () => {
  w = makeWorld();
  // Nothing here reads an agent's home: the server's ingest is a no-op, and HOME points at the world.
  for (const k of AGENT_HOMES) saved[k] = process.env[k];
  for (const k of AGENT_HOMES) delete process.env[k];
  Object.assign(process.env, { HOME: w.env.HOME, USERPROFILE: w.env.HOME });
  const t0 = w.now - 3600e3;
  const sessions = [
    session("split-opus", "claude-code", t0, [
      { model: "claude-opus-4-5", usage: { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 123_456, cacheWriteTokens: 7890 } },
      { model: "claude-opus-4-5", usage: { outputTokens: 891, cacheReadTokens: 234_567 } },
    ]),
    session("split-codex", "codex", t0 + 1000, [{ model: "gpt-5.1-codex", usage: { inputTokens: 3333, outputTokens: 2222, cacheReadTokens: 77_777 } }]),
    session("reported", "opencode", t0 + 2000, [{ model: "claude-opus-4-5", usage: { inputTokens: 100, costUsd: 0.25 } }]),
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
  mcp = createCodingShMcp({ env: w.env, cwd: w.root, log: () => {}, now: () => w.now, autoIngest: async () => ({ pendingFiles: 0, indexing: false }) });
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 0, method: "tools/list" });
  tools = (r!.result as { tools: typeof tools }).tools;
});

after(async () => {
  await mcp?.close();
  cleanup();
  for (const k of AGENT_HOMES) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The row's split: dollars that add up to its 4-decimal estimate, each within a unit of the calls' parts, and shares that add up to 1. */
function checkSplit(row: Row, parts: CostByTokenType) {
  const usd = row.estimatedCostByTokenType!;
  const share = row.estimatedCostShareByTokenType!;
  assert.deepEqual(Object.keys(usd), [...TOKEN_TYPES]);
  assert.deepEqual(Object.keys(share), [...TOKEN_TYPES]);
  const est = TOKEN_TYPES.reduce((x, k) => x + parts[k], 0);
  assert.equal(Math.round(TOKEN_TYPES.reduce((x, k) => x + usd[k], 0) * 1e4), Math.round(row.estimatedCostUsd! * 1e4), "the dollars add up to the estimate");
  assert.equal(Math.round(TOKEN_TYPES.reduce((x, k) => x + share[k], 0) * 1e3), 1000, "the shares add up to 1");
  for (const k of TOKEN_TYPES) {
    assert.ok(Math.abs(usd[k] - parts[k]) <= 1e-4 + 1e-12, `${k}: $${usd[k]} vs ${parts[k]}`);
    assert.ok(Math.abs(share[k] - parts[k] / est) <= 1e-3 + 1e-12, `${k}: share ${share[k]} vs ${parts[k] / est}`);
  }
}

describe("usage: the estimate by token type", () => {
  it("splits the estimate in all and per agent; the reported cost has no split", async () => {
    const d = await call("usage", { groupBy: "agent" });
    const total = d.total as Row;
    checkSplit(total, want.total!);
    assert.equal(total.estimatedCostUnsplitUsd, undefined, "every estimate has a split");
    assert.ok(Math.abs(total.costUsd! - total.estimatedCostUsd! - 0.25) < 1e-9, "the reported $0.25 is in the cost, not the estimate");
    const groups = d.groups as Row[];
    for (const agent of ["claude-code", "codex"]) checkSplit(groups.find((g) => g.key === agent)!, want[agent]!);
    const reported = groups.find((g) => g.key === "opencode")!;
    assert.deepEqual([reported.costUsd, reported.estimatedCostByTokenType, reported.estimatedCostShareByTokenType, reported.estimatedCostUnsplitUsd], [0.25, undefined, undefined, undefined]);
  });

  it("the note gives the parts cache reads first and names the reported cost", async () => {
    const d = await call("usage", { groupBy: "agent" });
    const total = d.total as Row;
    const note = (d.notes as string[]).find((x) => x.startsWith("The estimate by token type:"));
    assert.ok(note, (d.notes as string[]).join("\n"));
    const usd = total.estimatedCostByTokenType!;
    assert.ok(note.startsWith(`The estimate by token type: cache reads $${usd.cacheRead} (`), note);
    assert.match(note, /, cache writes \$[\d.]+ \(\d+%\), uncached input \$[\d.]+ \(\d+%\), output \$[\d.]+ \(\d+%\) \(estimatedCostByTokenType; shares in estimatedCostShareByTokenType\)\. Not split by token type: \$0\.25 reported or billed\.$/);
    const pcts = [...note.matchAll(/\((\d+)%\)/g)].map((m) => Number(m[1]));
    assert.equal(pcts.reduce((x, y) => x + y, 0), 100, "the percentages add up to 100");
  });

  it("a window with only the reported cost has no split and no note", async () => {
    const d = await call("usage", { agent: "opencode" });
    const total = d.total as Row;
    assert.deepEqual([total.costUsd, total.estimatedCostByTokenType, total.estimatedCostShareByTokenType], [0.25, undefined, undefined]);
    assert.ok(!(d.notes as string[] | undefined ?? []).some((x) => /by token type/.test(x)));
  });
});
