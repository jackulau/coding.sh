// ClickHouse over its HTTP interface with fetch: URL parsing, parameter
// encoding, JSONEachRow in and out, and the schema migrations. No driver.
//
// User values never go into SQL text. Queries name typed placeholders
// (`{p0:String}`) and the values travel as `param_p0` URL parameters, which the
// server parses as values of that type (scalars in TSV-escaped form, arrays as
// quoted literals), so a value can never become SQL.
import { gzipSync } from "node:zlib";

export const DEFAULT_DATABASE = "default";
export const QUERY_TIMEOUT_MS = 30_000;

export interface ChUrl {
  /** http(s)://host:port/ — no credentials. */
  endpoint: string;
  user: string;
  /** Never log it. */
  password: string;
  database: string;
  /** Extra URL parameters, sent as ClickHouse settings on every request. */
  settings: Record<string, string>;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SETTING_RE = /^[a-z_][a-z0-9_]*$/;
/** URL parameters that are ours, not ClickHouse settings. */
const OWN_PARAMS = new Set(["secure", "ssl", "database"]);

/**
 * Parses `clickhouse://user:pass@host:8123/db` (HTTP) and
 * `clickhouses://user:pass@host:8443/db` (HTTPS; `?secure=1` on clickhouse://
 * does the same). The path is the database (default `default`), created if
 * missing. Other parameters become ClickHouse settings for every request,
 * e.g. `?select_sequential_consistency=1`.
 */
export function parseChUrl(url: string): ChUrl {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`invalid clickhouse URL ${redactUrl(url)}: expected clickhouse://user:pass@host:8123/db`);
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "clickhouse" && scheme !== "clickhouses") {
    throw new Error(`invalid clickhouse URL ${redactUrl(url)}: the scheme must be clickhouse:// or clickhouses://`);
  }
  if (!u.hostname) throw new Error(`invalid clickhouse URL ${redactUrl(url)}: no host`);
  const flag = (k: string) => /^(1|true|yes|on)$/i.test(u.searchParams.get(k) ?? "");
  const secure = scheme === "clickhouses" || flag("secure") || flag("ssl");
  const path = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, ""));
  const database = path || u.searchParams.get("database") || DEFAULT_DATABASE;
  if (!IDENT_RE.test(database)) {
    throw new Error(`invalid database ${JSON.stringify(database)} in the clickhouse URL: use letters, digits and _ (at most 63, not starting with a digit)`);
  }
  const settings: Record<string, string> = {};
  for (const [k, v] of u.searchParams) {
    if (OWN_PARAMS.has(k)) continue;
    if (!SETTING_RE.test(k)) throw new Error(`invalid setting ${JSON.stringify(k)} in the clickhouse URL: ClickHouse settings are lower_snake_case`);
    settings[k] = v;
  }
  const port = u.port || (secure ? "8443" : "8123");
  const host = u.hostname.includes(":") && !u.hostname.startsWith("[") ? `[${u.hostname}]` : u.hostname;
  return {
    endpoint: `${secure ? "https" : "http"}://${host}:${port}/`,
    user: u.username ? decodeURIComponent(u.username) : "default",
    password: u.password ? decodeURIComponent(u.password) : "",
    database,
    settings,
  };
}

/** The URL with its password masked, for errors and logs. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/?#@]*):[^@/?#]*@/i, "$1:***@").replace(/([?&](?:password)=)[^&#]*/gi, "$1***");
}

/** Backquoted identifier. Database names are validated by IDENT_RE as well. */
export function quoteIdent(name: string): string {
  return `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
}

const TSV_ESCAPES: Record<string, string> = { "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r", "\0": "\\0" };
const LITERAL_ESCAPES: Record<string, string> = { ...TSV_ESCAPES, "'": "\\'" };

/** A single-quoted ClickHouse string literal (also how strings are written inside an Array parameter). */
export function quoteLiteral(s: string): string {
  return `'${s.replace(/[\\'\t\n\r\0]/g, (c) => LITERAL_ESCAPES[c]!)}'`;
}

export type ParamValue = string | number | boolean | null | undefined | readonly (string | number)[];

/** The `param_<name>` value for a typed placeholder: TSV-escaped scalars, quoted array literals, `\N` for NULL. */
export function encodeParam(v: ParamValue): string {
  if (v === null || v === undefined) return "\\N";
  if (typeof v === "string") return v.replace(/[\\\t\n\r\0]/g, (c) => TSV_ESCAPES[c]!);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`cannot bind ${v} as a ClickHouse parameter`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return `[${v.map((x) => (typeof x === "string" ? quoteLiteral(x) : encodeParam(x))).join(",")}]`;
}

