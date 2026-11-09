// Default IndexStore: a single SQLite file via node:sqlite (no native deps),
// loaded through ./sqlite-open.ts (which filters its ExperimentalWarning).
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { AgentEvent, BlobRef, Session } from "../schema/index.ts";
import type {
  EvalTask,
  EventCost,
  EventPage,
  EventQueryOpts,
  FacetCount,
  HarnessBundle,
  IndexStore,
  Label,
  MetricRow,
  RunResult,
  Score,
  ScoreConfig,
  ScoreFilter,
  SearchHit,
  SearchOpts,
  QueryOpts,
  SessionFilter,
  WriterLock,
} from "../core/types.ts";
import { compileWhere, facetSource, orderBy } from "../query/compile.ts";
import type { Query } from "../query/where.ts";
import { acquireLock, LockBusyError, type Lock } from "../core/lock.ts";
import type { Dataset, DatasetVersionInfo, ExperimentResult, JudgeVersion } from "../datasets/types.ts";
import type { DatasetListing } from "../core/types.ts";
import { BLOB_REF_FIELDS, type BlobRefField, ftsQuery, searchableText, SEARCHABLE_KINDS, searchTerms, snippet } from "./common.ts";
import { loadSqlite, switchToWal } from "./sqlite-open.ts";
import { runningUpgrade, describeStep, splitSql, UPGRADE_PROGRESS_MIN_ROWS, UpgradeProgress } from "./upgrade.ts";
import { labelToScore } from "../scores/labels.ts";

export { loadSqlite };

// ---------------------------------------------------------------- schema

interface Migration {
  version: number;
  sql: string;
  /**
   * Runs after `sql`, in the same transaction, for data changes SQL alone cannot compute.
   * A loop over events reports through `progress` (throttled; see ./upgrade.ts).
   */
  after?: (db: DatabaseSync, progress?: UpgradeProgress) => void;
  /** Leaves data in old event rows that only `coding.sh gc --compact` (SqliteIndexStore.compact) gives back. */
  compactAfter?: boolean;
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
    // This used to fill search_extra for every stored tool call and rebuild the index
    // (34 s on a 740k-event store). v10 indexes every event from scratch and no longer
    // keeps search_extra, and all pending migrations commit together, so that work is
    // left to v10: it computes the text of tool calls that have no search_extra.
  },
  {
    // Projects (coding.sh serve): 'default' is all unscoped data, read back as an unset field.
    version: 4,
    sql: `
ALTER TABLE events ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX sessions_project ON sessions(project_id, started_at DESC);
`,
    // events_project (project_id, ts) was created here too; no query used it and v10 drops it.
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
    // The 'rebuild' that repaired the index here is left to v10, which builds a new index
    // from the events (all pending migrations commit together).
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
  {
    // `--where` without scanning events (src/query/compile.ts). events.mcp holds a
    // tool call's MCP server (payload.server), written at insert like tool and ok.
    // The indexes answer the event keys at both levels: newest first for the Events
    // list (ts after the equality columns), session_id for "sessions with such an
    // event". events_ts serves the Events list when no clause has an index: it
    // reads newest first and stops at the page. session_facets keeps the distinct kind, tool and mcp values of each
    // session's events, so facet counts never touch the events table.
    version: 8,
    sql: `
ALTER TABLE events ADD COLUMN mcp TEXT;
UPDATE events SET mcp = json_extract(payload, '$.server') WHERE tool IS NOT NULL AND json_type(payload, '$.server') = 'text';
DROP INDEX events_kind;
DROP INDEX events_tool;
CREATE INDEX events_kind_ts ON events(kind, ts, session_id);
CREATE INDEX events_tool_ok ON events(tool, ok, ts, session_id) WHERE tool IS NOT NULL;
CREATE INDEX events_ok ON events(ok, ts, session_id) WHERE ok IS NOT NULL;
CREATE INDEX events_mcp ON events(mcp, ts, session_id) WHERE mcp IS NOT NULL;
CREATE INDEX events_ts ON events(ts);
CREATE TABLE session_facets (
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (key, value, session_id)
) WITHOUT ROWID;
CREATE INDEX session_facets_session ON session_facets(session_id);
INSERT OR IGNORE INTO session_facets (key, value, session_id) SELECT DISTINCT 'kind', kind, session_id FROM events WHERE kind <> '';
INSERT OR IGNORE INTO session_facets (key, value, session_id) SELECT DISTINCT 'tool', tool, session_id FROM events WHERE tool IS NOT NULL AND tool <> '';
INSERT OR IGNORE INTO session_facets (key, value, session_id) SELECT DISTINCT 'mcp', mcp, session_id FROM events WHERE mcp IS NOT NULL AND mcp <> '';
`,
  },
  {
    // Typed scores (src/scores). value holds numeric and boolean (1/0) values,
    // string_value categorical and text ones. Labels move into scores (pass and
    // fail as boolean, anything else as categorical) and `labels` becomes a view
    // that reads them back with the rules of src/scores/labels.ts, so SQL over
    // labels keeps working.
    version: 9,
    sql: `
CREATE TABLE scores (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  target_id TEXT NOT NULL,
  session_id TEXT,
  name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  value REAL,
  string_value TEXT,
  source TEXT NOT NULL,
  config_id TEXT,
  judge_version TEXT,
  calibrated INTEGER,
  comment TEXT,
  by TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX scores_target ON scores(target, target_id, name);
CREATE INDEX scores_session ON scores(session_id, name) WHERE session_id IS NOT NULL;
CREATE INDEX scores_name_ts ON scores(name, ts);
CREATE INDEX scores_ts ON scores(ts);
CREATE TABLE score_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  doc TEXT NOT NULL
);
INSERT OR IGNORE INTO scores (id, target, target_id, session_id, name, data_type, value, string_value, source, comment, by, ts)
  SELECT id, 'session', session_id, session_id, criterion,
    CASE WHEN value IN ('pass', 'fail') THEN 'boolean' ELSE 'categorical' END,
    CASE value WHEN 'pass' THEN 1 WHEN 'fail' THEN 0 END,
    CASE WHEN value IN ('pass', 'fail') THEN NULL ELSE value END,
    'human', note, by, ts
  FROM labels;
DROP TABLE labels;
CREATE VIEW labels AS
  SELECT id, session_id, name AS criterion,
    CASE WHEN data_type = 'boolean' THEN CASE WHEN value <> 0 THEN 'pass' ELSE 'fail' END ELSE string_value END AS value,
    comment AS note, by, ts,
    CASE WHEN target = 'case' THEN target_id END AS case_id
  FROM scores
  WHERE source = 'human' AND session_id IS NOT NULL AND target IN ('session', 'case')
    AND (data_type = 'boolean' OR (data_type = 'categorical' AND string_value IN ('pass', 'fail', 'skip')));
`,
  },
  {
    // A smaller index (TE-15):
    // - events_fts becomes contentless (contentless_delete=1) and is fed the search text
    //   at insert, so the tool text copied into search_extra (210 MB on a 756k-event
    //   store) is no longer needed. Snippets are cut in JS from the event (common.ts).
    // - cwd moves to the cwds lookup table (848 distinct paths over 756k rows).
    // - events_project goes: no query reads events by project.
    // The new index is built from events.text, the generated column of v5 (message text
    // or search_extra), and from the tool calls that have no search_extra (stores that
    // skipped v3's fill, see there), whose text is computed here.
    // Old rows keep their search_extra and inline cwd: emptying them rewrites every row,
    // which took over a minute on a 756k-event store. New rows never write them, reads
    // take an inline cwd as it is, and compact() (`gc --compact`, which the upgrade
    // suggests) empties them before its VACUUM. The columns stay in the schema: dropping
    // them would rewrite the table too.
    version: 10,
    compactAfter: true,
    sql: `
CREATE TABLE cwds (id INTEGER PRIMARY KEY, path TEXT NOT NULL);
CREATE INDEX cwds_path ON cwds(path);
ALTER TABLE events ADD COLUMN cwd_id INTEGER;
DROP INDEX IF EXISTS events_project;
CREATE VIRTUAL TABLE events_fts_v10 USING fts5(
  text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
);
`,
    after: (db, progress) => {
      const total = num((db.prepare("SELECT max(rowid) AS m FROM events").get() as Row).m) ?? 0;
      // One pass over the events: a tool call with no search_extra gets its text from JS.
      db.function("coding_sh_search_text", (kind, payload) => {
        const p = typeof payload === "string" ? parse<Record<string, unknown>>(payload) : undefined;
        return searchableText({ kind, payload: p ?? {} } as AgentEvent) ?? null;
      });
      // Kinds as SEARCHABLE_KINDS minus MESSAGE_SEARCH_KINDS in common.ts (written out so this migration never changes).
      const build = db.prepare(`INSERT INTO events_fts_v10 (rowid, text) SELECT rowid, t FROM (
        SELECT rowid, CASE WHEN text IS NOT NULL THEN text
          WHEN search_extra IS NULL AND kind IN ('tool.start', 'tool.end', 'subagent.start') THEN coding_sh_search_text(kind, payload) END AS t
        FROM events WHERE rowid > ? AND rowid <= ?) WHERE t IS NOT NULL`);
      const CHUNK = 20_000;
      for (let lo = 0; lo < total; lo += CHUNK) {
        const hi = Math.min(total, lo + CHUNK);
        build.run(lo, hi);
        progress?.step("search index", hi, total);
      }
      progress?.step("swapping in the new search index");
      db.exec("DROP TABLE events_fts");
      db.exec("ALTER TABLE events_fts_v10 RENAME TO events_fts");
      // A VIRTUAL generated column: dropping it rewrites nothing.
      db.exec("ALTER TABLE events DROP COLUMN text");
    },
  },
];

