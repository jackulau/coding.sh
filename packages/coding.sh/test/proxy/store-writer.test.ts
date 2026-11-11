// What the proxy does after each call: write the call's blobs in one durable
// batch, then the event, then refold the session from its saved fold, so the
// work per call stays flat however long the session gets.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { sha256Hex } from "../../src/core/ids.ts";
import { pricesFor } from "../../src/core/pricing.ts";
import { createRedactor } from "../../src/core/redact.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { BlobBatch, BlobStore, IndexStore } from "../../src/core/types.ts";
import { type CapturedCall, createRecorder, storeWriter } from "../../src/proxy/record.ts";
import { type AgentEvent, SCHEMA_VERSION } from "../../src/schema/index.ts";
import { MemoryBlobStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

const SESSION = "6c1d2f3e-4b5a-4c6d-9e8f-1a2b3c4d5e6f";
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

function call(n: number, i: number, every = MINUTE): AgentEvent {
  return {
    id: `proxy-${n}`,
    v: SCHEMA_VERSION,
    sessionId: SESSION,
    ts: T0 + n * every,
    durationMs: 2000,
    source: "proxy",
    agent: "claude-code",
    kind: "llm.call",
    model: "claude-sonnet-4-5",
    usage: { inputTokens: 100 + i, outputTokens: 10, costUsd: 0.001 },
    payload: { provider: "anthropic", api: "messages", ok: true, messageId: `msg_${n}` },
  } as AgentEvent;
}

/** The store, counting the events each write reads back. */
function counting(index: IndexStore): { index: IndexStore; read: number[] } {
  const read: number[] = [];
  const wrapped = new Proxy(index, {
    get(target, key, recv) {
      const v = Reflect.get(target, key, recv);
      if (typeof v !== "function") return v;
      if (key === "listEvents") return async (...a: unknown[]) => { const out = await v.apply(target, a); read[read.length - 1]! += out.length; return out; };
      if (key === "listEventsSince") return async (...a: unknown[]) => { const out = await v.apply(target, a); read[read.length - 1]! += out.events.length; return out; };
      return v.bind(target);
    },
  });
  return { index: wrapped, read };
}

describe("proxy store writes", () => {
  it("folds only the new events: a call reads as much at the end of a burst of 300 calls as at its start", async () => {
    const sqlite = await SqliteIndexStore.open(":memory:");
    const { index, read } = counting(sqlite);
    const write = storeWriter(index);
    const all: AgentEvent[] = [];
    // One call a second: all of them inside the 15 minutes a saved fold trails the newest event by.
    for (let n = 0; n < 300; n++) {
      read.push(0);
      const e = call(n, n, 1000);
      all.push(e);
      await write([e]);
    }
    assert.ok(read.slice(2).every((r) => r === 1), `each write read its own event only, not ${Math.max(...read.slice(2))}`);
    const row = await sqlite.getSession(SESSION);
    const built = buildSession(all);
    assert.equal(row?.parseVersion, 0, "a session the proxy creates stays unstamped");
    assert.deepEqual(row?.stats, built.stats);
    assert.equal(row?.startedAt, built.startedAt);
    assert.equal(row?.endedAt, built.endedAt);
    await sqlite.close();
  });

  it("keeps the row right when an event comes out of order or from another writer, folding again from the saved fold", async () => {
    const sqlite = await SqliteIndexStore.open(":memory:");
    const { index, read } = counting(sqlite);
    const write = storeWriter(index);
    const all: AgentEvent[] = [];
    const step = async (e: AgentEvent) => {
      read.push(0);
      all.push(e);
      await write([e]);
      assert.deepEqual((await sqlite.getSession(SESSION))?.stats, buildSession(all).stats, `after ${e.id}`);
    };
    for (let n = 0; n < 120; n++) await step(call(n, n));
    // A call that started before the last one it wrote (it ran longer): folded from the store.
    await step(call(118.5, 500));
    assert.ok(read.at(-1)! > 1, "folded again from the store");
    await step(call(121, 121));
    assert.equal(read.at(-1), 1, "then back to the new events only");
    // Another writer (ingest) adds an event and rewrites the row.
    const hook = { ...call(121.5, 0), id: "hook-1", source: "hook", kind: "tool.end", usage: undefined, payload: { tool: "Bash", ok: true } } as unknown as AgentEvent;
    await sqlite.putEvents([hook]);
    all.push(hook);
    await sqlite.upsertSession(buildSession(all, await sqlite.getSession(SESSION)));
    await step(call(122, 122));
    assert.ok(read.at(-1)! > 2 && read.at(-1)! <= 25, `a row another writer changed is folded again, from the fold saved last time: read ${read.at(-1)}`);
    await sqlite.close();
  });

  it("writes a call's blobs in one batch, flushed before the event, and puts them again after a failed flush", async () => {
    const mem = new MemoryBlobStore();
    let direct = 0;
    let flushes = 0;
    let failNext = true;
    const blobs: BlobStore = {
      kind: "memory",
      put: (d, m) => { direct++; return mem.put(d, m); },
      get: (r) => mem.get(r),
      getText: (r) => mem.getText(r),
      has: (r) => mem.has(r),
      list: () => mem.list(),
      delete: (r) => mem.delete(r),
      batch(): BlobBatch {
        const staged: (string | Uint8Array)[] = [];
        return {
          ...this,
          put: async (d) => { staged.push(d); return sha256Hex(d); },
          async flush() {
            flushes++;
            if (failNext) { failNext = false; throw new Error("disk full"); }
            for (const d of staged) await mem.put(d);
          },
        } as BlobBatch;
      },
    };
    const writes: AgentEvent[][] = [];
    const errors: Error[] = [];
    const rec = createRecorder({ blobs, redactor: createRedactor({ redact: defaultConfig({}).capture.redact, patterns: [], env: {} }), metadata: false, prices: pricesFor({}), write: async (e) => void writes.push(e), onError: (e) => void errors.push(e) });
    const body = Buffer.from(JSON.stringify({ model: "claude-sonnet-4-5", system: [{ type: "text", text: "You are Claude Code." }], tools: [{ name: "Bash", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hi" }] }));
    const captured = (n: number) => ({
      route: { provider: "anthropic", api: "messages" },
      method: "POST",
      path: "/v1/messages",
      upstream: "https://api.anthropic.com",
      reqHeaders: { "user-agent": "claude-cli/2.1.319 (external, cli)", "x-claude-code-session-id": SESSION },
      reqBody: body,
      reqBytes: body.length,
      status: 200,
      resHeaders: { "content-type": "application/json" },
      result: { id: `msg_${n}`, body: { id: `msg_${n}`, content: [] } },
      resBytes: 10,
      stream: false,
      startedAt: T0 + n * 1000,
      endedAt: T0 + n * 1000 + 500,
    }) as unknown as CapturedCall;
    rec.record(captured(0));
    await rec.flush();
    assert.equal(writes.length, 0, "no event points at blobs that did not reach the store");
    assert.equal(errors[0]?.message, "disk full");
    rec.record(captured(1));
    await rec.flush();
    assert.equal(direct, 0, "every blob went through the batch");
    assert.equal(flushes, 2, "one flush per call");
    const e = writes.flat()[0]!;
    for (const ref of e.blobs ?? []) assert.ok(await mem.get(ref), `blob ${ref.slice(0, 8)} is stored`);
    assert.ok(e.payload.systemRef && e.payload.toolsRef, "the system prompt and tools were put again after the failed flush");
  });

  it("tags the session with the gateway the proxy sends its calls on to", async () => {
    // After `init --proxy` chains through a gateway, the hook sees only the proxy's URL: the call names the gateway.
    const body = Buffer.from(JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }));
    const captured = (upstream: string): CapturedCall => ({
      route: { provider: "anthropic", api: "messages" },
      method: "POST",
      path: "/v1/messages",
      upstream,
      reqHeaders: { "user-agent": "claude-cli/2.1.319 (external, cli)", "x-claude-code-session-id": SESSION },
      reqBody: body,
      reqBytes: body.length,
      status: 200,
      resHeaders: { "content-type": "application/json" },
      result: { id: "msg_1", model: "claude-sonnet-4-5", usage: { inputTokens: 10, outputTokens: 2 }, hints: {}, events: 0, body: { id: "msg_1", content: [] } },
      resBytes: 10,
      stream: false,
      startedAt: T0,
      endedAt: T0 + 500,
    });
    const flagsAfter = async (upstream: string, o: { metadata?: boolean; env?: NodeJS.ProcessEnv } = {}) => {
      const sqlite = await SqliteIndexStore.open(":memory:");
      const rec = createRecorder({ blobs: new MemoryBlobStore(), redactor: createRedactor({ redact: defaultConfig({}).capture.redact, patterns: [], env: {} }), metadata: o.metadata === true, prices: pricesFor({}), write: storeWriter(sqlite), env: o.env ?? {} });
      rec.record(captured(upstream));
      await rec.flush();
      assert.deepEqual(rec.stats, { written: 1, failed: 0 });
      const [call] = await sqlite.listEvents(SESSION);
      const flags = (await sqlite.getSession(SESSION))!.flags;
      await sqlite.close();
      return { gateway: call!.payload.gateway, flags };
    };
    assert.deepEqual(await flagsAfter("http://127.0.0.1:8317"), { gateway: "cliproxyapi", flags: ["gateway:cliproxyapi"] });
    assert.deepEqual(await flagsAfter("http://127.0.0.1:8317", { metadata: true }), { gateway: "cliproxyapi", flags: ["gateway:cliproxyapi"] }, "capture mode metadata keeps the tag");
    assert.deepEqual(await flagsAfter("https://ai-gateway.vercel.sh"), { gateway: "vercel", flags: ["gateway:vercel"] });
    assert.deepEqual(await flagsAfter("https://litellm.internal", { env: { LITELLM_PROXY_URL: "https://litellm.internal/v1" } }), { gateway: "litellm", flags: ["gateway:litellm"] }, "a self-hosted gateway, by its URL variable");
    assert.deepEqual(await flagsAfter("https://api.anthropic.com"), { gateway: undefined, flags: [] }, "the provider's own API is no gateway");
  });
});
