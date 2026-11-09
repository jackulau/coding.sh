// The viewer's span model (src/viewer/model.ts) on real captures: Claude Code
// with nested subagents, Codex code-mode cells, Antigravity (no turn ids) and
// a compaction; folds never hide a failure; the outline and rows routes, one
// event by id, and byte-range blob reads; and the 150k-event budgets.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { convertRollout } from "../../src/adapters/codex.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { buildModel, FOLD_MIN, layoutRows, ModelCache, modelOutline, readRows, type FoldRow, type SessionModel } from "../../src/viewer/model.ts";
import { blobRange, startViewer, type Viewer } from "../../src/viewer/server.ts";
import { FIXTURES, testCtx } from "../adapters/_helpers.ts";
import { longSession } from "./fakes.ts";

const golden = (agent: string, name: string): AgentEvent[] => JSON.parse(readFileSync(join(FIXTURES, agent, "golden", name), "utf8"));
/** listEvents order: time, then the order they were stored. */
const sorted = (evs: AgentEvent[]) => evs.map((e, k) => [e, k] as const).sort((a, b) => a[0].ts - b[0].ts || a[1] - b[1]).map(([e]) => e);
const bySession = (evs: AgentEvent[]) => {
  const out = new Map<string, AgentEvent[]>();
  for (const e of evs) out.set(e.sessionId, [...(out.get(e.sessionId) ?? []), e]);
  return out;
};

/** Every event index of a turn, walked page by page: each index once, as a row or inside a fold. */
function walk(m: SessionModel, n: number, limit: number, fold = true) {
  const t = m.turns[n]!;
  const seen: number[] = [];
  const folds: { from: number; to: number }[] = [];
  let from = t.start;
  for (let pages = 0; pages < 10_000; pages++) {
    const { slots, next } = layoutRows(m, t, from, limit, fold);
    assert.ok(slots.length <= limit && slots.length > 0);
    for (const s of slots) {
      if ("i" in s) seen.push(s.i);
      else { folds.push(s); for (let k = s.from; k <= s.to; k++) seen.push(k); }
    }
    if (next === undefined) break;
    from = next;
  }
  assert.deepEqual(seen, Array.from({ length: t.end - t.start + 1 }, (_, k) => t.start + k), `turn ${n} covered once, in order`);
  return folds;
}

