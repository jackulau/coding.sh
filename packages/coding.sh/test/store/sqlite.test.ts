import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import { loadSqlite, MIGRATIONS, searchIndexOk, SQLITE_SCHEMA_VERSION, SqliteIndexStore, WAL_SIZE_LIMIT } from "../../src/store/sqlite.ts";
import { median, timeMs } from "../helpers-timing.ts";

const root = mkdtempSync(join(tmpdir(), "csh-sqlite-"));
after(() => rmSync(root, { recursive: true, force: true }));

function events(n: number, session = "perf"): AgentEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${session}-${i}`,
    v: 0,
    sessionId: session,
    ts: 1_700_000_000_000 + i,
    agent: "claude-code",
    kind: i % 3 === 0 ? "assistant.message" : i % 3 === 1 ? "tool.start" : "tool.end",
    payload: i % 3 === 0 ? { text: `message number ${i} about refactoring` } : { tool: "Bash", toolUseId: `t${i}`, ok: i % 2 === 0 },
    usage: { inputTokens: i },
  }));
}

describe("SqliteIndexStore writer lock fencing (STO-8)", () => {
  it("assertHeld passes while held and throws once another process took the lease over or after release", async () => {
    const db = join(root, "fence.db");
    const s = await SqliteIndexStore.open(db);
    const lock = await s.acquireWriterLock({ waitMs: 0 });
    assert.ok(lock && typeof lock.assertHeld === "function", "writer lock exposes a fence");
    lock.assertHeld!();
    // A same-host standby broke our stale lease (we stalled past staleMs) and is alive holding it.
    writeFileSync(`${db}.writer.lock`, JSON.stringify({ pid: process.ppid, host: hostname(), ts: Date.now(), nonce: "peer" }));
    assert.throws(() => lock.assertHeld!(), { name: "LockLostError" });
    await lock.release();
    assert.throws(() => lock.assertHeld!(), /released/);
    await s.close();
  });
});

describe("SqliteIndexStore write-ahead log (RT-5)", () => {
  const walSize = (db: string) => (existsSync(`${db}-wal`) ? statSync(`${db}-wal`).size : 0);

  it("close() empties the WAL even while another connection keeps the database open", async () => {
    const db = join(root, "wal-close.db");
    const s = await SqliteIndexStore.open(db);
    const reader = await SqliteIndexStore.open(db, { readOnly: true });
    await reader.listSessions({ limit: 1 });
    for (let i = 0; i < 4; i++) await s.putEvents(events(5_000, `wal-${i}`));
    assert.ok(walSize(db) > 1 << 20, `WAL holds the writes before close (${walSize(db)} bytes)`);
    await s.close();
    assert.equal(walSize(db), 0, "a reader that stays open no longer pins the WAL at its high-water mark");
    assert.equal((await reader.listEvents("wal-3", { limit: 1 })).length, 1, "the reader still sees the data");
    await reader.close();
  });

  it("checkpoint() truncates the WAL while the store stays open, and is a no-op read-only", async () => {
    const db = join(root, "wal-checkpoint.db");
    const s = await SqliteIndexStore.open(db);
    const pin = await SqliteIndexStore.open(db, { readOnly: true });
    await s.putEvents(events(20_000, "cp"));
    assert.ok(walSize(db) > 1 << 20);
    await pin.checkpoint();
    assert.ok(walSize(db) > 1 << 20, "a read-only connection does not checkpoint");
    await s.checkpoint();
    assert.equal(walSize(db), 0);
    await s.putEvents(events(10, "cp-after"));
    assert.equal((await pin.listEvents("cp-after")).length, 10, "writes after a checkpoint still work");
    assert.ok(WAL_SIZE_LIMIT <= 64 * 1024 * 1024);
    await s.close();
    await pin.close();
  });

  it("a cursor set back to 0 is not kept as a row", async () => {
    const db = join(root, "cursors.db");
    const s = await SqliteIndexStore.open(db);
    await s.setCursor("claude-code/2026-11-06.1.jsonl", 10);
    await s.setCursor("claude-code/2026-11-06.2.jsonl", 20);
    await s.setCursor("claude-code/2026-11-06.1.jsonl", 0);
    assert.equal(await s.getCursor("claude-code/2026-11-06.1.jsonl"), 0);
    assert.equal(await s.getCursor("claude-code/2026-11-06.2.jsonl"), 20);
    await s.close();
    const { DatabaseSync } = await loadSqlite();
    const raw = new DatabaseSync(db);
    assert.deepEqual(raw.prepare("SELECT source FROM cursors").all().map((r) => (r as { source: string }).source), ["claude-code/2026-11-06.2.jsonl"]);
    // Rows left at 0 by an older version go at the next compact (gc --compact).
    raw.prepare("INSERT INTO cursors (source, offset, updated_at) VALUES ('old', 0, 1)").run();
    raw.close();
    const again = await SqliteIndexStore.open(db);
    await again.compact();
    await again.close();
    const raw2 = new DatabaseSync(db);
    assert.equal((raw2.prepare("SELECT COUNT(*) AS n FROM cursors").get() as { n: number }).n, 1);
    raw2.close();
  });
});

describe("SqliteIndexStore", () => {
  it("writes 10k events in one batch in under a second (or 10x a raw insert on a loaded machine)", async () => {
    const s = await SqliteIndexStore.open(join(root, "perf.db"));
    const batch = events(10_000);
    const t = performance.now();
    const { inserted } = await s.putEvents(batch);
    const ms = performance.now() - t;
    assert.equal(inserted, 10_000);
    if (ms >= 1000) {
      // Over budget: load, or a regression? Compare with the same 10k rows inserted raw in one
      // transaction, at the same moment on the same disk (median of 3). The store adds JSON,
      // indexes and session stats, about 2x the raw cost; losing the single transaction or
      // going per-row costs orders of magnitude more.
      const { DatabaseSync } = await loadSqlite();
      const raw = median(
        [0, 1, 2].map((i) => {
          const db = new DatabaseSync(join(root, `raw-${i}.db`));
          db.exec("PRAGMA journal_mode=WAL; CREATE TABLE e (id TEXT PRIMARY KEY, session TEXT, ts INTEGER, kind TEXT, payload TEXT); CREATE INDEX e_s ON e (session, ts)");
          const ins = db.prepare("INSERT INTO e VALUES (?, ?, ?, ?, ?)");
          const took = timeMs(() => {
            db.exec("BEGIN");
            for (const e of batch) ins.run(e.id, e.sessionId, e.ts, e.kind, JSON.stringify(e));
            db.exec("COMMIT");
          });
          db.close();
          return took;
        }),
      );
      assert.ok(ms < 10 * raw, `putEvents took ${ms.toFixed(0)} ms; a raw insert of the same rows took ${raw.toFixed(0)} ms`);
    }
    assert.equal(await s.countEvents(), 10_000);
    assert.equal((await s.putEvents(batch)).inserted, 0);
    assert.equal((await s.search("refactoring", { limit: 5 })).length, 5);
    await s.close();
  });

  it("session_facets holds exactly the distinct (key, value, session) of the events, with repeats deduped in a batch", async () => {
    const path = join(root, "facets.db");
    const s = await SqliteIndexStore.open(path);
    // Two sessions whose events repeat the same few kinds/tools hundreds of times
    // in one batch: the dedup must leave the facet table identical to a rebuild.
    await s.putEvents([...events(600, "sa"), ...events(400, "sb")]);
    await s.close();
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const facets = (db.prepare("SELECT key, value, session_id FROM session_facets ORDER BY key, value, session_id").all() as Array<{ key: string; value: string; session_id: string }>).map((r) => `${r.key}|${r.value}|${r.session_id}`);
      const expected = (
        db
          .prepare(
            `SELECT DISTINCT 'kind' AS key, kind AS value, session_id FROM events WHERE kind <> ''
             UNION SELECT DISTINCT 'tool', tool, session_id FROM events WHERE tool IS NOT NULL AND tool <> ''
             UNION SELECT DISTINCT 'mcp', mcp, session_id FROM events WHERE mcp IS NOT NULL AND mcp <> ''
             ORDER BY key, value, session_id`,
          )
          .all() as Array<{ key: string; value: string; session_id: string }>
      ).map((r) => `${r.key}|${r.value}|${r.session_id}`);
      assert.deepEqual(facets, expected);
      // Every row is distinct (no duplicates slipped past the PRIMARY KEY).
      assert.equal(new Set(facets).size, facets.length);
    } finally {
      db.close();
    }
  });

  it("persists across reopen, records migrations and uses WAL", async () => {
    const path = join(root, "reopen.db");
    const s = await SqliteIndexStore.open(path);
    await s.putEvents(events(3, "keep"));
    await s.setCursor("a", 7);
    await s.close();
    await s.close(); // idempotent
    const again = await SqliteIndexStore.open(path);
    assert.equal((await again.listEvents("keep")).length, 3);
    assert.equal(await again.getCursor("a"), 7);
    await again.close();

    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    assert.deepEqual((db.prepare("SELECT version FROM migrations").all() as { version: number }[]).map((r) => r.version), Array.from({ length: SQLITE_SCHEMA_VERSION }, (_, i) => i + 1));
    // Promoted columns are populated for querying.
    const row = db.prepare("SELECT tool, ok FROM events WHERE id = 'keep-2'").get() as { tool: string; ok: number };
    assert.deepEqual({ ...row }, { tool: "Bash", ok: 1 });
    db.exec(`INSERT INTO migrations (version, applied_at) VALUES (${SQLITE_SCHEMA_VERSION + 1}, 0)`);
    db.close();
    await assert.rejects(() => SqliteIndexStore.open(path), new RegExp(`schema v${SQLITE_SCHEMA_VERSION + 1}, but this coding\\.sh only knows up to v${SQLITE_SCHEMA_VERSION}`));
    // The failed open closed the file: on Windows an open file can't be removed (EBUSY).
    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
  });

  it("migrates a v2 store so existing tool calls become searchable", async () => {
    const path = join(root, "v2.db");
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const m of MIGRATIONS.filter((m) => m.version <= 2)) {
      db.exec(m.sql);
      db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
    }
    // Rows as the v2 code wrote them: only message text went into the FTS index.
    const insert = db.prepare("INSERT INTO events (id, session_id, ts, agent, kind, tool, payload) VALUES (?, 's', ?, 'claude-code', ?, ?, ?)");
    const rows: [string, string, string | null, object][] = [
      ["u", "user.message", null, { text: "ask emil kowalski" }],
      ["t", "tool.start", "Bash", { tool: "Bash", toolUseId: "x", input: { command: "pgrep -fl vision_connector.py" } }],
      ["o", "tool.end", "Bash", { tool: "Bash", toolUseId: "x", ok: true, output: "4242 vision_connector.py" }],
      ["sa", "subagent.start", null, { subagentId: "a", description: "Research narwhal pricing" }],
    ];
    rows.forEach(([id, kind, tool, payload], i) => insert.run(id, i, kind, tool, JSON.stringify(payload)));
    db.exec("INSERT INTO events_fts (rowid, text) SELECT rowid, text FROM events WHERE text IS NOT NULL");
    db.close();

    const s = await SqliteIndexStore.open(path);
    const ids = async (q: string) => (await s.search(q)).map((h) => h.event.id).sort();
    assert.deepEqual(await ids("kowalski"), ["u"], "message text survives the reindex");
    assert.deepEqual(await ids("pgrep"), ["t"]);
    assert.deepEqual(await ids("vision_connector"), ["o", "t"]);
    assert.deepEqual(await ids("narwhal"), ["sa"]);
    const [hit] = await s.search("pgrep");
    assert.match(hit!.snippet, /«pgrep»/);
    // New writes after the migration index tool calls too.
    await s.putEvents([{ id: "n", v: 0, sessionId: "s", ts: 9, agent: "a", kind: "tool.start", payload: { tool: "TaskStop", input: { task_id: "q1" } } }]);
    assert.deepEqual(await ids("taskstop"), ["n"]);
    await s.close();

    const check = new DatabaseSync(path);
    check.exec("INSERT INTO events_fts(events_fts, rank) VALUES ('integrity-check', 1)"); // throws if index and content disagree
    check.close();
  });

  it("retention over empty-text messages leaves the FTS index intact", async () => {
    const path = join(root, "fts-empty.db");
    const s = await SqliteIndexStore.open(path);
    const msg = (id: string, sessionId: string, ts: number, text: string): AgentEvent =>
      ({ id, v: 0, sessionId, ts, agent: "claude-code", kind: "assistant.message", payload: { text } });
    const session = (id: string, at: number) => ({ id, agent: "claude-code", startedAt: at, endedAt: at, stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 }, flags: [] });
    await s.putEvents([msg("e1", "all-empty", 10, ""), msg("e2", "all-empty", 11, ""), msg("m1", "mixed", 10, ""), msg("m2", "mixed", 11, "hello world")]);
    await s.putEvents([msg("k", "keep", Date.now(), "refactor the tokenizer")]);
    await s.upsertSession(session("all-empty", 11));
    await s.upsertSession(session("mixed", 11));
    await s.upsertSession(session("keep", Date.now()));
    assert.deepEqual(await s.deleteBefore(10_000), { sessions: 2, events: 4 });
    assert.equal((await s.search("tokeni")).length, 1);
    assert.deepEqual(await s.deleteBefore(10_000), { sessions: 0, events: 0 });
    await s.close();
    const { DatabaseSync } = await loadSqlite();
    const check = new DatabaseSync(path);
    check.exec("INSERT INTO events_fts(events_fts, rank) VALUES ('integrity-check', 1)");
    check.close();
  });

  it("searchIndexOk passes with events that have no text and fails on a missing, stray or miscounted entry", async () => {
    const path = join(root, "fts-check.db");
    const s = await SqliteIndexStore.open(path);
    const ev = (id: string, kind: AgentEvent["kind"], payload: Record<string, unknown>): AgentEvent => ({ id, v: 0, sessionId: "s", ts: 1, agent: "claude-code", kind, payload });
    await s.putEvents([ev("start", "session.start", {}), ev("u", "user.message", { text: "refactor the tokenizer" }), ev("llm", "llm.call", {}), ev("t", "tool.start", { tool: "Bash", input: { command: "ls" } }), ev("end", "session.end", {})]);
    await s.close();
    const { DatabaseSync } = await loadSqlite();
    let copies = 0;
    // On a copy: FTS5 writes its row count when the transaction commits.
    const verdict = (fault?: string) => {
      const copy = join(root, `fts-check-${copies++}.db`);
      copyFileSync(path, copy);
      const db = new DatabaseSync(copy);
      try {
        if (fault) db.exec(fault);
        return searchIndexOk(db);
      } finally {
        db.close();
      }
    };
    const db = new DatabaseSync(path);
    assert.throws(() => db.exec("INSERT INTO events_fts(events_fts, rank) VALUES ('integrity-check', 1)"), /malformed/, "FTS5's content check counts rows without text as missing");
    db.close();
    assert.equal(verdict(), true);
    assert.equal(verdict("INSERT INTO events_fts(events_fts) VALUES ('rebuild')"), true, "a rebuild's empty entries for rows without text are allowed");
    assert.equal(verdict("INSERT INTO events_fts(events_fts, rowid, text) SELECT 'delete', rowid, text FROM events WHERE id = 'u'"), false, "an event with text has no entry");
    assert.equal(verdict("DELETE FROM events WHERE id = 'u'"), false, "an entry with tokens has no event");
    assert.equal(verdict("INSERT INTO events_fts(events_fts, rowid, text) SELECT 'delete', rowid, '' FROM events WHERE id = 'start'"), false, "a delete for a row never indexed (v4 retention)");
  });

  it("migrating to v5 repairs an FTS index that v4 retention corrupted", async () => {
    const path = join(root, "v4-corrupt.db");
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const m of MIGRATIONS.filter((m) => m.version <= 4)) {
      db.exec(m.sql);
      m.after?.(db);
      db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
    }
    // As v4 putEvents wrote them: the empty message is not indexed, the others are.
    const insert = db.prepare("INSERT INTO events (id, session_id, ts, agent, kind, payload) VALUES (?, ?, ?, 'claude-code', 'assistant.message', ?)");
    const fts = db.prepare("INSERT INTO events_fts (rowid, text) VALUES (?, ?)");
    for (const [id, sid, text] of [["m1", "old", ""], ["m2", "old", "hello world"], ["k", "keep", "refactor the tokenizer"]] as const) {
      const r = insert.run(id, sid, 1, JSON.stringify({ text }));
      if (text) fts.run(r.lastInsertRowid, text);
    }
    // What v4 deleteBefore did for session "old": an FTS 'delete' for the never-indexed '' row too.
    db.exec("INSERT INTO events_fts(events_fts, rowid, text) SELECT 'delete', rowid, text FROM events WHERE session_id = 'old' AND text IS NOT NULL");
    db.exec("DELETE FROM events WHERE session_id = 'old'");
    assert.throws(() => db.exec("INSERT INTO events_fts(events_fts, rank) VALUES ('integrity-check', 1)"), /malformed/, "the v4 index is corrupt");
    db.close();

    const s = await SqliteIndexStore.open(path);
    assert.deepEqual((await s.search("tokeni")).map((h) => h.event.id), ["k"]);
    assert.deepEqual(await s.search("hello"), []);
    await s.close();
    const check = new DatabaseSync(path);
    assert.equal((check.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v, SQLITE_SCHEMA_VERSION);
    assert.equal((check.prepare("SELECT text FROM events WHERE id = 'k'").get() as { text: string }).text, "refactor the tokenizer");
    check.exec("INSERT INTO events_fts(events_fts, rank) VALUES ('integrity-check', 1)");
    check.close();
  });

  it("migrating to v7 fills stats.llmErrors for sessions stored before it", async () => {
    const path = join(root, "v6-llm-errors.db");
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const m of MIGRATIONS.filter((m) => m.version <= 6)) {
      db.exec(m.sql);
      m.after?.(db);
      db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
    }
    const stats = JSON.stringify({ events: 3, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, latency: { llmCalls: 3 } });
    for (const id of ["api", "ok"]) db.prepare("INSERT INTO sessions (id, agent, started_at, stats) VALUES (?, 'sdk-app', 1, ?)").run(id, stats);
    const insert = db.prepare("INSERT INTO events (id, session_id, ts, agent, kind, payload) VALUES (?, ?, ?, 'sdk-app', 'llm.call', ?)");
    insert.run("a3", "api", 3, JSON.stringify({ ok: false, error: "socket hang up" }));
    insert.run("a1", "api", 1, JSON.stringify({ ok: true, statusCode: 200 }));
    insert.run("a2", "api", 2, JSON.stringify({ ok: false, statusCode: 429, error: "429 Rate limit reached" }));
    insert.run("o1", "ok", 1, JSON.stringify({ ok: true, statusCode: "500" }));
    db.close();

    const s = await SqliteIndexStore.open(path);
    assert.deepEqual((await s.getSession("api"))?.stats.llmErrors, { count: 2, statusCode: 429, error: "429 Rate limit reached" });
    assert.equal((await s.getSession("ok"))?.stats.llmErrors, undefined);
    assert.equal((await s.getSession("ok"))?.stats.latency?.llmCalls, 3, "the rest of stats is kept");
    await s.close();
  });

  // V-2: the facet table and the mcp column, filled for a store written before v8,
  // equal what a fresh store writes at insert.
  const facetEvents = (): AgentEvent[] => {
    const ev = (id: string, sessionId: string, kind: AgentEvent["kind"], payload: Record<string, unknown>): AgentEvent => ({ id, v: 0, sessionId, ts: 1_700_000_000_000 + Number(id.slice(1)), agent: "claude-code", kind, payload });
    return [
      ev("e1", "a", "user.message", { text: "hi" }),
      ev("e2", "a", "tool.start", { tool: "mcp__github__search", server: "github", input: {} }),
      ev("e3", "a", "tool.end", { tool: "mcp__github__search", server: "github", ok: true }),
      ev("e4", "a", "tool.end", { tool: "Bash", ok: false }),
      ev("e5", "b", "tool.end", { tool: "Bash", ok: true }),
      ev("e6", "b", "assistant.message", { text: "done", server: "not-a-tool" }),
      ev("e7", "b", "tool.end", { tool: "", ok: true }),
    ];
  };
  const facetRows = async (path: string) => {
    const db = new (await loadSqlite()).DatabaseSync(path, { readOnly: true });
    const plain = (rows: unknown[]) => rows.map((r) => ({ ...(r as Record<string, unknown>) }));
    try {
      return {
        facets: plain(db.prepare("SELECT key, value, session_id FROM session_facets ORDER BY key, value, session_id").all()) as { key: string; value: string; session_id: string }[],
        mcp: plain(db.prepare("SELECT id, mcp FROM events ORDER BY id").all()) as { id: string; mcp: string | null }[],
      };
    } finally {
      db.close();
    }
  };

  it("migrating to v8 fills session_facets and events.mcp as a fresh store writes them", async () => {
    const { DatabaseSync } = await loadSqlite();
    const old = join(root, "v7-facets.db");
    const db = new DatabaseSync(old);
    db.exec("CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const m of MIGRATIONS.filter((m) => m.version <= 7)) {
      db.exec(m.sql);
      m.after?.(db);
      db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, 0)").run(m.version);
    }
    const insert = db.prepare("INSERT INTO events (id, session_id, ts, agent, kind, tool, ok, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const e of facetEvents()) {
      const tool = typeof e.payload.tool === "string" ? e.payload.tool : null;
      insert.run(e.id, e.sessionId, e.ts, e.agent, e.kind, tool, typeof e.payload.ok === "boolean" ? Number(e.payload.ok) : null, JSON.stringify(e.payload));
    }
    db.close();
    await (await SqliteIndexStore.open(old)).close();

    const fresh = join(root, "v8-facets.db");
    const s = await SqliteIndexStore.open(fresh);
    await s.putEvents(facetEvents());
    await s.close();

    const migrated = await facetRows(old);
    assert.deepEqual(migrated, await facetRows(fresh));
    assert.deepEqual(migrated.mcp.filter((r) => r.mcp !== null).map((r) => r.id), ["e2", "e3"]);
    assert.deepEqual(migrated.facets.filter((r) => r.key === "tool"), [
      { key: "tool", value: "Bash", session_id: "a" },
      { key: "tool", value: "Bash", session_id: "b" },
      { key: "tool", value: "mcp__github__search", session_id: "a" },
    ]);
  });

  it("session_facets follows replaced and expired events", async () => {
    const path = join(root, "facets-follow.db");
    const s = await SqliteIndexStore.open(path);
    await s.putEvents(facetEvents());
    const session = (id: string) => ({ id, agent: "claude-code", startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_010, flags: [], stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 } });
    await s.upsertSession(session("a"));
    await s.upsertSession(session("b"));
    // Drop session a's MCP calls: its github and mcp__github__search facets go with them.
    await s.replaceSessionEvents("a", ["e2", "e3"], []);
    let rows = (await facetRows(path)).facets;
    assert.ok(!rows.some((r) => r.session_id === "a" && (r.value === "github" || r.value === "mcp__github__search")), JSON.stringify(rows));
    assert.ok(rows.some((r) => r.session_id === "a" && r.value === "Bash"));
    // Re-adding an event restores its facet.
    await s.replaceSessionEvents("a", [], [facetEvents()[1]!]);
    rows = (await facetRows(path)).facets;
    assert.ok(rows.some((r) => r.session_id === "a" && r.key === "mcp" && r.value === "github"));
    // Retention removes a whole session's facets.
    const removed = await s.deleteBefore(Date.now());
    assert.equal(removed.sessions, 2);
    assert.deepEqual((await facetRows(path)).facets, []);
    await s.close();
  });

  it("childCounts counts each parent's subagents in one query", async () => {
    const s = await SqliteIndexStore.open(":memory:");
    const row = (id: string, parent?: string, project?: string) => ({
      id, agent: "claude-code", startedAt: 1, flags: [], stats: { events: 0, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0 },
      ...(parent ? { parent: { sessionId: parent } } : {}), ...(project ? { project } : {}),
    });
    for (const r of [row("p"), row("q"), row("c1", "p"), row("c2", "p"), row("c3", "q", "team")]) await s.upsertSession(r);
    assert.deepEqual(await s.childCounts(["p", "q", "none"]), { p: 2, q: 1 });
    assert.deepEqual(await s.childCounts(["p", "q"], { project: "team" }), { q: 1 });
    await s.close();
  });

  it("retention keeps a resumed session and a session that never ended while they are active", async () => {
    const { rebuildSessions } = await import("../../src/otel/receiver.ts");
    const s = await SqliteIndexStore.open(":memory:");
    const now = Date.now();
    const H = 3_600_000;
    const ev = (id: string, sessionId: string, kind: string, ts: number, payload: Record<string, unknown> = {}): AgentEvent =>
      ({ id, v: 0, sessionId, ts, agent: "claude-code", kind: kind as AgentEvent["kind"], payload, source: "hook" });
    await s.putEvents([
      ev("r1", "resumed", "session.start", now - 72 * H),
      ev("r2", "resumed", "user.message", now - 72 * H + 1000, { text: "first run" }),
      ev("r3", "resumed", "session.end", now - 71 * H),
      ev("r4", "resumed", "session.start", now - 10 * 60_000),
      ev("r5", "resumed", "user.message", now - 5 * 60_000, { text: "still working on this right now" }),
      ev("l1", "long", "session.start", now - 48 * H),
      ev("l2", "long", "user.message", now - 60_000, { text: "live" }),
      ev("o1", "over", "session.start", now - 72 * H),
      ev("o2", "over", "session.end", now - 71 * H),
    ]);
    await rebuildSessions(s, ["resumed", "long", "over"]);
    assert.equal((await s.getSession("resumed"))!.endedAt, undefined, "activity after the first run's session.end reopens the session");
    assert.deepEqual(await s.deleteBefore(now - 24 * H), { sessions: 1, events: 2 });
    assert.equal((await s.listEvents("resumed")).length, 5);
    assert.equal((await s.listEvents("long")).length, 2);
    assert.equal(await s.getSession("over"), undefined);
    await s.close();
  });

  it("matches prefixes and ignores diacritics", async () => {
    const s = await SqliteIndexStore.open(":memory:");
    await s.putEvents([{ id: "x", v: 0, sessionId: "s", ts: 1, agent: "a", kind: "user.message", payload: { text: "I fixed the café tests" } }]);
    assert.equal((await s.search("fix")).length, 1);
    assert.equal((await s.search("cafe")).length, 1);
    assert.equal((await s.search("fixing")).length, 0, "no stemming");
    await s.close();
  });

  it("several processes can open a new database at the same time", async () => {
    // The hook's background ingest and the CLI often open a fresh index together.
    // Each must apply a migration once, not race to ALTER the same table.
    const path = join(root, "race.db");
    const script = `import { SqliteIndexStore } from ${JSON.stringify(new URL("../../src/store/sqlite.ts", import.meta.url).href)};
      const s = await SqliteIndexStore.open(process.argv[1]); await s.close();`;
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<{ code: number | null; err: string }>((done) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", script, path], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => done({ code, err }));
    })));
    for (const r of results) assert.equal(r.code, 0, r.err);
    const { DatabaseSync } = await loadSqlite();
    const check = new DatabaseSync(path);
    const versions = check.prepare("SELECT version FROM migrations ORDER BY version").all().map((r) => r.version);
    check.close();
    assert.deepEqual(versions, MIGRATIONS.map((m) => m.version));
  });

  it("loads node:sqlite without printing the ExperimentalWarning", () => {
    const script = `import { SqliteIndexStore } from ${JSON.stringify(new URL("../../src/store/sqlite.ts", import.meta.url).href)};
      const s = await SqliteIndexStore.open(":memory:"); await s.close();
      process.emitWarning("still-visible", "UserWarning");`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ExperimentalWarning.*SQLite/i);
    assert.match(r.stderr, /still-visible/, "other warnings still print");
  });
});
