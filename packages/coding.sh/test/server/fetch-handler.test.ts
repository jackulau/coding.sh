// createFetchHandler (coding.sh/server): serve's ingest routes as a WHATWG
// Request → Response function. These are serve's route tests (serve.test.ts:
// health, readiness, auth, project scoping, native + OTLP ingest, validation,
// limits, CORS, methods) run through Request objects instead of a socket, plus
// what only the handler does (base path, waitUntil, the SQLite store, the forward).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, describe, it } from "node:test";
import { generateKey } from "../../src/server/auth.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { createFetchHandler, type FetchHandler, type FetchHandlerOptions } from "../../src/server/index.ts";
import { createLogger } from "../../src/server/log.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import type { IndexStore } from "../../src/core/types.ts";
import { otlpSpan, otlpTraces, sAttr } from "../otel/_encode.ts";

type J = any;

const dirs: string[] = [];
const handlers: FetchHandler[] = [];
const servers: Server[] = [];
after(async () => {
  for (const h of handlers) await h.close().catch(() => {});
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "csh-fetch-"));
  dirs.push(root);
  mkdirSync(join(root, "home"));
  return { HOME: join(root, "home"), CODING_SH_HOME: join(root, "data"), CODING_SH_LOG: "json", ...extra };
}

const logs: string[] = [];
const quiet = () => createLogger({ format: "json", write: (l) => logs.push(l) });

type StoreKind = "memory" | "sqlite";

function make(kind: StoreKind, env: NodeJS.ProcessEnv, o: Partial<FetchHandlerOptions> = {}): { h: FetchHandler; index: () => Promise<IndexStore> } {
  const mem = new MemoryIndexStore();
  const e = kind === "memory" ? { CODING_SH_STORE_URL: "memory://", ...env } : env;
  const h = createFetchHandler({
    config: resolveServeConfig({}, e),
    log: quiet(),
    enrichSpan: false,
    ...(kind === "memory" ? { stores: { index: mem, blobs: new MemoryBlobStore() } } : {}),
    ...o,
  });
  handlers.push(h);
  return { h, index: async () => mem };
}

interface Res {
  status: number;
  headers: Headers;
  json: J;
  text: string;
}
const ORIGIN = "https://ingest.example.com";
async function call(h: FetchHandler, path: string, init: { method?: string; key?: string; body?: unknown; headers?: Record<string, string>; raw?: string | Uint8Array } = {}, ...rest: unknown[]): Promise<Res> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  let body: string | Uint8Array | undefined = init.raw;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] ??= "application/json";
  }
  const res = await h(new Request(ORIGIN + path, { method: init.method ?? (body !== undefined ? "POST" : "GET"), headers, body: body as BodyInit | undefined }), ...rest);
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

/** Reads what the handler stored, through a second connection for SQLite. */
async function stored(kind: StoreKind, env: NodeJS.ProcessEnv, mem: () => Promise<IndexStore>): Promise<{ sessions: Session[]; events: (id: string) => Promise<AgentEvent[]>; close: () => Promise<void> }> {
  if (kind === "memory") {
    const ix = await mem();
    return { sessions: await ix.listSessions({ limit: 100 }), events: (id) => ix.listEvents(id), close: async () => {} };
  }
  const { openIndexStore } = await import("../../src/store/factory.ts");
  const cfg = resolveServeConfig({}, env);
  const ix = await openIndexStore(cfg.core.store.index, cfg.core);
  return { sessions: await ix.listSessions({ limit: 100 }), events: (id) => ix.listEvents(id), close: () => ix.close() };
}

