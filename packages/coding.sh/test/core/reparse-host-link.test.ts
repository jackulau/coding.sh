// A Claude Code session T3 Code ran, stored before its host link: an older --since import cut T3's
// own rows (the host-link notification) off and recorded the thread as read, so ingest skips the
// thread from then on. The session stayed claude-code, and a t3code parse bump made nothing stale.
// The re-parse after a host's parse changes reads the host's store and links such sessions again.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { t3code } from "../../src/adapters/t3code.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { backfill } from "../../src/core/ingest.ts";
import { REPARSE_CURSOR, parseStamp, relinkCursor, reparse, reparseDue } from "../../src/core/reparse.ts";
import type { Adapter } from "../../src/core/types.ts";
import { HOST_AGENT_PROMPT } from "../../src/core/waiting.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { T3_AGENT } from "../../src/spool/host.ts";
import { MemoryBlobStore, MemoryIndexStore } from "../../src/store/memory.ts";
import { FIXTURES, tmpEnv, type TmpEnv, writeFile } from "../adapters/_helpers.ts";

const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
const T = (min: number) => `2026-11-01T10:${String(min).padStart(2, "0")}:00.000Z`;
const J = (o: unknown) => JSON.stringify(o);

// The v2 tables the T3 adapter reads, with the columns of a real store (as in test/adapters/t3code.test.ts).
const V2_SCHEMA = `
CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, scripts_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, default_model_selection_json TEXT);
CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, active_provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, provider TEXT NOT NULL, provider_thread_id TEXT, status TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT, provider TEXT NOT NULL, provider_session_id TEXT, status TEXT NOT NULL, first_run_ordinal INTEGER, last_run_ordinal INTEGER, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL, node_id TEXT NOT NULL, run_attempt_id TEXT, ordinal INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT, completed_at TEXT, payload_json TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, role TEXT NOT NULL, streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_turn_items (turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, node_id TEXT, provider_thread_id TEXT, provider_turn_id TEXT, parent_item_id TEXT, ordinal INTEGER NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_runtime_requests (runtime_request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, node_id TEXT NOT NULL, provider_turn_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, payload_json TEXT NOT NULL);
`;

/** A T3 store with one Claude thread whose provider thread is the fixture transcript's session. */
function t3Store(home: string): void {
  const dir = join(home, ".t3", "userdata");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "statev2.sqlite"));
  db.exec(V2_SCHEMA);
  db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES ('thr-claude', 'proj-1', 'Add sum', 'claudeAgent', 'full-access', 'default', NULL, ?, ?, NULL, NULL, ?, NULL)").run(
    T(0), T(0), J({ id: "thr-claude", projectId: "proj-1", title: "Add sum", lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thr-claude" }, historyOrigin: "native" }),
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt-claude', 'thr-claude', 'node-1', 'claudeAgent', NULL, 'idle', 1, 1, ?, ?, 'claudeAgent', NULL)").run(
    T(30), J({ driver: "claudeAgent", appThreadId: "thr-claude", nativeThreadRef: { driver: "claudeAgent", nativeId: CLAUDE_ID, strength: "strong" } }),
  );
  db.close();
}

/** The older t3code parse: a --since import that cut the thread's own rows (its host link) off. */
const olderT3 = (parseVersion: number): Adapter => ({
  ...t3code,
  parseVersion,
  async *backfill(ctx, opts) {
    for await (const e of t3code.backfill!(ctx, opts)) if (e.agent !== T3_AGENT) yield e;
  },
});

const T3_ENV = ["T3CODE_HOME", "T3CODE_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"];

