// Default IndexStore: a single SQLite file via node:sqlite (no native deps).
//
// node:sqlite is still flagged experimental and prints an ExperimentalWarning
// on load. That warning is noise for CLI users, so it is filtered once while
// the module is dynamically imported; every other warning passes through.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { AgentEvent, BlobRef, Session } from "../schema/index.ts";
import type {
  EvalTask,
  EventCost,
  HarnessBundle,
  IndexStore,
  Label,
  RunResult,
  SearchHit,
  SearchOpts,
  SessionFilter,
  WriterLock,
} from "../core/types.ts";
import { acquireLock, LockBusyError, type Lock } from "../core/lock.ts";
import type { Dataset, DatasetVersionInfo, ExperimentResult, JudgeVersion } from "../datasets/types.ts";
import type { DatasetListing } from "../core/types.ts";
import {
  BLOB_REF_FIELDS,
  type BlobRefField,
  ftsQuery,
  MESSAGE_SEARCH_KINDS,
  searchableText,
  SEARCHABLE_KINDS,
  SNIPPET_CLOSE,
  SNIPPET_ELLIPSIS,
  SNIPPET_OPEN,
  storedSearchText,
} from "./common.ts";

type SqliteModule = typeof import("node:sqlite");
let sqliteModule: Promise<SqliteModule> | undefined;

export function loadSqlite(): Promise<SqliteModule> {
  sqliteModule ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
      const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined);
      const message = typeof warning === "string" ? warning : warning.message;
      if (type === "ExperimentalWarning" && /SQLite/i.test(message)) return;
      return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
    } as typeof process.emitWarning;
    try {
      return await import("node:sqlite");
    } finally {
      process.emitWarning = original;
    }
  })();
  return sqliteModule;
}

// ---------------------------------------------------------------- schema

interface Migration {
  version: number;
  sql: string;
  /** Runs after `sql`, in the same transaction, for data changes SQL alone cannot compute. */
  after?: (db: DatabaseSync) => void;
}

const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");

/** SELECT of the refs at one BLOB_REF_FIELDS entry (paths are constants, not user input). */
function refFieldSql(f: BlobRefField): string {
  const path = `'$.${f.path.join(".")}'`;
  if (f.shape === "ref") return `SELECT json_extract(doc, ${path}) FROM ${f.table} WHERE json_type(doc, ${path}) = 'text'`;
  const type = f.shape === "list" ? "array" : "object";
  return `SELECT j.value FROM ${f.table}, json_each(${f.table}.doc, ${path}) AS j WHERE json_type(${f.table}.doc, ${path}) = '${type}' AND j.type = 'text'`;
}

