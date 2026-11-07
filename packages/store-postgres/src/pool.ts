// Connection handling shared by the index and blob stores: URL parsing, one
// refcounted pg.Pool per database URL (so `CODING_SH_STORE_URL` and
// `CODING_SH_BLOB_URL` pointing at the same database share connections), and
// the schema migrations.
import pg from "pg";

export const DEFAULT_SCHEMA = "public";
export const DEFAULT_POOL_MAX = 10;
export const STATEMENT_TIMEOUT_MS = 30_000;

export interface PgUrl {
  /** What pg receives: the URL without `schema` and `pool_max`. Holds the password, so never log it. */
  connectionString: string;
  schema: string;
  poolMax: number;
}

const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Parses `postgres://user:pass@host:5432/db?sslmode=require&schema=coding_sh&pool_max=10`
 * (`postgresql://` too). `schema` and `pool_max` are ours and are stripped; the
 * rest (sslmode, host=/socket/dir, application_name, …) goes to pg as is.
 */
export function parsePgUrl(url: string): PgUrl {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid postgres URL ${redactUrl(url)}: expected postgres://user:pass@host:5432/db`);
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error(`invalid postgres URL ${redactUrl(url)}: the scheme must be postgres:// or postgresql://`);
  }
  const schema = u.searchParams.get("schema") ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`invalid schema ${JSON.stringify(schema)} in the postgres URL: use letters, digits and _ (at most 63, not starting with a digit)`);
  }
  const rawMax = u.searchParams.get("pool_max");
  const poolMax = rawMax === null ? DEFAULT_POOL_MAX : Number(rawMax);
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 1000) {
    throw new Error(`invalid pool_max ${JSON.stringify(rawMax)} in the postgres URL: expected an integer from 1 to 1000`);
  }
  u.searchParams.delete("schema");
  u.searchParams.delete("pool_max");
  return { connectionString: u.toString(), schema, poolMax };
}

/** The URL with its password masked, for errors and logs. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/?#@]*):[^@/?#]*@/i, "$1:***@").replace(/([?&](?:password|sslpassword)=)[^&#]*/gi, "$1***");
}

/** Double-quoted SQL identifier. Schema names are validated by SCHEMA_RE as well. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// int8 (count(*), sum(), bigint columns) → Number for this pool only; the
// process-wide pg.types table is left alone so other pg users are unaffected.
const INT8_OID = 20;
const poolTypes = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (oid === INT8_OID && format !== "binary") return (v: string) => Number(v);
    return (pg.types.getTypeParser as (oid: number, format?: string) => unknown)(oid, format);
  },
} as unknown as pg.CustomTypesConfig;

/** Client config for one connection: pool members and the writer-lock client alike. */
export function clientConfig(url: PgUrl): pg.ClientConfig {
  return {
    connectionString: url.connectionString,
    types: poolTypes,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: "coding.sh",
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  };
}

interface PoolEntry {
  pool: pg.Pool;
  refs: number;
  /** Schemas migrated through this pool in this process. */
  migrated: Set<string>;
}

const pools = new Map<string, PoolEntry>();

/** Opens (or shares) the pool for this URL. Pair every call with releasePool. */
export function acquirePool(url: PgUrl): PoolEntry {
  const key = `${url.poolMax}\n${url.connectionString}`;
  let entry = pools.get(key);
  if (!entry) {
    const pool = new pg.Pool({ ...clientConfig(url), max: url.poolMax, idleTimeoutMillis: 30_000 });
    // An idle client dying (server restart, network) must not crash the process:
    // the pool drops it and the next query reconnects.
    pool.on("error", () => {});
    entry = { pool, refs: 0, migrated: new Set() };
    pools.set(key, entry);
  }
  entry.refs++;
  return entry;
}

