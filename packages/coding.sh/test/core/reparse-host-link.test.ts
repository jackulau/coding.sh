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