/** Builds placeholders and their values for one statement. */
export class Params {
  readonly values: Record<string, string> = {};
  private n = 0;
  /** `{pN:Type}` bound to v. */
  bind(type: string, v: ParamValue): string {
    const name = `p${this.n++}`;
    this.values[name] = encodeParam(v);
    return `{${name}:${type}}`;
  }
}

/** A ClickHouse error with its numeric code (X-ClickHouse-Exception-Code), when the server sent one. */
export class ChError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "ChError";
    this.code = code;
  }
}

/** Server error text, first line only, without the stack trace ClickHouse appends. */
function errorText(body: string): string {
  const line = body.trim().split("\n")[0] ?? "";
  return line.replace(/\s*\(version [^)]*\)\s*$/, "").slice(0, 2000) || "empty response";
}

const BASE_SETTINGS: Record<string, string> = {
  // 64-bit integers as JSON numbers (every value we store fits in 2^53).
  output_format_json_quote_64bit_integers: "0",
  output_format_json_quote_64bit_floats: "0",
  // Gzip responses; fetch decompresses them.
  enable_http_compression: "1",
};

export interface RequestOpts {
  params?: Record<string, string>;
  settings?: Record<string, string>;
  /** Client-side timeout, ms. 0 = none. Default QUERY_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Bodies above this are gzipped before they are sent. */
const GZIP_OVER = 16 * 1024;

export class ChClient {
  readonly url: ChUrl;
  private readonly headers: Record<string, string>;

  constructor(url: ChUrl) {
    this.url = url;
    this.headers = { "X-ClickHouse-User": url.user, "X-ClickHouse-Key": url.password };
  }

  private async request(query: string | undefined, body: string, o: RequestOpts & { stream?: boolean } = {}): Promise<Response> {
    const u = new URL(this.url.endpoint);
    const timeoutMs = o.timeoutMs ?? QUERY_TIMEOUT_MS;
    const settings: Record<string, string> = { ...BASE_SETTINGS, ...this.url.settings, ...o.settings };
    if (!o.stream) settings.wait_end_of_query = "1"; // errors arrive as HTTP errors, not mid-body
    if (timeoutMs > 0 && settings.max_execution_time === undefined) settings.max_execution_time = String(Math.ceil(timeoutMs / 1000));
    for (const [k, v] of Object.entries(settings)) u.searchParams.set(k, v);
    for (const [k, v] of Object.entries(o.params ?? {})) u.searchParams.set(`param_${k}`, v);
    if (query !== undefined) u.searchParams.set("query", query);
    const headers: Record<string, string> = { ...this.headers, "Content-Type": "text/plain; charset=utf-8" };
    let payload: string | Uint8Array<ArrayBuffer> = body;
    if (Buffer.byteLength(body) > GZIP_OVER) {
      payload = new Uint8Array(gzipSync(body));
      headers["Content-Encoding"] = "gzip";
    }
    let res: Response;
    try {
      res = await fetch(u, { method: "POST", headers, body: payload, ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs + 5_000) } : {}) });
    } catch (err) {
      const cause = (err as Error & { cause?: Error }).cause;
      throw new ChError(`clickhouse at ${this.url.endpoint} is unreachable: ${cause?.message ?? (err as Error).message}`);
    }
    if (!res.ok) {
      const code = Number(res.headers.get("x-clickhouse-exception-code")) || undefined;
      throw new ChError(`clickhouse: ${errorText(await res.text())}`, code);
    }
    return res;
  }

  /** Runs a statement that returns nothing (DDL, DELETE, INSERT … SELECT). */
  async exec(sql: string, o: RequestOpts = {}): Promise<void> {
    await (await this.request(undefined, sql, o)).arrayBuffer();
  }

  /** Runs a SELECT and returns its rows. The statement must not carry its own FORMAT. */
  async query<T = Record<string, unknown>>(sql: string, o: RequestOpts = {}): Promise<T[]> {
    const text = await (await this.request(undefined, `${sql}\nFORMAT JSONEachRow`, o)).text();
    const rows: T[] = [];
    for (const line of text.split("\n")) if (line) rows.push(JSON.parse(line) as T);
    return rows;
  }

  /** Streams a SELECT's rows without holding the whole result. */
  async *stream<T = Record<string, unknown>>(sql: string, o: RequestOpts = {}): AsyncGenerator<T> {
    const res = await this.request(undefined, `${sql}\nFORMAT JSONEachRow`, { ...o, stream: true });
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buf = "";
    const parse = (line: string): T => {
      try {
        return JSON.parse(line) as T;
      } catch {
        // An error after the first rows arrives in the body, as text.
        throw new ChError(`clickhouse: ${errorText(line)}`);
      }
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) yield parse(line);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield parse(buf);
  }

  /** INSERTs rows as JSONEachRow. Synchronous (never async_insert), so the next read sees them. */
  async insert(table: string, rows: readonly object[], o: RequestOpts = {}): Promise<void> {
    if (!rows.length) return;
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    const settings = { async_insert: "0", input_format_skip_unknown_fields: "0", ...o.settings };
    await (await this.request(`INSERT INTO ${table} FORMAT JSONEachRow`, body, { ...o, settings })).arrayBuffer();
  }
}

