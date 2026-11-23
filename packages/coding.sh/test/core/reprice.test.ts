import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultConfig } from "../../src/core/config.ts";
import { acquireLock, isLocked, wakeMarker } from "../../src/core/lock.ts";
import { PRICING_RULES_VERSION, pricesFor } from "../../src/core/pricing.ts";
import { priceStamp, repriceEvents, REPRICE_CURSOR, repriceLock, repriceStored } from "../../src/core/reprice.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { IndexStore } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { startServe } from "../../src/server/serve.ts";
import { openIndexStore, registerIndexStore } from "../../src/store/factory.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { AGENT_HOME_KEYS } from "../_agent-env.ts";

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

/** `store` with `n` sessions (s0, s1, …) of one unpriced call each, $5 once priced. */
async function withCalls<T extends IndexStore>(store: T, n: number): Promise<T> {
  for (let i = 0; i < n; i++) {
    const events = [ev(`c${i}`, { sessionId: `s${i}`, model: "claude-opus-4-5", usage: { inputTokens: M } })];
    await store.putEvents(events);
    await store.upsertSession(buildSession(events));
  }
  return store;
}

/** `get()` once it gives a value, polled every 25 ms for `ms` at most. */
async function poll<T>(get: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  let v = get();
  while (v === undefined && Date.now() < end) {
    await sleep(25);
    v = get();
  }
  return v;
}

