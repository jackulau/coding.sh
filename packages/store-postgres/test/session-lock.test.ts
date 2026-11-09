// The per-session lock (rebuildSession: pg_advisory_xact_lock on the session id)
// that lets several function instances behind coding.sh/server's
// createFetchHandler write one session at once. Live Postgres only.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { AgentEvent, Session } from "coding.sh/store";
import { createFetchHandler, resolveServeConfig } from "coding.sh/server";
import { PgBlobStore, PgIndexStore } from "../src/index.ts";
import { PG_URL, SKIP, schemaUrl } from "./helpers.ts";

const open: { close(): Promise<void> }[] = [];
after(async () => {
  for (const s of open.reverse()) await s.close().catch(() => {});
});

async function store(url: string): Promise<PgIndexStore> {
  const s = await PgIndexStore.open(url, { dropSchemaOnClose: true });
  open.push(s);
  return s;
}

const ev = (id: string, sessionId: string, tokens: number): AgentEvent => ({
  id,
  v: 0,
  sessionId,
  ts: 1_700_000_000_000 + Number(id.replace(/\D/g, "") || 0),
  agent: "sdk",
  kind: "llm.call",
  model: "gpt-4o",
  usage: { inputTokens: tokens, outputTokens: 1 },
  payload: {},
});

/** A session whose stats are a pure function of its events. */
const build = (id: string) => (_prev: Session | undefined, events: AgentEvent[]): Session | undefined =>
  events.length
    ? {
        id,
        agent: "sdk",
        startedAt: events[0]!.ts,
        flags: [],
        stats: { events: events.length, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { inputTokens: events.reduce((n, e) => n + (e.usage?.inputTokens ?? 0), 0), outputTokens: events.length } },
      }
    : undefined;