/** session_facets rows of one session, rebuilt from its events (SESSION_FACET_KEYS). */
const REBUILD_FACETS = `INSERT OR IGNORE INTO session_facets (key, value, session_id)
  SELECT 'kind', kind, session_id FROM events WHERE session_id = ? AND kind <> ''
  UNION SELECT 'tool', tool, session_id FROM events WHERE session_id = ? AND tool IS NOT NULL AND tool <> ''
  UNION SELECT 'mcp', mcp, session_id FROM events WHERE session_id = ? AND mcp IS NOT NULL AND mcp <> ''`;

export const SQLITE_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Whether events_fts is sound and indexes exactly the events that have search text.
 *
 * events_fts is contentless (v10): putEvents feeds it searchableText(event), and
 * events without text (session starts, model calls and the like) have no entry.
 * This runs FTS5's check of the index itself, then checks it against the events:
 * every entry belongs to an event of a searchable kind, and every event with search
 * text has an entry. Only events of a searchable kind with
 * no entry are read in full, so a sound index is checked without parsing payloads.
 */
export function searchIndexOk(db: DatabaseSync): boolean {
  try {
    db.exec("INSERT INTO events_fts(events_fts) VALUES ('integrity-check')");
  } catch {
    return false;
  }
  if (db.prepare("SELECT 1 FROM events_fts_docsize d WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.rowid = d.id) LIMIT 1").get()) return false;
  if (db.prepare(`SELECT 1 FROM events_fts_docsize d JOIN events e ON e.rowid = d.id WHERE e.kind NOT IN (${sqlList(SEARCHABLE_KINDS)}) LIMIT 1`).get()) return false;
  const unindexed = db.prepare(`SELECT kind, payload FROM events e WHERE kind IN (${sqlList(SEARCHABLE_KINDS)})
    AND NOT EXISTS (SELECT 1 FROM events_fts_docsize d WHERE d.id = e.rowid)`);
  for (const r of unindexed.iterate() as IterableIterator<Row>) {
    if (searchableText({ kind: r.kind, payload: parse<Record<string, unknown>>(r.payload) ?? {} } as AgentEvent) !== undefined) return false;
  }
  // No check of the averages record's row count: a contentless_delete delete cannot
  // know the tokens it removes, so FTS5 leaves the totals (bm25's averages) as they were.
  return true;
}

