// Request bodies stored as content-addressed message blocks: a long session
// costs about its own size in blobs, the exact redacted body reads back, old
// whole-body documents still read, and gc and purge follow the blocks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { gc } from "../../src/core/gc.ts";
import { pricesFor } from "../../src/core/pricing.ts";
import { createRedactor } from "../../src/core/redact.ts";
import { BIG_BYTES, FANOUT, getMessages, HOLD_BACK, putMessages, requestBlobRefs } from "../../src/proxy/blocks.ts";
import { loadCall } from "../../src/proxy/calls.ts";
import { type CapturedCall, createRecorder, storeWriter } from "../../src/proxy/record.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { FsBlobStore } from "../../src/store/fs-blobs.ts";
import { ageBlob, closeBlobs, fsBlobs } from "../store/_blobs.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { purgeLiterals } from "../../src/store/purge.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";

const roots: string[] = [];
after(async () => {
  await closeBlobs();
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "csh-blocks-"));
  roots.push(d);
  return d;
};

const SESSION = "5b0c1f2e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const SECRET = "sk-ant-api03-BLOCKSBLOCKSBLOCKSBLOCKSBLOCKS-abcdefAA";

/** Message i of a Claude Code–like conversation: prompts, tool calls and long tool results. */
function message(i: number): Record<string, unknown> {
  if (i === 0) return { role: "user", content: [{ type: "text", text: "fix the failing test" }] };
  if (i % 2 === 1) return { role: "assistant", content: [{ type: "text", text: `step ${i}` }, { type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: `npm test -- --grep case${i}` } }] };
  return { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i - 1}`, content: `${"ok ".repeat(40 + (i % 7) * 30)}line ${i}${i === 6 ? ` token=${SECRET}` : ""}` }] };
}

/** The body Claude Code would send at call n (2n+1 messages, the newest one marked for the cache). */
function body(n: number): Record<string, unknown> {
  const messages = Array.from({ length: 2 * n + 1 }, (_, i) => message(i));
  const last = messages.at(-1) as { content: Record<string, unknown>[] };
  messages[messages.length - 1] = { ...last, content: last.content.map((c) => ({ ...c, cache_control: { type: "ephemeral" } })) };
  return { model: "claude-sonnet-4-5", max_tokens: 32000, system: [{ type: "text", text: "You are Claude Code." }], tools: [{ name: "Bash", input_schema: { type: "object" } }], messages, stream: true, metadata: { user_id: JSON.stringify({ session_id: SESSION }) } };
}

function captured(n: number): CapturedCall {
  const b = Buffer.from(JSON.stringify(body(n)));
  return {
    route: { provider: "anthropic", api: "messages" },
    method: "POST",
    path: "/v1/messages",
    upstream: "https://api.anthropic.com",
    reqHeaders: { "user-agent": "claude-cli/2.1.319 (external, cli)", "x-claude-code-session-id": SESSION, "x-api-key": SECRET },
    reqBody: b,
    reqBytes: b.length,
    status: 200,
    resHeaders: { "content-type": "application/json" },
    result: { id: `msg_${n}`, model: "claude-sonnet-4-5", body: { id: `msg_${n}`, content: [{ type: "text", text: "ok" }] }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: "end_turn" },
    resBytes: 100,
    stream: false,
    startedAt: 1_700_000_000_000 + n * 1000,
    endedAt: 1_700_000_000_500 + n * 1000,
  } as unknown as CapturedCall;
}

const redactor = createRedactor({ redact: defaultConfig({}).capture.redact, patterns: [], env: {} });

async function record(blobs: MemoryBlobStore | FsBlobStore, index: MemoryIndexStore | SqliteIndexStore, calls: number): Promise<AgentEvent[]> {
  const rec = createRecorder({ blobs, redactor, metadata: false, prices: pricesFor({}), write: storeWriter(index) });
  for (let n = 0; n < calls; n++) {
    rec.record(captured(n));
    await rec.flush();
  }
  return index.listEvents(SESSION, { kinds: ["llm.call"] });
}

describe("proxy request blocks", () => {
  it("round-trips any conversation exactly: blocks of blocks, tail, inline and blob entries, strings", async () => {
    const blobs = new MemoryBlobStore();
    const items: unknown[] = [...Array.from({ length: FANOUT * FANOUT + 3 * FANOUT }, (_, i) => message(i)), "a bare string item", null, 42, { k: "x".repeat(BIG_BYTES * 2) }];
    const stored = await putMessages(blobs, items);
    const full = Math.floor((items.length - HOLD_BACK) / FANOUT) * FANOUT;
    assert.equal(stored.$tail.length, items.length - full);
    assert.ok(stored.$tail.length >= HOLD_BACK);
    const levels = await Promise.all(stored.$blocks.map(async (r) => JSON.parse((await blobs.getText(r))!).l));
    assert.deepEqual(levels, [1, ...Array.from({ length: full / FANOUT - FANOUT }, () => 0)], "one level 1 block, then the level 0 blocks after it");
    assert.ok(stored.$tail.includes(42), "small items stay inline");
    assert.equal(stored.$tail.filter((e) => typeof e === "string").length, 2, "a bare string and a large item are blob refs");
    const back = await getMessages(blobs, stored);
    assert.equal(JSON.stringify(back), JSON.stringify(items));
    for (const n of [0, 1, HOLD_BACK, HOLD_BACK + 1, FANOUT + HOLD_BACK, FANOUT + HOLD_BACK + 1, 75, 600]) {
      const xs = Array.from({ length: n }, (_, i) => message(i));
      assert.equal(JSON.stringify(await getMessages(blobs, await putMessages(blobs, xs))), JSON.stringify(xs), `${n} items`);
    }
  });

  it("calls that start alike share blocks; the newest messages (cache markers) never land in one", async () => {
    const blobs = new MemoryBlobStore();
    const a = await putMessages(blobs, (body(40).messages as unknown[]));
    const b = await putMessages(blobs, (body(41).messages as unknown[]));
    assert.equal(a.$blocks[0], b.$blocks[0], "the first 64 messages are one shared block");
    assert.ok(JSON.stringify(a.$tail).includes("cache_control"));
    for await (const ref of blobs.list()) {
      const v = JSON.parse((await blobs.getText(ref))!);
      if (typeof v?.l === "number") assert.ok(!JSON.stringify(v).includes("cache_control"), "no block holds a marker");
    }
  });

  it("writes calls in the order they were recorded, when one builds slower than the next", async () => {
    // Two calls in the same millisecond; the first one's response is still decoding when the second is recorded.
    const index = new MemoryIndexStore();
    const rec = createRecorder({ blobs: new MemoryBlobStore(), redactor, metadata: false, prices: pricesFor({}), write: storeWriter(index) });
    const first = { ...captured(1), startedAt: 1_700_000_000_000 };
    rec.record(new Promise<CapturedCall>((r) => setTimeout(() => r(first), 30)));
    rec.record({ ...captured(2), startedAt: 1_700_000_000_000 });
    await rec.flush();
    const events = await index.listEvents(SESSION, { kinds: ["llm.call"] });
    assert.deepEqual(events.map((e) => e.payload.messageCount), [3, 5]);
  });

  it("a growing session's blob bytes grow with its length, not its square", async () => {
    const bytes = async (calls: number) => {
      const blobs = new MemoryBlobStore();
      await record(blobs, new MemoryIndexStore(), calls);
      let n = 0;
      for await (const ref of blobs.list()) n += (await blobs.get(ref))!.byteLength;
      return n;
    };
    // What format 1 stored: every call's whole redacted body.
    const whole = (calls: number) => Array.from({ length: calls }, (_, n) => Buffer.byteLength(JSON.stringify(redactor.value(body(n))))).reduce((s, x) => s + x, 0);
    const [b60, b120] = [await bytes(60), await bytes(120)];
    assert.ok(whole(120) / whole(60) > 3.5, "whole bodies grow about 4× when the session doubles");
    assert.ok(b120 / b60 < 2.3, `blocks grow about 2× (${b60} → ${b120} bytes)`);
    assert.ok(b120 < whole(120) / 5, `${b120} bytes against ${whole(120)} as whole bodies`);
  });

  it("reads back the exact redacted body of every call, through loadCall", async () => {
    const blobs = new MemoryBlobStore();
    const index = new MemoryIndexStore();
    const events = await record(blobs, index, 40);
    for (const n of [0, 1, 15, 16, 31, 39]) {
      const l = await loadCall(blobs, events[n]!);
      assert.ok(l.request, `call ${n} has its request`);
      assert.equal(JSON.stringify(l.request.body), JSON.stringify({ ...(redactor.value(body(n)) as object) }), `call ${n} byte for byte`);
      assert.equal(l.info?.messages.length, 2 * n + 1);
      assert.equal(events[n]!.payload.requestPaged, true);
    }
    let all = "";
    for await (const ref of blobs.list()) all += await blobs.getText(ref);
    assert.ok(!all.includes(SECRET.slice(14, 40)), "the secret in a tool result is redacted before it is stored");
  });

  it("still reads format 1 documents (the whole body in one blob)", async () => {
    const blobs = new MemoryBlobStore();
    const sys = await blobs.put(JSON.stringify([{ type: "text", text: "You are Claude Code." }]));
    const b = { ...body(2), system: { $blob: sys } };
    const ref = await blobs.put(JSON.stringify({ v: 1, provider: "anthropic", api: "messages", method: "POST", path: "/v1/messages", headers: {}, body: b }));
    const e = { id: "e1", v: 1, sessionId: "s", ts: 1, agent: "proxy", kind: "llm.call", payload: { requestRef: ref } } as unknown as AgentEvent;
    const l = await loadCall(blobs, e);
    assert.deepEqual(l.request?.body.messages, body(2).messages);
    assert.deepEqual(l.request?.body.system, [{ type: "text", text: "You are Claude Code." }]);
  });

  it("a missing block makes the request unreadable, not wrong", async () => {
    const blobs = new MemoryBlobStore();
    const index = new MemoryIndexStore();
    const events = await record(blobs, index, FANOUT);
    const doc = JSON.parse((await blobs.getText(events.at(-1)!.payload.requestRef as string))!);
    await blobs.delete(doc.body.messages.$blocks[0]);
    const l = await loadCall(blobs, events.at(-1)!);
    assert.equal(l.request, undefined);
    assert.ok(l.response, "the response still reads");
  });

  it("gc keeps every page and message blob of a stored request and sweeps them with the session", async () => {
    const root = tmp();
    const env = { CODING_SH_HOME: join(root, "home"), HOME: root };
    const blobs = fsBlobs(join(root, "blobs"));
    const index = new MemoryIndexStore();
    const events = await record(blobs, index, 40);
    const all: string[] = [];
    for await (const ref of blobs.list()) all.push(ref);
    for (const ref of all) await ageBlob(blobs, ref, 3);
    const nested = await requestBlobRefs(blobs, events.at(-1)!.payload.requestRef as string, new Set());
    assert.ok(nested.length >= 4 && nested.every((r) => !events.at(-1)!.blobs?.includes(r)), "blocks are reachable only through the document");

    const kept = await gc({ index, blobs, config: defaultConfig(env), env, judgeCacheDir: false, lock: false });
    assert.equal(kept.blobs.deleted, 0, "nothing a stored request needs is swept");
    for (const n of [0, 20, 39]) assert.equal(JSON.stringify((await loadCall(blobs, events[n]!)).request?.body), JSON.stringify(redactor.value(body(n))));

    await index.deleteBefore(Date.now() + 86_400_000);
    const swept = await gc({ index, blobs, config: defaultConfig(env), env, judgeCacheDir: false, lock: false });
    assert.equal(swept.blobs.deleted, all.length, "with the session gone, its blocks go too");
  });

  it("purge rewrites a literal inside a message block, and the request still reads back", async () => {
    const root = tmp();
    const blobs = fsBlobs(join(root, "blobs"));
    const dbPath = join(root, "index.db");
    const index = await SqliteIndexStore.open(dbPath);
    const events = await record(blobs, index, 30);
    await index.close();
    // Message 6 holds a value no redaction rule knows (the redacted secret aside): purge it by literal.
    const LITERAL = "line 6 token=";
    const before = (await loadCall(blobs, events.at(-1)!)).request!;
    assert.ok(JSON.stringify(before.body).includes(LITERAL));
    const r = await purgeLiterals({ dbPath, blobs, literals: [LITERAL] });
    assert.ok(r.blobs >= 2, "the message block, and the blocks and documents above it");
    const after = await SqliteIndexStore.open(dbPath);
    const fresh = await after.listEvents(SESSION, { kinds: ["llm.call"] });
    await after.close();
    for (const n of [5, 20, 29]) {
      const l = await loadCall(blobs, fresh[n]!);
      assert.ok(l.request, `call ${n} still reads`);
      const text = JSON.stringify(l.request.body);
      assert.ok(!text.includes(LITERAL), `call ${n}: the literal is gone`);
      assert.equal(l.request.body.messages instanceof Array && (l.request.body.messages as unknown[]).length, 2 * n + 1);
    }
    let all = "";
    for await (const ref of blobs.list()) all += await blobs.getText(ref);
    assert.ok(!all.includes(LITERAL), "no blob keeps it");
  });
});
