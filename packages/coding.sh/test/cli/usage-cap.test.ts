// `usage` and `cache doctor` total every session in the window, past the 2,000 a list scan
// reads, and say so when they do stop (CODING_SH_SCAN_CAP forces a small stop here).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { ok, seed, session } from "../query/_seed.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { usage } from "../../src/mcp/data.ts";
import type { Usage } from "../../src/schema/index.ts";

const N = 2500;
const now = Date.now() - 3_600_000;
/** Session 7 adds output and a cost, session 2400 a cache read. */
function usageOf(i: number): Usage {
  if (i === 7) return { inputTokens: 1, outputTokens: 9, costUsd: 0.5 };
  if (i === 2400) return { inputTokens: 1, cacheReadTokens: 3 };
  return { inputTokens: 1 };
}
/** One input token each; every tenth is a codex session, and session 7 costs the most. */
const one = (i: number) =>
  session(`s${String(i).padStart(4, "0")}`, {
    agent: i % 10 === 0 ? "codex" : "claude-code",
    startedAt: now - i * 1000,
    endedAt: now - i * 1000 + 500,
    stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: usageOf(i) },
  });
const sessions = Array.from({ length: N }, (_, i) => one(i));

describe("usage over more than 2,000 sessions", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions });
  });
  after(() => env.restore());

  test("usage --json totals all 2,500 sessions and is not truncated", () => {
    const j = JSON.parse(ok(["usage", "--json"]).stdout) as { window: { sessions: number; truncated?: boolean }; total: { sessions: number; inputTokens: number; turns: number }; groups: { key: string; sessions: number }[]; topSessions: { id: string }[] };
    assert.equal(j.window.sessions, N);
    assert.equal(j.window.truncated, undefined);
    assert.equal(j.total.sessions, N);
    assert.equal(j.total.inputTokens, N);
    assert.equal(j.total.turns, N);
    assert.deepEqual(Object.fromEntries(j.groups.map((g) => [g.key, g.sessions])), { "claude-code": N - N / 10, codex: N / 10 });
    assert.deepEqual(j.topSessions.map((s) => s.id), ["s0007"]);
  });

  test("the table has no stopped line when nothing was left out", () => {
    const r = ok(["usage"]);
    assert.match(r.stdout, /^claude-code\s+2250\s/m);
    assert.doesNotMatch(r.stderr, /Stopped after/);
  });

  test("a scan that stops says so under the table and keeps truncated in --json", () => {
    const cap = { CODING_SH_SCAN_CAP: "1000" };
    const r = ok(["usage"], cap);
    assert.match(r.stdout, /^claude-code\s+900\s/m);
    assert.match(r.stderr, /^! Stopped after 1,000 sessions: narrow --since or --where\.$/m);
    assert.match(ok(["usage", "--cache"], cap).stderr, /^! Stopped after 1,000 sessions/m);
    const j = JSON.parse(ok(["usage", "--json"], cap).stdout) as { window: { sessions: number; truncated?: boolean } };
    assert.deepEqual([j.window.sessions, j.window.truncated], [1000, true]);
  });

  test("cache doctor reads the same sessions as usage", () => {
    const j = JSON.parse(ok(["cache", "doctor", "--json"]).stdout) as { sessions: number; truncated?: boolean; promptTokens: number };
    assert.equal(j.sessions, N);
    assert.equal(j.truncated, undefined);
    assert.equal(j.promptTokens, N + 3);
    const capped = ok(["cache", "doctor"], { CODING_SH_SCAN_CAP: "1000" });
    assert.match(capped.stderr, /^! Stopped after 1,000 sessions: narrow --since or --where\.$/m);
  });
});

test("usage() names the five costliest sessions without keeping the rows, in the order a full sort gives", async () => {
  const index = new MemoryIndexStore();
  const cost = [0.2, 0.9, 0.2, undefined, 0.5, 0.9, 0.1, 0.3];
  for (const [i, c] of cost.entries()) await index.upsertSession(session(`c${i}`, { startedAt: now - i * 1000, stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: c !== undefined ? { inputTokens: 1, outputTokens: 10 + i, costUsd: c } : { inputTokens: 1, outputTokens: 10 + i } } }));
  const r = (await usage(index, { since: now - 86_400_000, topLevel: false }, "agent", 20)) as { topSessions: { id: string }[]; topSessionsRankedBy: string; window: { sessions: number } };
  // Cost first, output tokens among equal costs: c5 (0.9, 15 out) before c1 (0.9, 11 out).
  assert.deepEqual(r.topSessions.map((s) => s.id), ["c5", "c1", "c4", "c7", "c2"]);
  assert.equal(r.topSessionsRankedBy, "costUsd");
  assert.equal(r.window.sessions, cost.length);
  const capped = (await usage(index, { since: now - 86_400_000, topLevel: false }, "agent", 20, { cap: 3 })) as { window: { sessions: number; truncated?: boolean } };
  assert.deepEqual([capped.window.sessions, capped.window.truncated], [3, true]);
});