// ---------------------------------------------------------------- row mapping

type Row = Record<string, unknown>;

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = <T>(v: unknown): T | undefined => (typeof v === "string" ? (JSON.parse(v) as T) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined);

function rowToScore(r: Row): Score {
  const dataType = r.data_type as Score["dataType"];
  const value = dataType === "boolean" ? num(r.value) !== 0 : dataType === "numeric" ? num(r.value)! : (r.string_value as string);
  const sc: Score = {
    id: r.id as string,
    target: r.target as Score["target"],
    targetId: r.target_id as string,
    ...(typeof r.session_id === "string" ? { sessionId: r.session_id } : {}),
    name: r.name as string,
    dataType,
    value,
    source: r.source as Score["source"],
    by: r.by as string,
    ts: num(r.ts)!,
  };
  if (typeof r.config_id === "string") sc.configId = r.config_id;
  if (typeof r.judge_version === "string") sc.judgeVersion = r.judge_version;
  if (r.calibrated !== null && r.calibrated !== undefined) sc.calibrated = num(r.calibrated) !== 0;
  if (typeof r.comment === "string") sc.comment = r.comment;
  return sc;
}

/** kv key of a session's saved fold (IndexStore.getSessionFold). */
const foldKey = (sessionId: string): string => `fold:${sessionId}`;

/** The columns rowToEvent reads, for events aliased `a`: every column plus the cwd path (v10 cwds table). */
const eventCols = (a: string): string => `${a}.*, (SELECT path FROM cwds WHERE cwds.id = ${a}.cwd_id) AS cwd_path`;

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
  // v10 keeps cwd in the cwds table (EVENT_COLS reads it back as cwd_path).
  set("cwd", str(r.cwd) ?? str(r.cwd_path));
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

/** A search matching more events than this lists them newest first instead of ranking them all (TE-8). */
export const SEARCH_RANK_MAX_MATCHES = 20_000;

/** Per-connection page cache, in KiB (negative cache_size = KiB, not pages). Bounded RAM, freed on close. */
const CACHE_SIZE_KIB = 16_000;

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

/** queryEvents' cursor: `<ts>:<rowid>` of the last event on the page before. */
function parseEventCursor(c: string | undefined): { ts: number; rowid: number } | undefined {
  if (!c) return undefined;
  const m = /^(-?\d+(?:\.\d+)?):(\d{1,18})$/.exec(c);
  if (!m) throw new RangeError("bad events cursor");
  return { ts: Number(m[1]), rowid: Number(m[2]) };
}

/** WHERE parts for a SessionFilter; `p` prefixes column names ("s." when sessions is aliased). */
function filterSql(f: Omit<SessionFilter, "limit" | "offset">, p: string): { where: string[]; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.agent) where.push(`${p}agent = ?`), params.push(f.agent);
  if (f.parentSessionId === null) where.push(`${p}parent_session_id IS NULL`);
  else if (f.parentSessionId !== undefined) where.push(`${p}parent_session_id = ?`), params.push(f.parentSessionId);
  if (f.repoRoot) where.push(`${p}repo_root = ?`), params.push(f.repoRoot);
  if (f.runId === null) where.push(`${p}run_id IS NULL`);
  else if (f.runId !== undefined) where.push(`${p}run_id = ?`), params.push(f.runId);
  if (f.flag) where.push(`EXISTS (SELECT 1 FROM json_each(${p || "sessions."}flags) WHERE value = ?)`), params.push(f.flag);
  if (f.since !== undefined) where.push(`${p}started_at >= ?`), params.push(f.since);
  if (f.until !== undefined) where.push(`${p}started_at < ?`), params.push(f.until);
  if (f.project !== undefined) where.push(`${p}project_id = ?`), params.push(f.project);
  return { where, params };
}

// ---------------------------------------------------------------- store

const BUSY_TIMEOUT_MS = 5000;
/** A reset WAL is truncated to this many bytes (PRAGMA journal_size_limit). */
export const WAL_SIZE_LIMIT = 64 * 1024 * 1024;
/** How long a checkpoint after a bulk write waits for readers. */
const CHECKPOINT_WAIT_MS = 2000;
/** close() barely waits: it runs at the end of every command, and a later close or bulk write finishes what it can't. */
const CLOSE_CHECKPOINT_WAIT_MS = 50;

export interface SqliteIndexOptions {
  /** Open read-only (no migrations). */
  readOnly?: boolean;
  /**
   * Runs before pending migrations (schema `from` → `to`); throws to refuse them and
   * leave the file as it is (core/store-guard.ts: another install owns the store).
   */
  beforeMigrate?: (from: number, to: number) => void;
  /** Where upgrade progress lines go (each ends in a newline). Default: stderr. */
  progress?: (line: string) => void;
  /** Events a store must hold before an upgrade reports progress. Default: UPGRADE_PROGRESS_MIN_ROWS. */
  progressMinRows?: number;
  /** Matches above which search lists newest first instead of by rank. Default: SEARCH_RANK_MAX_MATCHES. */
  searchRankMaxMatches?: number;
}

export class SqliteIndexStore implements IndexStore {
  readonly kind = "sqlite";
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  private closed = false;
  private static memSeq = 0;
  private readonly memId = SqliteIndexStore.memSeq++;

  private readonly readOnly: boolean;
  private readonly opts: SqliteIndexOptions;

  private constructor(db: DatabaseSync, path: string, opts: SqliteIndexOptions) {
    this.db = db;
    this.path = path;
    this.readOnly = opts.readOnly ?? false;
    this.opts = { progress: (line) => void process.stderr.write(line), progressMinRows: UPGRADE_PROGRESS_MIN_ROWS, ...opts };
  }

