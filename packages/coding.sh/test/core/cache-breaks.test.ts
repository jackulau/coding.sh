import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheBreakStats, cacheUnderused, findCacheBreaks } from "../../src/core/cache-breaks.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, EventKind, Usage } from "../../src/schema/index.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 7, 9);
let n = 0;
let clock = T0;
const reset = () => {
  n = 0;
  clock = T0;
};
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> & { gap?: number } = {}): AgentEvent => {
  const { gap = 1000, ...rest } = o;
  clock += gap;
  return { id: `e${++n}`, v: 0, sessionId: "s", ts: clock, agent: "claude-code", kind, payload, ...rest };
};
/** A model call: `read` tokens from cache, `write` written, 40 uncached. */
const call = (read: number, write: number, o: Partial<AgentEvent> & { gap?: number; usage?: Usage } = {}) =>
  ev("llm.call", { ok: true }, { model: "claude-opus-5-5", usage: { inputTokens: 40, outputTokens: 200, cacheReadTokens: read, cacheWriteTokens: write }, ...o });

/** Five calls whose cache reads grow, each writing 2k more. */
function warm(): AgentEvent[] {
  reset();
  const out = [call(0, 100_000)];
  for (let i = 0; i < 4; i++) out.push(call(100_000 + i * 2000, 2000));
  return out;
}

describe("cache breaks", () => {
  it("a drop to no cache reads after 6 idle minutes is one idle break, priced at write minus read", () => {
    const events = [...warm(), call(0, 120_000, { gap: 6 * MIN })];
    const breaks = findCacheBreaks(events);
    assert.equal(breaks.length, 1);
    const prevP = 40 + 106_000 + 2000;
    const b = breaks[0]!;
    assert.deepEqual([b.cause, b.eventId, b.prevEventId, b.lostTokens], ["idle", "e6", "e5", Math.min(prevP, 120_040)]);
    assert.equal(b.gapMs, 6 * MIN);
    // claude-opus-5-5: cache write $5/M, cache read $0.20/M.
    const hand = (b.lostTokens * (5 - 0.2)) / 1e6;
    assert.ok(Math.abs(b.extraUsd! - hand) <= hand * 0.001, `${b.extraUsd} vs ${hand}`);
    assert.deepEqual(cacheBreakStats(breaks), {
      count: 1,
      lostTokens: b.lostTokens,
      extraUsd: Math.round(hand * 1e6) / 1e6,
      byCause: { idle: { count: 1, lostTokens: b.lostTokens, extraUsd: Math.round(hand * 1e6) / 1e6 } },
    });
  });

  it("names the cause: compaction, then model switch, then idle, else other", () => {
    const compacted = [...warm(), ev("context.compact", { trigger: "auto" }, { gap: 10 * MIN }), call(0, 30_000)];
    assert.equal(findCacheBreaks(compacted)[0]?.cause, "compaction", "compaction wins over the idle gap");
    const switched = [...warm(), call(0, 110_000, { model: "claude-sonnet-4-5", gap: 10 * MIN })];
    assert.equal(findCacheBreaks(switched)[0]?.cause, "model-switch");
    const other = [...warm(), call(0, 110_000, { gap: 2 * MIN })];
    assert.equal(findCacheBreaks(other)[0]?.cause, "other");
  });

  it("an hour-long cache write moves the idle line to an hour", () => {
    reset();
    const events = [call(0, 50_000), call(50_000, 1000, { payload: { ok: true, cacheWrite1hTokens: 1000 } }), call(0, 52_000, { gap: 30 * MIN })];
    assert.equal(findCacheBreaks(events)[0]?.cause, "other");
  });

  it("thresholds: previous prompt over 4096, reads under half of it, more than 2048 lost", () => {
    reset();
    // Previous prompt exactly 4096: not big enough.
    assert.equal(findCacheBreaks([call(0, 4056), call(0, 4056)]).length, 0);
    reset();
    assert.equal(findCacheBreaks([call(0, 4057), call(0, 4057)]).length, 1);
    // Reads exactly half the previous prompt: kept.
    reset();
    assert.equal(findCacheBreaks([call(0, 9960), call(5000, 5000)]).length, 0);
    reset();
    assert.equal(findCacheBreaks([call(0, 9960), call(4999, 5000)]).length, 1);
    // Exactly 2048 lost: not a break (a shorter prompt loses less).
    reset();
    assert.equal(findCacheBreaks([call(0, 9960), call(0, 2008)]).length, 0);
    reset();
    assert.equal(findCacheBreaks([call(0, 9960), call(0, 2009)]).length, 1);
  });

  it("a subagent never compares against its parent, and calls without cache fields give nothing", () => {
    reset();
    const scoped = [call(0, 50_000), call(0, 50_000, { sessionId: "s", subagentId: "a1" }), call(50_000, 100)];
    assert.equal(findCacheBreaks(scoped).length, 0);
    reset();
    const plain = [call(0, 0, { usage: { inputTokens: 50_000, outputTokens: 10 } }), call(0, 0, { usage: { inputTokens: 51_000, outputTokens: 10 } })];
    assert.equal(findCacheBreaks(plain).length, 0);
  });

  it("an unknown model is counted but unpriced", () => {
    const events = [...warm(), call(0, 110_000, { model: "local-mystery-1", gap: 10 })].map((e) => ({ ...e, model: "local-mystery-1" }));
    const stats = cacheBreakStats(findCacheBreaks(events))!;
    assert.equal(stats.count, 1);
    assert.equal(stats.unpriced, 1);
    assert.equal(stats.extraUsd, undefined);
    assert.equal(stats.byCause.other?.extraUsd, undefined);
  });

  it("buildSession stores the stats only when a break happened", () => {
    const steady = warm();
    assert.equal(buildSession(steady).stats.cacheBreaks, undefined);
    const broke = buildSession([...steady, call(0, 110_000, { gap: 6 * MIN })]);
    assert.equal(broke.stats.cacheBreaks?.count, 1);
    assert.equal(broke.stats.cacheBreaks?.byCause.idle?.count, 1);
  });

  it("skips gateway companions and replayed calls", () => {
    const events = [...warm(), call(0, 110_000, { source: "gateway" }), call(0, 110_000, { payload: { ok: true, replay: true } })];
    assert.equal(findCacheBreaks(events).length, 0);
  });
});