describe("model on real captures", () => {
  test("Claude Code with nested subagents: their events stay in the turn that ran them", () => {
    const evs = sorted(golden("claude-code", "subagents.golden.json"));
    const main = [...bySession(evs).values()].sort((a, b) => b.length - a.length)[0]!;
    const m = buildModel(main);
    // One prompt from the user, then the task notification that woke the agent again.
    assert.deepEqual(m.turns.map((t) => [t.prompt?.slice(0, 20), t.subagents]), [["Read a.txt and b.txt", 1], [undefined, 0]]);
    assert.equal(m.turns[0]!.start, 0, "session.start joins the first prompt's turn");
    assert.equal(m.turns.at(-1)!.end, main.length - 1);
    // The helper runs as its own session, and it ran a nested helper of its own.
    assert.deepEqual(m.subagents.map((s) => [s.type, s.end > s.start, s.childSessionId?.split(":sub:")[1]]), [["general-purpose", true, "a33e97aae0b87e2b4"]]);
    const mid = buildModel(bySession(evs).get(m.subagents[0]!.childSessionId!)!);
    assert.deepEqual(mid.turns.map((t) => [t.prompt?.slice(0, 9), t.subagents]), [["MID-AGENT", 1]]);
    assert.equal(mid.subagents[0]!.childSessionId?.split(":sub:")[1], "afa77c104e92d121e");
    assert.equal(m.calls, main.filter((e) => e.kind === "llm.call").length);
    assert.deepEqual(m.failed, []);
  });

  test("Codex code mode: a cell is not a tool call, its calls are; the cell fails with them", async () => {
    const file = join(FIXTURES, "codex", "code-mode", "rollout-2026-11-01T10-00-00-0193dddd-1111-7222-8333-444455556666.jsonl");
    const evs = sorted(await convertRollout(testCtx().ctx, file, { mode: "full" }));
    const m = buildModel(evs);
    const starts = evs.filter((e) => e.kind === "tool.start");
    assert.equal(m.tools, starts.filter((e) => e.payload.wrapper !== true).length);
    assert.ok(starts.some((e) => e.payload.wrapper === true), "the fixture has cells");
    const s = buildSession(evs);
    assert.equal(m.tools, s.stats.toolCalls, "the model counts tool calls as the session does");
    // Each failed tool.end is a failure, and none of them is inside a fold.
    const failedEnds = evs.flatMap((e, i) => (e.kind === "tool.end" && e.payload.ok === false ? [i] : []));
    for (const i of failedEnds) assert.ok(m.failed.includes(i), `failed end ${i} is a failure`);
    assert.ok(m.turns.length >= 1);
    for (const t of m.turns) for (const f of walk(m, t.n, 5)) for (const i of m.failed) assert.ok(i < f.from || i > f.to);
  });

  test("Antigravity has no turn ids: turns open at each prompt", () => {
    const hooks = sorted(golden("antigravity", "hooks.golden.json"));
    assert.equal(hooks.filter((e) => e.turnId).length, 0);
    const h = buildModel(hooks);
    assert.deepEqual(h.turns.map((t) => [t.start, t.end, t.subagents]), [[0, hooks.length - 1, 1]]);
    // The transcript: two prompts, a failed test run, an error and a compaction in the first turn.
    const evs = sorted(golden("antigravity", "backfill.golden.json"));
    const m = buildModel(evs);
    const prompts = evs.flatMap((e, i) => (e.kind === "user.message" ? [i] : []));
    assert.deepEqual(m.turns.map((t) => t.start), [0, prompts[1]]);
    assert.deepEqual(m.turns.map((t) => [t.failures > 0, t.compactions]), [[true, 1], [false, 0]]);
    assert.ok(m.failed.includes(evs.findIndex((e) => e.kind === "error")));
  });

  test("a compaction is listed, counted on its turn, and is a row, not folded", () => {
    const evs = sorted(golden("claude-code", "backfill.golden.json"));
    const withCompact = [...bySession(evs).values()].find((x) => x.some((e) => e.kind === "context.compact"))!;
    const m = buildModel(withCompact);
    const at = withCompact.findIndex((e) => e.kind === "context.compact");
    assert.deepEqual(m.compactions, [at]);
    const t = m.turns.find((x) => x.start <= at && at <= x.end)!;
    assert.equal(t.compactions, 1);
    for (const f of walk(m, t.n, 3)) assert.ok(at < f.from || at > f.to);
    assert.deepEqual(modelOutline(m).compactions, [at]);
  });
});

// ---------------------------------------------------------------- synthetic

describe("folds", () => {
  test("never hide a failure, and pages cover every event once (any page size, folded or not)", () => {
    const evs = longSession(6000, 12, 3);
    const m = buildModel(evs);
    assert.ok(m.failed.length > 10, `fixture has failures: ${m.failed.length}`);
    let folded = 0;
    for (const limit of [1, 2, 7, 50, 200]) {
      for (const t of m.turns) {
        const folds = walk(m, t.n, limit);
        folded += folds.length;
        for (const f of folds) {
          assert.ok(f.to - f.from + 1 >= FOLD_MIN - 6, "a fold is a long run");
          for (let i = f.from; i <= f.to; i++) assert.ok(!m.failed.includes(i) && m.codes[i] !== 3 && m.codes[i] !== 8, `index ${i} folded`);
        }
        assert.deepEqual(walk(m, t.n, limit, false), []);
      }
    }
    assert.ok(folded > 0, "something folded");
  });
});