/** Each read of `store`'s events takes `ms` while `slow()` says so, as over the network to Postgres or ClickHouse; `during` runs at each. */
function slowReads(store: IndexStore, slow: () => boolean, during: () => void = () => {}, ms = 10): void {
  const list = store.listEvents.bind(store);
  store.listEvents = async (id, o) => {
    if (slow()) {
      during();
      await sleep(ms);
    }
    return list(id, o);
  };
}

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
        ev("sibling", { model: "gpt-6.3-sol", usage: { inputTokens: 125_000 } }), // as gpt-6.2-sol: 0.25
        ev("paid", { model: "gpt-6.1-sol", usage: { inputTokens: M, costUsd: 1 } }),
      ];
      await store.putEvents(evs);
      await store.upsertSession(buildSession(evs));
      assert.deepEqual(await repriceStored(store), { ran: true, events: 2, sessions: 1 });
      const byId = async () => Object.fromEntries((await store.listEvents("s1")).map((e) => [e.id, e]));
      let e = await byId();
      assert.deepEqual([e.exact!.usage?.costUsd, e.sibling!.usage?.costUsd, e.paid!.usage?.costUsd], [0.5, 0.25, 1]);
      assert.deepEqual([e.exact!.payload.pricedAs, e.sibling!.payload.pricedAs, e.sibling!.payload.costEstimated], [undefined, "gpt-6.2-sol", true]);
      let u = (await store.getSession("s1"))!.stats.usage!;
      assert.deepEqual([u.costUsd, u.estimatedCostUsd], [1.75, 0.75]);
      await repriceStored(store, { "gpt-6.3-sol": { input: 3, output: 3 } });
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

    it("splits stored estimates by token type once, and leaves reported costs unsplit", async () => {
      const store = await open();
      const evs = [
        // Estimated before splits: the cost is current, the split is missing.
        ev("old", { model: "claude-opus-4-5", usage: { inputTokens: M, cacheReadTokens: M, costUsd: 5.5 }, payload: { costEstimated: true } }), // 5 + 0.5
        ev("new", { model: "claude-opus-4-5", usage: { outputTokens: M, cacheWriteTokens: M } }), // 25 + 6.25
        // Parts that are not round in binary still read back exactly.
        ev("odd", { model: "claude-opus-4-5", usage: { inputTokens: 333_333, outputTokens: 123_457, cacheReadTokens: 777_777, cacheWriteTokens: 98_765 } }),
        ev("reported", { model: "claude-opus-4-5", usage: { inputTokens: M, costUsd: 9 } }),
      ];
      await store.putEvents(evs);
      const before = buildSession(evs);
      await store.upsertSession(before);
      assert.equal(before.stats.usage?.estimatedCostByTokenType, undefined, "an estimate without a split leaves the session unsplit");
      assert.deepEqual(await repriceStored(store), { ran: true, events: 3, sessions: 1 });
      const e = Object.fromEntries((await store.listEvents("s1")).map((x) => [x.id, x]));
      assert.deepEqual([e.old!.usage?.costUsd, e.old!.payload.costByTokenType], [5.5, { cacheRead: 0.5, cacheWrite: 0, input: 5, output: 0 }]);
      assert.deepEqual(e.new!.payload.costByTokenType, { cacheRead: 0, cacheWrite: 6.25, input: 0, output: 25 });
      const odd = e.odd!.payload.costByTokenType as Record<string, number>;
      assert.ok(Math.abs(Object.values(odd).reduce((a, b) => a + b, 0) - e.odd!.usage!.costUsd!) < 1e-12);
      assert.equal(e.reported!.payload.costByTokenType, undefined);
      const u = (await store.getSession("s1"))!.stats.usage!;
      const split = u.estimatedCostByTokenType!;
      assert.ok(Math.abs(split.cacheRead + split.cacheWrite + split.input + split.output - u.estimatedCostUsd!) < 1e-9);
      assert.ok(Math.abs(u.costUsd! - u.estimatedCostUsd! - 9) < 1e-9, "the reported $9 is not in the split");
      // A forced pass finds every stored split equal to a fresh one.
      assert.deepEqual(await repriceStored(store, undefined, { force: true }), { ran: true, events: 0, sessions: 0 });
      await store.close();
    });

    it("refolds a session stored before session totals marked estimates, without touching its events", async () => {
      const store = await open();
      const evs = [ev("old", { model: "claude-opus-4-5", usage: { inputTokens: M, costUsd: 5 }, payload: { costEstimated: true, costByTokenType: { cacheRead: 0, cacheWrite: 0, input: 5, output: 0 } } })];
      await store.putEvents(evs);
      const s = buildSession(evs);
      await store.upsertSession({ ...s, stats: { ...s.stats, usage: { inputTokens: M, costUsd: 5 } } });
      assert.deepEqual(await repriceStored(store), { ran: true, events: 0, sessions: 1 });
      assert.equal((await store.getSession("s1"))!.stats.usage?.estimatedCostUsd, 5);
      await store.close();
    });

    it("removes an estimate no price backs any more: once an override that priced a call is removed, the call and the session have no cost", async () => {
      const store = await open();
      const evs = [ev("start", { kind: "session.start", ts: 900 }), ev("call", { model: "no-such-model", usage: { inputTokens: M } })];
      await store.putEvents(evs);
      await store.upsertSession(buildSession(evs));
      assert.deepEqual(await repriceStored(store, { "no-such-model": { input: 3, output: 3 } }), { ran: true, events: 1, sessions: 1 });
      let call = (await store.listEvents("s1")).find((e) => e.id === "call")!;
      assert.deepEqual([call.usage?.costUsd, call.payload.costEstimated], [3, true]);
      assert.equal((await store.getSession("s1"))!.stats.usage?.estimatedCostUsd, 3);
      // The override is gone: no price makes the estimate now.
      assert.deepEqual(await repriceStored(store), { ran: true, events: 1, sessions: 1 });
      call = (await store.listEvents("s1")).find((e) => e.id === "call")!;
      assert.deepEqual(call.usage, { inputTokens: M }, "the call keeps its tokens and has no cost");
      assert.deepEqual(call.payload, {}, "nor costEstimated or a split");
      const u = (await store.getSession("s1"))!.stats.usage!;
      assert.deepEqual([u.inputTokens, u.costUsd, u.estimatedCostUsd, u.estimatedCostByTokenType], [M, undefined, undefined, undefined]);
      assert.deepEqual(await repriceStored(store, undefined, { force: true }), { ran: true, events: 0, sessions: 0 }, "a later pass finds nothing to do");
      await store.close();
    });

    it("a pass stopped between a session's new costs and its totals: the next pass brings the totals in line with the costs", async () => {
      const store = await open();
      await seed(store);
      await repriceStored(store);
      assert.equal((await store.getSession("s1"))!.stats.usage?.costUsd, 61);
      const cheaper = { "claude-opus-4-5": { input: 1, output: 1 } };
      const upsert = store.upsertSession;
      store.upsertSession = async () => {
        throw new Error("disk I/O error");
      };
      try {
        await assert.rejects(repriceStored(store, cheaper), /disk I\/O error/);
      } finally {
        store.upsertSession = upsert;
      }
      assert.notEqual(await store.getCursor(REPRICE_CURSOR), priceStamp(pricesFor(cheaper)), "the cursor stays, so the pass runs again");
      const c = await costs(store);
      if (name === "sqlite") assert.deepEqual([c.plain, c.stale], [5, 25], "the session's new costs rolled back with its totals");
      else assert.deepEqual([c.plain, c.stale], [1, 1], "a store without transactions keeps the new costs");
      assert.equal((await store.getSession("s1"))!.stats.usage?.costUsd, 61, "and the old totals");
      assert.deepEqual(await repriceStored(store, cheaper), { ran: true, events: name === "sqlite" ? 2 : 0, sessions: 1 });
      assert.deepEqual(await costs(store), { start: undefined, plain: 1, reported: 9, stale: 1, unknown: undefined, billed: undefined, gw: 7, snap: 15 });
      const u = (await store.getSession("s1"))!.stats.usage!;
      assert.deepEqual([u.costUsd, u.estimatedCostUsd], [1 + 9 + 1 + 7 + 15, 1 + 1 + 15]);
      await store.close();
    });

    it("does not run where its lock file can't be made: a pass that is not forced leaves the cursor, a forced one fails", async () => {
      const root = mkdtempSync(join(tmpdir(), "csh-reprice-nolock-"));
      roots.push(root);
      // The home is a file, so no lock file can be made in it, as on a read-only mount.
      const home = join(root, "home");
      writeFileSync(home, "");
      const store = await open();
      await seed(store);
      repriceLock(store, join(home, "reparse.lock"), join(home, "spool", ".ingest.lock"));
      assert.deepEqual(await repriceStored(store), { ran: false, events: 0, sessions: 0 });
      assert.equal(await store.getCursor(REPRICE_CURSOR), 0, "left for a run that can make the lock file");
      await assert.rejects(repriceStored(store, undefined, { force: true }), (err: Error) => err.name === "NoLockError" && /cannot make the lock file/.test(err.message));
      assert.equal((await costs(store)).plain, undefined, "nothing was written without the lock");
      await store.close();
    });
  });
}

