// usage --baseline: each agent row against its published prompt-cache hit rate. Without the flag,
// usage prints and returns exactly what it did before. The MCP usage tool takes the same option.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { usage } from "../../src/mcp/data.ts";
import { createCodingShMcp } from "../../src/mcp/server.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import type { Session } from "../../src/schema/index.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, session } from "../query/_seed.ts";

const now = Date.now() - 3_600_000;
const mk = (id: string, agent: string, read: number, input: number): Session =>
  session(id, {
    agent: agent as Session["agent"],
    model: "claude-sonnet-4-5",
    startedAt: now,
    endedAt: now + 60_000,
    stats: { events: 4, turns: 2, toolCalls: 1, toolErrors: 0, filesChanged: 0, usage: { inputTokens: input, outputTokens: 50, cacheReadTokens: read, cacheWriteTokens: 0, costUsd: 0.02 } },
  }) as Session;

// claude-code: 71% hit rate (-21pt against 91.9%); wrapper: no published rate.
const SESSIONS = [mk("cc", "claude-code", 710, 290), mk("wr", "wrapper", 500, 500)];

describe("usage --baseline", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions: SESSIONS });
  });
  after(() => env.restore());

  test("a signed point delta for Claude Code, - for an unknown agent, and the credited note", () => {
    const r = ok(["usage", "--by", "agent", "--baseline"]);
    const lines = r.stdout.trim().split("\n");
    assert.match(lines[0]!, /CACHE HIT\tVS PUBLISHED/);
    assert.match(lines.find((l) => l.startsWith("claude-code"))!, /\t71%\t92% \(-21pt\)\t/);
    assert.match(lines.find((l) => l.startsWith("wrapper"))!, /\t50%\t-\t/);
    assert.match(r.stderr, /Requesty's reported prompt-cache hit rate per coding agent for Apr 2026/);
    assert.match(r.stderr, /may differ from Requesty's denominator/);
  });

  test("--json rows carry cacheBaseline only for a listed agent, plus the note", () => {
    const j = JSON.parse(ok(["usage", "--by", "agent", "--baseline", "--json"]).stdout);
    const cc = j.groups.find((g: { key: string }) => g.key === "claude-code");
    assert.deepEqual(cc.cacheBaseline, { rate: 0.919, source: "requesty", period: "2026-04", delta: -0.209 });
    assert.equal(j.groups.find((g: { key: string }) => g.key === "wrapper").cacheBaseline, undefined);
    assert.ok(j.notes.some((n: string) => n.includes("directional")));
    const am = JSON.parse(ok(["usage", "--by", "agent-model", "--baseline", "--json"]).stdout);
    assert.equal(am.groups.find((g: { key: string }) => g.key === "claude-code claude-sonnet-4-5").cacheBaseline.delta, -0.209);
  });

  test("the MCP usage tool takes baseline and returns the same rows", async () => {
    const mcp = createCodingShMcp({ env: { ...process.env, CODING_SH_NO_AUTO_INGEST: "1" }, cwd: env.root, ingestIntervalMs: 0, ingestBudgetMs: 0, log: () => {} });
    try {
      const call = async (args: Record<string, unknown>) => {
        const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "usage", arguments: args } });
        const res = r!.result as { structuredContent: { groups: { key: string; cacheBaseline?: unknown }[]; notes?: string[] }; isError?: boolean };
        assert.notEqual(res.isError, true);
        return res.structuredContent;
      };
      const withB = await call({ since: "1d", groupBy: "agent", baseline: true });
      const cli = JSON.parse(ok(["usage", "--by", "agent", "--baseline", "--json", "--since", "1d"]).stdout);
      assert.deepEqual(withB.groups.map((g) => [g.key, g.cacheBaseline]), cli.groups.map((g: { key: string; cacheBaseline?: unknown }) => [g.key, g.cacheBaseline]));
      assert.ok(withB.notes?.some((n) => n.includes("Requesty")));
      const without = await call({ since: "1d", groupBy: "agent" });
      assert.ok(!without.groups.some((g) => g.cacheBaseline));
    } finally {
      await mcp.close();
    }
  });

  test("without --baseline nothing changes; --baseline needs an agent grouping", () => {
    const plain = ok(["usage", "--by", "agent"]);
    assert.doesNotMatch(plain.stdout, /VS PUBLISHED|CACHE HIT/);
    assert.match(plain.stdout, /CACHE READ/);
    assert.doesNotMatch(plain.stderr, /Requesty/);
    assert.doesNotMatch(ok(["usage", "--by", "agent", "--json"]).stdout, /cacheBaseline|Requesty/);
    for (const by of ["day", "model", "repo"]) assert.equal(cli(["usage", "--by", by, "--baseline"]).status, 2, by);
  });
});

describe("usage() data: baseline option", () => {
  test("never under day, model or repo; only with the option", async () => {
    const index = new MemoryIndexStore();
    for (const s of SESSIONS) await index.upsertSession(s);
    const q = { since: now - 86_400_000, topLevel: false };
    const rows = async (by: "agent" | "day" | "model" | "repo", baseline: boolean) => ((await usage(index, q, by, 10, { baseline })) as { groups: { key: string; cacheBaseline?: unknown }[] }).groups;
    assert.ok((await rows("agent", true)).some((g) => g.cacheBaseline));
    assert.ok(!(await rows("agent", false)).some((g) => g.cacheBaseline));
    for (const by of ["day", "model", "repo"] as const) assert.ok(!(await rows(by, true)).some((g) => g.cacheBaseline), by);
  });
});