describe("cache underused (cache:low)", () => {
  it("fires only over enough turns, with a cache written, when reads trail writes", () => {
    assert.equal(cacheUnderused({ cacheWriteTokens: 10_000, cacheReadTokens: 2000 }, 3), true);
    assert.equal(cacheUnderused({ cacheWriteTokens: 10_000, cacheReadTokens: 20_000 }, 3), false, "reads above writes: cache is being reused");
    assert.equal(cacheUnderused({ cacheWriteTokens: 10_000, cacheReadTokens: 2000 }, 2), false, "too few turns to have reused it");
    assert.equal(cacheUnderused({ cacheWriteTokens: 1000, cacheReadTokens: 0 }, 5), false, "no real cache block written");
    assert.equal(cacheUnderused({}, 5), false, "no cache written at all: the agent's behaviour, not a setup to fix");
  });

  const prompt = (i: number) => ev("user.message", { text: `prompt ${i}` });

  it("buildSession tags cache:low when a multi-turn session wrote a cache it barely read back", () => {
    reset();
    const churn = [prompt(1), call(0, 5000), prompt(2), call(0, 5000), prompt(3), call(0, 5000)];
    const s = buildSession(churn);
    assert.equal(s.stats.turns >= 3, true);
    assert.equal(s.flags.includes("cache:low"), true);
  });

  it("buildSession leaves a healthy session (reads above writes) untagged", () => {
    reset();
    const healthy = [prompt(1), call(0, 5000), prompt(2), call(5000, 500), prompt(3), call(5400, 500)];
    const s = buildSession(healthy);
    assert.equal(s.flags.includes("cache:low"), false);
  });

  it("a model fallback mid-session is a priced model-switch break, and tags model:switch", () => {
    reset();
    // Warm the cache on claude-opus-5-5, then fall back to opus-4-8: cache reads collapse to zero on the first call there.
    const events = [prompt(1), call(0, 100_000), prompt(2), call(100_000, 2000), prompt(3), call(0, 100_000, { model: "claude-opus-4-8" }), prompt(4), call(100_000, 2000, { model: "claude-opus-4-8" })];
    const s = buildSession(events);
    assert.equal(s.stats.cacheBreaks?.byCause["model-switch"]?.count, 1, "the fallback is named as the cause");
    assert.ok((s.stats.cacheBreaks?.extraUsd ?? 0) > 0, "the rebuild is priced over the cache-read rate");
    assert.ok(s.flags.includes("model:switch"), "built on the existing model:switch flag");
  });
});