describe("a reprice pass beside an ingest in another process", () => {
  it("sqlite: no other connection writes between a session's reads and its new costs and totals", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reprice-tx-"));
    roots.push(root);
    const path = join(root, "index.db");
    const store = await SqliteIndexStore.open(path);
    await seed(store);
    // An ingest in another process stores an event and folds its session in one write transaction (core/ingest.ts).
    const ingest = new DatabaseSync(path);
    ingest.exec("PRAGMA busy_timeout = 0");
    const list = store.listEvents.bind(store);
    let tried: string | undefined;
    store.listEvents = async (id, o) => {
      const out = await list(id, o);
      // The pass has read the session's events to total them and has not written its row yet.
      if (!o?.kinds && tried === undefined) {
        try {
          ingest.exec("BEGIN IMMEDIATE");
          ingest.exec("ROLLBACK");
          tried = "wrote";
        } catch (err) {
          tried = (err as Error).message;
        }
      }
      return out;
    };
    try {
      assert.equal((await repriceStored(store)).ran, true);
      assert.match(tried ?? "", /database is locked/, "the ingest's write waits for the session's repricing to commit");
      ingest.exec("BEGIN IMMEDIATE");
      ingest.exec("ROLLBACK");
      assert.equal((await store.getSession("s1"))!.stats.usage?.costUsd, 61);
    } finally {
      ingest.close();
      await store.close();
    }
  });

  it("a store without transactions: each session's writes wait for the ingest lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reprice-lock-"));
    roots.push(root);
    const spool = join(root, "spool");
    mkdirSync(spool);
    const store = new MemoryIndexStore();
    await seed(store);
    repriceLock(store, join(root, "reparse.lock"), join(spool, ".ingest.lock"));
    // An ingest holds the lock while it stores and folds.
    const ingest = await acquireLock(join(spool, ".ingest.lock"), { waitMs: 0 });
    const seen: (number | undefined)[] = [];
    const letGo = setTimeout(() => {
      void costs(store).then((c) => {
        seen.push(c.plain);
        ingest.release();
      });
    }, 300);
    try {
      assert.equal((await repriceStored(store)).ran, true);
    } finally {
      clearTimeout(letGo);
      ingest.release();
    }
    assert.deepEqual(seen, [undefined], "nothing was written while the ingest held the lock");
    assert.equal((await costs(store)).plain, 5);
    assert.equal((await store.getSession("s1"))!.stats.usage?.costUsd, 61);
    await store.close();
  });

  it("a store without transactions: an ingest waiting for the ingest lock gets it between the pass's holds", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reprice-turns-"));
    roots.push(root);
    const spool = join(root, "spool");
    mkdirSync(spool);
    const store = new MemoryIndexStore();
    for (let i = 0; i < 400; i++) {
      const events = [ev(`c${i}`, { sessionId: `s${i}`, model: "claude-opus-4-5", usage: { inputTokens: M } })];
      await store.putEvents(events);
      await store.upsertSession(buildSession(events));
    }
    repriceLock(store, join(root, "reparse.lock"), join(spool, ".ingest.lock"));
    // Reads take a few ms each, as over the network to Postgres or ClickHouse, while the ingest below waits.
    let waiting = true;
    const list = store.listEvents.bind(store);
    store.listEvents = async (id, o) => {
      if (waiting) await new Promise((r) => setTimeout(r, 10));
      return list(id, o);
    };
    // An ingest in another process (a read's, which waits 1.5 s) asks for the lock while the pass runs.
    const got = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        acquireLock(join(spool, ".ingest.lock"), { waitMs: 1_500 })
          .then((l) => (l.release(), true), () => false)
          .then((ok) => {
            waiting = false;
            resolve(ok);
          });
      }, 100);
    });
    assert.equal((await repriceStored(store, undefined, { onProgress: () => {} })).ran, true);
    assert.equal(await got, true, "HOLD_MS: the waiting ingest gets a turn between two holds");
    await store.close();
  });

  it("a store without transactions: a wake marker left during a hold starts a background ingest, and the pass keeps off the lock until it holds it", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reprice-wake-"));
    roots.push(root);
    mkdirSync(join(root, "spool"));
    const lockPath = join(root, "spool", ".ingest.lock");
    const marker = wakeMarker(lockPath);
    const store = await withCalls(new MemoryIndexStore(), 100);
    let ingested = false;
    slowReads(store, () => !ingested);
    // The open's kick (store/factory.ts): `ingest --background`, which starts a moment later and takes the lock without waiting.
    let kicks = 0;
    repriceLock(store, join(root, "reparse.lock"), lockPath, () => {
      kicks++;
      setTimeout(() => {
        void acquireLock(lockPath, { waitMs: 0 }).then(async (l) => {
          rmSync(marker, { force: true });
          await sleep(50);
          l.release();
          ingested = true;
        }, () => {});
      }, 300);
      return true;
    });
    // A hook at a session end finds the pass holding the lock: it leaves the marker and starts nothing (spool/kick.ts).
    const hook = setTimeout(() => writeFileSync(marker, ""), 100);
    try {
      assert.equal((await repriceStored(store, undefined, { onProgress: () => {} })).ran, true);
    } finally {
      clearTimeout(hook);
    }
    assert.equal(kicks, 1, "one background ingest started for the marker");
    assert.equal(ingested, true, "it took the lock with no wait");
    assert.equal(existsSync(marker), false);
    assert.equal((await store.getSession("s99"))!.stats.usage?.costUsd, 5);
    await store.close();
  });

  it("a store without transactions: when no background ingest starts, the pass tries once while the marker stays", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reprice-nokick-"));
    roots.push(root);
    mkdirSync(join(root, "spool"));
    const lockPath = join(root, "spool", ".ingest.lock");
    const marker = wakeMarker(lockPath);
    // Two reads of 40 ms or more a session: three stretches of a second at least, so the pass looks at the marker twice.
    const store = await withCalls(new MemoryIndexStore(), 27);
    slowReads(store, () => true, () => {}, 40);
    // No CLI to start (store/factory.ts ingestKick: spawnBackgroundIngest found none).
    let kicks = 0;
    repriceLock(store, join(root, "reparse.lock"), lockPath, () => {
      kicks++;
      return false;
    });
    writeFileSync(marker, "");
    try {
      assert.equal((await repriceStored(store, undefined, { onProgress: () => {} })).ran, true);
      assert.equal(kicks, 1, "a kick that started nothing is not tried again");
      assert.equal(existsSync(marker), true, "the marker stays for the next ingest");
    } finally {
      await store.close();
    }
  });

  it("sqlite: a wake marker starts a background ingest and the pass goes on at once, starting one per HANDOFF_MS at most", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reprice-kicknowait-"));
    roots.push(root);
    mkdirSync(join(root, "spool"));
    const lockPath = join(root, "spool", ".ingest.lock");
    const marker = wakeMarker(lockPath);
    // As above: three stretches at least, so the pass looks at the marker twice.
    const store = await withCalls(await SqliteIndexStore.open(join(root, "index.db")), 27);
    slowReads(store, () => true, () => {}, 40);
    // A background ingest that never takes the lock: the pass, which never holds it, has nothing to keep off.
    let kicks = 0;
    repriceLock(store, join(root, "reparse.lock"), lockPath, () => {
      kicks++;
      return true;
    });
    writeFileSync(marker, "");
    const t0 = Date.now();
    try {
      assert.equal((await repriceStored(store, undefined, { onProgress: () => {} })).ran, true);
      const ms = Date.now() - t0;
      assert.ok(ms < 10_000, `the pass waited for the ingest: ${ms} ms`);
      assert.equal(kicks, 1, "one background ingest started in the pass's first 10 s");
      assert.equal((await store.getSession("s26"))!.stats.usage?.costUsd, 5);
    } finally {
      await store.close();
    }
  });

  it("sqlite: the pass holds no ingest lock, and its onWake (`usage --reprice`'s) ingests between stretches while the wake marker is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reprice-onwake-"));
    roots.push(root);
    mkdirSync(join(root, "spool"));
    const lockPath = join(root, "spool", ".ingest.lock");
    const marker = wakeMarker(lockPath);
    const store = await withCalls(await SqliteIndexStore.open(join(root, "index.db")), 100);
    repriceLock(store, join(root, "reparse.lock"), lockPath);
    let ingests = 0;
    let held = false;
    slowReads(store, () => ingests === 0, () => (held ||= isLocked(lockPath)));
    // A read that found the pass running left the marker (cli/common.ts reparseBacklog).
    const read = setTimeout(() => writeFileSync(marker, ""), 100);
    const onWake = async () => {
      // As wakeIngest (core/context.ts): an ingest that takes the lock only if it is free now, and clears the marker.
      const l = await acquireLock(lockPath, { waitMs: 0 });
      rmSync(marker, { force: true });
      l.release();
      ingests++;
    };
    try {
      assert.equal((await repriceStored(store, undefined, { force: true, onWake, onProgress: () => {} })).ran, true);
      assert.equal(ingests, 1);
      assert.equal(held, false, "a store with transactions leaves the ingest lock to ingests");
      assert.equal(existsSync(marker), false);
      assert.equal((await store.getSession("s99"))!.stats.usage?.costUsd, 5);
    } finally {
      clearTimeout(read);
      await store.close();
    }
  });

  it("sqlite: repriceEvents (the refold's) leaves a call alone that a gateway companion billed after its first read", async () => {
    const store = await SqliteIndexStore.open(":memory:");
    const events = [ev("start", { kind: "session.start", ts: 900 }), ev("call", { model: "claude-opus-4-5", usage: { inputTokens: M } })];
    await store.putEvents(events);
    await store.upsertSession(buildSession(events));
    // `coding.sh gateway enrich` in another process stores its companion right after the pass's first read.
    const read = store.listEvents.bind(store);
    let between: (() => Promise<unknown>) | undefined = () => store.putEvents([ev("gw", { kind: "span", source: "gateway", parentId: "call", usage: { costUsd: 7 } })]);
    store.listEvents = async (id, o) => {
      const out = await read(id, o);
      const run = between;
      between = undefined;
      await run?.();
      return out;
    };
    try {
      await repriceEvents(store, (await store.getSession("s1"))!, pricesFor());
      assert.equal(between, undefined, "the companion was stored during the pass");
      assert.equal((await costs(store)).call, undefined, "no estimate on top of the gateway's bill");
    } finally {
      await store.close();
    }
  });
});

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

  it("a store without transactions: a hook's wake marker during the open's pass starts `ingest --background` with the CLI init recorded", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reprice-kick-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, "spool"), { recursive: true });
    mkdirSync(join(home, "bin"));
    const lockPath = join(home, "spool", ".ingest.lock");
    const report = join(root, "ingest.json");
    const pidFile = join(root, "ingest.pid");
    // Stands in for the CLI: takes the ingest lock without waiting and clears the marker, as `ingest --background` does, then says how it ran.
    // It writes its pid first, so the test can stop it, and exits within 20 s whatever happens.
    const cli = join(root, "cli.mjs");
    writeFileSync(cli, [
      `import { rmSync, writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `setTimeout(() => process.exit(2), 20_000).unref();`,
      `const out = { args: process.argv.slice(2), home: process.env.CODING_SH_HOME };`,
      `try {`,
      `  const { acquireLock, wakeMarker } = await import(${JSON.stringify(new URL("../../src/core/lock.ts", import.meta.url).href)});`,
      `  const lock = await acquireLock(${JSON.stringify(lockPath)}, { waitMs: 0 });`,
      `  rmSync(wakeMarker(${JSON.stringify(lockPath)}), { force: true });`,
      `  await new Promise((r) => setTimeout(r, 100));`,
      `  lock.release();`,
      `} catch (e) {`,
      `  out.error = String(e);`,
      `}`,
      `writeFileSync(${JSON.stringify(report)}, JSON.stringify(out));`,
    ].join("\n"));
    writeFileSync(join(home, "bin", "cli-path"), cli);
    const store = await withCalls(new MemoryIndexStore(), 100);
    slowReads(store, () => !existsSync(report));
    let live = true;
    registerIndexStore("reprice-kick", () => {
      if (!live) throw new Error("reprice-kick:// was a test's store");
      return store;
    });
    // The ingest inherits this env: no store or run of the caller's, and none of their agent homes.
    const env: NodeJS.ProcessEnv = { ...process.env, CODING_SH_HOME: home, HOME: root, USERPROFILE: root };
    for (const k of ["CODING_SH_NO_AUTO_INGEST", "CODING_SH_RUN_ID", "CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", ...AGENT_HOME_KEYS]) delete env[k];
    const hook = setTimeout(() => writeFileSync(wakeMarker(lockPath), ""), 100);
    try {
      try {
        assert.equal(await openIndexStore("reprice-kick://", defaultConfig({ CODING_SH_HOME: home, HOME: root }), { env }), store);
      } finally {
        clearTimeout(hook);
      }
      const ran = await poll(() => {
        try {
          return JSON.parse(readFileSync(report, "utf8")) as { args: string[]; home: string; error?: string };
        } catch {
          return undefined; // not written yet
        }
      }, 10_000);
      assert.deepEqual(ran && { args: ran.args, home: ran.home, error: ran.error }, { args: ["ingest", "--background"], home, error: undefined });
      assert.equal(existsSync(wakeMarker(lockPath)), false);
      assert.equal((await store.getSession("s99"))!.stats.usage?.costUsd, 5);
      assert.ok((await store.getCursor(REPRICE_CURSOR)) > 0, "the pass finished");
    } finally {
      live = false;
      // The ingest exits once it has reported: wait for that (or stop it) before the test's folder goes.
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : NaN;
      const gone = () => {
        try {
          process.kill(pid, 0);
          return undefined;
        } catch {
          return true;
        }
      };
      if (pid > 0 && !(await poll(gone, 5_000))) process.kill(pid);
      await store.close();
    }
  });

  it("serve with a store of its own (`--store`): the open's pass starts no ingest of the home's spool", async () => {
    const root = mkdtempSync(join(tmpdir(), "csh-reprice-serve-"));
    roots.push(root);
    const home = join(root, "home");
    mkdirSync(join(home, "spool"), { recursive: true });
    mkdirSync(join(home, "bin"));
    const marker = wakeMarker(join(home, "spool", ".ingest.lock"));
    const started = join(root, "started");
    // Stands in for the CLI: says it was started, and exits.
    const cli = join(root, "cli.mjs");
    writeFileSync(cli, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(started)}, String(process.pid));
`);
    writeFileSync(join(home, "bin", "cli-path"), cli);
    // Two stretches at least, so the pass looks at the marker a hook left.
    const store = await withCalls(new MemoryIndexStore(), 14);
    slowReads(store, () => true, () => {}, 40);
    let live = true;
    registerIndexStore("serve-own", () => {
      if (!live) throw new Error("serve-own:// was a test's store");
      return store;
    });
    writeFileSync(marker, "");
    // `coding.sh --store serve-own:// serve`: main.ts names the store in the command's env, not in process.env.
    const env: NodeJS.ProcessEnv = { HOME: root, USERPROFILE: root, CODING_SH_HOME: home, CODING_SH_STORE_URL: "serve-own://", CODING_SH_LOG: "json" };
    const h = await startServe(resolveServeConfig({ port: 0 }, env), { log: createLogger({ format: "json", write: () => {} }), enrichSpan: false, alerts: false });
    try {
      assert.ok((await store.getCursor(REPRICE_CURSOR)) > 0, "the open's pass ran");
      assert.equal(existsSync(started), false, "no `ingest --background` started");
      assert.equal(existsSync(marker), true, "the marker stays for the home's next ingest");
    } finally {
      live = false;
      await h.shutdown();
    }
  });
});