// ---------------------------------------------------------------- versions

let lastVer = 0;
/**
 * Version for ReplacingMergeTree rows and the batch-order `seq` of events:
 * microseconds since the epoch, strictly increasing within this process. A
 * later write from any process gets a larger version as long as clocks agree
 * to within the gap between the two writes.
 */
export function nextVer(): number {
  lastVer = Math.max(Date.now() * 1000, lastVer + 1);
  return lastVer;
}

// ---------------------------------------------------------------- migrations

interface Migration {
  version: number;
  /** One statement per entry (the HTTP interface runs one per request). Each must be safe to run twice. */
  statements: (db: string) => string[];
}

/**
 * Tables mirror the SQLite and Postgres stores. Rows that can be written again
 * (sessions, cursors, tasks, …) live in ReplacingMergeTree tables keyed by id
 * with a `ver` column; reads use FINAL, so the newest version wins whatever
 * the merge state. Events are written once per id (putEvents checks first)
 * and FINAL hides the rare duplicate a race between two processes leaves.
 * JSON fields are String holding JSON, so round-trips are exact. Numbers that
 * come from events and documents are Float64, exact for every JS number.
 * Every statement is idempotent, so replicas migrating at once are safe.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: (d) => [
      `CREATE TABLE IF NOT EXISTS ${d}.events (
  id String,
  session_id String,
  project_id LowCardinality(String),
  seq UInt64,
  ver UInt64,
  turn_id Nullable(String),
  parent_id Nullable(String),
  ts Float64,
  duration_ms Nullable(Float64),
  trace_id Nullable(String),
  span_id Nullable(String),
  parent_span_id Nullable(String),
  subagent_id Nullable(String),
  agent LowCardinality(String),
  agent_version Nullable(String),
  model Nullable(String),
  kind LowCardinality(String),
  tool Nullable(String),
  ok Nullable(Bool),
  run_id Nullable(String),
  cwd Nullable(String),
  repo Nullable(String),
  payload String,
  blobs Array(String),
  usage Nullable(String),
  source Nullable(String),
  -- ' ' + searchTerms(searchableText(e)).join(' '), computed in JS (diacritics folded like FTS5).
  search_text String,
  INDEX events_id id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX events_search search_text TYPE ngrambf_v1(3, 262144, 3, 0) GRANULARITY 1
) ENGINE = ReplacingMergeTree(ver)
ORDER BY (session_id, id)`,
      `CREATE TABLE IF NOT EXISTS ${d}.sessions (
  id String,
  ver UInt64,
  project_id LowCardinality(String),
  agent LowCardinality(String),
  agent_version Nullable(String),
  model Nullable(String),
  cwd Nullable(String),
  repo Nullable(String),
  repo_root Nullable(String),
  title Nullable(String),
  started_at Float64,
  ended_at Nullable(Float64),
  stats String,
  flags Array(String),
  run_id Nullable(String),
  end_snapshot Nullable(String),
  parent Nullable(String),
  parent_session_id Nullable(String),
  trace_ids Nullable(String),
  parse_version Nullable(UInt32)
) ENGINE = ReplacingMergeTree(ver)
ORDER BY id`,
      `CREATE TABLE IF NOT EXISTS ${d}.cursors (source String, ver UInt64, \`offset\` Float64, updated_at Int64)
ENGINE = ReplacingMergeTree(ver) ORDER BY source`,
      `CREATE TABLE IF NOT EXISTS ${d}.tasks (
  id String, ver UInt64, name String, status LowCardinality(String), tags Array(String),
  source_session_id Nullable(String), created_at Float64, doc String
) ENGINE = ReplacingMergeTree(ver) ORDER BY id`,
      `CREATE TABLE IF NOT EXISTS ${d}.bundles (id String, ver UInt64, name String, agent String, created_at Float64, doc String)
ENGINE = ReplacingMergeTree(ver) ORDER BY id`,
      `CREATE TABLE IF NOT EXISTS ${d}.runs (
  id String, ver UInt64, experiment_id Nullable(String), task_id String, bundle_id String,
  session_id Nullable(String), pass Bool, started_at Float64, doc String
) ENGINE = ReplacingMergeTree(ver) ORDER BY id`,
      `CREATE TABLE IF NOT EXISTS ${d}.labels (
  id String, ver UInt64, session_id String, criterion String, value LowCardinality(String),
  note Nullable(String), \`by\` String, ts Float64
) ENGINE = ReplacingMergeTree(ver) ORDER BY id`,
      // deleted = 1 rows are tombstones FINAL hides (kvSet(key, undefined)).
      `CREATE TABLE IF NOT EXISTS ${d}.kv (\`key\` String, ver UInt64, deleted UInt8, value String, updated_at Int64)
ENGINE = ReplacingMergeTree(ver, deleted) ORDER BY \`key\``,
      // Immutable per (id, version): putDataset checks before it writes. seq gives history order.
      `CREATE TABLE IF NOT EXISTS ${d}.datasets (
  id String, version String, seq UInt64, name String, cases UInt32, created_at Float64, note Nullable(String), doc String
) ENGINE = ReplacingMergeTree ORDER BY (id, version)`,
      `CREATE TABLE IF NOT EXISTS ${d}.dataset_latest (id String, ver UInt64, version String)
ENGINE = ReplacingMergeTree(ver) ORDER BY id`,
      `CREATE TABLE IF NOT EXISTS ${d}.experiments (id String, ver UInt64, name String, dataset_id String, created_at Float64, doc String)
ENGINE = ReplacingMergeTree(ver) ORDER BY id`,
      `CREATE TABLE IF NOT EXISTS ${d}.judges (id String, ver UInt64, doc String)
ENGINE = ReplacingMergeTree(ver) ORDER BY id`,
      // Lease rows for the single-writer lock (see index-store.ts acquireWriterLock).
      `CREATE TABLE IF NOT EXISTS ${d}.locks (
  name String, holder String, ver UInt64, claimed_at Int64, expires_at Int64, released UInt8
) ENGINE = ReplacingMergeTree(ver) ORDER BY (name, holder)`,
    ],
  },
];

export const CH_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** ClickHouse error codes a concurrent `IF NOT EXISTS` can still raise. */
const ALREADY_EXISTS = new Set([57, 82]);