describe("routes", () => {
  let v: Viewer;
  let index: MemoryIndexStore;
  let blobs: MemoryBlobStore;
  let ref: string;
  const evs = longSession(3000, 6, 11);
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${v.port}${path}`, { headers: { authorization: `Bearer ${v.token}`, ...headers } });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, buf, json: () => JSON.parse(buf.toString("utf8")) };
  };
  before(async () => {
    index = new MemoryIndexStore();
    blobs = new MemoryBlobStore();
    await index.putEvents(evs);
    await index.upsertSession(buildSession(evs));
    ref = await blobs.put("0123456789abcdefghij");
    v = await startViewer({ index, blobs, port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
  });
  after(async () => { await v?.close(); });

  test("outline adds turns, failures, compactions, subagents and a minimap", async () => {
    const o = (await get("/api/sessions/long-1/outline")).json();
    assert.ok(Array.isArray(o.phases), "the old fields stay");
    assert.equal(o.turns.count, 6);
    assert.equal(o.turns.lengths.length, 6);
    assert.equal(o.turns.lengths.reduce((a: number, b: number) => a + b, 0), 3000);
    const m = buildModel(evs);
    assert.deepEqual(o.failures.at, m.failed.slice(0, 100));
    assert.equal(o.failures.count, m.failed.length);
    assert.equal(o.minimap.rows.reduce((a: number, r: number[]) => a + r[0]!, 0), 3000);
    assert.equal(o.minimap.rows.reduce((a: number, r: number[]) => a + r[1]!, 0), m.failed.length);
  });

  test("rows pages through a turn with folds; after/next chain; bad params are 400", async () => {
    const m = buildModel(evs);
    const t = m.turns[2]!;
    let after: number | undefined;
    const got: number[] = [];
    for (let p = 0; p < 1000; p++) {
      const r = (await get(`/api/sessions/long-1/rows?turn=2&limit=40${after !== undefined ? `&after=${after}` : ""}`)).json();
      assert.equal(r.turn.n, 2);
      for (const row of r.rows) {
        if ("fold" in row) { for (let i = row.fold.from; i <= row.fold.to; i++) got.push(i); }
        else { got.push(row.i); assert.equal(row.id, evs[row.i]!.id, "the row is the event at its index"); }
      }
      if (r.next === undefined) break;
      after = r.next;
    }
    assert.deepEqual(got, Array.from({ length: t.end - t.start + 1 }, (_, k) => t.start + k));
    const failedRow = (await get(`/api/sessions/long-1/rows?turn=2&limit=1000`)).json().rows.find((x: any) => x.failed);
    assert.ok(failedRow && failedRow.kind === "tool.end");
    for (const q of ["turn=99", "turn=x", "limit=0", "limit=5000", `after=${t.end + 5}&turn=2`]) assert.equal((await get(`/api/sessions/long-1/rows?${q}`)).status, 400, q);
    assert.equal((await get("/api/sessions/nope/rows")).status, 404);
  });

  test("one event by id; unknown ids are 404", async () => {
    const r = await get(`/api/events/${evs[5]!.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json().payload, evs[5]!.payload);
    assert.equal((await get("/api/events/e9999999")).status, 404);
  });

  test("blob ranges: ?range= and the Range header give 206; past the end is 416; malformed is 400", async () => {
    const a = await get(`/api/blobs/${ref}?range=2-5`);
    assert.equal(a.status, 206);
    assert.equal(a.buf.toString(), "2345");
    assert.equal(a.headers.get("content-range"), "bytes 2-5/20");
    const b = await get(`/api/blobs/${ref}`, { range: "bytes=-3" });
    assert.equal(b.status, 206);
    assert.equal(b.buf.toString(), "hij");
    assert.equal((await get(`/api/blobs/${ref}?range=10-`)).buf.toString(), "abcdefghij");
    const c = await get(`/api/blobs/${ref}?range=20-30`);
    assert.equal(c.status, 416);
    assert.equal(c.headers.get("content-range"), "bytes */20");
    assert.equal((await get(`/api/blobs/${ref}?range=5-2`)).status, 400);
    assert.equal((await get(`/api/blobs/${ref}?range=abc`)).status, 400);
    const whole = await get(`/api/blobs/${ref}`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(blobRange("0-99999999", 10), [0, 9]);
    assert.equal(blobRange(null, 10), null);
  });
});