for (const kind of ["memory", "sqlite"] as const) {
  describe(`fetch handler (${kind})`, () => {
    it("answers health and readiness without auth and with no secrets", async () => {
      const ik = generateKey("ingest");
      const { h } = make(kind, tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ik}` }));
      const hz = await call(h, "/healthz");
      assert.equal(hz.status, 200);
      assert.deepEqual(hz.json, { ok: true });
      const rz = await call(h, "/readyz");
      assert.equal(rz.status, 200, rz.text);
      assert.equal(rz.json.ok, true);
      assert.equal(rz.json.store, kind);
      assert.equal(rz.json.writer, true);
      assert.deepEqual(rz.json.queue, { events: 0, max: 50_000 });
      assert.ok(!rz.text.includes(ik));
      assert.equal((await call(h, "/readyz", { method: "HEAD" })).status, 200);
    });

    it("is not ready, and refuses ingest, without ingest keys (every request is remote)", async () => {
      const { h } = make(kind, tmpEnv());
      const rz = await call(h, "/readyz");
      assert.equal(rz.status, 503);
      assert.match(rz.json.reason, /CODING_SH_INGEST_KEYS/);
      assert.equal((await call(h, "/v1/ingest", { body: batch([ev("a", "s")]) })).status, 401);
      const open = make(kind, tmpEnv({ CODING_SH_INSECURE: "1" })).h;
      assert.equal((await call(open, "/readyz")).status, 200);
      assert.equal((await call(open, "/v1/ingest", { body: batch([ev("a", "s")]) })).json.inserted, 1);
    });

    it("enforces ingest keys and scopes events by project", async () => {
      const ikDemo = generateKey("ingest");
      const ikDefault = generateKey("ingest");
      const env = tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ikDemo},${ikDefault}`, CODING_SH_READ_KEYS: generateKey("read") });
      const { h, index } = make(kind, env);
      const none = await call(h, "/v1/ingest", { body: batch([ev("a", "chat-1")]) });
      assert.equal(none.status, 401);
      assert.equal(none.headers.get("www-authenticate"), "Bearer");
      assert.equal((await call(h, "/v1/ingest", { key: "csh_ik_nope", body: batch([ev("a", "chat-1")]) })).status, 401);
      const otlpNone = await call(h, "/v1/traces", { body: otlpTraces("svc", []) });
      assert.equal(otlpNone.status, 401);
      assert.equal(otlpNone.json?.code, 16);

      const d = await call(h, "/v1/ingest", { key: ikDemo, body: batch([ev("a", "chat-1"), ev("b", "chat-1")]) });
      assert.equal(d.status, 200);
      assert.deepEqual(d.json, { accepted: 2, inserted: 2, rejected: [] });
      const again = await call(h, "/v1/ingest", { key: ikDemo, body: batch([ev("a", "chat-1"), ev("b", "chat-1")]) });
      assert.deepEqual(again.json, { accepted: 2, inserted: 0, rejected: [] }, "retries are idempotent");
      const def = await call(h, "/v1/ingest", { key: ikDefault, body: batch([ev("a", "chat-1")]) });
      assert.equal(def.json.inserted, 1, "same client id in another project is a different event");
      await h.close();

      const s = await stored(kind, env, index);
      try {
        assert.deepEqual(s.sessions.map((x) => x.id).sort(), ["chat-1", "demo/chat-1"]);
        const demo = s.sessions.find((x) => x.id === "demo/chat-1")!;
        assert.equal(demo.project, "demo");
        assert.equal(demo.stats.usage?.inputTokens, 2000);
        // cost estimated from the built-in table, as serve does
        const plain = s.sessions.find((x) => x.id === "chat-1")!;
        assert.ok(Math.abs(plain.stats.usage!.costUsd! - (1000 * 2.5 + 10 * 10) / 1e6) < 1e-12, JSON.stringify(plain.stats.usage));
        assert.ok((await s.events("demo/chat-1")).every((e) => e.project === "demo"));
      } finally {
        await s.close();
      }
    });

    it("validates native batches and rejects oversized or wrongly typed bodies", async () => {
      const { h } = make(kind, tmpEnv({ CODING_SH_INSECURE: "1" }));
      const mixed = await call(h, "/v1/ingest", { body: batch([ev("ok", "s"), { ...ev("bad", "s"), kind: "nope" }]) });
      assert.equal(mixed.status, 200);
      assert.equal(mixed.json.accepted, 1);
      assert.equal(mixed.json.rejected[0].index, 1);
      assert.equal((await call(h, "/v1/ingest", { raw: "{}", headers: { "content-type": "text/plain" } })).status, 415);
      assert.equal((await call(h, "/v1/ingest", { raw: "{nope", headers: { "content-type": "application/json" } })).status, 400);
      const get = await call(h, "/v1/ingest", { method: "GET" });
      assert.equal(get.status, 405);
      assert.equal(get.headers.get("allow"), "POST, OPTIONS");
      const big = new Uint8Array(16 * 1024 * 1024 + 1).fill(32);
      assert.equal((await call(h, "/v1/ingest", { raw: big, headers: { "content-type": "application/json" } })).status, 413);
      assert.equal((await call(h, "/v1/traces", { raw: big, headers: { "content-type": "application/json" } })).status, 413);
      // gzip bodies, as exporters send them
      const gz = await call(h, "/v1/ingest", { raw: gzipSync(JSON.stringify(batch([ev("gz", "s")]))), headers: { "content-type": "application/json", "content-encoding": "gzip" } });
      assert.equal(gz.json.inserted, 1, gz.text);
      assert.equal((await call(h, "/v1/nope", { body: {} })).status, 404);
    });

    it("ingests OTLP traces into the key's project", async () => {
      const ik = generateKey("ingest");
      const env = tmpEnv({ CODING_SH_INGEST_KEYS: `demo:${ik}` });
      const { h, index } = make(kind, env);
      const span = otlpSpan("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", undefined, "chat gpt-4o", [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.request.model", "gpt-4o"), sAttr("gen_ai.conversation.id", "conv-9")], 0, 1200);
      const r = await call(h, "/v1/traces", { key: ik, body: otlpTraces("support-bot", [span]) });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json, {});
      await h.close();
      const s = await stored(kind, env, index);
      try {
        assert.equal(s.sessions.length, 1);
        assert.match(s.sessions[0]!.id, /^demo\//);
      } finally {
        await s.close();
      }
    });

    it("applies serve.cors_origins to /v1/ingest, with an OPTIONS preflight", async () => {
      const env = tmpEnv({ CODING_SH_INSECURE: "1" });
      mkdirSync(env.CODING_SH_HOME!, { recursive: true });
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(env.CODING_SH_HOME!, "config.toml"), `[serve]\ncors_origins = ["https://app.example.com"]\n`);
      const { h } = make(kind, env);
      const pre = await call(h, "/v1/ingest", { method: "OPTIONS", headers: { origin: "https://app.example.com" } });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get("access-control-allow-origin"), "https://app.example.com");
      assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Authorization/);
      const ok = await call(h, "/v1/ingest", { body: batch([ev("a", "s")]), headers: { origin: "https://app.example.com" } });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example.com");
      assert.equal((await call(h, "/v1/ingest", { body: batch([ev("b", "s")]), headers: { origin: "https://evil.example.com" } })).status, 403);
    });

    it("answers 405 with Allow on /healthz and /readyz for methods other than GET and HEAD", async () => {
      const { h } = make(kind, tmpEnv({ CODING_SH_INSECURE: "1" }));
      for (const p of ["/healthz", "/readyz"]) {
        const r = await call(h, p, { method: "POST", body: {} });
        assert.equal(r.status, 405);
        assert.equal(r.headers.get("allow"), "GET, HEAD");
      }
    });
  });
}

