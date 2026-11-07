import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent, EventKind, Session } from "../../src/schema/index.ts";
import type { Adapter, Config, Sink, SinkAck } from "../../src/core/types.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill, ingest, sinkCursorKey, sinkRetryKey } from "../../src/core/ingest.ts";
import { acquireLock, isStale, LockBusyError, LockLostError } from "../../src/core/lock.ts";
import { kickIngest } from "../../src/spool/kick.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { wrapperAdapter } from "../../src/adapters/more/wrapper.ts";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const seenSources: (undefined | { file: string; offset: number })[] = [];
/** raw.hook = name → awaited inside normalize (to act mid-run). */
const hooks: Record<string, () => Promise<void> | void> = {};
/** raw = { session, kind, text?, blob?, ...payload } → one event; raw.events = n → n events. */
const fakeAdapter: Adapter = {
  id: "fake",
  displayName: "Fake",
  tier: "A",
  detect: async () => ({ installed: true, hooked: true }),
  install: async () => [],
  uninstall: async () => [],
  async normalize(line, ctx) {
    const raw = line.raw as Record<string, unknown>;
    seenSources.push(ctx.source);
    if (typeof raw.hook === "string") await hooks[raw.hook]?.();
    if (raw.throw) throw new Error("boom");
    if (raw.invalid) return [{ id: "", sessionId: "", kind: "nope" } as unknown as AgentEvent];
    const n = typeof raw.events === "number" ? raw.events : 1;
    const out: AgentEvent[] = [];
    for (let i = 0; i < n; i++) {
      const { session, kind, blob, events: _n, hook: _h, ...payload } = raw;
      const e: AgentEvent = {
        id: ctx.id(line.agent, String(session), line.ts, line.event, i),
        v: 0,
        sessionId: String(session),
        ts: line.ts + i,
        agent: line.agent,
        kind: (kind as EventKind) ?? "notification",
        cwd: line.cwd,
        payload,
      };
      if (typeof blob === "string") e.blobs = [await ctx.blob(blob)];
      out.push(e);
    }
    return out;
  },
};
const adapters = new Map<string, Adapter>([["fake", fakeAdapter]]);

function setup(over: Partial<Config["capture"]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "csh-ingest-"));
  roots.push(root);
  const env = { CODING_SH_HOME: join(root, "home"), HOME: join(root, "user") };
  const config = defaultConfig(env);
  Object.assign(config.capture, over);
  const dir = join(env.CODING_SH_HOME, "spool", "fake");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "2026-11-06.1.jsonl");
  let ts = 1_700_000_000_000;
  const line = (raw: Record<string, unknown>, o: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 0, agent: "fake", event: `E${ts}`, ts: (ts += 1000), pid: 1, cwd: join(root, "work"), raw, ...o }) + "\n";
  const write = (...lines: string[]) => appendFileSync(file, lines.join(""));
  return { root, env, config, file, line, write, index: new MemoryIndexStore(), blobs: new MemoryBlobStore() };
}

class RecordingSink implements Sink {
  readonly name: string;
  readonly mode: "full" | "metadata";
  batches: { events: AgentEvent[]; sessions: Session[] }[] = [];
  ack: SinkAck = { ok: true };
  constructor(name: string, mode: "full" | "metadata") {
    this.name = name;
    this.mode = mode;
  }
  async write(events: AgentEvent[], sessions: Session[]): Promise<SinkAck> {
    if (this.ack.ok) this.batches.push({ events, sessions });
    return this.ack;
  }
  get events() {
    return this.batches.flatMap((b) => b.events);
  }
}

