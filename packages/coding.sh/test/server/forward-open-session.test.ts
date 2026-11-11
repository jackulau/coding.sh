// serve's OTLP forward sends the invoke_agent span of a session that is still open: native
// ingest sessions keyed by a conversation id never get a session.end, and the chat spans
// already sent name that span as their parent. Same timing as the sink mirror (src/server/mirror.ts).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { resolveServeConfig } from "../../src/server/config.ts";
import { createLogger } from "../../src/server/log.ts";
import { startServe, type ServeHandle } from "../../src/server/serve.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";

type J = any;
const servers: Server[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.shutdown().catch(() => {});
  for (const s of servers) s.close();
});

async function collector(): Promise<{ url: string; spans: () => J[] }> {
  const bodies: J[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200);
      res.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, spans: () => bodies.flatMap((b) => b.resourceSpans.flatMap((rs: J) => rs.scopeSpans.flatMap((ss: J) => ss.spans))) };
}

async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  return cond();
}

async function serveWith(url: string, timing: { quietMs: number; refreshMs?: number }): Promise<ServeHandle> {
  const cfg = resolveServeConfig({ port: 0 }, { HOME: "/nonexistent-home", CODING_SH_HOME: "/nonexistent-data", CODING_SH_STORE_URL: "memory://", CODING_SH_FORWARD_URL: url, CODING_SH_LOG: "json" });
  const h = await startServe(cfg, {
    log: createLogger({ format: "json", write: () => {} }),
    enrichSpan: false,
    stores: { index: new MemoryIndexStore(), blobs: new MemoryBlobStore() },
    hookTiming: { flushMs: 10, minBackoffMs: 20, maxBackoffMs: 100, refreshMs: 60_000, ...timing },
  });
  handles.push(h);
  return h;
}

const ingest = (h: ServeHandle, sessionId: string) =>
  fetch(`${h.url}/v1/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      v: 0,
      service: "my-api",
      events: [{ v: 0, id: `${sessionId}-m`, sessionId, ts: Date.now() - 1000, kind: "llm.call", model: "gpt-4o", usage: { inputTokens: 100, outputTokens: 5 }, payload: { text: "hi" } }],
    }),
  });

describe("serve forward: open sessions", () => {
  it("sends one invoke_agent span, the parent the chat span names, once the session is quiet", async () => {
    const c = await collector();
    const h = await serveWith(c.url, { quietMs: 60 });
    assert.equal((await ingest(h, "chat-1")).status, 200);
    assert.ok(await until(() => c.spans().some((s) => s.name.startsWith("chat"))), "the chat span was forwarded");
    assert.ok(await until(() => c.spans().some((s) => s.name.startsWith("invoke_agent"))), "the open session's invoke_agent span was forwarded");
    await new Promise((r) => setTimeout(r, 250));
    const roots = c.spans().filter((s) => s.name.startsWith("invoke_agent"));
    assert.equal(roots.length, 1, "one, not one per flush");
    const chat = c.spans().find((s) => s.name.startsWith("chat"))!;
    assert.equal(roots[0].spanId, chat.parentSpanId);
    assert.equal(roots[0].traceId, chat.traceId);
  });

  it("sends the open session at shutdown, since nothing runs after it", async () => {
    const c = await collector();
    const h = await serveWith(c.url, { quietMs: 60_000 });
    assert.equal((await ingest(h, "chat-2")).status, 200);
    assert.ok(await until(() => c.spans().some((s) => s.name.startsWith("chat"))));
    assert.equal(c.spans().filter((s) => s.name.startsWith("invoke_agent")).length, 0, "not before it is quiet");
    await h.shutdown();
    assert.equal(c.spans().filter((s) => s.name.startsWith("invoke_agent")).length, 1);
  });
});