describe("fetch handler: platform glue", () => {
  it("strips basePath, and answers 503 after close", async () => {
    const { h } = make("memory", tmpEnv({ CODING_SH_INSECURE: "1" }), { basePath: "/api/coding-sh/" });
    assert.equal((await call(h, "/api/coding-sh/healthz")).status, 200);
    assert.equal((await call(h, "/api/coding-sh/v1/ingest", { body: batch([ev("a", "s")]) })).json.inserted, 1);
    await h.close();
    assert.equal((await call(h, "/api/coding-sh/v1/ingest", { body: batch([ev("b", "s")]) })).status, 503);
  });

  it("answers 503 with Retry-After when the store cannot open, and retries the open on the next request", async () => {
    const env = tmpEnv({ CODING_SH_INSECURE: "1", CODING_SH_STORE_URL: "nosuchscheme://x" });
    const h = createFetchHandler({ config: resolveServeConfig({}, env), log: quiet() });
    handlers.push(h);
    const r = await call(h, "/v1/ingest", { body: batch([ev("a", "s")]) });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "2");
    assert.equal((await call(h, "/readyz")).status, 503);
  });

  it("forwards committed traces through the Workers ctx.waitUntil, with the same ids plus coding_sh.project", async () => {
    const bodies: J[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end("{}");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const ik = generateKey("ingest");
    const { h } = make("memory", tmpEnv({ CODING_SH_INGEST_KEYS: `billing:${ik}`, CODING_SH_FORWARD_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }), {
      hookTiming: { flushMs: 60_000 },
    });
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    const span = otlpSpan("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", undefined, "chat gpt-4o", [sAttr("gen_ai.operation.name", "chat"), sAttr("gen_ai.conversation.id", "c1")], 0, 10);
    const r = await call(h, "/v1/traces", { key: ik, body: otlpTraces("svc", [span]) }, {}, ctx);
    assert.equal(r.status, 200);
    assert.equal(waits.length, 1, "the flush was handed to waitUntil");
    await Promise.all(waits);
    const sp = bodies[0].resourceSpans[0];
    assert.equal(sp.scopeSpans[0].spans[0].spanId, "b7ad6b7169203331");
    assert.equal(sp.scopeSpans[0].spans[0].traceId, "0af7651916cd43dd8448eb211c80319c");
    assert.ok(sp.resource.attributes.some((kv: J) => kv.key === "coding_sh.project" && kv.value.stringValue === "billing"));
  });

  it("rebuilds sessions through the store's rebuildSession (the per-session lock) when it has one", async () => {
    const mem = new MemoryIndexStore();
    const calls: string[] = [];
    // A store with the lock: serialize per id, as Postgres' pg_advisory_xact_lock does.
    const locks = new Map<string, Promise<unknown>>();
    const locked = Object.assign(Object.create(mem) as IndexStore, {
      rebuildSession(id: string, build: (prev: Session | undefined, events: AgentEvent[]) => Session | undefined) {
        calls.push(id);
        const run = (locks.get(id) ?? Promise.resolve()).then(async () => {
          const next = build(await mem.getSession(id), await mem.listEvents(id));
          if (next) await mem.upsertSession(next);
          return next;
        });
        locks.set(id, run.catch(() => {}));
        return run;
      },
    });
    const env = tmpEnv({ CODING_SH_INSECURE: "1", CODING_SH_STORE_URL: "memory://" });
    const a = createFetchHandler({ config: resolveServeConfig({}, env), log: quiet(), enrichSpan: false, stores: { index: locked, blobs: new MemoryBlobStore() } });
    const b = createFetchHandler({ config: resolveServeConfig({}, env), log: quiet(), enrichSpan: false, stores: { index: locked, blobs: new MemoryBlobStore() } });
    handlers.push(a, b);
    const posts: Promise<Res>[] = [];
    for (let i = 0; i < 20; i++) posts.push(call(i % 2 ? a : b, "/v1/ingest", { body: batch([ev(`e${i}`, "shared", { ts: NOW - 1000 + i })]) }));
    for (const r of await Promise.all(posts)) assert.equal(r.status, 200, r.text);
    assert.ok(calls.length >= 2 && calls.every((id) => id === "shared"));
    assert.equal((await mem.listEvents("shared")).length, 20);
    assert.equal((await mem.getSession("shared"))!.stats.usage?.inputTokens, 20_000);
  });
});