describe("ingest", () => {
  it("ingests spool lines into events and sessions, idempotently", async () => {
    const t = setup();
    t.write(
      t.line({ session: "s1", kind: "session.start" }),
      t.line({ session: "s1", kind: "user.message", text: "Fix the login bug" }),
      t.line({ session: "s1", kind: "file.change", path: "a.ts" }),
      t.line({ session: "s1", kind: "turn.end" }),
      t.line({ session: "s2", kind: "user.message", text: "Other" }),
    );
    const opts = { config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env };
    const r = await ingest(opts);
    assert.deepEqual({ lines: r.lines, events: r.events, sessions: r.sessions, errors: r.errors }, { lines: 5, events: 5, sessions: 2, errors: [] });
    const s1 = await t.index.getSession("s1");
    assert.equal(s1?.title, "Fix the login bug");
    assert.deepEqual(s1?.flags, ["no-verification"]);
    assert.equal(s1?.stats.events, 4);
    assert.equal(await t.index.getCursor("fake/2026-11-06.1.jsonl"), statSync(t.file).size);

    const again = await ingest(opts);
    assert.deepEqual({ lines: again.lines, events: again.events, sessions: again.sessions }, { lines: 0, events: 0, sessions: 0 });

    // Even if the cursor is lost, re-ingest inserts nothing new.
    await t.index.setCursor("fake/2026-11-06.1.jsonl", 0);
    const replay = await ingest(opts);
    assert.equal(replay.lines, 5);
    assert.equal(replay.events, 0);
  });

  it("leaves a partial last line for the next run", async () => {
    const t = setup();
    const full = t.line({ session: "s", kind: "user.message", text: "one" });
    const late = t.line({ session: "s", kind: "user.message", text: "two" });
    t.write(full, late.slice(0, 15));
    const opts = { config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env };
    assert.equal((await ingest(opts)).lines, 1);
    assert.equal(await t.index.getCursor("fake/2026-11-06.1.jsonl"), Buffer.byteLength(full));
    t.write(late.slice(15));
    const r = await ingest(opts);
    assert.equal(r.lines, 1);
    assert.equal((await t.index.listEvents("s")).length, 2);
  });

  it("records errors without wedging: unknown agent, adapter throw, invalid event, bad JSON", async () => {
    const t = setup();
    t.write(
      t.line({ session: "s" }, { agent: "mystery" }),
      t.line({ throw: true }),
      t.line({ invalid: true }),
      "{oops\n",
      t.line({ session: "s", kind: "user.message", text: "fine" }),
    );
    const opts = { config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env };
    const r = await ingest(opts);
    assert.equal(r.events, 1);
    assert.deepEqual(r.errors.map((e) => e.message.slice(0, 30)), [
      'no adapter registered for agen',
      "fake.normalize failed: boom",
      "fake: event has no id",
      "invalid JSON: Expected propert",
    ]);
    assert.ok(r.errors.every((e) => e.source === "fake/2026-11-06.1.jsonl" && typeof e.offset === "number"));
    assert.equal(await t.index.getCursor("fake/2026-11-06.1.jsonl"), statSync(t.file).size);
    assert.deepEqual((await ingest(opts)).errors, [], "errors are not repeated");
  });

  it("records `run --agent <any name>` wrapper lines under that name", async () => {
    const t = setup();
    const wrapper = new Map<string, Adapter>([["fake", fakeAdapter], ["wrapper", wrapperAdapter]]);
    const sid = "2dddda7a-0b0e-4c03-ba2e-52b2d1a22b84";
    const cwd = join(t.root, "work");
    t.write(
      t.line({ sessionId: sid, cmd: "./my-agent", args: ["--task", "42"], cwd }, { agent: "my-agent", event: "session.start" }),
      t.line({ sessionId: sid, path: "add.js", op: "modify", additions: 1, deletions: 1 }, { agent: "my-agent", event: "file.change" }),
      t.line({ sessionId: sid, exitCode: 0, durationMs: 2 }, { agent: "my-agent", event: "session.end" }),
      // A hook-shaped line from an unknown agent is still skipped.
      t.line({ hook_event_name: "Stop", session_id: "x" }, { agent: "my-agent", event: "session.end" }),
    );
    const r = await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters: wrapper, env: t.env });
    assert.deepEqual(r.errors.map((e) => e.message.slice(0, 30)), ["no adapter registered for agen"]);
    const s = await t.index.getSession(sid);
    assert.equal(s?.agent, "my-agent");
    assert.equal(s?.stats.filesChanged, 1);
    const events = await t.index.listEvents(sid);
    assert.deepEqual(events.map((e) => e.kind), ["session.start", "file.change", "session.end"]);
    assert.ok(events.every((e) => e.agent === "my-agent" && e.source === "wrapper"));
  });

  it("redacts payloads and blobs before storing", async () => {
    const t = setup();
    const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz";
    t.write(t.line({ session: "s", kind: "user.message", text: `my key is ${key}`, blob: `raw transcript with ${key}` }));
    await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    const [e] = await t.index.listEvents("s");
    assert.equal(e!.payload.text, "my key is [redacted:anthropic-key]");
    assert.equal(await t.blobs.getText(e!.blobs![0]!), "raw transcript with [redacted:anthropic-key]");
    assert.equal((await t.index.search("redacted")).length, 1);
  });

  it("metadata mode stores no content (and no blobs) but keeps verification signals", async () => {
    const t = setup({ mode: "metadata" });
    t.write(
      t.line({ session: "s", kind: "user.message", text: "secret prompt", blob: "secret blob" }),
      t.line({ session: "s", kind: "file.change", path: "/secret/a.ts" }),
      t.line({ session: "s", kind: "tool.start", tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }),
    );
    await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    const events = await t.index.listEvents("s");
    assert.ok(!JSON.stringify(events).includes("secret"));
    assert.equal(events[2]!.payload.verify, true);
    assert.equal(events[2]!.payload.tool, "Bash");
    assert.equal(await t.blobs.size(), 0);
    assert.deepEqual((await t.index.getSession("s"))?.flags, [], "npm test counted as verification");
  });

  it("honours capture.exclude and per-repo overrides by line cwd", async () => {
    const t = setup({ exclude: ["~/private/**"] });
    const repo = join(t.root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, ".coding.sh"), { recursive: true });
    writeFileSync(join(repo, ".coding.sh", "config.toml"), '[capture]\nmode = "metadata"\n');
    t.write(
      t.line({ session: "hidden", kind: "user.message", text: "x" }, { cwd: join(t.env.HOME, "private", "proj") }),
      t.line({ session: "meta", kind: "user.message", text: "repo secret" }, { cwd: join(repo, "src") }),
      t.line({ session: "full", kind: "user.message", text: "visible" }),
    );
    const r = await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    assert.equal(r.excluded, 1);
    assert.deepEqual(await t.index.listEvents("hidden"), []);
    assert.deepEqual((await t.index.listEvents("meta"))[0]!.payload, {});
    assert.equal((await t.index.listEvents("full"))[0]!.payload.text, "visible");
  });

  it("handles many events across batches and checkpoints with sqlite", async () => {
    const t = setup();
    const lines: string[] = [];
    for (let i = 0; i < 120; i++) lines.push(t.line({ session: `s${i % 3}`, kind: "tool.end", tool: "Bash", ok: true, events: 10 }));
    t.write(...lines);
    const index = await SqliteIndexStore.open(join(t.root, "idx.db"));
    const r = await ingest({ config: t.config, index, blobs: t.blobs, adapters, env: t.env, checkpointEvents: 250 });
    assert.equal(r.events, 1200);
    assert.equal(r.sessions, 3);
    assert.equal((await index.getSession("s0"))?.stats.events, 400);
    assert.equal(await index.getCursor("fake/2026-11-06.1.jsonl"), statSync(t.file).size);
    await index.close();
  });

  it("does not advance the cursor when a write fails, and recovers on the next run", async () => {
    const t = setup();
    t.write(t.line({ session: "s", kind: "user.message", text: "a" }), t.line({ session: "s", kind: "turn.end" }));
    const flaky = new MemoryIndexStore();
    const realPut = flaky.putEvents.bind(flaky);
    flaky.putEvents = async () => { throw new Error("disk full"); };
    const opts = { config: t.config, index: flaky, blobs: t.blobs, adapters, env: t.env };
    await assert.rejects(() => ingest(opts), /disk full/);
    assert.equal(await flaky.getCursor("fake/2026-11-06.1.jsonl"), 0);
    flaky.putEvents = realPut;
    const r = await ingest(opts);
    assert.equal(r.events, 2);
    assert.equal((await flaky.getSession("s"))?.stats.turns, 1);
  });

  it("fans out to sinks with their own cursors, backs off on failure and catches up", async () => {
    const t = setup();
    let now = 1_000_000;
    const good = new RecordingSink("good", "full");
    const meta = new RecordingSink("meta", "metadata");
    const down = new RecordingSink("down", "full");
    down.ack = { ok: false, error: "503", retryAfterMs: 60_000 };
    t.config.sinks = [
      { kind: "x", name: "good", endpoint: "", mode: "full", batchSize: 2 },
      { kind: "x", name: "meta", endpoint: "", mode: "metadata" },
      { kind: "x", name: "down", endpoint: "", mode: "full" },
    ];
    t.write(
      t.line({ session: "s", kind: "user.message", text: "secret prompt" }),
      t.line({ session: "s", kind: "tool.end", tool: "Bash", ok: true }),
      t.line({ session: "s", kind: "session.end" }),
    );
    const opts = { config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env, sinks: [good, meta, down], now: () => now };
    const r = await ingest(opts);
    assert.equal(r.events, 3, "local write is not blocked by a failing sink");
    assert.deepEqual(r.sinks.map((s) => [s.name, s.ok, s.sent]), [["good", true, 3], ["meta", true, 3], ["down", false, 0]]);
    assert.deepEqual(good.batches.map((b) => b.events.length), [2, 1], "batchSize respected");
    assert.equal(good.batches[0]!.sessions[0]!.title, "secret prompt", "sessions accompany events");
    assert.ok(!JSON.stringify(meta.batches).includes("secret"), "metadata sinks never see content");
    assert.equal(await t.index.getCursor(sinkRetryKey("down")), now + 60_000);
    assert.equal(await t.index.getCursor(sinkCursorKey("down", "fake/2026-11-06.1.jsonl")), 0);
    assert.ok(r.errors.some((e) => e.sink === "down"));

    // Still backing off: skipped without a request.
    t.write(t.line({ session: "s2", kind: "user.message", text: "later" }));
    down.ack = { ok: true };
    const skipped = await ingest(opts);
    assert.equal(skipped.sinks.find((s) => s.name === "down")?.retryAt, now + 60_000);
    assert.equal(down.batches.length, 0);
    assert.deepEqual(good.events.map((e) => e.sessionId), ["s", "s", "s", "s2"]);

    // After the backoff the sink replays everything it missed, from the spool.
    now += 61_000;
    const caught = await ingest(opts);
    assert.equal(caught.events, 0);
    assert.deepEqual(down.events.map((e) => e.kind), ["user.message", "tool.end", "session.end", "user.message"]);
    assert.equal(good.events.length, 4, "healthy sinks don't get duplicates");
    assert.equal(await t.index.getCursor(sinkCursorKey("down", "fake/2026-11-06.1.jsonl")), statSync(t.file).size);
  });

  it("links subagent sessions to their parent regardless of ingest order", async () => {
    const t = setup();
    t.write(
      t.line({ session: "child", kind: "user.message", text: "explore" }),
      t.line({ session: "parent", kind: "subagent.start", subagentId: "a1", type: "explore", childSessionId: "child" }),
    );
    await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    const child = await t.index.getSession("child");
    assert.equal(child?.parent?.sessionId, "parent");
    assert.equal(child?.parent?.subagentId, "a1");
    assert.equal(child?.parent?.type, "explore");
    assert.equal((await t.index.getSession("parent"))?.stats.latency?.subagents, 1);
    assert.deepEqual((await t.index.listSessions({ parentSessionId: null })).map((s) => s.id), ["parent"]);
    // A later recompute of the child keeps the link.
    t.write(t.line({ session: "child", kind: "turn.end" }));
    await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    assert.equal((await t.index.getSession("child"))?.parent?.sessionId, "parent");
  });

  it("applies the spool line's runId when the adapter doesn't set one", async () => {
    const t = setup();
    t.write(t.line({ session: "r", kind: "user.message", text: "x" }, { runId: "run_1" }));
    await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    assert.equal((await t.index.listEvents("r"))[0]!.runId, "run_1");
    assert.equal((await t.index.getSession("r"))?.runId, "run_1");
  });

  it("links a child named only by its parent's subagent event when the child arrives in a later run", async () => {
    const t = setup();
    const opts = { config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env };
    t.write(t.line({ session: "parent", kind: "subagent.start", subagentId: "a1", type: "explore", childSessionId: "late-child" }));
    await ingest(opts);
    assert.equal(await t.index.getSession("late-child"), undefined);
    t.write(t.line({ session: "late-child", kind: "user.message", text: "explore" }));
    await ingest(opts);
    const child = await t.index.getSession("late-child");
    assert.deepEqual([child?.parent?.sessionId, child?.parent?.subagentId, child?.parent?.type], ["parent", "a1", "explore"]);
  });

  it("passes the spool position to adapters, sets source and fills tool durations by toolUseId", async () => {
    const t = setup();
    seenSources.length = 0;
    t.write(
      t.line({ session: "d", kind: "tool.start", tool: "Bash", toolUseId: "tu1" }),
      t.line({ session: "d", kind: "tool.end", tool: "Bash", toolUseId: "tu1", ok: true }),
      t.line({ session: "d", kind: "tool.start", tool: "Read", toolUseId: "tu2" }),
    );
    const opts = { config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env };
    await ingest(opts);
    assert.deepEqual(seenSources.map((x) => x?.file), ["fake/2026-11-06.1.jsonl", "fake/2026-11-06.1.jsonl", "fake/2026-11-06.1.jsonl"]);
    assert.equal(seenSources[0]?.offset, 0);
    assert.ok((seenSources[1]?.offset ?? 0) > 0);
    // The end of tu2 arrives in a later run: its start is found in the index.
    t.write(t.line({ session: "d", kind: "tool.end", tool: "Read", toolUseId: "tu2", ok: true }));
    await ingest(opts);
    const ends = await t.index.listEvents("d", { kinds: ["tool.end"] });
    assert.deepEqual(ends.map((e) => [e.payload.toolUseId, e.durationMs, e.payload.durationMs]), [["tu1", 1000, 1000], ["tu2", 1000, 1000]]);
    assert.ok((await t.index.listEvents("d")).every((e) => e.source === "hook"));
    assert.equal((await t.index.getSession("d"))?.stats.latency?.toolMs !== undefined, true);
  });

  it("holds a cross-process lock so concurrent ingests never send a sink the same batch twice", async () => {
    const t = setup();
    for (let i = 0; i < 20; i++) t.write(t.line({ session: "s", kind: "notification", i }));
    const sink = new RecordingSink("remote", "full");
    t.config.sinks.push({ kind: "test", name: "remote", endpoint: "http://x", mode: "full" });
    const opts = { config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env, sinks: [sink] };
    const [a, b] = await Promise.all([ingest(opts), ingest(opts)]);
    assert.equal(a.lines + b.lines, 20);
    assert.equal(sink.events.length, 20, "no duplicates");
    // Held lock + no wait → busy; a dead holder's lock is stale and gets broken.
    const lockPath = join(t.env.CODING_SH_HOME, "spool", ".ingest.lock");
    const held = await acquireLock(lockPath);
    await assert.rejects(ingest({ ...opts, lock: { waitMs: 0 } }), LockBusyError);
    held.release();
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import("node:os")).hostname(), ts: 1 }));
    assert.equal(isStale(lockPath), true);
    t.write(t.line({ session: "s", kind: "notification", i: 99 }));
    assert.equal((await ingest({ ...opts, lock: { waitMs: 0 } })).lines, 1);
  });

  it("backfill skips prompts/replies a live path already captured and keeps the rest", async () => {
    const t = setup();
    t.write(
      t.line({ session: "b", kind: "user.message", text: "Fix   the bug" }),
      t.line({ session: "b", kind: "assistant.message", text: "Done." }),
    );
    await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    const ev = (id: string, kind: EventKind, text: string, ts: number): AgentEvent => ({ id, v: 0, sessionId: "b", ts, agent: "fake", kind, payload: { text } });
    const historian: Adapter = {
      ...fakeAdapter,
      id: "hist",
      async *backfill() {
        yield ev("t1", "user.message", "Fix the bug", 1);
        yield ev("t2", "assistant.message", "Done.", 2);
        yield ev("t3", "user.message", "And add a test", 3);
        yield { ...ev("t4", "user.message", "Older session prompt", 4), sessionId: "old" };
      },
    };
    const r = await backfill({ config: t.config, index: t.index, blobs: t.blobs, adapters: [historian], env: t.env });
    assert.deepEqual([r.events, r.duplicates, r.sessions, r.errors], [2, 2, 2, []]);
    const texts = (await t.index.listEvents("b")).map((e) => [e.payload.text, e.source]);
    assert.deepEqual(texts, [["And add a test", "transcript"], ["Fix   the bug", "hook"], ["Done.", "hook"]]);
    assert.equal((await t.index.getSession("old"))?.title, "Older session prompt");
    const again = await backfill({ config: t.config, index: t.index, blobs: t.blobs, adapters: [historian], env: t.env });
    assert.deepEqual([again.events, again.duplicates], [0, 2]);
  });

  it("stores one session.start and session.end across live and backfill, in either order", async () => {
    const base = 1_700_000_000_000;
    const ev = (sessionId: string, kind: EventKind, ts: number, payload: Record<string, unknown> = {}): AgentEvent => ({ id: `t-${sessionId}-${kind}-${ts}`, v: 0, sessionId, ts: base + ts, agent: "fake", kind, payload });
    const historian = (events: AgentEvent[]): Adapter => ({
      ...fakeAdapter,
      id: "hist",
      async *backfill() {
        yield* events;
      },
    });
    const kinds = async (index: MemoryIndexStore, id: string) => (await index.listEvents(id)).map((e) => `${e.kind}:${e.source}`);

    // Live first: the transcript's start and idle end are copies; a child's start that alone links its parent is kept.
    const t = setup();
    t.write(
      t.line({ session: "a", kind: "session.start" }, { ts: base + 1000 }),
      t.line({ session: "a", kind: "notification" }, { ts: base + 2000 }),
      t.line({ session: "a", kind: "session.end" }, { ts: base + 3000 }),
      t.line({ session: "c", kind: "session.start" }, { ts: base + 4000 }),
    );
    await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    const r = await backfill({ config: t.config, index: t.index, blobs: t.blobs, env: t.env, adapters: [historian([ev("a", "session.start", 1500), ev("a", "session.end", 2500), ev("c", "session.start", 4000, { parentSessionId: "a" })])] });
    assert.deepEqual([r.events, r.duplicates], [1, 2]);
    assert.deepEqual(await kinds(t.index, "a"), ["session.start:hook", "notification:hook", "session.end:hook"]);
    assert.deepEqual(await kinds(t.index, "c"), ["session.start:hook", "session.start:transcript"]);

    // Backfill first: the hook's start is a copy, and so is its end with nothing after the
    // transcript's idle end; a session resumed after that idle end keeps its live end.
    const u = setup();
    await backfill({ config: u.config, index: u.index, blobs: u.blobs, env: u.env, adapters: [historian(["b", "r"].flatMap((s) => [ev(s, "session.start", 500), ev(s, "notification", 600), ev(s, "session.end", 900)]))] });
    u.write(
      u.line({ session: "b", kind: "session.start" }, { ts: base + 1000 }),
      u.line({ session: "b", kind: "session.end" }, { ts: base + 60_000 }),
      u.line({ session: "r", kind: "session.start" }, { ts: base + 1000 }),
      u.line({ session: "r", kind: "notification" }, { ts: base + 120_000 }),
      u.line({ session: "r", kind: "session.end" }, { ts: base + 130_000 }),
    );
    await ingest({ config: u.config, index: u.index, blobs: u.blobs, adapters, env: u.env });
    assert.deepEqual(await kinds(u.index, "b"), ["session.start:transcript", "notification:transcript", "session.end:transcript"]);
    assert.deepEqual(await kinds(u.index, "r"), ["session.start:transcript", "notification:transcript", "session.end:transcript", "notification:hook", "session.end:hook"]);
    assert.equal((await u.index.getSession("r"))!.endedAt, base + 130_000);
  });

  it("pairs prompts with an untimed transcript's (no timestamps) by text and position, in either order", async () => {
    const base = 1_700_000_000_000;
    // Untimed transcript lines all carry the file's birth time + line number, and the time it was last written.
    const historian = (texts: string[], written: number): Adapter => ({
      ...fakeAdapter,
      id: "hist",
      async *backfill() {
        yield* texts.map((text, i): AgentEvent => ({ id: `t-untimed-${i}`, v: 0, sessionId: "a", ts: base + i, agent: "fake", kind: "user.message", payload: { text, untimed: base + written } }));
      },
    });
    const rows = async (index: MemoryIndexStore) => (await index.listEvents("a")).map((e) => `${e.payload.text}:${e.source}`).sort();
    const prompt = (t: ReturnType<typeof setup>, text: string, at: number) => t.line({ session: "a", kind: "user.message", text }, { ts: base + at });

    // Hooks first; the transcript also has a third "yes" the hooks missed.
    const t = setup();
    t.write(prompt(t, "yes", 60_000), prompt(t, "yes", 300_000), prompt(t, "hi", 360_000));
    await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    await backfill({ config: t.config, index: t.index, blobs: t.blobs, env: t.env, adapters: [historian(["yes", "hi", "yes", "yes"], 400_000)] });
    assert.deepEqual(await rows(t.index), ["hi:hook", "yes:hook", "yes:hook", "yes:transcript"]);

    // Transcript first (read at 150s): the live "yes" prompts before then are its two, across ingest runs; the third is new.
    const u = setup();
    await backfill({ config: u.config, index: u.index, blobs: u.blobs, env: u.env, adapters: [historian(["yes", "yes"], 150_000)] });
    u.write(prompt(u, "yes", 60_000));
    await ingest({ config: u.config, index: u.index, blobs: u.blobs, adapters, env: u.env });
    u.write(prompt(u, "yes", 120_000), prompt(u, "yes", 300_000));
    await ingest({ config: u.config, index: u.index, blobs: u.blobs, adapters, env: u.env });
    assert.deepEqual(await rows(u.index), ["yes:hook", "yes:transcript", "yes:transcript"]);
  });

  it("stores each compaction once across a PreCompact hook and the transcript, in either order", async () => {
    const base = 1_700_000_000_000;
    const min = 60_000;
    const ev = (ts: number): AgentEvent => ({ id: `t-compact-${ts}`, v: 0, sessionId: "a", ts: base + ts, agent: "fake", kind: "context.compact", payload: {} });
    const historian = (tss: number[]): Adapter => ({
      ...fakeAdapter,
      id: "hist",
      async *backfill() {
        yield* tss.map(ev);
      },
    });
    const sources = async (index: MemoryIndexStore) => (await index.listEvents("a")).map((e) => `${(e.ts - base) / 1000}:${e.source}`);

    // Hook first: the transcript records each compaction after its hook (90s, 20s later); one with no hook is kept.
    const t = setup();
    t.write(t.line({ session: "a", kind: "context.compact" }, { ts: base + 10_000 }), t.line({ session: "a", kind: "context.compact" }, { ts: base + 30 * min }));
    await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    const r = await backfill({ config: t.config, index: t.index, blobs: t.blobs, env: t.env, adapters: [historian([100_000, 30 * min + 20_000, 50 * min])] });
    assert.deepEqual([r.events, r.duplicates], [1, 2]);
    assert.deepEqual(await sources(t.index), ["10:hook", "1800:hook", "3000:transcript"]);

    // Transcript first: a hook pairs with the next transcript compaction within the window, once.
    const u = setup();
    await backfill({ config: u.config, index: u.index, blobs: u.blobs, env: u.env, adapters: [historian([100_000, 40 * min])] });
    u.write(
      u.line({ session: "a", kind: "context.compact" }, { ts: base + 30_000 }),
      u.line({ session: "a", kind: "context.compact" }, { ts: base + 60_000 }),
      u.line({ session: "a", kind: "context.compact" }, { ts: base + 20 * min }),
    );
    await ingest({ config: u.config, index: u.index, blobs: u.blobs, adapters, env: u.env });
    assert.deepEqual(await sources(u.index), ["60:hook", "100:transcript", "1200:hook", "2400:transcript"]);
  });

  it("does nothing when there is no spool", async () => {
    const t = setup();
    rmSync(join(t.env.CODING_SH_HOME, "spool"), { recursive: true });
    const r = await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    assert.deepEqual(r, { lines: 0, events: 0, sessions: 0, excluded: 0, errors: [], sinks: [] });
  });

  it("re-runs for a session that ended while it held the lock (no lost wakeup)", async () => {
    const t = setup();
    const dir = join(t.env.CODING_SH_HOME, "spool", "fake");
    const later = join(dir, "2026-11-06.2.jsonl");
    // Session B ends while this ingest is busy: its hook appends a new file, then kicks.
    hooks.midRun = () => {
      appendFileSync(later, t.line({ session: "B", kind: "turn.end" }, { pid: 2 }));
      assert.equal(kickIngest("Stop", t.env, () => assert.fail("must not spawn while the lock is held")), undefined);
    };
    t.write(t.line({ session: "A", kind: "turn.end", hook: "midRun" }));
    const r = await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
    delete hooks.midRun;
    assert.equal(r.lines, 2);
    assert.ok(await t.index.getSession("B"), "B ingested by the same call");
    assert.equal(await t.index.getCursor("fake/2026-11-06.2.jsonl"), statSync(later).size);
    assert.equal(existsSync(join(t.env.CODING_SH_HOME, "spool", ".ingest.pending")), false, "marker consumed");
  });

  it("stops before writing a cursor or sending to a sink once its lock was broken by a peer", async () => {
    const t = setup();
    const lockPath = join(t.env.CODING_SH_HOME, "spool", ".ingest.lock");
    const sink = new RecordingSink("remote", "full");
    t.config.sinks.push({ kind: "test", name: "remote", endpoint: "http://x", mode: "full" });
    // We stalled past staleMs; a peer broke our lock and holds its own now.
    hooks.steal = () => writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, host: (process.getBuiltinModule("node:os") as typeof import("node:os")).hostname(), ts: Date.now(), nonce: "peer" }));
    t.write(t.line({ session: "s", kind: "notification", hook: "steal" }));
    await assert.rejects(ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env, sinks: [sink] }), LockLostError);
    delete hooks.steal;
    assert.equal(await t.index.getCursor("fake/2026-11-06.1.jsonl"), 0, "no cursor committed");
    assert.equal(await t.index.getCursor(sinkCursorKey("remote", "fake/2026-11-06.1.jsonl")), 0);
    assert.equal(sink.events.length, 0, "nothing sent");
    rmSync(lockPath);
  });

  it("fills a tool.end's duration when its tool.start is in a file read after it", async () => {
    for (const [startPid, endPid] of [[9999, 10000], [99990, 112]] as const) {
      const t = setup();
      const dir = join(t.env.CODING_SH_HOME, "spool", "fake");
      const startFile = join(dir, `2026-11-06.${startPid}.jsonl`);
      const endFile = join(dir, `2026-11-06.${endPid}.jsonl`);
      const ts = 1_700_000_000_000;
      writeFileSync(startFile, JSON.stringify({ v: 0, agent: "fake", event: "PreToolUse", ts, pid: startPid, cwd: t.root, raw: { session: "d", kind: "tool.start", toolUseId: "tu1", tool: "Bash" } }) + "\n");
      writeFileSync(endFile, JSON.stringify({ v: 0, agent: "fake", event: "PostToolUse", ts: ts + 1234, pid: endPid, cwd: t.root, raw: { session: "d", kind: "tool.end", toolUseId: "tu1", tool: "Bash" } }) + "\n");
      // Same mtime: only the name breaks the tie, and it puts the end first.
      const m = new Date(ts);
      for (const f of [startFile, endFile]) utimesSync(f, m, m);
      await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env });
      const [end] = await t.index.listEvents("d", { kinds: ["tool.end"] });
      assert.deepEqual([end?.durationMs, end?.payload.durationMs], [1234, 1234], `start pid ${startPid}, end pid ${endPid}`);
    }
  });

  it("re-sends a recreated file to a sink whose cursor is past its end", async () => {
    const t = setup();
    const sink = new RecordingSink("remote", "full");
    t.config.sinks.push({ kind: "test", name: "remote", endpoint: "http://x", mode: "full" });
    t.write(t.line({ session: "s", kind: "notification" }));
    const src = "fake/2026-11-06.1.jsonl";
    // Left over from a longer file that was deleted (gc) before this one took its path.
    await t.index.setCursor(src, 10_000);
    await t.index.setCursor(sinkCursorKey("remote", src), 10_000);
    const r = await ingest({ config: t.config, index: t.index, blobs: t.blobs, adapters, env: t.env, sinks: [sink] });
    assert.equal(r.lines, 1);
    assert.equal(sink.events.length, 1, "the sink gets the new content");
    assert.equal(await t.index.getCursor(sinkCursorKey("remote", src)), statSync(t.file).size);
  });
});
