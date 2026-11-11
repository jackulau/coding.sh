import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { PRICING_RULES_VERSION, pricesFor } from "../../src/core/pricing.ts";
import { priceStamp, REPRICE_CURSOR, repriceStored } from "../../src/core/reprice.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { IndexStore } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { openIndexStore } from "../../src/store/factory.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const M = 1_000_000;
const ev = (id: string, o: Partial<AgentEvent>): AgentEvent => ({ id, v: 0, sessionId: "s1", ts: 1000, agent: "claude-code", kind: "llm.call", payload: {}, ...o });
/** Stored before local pricing: no costs, except one the agent reported and one estimated under old prices. */
const OLD: AgentEvent[] = [
  ev("start", { kind: "session.start", ts: 900 }),
  ev("plain", { model: "claude-opus-4-5", usage: { inputTokens: M } }), // $5
  ev("reported", { model: "claude-opus-4-5", usage: { inputTokens: M, costUsd: 9 } }),
  ev("stale", { model: "claude-opus-4-5", usage: { outputTokens: M, costUsd: 1 }, payload: { costEstimated: true } }), // $25 now
  ev("unknown", { model: "no-such-model", usage: { inputTokens: M } }),
  ev("billed", { model: "claude-opus-4-5", usage: { inputTokens: M } }),
  ev("gw", { kind: "span", source: "gateway", parentId: "billed", usage: { costUsd: 7 } }),
  ev("snap", { kind: "notification", model: "gpt-5.4", payload: { type: "usage-summary" }, usage: { outputTokens: M } }), // $15
];

async function seed(store: IndexStore) {
  await store.putEvents(OLD);
  await store.upsertSession({ ...buildSession(OLD), parent: { sessionId: "p", subagentId: "a" } });
}

const costs = async (store: IndexStore) => Object.fromEntries((await store.listEvents("s1")).map((e) => [e.id, e.usage?.costUsd]));

