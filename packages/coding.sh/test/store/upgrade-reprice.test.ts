// What a person waits for when the open of the index still reprices stored cost estimates
// (store/factory.ts runs the pass there when no background ingest will): the line that closes an
// upgrade counts the pass and names the parts, and a pass that runs past 2 s says how far it is.
// A first open after an upgrade once waited 31 s and said `index upgraded in 1.3s.`
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { pricesFor } from "../../src/core/pricing.ts";
import { priceStamp, REPRICE_CURSOR } from "../../src/core/reprice.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { EventCost } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { openIndexStore, openStores, registerIndexStore } from "../../src/store/factory.ts";
import { loadSqlite } from "../../src/store/sqlite-open.ts";
import { MIGRATIONS, SQLITE_SCHEMA_VERSION, SqliteIndexStore } from "../../src/store/sqlite.ts";
import { setUpgradeNotice } from "../../src/store/upgrade.ts";

const root = mkdtempSync(join(tmpdir(), "csh-upgrade-reprice-"));
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
const dir = (): string => mkdtempSync(join(root, `h${seq++}-`));

const OLD = SQLITE_SCHEMA_VERSION - 1;
const IDS = ["s1", "s2", "s3", "s4", "s5"];

/** A session stored before local pricing: one call worth $5 and no cost on it. */
const eventsOf = (sid: string, i: number): AgentEvent[] => [
  { id: `${sid}-start`, v: 0, sessionId: sid, ts: 1000 + i, agent: "claude-code", kind: "session.start", payload: {} },
  { id: `${sid}-call`, v: 0, sessionId: sid, ts: 1001 + i, agent: "claude-code", kind: "llm.call", model: "claude-opus-4-5", payload: {}, usage: { inputTokens: 1_000_000 } },
];

/** An index at the schema before this one holding IDS, as the coding.sh that knew only that schema left it. */
async function oldIndex(file: string, repriced?: number): Promise<void> {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  for (const m of MIGRATIONS.filter((m) => m.version <= OLD)) {
    db.exec(m.sql);
    m.after?.(db);
    db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
  }
  const event = db.prepare("INSERT INTO events (id, session_id, ts, agent, kind, model, payload, usage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const session = db.prepare("INSERT INTO sessions (id, agent, started_at, stats) VALUES (?, 'claude-code', ?, ?)");
  IDS.forEach((sid, i) => {
    const evs = eventsOf(sid, i);
    for (const e of evs) event.run(e.id, e.sessionId, e.ts, e.agent, e.kind, e.model ?? null, JSON.stringify(e.payload), e.usage ? JSON.stringify(e.usage) : null);
    session.run(sid, evs[0]!.ts, JSON.stringify(buildSession(evs).stats));
  });
  if (repriced !== undefined) db.prepare("INSERT INTO cursors (source, offset, updated_at) VALUES (?, ?, 0)").run(REPRICE_CURSOR, repriced);
  db.close();
}

/**
 * Opens `file` through the factory, as the CLI opens a store, on a stubbed clock: the migration
 * takes 1.2 s and each session's new costs 4.7 s. Returns the store and the progress lines.
 */
async function upgrade(t: TestContext, file: string, home: string) {
  const lines: string[] = [];
  const scheme = `upgrade-reprice-${seq++}`;
  registerIndexStore(scheme, async () => {
    const store = await SqliteIndexStore.open(file, { progress: (line) => void lines.push(line), progressMinRows: 1, beforeMigrate: () => t.mock.timers.tick(1_200) });
    const set = store.setEventCosts.bind(store);
    store.setEventCosts = async (costs: EventCost[]) => {
      t.mock.timers.tick(4_700);
      return set(costs);
    };
    return store;
  });
  const store = await openIndexStore(`${scheme}://`, defaultConfig({ CODING_SH_HOME: home, HOME: home }));
  return { store, lines };
}

describe("an open that upgrades the index and reprices it says how long both took", () => {
  it("counts the repricing in the line that closes the upgrade and names the parts; a migration alone is timed alone", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const home = dir();
    const file = join(home, "index.db");
    await oldIndex(file);
    const { store, lines } = await upgrade(t, file, home);
    try {
      const last = lines.at(-1)!;
      assert.match(last, /^coding\.sh: index upgraded in 24\.7s: migrate 1\.2s, reprice 23\.5s\. /, "1.2 s of migration and 5 sessions at 4.7 s each");
      assert.match(last, /The index as it was is kept at /);
      assert.equal(lines.filter((l) => l.includes("index upgraded in")).length, 1, "one closing line");
      for (const id of IDS) assert.equal((await store.getSession(id))?.stats.usage?.costUsd, 5, `${id} is repriced`);
    } finally {
      await store.close();
    }

    // The same upgrade with this price table applied already: nothing to reprice, nothing named.
    const home2 = dir();
    const file2 = join(home2, "index.db");
    await oldIndex(file2, priceStamp(pricesFor()));
    const again = await upgrade(t, file2, home2);
    try {
      assert.match(again.lines.at(-1)!, /^coding\.sh: index upgraded in 1\.2s\. The index as it was is kept at /);
    } finally {
      await again.store.close();
    }
  });
});

describe("a repricing a person waits for", () => {
  it("with CODING_SH_NO_AUTO_INGEST=1 runs on the open, says how far it is after 2 s, once a second, and how long it took", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const env = { CODING_SH_HOME: join(dir(), "home"), HOME: dir(), CODING_SH_NO_AUTO_INGEST: "1" };
    const config = defaultConfig(env);
    const seed = await SqliteIndexStore.open(join(config.home, "index.db"));
    for (const [i, sid] of IDS.entries()) {
      const evs = eventsOf(sid, i);
      await seed.putEvents(evs);
      await seed.upsertSession(buildSession(evs));
    }
    await seed.close();
    const notices: string[] = [];
    setUpgradeNotice((line) => void notices.push(line));
    // Each session's new costs take a second.
    const set = SqliteIndexStore.prototype.setEventCosts;
    SqliteIndexStore.prototype.setEventCosts = async function (this: SqliteIndexStore, costs: EventCost[]) {
      t.mock.timers.tick(1_000);
      return set.call(this, costs);
    };
    try {
      const { index, blobs } = await openStores(config, { env });
      try {
        for (const id of IDS) assert.equal((await index.getSession(id))?.stats.usage?.costUsd, 5, `${id} is repriced by the open`);
        assert.equal(await index.getCursor(REPRICE_CURSOR), priceStamp(pricesFor(config.pricing)));
      } finally {
        await index.close();
        await blobs.close?.();
      }
    } finally {
      SqliteIndexStore.prototype.setEventCosts = set;
      setUpgradeNotice(undefined);
    }
    assert.deepEqual(notices, [
      "coding.sh: repricing cost estimates: 2 of 5 sessions (40%)",
      "coding.sh: repricing cost estimates: 3 of 5 sessions (60%)",
      "coding.sh: repricing cost estimates: 4 of 5 sessions (80%)",
      "coding.sh: repricing cost estimates: 5 of 5 sessions (100%)",
      "coding.sh: cost estimates repriced in 5.0s.",
    ]);
  });
});
