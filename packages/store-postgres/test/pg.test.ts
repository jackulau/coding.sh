// Postgres-specific behaviour beyond the shared conformance suite: URL handling,
// concurrent migrations, the writer lock, retention, and the edge cases that
// would otherwise poison a serve writer tick (fractional ms, U+0000).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pg from "pg";
import type { AgentEvent } from "coding.sh/store";
import { blobStore, indexStore, parsePgUrl, PgBlobStore, PgIndexStore, redactUrl, searchFolded, tsQuery } from "../src/index.ts";
import { MIGRATIONS } from "../src/pool.ts";
import { PG_URL, SKIP, schemaUrl } from "./helpers.ts";

const ev = (over: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `e-${Math.random().toString(36).slice(2)}`,
  v: 0,
  sessionId: "s1",
  ts: 1_700_000_000_000,
  agent: "sdk",
  kind: "notification",
  payload: {},
  ...over,
});

describe("postgres URL handling", () => {
  it("strips schema and pool_max and keeps the rest for pg", () => {
    const u = parsePgUrl("postgres://u:p%40ss@db.example.com:5432/app?sslmode=require&schema=coding_sh&pool_max=4");
    assert.equal(u.schema, "coding_sh");
    assert.equal(u.poolMax, 4);
    assert.equal(u.connectionString, "postgres://u:p%40ss@db.example.com:5432/app?sslmode=require");
    const d = parsePgUrl("postgresql://localhost/app");
    assert.equal(d.schema, "public");
    assert.equal(d.poolMax, 10);
  });

  it("rejects bad schemas, pool sizes and schemes without echoing the password", () => {
    assert.throws(() => parsePgUrl("postgres://u:secret@h/db?schema=a;drop"), /invalid schema/);
    assert.throws(() => parsePgUrl("postgres://u:secret@h/db?pool_max=0"), /pool_max/);
    assert.throws(() => parsePgUrl("mysql://u:secret@h/db"), (err: Error) => /scheme/.test(err.message) && !err.message.includes("secret"));
  });

  it("redacts passwords", () => {
    assert.equal(redactUrl("postgres://user:hunter2@host:5432/db?sslmode=require"), "postgres://user:***@host:5432/db?sslmode=require");
    assert.equal(redactUrl("postgres://host/db?password=hunter2&x=1"), "postgres://host/db?password=***&x=1");
    assert.equal(redactUrl("postgres://host/db"), "postgres://host/db");
  });

  it("builds a tsquery from letters and digits only, with the last term a prefix", () => {
    assert.deepEqual(tsQuery("Café  zürich!"), { query: "cafe & zurich:*", terms: ["cafe", "zurich"] });
    assert.equal(tsQuery("'); DROP TABLE x; --")?.query, "drop & table & x:*");
    assert.equal(tsQuery(" & | ! :* "), undefined);
    assert.equal(searchFolded(ev({ kind: "user.message", payload: { text: "Hello, Wörld_42" } })), "hello world 42");
    assert.equal(searchFolded(ev({ kind: "notification", payload: { text: "x" } })), null);
  });
});