/** Exported for migration tests only. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  parent_id TEXT,
  ts INTEGER NOT NULL,
  duration_ms REAL,
  trace_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  subagent_id TEXT,
  agent TEXT NOT NULL,
  agent_version TEXT,
  model TEXT,
  kind TEXT NOT NULL,
  tool TEXT,
  ok INTEGER,
  run_id TEXT,
  cwd TEXT,
  repo TEXT,
  payload TEXT NOT NULL,
  blobs TEXT,
  usage TEXT,
  -- Virtual (not stored): the FTS index reads message text from the payload.
  text TEXT GENERATED ALWAYS AS (
    CASE WHEN kind IN ('user.message', 'assistant.message') THEN json_extract(payload, '$.text') END
  ) VIRTUAL
);
CREATE INDEX events_session_ts ON events(session_id, ts);
CREATE INDEX events_kind ON events(kind);
CREATE INDEX events_run ON events(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX events_tool ON events(tool) WHERE tool IS NOT NULL;
CREATE INDEX events_trace ON events(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX events_subagent ON events(session_id, subagent_id) WHERE subagent_id IS NOT NULL;

-- External-content FTS over events.text: no duplicate copy of message text.
-- No porter stemming: it breaks as-you-type prefix queries ("tokeni" vs stem "token").
CREATE VIRTUAL TABLE events_fts USING fts5(
  text, content='events', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  agent_version TEXT,
  model TEXT,
  cwd TEXT,
  repo TEXT,
  repo_root TEXT,
  title TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  stats TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  end_snapshot TEXT,
  parent TEXT,
  parent_session_id TEXT
);
CREATE INDEX sessions_started ON sessions(started_at DESC);
CREATE INDEX sessions_agent ON sessions(agent, started_at DESC);
CREATE INDEX sessions_repo ON sessions(repo_root, started_at DESC);
CREATE INDEX sessions_run ON sessions(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX sessions_parent ON sessions(parent_session_id, started_at DESC);

CREATE TABLE cursors (
  source TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source_session_id TEXT,
  created_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX tasks_status ON tasks(status, created_at DESC);

CREATE TABLE bundles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX bundles_name ON bundles(name, created_at DESC);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT,
  task_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  session_id TEXT,
  pass INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX runs_task ON runs(task_id);
CREATE INDEX runs_bundle ON runs(bundle_id);
CREATE INDEX runs_experiment ON runs(experiment_id) WHERE experiment_id IS NOT NULL;

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  criterion TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  by TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX labels_session ON labels(session_id, criterion);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE events ADD COLUMN source TEXT;
ALTER TABLE sessions ADD COLUMN trace_ids TEXT;

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE datasets (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  cases INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  note TEXT,
  doc TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE dataset_latest (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL
);

CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX experiments_dataset ON experiments(dataset_id, id DESC);

CREATE TABLE judges (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);
`,
  },
  {
    // Search covers tool calls, tool output and subagent launches, not only
    // messages. That text is computed in JS (searchableText), so it is kept in
    // `search_extra`; message text is still read from the payload, never copied.
    version: 3,
    sql: `
DROP TABLE events_fts;
ALTER TABLE events DROP COLUMN text;
ALTER TABLE events ADD COLUMN search_extra TEXT;
-- Message kinds must match MESSAGE_SEARCH_KINDS in common.ts (written out so this migration never changes).
ALTER TABLE events ADD COLUMN text TEXT GENERATED ALWAYS AS (
  CASE WHEN kind IN ('user.message', 'assistant.message') THEN
    CASE WHEN json_type(payload, '$.text') = 'text' THEN json_extract(payload, '$.text') END
  ELSE search_extra END
) VIRTUAL;
CREATE VIRTUAL TABLE events_fts USING fts5(
  text, content='events', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
`,
    after: (db) => {
      const kinds = SEARCHABLE_KINDS.filter((k) => !MESSAGE_SEARCH_KINDS.includes(k));
      const select = db.prepare(`SELECT rowid AS rid, * FROM events WHERE rowid > ? AND kind IN (${sqlList(kinds)}) ORDER BY rowid LIMIT 1000`);
      const update = db.prepare("UPDATE events SET search_extra = ? WHERE rowid = ?");
      // Page by rowid: rows are not updated while a SELECT over them is still open.
      for (let last = 0; ;) {
        const rows = select.all(last) as Row[];
        if (!rows.length) break;
        for (const r of rows) {
          const text = storedSearchText(rowToEvent(r));
          if (text !== undefined) update.run(text, r.rid as number);
          last = num(r.rid)!;
        }
      }
      db.exec("INSERT INTO events_fts(events_fts) VALUES ('rebuild')");
    },
  },
  {
    // Projects (coding.sh serve): 'default' is all unscoped data, read back as an unset field.
    version: 4,
    sql: `
ALTER TABLE events ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX sessions_project ON sessions(project_id, started_at DESC);
CREATE INDEX events_project ON events(project_id, ts);
`,
  },
  {
    // events.text is NULL exactly when putEvents indexed nothing (searchableText is
    // undefined for empty text). v3 gave '' for an empty message, so retention sent
    // FTS 'delete' for rows never indexed and corrupted the index; 'rebuild' repairs
    // databases that already hit it.
    version: 5,
    sql: `
DROP TABLE events_fts;
ALTER TABLE events DROP COLUMN text;
-- Message kinds must match MESSAGE_SEARCH_KINDS in common.ts (written out so this migration never changes).
ALTER TABLE events ADD COLUMN text TEXT GENERATED ALWAYS AS (NULLIF(
  CASE WHEN kind IN ('user.message', 'assistant.message') THEN
    CASE WHEN json_type(payload, '$.text') = 'text' THEN json_extract(payload, '$.text') END
  ELSE search_extra END, ''
)) VIRTUAL;
CREATE VIRTUAL TABLE events_fts USING fts5(
  text, content='events', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);
`,
    after: (db) => db.exec("INSERT INTO events_fts(events_fts) VALUES ('rebuild')"),
  },
  {
    // Adapter parse version per session (Session.parseVersion). Sessions stored
    // before versioning came from parse version 1 (coding.sh 0.1.1 and earlier).
    version: 6,
    sql: `
ALTER TABLE sessions ADD COLUMN parse_version INTEGER;
UPDATE sessions SET parse_version = 1;
`,
  },
  {
    // Session.stats.llmErrors: failed model calls (ok false, or HTTP status 400+),
    // which buildSession now counts. Filled in once for sessions stored before,
    // so the session list reads it from the row. Written out (not buildSession's
    // helpers) so this migration never changes.
    version: 7,
    sql: "-- stats.llmErrors is filled in by after()",
    after: (db) => {
      const failed = db.prepare(`SELECT session_id, payload FROM events WHERE kind = 'llm.call'
        AND (json_type(payload, '$.ok') = 'false'
          OR (json_type(payload, '$.statusCode') IN ('integer', 'real') AND json_extract(payload, '$.statusCode') >= 400))
        ORDER BY session_id, ts, rowid`).all() as Row[];
      const bySession = new Map<string, { count: number; statusCode?: number; error?: string }>();
      for (const r of failed) {
        const id = String(r.session_id);
        const prev = bySession.get(id);
        if (prev) {
          prev.count++;
          continue;
        }
        const p = JSON.parse(String(r.payload)) as Record<string, unknown>;
        const first: { count: number; statusCode?: number; error?: string } = { count: 1 };
        if (typeof p.statusCode === "number") first.statusCode = p.statusCode;
        if (typeof p.error === "string" && p.error) first.error = p.error.slice(0, 300);
        bySession.set(id, first);
      }
      const update = db.prepare("UPDATE sessions SET stats = json_set(stats, '$.llmErrors', json(?)) WHERE id = ?");
      for (const [id, errors] of bySession) update.run(JSON.stringify(errors), id);
    },
  },
];

export const SQLITE_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

// ---------------------------------------------------------------- row mapping

type Row = Record<string, unknown>;

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = <T>(v: unknown): T | undefined => (typeof v === "string" ? (JSON.parse(v) as T) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined);

/**
 * PRAGMA journal_mode = WAL, retried on SQLITE_BUSY. Switching a fresh database out of
 * rollback mode needs an exclusive lock, and SQLite skips the busy handler when waiting
 * could deadlock, so several processes opening a new index together (the hook's
 * background ingest and the CLI) can get "database is locked" despite busy_timeout.
 */
