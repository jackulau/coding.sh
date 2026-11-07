// trace / span / withSession semantics: return values and errors pass through
// untouched, sync and async work, nesting, metadata mode, and no URL = no-op.
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { flush, init, span, stats, trace, withSession } from "../src/index.ts";
import { _reset } from "../src/client.ts";
import { type FakeServe, startFakeServe } from "./helpers/fake-serve.ts";

let serve: FakeServe;
before(async () => {
  serve = await startFakeServe();
});
after(async () => {
  assert.deepEqual(serve.rejected, [], "the real server parser accepts every SDK event");
  await serve.close();
});
beforeEach(() => {
  _reset();
  init({ url: serve.url, flushIntervalMs: 10 });
});

const kinds = (sid: string) => serve.events().filter((e) => e.sessionId === sid).map((e) => e.kind);

test("sync and async traces return the app's own values", async () => {
  assert.equal(trace("sync", () => 7), 7);
  const obj = { a: 1 };
  assert.equal(await trace("async", async () => obj), obj, "same object, not a copy");
  const p = Promise.resolve(3);
  assert.equal(trace("promise", () => p), p, "the very same promise is returned");
});

test("errors pass through unchanged and are recorded on turn.end", async () => {
  const boom = new Error("boom");
  assert.throws(() => trace("sync-fail", () => { throw boom; }, { sessionId: "err-s" }), (e) => e === boom);
  await assert.rejects(trace("async-fail", async () => { throw boom; }, { sessionId: "err-a" }), (e) => e === boom);
  await assert.rejects(span("tool", "t", async () => { throw boom; }), (e) => e === boom);
  await flush();
  const end = serve.events().find((e) => e.sessionId === "err-a" && e.kind === "turn.end")!;
  assert.equal(end.payload.ok, false);
  assert.equal(end.payload.error, "boom");
});

test("a trace is a session: session.start, user.message, turn.end, session.end", async () => {
  const sid = trace("solo", (t) => t.sessionId, { input: "hello" });
  await flush();
  assert.deepEqual(kinds(sid), ["session.start", "user.message", "turn.end", "session.end"]);
  const s = serve.session(sid)!;
  assert.equal(s.title, "hello");
  assert.equal(s.stats.turns, 1);
});

test("sessionId groups turns into one conversation (no session.end per turn)", async () => {
  await trace("t1", async () => 1, { sessionId: "conv", input: "first" });
  await trace("t2", async () => 2, { sessionId: "conv", input: "second" });
  await flush();
  const k = kinds("conv");
  assert.equal(k.filter((x) => x === "turn.end").length, 2);
  assert.ok(!k.includes("session.end"));
  assert.equal(serve.session("conv")!.stats.turns, 2);
});

test("withSession applies to traces inside it; nested traces become step spans; tools nest", async () => {
  await withSession("ws", () =>
    trace("outer", async () => {
      await trace("inner", async () => {
        await span("tool", "lookup_order", async () => ({ ok: true }), { input: { id: 1 } });
      });
    }),
  );
  await flush();
  const evs = serve.events().filter((e) => e.sessionId === "ws");
  assert.deepEqual(evs.map((e) => e.kind).sort(), ["session.start", "span", "tool.end", "tool.start", "turn.end"].sort());
  const step = evs.find((e) => e.kind === "span")!;
  const tool = evs.find((e) => e.kind === "tool.start")!;
  const root = evs.find((e) => e.kind === "session.start")!;
  assert.equal(new Set(evs.map((e) => e.traceId)).size, 1);
  assert.equal(step.parentSpanId, root.spanId);
  assert.equal(tool.parentSpanId, step.spanId, "tool is a child of the inner step");
  assert.deepEqual(tool.payload.input, { id: 1 });
  assert.equal(serve.session("ws")!.stats.toolCalls, 1);
});

test("span outside a trace is its own trace", async () => {
  span("tool", "standalone", () => 1);
  await flush();
  const s = [...serve.sessions().values()].find((x) => x.stats.toolCalls === 1 && !x.id.includes("ws"));
  assert.ok(s);
});

test("metadata capture mode drops text but keeps structure", async () => {
  _reset();
  init({ url: serve.url, flushIntervalMs: 10, capture: "metadata" });
  await trace("m", async () => span("tool", "t", async () => "secret out", { input: "secret in" }), { sessionId: "meta", input: "secret prompt" });
  await flush();
  const body = JSON.stringify(serve.events().filter((e) => e.sessionId === "meta"));
  assert.doesNotMatch(body, /secret/);
  assert.equal(serve.session("meta")!.stats.toolCalls, 1);
});

test("no URL: nothing is sent and every helper still works", async () => {
  _reset();
  init({});
  const n = serve.requests.length;
  assert.equal(trace("x", () => span("tool", "y", () => withSession("z", () => 5))), 5);
  assert.equal(await flush(50), true);
  assert.equal(serve.requests.length, n);
  assert.deepEqual(stats(), { queued: 0, sent: 0, dropped: 0, failed: 0 });
});

test("observation failures never reach the app (unserializable tool input/output)", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const big = 10n;
  assert.equal(span("tool", "weird", () => big, { input: cyclic }), big);
  await flush();
});
