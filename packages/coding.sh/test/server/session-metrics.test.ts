// The session counters on serve's /metrics (cost by agent and model, sessions by
// outcome, failure flags) and the alert check serve runs every minute.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { saveAlerts } from "../../src/alerts/store.ts";
import { paths } from "../../src/core/paths.ts";
import type { Session } from "../../src/schema/index.ts";
import { generateKey } from "../../src/server/auth.ts";
import { resolveServeConfig } from "../../src/server/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { ServeMetrics } from "../../src/server/metrics.ts";
import { startServe, type ServeHandle, type ServeOptions } from "../../src/server/serve.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";

const dirs: string[] = [];
const handles: ServeHandle[] = [];
const servers: Server[] = [];
after(async () => {
  for (const h of handles) await h.shutdown().catch(() => {});
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "csh-serve-metrics-"));
  dirs.push(root);
  mkdirSync(join(root, "home"));
  return { HOME: join(root, "home"), USERPROFILE: join(root, "home"), CODING_SH_HOME: join(root, "data"), CODING_SH_LOG: "json", CODING_SH_STORE_URL: "memory://", ...extra };
}

const logs: string[] = [];
async function serve(env: NodeJS.ProcessEnv, opts: ServeOptions = {}): Promise<ServeHandle> {
  const cfg = resolveServeConfig({ port: 0 }, env);
  const h = await startServe(cfg, { log: createLogger({ format: "json", write: (l) => logs.push(l) }), enrichSpan: false, stores: { index: new MemoryIndexStore(), blobs: new MemoryBlobStore() }, ...opts });
  handles.push(h);
  return h;
}

const NOW = Date.now();
const llm = (id: string, sessionId: string) => ({ v: 0, id, sessionId, ts: NOW - 2000, kind: "llm.call", model: "gpt-4o", usage: { inputTokens: 1000, outputTokens: 10 }, payload: {} });
const end = (id: string, sessionId: string) => ({ v: 0, id, sessionId, ts: NOW - 1000, kind: "session.end", payload: { reason: "completed" } });
const ingest = (h: ServeHandle, key: string, events: unknown[]) =>
  fetch(`${h.url}/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ v: 0, service: "my-api", events }) }).then(async (r) => ({ status: r.status, json: (await r.json()) as { inserted: number } }));
const metricsText = (h: ServeHandle, key: string) => fetch(`${h.url}/metrics`, { headers: { authorization: `Bearer ${key}` } }).then((r) => r.text());

describe("serve session metrics", () => {
  it("counts a priced session's cost and outcome once, when it ends", async () => {
    const ik = generateKey("ingest");
    const rk = generateKey("read");
    const h = await serve(tmpEnv({ CODING_SH_INGEST_KEYS: ik, CODING_SH_READ_KEYS: `*:${rk}` }));

    // Not ended yet: nothing counted.
    assert.equal((await ingest(h, ik, [llm("a", "chat-1")])).status, 200);
    assert.doesNotMatch(await metricsText(h, rk), /coding_sh_session_cost_usd_total/);

    assert.equal((await ingest(h, ik, [llm("b", "chat-1"), end("c", "chat-1")])).json.inserted, 2);
    const cost = (2 * (1000 * 2.5 + 10 * 10)) / 1e6;
    const text = await metricsText(h, rk);
    const line = /^coding_sh_session_cost_usd_total\{agent="([^"]+)",model="gpt-4o"\} (\S+)$/m.exec(text);
    assert.ok(line, text);
    assert.ok(Math.abs(Number(line[2]) - cost) < 1e-12, line[0]);
    assert.match(text, /^coding_sh_sessions_total\{agent="[^"]+",outcome="ok"\} 1$/m);
    assert.match(text, /# TYPE coding_sh_session_cost_usd_total counter/);

    // More events for the ended session: it is not counted again.
    await ingest(h, ik, [llm("d", "chat-1")]);
    const again = await metricsText(h, rk);
    assert.match(again, /^coding_sh_sessions_total\{agent="[^"]+",outcome="ok"\} 1$/m);
    assert.equal(/^coding_sh_session_cost_usd_total\{[^}]*\} (\S+)$/m.exec(again)![1], line[2]);
  });
});

describe("ServeMetrics.observeSessions", () => {
  const s = (id: string, over: Partial<Session> = {}): Session => ({ id, agent: "codex", startedAt: 1, endedAt: 2, flags: [], stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 } }, ...over }) as Session;

  it("labels failed sessions and their failure flags, skips tags, and counts subagent cost only", () => {
    const m = new ServeMetrics();
    try {
      m.observeSessions([
        s("a", { model: "gpt-5", flags: ["repeated-tool-failure", "gateway:vercel"] }),
        s("a", { model: "gpt-5", flags: ["repeated-tool-failure"] }),
        s("b", { flags: ["model:switch"] }),
        s("child", { parent: { sessionId: "a" }, flags: ["tests-failed"] }),
      ]);
      const text = m.render();
      assert.match(text, /^coding_sh_sessions_total\{agent="codex",outcome="failed"\} 1$/m);
      assert.match(text, /^coding_sh_sessions_total\{agent="codex",outcome="ok"\} 1$/m);
      assert.match(text, /^coding_sh_session_flags_total\{flag="repeated-tool-failure"\} 1$/m);
      assert.doesNotMatch(text, /flag="gateway:vercel"|flag="model:switch"|flag="tests-failed"/);
      assert.match(text, /^coding_sh_session_cost_usd_total\{agent="codex",model="gpt-5"\} 0\.5$/m);
      assert.match(text, /^coding_sh_session_cost_usd_total\{agent="codex",model="unknown"\} 1$/m);
    } finally {
      m.close();
    }
  });

  it("leaves the counters out of /metrics until a session is counted, and caps label sets", () => {
    const m = new ServeMetrics();
    try {
      assert.doesNotMatch(m.render(), /coding_sh_session/);
      m.observeSessions(Array.from({ length: 600 }, (_, i) => s(`s${i}`, { model: `m${i}` })));
      assert.equal(m.sessionCost.values.size, 501);
      assert.ok(m.sessionCost.get({ agent: "other", model: "other" }) > 0);
    } finally {
      m.close();
    }
  });
});

describe("serve alert check", () => {
  it("runs the alert check on its interval and notifies a change of state", async () => {
    const posts: string[] = [];
    const listener = createServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        posts.push(body);
        res.writeHead(204).end();
      });
    });
    servers.push(listener);
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/`;

    const ik = generateKey("ingest");
    const env = tmpEnv({ CODING_SH_INGEST_KEYS: ik, CODING_SH_READ_KEYS: `*:${generateKey("read")}` });
    const file = paths(env).alerts;
    await saveAlerts(file, { v: 1, alerts: [{ name: "busy", measure: "sessions", over: 0, window: "1h", notify: { kind: "webhook", url }, createdAt: NOW, states: {}, delivery: { failures: 0 } }] });
    const h = await serve(env, { alertIntervalMs: 50 });
    await ingest(h, ik, [llm("a", "chat-1"), end("b", "chat-1")]);
    const deadline = Date.now() + 10_000;
    while (!posts.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.equal(posts.length, 1, logs.slice(-5).join("\n"));
    const body = JSON.parse(posts[0]!);
    assert.equal(body.alert, "busy");
    assert.equal(body.state, "ALERT");
    assert.equal(body.value, 1);
    await h.shutdown();
  });
});
