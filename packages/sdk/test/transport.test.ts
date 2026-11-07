import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { flush, init, shutdown, stats, trace, withSession } from "../src/index.ts";
import { _reset } from "../src/client.ts";
import { baseUrl, resolveConfig } from "../src/config.ts";
import { retryAfterMs, Transport } from "../src/transport.ts";
import { type FakeServe, startFakeServe } from "./helpers/fake-serve.ts";

let serve: FakeServe;
const KEY = "csh_ik_" + "a".repeat(43);

before(async () => {
  serve = await startFakeServe({ keys: { [KEY]: "demo" } });
});
after(async () => {
  assert.deepEqual(serve.rejected, [], "the real server parser accepts every SDK event");
  await serve.close();
});
beforeEach(() => {
  _reset();
  serve.requests.length = 0;
});

const ingestRequests = () => serve.requests.filter((r) => r.path === "/v1/ingest");
const eventsIn = (r: { body: unknown }) => (r.body as { events: { id: string }[] }).events;

/** Records n tool spans in one trace (2 events each, plus the trace's own 3). */
function burst(n: number, sessionId?: string): void {
  trace(
    "burst",
    () => {
      for (let i = 0; i < n; i++) {
        trace("noop", () => i); // nested: a step span → 1 event
      }
    },
    sessionId ? { sessionId } : {},
  );
}

test("config: env and options, base URL normalization, disabled without a URL", () => {
  assert.equal(baseUrl("https://obs.example.com/"), "https://obs.example.com");
  assert.equal(baseUrl("https://obs.example.com/v1/ingest"), "https://obs.example.com");
  const c = resolveConfig({}, { CODING_SH_URL: "http://h:4318", CODING_SH_INGEST_KEY: KEY, OTEL_SERVICE_NAME: "svc", CODING_SH_CAPTURE_MODE: "metadata" });
  assert.equal(c.url, "http://h:4318");
  assert.equal(c.key, KEY);
  assert.equal(c.service, "svc");
  assert.equal(c.capture, "metadata");
  assert.equal(c.maxBatch, 500);
  assert.equal(resolveConfig({ maxBatch: 5000 }, {}).maxBatch, 500);
  assert.equal(resolveConfig({}, {}).url, undefined);
  assert.equal(resolveConfig({}, { CODING_SH_URL: "http://h", CODING_SH_DISABLED: "1" }).url, undefined);
  assert.equal(resolveConfig({ url: "http://x" }, { CODING_SH_URL: "http://h" }).url, "http://x");
});

test("no URL: nothing is queued or sent, and the app works", async () => {
  init({});
  const out = trace("t", () => 42);
  assert.equal(out, 42);
  assert.equal(await flush(100), true);
  assert.deepEqual(stats(), { queued: 0, sent: 0, dropped: 0, failed: 0 });
  assert.equal(serve.requests.length, 0);
});

test("batches ≤ maxBatch, gzip, bearer key, service, project scoping", async () => {
  init({ url: serve.url, key: KEY, service: "Checkout API", flushIntervalMs: 20, maxBatch: 50 });
  burst(120, "batch-s");
  assert.equal(await flush(), true);
  const reqs = ingestRequests();
  assert.ok(reqs.length >= 3, `requests: ${reqs.length}`);
  for (const r of reqs) {
    assert.ok(eventsIn(r).length <= 50);
    assert.equal(r.headers.authorization, `Bearer ${KEY}`);
    assert.equal((r.body as { service: string }).service, "Checkout API");
    assert.equal((r.body as { v: number }).v, 0);
  }
  assert.ok(reqs.some((r) => r.gzip), "large batches are gzipped");
  const total = reqs.reduce((n, r) => n + eventsIn(r).length, 0);
  assert.equal(total, 120 + 2); // 120 step spans + session.start + turn.end (conversation: no session.end)
  assert.equal(stats().sent, total);
  const s = serve.session("demo/batch-s")!;
  assert.equal(s.stats.events, total);
  assert.equal(s.agent, "checkout-api");
});