async function switchToWal(db: DatabaseSync): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (e) {
      if ((e as { errcode?: number }).errcode !== 5 || i >= 50) throw e;
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
    }
  }
}

function rowToEvent(r: Row): AgentEvent {
  const e: AgentEvent = {
    id: r.id as string,
    v: 0,
    sessionId: r.session_id as string,
    ts: num(r.ts)!,
    agent: r.agent as string,
    kind: r.kind as AgentEvent["kind"],
    payload: parse<Record<string, unknown>>(r.payload) ?? {},
  };
  const set = <K extends keyof AgentEvent>(k: K, v: AgentEvent[K] | undefined) => {
    if (v !== undefined) e[k] = v;
  };
  set("turnId", str(r.turn_id));
  set("durationMs", num(r.duration_ms));
  set("traceId", str(r.trace_id));
  set("spanId", str(r.span_id));
  set("parentSpanId", str(r.parent_span_id));
  set("subagentId", str(r.subagent_id));
  set("parentId", str(r.parent_id));
  set("agentVersion", str(r.agent_version));
  set("model", str(r.model));
  set("runId", str(r.run_id));
  set("cwd", str(r.cwd));
  set("repo", parse(r.repo));
  set("blobs", parse(r.blobs));
  set("usage", parse(r.usage));
  set("source", str(r.source));
  set("project", projectField(r.project_id));
  return e;
}

/** 'default' (the column default) reads back as an unset field. */
const projectField = (v: unknown): string | undefined => (typeof v === "string" && v !== "default" ? v : undefined);
const projectCol = (p: string | undefined): string => p ?? "default";

/** Writer locks this process holds, by lock path (see acquireWriterLock). */
const heldWriterLocks = new Set<string>();

function rowToSession(r: Row): Session {
  const s: Session = {
    id: r.id as string,
    agent: r.agent as string,
    startedAt: num(r.started_at)!,
    stats: parse<Session["stats"]>(r.stats)!,
    flags: parse<string[]>(r.flags) ?? [],
  };
  // provider rides in the stats JSON (no column; see upsertSession).
  const { provider, ...stats } = s.stats as Session["stats"] & { provider?: string };
  if (typeof provider === "string") (s.stats = stats), (s.provider = provider);
  const set = <K extends keyof Session>(k: K, v: Session[K] | undefined) => {
    if (v !== undefined) s[k] = v;
  };
  set("agentVersion", str(r.agent_version));
  set("model", str(r.model));
  set("cwd", str(r.cwd));
  set("repo", parse(r.repo));
  set("title", str(r.title));
  set("endedAt", num(r.ended_at));
  set("runId", str(r.run_id));
  set("endSnapshot", str(r.end_snapshot));
  set("parent", parse(r.parent));
  set("traceIds", parse(r.trace_ids));
  set("project", projectField(r.project_id));
  set("parseVersion", num(r.parse_version));
  return s;
}

// ---------------------------------------------------------------- store

export interface SqliteIndexOptions {
  /** Open read-only (no migrations). */
  readOnly?: boolean;
}

export class SqliteIndexStore implements IndexStore {
  readonly kind = "sqlite";
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  private closed = false;
  private static memSeq = 0;
  private readonly memId = SqliteIndexStore.memSeq++;

