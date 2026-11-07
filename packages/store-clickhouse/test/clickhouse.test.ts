// ClickHouse-specific behaviour beyond the shared conformance suite: URL and
// parameter handling, concurrent migrations, upserts read before any merge,
// the lease writer lock, retention in chunks, and values that would break a
// hand-built SQL string.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent, Session } from "coding.sh/store";
import { ChClient, ChIndexStore, encodeParam, indexStore, likeTerms, parseChUrl, quoteLiteral, redactUrl, searchText } from "../src/index.ts";
import { CH_URL, SKIP, dbUrl } from "./helpers.ts";

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
const stats = { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 };
const session = (over: Partial<Session> = {}): Session => ({ id: "s1", agent: "sdk", startedAt: 1, stats, flags: [], ...over });

describe("clickhouse URL and parameters", () => {
  it("parses clickhouse:// and clickhouses:// with defaults", () => {
    const a = parseChUrl("clickhouse://u:p%40ss@ch.example.com:8123/coding");
    assert.deepEqual(a, { endpoint: "http://ch.example.com:8123/", user: "u", password: "p@ss", database: "coding", settings: {} });
    const b = parseChUrl("clickhouses://u:p@abc.clickhouse.cloud/coding");
    assert.equal(b.endpoint, "https://abc.clickhouse.cloud:8443/");
    const c = parseChUrl("clickhouse://localhost");
    assert.deepEqual([c.endpoint, c.user, c.password, c.database], ["http://localhost:8123/", "default", "", "default"]);
    const d = parseChUrl("clickhouse://h:8443/db?secure=1&select_sequential_consistency=1");
    assert.equal(d.endpoint, "https://h:8443/");
    assert.deepEqual(d.settings, { select_sequential_consistency: "1" });
  });

  it("rejects bad databases, settings and schemes without echoing the password", () => {
    assert.throws(() => parseChUrl("clickhouse://u:secret@h/a;drop"), /invalid database/);
    assert.throws(() => parseChUrl("clickhouse://u:secret@h/db?Bad-Key=1"), /invalid setting/);
    assert.throws(() => parseChUrl("mysql://u:secret@h/db"), (err: Error) => /scheme/.test(err.message) && !err.message.includes("secret"));
  });

  it("redacts passwords", () => {
    assert.equal(redactUrl("clickhouses://user:hunter2@host:8443/db"), "clickhouses://user:***@host:8443/db");
    assert.equal(redactUrl("clickhouse://host/db"), "clickhouse://host/db");
  });

  it("encodes parameters so no value can end its own placeholder", () => {
    assert.equal(encodeParam("a\\b\tc\nd\0"), "a\\\\b\\tc\\nd\\0");
    assert.equal(encodeParam(null), "\\N");
    assert.equal(encodeParam(1.5), "1.5");
    assert.equal(encodeParam(["x", "it's", "back\\slash"]), "['x','it\\'s','back\\\\slash']");
    assert.equal(quoteLiteral("'); DROP TABLE x; --"), "'\\'); DROP TABLE x; --'");
    assert.throws(() => encodeParam(Number.NaN));
  });

  it("builds LIKE terms from letters and digits only", () => {
    assert.deepEqual(likeTerms("Café  zürich!"), ["cafe", "zurich"]);
    assert.deepEqual(likeTerms("100% _done_ \\x"), ["100", "done", "x"]);
    assert.deepEqual(likeTerms(" & | ! :* "), []);
    assert.equal(searchText(ev({ kind: "user.message", payload: { text: "Hello, Wörld_42" } })), " hello world 42");
    assert.equal(searchText(ev({ kind: "notification", payload: { text: "x" } })), "");
  });
});