describe("postgres per-session lock", { skip: SKIP }, () => {
  it("an unlocked read-modify-write loses a concurrent writer's events (the race the lock prevents)", async () => {
    const url = schemaUrl();
    const a = await store(url);
    const b = await PgIndexStore.open(url);
    open.push(b);
    await a.putEvents([ev("e1", "s", 10)]);
    // Writer A reads, then stalls; writer B commits an event and rebuilds; A writes what it read.
    const stale = await a.listEvents("s");
    await b.putEvents([ev("e2", "s", 20)]);
    await b.upsertSession(build("s")(undefined, await b.listEvents("s"))!);
    await a.upsertSession(build("s")(undefined, stale)!);
    assert.equal((await a.getSession("s"))!.stats.events, 1, "the unlocked rebuild overwrote the newer one");
    // With the lock, a rebuild that starts after B's commit always sees both.
    await a.rebuildSession("s", build("s"));
    assert.equal((await a.getSession("s"))!.stats.events, 2);
  });

  it("holds the lock for the whole transaction: a second rebuild of the same session waits for the first", async () => {
    const url = schemaUrl();
    const a = await store(url);
    const b = await PgIndexStore.open(url);
    open.push(b);
    await a.putEvents([ev("e1", "s", 1)]);
    const order: string[] = [];
    // Hold the session's lock from a raw transaction, as a slow rebuild would.
    const pg = (await import("pg")).default;
    const c = new pg.Client({ connectionString: new URL(PG_URL!).toString() });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`coding.sh:session:${a.schema}:s`]);
      const waiting = b.rebuildSession("s", (prev, events) => (order.push("rebuild"), build("s")(prev, events))).then(() => order.push("done"));
      await new Promise((r) => setTimeout(r, 300));
      order.push("release");
      await c.query("COMMIT");
      await waiting;
    } finally {
      await c.end();
    }
    assert.deepEqual(order, ["release", "rebuild", "done"]);
    // Another session's rebuild never waits on this one's lock.
    await a.putEvents([ev("e9", "other", 1)]);
    assert.equal((await a.rebuildSession("other", build("other")))!.stats.events, 1);
  });

  it("many concurrent writers to one session end with every event counted", async () => {
    const url = schemaUrl();
    const writers = [await store(url)];
    for (let i = 1; i < 4; i++) {
      const w = await PgIndexStore.open(url);
      open.push(w);
      writers.push(w);
    }
    let n = 0;
    await Promise.all(
      writers.map(async (w, wi) => {
        for (let r = 0; r < 25; r++) {
          await w.putEvents([ev(`w${wi}r${r}`, "hot", 1 + wi)]);
          n++;
          await w.rebuildSession("hot", build("hot"));
        }
      }),
    );
    const s = (await writers[0]!.getSession("hot"))!;
    assert.equal(s.stats.events, n);
    assert.equal(s.stats.usage?.inputTokens, 25 * (1 + 2 + 3 + 4));
  });

  it("two fetch-handler instances writing one session give the same stats as one writing serially", async () => {
    const env = { HOME: "/nonexistent-home", CODING_SH_HOME: "/nonexistent-home/.coding.sh", CODING_SH_INSECURE: "1", CODING_SH_STORE_URL: "memory://", CODING_SH_LOG: "json" };
    const quiet = { log() {}, info() {}, warn() {}, error() {} };
    const handler = async (url: string) => {
      const index = await PgIndexStore.open(url);
      const blobs = await PgBlobStore.open(url);
      const h = createFetchHandler({ config: resolveServeConfig({}, env), log: quiet, enrichSpan: false, stores: { index, blobs } });
      return h;
    };
    const NOW = Date.now() - 60_000;
    const events = Array.from({ length: 60 }, (_, i) => ({
      v: 0,
      id: `ev-${i}`,
      sessionId: "chat-1",
      ts: NOW + i * 10,
      kind: i % 3 === 0 ? "user.message" : i % 3 === 1 ? "llm.call" : "assistant.message",
      model: "gpt-4o",
      usage: i % 3 === 1 ? { inputTokens: 100 + i, outputTokens: 5 } : undefined,
      payload: { text: `message ${i}` },
    }));
    const post = (h: (r: Request) => Promise<Response>, e: unknown) =>
      h(new Request("https://fn.example.com/v1/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 0, service: "app", events: [e] }) })).then(async (r) => {
        assert.equal(r.status, 200, await r.text());
      });

    // Serial: one instance, one request after another.
    const serialUrl = schemaUrl();
    const serialCheck = await store(serialUrl);
    const one = await handler(serialUrl);
    for (const e of events) await post(one, e);
    await one.close();

    // Concurrent: two instances, alternating events, all requests in flight at once.
    const concUrl = schemaUrl();
    const concCheck = await store(concUrl);
    const [a, b] = [await handler(concUrl), await handler(concUrl)];
    await Promise.all(events.map((e, i) => post(i % 2 ? a : b, e)));
    await a.close();
    await b.close();

    const serial = (await serialCheck.getSession("chat-1"))!;
    const same = async (check: PgIndexStore, what: string) => {
      const conc = (await check.getSession("chat-1"))!;
      assert.equal((await check.listEvents("chat-1")).length, 60, what);
      assert.equal(conc.stats.events, 60, what);
      assert.deepEqual(conc.stats, serial.stats, what);
      assert.deepEqual(conc.flags, serial.flags, what);
      assert.equal(conc.startedAt, serial.startedAt, what);
      assert.equal(conc.endedAt, serial.endedAt, what);
    };
    await same(concCheck, "free-for-all");

    // The race, forced: instance A reads the session's events, then stalls before it writes
    // the rebuilt session (a slow database), while instance B commits the other half and
    // rebuilds. Unlocked, A's late write of what it read wins and drops B's events (this
    // fails with rebuildSession removed). With the lock, B's rebuild waits for A's and sees all.
    const raceUrl = schemaUrl();
    const raceCheck = await store(raceUrl);
    const slowIndex = await PgIndexStore.open(raceUrl);
    let readSeen!: () => void;
    const aRead = new Promise<void>((r) => (readSeen = r));
    let bDone!: () => void;
    const bFinished = new Promise<void>((r) => (bDone = r));
    let gated = false;
    // Tables are "<schema>".events; the pool is shared by every store on one URL, so gate only the first read (A's).
    const eventsRead = /FROM "[^"]+"\.events WHERE session_id/;
    type Q = (...args: unknown[]) => unknown;
    (slowIndex as unknown as { pool: { on(ev: "acquire", f: (c: { query: Q; slowed?: true }) => void): void } }).pool.on("acquire", (client) => {
      if (client.slowed) return;
      client.slowed = true;
      const orig = client.query.bind(client) as Q;
      client.query = (...args: unknown[]) => {
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text;
        if (gated || !sql || !eventsRead.test(sql)) return orig(...args);
        gated = true;
        const cb = typeof args[args.length - 1] === "function" ? (args.pop() as (e: unknown, r?: unknown) => void) : undefined;
        const p = (orig(...args) as Promise<unknown>).then(async (r) => {
          readSeen();
          // Hold the stale read until B has committed and rebuilt, or 1 s (B waits on the lock).
          await Promise.race([bFinished, new Promise((t) => setTimeout(t, 1000))]);
          return r;
        });
        if (!cb) return p;
        p.then((r) => cb(null, r), (e) => cb(e));
        return undefined;
      };
    });
    const slowA = createFetchHandler({ config: resolveServeConfig({}, env), log: quiet, enrichSpan: false, stores: { index: slowIndex, blobs: await PgBlobStore.open(raceUrl) } });
    const fastB = await handler(raceUrl);
    const batch = (h: (r: Request) => Promise<Response>, evs: unknown[]) =>
      h(new Request("https://fn.example.com/v1/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 0, service: "app", events: evs }) })).then(async (r) => {
        assert.equal(r.status, 200, await r.text());
      });
    const aPost = batch(slowA, events.filter((_, i) => i % 2 === 0));
    await Promise.race([aRead, new Promise((_, no) => setTimeout(() => no(new Error("A never read the events through the slowed pool")), 10_000).unref())]);
    await batch(fastB, events.filter((_, i) => i % 2 === 1));
    bDone();
    await aPost;
    await slowA.close();
    await fastB.close();
    assert.ok(gated, "A's rebuild read the events through the slowed connection");
    await same(raceCheck, "forced race");
  });
});

if (!PG_URL) {
  describe("postgres per-session lock (live)", () => {
    it("runs against CODING_SH_TEST_PG_URL", { skip: SKIP }, () => {});
  });
}