  private constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
  }

  /** Opens (creating if needed) the database at `path` (":memory:" for tests) and migrates it. */
  static async open(path: string, opts: SqliteIndexOptions = {}): Promise<SqliteIndexStore> {
    const { DatabaseSync } = await loadSqlite();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
    // busy_timeout first so the WAL switch itself waits on a concurrent writer.
    db.exec("PRAGMA busy_timeout = 5000");
    if (!opts.readOnly) await switchToWal(db);
    db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    const store = new SqliteIndexStore(db, path);
    if (!opts.readOnly) await store.migrate();
    return store;
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private tx<T>(fn: () => T): T {
    // Inside transaction(): a savepoint, so a failed write still undoes only itself.
    if (this.txDepth) {
      this.db.exec("SAVEPOINT w");
      try {
        const out = fn();
        this.db.exec("RELEASE w");
        return out;
      } catch (err) {
        this.db.exec("ROLLBACK TO w; RELEASE w");
        throw err;
      }
    }
    // IMMEDIATE takes the write lock up front, avoiding SQLITE_BUSY on lock upgrade.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private txDepth = 0;

  /** See IndexStore.transaction. Nested calls join the outer transaction. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.txDepth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const out = await fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  async migrate(): Promise<void> {
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT MAX(version) AS v FROM migrations").get() as Row | undefined;
    const current = num(row?.v) ?? 0;
    if (current > SQLITE_SCHEMA_VERSION) {
      throw new Error(`${this.path} uses index schema v${current}, but this coding.sh only knows up to v${SQLITE_SCHEMA_VERSION}. Upgrade coding.sh.`);
    }
    const applied = this.db.prepare("SELECT 1 FROM migrations WHERE version = ?");
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.tx(() => {
        // Another process (the background hook ingest, a second CLI) may have applied
        // this version between the read above and taking the write lock.
        if (applied.get(m.version)) return;
        this.db.exec(m.sql);
        m.after?.(this.db);
        this.db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stmts.clear();
    this.db.close();
  }

  // ------------------------------------------------------------ events

  async putEvents(batch: AgentEvent[]): Promise<{ inserted: number }> {
    if (!batch.length) return { inserted: 0 };
    return this.tx(() => ({ inserted: this.insertEvents(batch) }));
  }

  async replaceSessionEvents(sessionId: string, removeIds: string[], add: AgentEvent[]): Promise<{ removed: number; inserted: number }> {
    // External-content FTS: drop each row's index entry with the text it was indexed under (see deleteBefore).
    const ftsDelete = this.stmt("INSERT INTO events_fts(events_fts, rowid, text) SELECT 'delete', rowid, text FROM events WHERE id = ? AND session_id = ? AND text IS NOT NULL AND text <> ''");
    const del = this.stmt("DELETE FROM events WHERE id = ? AND session_id = ?");
    return this.tx(() => {
      let removed = 0;
      for (const id of new Set(removeIds)) {
        ftsDelete.run(id, sessionId);
        removed += Number(del.run(id, sessionId).changes);
      }
      return { removed, inserted: this.insertEvents(add) };
    });
  }

  /** INSERT OR IGNORE plus FTS rows; the caller holds the transaction. Returns rows inserted. */
  private insertEvents(batch: AgentEvent[]): number {
    const insert = this.stmt(`INSERT OR IGNORE INTO events
      (id, session_id, turn_id, parent_id, ts, duration_ms, trace_id, span_id, parent_span_id, subagent_id,
       agent, agent_version, model, kind, tool, ok, run_id, cwd, repo, payload, blobs, usage, source, search_extra, project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const fts = this.stmt("INSERT INTO events_fts (rowid, text) VALUES (?, ?)");
    let inserted = 0;
    for (const e of batch) {
      const p = e.payload ?? {};
      const tool = typeof p.tool === "string" ? p.tool : null;
      const ok = typeof p.ok === "boolean" ? (p.ok ? 1 : 0) : null;
      const r = insert.run(
        e.id, e.sessionId, e.turnId ?? null, e.parentId ?? null, e.ts, e.durationMs ?? null, e.traceId ?? null,
        e.spanId ?? null, e.parentSpanId ?? null, e.subagentId ?? null, e.agent, e.agentVersion ?? null,
        e.model ?? null, e.kind, tool, ok, e.runId ?? null, e.cwd ?? null, json(e.repo), JSON.stringify(p),
        e.blobs?.length ? JSON.stringify(e.blobs) : null, json(e.usage), e.source ?? null, storedSearchText(e) ?? null,
        projectCol(e.project),
      );
      if (Number(r.changes) === 0) continue;
      inserted++;
      // Must equal the generated events.text, which the external-content FTS reads for snippets.
      const text = searchableText(e);
      if (text !== undefined) fts.run(r.lastInsertRowid, text);
    }
    return inserted;
  }

  async setEventCosts(costs: EventCost[]): Promise<number> {
    if (!costs.length) return 0;
    // Only usage, payload.costEstimated and payload.pricedAs: message text (the FTS source) never changes here.
    const update = this.stmt(
      "UPDATE events SET usage = json_set(coalesce(usage, '{}'), '$.costUsd', ?), payload = CASE WHEN ? IS NULL THEN json_set(json_remove(payload, '$.pricedAs'), '$.costEstimated', json('true')) ELSE json_set(payload, '$.costEstimated', json('true'), '$.pricedAs', ?) END WHERE id = ?",
    );
    return this.tx(() => {
      let found = 0;
      for (const { id, costUsd, pricedAs } of costs) found += Number(update.run(costUsd, pricedAs ?? null, pricedAs ?? null, id).changes);
      return found;
    });
  }

  async listEvents(sessionId: string, opts: { kinds?: string[]; limit?: number; offset?: number } = {}): Promise<AgentEvent[]> {
    const params: (string | number)[] = [sessionId];
    let sql = "SELECT * FROM events WHERE session_id = ?";
    if (opts.kinds?.length) {
      sql += ` AND kind IN (${opts.kinds.map(() => "?").join(", ")})`;
      params.push(...opts.kinds);
    }
    sql += " ORDER BY ts, rowid LIMIT ? OFFSET ?";
    params.push(opts.limit ?? -1, opts.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToEvent);
  }

  async search(text: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const q = ftsQuery(text);
    if (!q) return [];
    const params: (string | number)[] = [q];
    let sql = `SELECT e.*, snippet(events_fts, 0, ?, ?, ?, 16) AS snip
      FROM events_fts JOIN events e ON e.rowid = events_fts.rowid
      WHERE events_fts MATCH ?`;
    params.unshift(SNIPPET_OPEN, SNIPPET_CLOSE, SNIPPET_ELLIPSIS);
    if (opts.agent) {
      sql += " AND e.agent = ?";
      params.push(opts.agent);
    }
    if (opts.project !== undefined) {
      sql += " AND e.project_id = ?";
      params.push(opts.project);
    }
    sql += " ORDER BY bm25(events_fts), e.ts DESC LIMIT ?";
    params.push(opts.limit ?? 50);
    return (this.stmt(sql).all(...params) as Row[]).map((r) => ({ event: rowToEvent(r), snippet: String(r.snip ?? "") }));
  }

  // ------------------------------------------------------------ sessions

  async upsertSession(s: Session): Promise<void> {
    this.stmt(`INSERT INTO sessions
      (id, agent, agent_version, model, cwd, repo, repo_root, title, started_at, ended_at, stats, flags, run_id, end_snapshot,
       parent, parent_session_id, trace_ids, project_id, parse_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent = excluded.agent, agent_version = excluded.agent_version, model = excluded.model, cwd = excluded.cwd,
        repo = excluded.repo, repo_root = excluded.repo_root, title = excluded.title, started_at = excluded.started_at,
        ended_at = excluded.ended_at, stats = excluded.stats, flags = excluded.flags, run_id = excluded.run_id,
        end_snapshot = excluded.end_snapshot, parent = excluded.parent, parent_session_id = excluded.parent_session_id,
        trace_ids = excluded.trace_ids, project_id = excluded.project_id,
        parse_version = coalesce(excluded.parse_version, sessions.parse_version)`).run(
      s.id, s.agent, s.agentVersion ?? null, s.model ?? null, s.cwd ?? null, json(s.repo), s.repo?.root ?? null,
      s.title ?? null, s.startedAt, s.endedAt ?? null, JSON.stringify(s.provider ? { ...s.stats, provider: s.provider } : s.stats), JSON.stringify(s.flags ?? []),
      s.runId ?? null, s.endSnapshot ?? null, json(s.parent), s.parent?.sessionId ?? null,
      s.traceIds?.length ? JSON.stringify(s.traceIds) : null, projectCol(s.project), s.parseVersion ?? null,
    );
  }

  async getSession(id: string): Promise<Session | undefined> {
    const r = this.stmt("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToSession(r) : undefined;
  }

  async sessionIdsByPrefix(prefix: string, limit: number): Promise<string[]> {
    // A range on the primary key: every id with this prefix sorts in [prefix, prefix + U+10FFFF).
    const rows = this.stmt("SELECT id FROM sessions WHERE id >= ? AND id < ? ORDER BY id LIMIT ?").all(prefix, `${prefix}\u{10FFFF}`, limit) as Row[];
    return rows.map((r) => String(r.id)).filter((id) => id.startsWith(prefix));
  }

  async childCounts(parentIds: string[], opts: { project?: string } = {}): Promise<Record<string, number>> {
    if (!parentIds.length) return {};
    const params: string[] = [JSON.stringify(parentIds)];
    let sql = "SELECT parent_session_id AS p, COUNT(*) AS n FROM sessions WHERE parent_session_id IN (SELECT value FROM json_each(?))";
    if (opts.project !== undefined) sql += " AND project_id = ?", params.push(opts.project);
    const out: Record<string, number> = {};
    for (const r of this.db.prepare(`${sql} GROUP BY parent_session_id`).all(...params) as Row[]) out[String(r.p)] = num(r.n) ?? 0;
    return out;
  }

  async listSessions(f: SessionFilter = {}): Promise<Session[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.agent) where.push("agent = ?"), params.push(f.agent);
    if (f.parentSessionId === null) where.push("parent_session_id IS NULL");
    else if (f.parentSessionId !== undefined) where.push("parent_session_id = ?"), params.push(f.parentSessionId);
    if (f.repoRoot) where.push("repo_root = ?"), params.push(f.repoRoot);
    if (f.runId === null) where.push("run_id IS NULL");
    else if (f.runId !== undefined) where.push("run_id = ?"), params.push(f.runId);
    if (f.flag) where.push("EXISTS (SELECT 1 FROM json_each(sessions.flags) WHERE value = ?)"), params.push(f.flag);
    if (f.since !== undefined) where.push("started_at >= ?"), params.push(f.since);
    if (f.until !== undefined) where.push("started_at < ?"), params.push(f.until);
    if (f.project !== undefined) where.push("project_id = ?"), params.push(f.project);
    const sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY started_at DESC, id LIMIT ? OFFSET ?`;
    params.push(f.limit ?? -1, f.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToSession);
  }

  // ------------------------------------------------------------ cursors

  async getCursor(source: string): Promise<number> {
    const r = this.stmt("SELECT offset FROM cursors WHERE source = ?").get(source) as Row | undefined;
    return num(r?.offset) ?? 0;
  }

  async setCursor(source: string, offset: number): Promise<void> {
    this.stmt(`INSERT INTO cursors (source, offset, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET offset = excluded.offset, updated_at = excluded.updated_at`).run(source, offset, Date.now());
  }

  // ------------------------------------------------------------ tasks / bundles / runs / labels

  async putTask(t: EvalTask): Promise<void> {
    this.stmt(`INSERT INTO tasks (id, name, status, tags, source_session_id, created_at, doc) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, tags = excluded.tags,
        source_session_id = excluded.source_session_id, created_at = excluded.created_at, doc = excluded.doc`).run(
      t.id, t.name, t.status, JSON.stringify(t.tags ?? []), t.sourceSessionId ?? null, t.createdAt, JSON.stringify(t),
    );
  }

  async getTask(id: string): Promise<EvalTask | undefined> {
    const r = this.stmt("SELECT doc FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return parse<EvalTask>(r?.doc);
  }

  async listTasks(opts: { status?: EvalTask["status"]; tag?: string } = {}): Promise<EvalTask[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.status) where.push("status = ?"), params.push(opts.status);
    if (opts.tag) where.push("EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE value = ?)"), params.push(opts.tag);
    const sql = `SELECT doc FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => parse<EvalTask>(r.doc)!);
  }

  async putBundle(b: HarnessBundle): Promise<void> {
    this.stmt(`INSERT INTO bundles (id, name, agent, created_at, doc) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, agent = excluded.agent, created_at = excluded.created_at, doc = excluded.doc`).run(
      b.id, b.name, b.agent, b.createdAt, JSON.stringify(b),
    );
  }

  async getBundle(idOrName: string): Promise<HarnessBundle | undefined> {
    const r = (this.stmt("SELECT doc FROM bundles WHERE id = ?").get(idOrName) ??
      this.stmt("SELECT doc FROM bundles WHERE name = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(idOrName)) as Row | undefined;
    return parse<HarnessBundle>(r?.doc);
  }

  async listBundles(): Promise<HarnessBundle[]> {
    return (this.stmt("SELECT doc FROM bundles ORDER BY created_at DESC, id").all() as Row[]).map((r) => parse<HarnessBundle>(r.doc)!);
  }

  async putRun(run: RunResult): Promise<void> {
    this.stmt(`INSERT INTO runs (id, experiment_id, task_id, bundle_id, session_id, pass, started_at, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET experiment_id = excluded.experiment_id, task_id = excluded.task_id, bundle_id = excluded.bundle_id,
        session_id = excluded.session_id, pass = excluded.pass, started_at = excluded.started_at, doc = excluded.doc`).run(
      run.id, run.experimentId ?? null, run.taskId, run.bundleId, run.sessionId ?? null, run.pass ? 1 : 0, run.startedAt, JSON.stringify(run),
    );
  }

  async listRuns(f: { taskId?: string; bundleId?: string; experimentId?: string } = {}): Promise<RunResult[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (f.taskId) where.push("task_id = ?"), params.push(f.taskId);
    if (f.bundleId) where.push("bundle_id = ?"), params.push(f.bundleId);
    if (f.experimentId) where.push("experiment_id = ?"), params.push(f.experimentId);
    const sql = `SELECT doc FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at, id`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => parse<RunResult>(r.doc)!);
  }

  async putLabel(l: Label): Promise<void> {
    this.stmt(`INSERT INTO labels (id, session_id, criterion, value, note, by, ts) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, criterion = excluded.criterion, value = excluded.value,
        note = excluded.note, by = excluded.by, ts = excluded.ts`).run(
      l.id, l.sessionId, l.criterion, l.value, l.note ?? null, l.by, l.ts,
    );
  }

  async listLabels(f: { sessionId?: string; criterion?: string } = {}): Promise<Label[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (f.sessionId) where.push("session_id = ?"), params.push(f.sessionId);
    if (f.criterion) where.push("criterion = ?"), params.push(f.criterion);
    const sql = `SELECT * FROM labels ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts, id`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => {
      const l: Label = {
        id: r.id as string,
        sessionId: r.session_id as string,
        criterion: r.criterion as string,
        value: r.value as Label["value"],
        by: r.by as string,
        ts: num(r.ts)!,
      };
      if (typeof r.note === "string") l.note = r.note;
      return l;
    });
  }

  // ------------------------------------------------------------ kv

  async kvGet(key: string): Promise<string | undefined> {
    const r = this.stmt("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return str(r?.value);
  }

  async kvSet(key: string, value: string | undefined): Promise<void> {
    if (value === undefined) {
      this.stmt("DELETE FROM kv WHERE key = ?").run(key);
      return;
    }
    this.stmt(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, Date.now());
  }

  // ------------------------------------------------------------ datasets / experiments / judges

  async putDataset(ds: Dataset, opts: { note?: string; now?: number } = {}): Promise<{ version: string; created: boolean }> {
    return this.tx(() => {
      const exists = this.stmt("SELECT 1 FROM datasets WHERE id = ? AND version = ?").get(ds.id, ds.version);
      let created = false;
      if (!exists) {
        const createdAt = opts.now ?? ds.createdAt ?? Date.now();
        const stored: Dataset = { ...ds, createdAt };
        this.stmt("INSERT INTO datasets (id, version, name, cases, created_at, note, doc) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          ds.id, ds.version, ds.name, ds.cases.length, createdAt, opts.note ?? null, JSON.stringify(stored),
        );
        created = true;
      }
      this.stmt(`INSERT INTO dataset_latest (id, version) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET version = excluded.version`).run(ds.id, ds.version);
      return { version: ds.version, created };
    });
  }

  async getDataset(id: string, version = "latest"): Promise<Dataset | undefined> {
    let v = version;
    if (v === "latest") {
      const r = this.stmt("SELECT version FROM dataset_latest WHERE id = ?").get(id) as Row | undefined;
      if (!r) return undefined;
      v = r.version as string;
    }
    const r = this.stmt("SELECT doc FROM datasets WHERE id = ? AND version = ?").get(id, v) as Row | undefined;
    return parse<Dataset>(r?.doc);
  }

  async listDatasetVersions(id: string): Promise<DatasetVersionInfo[]> {
    const rows = this.stmt("SELECT version, cases, created_at, note FROM datasets WHERE id = ? ORDER BY rowid").all(id) as Row[];
    return rows.map((r) => {
      const info: DatasetVersionInfo = { version: r.version as string, cases: num(r.cases)!, createdAt: num(r.created_at)! };
      if (typeof r.note === "string") info.note = r.note;
      return info;
    });
  }

  async listDatasets(): Promise<DatasetListing[]> {
    const rows = this.stmt(`SELECT l.id, l.version AS latest, d.name, d.cases,
        (SELECT COUNT(*) FROM datasets x WHERE x.id = l.id) AS versions
      FROM dataset_latest l JOIN datasets d ON d.id = l.id AND d.version = l.version ORDER BY l.id`).all() as Row[];
    return rows.map((r) => ({ id: r.id as string, name: r.name as string, latest: r.latest as string, versions: num(r.versions)!, cases: num(r.cases)! }));
  }

  async putExperiment(r: ExperimentResult): Promise<void> {
    this.stmt(`INSERT INTO experiments (id, name, dataset_id, created_at, doc) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, dataset_id = excluded.dataset_id, created_at = excluded.created_at, doc = excluded.doc`).run(
      r.id, r.name, r.dataset.id, r.createdAt, JSON.stringify(r),
    );
  }

  async getExperiment(id: string): Promise<ExperimentResult | undefined> {
    const r = this.stmt("SELECT doc FROM experiments WHERE id = ?").get(id) as Row | undefined;
    return parse<ExperimentResult>(r?.doc);
  }

  async listExperiments(f: { datasetId?: string; name?: string; limit?: number } = {}): Promise<ExperimentResult[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.datasetId) where.push("dataset_id = ?"), params.push(f.datasetId);
    if (f.name) where.push("name = ?"), params.push(f.name);
    const sql = `SELECT doc FROM experiments ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    params.push(f.limit ?? -1); // SQLite: a negative LIMIT is no limit, LIMIT 0 is none
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => parse<ExperimentResult>(r.doc)!);
  }

  async putJudge(v: JudgeVersion): Promise<void> {
    this.stmt("INSERT INTO judges (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc").run(v.id, JSON.stringify(v));
  }

  async getJudge(id: string): Promise<JudgeVersion | undefined> {
    const r = this.stmt("SELECT doc FROM judges WHERE id = ?").get(id) as Row | undefined;
    return parse<JudgeVersion>(r?.doc);
  }

  async listJudges(): Promise<JudgeVersion[]> {
    return (this.stmt("SELECT doc FROM judges ORDER BY id").all() as Row[]).map((r) => parse<JudgeVersion>(r.doc)!);
  }

  // ------------------------------------------------------------ gc

  async *referencedBlobs(): AsyncIterable<BlobRef> {
    // UNION de-duplicates inside SQLite, so a blob shared by 1,000 events is yielded once.
    const sql = ["SELECT j.value AS ref FROM events, json_each(events.blobs) AS j WHERE events.blobs IS NOT NULL", ...BLOB_REF_FIELDS.map(refFieldSql)].join("\nUNION ");
    for (const r of this.db.prepare(sql).iterate() as IterableIterator<Row>) {
      if (typeof r.ref === "string") yield r.ref;
    }
  }

  async compact(): Promise<void> {
    this.db.exec("INSERT INTO events_fts(events_fts) VALUES ('optimize')");
    if (this.path !== ":memory:") this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.exec("VACUUM");
  }

  // ------------------------------------------------------------ serve capabilities

  async ping(): Promise<void> {
    this.stmt("SELECT 1").get();
  }

  /**
   * File lock on `<db>.writer.lock` (core/lock.ts): a dead holder on this host,
   * or one whose heartbeat stopped for 2 min, is broken. A lock file naming this
   * very pid that this process does not hold was left by an earlier run that
   * reused the pid (PID 1 in a restarted container), so it is broken too.
   */
  async acquireWriterLock(opts: { waitMs?: number } = {}): Promise<WriterLock | undefined> {
    const path = this.path === ":memory:" ? `:memory:${this.memId}` : `${this.path}.writer.lock`;
    if (heldWriterLocks.has(path)) return undefined;
    let lock: Lock | undefined;
    if (this.path !== ":memory:") {
      try {
        const holder = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; host?: string };
        if (holder.pid === process.pid && holder.host === hostname()) rmSync(path, { force: true });
      } catch {
        // no lock file, or a torn one: acquireLock judges it
      }
      try {
        lock = await acquireLock(path, { waitMs: opts.waitMs ?? 0 });
      } catch (e) {
        if (e instanceof LockBusyError) return undefined;
        throw e;
      }
    }
    heldWriterLocks.add(path);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        heldWriterLocks.delete(path);
        lock?.release();
      },
      // Fencing (core/lock.ts nonce): fails once another replica took the lease over.
      assertHeld: () => {
        if (released) throw new Error(`writer lock ${path} was released`);
        lock?.assertHeld();
      },
    };
  }

  async listProjects(): Promise<string[]> {
    return (this.stmt("SELECT DISTINCT project_id AS p FROM sessions").all() as { p: string }[]).map((r) => r.p).sort();
  }

  async deleteBefore(cutoffMs: number, opts: { project?: string } = {}): Promise<{ sessions: number; events: number }> {
    // Last activity (see IndexStore.deleteBefore), not the recorded end: a resumed session keeps
    // its first run's endedAt, and one that never sent session.end has none.
    const params: (string | number)[] = [cutoffMs, cutoffMs];
    let sql = `SELECT id FROM sessions s WHERE coalesce(ended_at, started_at) < ?
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.ts + coalesce(e.duration_ms, 0) >= ?)`;
    if (opts.project !== undefined) sql += " AND project_id = ?", params.push(opts.project);
    return this.tx(() => {
      // Selected inside the transaction so an event committed meanwhile is seen.
      const ids = (this.stmt(sql).all(...params) as Row[]).map((r) => r.id as string);
      let events = 0;
      // External-content FTS: remove each row's index entry with the text it was indexed under.
      // events.text is NULL or '' exactly when putEvents indexed nothing (searchableText undefined).
      const ftsDelete = this.stmt("INSERT INTO events_fts(events_fts, rowid, text) SELECT 'delete', rowid, text FROM events WHERE session_id = ? AND text IS NOT NULL AND text <> ''");
      const delEvents = this.stmt("DELETE FROM events WHERE session_id = ?");
      const delLabels = this.stmt("DELETE FROM labels WHERE session_id = ?");
      const delSession = this.stmt("DELETE FROM sessions WHERE id = ?");
      for (const id of ids) {
        ftsDelete.run(id);
        events += Number(delEvents.run(id).changes);
        delLabels.run(id);
        delSession.run(id);
      }
      return { sessions: ids.length, events };
    });
  }

  /** Approximate event count, for doctor/status output. */
  async countEvents(): Promise<number> {
    const r = this.stmt("SELECT COUNT(*) AS n FROM events").get() as Row;
    return num(r.n) ?? 0;
  }
}