describe("a Claude Code session T3 Code ran, stored before its host link", () => {
  let env: TmpEnv;
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const k of T3_ENV) (saved[k] = process.env[k]), delete process.env[k];
  });
  after(() => {
    for (const k of T3_ENV) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
  beforeEach(() => {
    env = tmpEnv();
    const src = join(FIXTURES, "claude-code", "config", "projects", "-work-demo", `${CLAUDE_ID}.jsonl`);
    writeFile(join(env.home, ".claude", "projects", "-work-demo", `${CLAUDE_ID}.jsonl`), readFileSync(src, "utf8"));
    t3Store(env.home);
  });
  afterEach(() => env.restore());

  const setup = async (older: Adapter) => {
    const cenv = { ...process.env };
    const o = { config: defaultConfig(cenv), index: new MemoryIndexStore(), blobs: new MemoryBlobStore(), env: cenv };
    const r = await backfill({ ...o, adapters: [claudeCode, older] });
    assert.deepEqual(r.errors, []);
    const s = await o.index.getSession(CLAUDE_ID);
    assert.equal(s?.agent, "claude-code", "the older parse stored the session without its host link");
    return o;
  };

  /** What `coding.sh ingest` runs after an upgrade: the import, then the re-parse when it is due. */
  const ingestAfterUpgrade = async (o: Awaited<ReturnType<typeof setup>>) => {
    const r = await backfill({ ...o, adapters: [claudeCode, t3code] });
    assert.deepEqual(r.errors, []);
    assert.equal(r.events, 0, "the thread is unchanged, so the import reads nothing");
    const adapters = new Map<string, Adapter>([[claudeCode.id, claudeCode], [t3code.id, t3code]]);
    assert.equal(await reparseDue(o.index, adapters), true, "a re-parse is due");
    const rp = await reparse({ ...o, adapters, runLock: false, ingestLock: false });
    assert.deepEqual(rp.errors, []);
    return { adapters, rp };
  };

  /** The event ids a fresh import of both stores gives the session. */
  const freshIds = async () => {
    const cenv = { ...process.env };
    const index = new MemoryIndexStore();
    await backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), env: cenv, adapters: [claudeCode, t3code] });
    return (await index.listEvents(CLAUDE_ID)).map((e) => e.id).sort();
  };

  const assertLinked = async (o: Awaited<ReturnType<typeof setup>>) => {
    const s = await o.index.getSession(CLAUDE_ID);
    assert.equal(s?.agent, "claude-code");
    assert.equal(s?.host, "t3code");
    assert.equal(s?.provider, "claude-code");
    assert.equal(s?.title, "Add sum", "the T3 thread titles the session again");
    const ids = (await o.index.listEvents(CLAUDE_ID)).map((e) => e.id).sort();
    assert.equal(new Set(ids).size, ids.length, "no row twice");
    assert.deepEqual(ids, await freshIds(), "the same rows a fresh import stores");
  };

  it("regains the link on the re-parse after a t3code parse bump", async () => {
    const o = await setup(olderT3(t3code.parseVersion! - 1));
    const old = new Map<string, Adapter>([[claudeCode.id, claudeCode], [t3code.id, olderT3(t3code.parseVersion! - 1)]]);
    // The older build's ingest stamped the store with its parsers.
    assert.equal(await reparseDue(o.index, old), false);
    const { adapters, rp } = await ingestAfterUpgrade(o);
    assert.equal(rp.relinked, 1);
    await assertLinked(o);
    assert.equal(await reparseDue(o.index, adapters), false, "nothing is due once the host's links were checked");
    const again = await reparse({ ...o, adapters, runLock: false, ingestLock: false });
    assert.equal(again.relinked, 0);
    assert.equal(again.inserted, 0, "a second run writes nothing");
  });

  it("regains the link once on a store from a build before host links were checked", async () => {
    const o = await setup(olderT3(t3code.parseVersion!));
    const adapters = new Map<string, Adapter>([[claudeCode.id, claudeCode], [t3code.id, t3code]]);
    // An older build's ingest stamped the same parsers, and kept no host cursor.
    await o.index.setCursor(REPARSE_CURSOR, parseStamp(adapters));
    assert.equal(await o.index.getCursor(relinkCursor(T3_AGENT)), 0);
    const { rp } = await ingestAfterUpgrade(o);
    assert.equal(rp.relinked, 1);
    await assertLinked(o);
    assert.equal(await o.index.getCursor(relinkCursor(T3_AGENT)), t3code.parseVersion);
  });

  it("a new store needs no host pass: its import linked every session", async () => {
    const cenv = { ...process.env };
    const index = new MemoryIndexStore();
    await backfill({ config: defaultConfig(cenv), index, blobs: new MemoryBlobStore(), env: cenv, adapters: [claudeCode, t3code] });
    assert.equal((await index.getSession(CLAUDE_ID))?.host, "t3code");
    const adapters = new Map<string, Adapter>([[claudeCode.id, claudeCode], [t3code.id, t3code]]);
    assert.equal(await reparseDue(index, adapters), false);
    assert.equal(await index.getCursor(relinkCursor(T3_AGENT)), t3code.parseVersion);
  });

  it("ingest --rebuild links it too", async () => {
    const o = await setup(olderT3(t3code.parseVersion!));
    const adapters = new Map<string, Adapter>([[claudeCode.id, claudeCode], [t3code.id, t3code]]);
    await reparseDue(o.index, adapters);
    const rp = await reparse({ ...o, adapters, all: true, runLock: false, ingestLock: false });
    assert.deepEqual(rp.errors, []);
    await assertLinked(o);
  });
});

