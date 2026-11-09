// The receiver's group commit on the real stores (SQLite index, file blobs):
// concurrent requests are stored together, each still gets its own answer,
// and a session built from the events in hand equals one read back from the store.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import { type BatchInfo, type Receiver, startReceiver } from "../../src/otel/receiver.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/otel/${name}`, import.meta.url), "utf8");

function post(base: string, data: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(new URL("/v1/traces", base), { method: "POST", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

describe("receiver group commit", () => {
  let root: string;
  let store: SqliteIndexStore;
  let rx: Receiver;
  const batches: BatchInfo[] = [];
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "cs-rx-commit-"));
    store = await SqliteIndexStore.open(join(root, "index.db"));
    rx = await startReceiver({ port: 0, store, blobs: new FsBlobStore(join(root, "blobs")), onBatch: (b) => void batches.push(b) });
  });
  after(async () => {
    await rx.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("answers every request of a concurrent burst and stores each once", async () => {
    const bodies = ["genai-semconv.json", "vercel-ai.json", "openinference.json", "claude-code-traces.json", "agent-runs/turn.json", "genai-semconv-agents.json"].map(fixture);
    const res = await Promise.all([...bodies, ...bodies].map((b) => post(rx.url, b)));
    assert.deepEqual(res.map((r) => r.status), Array(12).fill(200));
    assert.equal(batches.length, 12);
    // The second copy of each request stores nothing new, whichever group it landed in.
    const inserted = batches.reduce((n, b) => n + b.inserted, 0);
    const mapped = batches.reduce((n, b) => n + b.events.length, 0) / 2;
    assert.equal(inserted, mapped);
    for (const b of batches) for (const s of b.sessions) assert.ok(b.events.some((e) => e.sessionId === s.id), "a batch reports only its own sessions");
  });

  it("builds a new session from the events in hand as from the stored events", async () => {
    const seen = new Set<string>();
    for (const b of batches) {
      for (const s of b.sessions) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        const inHand = b.events.filter((e) => e.sessionId === s.id);
        assert.deepEqual(buildSession(inHand), buildSession(await store.listEvents(s.id)), s.id);
      }
    }
    assert.ok(seen.size >= 6);
  });
});