for (const [name, open] of [["memory", async () => new MemoryIndexStore()], ["sqlite", () => SqliteIndexStore.open(":memory:")]] as const) {
  describe(`repriceStored (${name})`, () => {
    it("fills missing estimates in place, keeps reported and gateway-billed costs, refolds session usage", async () => {
      const store = await open();
      await seed(store);
      const r = await repriceStored(store);
      assert.deepEqual(r, { ran: true, events: 3, sessions: 1 });
      assert.deepEqual(await costs(store), { start: undefined, plain: 5, reported: 9, stale: 25, unknown: undefined, billed: undefined, gw: 7, snap: 15 });
      const events = await store.listEvents("s1");
      assert.deepEqual(events.map((e) => e.id).sort(), OLD.map((e) => e.id).sort(), "same ids, no new rows");
      assert.equal(events.find((e) => e.id === "plain")!.payload.costEstimated, true);
      assert.equal(events.find((e) => e.id === "reported")!.payload.costEstimated, undefined);
      const s = (await store.getSession("s1"))!;
      assert.equal(s.stats.usage?.costUsd, 5 + 9 + 25 + 7 + 15);
      assert.deepEqual(s.parent, { sessionId: "p", subagentId: "a" }, "only usage is refolded");
      await store.close();
    });

    it("runs once per price table, and again when [pricing] changes", async () => {
      const store = await open();
      await seed(store);
      await repriceStored(store);
      assert.ok((await store.getCursor(REPRICE_CURSOR)) > 0);
      assert.deepEqual(await repriceStored(store), { ran: false, events: 0, sessions: 0 });
      const r = await repriceStored(store, { "claude-opus-4-5": { input: 1, output: 1 } });
      assert.equal(r.ran, true);
      const c = await costs(store);
      assert.deepEqual([c.plain, c.stale, c.reported, c.billed], [1, 1, 9, undefined], "our estimates follow the table; reported and billed stay");
      await store.close();
    });

    it("marks the session's estimated part: reported and gateway-billed costs are not estimates", async () => {
      const store = await open();
      await seed(store);
      await repriceStored(store);
      const u = (await store.getSession("s1"))!.stats.usage!;
      assert.equal(u.costUsd, 61);
      assert.equal(u.estimatedCostUsd, 5 + 25 + 15);
      await store.close();
    });

    it("prices a call whose gateway companion carries no cost: nothing billed it", async () => {
      const store = await open();
      const evs = [ev("call", { model: "claude-opus-4-5", usage: { inputTokens: M } }), ev("gw", { kind: "span", source: "gateway", parentId: "call", payload: { gateway: "cliproxyapi", promptTokens: M } })];
      await store.putEvents(evs);
      await store.upsertSession(buildSession(evs));
      assert.deepEqual(await repriceStored(store), { ran: true, events: 1, sessions: 1 });
      const u = (await store.getSession("s1"))!.stats.usage!;
      assert.deepEqual([u.costUsd, u.estimatedCostUsd], [5, 5]);
      await store.close();
    });

    it("prices stored 2026 models, records the sibling a fallback used, and drops it when the model gets its own row", async () => {
      const store = await open();
      const evs = [
        // Prompts under OpenAI's 272K long-context threshold.
        ev("exact", { model: "gpt-6.1-sol", usage: { inputTokens: 125_000, cacheWriteTokens: 100_000 } }), // 0.25 + 0.25
        ev("sibling", { model: "gpt-6.2-sol", usage: { inputTokens: 125_000 } }), // as gpt-6.1-sol: 0.25
        ev("paid", { model: "gpt-6.1-sol", usage: { inputTokens: M, costUsd: 1 } }),
      ];
      await store.putEvents(evs);
      await store.upsertSession(buildSession(evs));
      assert.deepEqual(await repriceStored(store), { ran: true, events: 2, sessions: 1 });
      const byId = async () => Object.fromEntries((await store.listEvents("s1")).map((e) => [e.id, e]));
      let e = await byId();
      assert.deepEqual([e.exact!.usage?.costUsd, e.sibling!.usage?.costUsd, e.paid!.usage?.costUsd], [0.5, 0.25, 1]);
      assert.deepEqual([e.exact!.payload.pricedAs, e.sibling!.payload.pricedAs, e.sibling!.payload.costEstimated], [undefined, "gpt-6.1-sol", true]);
      let u = (await store.getSession("s1"))!.stats.usage!;
      assert.deepEqual([u.costUsd, u.estimatedCostUsd], [1.75, 0.75]);
      await repriceStored(store, { "gpt-6.2-sol": { input: 3, output: 3 } });
      e = await byId();
      assert.deepEqual([e.sibling!.usage?.costUsd, e.sibling!.payload.pricedAs, e.sibling!.payload.costEstimated], [0.375, undefined, true]);
      u = (await store.getSession("s1"))!.stats.usage!;
      assert.deepEqual([u.costUsd, u.estimatedCostUsd], [1.875, 0.875]);
      await store.close();
    });

    it("reprices stored calls at their tier and long-context rates, records payload.priceTier, and totals it per tier", async () => {
      const store = await open();
      // Estimated before tiers, at standard short-context rates.
      const evs = [
        ev("batch", { model: "claude-opus-4-5", usage: { inputTokens: M, costUsd: 5 }, payload: { costEstimated: true, serviceTier: "batch" } }), // 2.5
        ev("long", { model: "gpt-6.1-sol", usage: { inputTokens: 300_000, costUsd: 0.6 }, payload: { costEstimated: true } }), // 300k × 4 = 1.2
        ev("short", { model: "gpt-6.1-sol", usage: { inputTokens: 100_000 } }), // 0.2, standard
        ev("snap", { kind: "notification", model: "gpt-6.1-sol", payload: { type: "usage-summary" }, usage: { inputTokens: 400_000 } }), // 0.8: running totals stay standard
      ];
      await store.putEvents(evs);
      await store.upsertSession(buildSession(evs));
      assert.deepEqual(await repriceStored(store, undefined, { force: true }), { ran: true, events: 4, sessions: 1 });
      const e = Object.fromEntries((await store.listEvents("s1")).map((x) => [x.id, x]));
      assert.deepEqual([e.batch!.usage?.costUsd, e.batch!.payload.priceTier, e.batch!.payload.serviceTier], [2.5, "batch", "batch"]);
      assert.deepEqual([e.long!.usage?.costUsd, e.long!.payload.priceTier], [1.2, "long-context"]);
      assert.deepEqual([e.short!.usage?.costUsd, e.short!.payload.priceTier], [0.2, undefined]);
      assert.deepEqual([e.snap!.usage?.costUsd, e.snap!.payload.priceTier], [0.8, undefined]);
      const u = (await store.getSession("s1"))!.stats.usage!;
      assert.equal(u.estimatedCostByTier?.batch, 2.5);
      assert.ok(Math.abs(u.estimatedCostByTier!["long-context"]! - 1.2) < 1e-9);
      assert.deepEqual(Object.keys(u.estimatedCostByTier!).sort(), ["batch", "long-context"]);
      // An override with no batch rates prices the batch call at its standard rate and drops the tier.
      await repriceStored(store, { "claude-opus-4-5": { input: 4, output: 4 } });
      const b = (await store.listEvents("s1")).find((x) => x.id === "batch")!;
      assert.deepEqual([b.usage?.costUsd, b.payload.priceTier, b.payload.costEstimated], [4, undefined, true]);
      assert.equal((await store.getSession("s1"))!.stats.usage!.estimatedCostByTier?.batch, undefined);
      await store.close();
    });

    it("refolds a session stored before session totals marked estimates, without touching its events", async () => {
      const store = await open();
      const evs = [ev("old", { model: "claude-opus-4-5", usage: { inputTokens: M, costUsd: 5 }, payload: { costEstimated: true } })];
      await store.putEvents(evs);
      const s = buildSession(evs);
      await store.upsertSession({ ...s, stats: { ...s.stats, usage: { inputTokens: M, costUsd: 5 } } });
      assert.deepEqual(await repriceStored(store), { ran: true, events: 0, sessions: 1 });
      assert.equal((await store.getSession("s1"))!.stats.usage?.estimatedCostUsd, 5);
      await store.close();
    });
  });
}

describe("priceStamp", () => {
  it("changes with the table and with the lookup rules", () => {
    const t = pricesFor();
    assert.equal(priceStamp(t), priceStamp(pricesFor()));
    assert.notEqual(priceStamp(t), priceStamp(t, PRICING_RULES_VERSION - 1));
    assert.notEqual(priceStamp(t), priceStamp(pricesFor({ x: { input: 1, output: 1 } })));
  });
});

describe("opening the index reprices it", () => {
  it("an index written before local pricing has costs after the next open", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reprice-"));
    roots.push(root);
    const path = join(root, "index.db");
    const before = await SqliteIndexStore.open(path);
    await seed(before);
    await before.close();
    const store = await openIndexStore(`sqlite://${path}`, defaultConfig({ CODING_SH_HOME: root, HOME: root }));
    assert.equal((await costs(store)).plain, 5);
    assert.equal((await store.getSession("s1"))!.stats.usage?.costUsd, 5 + 9 + 25 + 7 + 15);
    await store.close();
  });
});
