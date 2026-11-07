// End-to-end tests for `coding.sh serve` (docs/PRODUCTION.md §1-§2), run once
// against the memory store and once against SQLite: auth on every route,
// project scoping, native + OTLP ingest, body limits, backpressure (429 +
// Retry-After), apportioned `inserted`, crash repair, single writer + standby,
// and graceful shutdown.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { generateKey, sha256 } from "../../src/server/auth.ts";
import { resolveServeConfig, type ServeConfig } from "../../src/server/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { DIRTY_KEY, IngestQueue } from "../../src/server/queue.ts";
import { startServe, type ServeHandle, type ServeOptions } from "../../src/server/serve.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import type { IndexStore } from "../../src/core/types.ts";
import { otlpSpan, otlpTraces, sAttr } from "../otel/_encode.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import { openIndexStore } from "../../src/store/factory.ts";
import { experimentResult } from "../viewer/fakes.ts";

const dirs: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.shutdown().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "csh-serve-e2e-"));
  dirs.push(root);
  mkdirSync(join(root, "home"));
  return { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), CODING_SH_LOG: "json", ...extra };
}

const logs: string[] = [];
const quiet = () => createLogger({ format: "json", write: (l) => logs.push(l) });

type StoreKind = "memory" | "sqlite";

async function serve(kind: StoreKind, env: NodeJS.ProcessEnv, opts: ServeOptions & { flags?: Parameters<typeof resolveServeConfig>[0] } = {}): Promise<{ h: ServeHandle; cfg: ServeConfig }> {
  const cfg = resolveServeConfig({ port: 0, ...(opts.flags ?? {}) }, kind === "memory" ? { CODING_SH_STORE_URL: "memory://", ...env } : env);
  const h = await startServe(cfg, {
    log: quiet(),
    enrichSpan: false,
    ...(kind === "memory" ? { stores: { index: new MemoryIndexStore(), blobs: new MemoryBlobStore() } } : {}),
    ...opts,
  });
  handles.push(h);
  return { h, cfg };
}

interface Res {
  status: number;
  headers: Headers;
  json: any;
  text: string;
}
async function call(h: ServeHandle, path: string, init: { method?: string; key?: string; body?: unknown; headers?: Record<string, string>; raw?: string | Uint8Array } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  let body: string | Uint8Array | undefined = init.raw;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] ??= "application/json";
  }
  const res = await fetch(h.url + path, { method: init.method ?? (body !== undefined ? "POST" : "GET"), headers, body: body as BodyInit | undefined });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

const NOW = Date.now();
const ev = (id: string, sessionId: string, over: Record<string, unknown> = {}) => ({ v: 0, id, sessionId, ts: NOW - 1000, kind: "llm.call", model: "gpt-4o", usage: { inputTokens: 1000, outputTokens: 10 }, payload: { text: `hello ${id}` }, ...over });
const batch = (events: unknown[], service = "my-api") => ({ v: 0, service, events });
const sessionIds = (r: Res): string[] => ((r.json?.items ?? r.json?.sessions ?? []) as { id: string }[]).map((s) => s.id).sort();

