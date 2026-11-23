// T3 Code's store read where it is while T3 Code writes it (from another process, in WAL mode), and
// from a copy in the temp directory when it can't be; a copy is made only when there is room for it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SQLITE_COPY_PREFIX } from "../../src/adapters/_shared/sqlite-copies.ts";
import type { FreeSpace } from "../../src/adapters/more/_util.ts";
import { backfillT3 } from "../../src/adapters/t3code.ts";
import type { BackfillOpts } from "../../src/core/types.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { collect, FIXTURES, testCtx, tmpEnv, type TmpEnv, writeFile } from "./_helpers.ts";
import { startWriter, type Writer } from "./_sqlite-writer.ts";

const CODEX_ID = "0193aaaa-1111-7222-8333-444455556666";
const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
const ROLLOUT = `sessions/2026/11/01/rollout-2026-11-01T10-00-00-${CODEX_ID}.jsonl`;

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

const T = (min: number, sec = 0) => `2026-11-01T10:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;
const J = (o: unknown) => JSON.stringify(o);

function thread(db: DatabaseSync, id: string, o: { provider: string; title: string; created: string; deleted?: string; payload?: Record<string, unknown> }) {
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, 'proj-1', ?, ?, 'full-access', 'default', NULL, ?, ?, NULL, ?, ?, NULL)").run(
    id, o.title, o.provider, o.created, o.created, o.deleted ?? null,
    J({ id, projectId: "proj-1", title: o.title, modelSelection: { instanceId: o.provider, model: "gpt-5.5" }, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, historyOrigin: "native", ...o.payload }),
  );
}

function providerThread(db: DatabaseSync, id: string, threadId: string, driver: string, nativeId: string, ordinal: number, extra: Record<string, unknown> = {}) {
  db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, 'node-1', ?, NULL, 'idle', ?, ?, ?, ?, ?, NULL)").run(
    id, threadId, driver, ordinal, ordinal, T(30), J({ driver, appThreadId: threadId, nativeThreadRef: { driver, nativeId, strength: "strong" }, nativeMetadata: { modelSelection: { model: driver === "codex" ? "gpt-5.5" : `${driver}-model` } }, ...extra }), driver,
  );
}

const project = (db: DatabaseSync) => db.prepare("INSERT INTO projection_projects VALUES ('proj-1', 'demo', '/work/demo', '[]', ?, ?, NULL, NULL)").run(T(0), T(0));

const addRun = (db: DatabaseSync, id: string, threadId: string, ordinal: number, provider: string, pt: string, at: string) =>
  db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, '{}', NULL)").run(id, threadId, ordinal, provider, pt, at, at);

const message = (db: DatabaseSync, id: string, threadId: string, runId: string | null, role: string, at: string, text: string) =>
  db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, 'node-1', ?, 0, ?, ?, ?)").run(id, threadId, runId, role, at, at, J({ text }));

/** A shell call T3 Code recorded as a turn item. */
const shellItem = (db: DatabaseSync, id: string, threadId: string, runId: string, pt: string, ordinal: number, at: string) =>
  db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, 'node-1', ?, NULL, NULL, ?, 'command_execution', 'completed', ?, ?)").run(
    id, threadId, runId, pt, ordinal, at, J({ id, status: "completed", title: "npm test", input: "npm test", output: "2 passing", exitCode: 0, startedAt: at, completedAt: at }),
  );

const THREADS = ["thr-a", "thr-b", "thr-noise"];

/** T3 Code's v2 store with three Grok threads, each with its provider thread, a run and a first prompt; closed, in rollback-journal mode unless `wal`. */
function buildStore(path: string, wal = false): void {
  const db = new DatabaseSync(path);
  try {
    if (wal) db.exec("PRAGMA journal_mode = WAL");
    db.exec(V2_SCHEMA);
    project(db);
    THREADS.forEach((id, i) => {
      thread(db, id, { provider: "grok", title: `Thread ${id}`, created: T(i) });
      providerThread(db, `pt-${id}`, id, "grok", `grok-${id}`, 1);
      addRun(db, `run-${id}`, id, 1, "grok", `pt-${id}`, T(i));
      message(db, `${id}-m1`, id, `run-${id}`, "user", T(i, 1), `First prompt in ${id}`);
    });
  } finally {
    db.close();
  }
}

/** T3 Code's own connection, in this process: WAL mode, with -wal and -shm made by a first read. */
function openAsT3(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.prepare("SELECT count(*) FROM orchestration_v2_projection_threads").get();
  assert.ok(existsSync(`${path}-wal`) && existsSync(`${path}-shm`), "T3 Code has the store open in WAL mode");
  return db;
}

/** One message a commit in thr-noise, as T3 Code writes while an agent runs. */
const NOISE = "INSERT INTO orchestration_v2_projection_messages VALUES ('noise-' || $n, 'thr-noise', NULL, 'node-1', 'assistant', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), json_object('text', 'noise ' || $n))";

const texts = (events: AgentEvent[], sessionId: string) =>
  events.filter((e) => e.sessionId === sessionId && (e.kind === "user.message" || e.kind === "assistant.message")).map((e) => e.payload.text);

/** Copy the Codex/Claude fixture transcripts into HOME as the sessions T3 ran. */
function nativeTranscripts(home: string, originator = "T3 Code") {
  const rollout = readFileSync(join(FIXTURES, "codex", "home", ROLLOUT), "utf8").replace('"originator": "codex_exec"', `"originator": ${J(originator)}`);
  writeFile(join(home, ".codex", ROLLOUT), rollout);
  const claude = join(home, ".claude", "projects", "-work-demo", `${CLAUDE_ID}.jsonl`);
  writeFile(claude, readFileSync(join(FIXTURES, "claude-code", "config", "projects", "-work-demo", `${CLAUDE_ID}.jsonl`), "utf8"));
  return { claude };
}

/** Indexes on thread_id, which a store read a thread at a time needs (T3 Code's own indexes are not recorded here). */
const THREAD_INDEXES = `
CREATE INDEX messages_by_thread ON orchestration_v2_projection_messages (thread_id, created_at);
CREATE INDEX turn_items_by_thread ON orchestration_v2_projection_turn_items (thread_id, ordinal);
CREATE INDEX provider_turns_by_thread ON orchestration_v2_projection_provider_turns (thread_id, provider_thread_id, ordinal);
CREATE INDEX runtime_requests_by_thread ON orchestration_v2_projection_runtime_requests (thread_id, created_at);
`;

const at = (ms: number) => new Date(Date.UTC(2026, 10, 1, 10) + ms).toISOString();
const filler = (n: number) => "The tests pass after the fix to the parser. ".repeat(Math.ceil(n / 44)).slice(0, n);

/**
 * A store of realistic shape: 200 threads of 60 rows (20 messages, 30 shell calls, 10 provider turns)
 * and one thread of 4,000, with messages and shell output of 1 to 4 kB, written a row per thread in
 * turn so that a thread's rows are spread through the file, as a long-running app writes them.
 */
function buildLargeStore(path: string): { threads: number; rows: number; big: string; bigRows: number } {
  const SMALL = 200;
  const PER = 60;
  const BIG = 4000;
  const db = new DatabaseSync(path);
  try {
    db.exec(V2_SCHEMA + THREAD_INDEXES);
    db.exec("BEGIN");
    project(db);
    const ids = Array.from({ length: SMALL + 1 }, (_, i) => `thr-${String(i).padStart(3, "0")}`);
    ids.forEach((id, i) => {
      thread(db, id, { provider: "grok", title: `Thread ${i}`, created: at(i * 1000) });
      providerThread(db, `pt-${id}`, id, "grok", `grok-${id}`, 1);
      addRun(db, `run-${id}`, id, 1, "grok", `pt-${id}`, at(i * 1000));
    });
    const msg = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, 'node-1', ?, 0, ?, ?, ?)");
    const item = db.prepare("INSERT INTO orchestration_v2_projection_turn_items VALUES (?, ?, ?, 'node-1', ?, NULL, NULL, ?, 'command_execution', 'completed', ?, ?)");
    const turn = db.prepare("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, 'node-1', NULL, ?, 'completed', ?, ?, ?)");
    const usage = J({ status: "completed", turnTokenUsage: { usageScope: "main_agent", usageStatus: "complete", inputTokens: 1000, cachedInputTokens: 600, cacheCreationTokens: 100, outputTokens: 50, hasSubagents: false } });
    const row = (i: number, k: number) => {
      const id = ids[i]!;
      const ts = at(i * 1000 + k * 60_000);
      const size = 1000 + ((k * 7919 + i * 104_729) % 3000);
      if (k % 6 === 0 || k % 6 === 3) msg.run(`${id}-m${k}`, id, `run-${id}`, k % 2 ? "assistant" : "user", ts, ts, J({ text: filler(size) }));
      else if (k % 6 === 5) turn.run(`${id}-t${k}`, id, `pt-${id}`, k, ts, ts, usage);
      else item.run(`${id}-i${k}`, id, `run-${id}`, `pt-${id}`, k, ts, J({ id: `${id}-i${k}`, status: "completed", title: "npm test", input: "npm test", output: filler(size), exitCode: 0, startedAt: ts, completedAt: ts }));
    };
    let b = 0;
    for (let k = 0; k < PER; k++) {
      for (let i = 0; i < SMALL; i++) row(i, k);
      for (let j = 0; j < Math.ceil(BIG / PER) && b < BIG; j++) row(SMALL, b++);
    }
    db.exec("COMMIT");
    return { threads: ids.length, rows: SMALL * PER + BIG, big: ids[SMALL]!, bigRows: BIG };
  } finally {
    db.close();
  }
}

const TMP_KEYS = ["TMPDIR", "TEMP", "TMP"];
const t3Env = ["T3CODE_HOME", "T3CODE_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"];

describe("T3 Code's store, read while T3 Code writes it", () => {
  let env: TmpEnv;
  /** The temp directory a copy of the store goes to. */
  let tmp: string;
  let store: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    env = tmpEnv();
    for (const k of [...t3Env, ...TMP_KEYS]) (saved[k] = process.env[k]), delete process.env[k];
    tmp = join(env.root, "tmp");
    mkdirSync(tmp);
    for (const k of TMP_KEYS) process.env[k] = tmp;
    store = join(env.home, ".t3", "userdata", "statev2.sqlite");
    mkdirSync(dirname(store), { recursive: true });
  });
  afterEach(() => {
    for (const k of [...t3Env, ...TMP_KEYS]) if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    env.restore();
  });

  const copies = () => readdirSync(tmp).filter((n) => n.startsWith(SQLITE_COPY_PREFIX));
  const read = (opts: BackfillOpts = {}, room?: FreeSpace) => collect(backfillT3(testCtx().ctx, opts, process.env, room));
  /** Read every thread, calling `f` with each thread's id just before its rows are read (the store is open by then). */
  const perThread = (f: (threadId: string) => void): BackfillOpts => ({
    changed: async (file) => {
      if (!file.path.endsWith("#store")) f(file.path.slice(file.path.lastIndexOf("#") + 1));
      return true;
    },
  });

  it("reads the store where it is while T3 Code writes it: no copy, and T3 Code's commits never get SQLITE_BUSY", { timeout: 60_000 }, async () => {
    buildStore(store);
    let w: Writer | undefined;
    try {
      w = await startWriter(store, { setup: "PRAGMA wal_autocheckpoint = 10", step: NOISE, everyMs: 2 });
      assert.ok(existsSync(`${store}-wal`) && existsSync(`${store}-shm`), "T3 Code has the store open in WAL mode");
      const noise: number[] = [];
      const until = Date.now() + 20_000;
      while (noise.length < 10 || (noise.at(-1)! - noise[0]! < 5 && Date.now() < until)) {
        const during: number[] = [];
        const events = await read(perThread(() => during.push(copies().length)));
        assert.deepEqual(during, [0, 0, 0], "no copy while the threads are read");
        assert.deepEqual(texts(events, "grok-thr-a"), ["First prompt in thr-a"]);
        noise.push(texts(events, "grok-thr-noise").length);
      }
      assert.ok(noise.at(-1)! - noise[0]! >= 5, `later passes read what T3 Code committed since: ${noise.join(" ")}`);
      const r = await w.stop();
      assert.deepEqual([r.busy, r.errors], [0, []], "no commit of T3 Code's waited on a read");
      assert.ok(r.commits >= noise.at(-1)! - 1);
    } finally {
      await w?.kill();
    }
    assert.deepEqual(copies(), []);
  });

  it("reads a store in rollback-journal mode from a copy, and removes the copy", async () => {
    buildStore(store);
    const during: number[] = [];
    const events = await read(perThread(() => during.push(copies().length)));
    assert.deepEqual(during, [1, 1, 1], "one copy while the threads are read");
    assert.deepEqual(copies(), [], "removed after the pass");
    assert.deepEqual(readdirSync(dirname(store)), ["statev2.sqlite"]);
    assert.deepEqual(texts(events, "grok-thr-a"), ["First prompt in thr-a"]);
  });

  it("reads a store in WAL mode that no one has open (no -wal or -shm) from a copy, and makes no file next to it", async () => {
    buildStore(store, true);
    assert.deepEqual([...readFileSync(store).subarray(18, 20)], [2, 2], "in WAL mode");
    const bytes = readFileSync(store);
    const during: number[] = [];
    const listings: string[][] = [];
    const events = await read(
      perThread(() => {
        during.push(copies().length);
        listings.push(readdirSync(dirname(store)));
      }),
    );
    assert.deepEqual(during, [1, 1, 1], "read from a copy");
    assert.deepEqual(listings, [["statev2.sqlite"], ["statev2.sqlite"], ["statev2.sqlite"]], "no -wal or -shm made next to the store");
    assert.deepEqual(readdirSync(dirname(store)), ["statev2.sqlite"]);
    assert.ok(readFileSync(store).equals(bytes), "the store is not written");
    assert.deepEqual(copies(), []);
    assert.deepEqual(texts(events, "grok-thr-a"), ["First prompt in thr-a"]);
  });

  it("reads a store T3 Code holds in exclusive locking mode from a copy", { timeout: 60_000 }, async () => {
    buildStore(store);
    let w: Writer | undefined;
    try {
      // A first read in WAL mode makes -wal and -shm before T3 Code takes the store for itself.
      w = await startWriter(store, { setup: "SELECT count(*) FROM orchestration_v2_projection_threads", step: NOISE, everyMs: 0, exclusive: true });
      assert.ok(existsSync(`${store}-wal`) && existsSync(`${store}-shm`));
      const during: number[] = [];
      const locked = await read(perThread(() => during.push(copies().length)));
      assert.deepEqual(during, [1, 1, 1], "read from a copy");
      assert.deepEqual(copies(), []);
      assert.deepEqual(texts(locked, "grok-thr-noise").sort(), ["First prompt in thr-noise", "noise 1"]);
      assert.deepEqual(await w.stop(), { commits: 1, busy: 0, errors: [] });
      assert.deepEqual(locked, await read(), "what a read finds after T3 Code closes the store");
    } finally {
      await w?.kill();
    }
  });

  it("makes no copy without room for it in the temp directory, and says how much it needs", async () => {
    buildStore(store);
    const need = statSync(store).size;
    const kB = (n: number) => `${(n / 1e3).toFixed(1)} kB`;
    await assert.rejects(read({}, () => 0), {
      message: `T3 Code's store was not read: could not copy ${store} to ${tmp}: that needs ${kB(2 * need)} free (${kB(need)} for the copy and ${kB(need)} left over), and 0 B is free. When it can't be read in place, it is read from a copy in the temp directory (TMPDIR, or TEMP on Windows), which needs room for it`,
    });
    assert.deepEqual(readdirSync(tmp), [], "no copy, and no part of one");
  });

  it("needs no room in the temp directory for a store it reads where it is", async () => {
    buildStore(store);
    const db = openAsT3(store);
    try {
      message(db, "thr-a-m2", "thr-a", "run-thr-a", "assistant", T(0, 2), "Read with no room for a copy");
      const events = await read({}, () => 0);
      assert.deepEqual(texts(events, "grok-thr-a"), ["First prompt in thr-a", "Read with no room for a copy"]);
    } finally {
      db.close();
    }
    assert.deepEqual(readdirSync(tmp), []);
  });

  it("reads each thread in a snapshot of its own: a commit between two threads' reads shows in the later one", async () => {
    buildStore(store);
    const db = openAsT3(store);
    try {
      const events = await read(
        perThread((id) => {
          if (id === "thr-b") message(db, "thr-b-m2", "thr-b", "run-thr-b", "assistant", T(1, 2), "Committed after thr-a was read");
        }),
      );
      assert.deepEqual(texts(events, "grok-thr-b"), ["First prompt in thr-b", "Committed after thr-a was read"]);
    } finally {
      db.close();
    }
  });

  it("never reads half of a commit: one made while a thread is read shows whole in the next pass", async () => {
    buildStore(store);
    const db = openAsT3(store);
    const proto = StatementSync.prototype;
    const all = proto.all;
    let wrote = false;
    proto.all = function (this: StatementSync, ...args: any[]): any {
      const rows = Reflect.apply(all, this, args);
      // After thr-a's messages are read and before its turn items are, T3 Code commits a reply and the shell call it made, together.
      if (!wrote && this.sourceSQL.includes("FROM orchestration_v2_projection_messages WHERE thread_id") && args[0] === "thr-a") {
        wrote = true;
        db.exec("BEGIN IMMEDIATE");
        shellItem(db, "thr-a-it1", "thr-a", "run-thr-a", "pt-thr-a", 1, T(0, 2));
        message(db, "thr-a-m2", "thr-a", "run-thr-a", "assistant", T(0, 3), "Ran the tests");
        db.exec("COMMIT");
      }
      return rows;
    };
    try {
      const first = await read();
      assert.ok(wrote);
      assert.deepEqual(texts(first, "grok-thr-a"), ["First prompt in thr-a"]);
      assert.ok(!first.some((e) => e.payload.toolUseId === "thr-a-it1"), "the shell call comes in the next pass, with its reply");
      const second = await read();
      assert.deepEqual(texts(second, "grok-thr-a"), ["First prompt in thr-a", "Ran the tests"]);
      assert.equal(second.filter((e) => e.kind === "tool.end" && e.payload.toolUseId === "thr-a-it1").length, 1);
    } finally {
      proto.all = all;
      db.close();
    }
  });

  it("attributes a message to its run's provider thread when the run began after the threads were listed", async () => {
    buildStore(store);
    const db = openAsT3(store);
    try {
      // thr-a moved to Muse before the pass; its first Muse run starts during the pass.
      providerThread(db, "pt-muse", "thr-a", "muse", "provider-instance:muse_main:muse-thr-a", 2);
      const events = await read(
        perThread((id) => {
          if (id !== "thr-a") return;
          addRun(db, "run-muse", "thr-a", 2, "muse", "pt-muse", T(0, 5));
          message(db, "thr-a-m2", "thr-a", "run-muse", "user", T(0, 5), "Now with Muse");
        }),
      );
      assert.deepEqual(texts(events, "grok-thr-a"), ["First prompt in thr-a"]);
      assert.deepEqual(texts(events, "muse-thr-a"), ["Now with Muse"]);
    } finally {
      db.close();
    }
  });

  it("fails the pass when a thread's read finds the store locked or failing, and skips a thread whose rows it can't read", async () => {
    buildStore(store);
    const db = openAsT3(store);
    const proto = StatementSync.prototype;
    const all = proto.all;
    let fail: { thread: string; errcode: number; message: string } | undefined;
    proto.all = function (this: StatementSync, ...args: any[]): any {
      if (fail && args[0] === fail.thread && this.sourceSQL.includes("FROM orchestration_v2_projection_messages WHERE thread_id")) {
        throw Object.assign(new Error(fail.message), { code: "ERR_SQLITE_ERROR", errcode: fail.errcode });
      }
      return Reflect.apply(all, this, args);
    };
    try {
      fail = { thread: "thr-b", errcode: 5, message: "database is locked" };
      await assert.rejects(read(), { message: "T3 Code's store was not read: database is locked" });
      fail = { thread: "thr-b", errcode: 11, message: "database disk image is malformed" };
      await assert.rejects(read(), { message: "T3 Code's store was not read: database disk image is malformed" });
      fail = { thread: "thr-b", errcode: 1, message: "no such column: streaming" };
      const events = await read();
      assert.deepEqual(texts(events, "grok-thr-a"), ["First prompt in thr-a"]);
      assert.deepEqual(texts(events, "grok-thr-b"), []);
      assert.deepEqual(texts(events, "grok-thr-noise"), ["First prompt in thr-noise"]);
    } finally {
      proto.all = all;
      db.close();
    }
  });

  it("reads the same events where it is as from a copy, with Codex and Claude Code transcripts T3 Code ran", async () => {
    nativeTranscripts(env.home);
    const build = new DatabaseSync(store);
    build.exec(V2_SCHEMA);
    project(build);
    thread(build, "thr-codex", { provider: "codex", title: "Fix the failing test", created: T(0) });
    providerThread(build, "pt-codex", "thr-codex", "codex", CODEX_ID, 1);
    thread(build, "thr-claude", { provider: "claudeAgent", title: "Add sum", created: T(0) });
    providerThread(build, "pt-claude", "thr-claude", "claudeAgent", CLAUDE_ID, 1);
    thread(build, "thr-grok", { provider: "grok", title: "List files", created: T(1) });
    providerThread(build, "pt-grok", "thr-grok", "grok", "grok-session-1", 1);
    addRun(build, "run-g1", "thr-grok", 1, "grok", "pt-grok", T(2));
    message(build, "m1", "thr-grok", "run-g1", "user", T(2), "List files and run the tests");
    shellItem(build, "it-cmd", "thr-grok", "run-g1", "pt-grok", 1, T(2, 30));
    message(build, "m2", "thr-grok", "run-g1", "assistant", T(3), "Tests pass.");
    build.close();
    const db = openAsT3(store);
    let inPlace: AgentEvent[];
    try {
      const during: number[] = [];
      inPlace = await read(perThread(() => during.push(copies().length)));
      assert.deepEqual(during, [0, 0, 0], "read where it is");
    } finally {
      db.close();
    }
    assert.ok(!existsSync(`${store}-wal`), "T3 Code closed the store: the next read is from a copy");
    assert.deepEqual(inPlace, await read());
    assert.ok(inPlace.some((e) => e.sessionId === CODEX_ID && e.kind === "llm.call"), "the Codex rollout is read");
    assert.ok(inPlace.some((e) => e.sessionId === CLAUDE_ID && e.kind === "tool.start"), "the Claude Code transcript is read");
    assert.deepEqual(texts(inPlace, "grok-session-1"), ["List files and run the tests", "Tests pass."]);
  });

  it("reads a store of realistic size in short read transactions while T3 Code writes it", { timeout: 300_000 }, async (t) => {
    const big = buildLargeStore(store);
    const mb = (statSync(store).size / 1e6).toFixed(1);
    const dbProto = DatabaseSync.prototype;
    const stProto = StatementSync.prototype;
    const exec = dbProto.exec;
    const all = stProto.all;
    /** Each explicit read transaction (BEGIN to COMMIT or ROLLBACK): the thread read in it, or "" for the thread list. */
    const spans: { thread: string; ms: number }[] = [];
    /** Each activity count, a statement read outside those transactions. */
    const counts: number[] = [];
    let current = "";
    let begun: number | undefined;
    dbProto.exec = function (this: DatabaseSync, sql: string): void {
      if (sql === "BEGIN") {
        assert.equal(begun, undefined, "read transactions never nest");
        begun = performance.now();
      }
      Reflect.apply(exec, this, [sql]);
      if ((sql === "COMMIT" || sql === "ROLLBACK") && begun !== undefined) {
        spans.push({ thread: current, ms: performance.now() - begun });
        begun = undefined;
      }
    };
    stProto.all = function (this: StatementSync, ...args: any[]): any {
      const t0 = performance.now();
      const rows = Reflect.apply(all, this, args);
      if (this.sourceSQL.includes("GROUP BY thread_id")) counts.push(performance.now() - t0);
      return rows;
    };
    let w: Writer | undefined;
    try {
      w = await startWriter(store, { step: NOISE, everyMs: 2 });
      const t0 = performance.now();
      const events = await read(perThread((id) => (current = id)));
      const pass = performance.now() - t0;
      dbProto.exec = exec;
      stProto.all = all;
      const r = await w.stop();
      assert.deepEqual([r.busy, r.errors], [0, []], "no commit of T3 Code's waited on a read");
      assert.equal(spans.length, 1 + big.threads, "one transaction for the thread list and one a thread");
      assert.equal(spans[0]!.thread, "", "the thread list is read first");
      assert.equal(counts.length, 4);
      assert.equal(new Set(events.map((e) => e.sessionId)).size, big.threads);
      const reads = spans.slice(1);
      const longest = reads.reduce((a, b) => (b.ms > a.ms ? b : a));
      const median = reads.map((s) => s.ms).sort((a, b) => a - b)[reads.length >> 1]!;
      const f = (n: number) => n.toFixed(1);
      t.diagnostic(`store: ${big.threads} threads, ${big.rows} rows, ${mb} MB; pass ${f(pass)} ms; T3 Code's writer committed ${r.commits} times during it, never busy`);
      t.diagnostic(`thread list: ${f(spans[0]!.ms)} ms; a thread's read: median ${f(median)} ms, longest ${f(longest.ms)} ms (${longest.thread}); the ${big.bigRows}-row thread: ${f(reads.find((s) => s.thread === big.big)!.ms)} ms`);
      t.diagnostic(`activity counts, each a read of its own: ${counts.map(f).join(", ")} ms`);
    } finally {
      dbProto.exec = exec;
      stProto.all = all;
      await w?.kill();
    }
  });
});
