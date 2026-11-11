// Golden harness: the same conversation through the Python SDK and through OTel must give
// equal Session.stats (docs/PRODUCTION.md section 4).
//
// Runs the core package's real OTLP receiver (src/otel/receiver.ts) on a memory store, plus a
// minimal stand-in for serve's native ingest: price and put the events, rebuild each touched session with
// the same buildSession() serve uses. Prints {"otlp": url, "ingest": url} on the first stdout line.
//   GET /session?id=<id>  -> the stored Session JSON (404 when missing)
//   POST /v1/ingest       -> {v, service, events}, gzip allowed
// Stops on stdin EOF.
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { applyPricing, pricesFor } from "../../../coding.sh/src/core/pricing.ts";
import { buildSession } from "../../../coding.sh/src/core/sessions.ts";
import type { AgentEvent } from "../../../coding.sh/src/schema/index.ts";
import { startReceiver } from "../../../coding.sh/src/otel/receiver.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../../coding.sh/src/store/memory.ts";

const store = new MemoryIndexStore();
const blobs = new MemoryBlobStore();
const receiver = await startReceiver({ host: "127.0.0.1", port: 0, store, blobs });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && url.pathname === "/session") {
      const s = await store.getSession(url.searchParams.get("id") ?? "");
      return s ? send(200, s) : send(404, { error: "not found" });
    }
    if (req.method === "POST" && url.pathname === "/v1/ingest") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
      const env = JSON.parse(body.toString("utf8"));
      // Priced with the built-in table, as serve's queue (src/server/queue.ts) and the OTLP receiver do.
      const raw = (env.events as Record<string, unknown>[]).map((e) => ({ agent: env.service ?? "sdk", source: "sdk", ...e })) as AgentEvent[];
      const events = applyPricing(raw, pricesFor());
      const { inserted } = await store.putEvents(events);
      for (const id of new Set(events.map((e) => e.sessionId))) {
        await store.upsertSession(buildSession(await store.listEvents(id), await store.getSession(id)));
      }
      return send(200, { accepted: events.length, inserted, rejected: [] });
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(500, { error: String(e) });
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const addr = server.address() as { port: number };
process.stdout.write(JSON.stringify({ otlp: receiver.url, ingest: `http://127.0.0.1:${addr.port}` }) + "\n");

process.stdin.resume();
process.stdin.on("end", async () => {
  server.close();
  await receiver.close();
  process.exit(0);
});