  /** Opens (creating if needed) the database at `path` (":memory:" for tests) and migrates it. */
  static async open(path: string, opts: SqliteIndexOptions = {}): Promise<SqliteIndexStore> {
    const { DatabaseSync } = await loadSqlite();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, { readOnly: opts.readOnly ?? false });
    try {
      // busy_timeout first so the WAL switch itself waits on a concurrent writer.
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      if (!opts.readOnly) await switchToWal(db);
      db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
      // A WAL that a checkpoint has reset is cut back to this size instead of keeping its high-water mark.
      if (!opts.readOnly) db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT}`);
      // RAM-only cache tuning: a larger page cache (bounded, freed on close) and
      // in-memory temp b-trees (sorts, FTS merges). The default cache is ~2 MB; a
      // few thousand events spill it, so ingest and the reads that fold a session
      // re-decode pages this keeps resident. No effect on the on-disk file or its
      // locking, so it is safe for read-only connections and on Windows.
      db.exec(`PRAGMA cache_size = -${CACHE_SIZE_KIB}; PRAGMA temp_store = MEMORY;`);
      const store = new SqliteIndexStore(db, path, opts);
      if (!opts.readOnly) await store.migrate();
      return store;
    } catch (e) {
      // A store that can't be opened (a newer schema, a failed migration) must not keep
      // the file open: Windows can't delete or replace an open file.
      db.close();
      throw e;
    }
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
        this.cwdIds.clear();
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
      this.cwdIds.clear();
      throw err;
    }
  }

  /** cwds ids by path; cleared on rollback, which may have undone an id it holds. */
  private readonly cwdIds = new Map<string, number>();

  /** The cwds row of a path, added if new (the caller holds the transaction). */
  private cwdId(path: string): number {
    let id = this.cwdIds.get(path);
    if (id === undefined) {
      id = num((this.stmt("SELECT min(id) AS id FROM cwds WHERE path = ?").get(path) as Row).id) ?? Number(this.stmt("INSERT INTO cwds (path) VALUES (?)").run(path).lastInsertRowid);
      this.cwdIds.set(path, id);
    }
    return id;
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
      this.cwdIds.clear();
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  private schemaVersion(): number {
    const current = num((this.db.prepare("SELECT MAX(version) AS v FROM migrations").get() as Row | undefined)?.v) ?? 0;
    if (current > SQLITE_SCHEMA_VERSION) {
      throw new Error(`${this.path} uses index schema v${current}, but this coding.sh only knows up to v${SQLITE_SCHEMA_VERSION}. Upgrade coding.sh.`);
    }
    return current;
  }

  /**
   * Brings the schema to SQLITE_SCHEMA_VERSION. Every pending migration runs in one
   * transaction, so no reader ever sees a half-upgraded store and a failed upgrade
   * leaves it as it was. On a store of UPGRADE_PROGRESS_MIN_ROWS events or more it
   * prints progress to stderr (see ./upgrade.ts) and, when it rewrote the events,
   * suggests `coding.sh gc --compact` to give the freed space back. A process that
   * finds another one upgrading waits for it and says so.
   */
  async migrate(): Promise<void> {
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const current = this.schemaVersion();
    if (current === SQLITE_SCHEMA_VERSION) return;
    // core/store-guard.ts: another install owns this store, so leave its schema as it is.
    this.opts.beforeMigrate?.(current, SQLITE_SCHEMA_VERSION);
    // The highest rowid stands for the event count: read from the b-tree's edge, no scan.
    const rows = current === 0 ? 0 : (num((this.db.prepare("SELECT max(rowid) AS n FROM events").get() as Row).n) ?? 0);
    const report = rows >= this.opts.progressMinRows! ? this.opts.progress : undefined;
    const progress = new UpgradeProgress(this.path, current, SQLITE_SCHEMA_VERSION, rows, report);
    await this.lockForUpgrade(report);
    let ok = false;
    let rewrote = false;
    try {
      // Another process (the background hook ingest, a second CLI) may have upgraded while this one waited.
      const from = this.schemaVersion();
      if (from < SQLITE_SCHEMA_VERSION) progress.begin();
      const record = this.db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)");
      for (const m of MIGRATIONS) {
        if (m.version <= from) continue;
        for (const statement of splitSql(m.sql)) {
          progress.step(`schema v${m.version} of v${SQLITE_SCHEMA_VERSION}`);
          this.db.exec(statement);
        }
        m.after?.(this.db, progress);
        record.run(m.version, Date.now());
        if (m.compactAfter && from > 0) rewrote = true;
      }
      this.db.exec("COMMIT");
      ok = true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      progress.end(ok, rewrote ? "Run `coding.sh gc --compact` to give back the space the old layout used." : undefined);
    }
  }

  /**
   * BEGIN IMMEDIATE for migrate(). While another process holds the write lock to upgrade
   * the index (it keeps `<db>.upgrade`), this waits as long as that process lives and
   * prints how far it is once a second; any other writer gets the usual busy timeout.
   */
  private async lockForUpgrade(report: ((line: string) => void) | undefined): Promise<void> {
    const started = Date.now();
    let lastPrint = 0;
    this.db.exec("PRAGMA busy_timeout = 200");
    try {
      for (;;) {
        try {
          this.db.exec("BEGIN IMMEDIATE");
          return;
        } catch (e) {
          if ((e as { errcode?: number }).errcode !== 5) throw e;
        }
        const other = this.path === ":memory:" ? undefined : runningUpgrade(this.path);
        if (!other && Date.now() - started >= BUSY_TIMEOUT_MS) throw new Error(`${this.path} is locked by another process (database is locked)`);
        if (other && Date.now() - lastPrint >= 1000) {
          lastPrint = Date.now();
          // Always said, even on a small store: this process is blocked on another one.
          (report ?? this.opts.progress)?.(`coding.sh: waiting for another coding.sh (pid ${other.pid}) to finish upgrading the index: ${describeStep(other)}\n`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // SQLite folds the WAL in on the last connection's close only; with a reader still open
    // (the viewer, another command) the file would keep every frame this connection wrote.
    await this.checkpoint("TRUNCATE", CLOSE_CHECKPOINT_WAIT_MS);
    this.closed = true;
    this.stmts.clear();
    this.db.close();
  }

  /**
   * Copies the WAL into the database and, with TRUNCATE, empties the WAL file. Waits at most
   * `waitMs` for readers on an older snapshot, then leaves what they still need (a later
   * checkpoint or the last close finishes it). Never throws.
   */
  async checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "TRUNCATE", waitMs = CHECKPOINT_WAIT_MS): Promise<void> {
    if (this.closed || this.readOnly || this.path === ":memory:") return;
    try {
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`);
      this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
    } catch {
      // busy or locked: the WAL stays as it is until the next checkpoint
    } finally {
      try {
        this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      } catch {
        // nothing to restore on a connection that failed
      }
    }
  }

  // ------------------------------------------------------------ events

  async putEvents(batch: AgentEvent[]): Promise<{ inserted: number }> {
    if (!batch.length) return { inserted: 0 };
    return this.tx(() => ({ inserted: this.insertEvents(batch) }));
  }

  async replaceSessionEvents(sessionId: string, removeIds: string[], add: AgentEvent[]): Promise<{ removed: number; inserted: number }> {
    // Contentless FTS with contentless_delete: an entry is removed by rowid (see deleteBefore).
    const ftsDelete = this.stmt(`DELETE FROM events_fts WHERE rowid = (SELECT rowid FROM events WHERE id = ? AND session_id = ? AND kind IN (${sqlList(SEARCHABLE_KINDS)}))`);
    const del = this.stmt("DELETE FROM events WHERE id = ? AND session_id = ?");
    return this.tx(() => {
      let removed = 0;
      for (const id of new Set(removeIds)) {
        ftsDelete.run(id, sessionId);
        removed += Number(del.run(id, sessionId).changes);
      }
      this.stmt("DELETE FROM kv WHERE key = ?").run(foldKey(sessionId));
      if (removed) {
        // A removed event may have been the session's only one with a tool or kind.
        this.stmt("DELETE FROM session_facets WHERE session_id = ?").run(sessionId);
        this.stmt(REBUILD_FACETS).run(sessionId, sessionId, sessionId);
      }
      return { removed, inserted: this.insertEvents(add) };
    });
  }

  /** INSERT OR IGNORE plus FTS rows; the caller holds the transaction. Returns rows inserted. */
  private insertEvents(batch: AgentEvent[]): number {
    const insert = this.stmt(`INSERT OR IGNORE INTO events
      (id, session_id, turn_id, parent_id, ts, duration_ms, trace_id, span_id, parent_span_id, subagent_id,
       agent, agent_version, model, kind, tool, ok, run_id, cwd_id, repo, payload, blobs, usage, source, project_id, mcp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const fts = this.stmt("INSERT INTO events_fts (rowid, text) VALUES (?, ?)");
    const facet = this.stmt("INSERT OR IGNORE INTO session_facets (key, value, session_id) VALUES (?, ?, ?)");
    // A session repeats a handful of (key, value) facets across hundreds of events,
    // and session_facets' PRIMARY KEY (key, value, session_id) makes every repeat an
    // INSERT OR IGNORE no-op that still probes the b-tree. Skipping tuples already
    // issued in this batch leaves the table identical and cuts most of those probes.
    const facetSeen = new Set<string>();
    const addFacet = (key: string, value: string, sid: string) => {
      const k = `${key}\0${value}\0${sid}`;
      if (facetSeen.has(k)) return;
      facetSeen.add(k);
      facet.run(key, value, sid);
    };
    let inserted = 0;
    for (const e of batch) {
      const p = e.payload ?? {};
      const tool = typeof p.tool === "string" ? p.tool : null;
      const ok = typeof p.ok === "boolean" ? (p.ok ? 1 : 0) : null;
      const mcp = tool !== null && typeof p.server === "string" ? p.server : null;
      const r = insert.run(
        e.id, e.sessionId, e.turnId ?? null, e.parentId ?? null, e.ts, e.durationMs ?? null, e.traceId ?? null,
        e.spanId ?? null, e.parentSpanId ?? null, e.subagentId ?? null, e.agent, e.agentVersion ?? null,
        e.model ?? null, e.kind, tool, ok, e.runId ?? null, e.cwd ? this.cwdId(e.cwd) : null, json(e.repo), JSON.stringify(p),
        e.blobs?.length ? JSON.stringify(e.blobs) : null, json(e.usage), e.source ?? null,
        projectCol(e.project), mcp,
      );
      if (Number(r.changes) === 0) continue;
      inserted++;
      // session_facets (SESSION_FACET_KEYS): most inserts find the row there already.
      if (e.kind) addFacet("kind", e.kind, e.sessionId);
      if (tool) addFacet("tool", tool, e.sessionId);
      if (mcp) addFacet("mcp", mcp, e.sessionId);
      // The contentless FTS keeps no text: search cuts snippets from searchableText of the row it reads.
      const text = searchableText(e);
      if (text !== undefined) fts.run(r.lastInsertRowid, text);
    }
    return inserted;
  }

  async setEventCosts(costs: EventCost[]): Promise<number> {
    if (!costs.length) return 0;
    // Only usage, payload.costEstimated, payload.pricedAs and payload.priceTier: message text (the FTS source) never changes here.
    const update = this.stmt(
      "UPDATE events SET usage = json_set(coalesce(usage, '{}'), '$.costUsd', ?), payload = json_patch(json_set(json_remove(payload, '$.pricedAs', '$.priceTier'), '$.costEstimated', json('true')), ?) WHERE id = ?",
    );
    // Folds hold the old costs: drop those of the sessions touched.
    const dropFold = this.stmt("DELETE FROM kv WHERE key = (SELECT 'fold:' || session_id FROM events WHERE id = ?)");
    return this.tx(() => {
      let found = 0;
      for (const { id, costUsd, pricedAs, priceTier } of costs) {
        const set = JSON.stringify({ ...(pricedAs ? { pricedAs } : {}), ...(priceTier ? { priceTier } : {}) });
        const n = Number(update.run(costUsd, set, id).changes);
        if (n) dropFold.run(id);
        found += n;
      }
      return found;
    });
  }

  async listEvents(sessionId: string, opts: { kinds?: string[]; limit?: number; offset?: number } = {}): Promise<AgentEvent[]> {
    const params: (string | number)[] = [sessionId];
    let sql = `SELECT ${eventCols("events")} FROM events WHERE session_id = ?`;
    if (opts.kinds?.length) {
      sql += ` AND kind IN (${opts.kinds.map(() => "?").join(", ")})`;
      params.push(...opts.kinds);
    }
    sql += " ORDER BY ts, rowid LIMIT ? OFFSET ?";
    params.push(opts.limit ?? -1, opts.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToEvent);
  }

  async search(text: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    return this.searchHits(text, opts);
  }

  /**
   * search() and searchWhere(). Hits are ranked by bm25 inside the FTS table, and only
   * the page of hits is joined to events; a term that matches more than
   * SEARCH_RANK_MAX_MATCHES events is listed newest first (by rowid) instead, because
   * ranking every match costs more than the answer is worth (TE-8: "the" matches 177k).
   * Snippets are cut in JS from the event's search text: the contentless index keeps none.
   */
  private searchHits(text: string, opts: SearchOpts, q?: Query): SearchHit[] {
    const fts = ftsQuery(text);
    if (!fts) return [];
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.agent) where.push("e.agent = ?"), params.push(opts.agent);
    if (opts.project !== undefined) where.push("e.project_id = ?"), params.push(opts.project);
    if (q?.root) {
      const c = compileWhere(q.root, "event");
      where.push(c.sql);
      params.push(...c.params);
    }
    const limit = opts.limit ?? 50;
    const sessions = q?.root ? "LEFT JOIN sessions s ON s.id = e.session_id" : "";
    const cond = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const cap = this.opts.searchRankMaxMatches ?? SEARCH_RANK_MAX_MATCHES;
    const count = this.stmt("SELECT count(*) AS n FROM (SELECT 1 FROM events_fts WHERE events_fts MATCH ? LIMIT ?)");
    const over = (match: string) => num((count.get(match, cap + 1) as Row).n)! > cap;
    // The last term as a whole word matches a subset of it as a prefix, and costs a few ms
    // where the prefix ("the*": then, there, these, …) merges every matching word's list.
    const many = over(fts.slice(0, -1)) || over(fts);
    let sql: string;
    let args: (string | number)[];
    if (many) {
      sql = `SELECT ${eventCols("e")} FROM events_fts JOIN events e ON e.rowid = events_fts.rowid ${sessions}
        WHERE events_fts MATCH ? ${where.length ? `AND ${where.join(" AND ")}` : ""} ORDER BY events_fts.rowid DESC LIMIT ?`;
      args = [fts, ...params, limit];
    } else {
      // Unfiltered, the FTS table ranks and cuts the page itself; filtered, it ranks its (at most
      // SEARCH_RANK_MAX_MATCHES) matches and the join keeps the best that pass.
      const page = where.length ? "" : "ORDER BY rank LIMIT ?";
      sql = `SELECT ${eventCols("e")} FROM (SELECT rowid AS r, rank AS rk FROM events_fts WHERE events_fts MATCH ? ${page}) f
        JOIN events e ON e.rowid = f.r ${sessions} ${cond} ORDER BY f.rk, e.ts DESC LIMIT ?`;
      args = where.length ? [fts, ...params, limit] : [fts, limit, limit];
    }
    const terms = searchTerms(text);
    // A --where query compiles to new SQL each time: prepared once, not cached.
    return ((q?.root ? this.db.prepare(sql) : this.stmt(sql)).all(...args) as Row[]).map((r) => {
      const event = rowToEvent(r);
      return { event, snippet: snippet(searchableText(event) ?? "", terms) };
    });
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

  async sessionsWithoutRow(): Promise<{ sessionId: string; agent: string }[]> {
    // One pass over the events' session index (0.5 s for 2.8M events), a primary-key probe per session.
    const rows = this.stmt(
      "SELECT e.session_id AS id, MIN(e.agent) AS agent FROM events e WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id) GROUP BY e.session_id ORDER BY e.session_id",
    ).all() as Row[];
    return rows.map((r) => ({ sessionId: String(r.id), agent: String(r.agent) }));
  }

  async eventsByIdPrefix(prefix: string, limit: number): Promise<AgentEvent[]> {
    const rows = this.stmt(`SELECT ${eventCols("events")} FROM events WHERE id >= ? AND id < ? ORDER BY id LIMIT ?`).all(prefix, `${prefix}\u{10FFFF}`, limit) as Row[];
    return rows.map(rowToEvent).filter((e) => e.id.startsWith(prefix));
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
    const { where, params } = filterSql(f, "");
    const sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY started_at DESC, id LIMIT ? OFFSET ?`;
    params.push(f.limit ?? -1, f.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToSession);
  }

  // ------------------------------------------------------------ --where (src/query)

  async querySessions(q: Query, o: QueryOpts = {}): Promise<Session[]> {
    const { where, params } = filterSql(o.filter ?? {}, "s.");
    if (q.root) {
      const c = compileWhere(q.root, "session");
      where.push(c.sql);
      params.push(...c.params);
    }
    const sql = `SELECT s.* FROM sessions s ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${orderBy(q.sort)} LIMIT ? OFFSET ?`;
    params.push(o.limit ?? -1, o.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToSession);
  }

  async queryFacets(q: Query, key: string, o: QueryOpts = {}): Promise<FacetCount[]> {
    const src = facetSource(key);
    const { where, params } = filterSql(o.filter ?? {}, "s.");
    if (q.root) {
      const c = compileWhere(q.root, "session");
      where.push(c.sql);
      params.push(...c.params);
    }
    const like = (x: string) => x.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    if (src.prefix) where.push("j.value LIKE ? ESCAPE '\\'"), params.push(`${like(src.prefix)}%`);
    if (src.facetKey) where.unshift("f.key = ?"), params.unshift(src.facetKey);
    // Autocomplete: values starting with what was typed (LIKE folds ASCII case, as match.ts).
    const typed = o.prefix ? " AND v LIKE ? ESCAPE '\\'" : "";
    const sql = `SELECT v, COUNT(DISTINCT sid) AS n FROM (SELECT ${src.value} AS v, s.id AS sid FROM ${src.from} ${where.length ? `WHERE ${where.join(" AND ")}` : ""})
      WHERE v IS NOT NULL AND v <> ''${typed} GROUP BY v ORDER BY n DESC, v LIMIT ?`;
    if (o.prefix) params.push(`${like(o.prefix)}%`);
    params.push(o.limit ?? 20);
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({ value: String(r.v), count: num(r.n) ?? 0 }));
  }

  async metricRows(q: Query, o: QueryOpts = {}): Promise<MetricRow[]> {
    const { where, params } = filterSql(o.filter ?? {}, "s.");
    if (q.root) {
      const c = compileWhere(q.root, "session");
      where.push(c.sql);
      params.push(...c.params);
    }
    // Only the numbers metrics add up, read with json_extract: no full stats parse per session.
    const x = (path: string) => `json_extract(s.stats, '$.${path}')`;
    const cols = ["usage.inputTokens", "usage.outputTokens", "usage.cacheReadTokens", "usage.cacheWriteTokens", "usage.costUsd", "usage.estimatedCostUsd", "toolCalls", "toolErrors", "latency.llmCalls", "llmErrors.count", "latency.llmP95Ms", "latency.ttftP50Ms"];
    const sql = `SELECT s.started_at, s.agent, s.model, coalesce(s.repo_root, s.cwd) AS dir, s.flags, ${cols.map((c, i) => `${x(c)} AS c${i}`).join(", ")}
      FROM sessions s ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd", "estimatedCostUsd", "toolCalls", "toolErrors", "llmCalls", "llmErrors", "llmP95Ms", "ttftP50Ms"] as const;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => {
      const m: MetricRow = { startedAt: num(r.started_at) ?? 0, agent: String(r.agent), flags: parse<string[]>(r.flags) ?? [], toolCalls: 0, toolErrors: 0 };
      if (typeof r.model === "string") m.model = r.model;
      if (typeof r.dir === "string") m.dir = r.dir;
      keys.forEach((k, i) => {
        const v = num(r[`c${i}`]);
        if (v !== undefined) m[k] = v;
      });
      return m;
    });
  }

  async queryEvents(q: Query, o: EventQueryOpts = {}): Promise<EventPage> {
    const { where, params } = filterSql(o.filter ?? {}, "s.");
    if (q.root) {
      const c = compileWhere(q.root, "event");
      where.push(c.sql);
      params.push(...c.params);
    }
    const base = `FROM events e JOIN sessions s ON s.id = e.session_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    const cur = parseEventCursor(o.cursor);
    const page = cur ? `${where.length ? "AND" : "WHERE"} (e.ts < ? OR (e.ts = ? AND e.rowid < ?))` : "";
    const limit = o.limit ?? 50;
    // The inner query picks the page from index columns alone (ts, rowid); only the
    // rows on the page are read in full, so a broad match never sorts payloads.
    const sql = `SELECT e.rowid AS rid, ${eventCols("e")} FROM events e WHERE e.rowid IN (
        SELECT e.rowid ${base} ${page} ORDER BY e.ts DESC, e.rowid DESC LIMIT ?)
      ORDER BY e.ts DESC, e.rowid DESC`;
    const rows = this.db.prepare(sql).all(...params, ...(cur ? [cur.ts, cur.ts, cur.rowid] : []), limit + 1) as Row[];
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    const out: EventPage = { items: items.map(rowToEvent) };
    const last = items[items.length - 1];
    if (more && last) out.next = `${num(last.ts)}:${num(last.rid)}`;
    if (o.countUpTo !== undefined) {
      const cap = Math.max(0, Math.floor(o.countUpTo));
      // A first page that is not full already holds every match.
      const n = !more && !cur ? items.length : (num((this.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${base} LIMIT ?)`).get(...params, cap + 1) as Row).n) ?? 0);
      out.total = Math.min(n, cap);
      if (n > cap) out.totalCapped = true;
    }
    return out;
  }

  async searchWhere(text: string, q: Query, opts: SearchOpts = {}): Promise<SearchHit[]> {
    return this.searchHits(text, opts, q);
  }

  // ------------------------------------------------------------ cursors

  async getCursor(source: string): Promise<number> {
    const r = this.stmt("SELECT offset FROM cursors WHERE source = ?").get(source) as Row | undefined;
    return num(r?.offset) ?? 0;
  }

  /** 0 is where every cursor starts, so a cursor set back to 0 (gc removed its spool file) is not kept. */
  async setCursor(source: string, offset: number): Promise<void> {
    if (offset === 0) {
      this.stmt("DELETE FROM cursors WHERE source = ?").run(source);
      return;
    }
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

  // Labels are human scores (src/scores/labels.ts); the labels view reads them back.
  async putLabel(l: Label): Promise<void> {
    await this.putScore(labelToScore(l));
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
      if (typeof r.case_id === "string") l.caseId = r.case_id;
      if (typeof r.note === "string") l.note = r.note;
      return l;
    });
  }

  // ------------------------------------------------------------ scores

  async putScore(sc: Score): Promise<void> {
    const numeric = sc.dataType === "numeric" || sc.dataType === "boolean";
    this.stmt(`INSERT INTO scores (id, target, target_id, session_id, name, data_type, value, string_value, source, config_id, judge_version, calibrated, comment, by, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET target = excluded.target, target_id = excluded.target_id, session_id = excluded.session_id, name = excluded.name,
        data_type = excluded.data_type, value = excluded.value, string_value = excluded.string_value, source = excluded.source,
        config_id = excluded.config_id, judge_version = excluded.judge_version, calibrated = excluded.calibrated,
        comment = excluded.comment, by = excluded.by, ts = excluded.ts`).run(
      sc.id, sc.target, sc.targetId, sc.sessionId ?? null, sc.name, sc.dataType,
      numeric ? (typeof sc.value === "boolean" ? (sc.value ? 1 : 0) : Number(sc.value)) : null,
      numeric ? null : String(sc.value),
      sc.source, sc.configId ?? null, sc.judgeVersion ?? null, sc.calibrated === undefined ? null : sc.calibrated ? 1 : 0,
      sc.comment ?? null, sc.by, sc.ts,
    );
  }

  async listScores(f: ScoreFilter = {}): Promise<Score[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    const eq = (col: string, v: string | undefined) => {
      if (v !== undefined) where.push(`${col} = ?`), params.push(v);
    };
    eq("id", f.id);
    eq("target", f.target);
    eq("target_id", f.targetId);
    eq("session_id", f.sessionId);
    eq("name", f.name);
    eq("source", f.source);
    if (f.since !== undefined) where.push("ts >= ?"), params.push(f.since);
    if (f.until !== undefined) where.push("ts < ?"), params.push(f.until);
    let sql = `SELECT * FROM scores ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC, id DESC`;
    if (f.limit !== undefined) sql += " LIMIT ?", params.push(Math.max(0, Math.floor(f.limit)));
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToScore);
  }

  async putScoreConfig(c: ScoreConfig): Promise<void> {
    this.stmt(`INSERT INTO score_configs (id, name, data_type, doc) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, data_type = excluded.data_type, doc = excluded.doc`).run(c.id, c.name, c.dataType, JSON.stringify(c));
  }

  async listScoreConfigs(): Promise<ScoreConfig[]> {
    return (this.stmt("SELECT doc FROM score_configs ORDER BY name, id").all() as Row[]).map((r) => parse<ScoreConfig>(r.doc)!);
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

  // ------------------------------------------------------------ session folds

  // The rowid is the seq: SQLite gives each new row one above the highest in the table.
  async listEventsSince(sessionId: string, since: { seq: number; ts: number }): Promise<{ events: AgentEvent[]; seq: number }> {
    const rows = (
      since.seq > 0
        ? this.stmt(`SELECT rowid AS seq_, ${eventCols("events")} FROM events WHERE session_id = ? AND (ts > ? OR rowid > ?) ORDER BY ts, rowid`).all(sessionId, Number.isFinite(since.ts) ? since.ts : -Number.MAX_VALUE, since.seq)
        : this.stmt(`SELECT rowid AS seq_, ${eventCols("events")} FROM events WHERE session_id = ? ORDER BY ts, rowid`).all(sessionId)
    ) as Row[];
    let seq = since.seq;
    for (const r of rows) seq = Math.max(seq, Number(r.seq_));
    return { events: rows.map(rowToEvent), seq };
  }

  // Kept in kv under fold:<session id>, as a blob.
  async getSessionFold(sessionId: string): Promise<Uint8Array | undefined> {
    const r = this.stmt("SELECT value FROM kv WHERE key = ?").get(foldKey(sessionId)) as Row | undefined;
    return r?.value instanceof Uint8Array ? r.value : undefined;
  }

  async putSessionFold(sessionId: string, fold: Uint8Array | undefined): Promise<void> {
    if (!fold) {
      this.stmt("DELETE FROM kv WHERE key = ?").run(foldKey(sessionId));
      return;
    }
    this.stmt(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(foldKey(sessionId), fold, Date.now());
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
    this.slimEvents();
    this.db.exec("INSERT INTO events_fts(events_fts) VALUES ('optimize')");
    // Rows of cursors at 0 (spool files gc removed) from before setCursor stopped keeping them.
    this.db.exec("DELETE FROM cursors WHERE offset = 0");
    if (this.path !== ":memory:") this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.exec("VACUUM");
  }

  /**
   * Empties what rows written before v10 still hold (see the v10 migration): the
   * search_extra copy of their tool text and an inline cwd, which moves to cwds. One
   * transaction per chunk of rows, so the WAL stays small and writers get turns.
   */
  private slimEvents(): void {
    const total = num((this.db.prepare("SELECT max(rowid) AS m FROM events").get() as Row).m) ?? 0;
    const addCwds = this.db.prepare(`INSERT INTO cwds (path) SELECT DISTINCT cwd FROM events
      WHERE rowid > ? AND rowid <= ? AND cwd IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cwds c WHERE c.path = events.cwd)`);
    const slim = this.db.prepare(`UPDATE events SET cwd_id = (SELECT min(id) FROM cwds c WHERE c.path = events.cwd), cwd = NULL, search_extra = NULL
      WHERE rowid > ? AND rowid <= ? AND (cwd IS NOT NULL OR search_extra IS NOT NULL)`);
    const CHUNK = 20_000;
    for (let lo = 0; lo < total; lo += CHUNK) {
      this.tx(() => {
        addCwds.run(lo, lo + CHUNK);
        slim.run(lo, lo + CHUNK);
      });
    }
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
      // Contentless FTS with contentless_delete: entries go by rowid. Only searchable kinds can have one.
      const ftsDelete = this.stmt(`DELETE FROM events_fts WHERE rowid IN (SELECT rowid FROM events WHERE session_id = ? AND kind IN (${sqlList(SEARCHABLE_KINDS)}))`);
      const delEvents = this.stmt("DELETE FROM events WHERE session_id = ?");
      const delScores = this.stmt("DELETE FROM scores WHERE session_id = ?");
      const delSession = this.stmt("DELETE FROM sessions WHERE id = ?");
      const delFold = this.stmt("DELETE FROM kv WHERE key = ?");
      const delFacets = this.stmt("DELETE FROM session_facets WHERE session_id = ?");
      for (const id of ids) {
        ftsDelete.run(id);
        events += Number(delEvents.run(id).changes);
        delScores.run(id);
        delSession.run(id);
        delFold.run(foldKey(id));
        delFacets.run(id);
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
