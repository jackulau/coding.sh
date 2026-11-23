// Repricing stored cost estimates after the price table changed runs in the background ingest
// that refolds (core/reparse.ts), not on the open of the index: the first command after an
// upgrade once waited 23.5 s for it. Readers are told estimates are being rebuilt meanwhile, a
// session the refold folds anyway is folded once, a pass holds the refold's lock, and a pass that
// failed runs again.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { refolding } from "../../src/cli/common.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { openContext, type Context } from "../../src/core/context.ts";
import { REFOLD_CURSOR } from "../../src/core/ingest.ts";
import { acquireLock } from "../../src/core/lock.ts";
import { paths } from "../../src/core/paths.ts";
import { pricesFor } from "../../src/core/pricing.ts";
import { reparse, reparseDue } from "../../src/core/reparse.ts";
import { priceStamp, REPRICE_CURSOR, repriceStored } from "../../src/core/reprice.ts";
import { buildSession, foldStamp } from "../../src/core/sessions.ts";
import type { EventCost, IndexStore } from "../../src/core/types.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { openStores } from "../../src/store/factory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const IDS = ["s1", "s2", "s3"];

/** A home whose index holds IDS, each with one $5 call stored before local pricing, last folded under `fold`. */
async function home(fold = foldStamp()) {
  const root = mkdtempSync(join(tmpdir(), "csh-reprice-bg-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
  const config = defaultConfig(env);
  mkdirSync(config.home, { recursive: true });
  const seed = await SqliteIndexStore.open(join(config.home, "index.db"));
  for (const [i, sid] of IDS.entries()) {
    const evs: AgentEvent[] = [
      { id: `${sid}-start`, v: 0, sessionId: sid, ts: 1000 + i, agent: "claude-code", kind: "session.start", payload: {} },
      { id: `${sid}-call`, v: 0, sessionId: sid, ts: 1001 + i, agent: "claude-code", kind: "llm.call", model: "claude-opus-4-5", payload: {}, usage: { inputTokens: 1_000_000 } },
    ];
    await seed.putEvents(evs);
    await seed.upsertSession(buildSession(evs));
  }
  await seed.setCursor(REFOLD_CURSOR, fold);
  await seed.close();
  return { env, config, stamp: priceStamp(pricesFor(config.pricing)) };
}

const costs = (index: IndexStore) => Promise.all(IDS.map(async (id) => (await index.listEvents(id)).find((e) => e.kind === "llm.call")?.usage?.costUsd));
const totals = (index: IndexStore) => Promise.all(IDS.map(async (id) => (await index.getSession(id))?.stats.usage?.costUsd));
/** What refolding() reads of a command's context. */
const reader = (index: IndexStore, env: NodeJS.ProcessEnv) => ({ storeOverridden: false, paths: paths(env), index }) as unknown as Context; // slop-allow chained-as: refolding reads only storeOverridden, paths and index

describe("repricing after the price table changed", () => {
  it("is left by the open to the background ingest, which runs it; readers are told meanwhile", async () => {
    const { env, config, stamp } = await home();
    const { index, blobs } = await openStores(config, { env });
    try {
      assert.deepEqual(await costs(index), [undefined, undefined, undefined], "the open reprices nothing");
      assert.notEqual(await index.getCursor(REPRICE_CURSOR), stamp);
      assert.equal(await refolding(reader(index, env), env), true, "readers are told the estimates are being rebuilt");
      assert.equal(await reparseDue(index, new Map()), true, "the background ingest has work");
      // What `coding.sh ingest --background` runs when reparseDue says so.
      const r = await reparse({ config, index, blobs, adapters: new Map(), env });
      assert.deepEqual(r.errors, []);
      assert.deepEqual(await costs(index), [5, 5, 5]);
      assert.deepEqual(await totals(index), [5, 5, 5]);
      assert.equal(await index.getCursor(REPRICE_CURSOR), stamp);
      assert.equal(await reparseDue(index, new Map()), false);
      assert.equal(await refolding(reader(index, env), env), false);
    } finally {
      await index.close();
    }
  });

  it("is decided by the environment a command was given, not the process's", async () => {
    const { env, config, stamp } = await home();
    const saved = process.env.CODING_SH_NO_AUTO_INGEST;
    delete process.env.CODING_SH_NO_AUTO_INGEST;
    try {
      // No background ingest runs for this command, so its open reprices.
      const ctx = await openContext({ env: { ...env, CODING_SH_NO_AUTO_INGEST: "1" }, config });
      try {
        assert.deepEqual(await costs(ctx.index), [5, 5, 5]);
        assert.equal(await ctx.index.getCursor(REPRICE_CURSOR), stamp);
      } finally {
        await ctx.close();
      }
    } finally {
      if (saved === undefined) delete process.env.CODING_SH_NO_AUTO_INGEST;
      else process.env.CODING_SH_NO_AUTO_INGEST = saved;
    }
  });

  it("folds each session once when the fold stamp changed too", async () => {
    const { env, config, stamp } = await home(foldStamp() - 1);
    const writes = new Map<string, number>();
    const upsert = SqliteIndexStore.prototype.upsertSession;
    SqliteIndexStore.prototype.upsertSession = async function (this: SqliteIndexStore, s: Session) {
      writes.set(s.id, (writes.get(s.id) ?? 0) + 1);
      return upsert.call(this, s);
    };
    try {
      const { index, blobs } = await openStores(config, { env });
      try {
        const r = await reparse({ config, index, blobs, adapters: new Map(), env });
        assert.deepEqual(r.errors, []);
        assert.equal(r.refolded, IDS.length);
        assert.deepEqual(Object.fromEntries(writes), { s1: 1, s2: 1, s3: 1 }, "one write per session, by its fold");
        assert.deepEqual(await totals(index), [5, 5, 5], "the fold counts the new costs");
        assert.equal(await index.getCursor(REPRICE_CURSOR), stamp);
        assert.equal(await index.getCursor(REFOLD_CURSOR), foldStamp());
      } finally {
        await index.close();
      }
    } finally {
      SqliteIndexStore.prototype.upsertSession = upsert;
    }
  });

  it("holds the refold's lock: an open skips the pass while another process holds it, and a forced pass waits for it", async () => {
    const { env, config, stamp } = await home();
    const off = { ...env, CODING_SH_NO_AUTO_INGEST: "1" };
    const held = await acquireLock(paths(env).reparseLock, { waitMs: 0 });
    let released = false;
    try {
      const first = await openStores(config, { env: off });
      try {
        assert.deepEqual(await costs(first.index), [undefined, undefined, undefined], "skipped while the refold runs");
        assert.equal(await first.index.getCursor(REPRICE_CURSOR), 0, "and left for a later open");
        // `coding.sh usage --reprice` waits for the lock instead.
        const wait = setTimeout(() => {
          released = true;
          held.release();
        }, 300);
        try {
          const r = await repriceStored(first.index, config.pricing, { force: true });
          assert.equal(released, true, "the forced pass ran after the lock was let go");
          assert.equal(r.ran, true);
        } finally {
          clearTimeout(wait);
        }
        assert.deepEqual(await costs(first.index), [5, 5, 5]);
        assert.equal(await first.index.getCursor(REPRICE_CURSOR), stamp);
      } finally {
        await first.index.close();
      }
    } finally {
      if (!released) held.release();
    }
  });

  it("runs again after a session's repricing failed", async () => {
    const { env, config, stamp } = await home(foldStamp() - 1);
    const { index, blobs } = await openStores(config, { env });
    const set = SqliteIndexStore.prototype.setEventCosts;
    let fail = true;
    SqliteIndexStore.prototype.setEventCosts = async function (this: SqliteIndexStore, c: EventCost[]) {
      if (fail) {
        fail = false;
        throw new Error("disk I/O error");
      }
      return set.call(this, c);
    };
    try {
      const r = await reparse({ config, index, blobs, adapters: new Map(), env });
      assert.ok(r.errors.some((e) => /repricing the cost estimates of session s\d failed: disk I\/O error/.test(e.message)), JSON.stringify(r.errors));
      assert.notEqual(await index.getCursor(REPRICE_CURSOR), stamp, "the cursor stays, so the pass runs again");
      assert.equal(await reparseDue(index, new Map()), true);
      const again = await reparse({ config, index, blobs, adapters: new Map(), env });
      assert.deepEqual(again.errors, []);
      assert.deepEqual(await costs(index), [5, 5, 5]);
      assert.deepEqual(await totals(index), [5, 5, 5]);
      assert.equal(await index.getCursor(REPRICE_CURSOR), stamp);
    } finally {
      SqliteIndexStore.prototype.setEventCosts = set;
      await index.close();
    }
  });
});
