import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MAX_DATE_MS } from "../../src/core/dates.ts";
import { iso, localDay, sessionSummary, usage } from "../../src/mcp/data.ts";
import { createCodingShMcp } from "../../src/mcp/server.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { sandbox } from "../cli/_cmd.ts";

const T0 = Date.parse("2026-11-01T10:00:00Z");
const FAR = MAX_DATE_MS + 1;
const PAST = -MAX_DATE_MS - 1;

const mkSession = (id: string, startedAt: number, endedAt?: number): Session => {
  const s: Session = {
    id,
    agent: "claude-code",
    startedAt,
    flags: [],
    stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } },
  };
  if (endedAt !== undefined) s.endedAt = endedAt;
  return s;
};

describe("mcp/data date range handling", () => {
  it("iso and localDay read times outside the Date range as missing", () => {
    assert.equal(iso(T0), "2026-11-01T10:00:00.000Z");
    assert.equal(iso(FAR), undefined);
    assert.equal(iso(PAST), undefined);
    assert.equal(iso(1e300), undefined);
    assert.equal(localDay(FAR), "unknown");
    assert.equal(localDay(PAST), "unknown");
    assert.equal(localDay(1e300), "unknown");
  });

  it("sessionSummary and usage by day leave out-of-range times missing while keeping other sessions", async () => {
    const store = new MemoryIndexStore();
    const good = mkSession("s-good", T0, T0 + 1_000);
    const far = mkSession("s-far", FAR, 1e300);
    await store.upsertSession(good);
    await store.upsertSession(far);

    const sumFar = sessionSummary(far, T0 + 5_000);
    assert.equal(sumFar.startedAt, undefined);
    assert.equal(sumFar.endedAt, undefined);
    const sumGood = sessionSummary(good, T0 + 5_000);
    assert.equal(sumGood.startedAt, "2026-11-01T10:00:00.000Z");

    const out = (await usage(store, { topLevel: false }, "day", 20)) as { groups: { key: string; sessions: number }[] };
    assert.equal(out.groups.length, 2);
    assert.ok(out.groups.some((g) => g.key === "unknown" && g.sessions === 1));
    assert.ok(out.groups.some((g) => g.key !== "unknown" && g.sessions === 1));
  });
});

describe("mcp/tools eval_candidates date range handling", () => {
  const sb = sandbox();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  after(() => {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.USERPROFILE;
    sb.cleanup();
  });

  it("omits out-of-range startedAt on candidates and keeps valid candidates intact", async () => {
    const repo = join(sb.root, "repo");
    mkdirSync(repo);
    Object.assign(process.env, { HOME: sb.env.HOME, USERPROFILE: sb.env.HOME });
    const now = Date.now();
    const sOk: Session = {
      id: "cand-ok",
      agent: "claude-code",
      cwd: repo,
      repo: { root: repo, head: "abc1234" },
      title: "Fix widget",
      startedAt: now - 3600_000,
      endedAt: now - 3500_000,
      flags: [],
      stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 1 },
    };
    const sFar: Session = {
      id: "cand-far",
      agent: "claude-code",
      cwd: repo,
      repo: { root: repo, head: "abc1234" },
      title: "Far session",
      startedAt: FAR,
      flags: [],
      stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 1 },
    };
    const evs: AgentEvent[] = [
      { id: "ok-1", v: 0, sessionId: sOk.id, ts: sOk.startedAt, agent: "claude-code", kind: "user.message", payload: { text: "Fix widget" }, cwd: repo, repo: { root: repo, head: "abc1234" } },
      { id: "ok-2", v: 0, sessionId: sOk.id, ts: sOk.startedAt + 1000, agent: "claude-code", kind: "file.change", payload: { path: "a.ts", op: "modify" }, cwd: repo, repo: { root: repo, head: "abc1234" } },
      { id: "far-1", v: 0, sessionId: sFar.id, ts: FAR, agent: "claude-code", kind: "user.message", payload: { text: "Far task" }, cwd: repo, repo: { root: repo, head: "abc1234" } },
      { id: "far-2", v: 0, sessionId: sFar.id, ts: FAR, agent: "claude-code", kind: "file.change", payload: { path: "b.ts", op: "modify" }, cwd: repo, repo: { root: repo, head: "abc1234" } },
    ];
    await sb.seed([sOk, sFar], evs);

    const mcp = createCodingShMcp({ env: sb.env, cwd: repo });
    try {
      const r = await mcp.server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "eval_candidates", arguments: { repo: "all", includeRejected: true } },
      });
      const res = r!.result as { isError?: boolean; structuredContent: { candidates: { sessionId: string; startedAt?: string }[] } };
      assert.notEqual(res.isError, true);
      assert.equal(res.structuredContent.candidates.length, 2);
      const farRow = res.structuredContent.candidates.find((c) => c.sessionId === sFar.id)!;
      const okRow = res.structuredContent.candidates.find((c) => c.sessionId === sOk.id)!;
      assert.equal(farRow.startedAt, undefined);
      assert.equal(okRow.startedAt, new Date(sOk.startedAt).toISOString());
    } finally {
      await mcp.close();
    }
  });
});
