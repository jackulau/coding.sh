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

    it("prices stored 2026 models, records the sibling a fallback used, and drops it when the model gets its own row", async () => {
      const store = await open();
      const evs = [
        ev("exact", { model: "gpt-6.1-sol", usage: { inputTokens: M, cacheWriteTokens: M } }), // 2 + 2.5
        ev("sibling", { model: "gpt-6.2-sol", usage: { inputTokens: M } }), // as gpt-6.1-sol: 2
        ev("paid", { model: "gpt-6.1-sol", usage: { inputTokens: M, costUsd: 1 } }),
      ];
      await store.putEvents(evs);
      await store.upsertSession(buildSession(evs));
      assert.deepEqual(await repriceStored(store), { ran: true, events: 2, sessions: 1 });
      const byId = async () => Object.fromEntries((await store.listEvents("s1")).map((e) => [e.id, e]));
      let e = await byId();
      assert.deepEqual([e.exact!.usage?.costUsd, e.sibling!.usage?.costUsd, e.paid!.usage?.costUsd], [4.5, 2, 1]);
      assert.deepEqual([e.exact!.payload.pricedAs, e.sibling!.payload.pricedAs, e.sibling!.payload.costEstimated], [undefined, "gpt-6.1-sol", true]);
      let u = (await store.getSession("s1"))!.stats.usage!;
      assert.deepEqual([u.costUsd, u.estimatedCostUsd], [7.5, 6.5]);
      await repriceStored(store, { "gpt-6.2-sol": { input: 3, output: 3 } });
      e = await byId();
      assert.deepEqual([e.sibling!.usage?.costUsd, e.sibling!.payload.pricedAs, e.sibling!.payload.costEstimated], [3, undefined, true]);
      u = (await store.getSession("s1"))!.stats.usage!;
      assert.deepEqual([u.costUsd, u.estimatedCostUsd], [8.5, 7.5]);
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