describe("postgres store", { skip: SKIP }, () => {
  const open = (schema?: string) => PgIndexStore.open(schemaUrl(schema), { dropSchemaOnClose: true });

  it("factories open migrated stores and report the postgres kind", async () => {
    const url = schemaUrl();
    const index = await indexStore(url);
    const blobs = await blobStore(url);
    try {
      assert.equal(index.kind, "postgres");
      assert.equal(blobs.kind, "postgres");
      await index.ping!();
      const ref = await blobs.put("shared database");
      assert.equal(await blobs.getText(ref), "shared database");
    } finally {
      await (blobs as PgBlobStore).close();
      await index.close();
      const cleanup = await PgIndexStore.open(url, { dropSchemaOnClose: true });
      await cleanup.close();
    }
  });

  it("replicas migrating the same new schema at once all succeed", async () => {
    const schema = `t_mig_${Date.now().toString(36)}`;
    // Separate pool sizes give separate pools, i.e. separate "replicas".
    const stores = await Promise.all([1, 2, 3, 4].map((n) => PgIndexStore.open(schemaUrl(schema, { pool_max: String(n) }))));
    try {
      const client = new pg.Client({ connectionString: PG_URL });
      await client.connect();
      const { rows } = await client.query(`SELECT version FROM "${schema}".coding_sh_migrations`);
      await client.end();
      assert.deepEqual(rows.map((r) => r.version).sort((a, b) => a - b), MIGRATIONS.map((m) => m.version), "each migration applied once");
    } finally {
      for (const s of stores.slice(1)) await s.close();
      await stores[0]!.close();
      const cleanup = await PgIndexStore.open(schemaUrl(schema), { dropSchemaOnClose: true });
      await cleanup.close();
    }
  });

  it("round-trips fractional ms, U+0000 in JSON, and project ids", async () => {
    const s = await open();
    try {
      const e = ev({ id: "frac", ts: 1_700_000_000_123.456, durationMs: 0.25, payload: { text: "nul\u0000inside" }, project: "demo", sessionId: "demo/c1" });
      assert.deepEqual(await s.putEvents([e]), { inserted: 1 });
      assert.deepEqual(await s.listEvents("demo/c1"), [e]);
      // Plain text columns cannot hold U+0000: it is dropped instead of failing the batch.
      await s.putEvents([ev({ id: "nul", sessionId: "s\u0000x", model: "m\u0000" })]);
      assert.equal((await s.listEvents("sx"))[0]?.model, "m");
      await s.upsertSession({ id: "demo/c1", project: "demo", agent: "sdk", startedAt: 1.5, endedAt: 2.75, stats: { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] });
      assert.equal((await s.getSession("demo/c1"))?.project, "demo");
      assert.equal((await s.getSession("demo/c1"))?.endedAt, 2.75);
      assert.deepEqual((await s.listSessions({ project: "demo" })).map((x) => x.id), ["demo/c1"]);
      assert.deepEqual(await s.listSessions({ project: "other" }), []);
    } finally {
      await s.close();
    }
  });

  it("keeps batch order for equal timestamps", async () => {
    const s = await open();
    try {
      const ids = ["z", "a", "m", "b"];
      await s.putEvents(ids.map((id) => ev({ id, ts: 5 })));
      assert.deepEqual((await s.listEvents("s1")).map((e) => e.id), ids);
    } finally {
      await s.close();
    }
  });

  it("concurrent overlapping batches never deadlock or double count", async () => {
    const s = await open();
    try {
      const all = Array.from({ length: 2000 }, (_, i) => ev({ id: `c${i}`, ts: i }));
      const a = all.slice(0, 1500);
      const b = all.slice(500).reverse();
      const c = [...all].sort(() => Math.random() - 0.5);
      const results = await Promise.all([s.putEvents(a), s.putEvents(b), s.putEvents(c)]);
      assert.equal(results.reduce((n, r) => n + r.inserted, 0), 2000);
      assert.equal(await s.countEvents(), 2000);
    } finally {
      await s.close();
    }
  });

  it("searches by project and ranks a large message without tsvector overflow", async () => {
    const s = await open();
    try {
      await s.putEvents([
        ev({ id: "d1", kind: "user.message", project: "demo", payload: { text: "pong from demo" } }),
        ev({ id: "f1", kind: "user.message", project: "flood", payload: { text: "pong from flood" } }),
        ev({ id: "big", kind: "assistant.message", payload: { text: `${Array.from({ length: 120_000 }, (_, i) => `w${i}`).join(" ")} pong` } }),
      ]);
      assert.deepEqual((await s.search("pong", { project: "demo" })).map((h) => h.event.id), ["d1"]);
      assert.deepEqual((await s.search("pong")).map((h) => h.event.id).sort(), ["d1", "f1"], "text past the index cap is not searchable");
      assert.deepEqual((await s.search("w5")).length > 0, true);
    } finally {
      await s.close();
    }
  });

  it("deleteBefore removes old sessions with their events and labels, per project", async () => {
    const s = await open();
    try {
      const stats = { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 };
      await s.upsertSession({ id: "old", agent: "sdk", startedAt: 10, endedAt: 20, stats, flags: [] });
      await s.upsertSession({ id: "demo/old", project: "demo", agent: "sdk", startedAt: 10, stats, flags: [] });
      await s.upsertSession({ id: "new", agent: "sdk", startedAt: 10, endedAt: 1000, stats, flags: [] });
      // Event times inside each session: retention judges by last activity, events included.
      await s.putEvents([ev({ sessionId: "old", ts: 10 }), ev({ sessionId: "old", ts: 20 }), ev({ sessionId: "demo/old", project: "demo", ts: 10 }), ev({ sessionId: "new", ts: 1000 })]);
      await s.putLabel({ id: "l1", sessionId: "old", criterion: "outcome", value: "pass", by: "me", ts: 1 });
      await s.putDataset!({ id: "qa", name: "QA", version: "v1", cases: [] }, { now: 1 });
      assert.deepEqual(await s.deleteBefore(100, { project: "default" }), { sessions: 1, events: 2 });
      assert.equal(await s.getSession("old"), undefined);
      assert.ok(await s.getSession("demo/old"), "other projects are untouched");
      assert.deepEqual(await s.listLabels({ sessionId: "old" }), []);
      assert.deepEqual(await s.deleteBefore(100), { sessions: 1, events: 1 });
      assert.ok(await s.getSession("new"));
      await s.putEvents([ev({ sessionId: "new", ts: 5000 })]);
      assert.deepEqual(await s.deleteBefore(2000), { sessions: 0, events: 0 }, "an event after the cutoff keeps a session that ended before it");
      assert.ok(await s.getDataset!("qa"), "eval assets are never deleted");
    } finally {
      await s.close();
    }
  });

  it("deleteBefore works through more sessions than one chunk", async () => {
    const s = await open();
    try {
      const stats = { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 };
      const ids = Array.from({ length: 1203 }, (_, i) => `s${i}`);
      for (let i = 0; i < ids.length; i += 50) {
        await Promise.all(ids.slice(i, i + 50).map((id) => s.upsertSession({ id, agent: "sdk", startedAt: 1, stats, flags: [] })));
      }
      await s.putEvents(Array.from({ length: 1203 }, (_, i) => ev({ sessionId: `s${i}`, ts: 1 })));
      assert.deepEqual(await s.deleteBefore(2), { sessions: 1203, events: 1203 });
      assert.deepEqual(await s.listSessions(), []);
    } finally {
      await s.close();
    }
  });

  it("the writer lock is exclusive per schema and hands over on release", async () => {
    const schema = `t_lock_${Date.now().toString(36)}`;
    const a = await PgIndexStore.open(schemaUrl(schema));
    const b = await PgIndexStore.open(schemaUrl(schema, { pool_max: "2" }));
    const other = await open();
    try {
      const la = await a.acquireWriterLock();
      assert.ok(la, "first replica takes the lock");
      assert.equal(await b.acquireWriterLock(), undefined, "second replica stands by");
      const lo = await other.acquireWriterLock();
      assert.ok(lo, "another schema has its own lock");
      const waiting = b.acquireWriterLock({ waitMs: 5000 });
      await new Promise((r) => setTimeout(r, 300));
      await la!.release();
      const lb = await waiting;
      assert.ok(lb, "standby takes over after release");
      await lb!.release();
      await lo!.release();
      // A crashed holder (connection gone) frees the lock too.
      const lc = await a.acquireWriterLock();
      assert.ok(lc);
      await a.close();
      assert.ok(await b.acquireWriterLock({ waitMs: 5000 }), "lock is freed when its holder closes");
    } finally {
      await a.close();
      await b.close();
      await other.close();
      const cleanup = await PgIndexStore.open(schemaUrl(schema), { dropSchemaOnClose: true });
      await cleanup.close();
    }
  });

  it("blob stat refreshes on a dedupe hit and compact runs", async () => {
    const url = schemaUrl();
    const blobs = await PgBlobStore.open(url, { dropSchemaOnClose: true });
    const index = await PgIndexStore.open(url);
    try {
      const ref = await blobs.put("age me");
      const client = new pg.Client({ connectionString: PG_URL });
      await client.connect();
      await client.query(`UPDATE "${blobs.schema}".blobs SET created_at = 1 WHERE ref = $1`, [ref]);
      await client.end();
      assert.equal((await blobs.stat(ref))?.mtimeMs, 1);
      await blobs.put("age me");
      assert.ok((await blobs.stat(ref))!.mtimeMs > Date.now() - 60_000);
      await index.compact!();
    } finally {
      await index.close();
      await blobs.close();
    }
  });

  it("open errors name the database but never the password", async () => {
    const u = new URL(PG_URL!);
    u.password = "definitely-wrong-password";
    u.searchParams.set("schema", "t_nope");
    await assert.rejects(PgIndexStore.open(u.toString()), (err: Error) => {
      assert.match(err.message, /cannot open postgres/);
      assert.ok(!err.message.includes("definitely-wrong-password"), err.message);
      return true;
    });
  });
});