export async function releasePool(entry: PoolEntry): Promise<void> {
  if (--entry.refs > 0) return;
  for (const [k, v] of pools) if (v === entry) pools.delete(k);
  await entry.pool.end();
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    try {
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------- migrations

interface Migration {
  version: number;
  sql: (s: string) => string;
}

/**
 * Tables mirror the SQLite store. JSON fields are `text` holding JSON (jsonb
 * rejects \u0000 and renormalizes numbers; round-trips must be exact). Numbers
 * that come from events and documents (ts, started_at, created_at, …) are
 * `double precision`: exact for every JS number, including the fractional ms an
 * OTel duration produces, which a bigint column would reject. Ids are
 * COLLATE "C" so ORDER BY matches SQLite's byte order on any server locale.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: (s) => `
CREATE SEQUENCE ${s}.events_seq;
CREATE TABLE ${s}.events (
  id text COLLATE "C" PRIMARY KEY,
  seq bigint NOT NULL DEFAULT nextval('${s}.events_seq'),
  project_id text NOT NULL DEFAULT 'default',
  session_id text COLLATE "C" NOT NULL,
  turn_id text,
  parent_id text,
  ts double precision NOT NULL,
  duration_ms double precision,
  trace_id text,
  span_id text,
  parent_span_id text,
  subagent_id text,
  agent text NOT NULL,
  agent_version text,
  model text,
  kind text NOT NULL,
  tool text,
  ok boolean,
  run_id text,
  cwd text,
  repo text,
  payload text NOT NULL,
  blobs text,
  usage text,
  source text,
  -- searchTerms(searchableText(e)).join(" "), computed in JS: diacritics are folded like FTS5, no unaccent needed.
  search_folded text,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(search_folded, ''))) STORED
);
ALTER SEQUENCE ${s}.events_seq OWNED BY ${s}.events.seq;
CREATE INDEX events_session_ts ON ${s}.events (session_id, ts, seq);
CREATE INDEX events_project_ts ON ${s}.events (project_id, ts);
CREATE INDEX events_kind ON ${s}.events (kind);
CREATE INDEX events_run ON ${s}.events (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX events_tool ON ${s}.events (tool) WHERE tool IS NOT NULL;
CREATE INDEX events_trace ON ${s}.events (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX events_subagent ON ${s}.events (session_id, subagent_id) WHERE subagent_id IS NOT NULL;
CREATE INDEX events_tsv ON ${s}.events USING gin (tsv);

CREATE TABLE ${s}.sessions (
  id text COLLATE "C" PRIMARY KEY,
  project_id text NOT NULL DEFAULT 'default',
  agent text NOT NULL,
  agent_version text,
  model text,
  cwd text,
  repo text,
  repo_root text,
  title text,
  started_at double precision NOT NULL,
  ended_at double precision,
  stats text NOT NULL,
  flags text NOT NULL DEFAULT '[]',
  run_id text,
  end_snapshot text,
  parent text,
  parent_session_id text,
  trace_ids text
);
CREATE INDEX sessions_started ON ${s}.sessions (started_at DESC);
CREATE INDEX sessions_project ON ${s}.sessions (project_id, started_at DESC);
CREATE INDEX sessions_agent ON ${s}.sessions (agent, started_at DESC);
CREATE INDEX sessions_repo ON ${s}.sessions (repo_root, started_at DESC);
CREATE INDEX sessions_run ON ${s}.sessions (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX sessions_parent ON ${s}.sessions (parent_session_id, started_at DESC);
CREATE INDEX sessions_retention ON ${s}.sessions (project_id, (coalesce(ended_at, started_at)));

CREATE TABLE ${s}.cursors (
  source text COLLATE "C" PRIMARY KEY,
  "offset" double precision NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE ${s}.tasks (
  id text COLLATE "C" PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  tags text NOT NULL DEFAULT '[]',
  source_session_id text,
  created_at double precision NOT NULL,
  doc text NOT NULL
);
CREATE INDEX tasks_status ON ${s}.tasks (status, created_at DESC);

CREATE TABLE ${s}.bundles (
  id text COLLATE "C" PRIMARY KEY,
  name text COLLATE "C" NOT NULL,
  agent text NOT NULL,
  created_at double precision NOT NULL,
  doc text NOT NULL
);
CREATE INDEX bundles_name ON ${s}.bundles (name, created_at DESC);

CREATE TABLE ${s}.runs (
  id text COLLATE "C" PRIMARY KEY,
  experiment_id text,
  task_id text NOT NULL,
  bundle_id text NOT NULL,
  session_id text,
  pass boolean NOT NULL,
  started_at double precision NOT NULL,
  doc text NOT NULL
);
CREATE INDEX runs_task ON ${s}.runs (task_id);
CREATE INDEX runs_bundle ON ${s}.runs (bundle_id);
CREATE INDEX runs_experiment ON ${s}.runs (experiment_id) WHERE experiment_id IS NOT NULL;

CREATE TABLE ${s}.labels (
  id text COLLATE "C" PRIMARY KEY,
  session_id text NOT NULL,
  criterion text NOT NULL,
  value text NOT NULL,
  note text,
  "by" text NOT NULL,
  ts double precision NOT NULL
);
CREATE INDEX labels_session ON ${s}.labels (session_id, criterion);

CREATE TABLE ${s}.kv (
  key text COLLATE "C" PRIMARY KEY,
  value text NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE ${s}.datasets (
  id text COLLATE "C" NOT NULL,
  version text COLLATE "C" NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  name text NOT NULL,
  cases integer NOT NULL,
  created_at double precision NOT NULL,
  note text,
  doc text NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE TABLE ${s}.dataset_latest (
  id text COLLATE "C" PRIMARY KEY,
  version text COLLATE "C" NOT NULL
);

CREATE TABLE ${s}.experiments (
  id text COLLATE "C" PRIMARY KEY,
  name text NOT NULL,
  dataset_id text NOT NULL,
  created_at double precision NOT NULL,
  doc text NOT NULL
);
CREATE INDEX experiments_dataset ON ${s}.experiments (dataset_id, id DESC);

CREATE TABLE ${s}.judges (
  id text COLLATE "C" PRIMARY KEY,
  doc text NOT NULL
);

-- Content-addressed blobs, zstd-compressed by the store. Already compressed, so TOAST
-- stores them out of line without trying to compress again.
CREATE TABLE ${s}.blobs (
  ref text COLLATE "C" PRIMARY KEY,
  data bytea NOT NULL,
  size integer NOT NULL,
  created_at bigint NOT NULL
);
ALTER TABLE ${s}.blobs ALTER COLUMN data SET STORAGE EXTERNAL;
`,
  },
  {
    // Adapter parse version per session (Session.parseVersion), as SQLite v6.
    // Sessions stored before versioning came from parse version 1.
    version: 2,
    sql: (s) => `
ALTER TABLE ${s}.sessions ADD COLUMN parse_version integer;
UPDATE ${s}.sessions SET parse_version = 1;
`,
  },
];

export const PG_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/**
 * Creates the schema if missing and applies pending migrations, all in one
 * transaction under a transaction-level advisory lock keyed by the schema, so
 * replicas starting together never race. Cheap when already current.
 */
export async function migrateSchema(entry: PoolEntry, schema: string): Promise<void> {
  if (entry.migrated.has(schema)) return;
  const s = quoteIdent(schema);
  await withTx(entry.pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`coding.sh:migrate:${schema}`]);
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`CREATE TABLE IF NOT EXISTS ${s}.coding_sh_migrations (version integer PRIMARY KEY, applied_at bigint NOT NULL)`);
    const { rows } = await c.query<{ v: number | null }>(`SELECT max(version) AS v FROM ${s}.coding_sh_migrations`);
    const current = rows[0]?.v ?? 0;
    if (current > PG_SCHEMA_VERSION) {
      throw new Error(`schema ${schema} uses coding.sh postgres schema v${current}, but this coding.sh-store-postgres only knows up to v${PG_SCHEMA_VERSION}. Upgrade coding.sh-store-postgres.`);
    }
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      await c.query(m.sql(s));
      await c.query(`INSERT INTO ${s}.coding_sh_migrations (version, applied_at) VALUES ($1, $2)`, [m.version, Date.now()]);
    }
  });
  entry.migrated.add(schema);
}

/** Wraps connection/migration failures so the message names the database but never the password. */
export function openError(url: string, err: unknown): Error {
  const e = new Error(`cannot open ${redactUrl(url)}: ${(err as Error)?.message ?? String(err)}`);
  (e as Error & { cause?: unknown }).cause = err;
  return e;
}