for (const kind of ["memory", "sqlite"] as const) {
  describe(`serve (${kind})`, () => {
    it("answers health and readiness without auth and with no secrets", async () => {
      const ik = generateKey("ingest");
      const { h } = await serve(kind, tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ik}`, CODING_SH_READ_KEYS: generateKey("read") }));
      const hz = await call(h, "/healthz");
      assert.equal(hz.status, 200);
      assert.deepEqual(hz.json, { ok: true });
      const rz = await call(h, "/readyz");
      assert.equal(rz.status, 200);
      assert.equal(rz.json.ok, true);
      assert.equal(rz.json.store, kind);
      assert.equal(rz.json.writer, true);
      assert.deepEqual(rz.json.queue, { events: 0, max: 50_000 });
      assert.ok(!rz.text.includes(ik));
      await h.shutdown();
    });

    it("enforces keys on every route and scopes reads by project", async () => {
      const ikDemo = generateKey("ingest");
      const ikDefault = generateKey("ingest");
      const rkDemo = generateKey("read");
      const rkAll = generateKey("read");
      const { h } = await serve(kind, tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ikDemo},${ikDefault}`, CODING_SH_READ_KEYS: `demo:${rkDemo},*:${rkAll}` }));

      // ingest auth
      const none = await call(h, "/v1/ingest", { body: batch([ev("a", "chat-1")]) });
      assert.equal(none.status, 401);
      assert.equal(none.headers.get("www-authenticate"), "Bearer");
      assert.equal((await call(h, "/v1/ingest", { key: "csh_ik_nope", body: batch([ev("a", "chat-1")]) })).status, 401);
      assert.equal((await call(h, "/v1/ingest", { key: rkAll, body: batch([ev("a", "chat-1")]) })).status, 401, "a read key cannot ingest");
      const otlpNone = await call(h, "/v1/traces", { body: otlpTraces("svc", []) });
      assert.equal(otlpNone.status, 401);
      assert.equal(otlpNone.json?.code, 16);

      // two projects, same client session id
      const d = await call(h, "/v1/ingest", { key: ikDemo, body: batch([ev("a", "chat-1"), ev("b", "chat-1")]) });
      assert.equal(d.status, 200);
      assert.deepEqual(d.json, { accepted: 2, inserted: 2, rejected: [] });
      const again = await call(h, "/v1/ingest", { key: ikDemo, body: batch([ev("a", "chat-1"), ev("b", "chat-1")]) });
      assert.deepEqual(again.json, { accepted: 2, inserted: 0, rejected: [] }, "retries are idempotent");
      const def = await call(h, "/v1/ingest", { key: ikDefault, body: batch([ev("a", "chat-1")]) });
      assert.equal(def.json.inserted, 1, "same client id in another project is a different event");

      // read auth
      assert.equal((await call(h, "/api/sessions")).status, 401);
      assert.equal((await call(h, "/api/sessions", { key: ikDemo })).status, 401, "an ingest key cannot read");
      assert.deepEqual(sessionIds(await call(h, "/api/sessions", { key: rkAll })), ["chat-1", "demo/chat-1"]);
      assert.deepEqual(sessionIds(await call(h, "/api/sessions?project=demo", { key: rkAll })), ["demo/chat-1"]);
      assert.deepEqual(sessionIds(await call(h, "/api/sessions", { key: rkDemo })), ["demo/chat-1"]);
      assert.equal((await call(h, "/api/sessions/chat-1", { key: rkDemo })).status, 404, "another project's session is invisible");
      const own = await call(h, `/api/sessions/${encodeURIComponent("demo/chat-1")}`, { key: rkDemo });
      assert.equal(own.status, 200);
      assert.equal(own.json.project ?? own.json.session?.project, "demo");
      assert.ok((await call(h, "/api/projects", { key: rkAll })).text.includes("demo"));
      // the cookie exchange
      const t = await fetch(`${h.url}/?t=${rkDemo}`, { redirect: "manual" });
      await t.text();
      const cookie = t.headers.get("set-cookie") ?? "";
      assert.match(cookie, /csh_rk=.*HttpOnly/);
      assert.deepEqual(sessionIds(await call(h, "/api/sessions", { headers: { cookie: cookie.split(";")[0]! } })), ["demo/chat-1"]);

      // cost was estimated from the built-in table
      const s = await call(h, "/api/sessions/chat-1", { key: rkAll });
      const usage = s.json.stats?.usage ?? s.json.session?.stats?.usage;
      assert.ok(Math.abs(usage.costUsd - (1000 * 2.5 + 10 * 10) / 1e6) < 1e-12, JSON.stringify(usage));

      // metrics need a read key
      assert.equal((await call(h, "/metrics")).status, 401);
      const m = await call(h, "/metrics", { key: rkAll });
      assert.equal(m.status, 200);
      assert.match(m.text, /coding_sh_ingest_events_total\{project="demo",result="inserted"\} 2/);
      assert.match(m.text, /coding_sh_ingest_auth_failures_total/);
      assert.ok(!m.text.includes(ikDemo) && !m.text.includes(rkAll));
      await h.shutdown();
    });

    it("keeps a default-project key out of another project's sessions (INS-8)", async () => {
      const ikBilling = generateKey("ingest");
      const ikDefault = generateKey("ingest");
      const rkBilling = generateKey("read");
      const rkAll = generateKey("read");
      const { h } = await serve(kind, tmpEnv({ CODING_SH_INGEST_KEYS: `billing:${ikBilling},${ikDefault}`, CODING_SH_READ_KEYS: `billing:${rkBilling},*:${rkAll}` }));
      assert.equal((await call(h, "/v1/ingest", { key: ikBilling, body: batch([ev("a1", "chat-1", { kind: "user.message", payload: { text: "billing's prompt" } })]) })).status, 200);
      const intr = await call(h, "/v1/ingest", { key: ikDefault, body: batch([ev("d1", "billing/chat-1", { kind: "user.message", payload: { text: "injected" } })]) });
      assert.equal(intr.status, 200);
      // OTLP from the default key with a conversation id shaped like billing's namespace.
      const span = otlpSpan("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", undefined, "chat gpt-4o", [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.conversation.id", "billing/chat-1"), sAttr("gen_ai.request.model", "gpt-4o")], 0, 10);
      assert.equal((await call(h, "/v1/traces", { key: ikDefault, body: otlpTraces("intruder", [span]) })).status, 200);

      const evs = await call(h, `/api/sessions/${encodeURIComponent("billing/chat-1")}/events`, { key: rkBilling });
      assert.equal(evs.status, 200, evs.text);
      const items = (evs.json.items ?? evs.json.events ?? evs.json) as AgentEvent[];
      assert.equal(items.length, 1, JSON.stringify(items.map((e) => e.payload)));
      assert.ok(items.every((e) => e.project === "billing"));
      assert.ok(!evs.text.includes("injected"));
      const billingSession = await call(h, `/api/sessions/${encodeURIComponent("billing/chat-1")}`, { key: rkBilling });
      assert.equal(billingSession.json.project ?? billingSession.json.session?.project, "billing");
      assert.deepEqual(sessionIds(await call(h, "/api/sessions", { key: rkBilling })), ["billing/chat-1"]);
      const all = sessionIds(await call(h, "/api/sessions", { key: rkAll }));
      assert.ok(all.includes("default/billing/chat-1"), JSON.stringify(all));
      await h.shutdown();
    });

    it("validates native batches and rejects oversized or wrongly typed bodies", async () => {
      const { h } = await serve(kind, tmpEnv());
      const mixed = await call(h, "/v1/ingest", { body: batch([ev("ok", "s"), { ...ev("bad", "s"), kind: "nope" }]) });
      assert.equal(mixed.status, 200);
      assert.equal(mixed.json.accepted, 1);
      assert.equal(mixed.json.rejected[0].index, 1);
      assert.equal((await call(h, "/v1/ingest", { raw: "{}", headers: { "content-type": "text/plain" } })).status, 415);
      assert.equal((await call(h, "/v1/ingest", { raw: "{nope", headers: { "content-type": "application/json" } })).status, 400);
      assert.equal((await call(h, "/v1/ingest", { method: "GET" })).status, 405);
      const big = new Uint8Array(16 * 1024 * 1024 + 1).fill(32);
      assert.equal((await call(h, "/v1/ingest", { raw: big, headers: { "content-type": "application/json" } })).status, 413);
      assert.equal((await call(h, "/v1/traces", { raw: big, headers: { "content-type": "application/json" } })).status, 413);
      await h.shutdown();
    });

    it("ingests OTLP traces into the key's project", async () => {
      const ik = generateKey("ingest");
      const rk = generateKey("read");
      const { h } = await serve(kind, tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ik}`, CODING_SH_READ_KEYS: rk }));
      const span = otlpSpan("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", undefined, "chat gpt-4o", [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.request.model", "gpt-4o"), sAttr("gen_ai.conversation.id", "conv-9")], 0, 1200);
      const r = await call(h, "/v1/traces", { key: ik, body: otlpTraces("support-bot", [span]) });
      assert.equal(r.status, 200, r.text);
      const ids = sessionIds(await call(h, "/api/sessions", { key: rk }));
      assert.equal(ids.length, 1);
      assert.match(ids[0]!, /^demo\//);
      await h.shutdown();
    });

    // Regression: `coding.sh exp run` results in the server's store never showed in its viewer.
    it("serves dataset experiments from its store to the viewer; project keys see none", async () => {
      const rkAll = generateKey("read");
      const rkDemo = generateKey("read");
      const env = tmpEnv({ CODING_SH_READ_KEYS: `*:${rkAll},demo:${rkDemo}` });
      const mem = new MemoryIndexStore();
      const { h, cfg } = await serve(kind, env, kind === "memory" ? { stores: { index: mem, blobs: new MemoryBlobStore() } } : {});
      // What `coding.sh exp run` does with the same store URL: a second process writing through FileEvalStore.
      const writer = kind === "memory" ? mem : await openIndexStore(cfg.core.store.index, cfg.core);
      const evals = new FileEvalStore({ env, index: writer });
      assert.equal(evals.kind, "index");
      await evals.putExperiment(experimentResult("exp-prod-smoke"));
      if (kind !== "memory") await writer.close();

      const list = await call(h, "/api/experiments", { key: rkAll });
      assert.equal(list.status, 200, list.text);
      assert.deepEqual(list.json.items.map((e: { id: string; name: string; runCount: number }) => [e.id, e.name, e.runCount]), [["exp-prod-smoke", "prod-smoke", 2]]);
      const one = await call(h, "/api/experiments/exp-prod-smoke", { key: rkAll });
      assert.equal(one.json.runs.length, 2);
      assert.equal((await call(h, "/api/experiments")).status, 401);
      assert.deepEqual((await call(h, "/api/experiments", { key: rkDemo })).json, { items: [] });
      assert.equal((await call(h, "/api/experiments/exp-prod-smoke", { key: rkDemo })).status, 404);
      await h.shutdown();
    });

    it("refuses ingest on a viewer replica and runs without a writer lock", async () => {
      const { h } = await serve(kind, tmpEnv(), { flags: { role: "viewer" } });
      assert.equal((await call(h, "/v1/ingest", { body: batch([ev("a", "s")]) })).status, 404);
      const rz = await call(h, "/readyz");
      assert.equal(rz.status, 200);
      assert.equal(rz.json.role, "viewer");
      assert.equal(rz.json.writer, false);
      await h.shutdown();
    });

    it("drains on shutdown: readyz 503, then the port closes and the stores close", async () => {
      const { h } = await serve(kind, tmpEnv());
      assert.equal((await call(h, "/v1/ingest", { body: batch([ev("a", "s")]) })).json.inserted, 1);
      const done = h.shutdown();
      assert.deepEqual(await done, { drained: true });
      await assert.rejects(fetch(h.url + "/healthz"));
      assert.equal(await h.shutdown().then((r) => r.drained), true, "idempotent");
    });
  });
}

describe("serve backpressure", () => {
  it("answers 429 with Retry-After when the queue is full, and every acked event is stored", async () => {
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const index = new MemoryIndexStore();
    const put = index.putEvents.bind(index);
    index.putEvents = async (b: AgentEvent[]) => {
      await gate;
      return put(b);
    };
    const { h } = await serve("memory", tmpEnv({ CODING_SH_QUEUE_MAX_EVENTS: "10" }), { stores: { index, blobs: new MemoryBlobStore() } });
    // An empty queue admits any one request; it now sits in a blocked tick.
    const first = call(h, "/v1/ingest", { body: batch(Array.from({ length: 8 }, (_, i) => ev(`f${i}`, "flood"))) });
    while (h.queue.depth.events === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await call(h, "/v1/ingest", { body: batch(Array.from({ length: 5 }, (_, i) => ev(`s${i}`, "flood"))) });
    assert.equal(second.status, 429);
    const after = Number(second.headers.get("retry-after"));
    assert.ok(after >= 1 && after <= 30, `Retry-After ${after}`);
    const rz = await call(h, "/readyz");
    assert.equal(rz.status, 200, "8 of 10 is under the 90% readiness bar");
    release();
    gate = Promise.resolve();
    assert.equal((await first).json.inserted, 8);
    const retry = await call(h, "/v1/ingest", { body: batch(Array.from({ length: 5 }, (_, i) => ev(`s${i}`, "flood"))) });
    assert.equal(retry.json.inserted, 5);
    assert.equal((await index.listEvents("flood", { limit: 100 })).length, 13);
    const m = await call(h, "/metrics");
    assert.match(m.text, /coding_sh_ingest_throttled_total\{project="default"\} 1/);
    await h.shutdown();
  });

  it("answers 503 + Retry-After when the store fails, and the retry repairs the session", async () => {
    const index = new MemoryIndexStore();
    const put = index.putEvents.bind(index);
    let fail = 1;
    index.putEvents = async (b: AgentEvent[]) => {
      if (fail-- > 0) throw new Error("connection reset");
      return put(b);
    };
    const { h } = await serve("memory", tmpEnv(), { stores: { index, blobs: new MemoryBlobStore() } });
    const r = await call(h, "/v1/ingest", { body: batch([ev("a", "s")]) });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "2");
    const ok = await call(h, "/v1/ingest", { body: batch([ev("a", "s")]) });
    assert.equal(ok.json.inserted, 1);
    assert.equal((await index.getSession("s"))?.stats.events, 1);
    await h.shutdown();
  });
});

describe("ingest queue", () => {
  const config = resolveServeConfig({}, tmpEnv()).core;
  const native = (ids: string[], session = "s"): AgentEvent[] => ids.map((id) => ({ id, v: 0, sessionId: session, ts: NOW, agent: "sdk", kind: "user.message", payload: { text: id } }));

  it("credits inserted to requests in arrival order within one tick", async () => {
    const store = new MemoryIndexStore();
    const q = new IngestQueue({ store, blobs: new MemoryBlobStore(), config, maxEvents: 100, maxBytes: 1e6 });
    q.setWritable(true);
    const a = q.submit({ kind: "native", project: "default", events: native(["x", "y"]), items: 2, bytes: 10 });
    const b = q.submit({ kind: "native", project: "default", events: native(["y", "z"]), items: 2, bytes: 10 });
    q.start();
    assert.equal((await a).inserted, 2);
    assert.equal((await b).inserted, 1, "y belongs to the first request");
    const c = await q.submit({ kind: "native", project: "default", events: native(["x", "z"]), items: 2, bytes: 10 });
    assert.equal(c.inserted, 0);
    assert.equal(c.stored, 2);
    await q.drain(1000);
  });

  it("repairs sessions a crashed writer left dirty", async () => {
    const store = new MemoryIndexStore();
    await store.putEvents(native(["e1", "e2"], "crashed"));
    await store.kvSet(DIRTY_KEY, JSON.stringify(["crashed"]));
    assert.equal(await store.getSession("crashed"), undefined);
    const q = new IngestQueue({ store, blobs: new MemoryBlobStore(), config, maxEvents: 100, maxBytes: 1e6 });
    assert.equal(await q.repair(), 1);
    assert.equal((await store.getSession("crashed"))?.stats.events, 2);
    assert.equal(await store.kvGet(DIRTY_KEY), undefined);
  });

  it("namespaces project sessions and drops content in metadata mode", async () => {
    const store = new MemoryIndexStore();
    const meta = { ...config, capture: { ...config.capture, mode: "metadata" as const } };
    const q = new IngestQueue({ store, blobs: new MemoryBlobStore(), config: meta, maxEvents: 100, maxBytes: 1e6 });
    q.setWritable(true);
    q.start();
    await q.submit({ kind: "native", project: "demo", events: native(["m1"], "chat"), items: 1, bytes: 10 });
    const [e] = await store.listEvents("demo/chat", { limit: 10 });
    assert.equal(e?.project, "demo");
    assert.equal(e?.payload.text, undefined, "metadata mode keeps no message text");
    await q.drain(1000);
  });
});

describe("single writer (sqlite)", () => {
  it("a second replica waits in standby (503) and takes over when the first stops", async () => {
    const env = tmpEnv();
    const { h: a } = await serve("sqlite", env);
    const { h: b } = await serve("sqlite", env, { lockRetryMs: 50 });
    const rz = await call(b, "/readyz");
    assert.equal(rz.status, 503);
    assert.equal(rz.json.writer, false);
    assert.match(rz.json.reason, /standby/);
    const ing = await call(b, "/v1/ingest", { body: batch([ev("a", "s")]) });
    assert.equal(ing.status, 503);
    assert.equal(ing.headers.get("retry-after"), "5");
    assert.equal((await call(a, "/v1/ingest", { body: batch([ev("a", "s")]) })).json.inserted, 1);
    await a.shutdown();
    const deadline = Date.now() + 5000;
    while ((await call(b, "/readyz")).status !== 200 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await call(b, "/readyz")).json.writer, true);
    assert.equal((await call(b, "/v1/ingest", { body: batch([ev("a", "s"), ev("b", "s")]) })).json.inserted, 1);
    await b.shutdown();
  });

  it("a writer whose lease another replica took over stops writing, goes standby, and takes over again later", async () => {
    const env = tmpEnv();
    const { h } = await serve("sqlite", env, { lockRetryMs: 50 });
    assert.equal((await call(h, "/v1/ingest", { body: batch([ev("a", "s")]) })).json.inserted, 1);
    const lockName = readdirSync(env.CODING_SH_HOME!).find((f) => f.endsWith(".writer.lock"));
    assert.ok(lockName, "writer lock file");
    const lockPath = join(env.CODING_SH_HOME!, lockName);
    // We stalled past staleMs (a long synchronous store call); another live replica broke our lease and holds it now.
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, host: hostname(), ts: Date.now(), nonce: "peer" }));
    const lost = await call(h, "/v1/ingest", { body: batch([ev("b", "s")]) });
    assert.equal(lost.status, 503, lost.text);
    assert.match(lost.text, /standby/);
    const rz = await call(h, "/readyz");
    assert.equal(rz.status, 503);
    assert.equal(rz.json.writer, false);
    // The other replica goes away: we become the writer again, and "b" was never written meanwhile.
    rmSync(lockPath);
    const deadline = Date.now() + 5000;
    while ((await call(h, "/readyz")).status !== 200 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await call(h, "/readyz")).json.writer, true);
    assert.equal((await call(h, "/v1/ingest", { body: batch([ev("a", "s"), ev("b", "s")]) })).json.inserted, 1);
    await h.shutdown();
  });

  it("applies retention per project and never deletes newer sessions", async () => {
    const { applyRetention } = await import("../../src/server/retention.ts");
    const store: IndexStore = new MemoryIndexStore();
    const day = 86_400_000;
    await store.putEvents([
      { id: "old", v: 0, sessionId: "demo/old", project: "demo", ts: NOW - 10 * day, agent: "sdk", kind: "user.message", payload: {} },
      { id: "new", v: 0, sessionId: "demo/new", project: "demo", ts: NOW - day, agent: "sdk", kind: "user.message", payload: {} },
      { id: "keep", v: 0, sessionId: "old-default", ts: NOW - 10 * day, agent: "sdk", kind: "user.message", payload: {} },
    ]);
    const { rebuildSessions } = await import("../../src/otel/receiver.ts");
    await rebuildSessions(store, ["demo/old", "demo/new", "old-default"]);
    const r = await applyRetention({ store, days: new Map([["demo", 7], ["default", 0]]), now: () => NOW });
    assert.equal(r.demo?.sessions, 1);
    assert.equal(await store.getSession("demo/old"), undefined);
    assert.ok(await store.getSession("demo/new"));
    assert.ok(await store.getSession("old-default"));
  });
});

describe("serve readiness", () => {
  it("reports a postgresql:// store as postgres in /readyz", async () => {
    // A postgresql:// URL as hosting platforms hand it out; the stores are injected, so nothing dials it.
    const { h } = await serve("memory", tmpEnv({ CODING_SH_STORE_URL: "postgresql://csh@db.invalid:5432/coding" }), {
      stores: { index: new MemoryIndexStore(), blobs: new MemoryBlobStore() },
    });
    const rz = await call(h, "/readyz");
    assert.equal(rz.status, 200);
    assert.equal(rz.json.store, "postgres");
    await h.shutdown();
  });
});

// Regressions from the API reference audit (docs/reference/api.md).
describe("serve API audit", () => {
  const configFile = (env: NodeJS.ProcessEnv, lines: string[]) => {
    const file = join(env.HOME!, "serve.toml");
    writeFileSync(file, lines.join("\n"));
    return file;
  };

  it("/metrics refuses a project-scoped read key: its labels name every project", async () => {
    const ikDemo = generateKey("ingest");
    const ikAlpha = generateKey("ingest");
    const rkDemo = generateKey("read");
    const rkAll = generateKey("read");
    const { h } = await serve("memory", tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ikDemo},alpha:${ikAlpha}`, CODING_SH_READ_KEYS: `demo:${rkDemo},*:${rkAll}` }));
    assert.equal((await call(h, "/v1/ingest", { key: ikAlpha, body: batch([ev("a", "chat-1")]) })).status, 200);
    const scoped = await call(h, "/metrics", { key: rkDemo });
    assert.equal(scoped.status, 403);
    assert.ok(!scoped.text.includes("alpha"), "no foreign project names leak");
    const all = await call(h, "/metrics", { key: rkAll });
    assert.equal(all.status, 200);
    assert.match(all.text, /project="alpha"/);
    await h.shutdown();
  });

  it("records each read key's own id as the label author, never the secret", async () => {
    const ik = generateKey("ingest");
    const rkA = generateKey("read");
    const rkB = generateKey("read");
    const rkNamed = generateKey("read");
    const env = tmpEnv({ CODING_SH_INGEST_KEYS: ik, CODING_SH_READ_KEYS: `*:${rkA},*:${rkB}` });
    const config = configFile(env, ["[serve.viewer]", `read_keys = [{ project = "*", key = "sha256:${sha256(rkNamed)}", name = "alice" }]`]);
    const { h } = await serve("memory", env, { flags: { config } });
    assert.equal((await call(h, "/v1/ingest", { key: ik, body: batch([ev("a", "chat-1")]) })).status, 200);
    const label = (key: string, value: string) => call(h, "/api/labels", { key, body: { sessionId: "chat-1", criterion: "outcome", value } });
    const a = await label(rkA, "pass");
    const b = await label(rkB, "fail");
    const n = await label(rkNamed, "skip");
    assert.deepEqual([a.status, b.status, n.status], [201, 201, 201]);
    assert.equal(a.json.by, `reader:${sha256(rkA).slice(0, 12)}`);
    assert.equal(b.json.by, `reader:${sha256(rkB).slice(0, 12)}`);
    assert.equal(n.json.by, "alice");
    const items = (await call(h, "/api/labels?sessionId=chat-1", { key: rkA })).json.items as { by: string; value: string }[];
    assert.equal(items.length, 3, "two people labelling the same criterion keep separate labels");
    const text = JSON.stringify(items);
    for (const k of [rkA, rkB, rkNamed]) assert.ok(!text.includes(k) && !text.includes(sha256(k)), "no key or full key hash in labels");
    await h.shutdown();
  });

  for (const kind of ["memory", "sqlite"] as const) {
    it(`lists projects found in the store on a --role viewer replica (${kind})`, async () => {
      // A writer ingests for alpha and beta; the replica knows none of their keys, only a "*" read key.
      const ikAlpha = generateKey("ingest");
      const ikBeta = generateKey("ingest");
      const rkAll = generateKey("read");
      const env = tmpEnv();
      const stores = () => (kind === "memory" ? { stores: { index: mem, blobs: new MemoryBlobStore() } } : {});
      const mem = new MemoryIndexStore();
      const w = await serve(kind, { ...env, CODING_SH_INGEST_KEYS: `alpha:${ikAlpha},beta:${ikBeta}` }, stores());
      assert.equal((await call(w.h, "/v1/ingest", { key: ikAlpha, body: batch([ev("a", "chat-1")]) })).status, 200);
      assert.equal((await call(w.h, "/v1/ingest", { key: ikBeta, body: batch([ev("b", "x")]) })).status, 200);
      await w.h.shutdown();
      const { h } = await serve(kind, { ...env, CODING_SH_READ_KEYS: `*:${rkAll}` }, { flags: { role: "viewer" }, ...stores() });
      const p = await call(h, "/api/projects", { key: rkAll });
      assert.equal(p.status, 200);
      assert.deepEqual(p.json.items, ["alpha", "beta", "default"]);
      await h.shutdown();
    });
  }

  it("applies serve.cors_origins to /v1/ingest, with an OPTIONS preflight", async () => {
    const ik = generateKey("ingest");
    const env = tmpEnv({ CODING_SH_INGEST_KEYS: ik });
    const config = configFile(env, ["[serve]", 'cors_origins = ["https://app.example"]']);
    const { h } = await serve("memory", env, { flags: { config } });
    const pre = await call(h, "/v1/ingest", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://app.example");
    assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Authorization/i);
    const ok = await call(h, "/v1/ingest", { key: ik, body: batch([ev("a", "chat-1")]), headers: { origin: "https://app.example" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example");
    const unauth = await call(h, "/v1/ingest", { body: batch([ev("a", "chat-1")]), headers: { origin: "https://app.example" } });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get("access-control-allow-origin"), "https://app.example", "errors stay readable to the page");
    const evil = await call(h, "/v1/ingest", { key: ik, body: batch([ev("b", "chat-1")]), headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    assert.equal((await call(h, "/v1/ingest", { method: "OPTIONS", headers: { origin: "https://evil.example" } })).status, 403);
    // Server-side SDKs send no Origin and are unaffected.
    assert.equal((await call(h, "/v1/ingest", { key: ik, body: batch([ev("c", "chat-1")]) })).status, 200);
    const get = await call(h, "/v1/ingest", { key: ik });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST, OPTIONS");
    await h.shutdown();
  });

  it("answers 405 with Allow on /healthz, /readyz and /metrics for methods other than GET and HEAD", async () => {
    const { h } = await serve("memory", tmpEnv());
    for (const path of ["/healthz", "/readyz", "/metrics"]) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const r = await call(h, path, { method });
        assert.equal(r.status, 405, `${method} ${path}`);
        assert.equal(r.headers.get("allow"), "GET, HEAD");
      }
      assert.equal((await call(h, path, { method: "HEAD" })).status, 200, `HEAD ${path}`);
      assert.equal((await call(h, path)).status, 200, `GET ${path}`);
    }
    await h.shutdown();
  });

  it("needs a percent-encoded / in a session id path, and the 404 says so", async () => {
    const ik = generateKey("ingest");
    const rk = generateKey("read");
    const { h } = await serve("memory", tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ik}`, CODING_SH_READ_KEYS: `*:${rk}` }));
    assert.equal((await call(h, "/v1/ingest", { key: ik, body: batch([ev("a", "chat-1")]) })).status, 200);
    const raw = await call(h, "/api/sessions/demo/chat-1", { key: rk });
    assert.equal(raw.status, 404);
    assert.match(raw.json.error, /percent-encode/);
    assert.match(raw.json.error, /%2F/);
    assert.equal((await call(h, "/api/sessions/demo%2Fchat-1", { key: rk })).status, 200);
    assert.equal((await call(h, "/api/sessions/demo%2Fchat-1/events", { key: rk })).status, 200);
    await h.shutdown();
  });
});