/**
 * Creates the database if missing and applies pending migrations. Every
 * statement is idempotent, so replicas starting together all succeed (a lost
 * race on CREATE is retried). Cheap when already current: one read.
 */
export async function migrateDatabase(client: ChClient): Promise<void> {
  const name = client.url.database;
  const d = quoteIdent(name);
  const p = new Params();
  const [known] = await client.query<{ n: number }>(`SELECT count() AS n FROM system.databases WHERE name = ${p.bind("String", name)}`, { params: p.values });
  if (!known?.n) await retryExists(() => client.exec(`CREATE DATABASE IF NOT EXISTS ${d}`));
  await retryExists(() => client.exec(`CREATE TABLE IF NOT EXISTS ${d}.coding_sh_migrations (version UInt32, applied_at Int64) ENGINE = ReplacingMergeTree ORDER BY version`));
  const [row] = await client.query<{ v: number }>(`SELECT max(version) AS v FROM ${d}.coding_sh_migrations`);
  const current = row?.v ?? 0;
  if (current > CH_SCHEMA_VERSION) {
    throw new Error(`database ${name} uses coding.sh clickhouse schema v${current}, but this coding.sh-store-clickhouse only knows up to v${CH_SCHEMA_VERSION}. Upgrade coding.sh-store-clickhouse.`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    for (const sql of m.statements(d)) await retryExists(() => client.exec(sql));
    await client.insert(`${d}.coding_sh_migrations`, [{ version: m.version, applied_at: Date.now() }]);
  }
}

async function retryExists(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ChError) || !ALREADY_EXISTS.has(err.code ?? 0)) throw err;
    await fn();
  }
}

/** Wraps connection/migration failures so the message names the server but never the password. */
export function openError(url: string, err: unknown): Error {
  const e = new Error(`cannot open ${redactUrl(url)}: ${(err as Error)?.message ?? String(err)}`);
  (e as Error & { cause?: unknown }).cause = err;
  return e;
}