describe("clickhouse store", { skip: SKIP }, () => {
  const open = (url = dbUrl()) => ChIndexStore.open(url, { dropDatabaseOnClose: true });

  it("the factory opens a migrated store of kind clickhouse", async () => {
    const url = dbUrl();
    const index = await indexStore(url);
    try {
      assert.equal(index.kind, "clickhouse");
      await index.ping!();
    } finally {
      await index.close();
      await (await open(url)).close();
    }
  });

  it("replicas migrating the same new database at once all succeed", async () => {
    const url = dbUrl();
    const stores = await Promise.all([1, 2, 3, 4].map(() => ChIndexStore.open(url)));
    try {
      const rows = await stores[0]!.client.query<{ version: number }>(`SELECT version FROM ${stores[0]!.database}.coding_sh_migrations FINAL`);
      assert.deepEqual(rows.map((r) => r.version), [1]);
    } finally {
      for (const s of stores) await s.close();
      await (await open(url)).close();
    }
  });

  it("round-trips fractional ms, control characters and quotes in every text column", async () => {
    const s = await open();
    try {
      const nasty = "it's a \\ back\tslash\nline\u0000nul ✓ 😀 '); DROP TABLE events; --";
      const e = ev({ id: `x${nasty}`, sessionId: `s${nasty}`, ts: 1_700_000_000_123.456, durationMs: 0.25, model: nasty, project: "demo", payload: { text: nasty } });
      assert.deepEqual(await s.putEvents([e]), { inserted: 1 });
      assert.deepEqual(await s.listEvents(`s${nasty}`), [e]);
      assert.deepEqual(await s.putEvents([e]), { inserted: 0 });
      await s.upsertSession(session({ id: `s${nasty}`, project: "demo", title: nasty, flags: [nasty], startedAt: 1.5, endedAt: 2.75 }));
      const back = await s.getSession(`s${nasty}`);
      assert.equal(back?.title, nasty);
      assert.equal(back?.endedAt, 2.75);
      assert.deepEqual((await s.listSessions({ flag: nasty })).map((x) => x.id), [`s${nasty}`]);
      await s.kvSet(nasty, nasty);
      assert.equal(await s.kvGet(nasty), nasty);
      assert.deepEqual(await s.sessionIdsByPrefix("s'", 5), []);
      assert.deepEqual(await s.sessionIdsByPrefix("sit's", 5), [`s${nasty}`]);
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

  it("reads the newest upsert before any merge, and after OPTIMIZE", async () => {
    const s = await open();
    try {
      for (let i = 0; i < 20; i++) await s.upsertSession(session({ title: `v${i}`, stats: { ...stats, events: i } }));
      assert.equal((await s.getSession("s1"))?.title, "v19");
      assert.equal((await s.listSessions()).length, 1);
      await s.compact();
      assert.equal((await s.getSession("s1"))?.stats.events, 19);
    } finally {
      await s.close();
    }
  });

  it("concurrent overlapping batches insert each id once", async () => {
    const s = await open();
    try {
      const all = Array.from({ length: 6000 }, (_, i) => ev({ id: `c${i}`, ts: i, sessionId: `s${i % 7}` }));
      const results = await Promise.all([s.putEvents(all.slice(0, 4000)), s.putEvents(all.slice(1000).reverse()), s.putEvents([...all].sort(() => Math.random() - 0.5))]);
      assert.equal(results.reduce((n, r) => n + r.inserted, 0), 6000);
      assert.equal(await s.countEvents(), 6000);
    } finally {
      await s.close();
    }
  });

  it("FINAL hides an event two processes both inserted", async () => {
    const url = dbUrl();
    const a = await ChIndexStore.open(url);
    const b = await ChIndexStore.open(url);
    try {
      const e = ev({ id: "dup", kind: "user.message", payload: { text: "twice stored" } });
      // Two stores do not share the in-process lock, so both may write the row.
      await Promise.all([a.putEvents([e]), b.putEvents([e])]);
      assert.equal((await a.listEvents("s1")).length, 1);
      assert.equal((await a.search("twice")).length, 1);
      assert.equal(await a.countEvents(), 1);
    } finally {
      await a.close();
      await b.close();
      await (await open(url)).close();
    }
  });

  it("searches by project, with prefixes, and not past the index cap", async () => {
    const s = await open();
    try {
      await s.putEvents([
        ev({ id: "d1", kind: "user.message", project: "demo", payload: { text: "pong from demo" } }),
        ev({ id: "f1", kind: "user.message", project: "flood", payload: { text: "pong from flood" } }),
        ev({ id: "big", kind: "assistant.message", payload: { text: `${Array.from({ length: 40_000 }, (_, i) => `w${i}`).join(" ")} pong` } }),
        ev({ id: "pct", kind: "user.message", payload: { text: "100% done_now" } }),
      ]);
      assert.deepEqual((await s.search("pong", { project: "demo" })).map((h) => h.event.id), ["d1"]);
      assert.deepEqual((await s.search("pong")).map((h) => h.event.id).sort(), ["d1", "f1"], "text past the index cap is not searchable");
      assert.ok((await s.search("w5")).length > 0);
      assert.deepEqual((await s.search("%")).map((h) => h.event.id), [], "a bare wildcard matches nothing");
      assert.deepEqual((await s.search("10 don")).map((h) => h.event.id), ["pct"]);
    } finally {
      await s.close();
    }
  });

  it("setEventCosts writes a new version in place", async () => {
    const s = await open();
    try {
      const e = ev({ id: "call", kind: "llm.call", ts: 7, usage: { inputTokens: 10 }, payload: { model: "m", pricedAs: "old", priceTier: "batch" } });
      await s.putEvents([e, ev({ id: "later", ts: 7 })]);
      assert.equal(await s.setEventCosts([{ id: "call", costUsd: 0.5 }, { id: "missing", costUsd: 1 }]), 1);
      const [first, second] = await s.listEvents("s1");
      assert.equal(first?.id, "call", "seq is kept");
      assert.deepEqual(first?.usage, { inputTokens: 10, costUsd: 0.5 });
      assert.deepEqual(first?.payload, { model: "m", costEstimated: true });
      assert.equal(second?.id, "later");
      assert.equal(await s.countEvents(), 2);
      await s.setEventCosts([{ id: "call", costUsd: 0.25, priceTier: "long-context" }]);
      assert.deepEqual((await s.listEvents("s1"))[0]?.payload, { model: "m", costEstimated: true, priceTier: "long-context" });
    } finally {
      await s.close();
    }
  });

  it("deleteBefore works through more sessions than one chunk", async () => {
    const s = await open();
    try {
      const ids = Array.from({ length: 1203 }, (_, i) => `s${i}`);
      for (let i = 0; i < ids.length; i += 100) await Promise.all(ids.slice(i, i + 100).map((id) => s.upsertSession(session({ id }))));
      await s.putEvents(ids.map((id) => ev({ sessionId: id, ts: 1 })));
      await s.putEvents([ev({ sessionId: "s5", ts: 50 })]);
      assert.deepEqual(await s.deleteBefore(2), { sessions: 1202, events: 1202 });
      assert.deepEqual((await s.listSessions()).map((x) => x.id), ["s5"]);
    } finally {
      await s.close();
    }
  });

  it("the writer lock is exclusive per database and hands over on release", async () => {
    const url = dbUrl();
    const a = await ChIndexStore.open(url, { lockSettleMs: 100 });
    const b = await ChIndexStore.open(url, { lockSettleMs: 100 });
    const other = await open();
    try {
      const la = await a.acquireWriterLock();
      assert.ok(la, "first replica takes the lock");
      la.assertHeld!();
      assert.equal(await b.acquireWriterLock(), undefined, "second replica stands by");
      const lo = await other.acquireWriterLock();
      assert.ok(lo, "another database has its own lock");
      const waiting = b.acquireWriterLock({ waitMs: 5000 });
      await new Promise((r) => setTimeout(r, 300));
      await la.release();
      assert.throws(() => la.assertHeld!(), /released/);
      const lb = await waiting;
      assert.ok(lb, "standby takes over after release");
      await lb.release();
      await lo.release();
      const lc = await a.acquireWriterLock();
      assert.ok(lc);
      await a.close();
      assert.ok(await b.acquireWriterLock({ waitMs: 5000 }), "closing the holder releases the lock");
    } finally {
      await a.close();
      await b.close();
      await other.close();
      await (await open(url)).close();
    }
  });

  it("a crashed holder's lease runs out, and its assertHeld then fails", async () => {
    const url = dbUrl();
    const a = await ChIndexStore.open(url, { lockTtlMs: 1500, lockSettleMs: 100 });
    const b = await ChIndexStore.open(url, { lockTtlMs: 1500, lockSettleMs: 100 });
    try {
      const la = await a.acquireWriterLock();
      assert.ok(la);
      // Stall a's heartbeat, as a frozen process would: its claims stop renewing.
      const client = a.client as unknown as { exec: ChClient["exec"] };
      const realExec = client.exec.bind(a.client);
      client.exec = async () => {
        throw new Error("network down");
      };
      const lb = await b.acquireWriterLock({ waitMs: 5000 });
      assert.ok(lb, "the standby takes over once the lease runs out");
      assert.throws(() => la.assertHeld!(), /lease ran out|took the writer lock/);
      client.exec = realExec;
      await lb.release();
    } finally {
      await a.close();
      await b.close();
      await (await open(url)).close();
    }
  });

  it("open errors name the server but never the password", async () => {
    const u = new URL(CH_URL!);
    u.password = "definitely-wrong-password";
    await assert.rejects(ChIndexStore.open(u.toString()), (err: Error) => {
      assert.match(err.message, /cannot open clickhouse/);
      assert.ok(!err.message.includes("definitely-wrong-password"), err.message);
      return true;
    });
  });
});