describe("150k events in SQLite", () => {
  let dir: string;
  let store: SqliteIndexStore;
  let v: Viewer;
  const N = 150_000;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "csh-model-"));
    store = await SqliteIndexStore.open(join(dir, "index.db"));
    const evs = longSession(N, 1000, 5);
    for (let i = 0; i < evs.length; i += 10_000) await store.putEvents(evs.slice(i, i + 10_000));
    await store.upsertSession(buildSession(evs));
    v = await startViewer({ index: store, blobs: new MemoryBlobStore(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
  });
  after(async () => {
    await v?.close();
    await store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const timed = async (path: string) => {
    const t0 = performance.now();
    const r = await fetch(`http://127.0.0.1:${v.port}${path}`, { headers: { authorization: `Bearer ${v.token}` } });
    const body = await r.text();
    return { ms: performance.now() - t0, bytes: Buffer.byteLength(body), status: r.status, body };
  };

  test("outline: under 30 ms and 20 KB; the first build of the spans runs in the background, then the kv keeps them", async () => {
    const first = await timed("/api/sessions/long-1/outline");
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.body).spans, "building");
    // The rows route waits for the build; then every outline has the spans.
    const t0 = performance.now();
    assert.equal((await timed("/api/sessions/long-1/rows?turn=0")).status, 200);
    const build = performance.now() - t0;
    // The first answer does not wait for the build: 200 ms, or a quarter of the build on a machine slow enough for that to be more.
    assert.ok(first.ms < Math.max(200, build / 4), `first outline ${first.ms} ms, build ${build} ms`);
    const warm: number[] = [];
    let body = "";
    for (let k = 0; k < 7; k++) { const r = await timed("/api/sessions/long-1/outline"); warm.push(r.ms); body = r.body; }
    warm.sort((a, b) => a - b);
    const median = warm[3]!;
    const bytes = Buffer.byteLength(body);
    console.log(`# outline 150k: first ${first.ms.toFixed(1)} ms (spans building), build ${build.toFixed(0)} ms, then median ${median.toFixed(1)} ms, ${bytes} bytes`);
    assert.ok(median < 30, `outline ${median} ms`);
    assert.ok(bytes < 20_000, `outline ${bytes} bytes`);
    assert.ok(JSON.parse(body).turns.count >= 990);
    // A new cache (a restarted viewer) reads the model from the kv instead of folding 150k events.
    const s = (await store.getSession("long-1"))!;
    const t1 = performance.now();
    const m = await new ModelCache().peek(store, s);
    const restart = performance.now() - t1;
    console.log(`# model from kv after restart: ${restart.toFixed(1)} ms`);
    assert.equal(m?.events, s.stats.events);
    assert.ok(restart < 100, `model from kv ${restart} ms`);
  });

  test("rows: a page deep in the session in under 50 ms", async () => {
    await timed("/api/sessions/long-1/outline");
    const times: number[] = [];
    for (const turn of [0, 500, 998, 997, 3, 750, 250]) {
      const r = await timed(`/api/sessions/long-1/rows?turn=${turn}&limit=200`);
      assert.equal(r.status, 200);
      assert.ok(JSON.parse(r.body).rows.length > 0);
      times.push(r.ms);
    }
    times.sort((a, b) => a - b);
    console.log(`# rows 150k: median ${times[3]!.toFixed(1)} ms, max ${times.at(-1)!.toFixed(1)} ms`);
    assert.ok(times[3]! < 50, `rows median ${times[3]} ms`);
  });
});

test("readRows reads only the events a page shows", async () => {
  const evs = longSession(400, 1, 2);
  const m = buildModel(evs);
  const reads: [number, number][] = [];
  const idx = { listEvents: async (_s: string, o: { offset?: number; limit?: number } = {}) => { reads.push([o.offset!, o.limit!]); return evs.slice(o.offset, o.offset! + o.limit!); } };
  const { slots } = layoutRows(m, m.turns[0]!, 0, 1000);
  const rows = await readRows(idx, "long-1", m, slots);
  const folds = rows.filter((r): r is FoldRow => "fold" in r);
  assert.ok(folds.length > 0);
  const read = reads.reduce((a, [, n]) => a + n, 0);
  assert.equal(read, rows.length - folds.length, "folded events are not read");
});