const GROK_ID = "grok-flaky";

/**
 * The store of t3Store, with who made each prompt: the person started the Claude thread, and another thread sent
 * its "Thanks!". A Grok thread T3 keeps no transcript of (its rows come from the store): the person's prompt, then
 * another thread's, then the person's again, which a turn still runs.
 */
function t3StoreWithPrompts(home: string): void {
  t3Store(home);
  const db = new DatabaseSync(join(home, ".t3", "userdata", "statev2.sqlite"));
  const msg = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, NULL, 'node-1', ?, 0, ?, ?, ?)");
  const at = (min: number, sec = 0) => `2026-11-01T10:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;
  msg.run("mc1", "thr-claude", "user", at(0), at(0), J({ text: "Add a sum function in sum.js and run the tests", createdBy: "user" }));
  msg.run("mc2", "thr-claude", "user", at(0, 30), at(0, 30), J({ text: "Thanks!", senderThreadId: "thr-other" }));
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES ('thr-grok', 'proj-1', 'Fix the flaky test', 'grok', 'full-access', 'default', NULL, ?, ?, NULL, NULL, ?, NULL)").run(
    at(1), at(1), J({ id: "thr-grok", projectId: "proj-1", title: "Fix the flaky test", lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thr-grok" }, historyOrigin: "native" }),
  );
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES ('pt-grok', 'thr-grok', 'node-1', 'grok', NULL, 'idle', 1, 1, ?, ?, 'grok', NULL)").run(
    T(30), J({ driver: "grok", appThreadId: "thr-grok", nativeThreadRef: { driver: "grok", nativeId: GROK_ID, strength: "strong" } }),
  );
  msg.run("mg1", "thr-grok", "user", at(1), at(1), J({ text: "Fix the flaky test", createdBy: "user" }));
  msg.run("mg2", "thr-grok", "assistant", at(2), at(2), J({ text: "Fixed: the test waited on a timer." }));
  msg.run("mg3", "thr-grok", "user", at(3), at(3), J({ text: "Review the diff on the other branch", senderThreadId: "thr-other" }));
  msg.run("mg4", "thr-grok", "assistant", at(4), at(4), J({ text: "The diff looks right." }));
  msg.run("mg5", "thr-grok", "user", at(6), at(6), J({ text: "Now run the whole suite", createdBy: "user" }));
  const turn = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, 'thr-grok', 'pt-grok', 'node-1', NULL, ?, 'completed', ?, ?, ?)");
  turn.run("tg1", 1, at(1), at(2), J({ status: "completed" }));
  turn.run("tg2", 2, at(3), at(4), J({ status: "completed" }));
  db.close();
}

/** The t3code parse before 17: no host-link launch, no from on a store prompt, no marker before a transcript prompt. */
const beforeFrom: Adapter = {
  ...t3code,
  parseVersion: t3code.parseVersion! - 1,
  async *backfill(ctx, opts) {
    for await (const e of t3code.backfill!(ctx, opts)) {
      if (e.agent !== T3_AGENT) yield e;
      else if (e.payload.type !== HOST_AGENT_PROMPT) {
        const { launch: _launch, from: _from, ...payload } = e.payload;
        yield { ...e, payload };
      }
    }
  },
};

/** Rows as stored, compared whatever their key order or undefined fields. */
const plain = (rows: AgentEvent[]) => rows.map((e) => JSON.parse(J(e)) as AgentEvent).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

describe("sessions T3 Code ran, stored by its parse before prompts said who made them", () => {
  // Parse 17 gives a thread a person started an interactive launch (its host link's launch) and an agent's prompt
  // from: "agent", in rows with the ids parse 16 gave them. A Claude Code or Grok session T3 ran is not stale for a
  // t3code bump: the re-parse reaches it only through the host's pass over its links.
  let env: TmpEnv;
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const k of T3_ENV) (saved[k] = process.env[k]), delete process.env[k];
  });
  after(() => {
    for (const k of T3_ENV) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
  beforeEach(() => {
    env = tmpEnv();
    const src = join(FIXTURES, "claude-code", "config", "projects", "-work-demo", `${CLAUDE_ID}.jsonl`);
    writeFile(join(env.home, ".claude", "projects", "-work-demo", `${CLAUDE_ID}.jsonl`), readFileSync(src, "utf8"));
    t3StoreWithPrompts(env.home);
  });
  afterEach(() => env.restore());

  it("the re-parse after the bump replaces the host's rows they stored: the launch, the agent's prompts, the waits", async () => {
    const cenv = { ...process.env };
    const o = { config: defaultConfig(cenv), index: new MemoryIndexStore(), blobs: new MemoryBlobStore(), env: cenv };
    assert.deepEqual((await backfill({ ...o, adapters: [claudeCode, beforeFrom] })).errors, []);
    assert.equal(await reparseDue(o.index, new Map<string, Adapter>([[claudeCode.id, claudeCode], [t3code.id, beforeFrom]])), false);
    const link = async (id: string) => (await o.index.listEvents(id)).find((e) => e.payload.type === "host-link");
    const prompts = async () => (await o.index.listEvents(GROK_ID, { kinds: ["user.message"] })).map((e) => [e.payload.text, e.payload.from]);
    // The older parse's rows: hosted by T3, no launch from the host, no prompt an agent's.
    assert.equal((await o.index.getSession(CLAUDE_ID))?.host, "t3code");
    assert.equal((await link(CLAUDE_ID))?.payload.launch, undefined);
    const stored = await o.index.getSession(GROK_ID);
    assert.equal(stored?.agent, "grok");
    assert.equal(stored?.host, "t3code");
    assert.equal(stored?.stats.launch, undefined);
    assert.equal(stored?.stats.waits, undefined);
    assert.deepEqual((await prompts()).map(([, from]) => from), [undefined, undefined, undefined]);

    // The upgrade: the threads are unchanged, so the import reads nothing; the host's pass over its links is due.
    const adapters = new Map<string, Adapter>([[claudeCode.id, claudeCode], [t3code.id, t3code]]);
    assert.equal((await backfill({ ...o, adapters: [claudeCode, t3code] })).events, 0);
    assert.equal(await reparseDue(o.index, adapters), true);
    const rp = await reparse({ ...o, adapters, runLock: false, ingestLock: false });
    assert.deepEqual(rp.errors, []);

    assert.equal((await link(CLAUDE_ID))?.payload.launch, "interactive");
    assert.deepEqual(await prompts(), [
      ["Fix the flaky test", undefined],
      ["Review the diff on the other branch", "agent"],
      ["Now run the whole suite", undefined],
    ]);
    const s = await o.index.getSession(GROK_ID);
    assert.equal(s?.stats.launch, "interactive");
    // 10:02 to 10:03: the other thread's prompt ended it. 10:04 to 10:06: the person's.
    assert.deepEqual(s?.stats.waits, { count: 1, ms: 120_000, byKind: { turn: { count: 1, ms: 120_000 } }, agent: { count: 1, ms: 60_000 } });
    // The rows and stats a fresh import of both stores gives (the Claude thread's marker before its "Thanks!" too).
    const cenvFresh = { ...process.env };
    const fresh = new MemoryIndexStore();
    await backfill({ config: defaultConfig(cenvFresh), index: fresh, blobs: new MemoryBlobStore(), env: cenvFresh, adapters: [claudeCode, t3code] });
    assert.ok((await fresh.listEvents(CLAUDE_ID)).some((e) => e.payload.type === HOST_AGENT_PROMPT), "the fresh import marks the agent's prompt");
    for (const id of [CLAUDE_ID, GROK_ID]) {
      assert.deepEqual(plain(await o.index.listEvents(id)), plain(await fresh.listEvents(id)), id);
      assert.deepEqual(JSON.parse(J((await o.index.getSession(id))?.stats)), JSON.parse(J((await fresh.getSession(id))?.stats)), id);
    }
    assert.equal(rp.relinked, 2);

    // The host's pass again (its cursor set back): nothing left to replace.
    await o.index.setCursor(relinkCursor(T3_AGENT), beforeFrom.parseVersion!);
    const again = await reparse({ ...o, adapters, runLock: false, ingestLock: false });
    assert.deepEqual(again.errors, []);
    assert.deepEqual([again.relinked, again.removed, again.inserted], [0, 0, 0]);
  });
});