test("429 with Retry-After and 503 are retried with the same event ids; nothing duplicates", async () => {
  init({ url: serve.url, key: KEY, flushIntervalMs: 10 });
  serve.plan({ status: 429, retryAfter: "0" }, { status: 503, retryAfter: "0" });
  withSession("retry-s", () => trace("t", () => "ok"));
  assert.equal(await flush(), true);
  const reqs = ingestRequests();
  assert.equal(reqs.length, 3);
  assert.deepEqual(reqs.map((r) => r.status), [429, 503, 200]);
  const ids = reqs.map((r) => eventsIn(r).map((e) => e.id).join(","));
  assert.equal(new Set(ids).size, 1, "every attempt carries the same ids");
  assert.equal(stats().sent, 2);
  assert.equal(stats().failed, 0);
});

test("without Retry-After the first retry waits ~1 s", async () => {
  init({ url: serve.url, key: KEY, flushIntervalMs: 10 });
  serve.plan({ status: 500 });
  const t0 = Date.now();
  withSession("backoff-s", () => trace("t", () => 1));
  assert.equal(await flush(5000), true);
  const waited = Date.now() - t0;
  assert.ok(waited >= 950 && waited < 3000, `waited ${waited} ms`);
});

test("401 drops the batch and warns once", async () => {
  init({ url: serve.url, key: "csh_ik_wrong", flushIntervalMs: 10 });
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => void warns.push(m);
  try {
    trace("a", () => 1);
    await flush();
    trace("b", () => 1);
    await flush();
  } finally {
    console.warn = orig;
  }
  assert.equal(ingestRequests().length, 2);
  assert.equal(stats().sent, 0);
  assert.equal(stats().failed, 6);
  assert.equal(warns.length, 1);
  assert.match(warns[0]!, /401/);
  assert.doesNotMatch(warns[0]!, /csh_ik_wrong/, "never prints the key");
});

test("a full queue drops new events, counts them and warns at most once a minute", async () => {
  init({ url: serve.url, key: KEY, flushIntervalMs: 60_000, maxQueue: 10, maxBatch: 500 });
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => void warns.push(m);
  try {
    burst(20);
    burst(5);
  } finally {
    console.warn = orig;
  }
  const s = stats();
  assert.equal(s.queued, 10);
  assert.equal(s.dropped, 20 + 3 + 5 + 3 - 10);
  assert.equal(warns.length, 1);
  assert.equal(await flush(), true);
  assert.equal(stats().sent, 10);
});

test("server down: flush and close are bounded, the batch is counted failed once, never throws", async () => {
  const t = new Transport(resolveConfig({ url: "http://127.0.0.1:9", flushIntervalMs: 10 }, {}));
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => void warns.push(m);
  try {
    t.enqueue("event", { v: 0, id: "x", sessionId: "s", kind: "span", ts: 1, payload: {} });
    const t0 = Date.now();
    assert.equal(await t.flush(300), false);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(await t.close(200), false);
    assert.equal(t.stats().failed, 1);
    assert.equal(t.stats().queued, 0);
  } finally {
    console.warn = orig;
  }
});

test("at most 5 attempts per batch, then it is dropped and counted", async () => {
  init({ url: serve.url, key: KEY, flushIntervalMs: 10 });
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => void warns.push(m);
  try {
    serve.plan(...Array.from({ length: 5 }, () => ({ status: 503, retryAfter: "0" })));
    withSession("five-s", () => trace("t", () => 1));
    assert.equal(await flush(), true);
  } finally {
    console.warn = orig;
  }
  assert.equal(ingestRequests().length, 5);
  assert.equal(stats().failed, 2);
  assert.match(warns.join("\n"), /after 5 attempts/);
});

test("shutdown flushes, then the SDK stops sending", async () => {
  init({ url: serve.url, key: KEY, flushIntervalMs: 60_000 });
  withSession("shutdown-s", () => trace("t", () => 1));
  assert.equal(await shutdown(), true);
  const n = ingestRequests().length;
  assert.equal(n, 1);
  trace("after", () => 1);
  await flush(100);
  assert.equal(ingestRequests().length, n);
});

test("Retry-After parsing", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs(null), undefined);
  assert.equal(retryAfterMs("junk"), undefined);
  const d = retryAfterMs(new Date(Date.now() + 3000).toUTCString())!;
  assert.ok(d > 1000 && d <= 3000);
});
