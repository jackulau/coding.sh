// IndexStore on Postgres. Mirrors the SQLite store table for table, so the
// conformance suite holds for both, and adds what production needs: project_id
// on events and sessions, idempotent batched upserts, full-text search on a
// GIN-indexed tsvector, retention, and a cluster-wide single-writer lock.
import pg from "pg";
import {
  BLOB_REF_FIELDS,
  DEFAULT_PROJECT,
  searchableText,
  searchTerms,
  snippet,
  type AgentEvent,
  type AgentId,
  type BlobRef,
  type BlobRefField,
  type Dataset,
  type DatasetListing,
  type DatasetVersionInfo,
  type EvalTask,
  type ExperimentResult,
  type FacetCount,
  type HarnessBundle,
  type IndexStore,
  type JudgeVersion,
  type Label,
  type Query,
  type QueryOpts,
  type RunResult,
  type SearchHit,
  type Session,
  type SessionFilter,
} from "coding.sh/store";
import {
  acquirePool,
  clientConfig,
  migrateSchema,
  openError,
  parsePgUrl,
  quoteIdent,
  releasePool,
  withTx,
  type PgUrl,
} from "./pool.ts";
import { compileWhere, facetSource, orderBy, tsQuery } from "./where.ts";

/** Rows per INSERT; one transaction covers the whole putEvents batch. */
const INSERT_CHUNK = 500;
/** Sessions deleted per retention transaction, so one sweep never holds a huge transaction open. */
const DELETE_CHUNK = 500;
/**
 * Cap on indexed text per event. tsvector values must stay under 1 MB; message
 * text has no cap of its own (tool text is already capped by searchableText).
 */
const SEARCH_TEXT_CAP = 200_000;

type Row = Record<string, unknown>;

const EVENT_COLS = `id, project_id, session_id, turn_id, parent_id, ts, duration_ms, trace_id, span_id, parent_span_id,
  subagent_id, agent, agent_version, model, kind, run_id, cwd, repo, payload, blobs, usage, source`;

// Text columns reject U+0000. JSON columns are safe (JSON.stringify escapes it);
// plain text columns drop it rather than failing the whole batch.
const NUL = /\u0000/g;
const txt = (v: string | undefined | null): string | null => (v === undefined || v === null ? null : v.includes("\u0000") ? v.replace(NUL, "") : v);
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = <T>(v: unknown): T | undefined => (typeof v === "string" ? (JSON.parse(v) as T) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined);
const projectOf = (p: string | undefined): string => p || DEFAULT_PROJECT;

/** Search text for the tsvector: folded terms, so "Café" matches "cafe" like FTS5 remove_diacritics. */
export function searchFolded(e: AgentEvent): string | null {
  const text = searchableText(e);
  if (text === undefined) return null;
  const folded = searchTerms(text).join(" ");
  if (!folded) return null;
  if (folded.length <= SEARCH_TEXT_CAP) return folded;
  const cut = folded.lastIndexOf(" ", SEARCH_TEXT_CAP);
  return folded.slice(0, cut > 0 ? cut : SEARCH_TEXT_CAP);
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
  if (typeof r.project_id === "string" && r.project_id !== DEFAULT_PROJECT) e.project = r.project_id;
  return e;
}

function rowToSession(r: Row): Session {
  const s: Session = {
    id: r.id as string,
    agent: r.agent as string,
    startedAt: num(r.started_at)!,
    stats: parse<Session["stats"]>(r.stats)!,
    flags: parse<string[]>(r.flags) ?? [],
  };
  // provider rides in the stats JSON, as in the SQLite store.
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
  if (typeof r.project_id === "string" && r.project_id !== DEFAULT_PROJECT) s.project = r.project_id;
  set("parseVersion", num(r.parse_version));
  return s;
}

function rowToLabel(r: Row): Label {
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
}

/** Collects WHERE clauses with numbered placeholders. */
class Where {
  readonly parts: string[] = [];
  readonly params: unknown[] = [];
  add(sql: string, ...values: unknown[]): this {
    let out = sql;
    for (const v of values) {
      this.params.push(v);
      out = out.replace("?", `$${this.params.length}`);
    }
    this.parts.push(out);
    return this;
  }
  param(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  get sql(): string {
    return this.parts.length ? `WHERE ${this.parts.join(" AND ")}` : "";
  }
}

/** WHERE parts for a SessionFilter; `p` prefixes column names ("s." when sessions is aliased). */
function sessionFilter(w: Where, f: Omit<SessionFilter, "limit" | "offset">, p = ""): Where {
  if (f.project) w.add(`${p}project_id = ?`, f.project);
  if (f.agent) w.add(`${p}agent = ?`, f.agent);
  if (f.parentSessionId === null) w.add(`${p}parent_session_id IS NULL`);
  else if (f.parentSessionId !== undefined) w.add(`${p}parent_session_id = ?`, f.parentSessionId);
  if (f.repoRoot) w.add(`${p}repo_root = ?`, f.repoRoot);
  if (f.runId === null) w.add(`${p}run_id IS NULL`);
  else if (f.runId !== undefined) w.add(`${p}run_id = ?`, f.runId);
  if (f.flag) w.add(`EXISTS (SELECT 1 FROM json_array_elements_text(${p}flags::json) AS j(v) WHERE j.v = ?)`, f.flag);
  if (f.since !== undefined) w.add(`${p}started_at >= ?`, f.since);
  if (f.until !== undefined) w.add(`${p}started_at < ?`, f.until);
  return w;
}

export interface PgIndexOptions {
  /** Test hook: drop the whole schema on close. */
  dropSchemaOnClose?: boolean;
}

export class PgIndexStore implements IndexStore {
  readonly kind = "postgres";
  readonly schema: string;
  private readonly url: PgUrl;
  private readonly entry: ReturnType<typeof acquirePool>;
  private readonly t: (table: string) => string;
  private readonly opts: PgIndexOptions;
  private readonly lockClients = new Set<pg.Client>();
  private closed = false;

  private constructor(url: PgUrl, opts: PgIndexOptions) {
    this.url = url;
    this.schema = url.schema;
    this.opts = opts;
    this.entry = acquirePool(url);
    const s = quoteIdent(url.schema);
    this.t = (table) => `${s}.${table}`;
  }

  /** Connects, creates the schema if missing and migrates it. */
  static async open(url: string, opts: PgIndexOptions = {}): Promise<PgIndexStore> {
    const store = new PgIndexStore(parsePgUrl(url), opts);
    try {
      await store.migrate();
    } catch (err) {
      await store.close().catch(() => {});
      throw openError(url, err);
    }
    return store;
  }

  private get pool(): pg.Pool {
    return this.entry.pool;
  }

  private async q<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  async migrate(): Promise<void> {
    await migrateSchema(this.entry, this.schema);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.lockClients) await c.end().catch(() => {});
    this.lockClients.clear();
    try {
      if (this.opts.dropSchemaOnClose) {
        await this.pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(this.schema)} CASCADE`);
        this.entry.migrated.delete(this.schema);
      }
    } finally {
      await releasePool(this.entry);
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  // ------------------------------------------------------------ events

  async putEvents(batch: AgentEvent[]): Promise<{ inserted: number }> {
    const seen = new Set<string>();
    const unique: AgentEvent[] = [];
    for (const e of batch) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      unique.push(e);
    }
    if (!unique.length) return { inserted: 0 };
    return withTx(this.pool, async (c) => ({ inserted: await this.insertEvents(c, unique) }));
  }

  async replaceSessionEvents(sessionId: string, removeIds: string[], add: AgentEvent[]): Promise<{ removed: number; inserted: number }> {
    const seen = new Set<string>();
    const unique = add.filter((e) => !seen.has(e.id) && (seen.add(e.id), true));
    return withTx(this.pool, async (c) => {
      const del = await c.query(`DELETE FROM ${this.t("events")} WHERE session_id = $1 AND id = ANY($2::text[])`, [sessionId, [...new Set(removeIds)]]);
      const inserted = unique.length ? await this.insertEvents(c, unique) : 0;
      return { removed: del.rowCount ?? 0, inserted };
    });
  }

  /** Inserts distinct-id events on the caller's transaction; returns rows inserted. */
  private async insertEvents(c: pg.PoolClient, unique: AgentEvent[]): Promise<number> {
    // seq keeps batch order for events with equal ts (as SQLite's rowid does),
    // while rows are inserted in id order: concurrent writers with overlapping
    // ids then take row locks in the same order and cannot deadlock.
    const { rows } = await c.query<{ v: number }>(`SELECT nextval('${this.t("events_seq")}') AS v FROM generate_series(1, $1::int)`, [unique.length]);
    const seqs = rows.map((r) => r.v).sort((a, b) => a - b);
    const ordered = unique.map((e, i) => ({ e, seq: seqs[i]! })).sort((a, b) => (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
    let inserted = 0;
    for (let i = 0; i < ordered.length; i += INSERT_CHUNK) {
      const chunk = ordered.slice(i, i + INSERT_CHUNK);
      // Column-wise arrays for unnest(): one fixed statement whatever the chunk size.
      const cols: unknown[][] = Array.from({ length: 26 }, () => []);
      for (const { e, seq } of chunk) {
        const p = e.payload ?? {};
        const values = [
          txt(e.id), seq, txt(projectOf(e.project)), txt(e.sessionId), txt(e.turnId), txt(e.parentId), e.ts, e.durationMs ?? null,
          txt(e.traceId), txt(e.spanId), txt(e.parentSpanId), txt(e.subagentId), txt(e.agent), txt(e.agentVersion), txt(e.model),
          txt(e.kind), typeof p.tool === "string" ? txt(p.tool) : null, typeof p.ok === "boolean" ? p.ok : null, txt(e.runId),
          txt(e.cwd), json(e.repo), JSON.stringify(p), e.blobs?.length ? JSON.stringify(e.blobs) : null, json(e.usage),
          txt(e.source), searchFolded(e),
        ];
        values.forEach((v, k) => cols[k]!.push(v));
      }
      const r = await c.query(
        `INSERT INTO ${this.t("events")} (id, seq, project_id, session_id, turn_id, parent_id, ts, duration_ms, trace_id, span_id,
           parent_span_id, subagent_id, agent, agent_version, model, kind, tool, ok, run_id, cwd, repo, payload, blobs, usage,
           source, search_folded)
         SELECT * FROM unnest($1::text[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::float8[], $8::float8[],
           $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[], $17::text[],
           $18::boolean[], $19::text[], $20::text[], $21::text[], $22::text[], $23::text[], $24::text[], $25::text[], $26::text[])
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        cols,
      );
      inserted += r.rowCount ?? 0;
    }
    return inserted;
  }

  async listEvents(sessionId: string, opts: { kinds?: string[]; limit?: number; offset?: number } = {}): Promise<AgentEvent[]> {
    const w = new Where().add("session_id = ?", sessionId);
    if (opts.kinds?.length) w.add("kind = ANY(?::text[])", opts.kinds);
    const sql = `SELECT ${EVENT_COLS} FROM ${this.t("events")} ${w.sql} ORDER BY ts, seq LIMIT ${w.param(opts.limit ?? null)} OFFSET ${w.param(opts.offset ?? 0)}`;
    return (await this.q(sql, w.params)).map(rowToEvent);
  }

  async search(text: string, opts: { limit?: number; agent?: AgentId; project?: string } = {}): Promise<SearchHit[]> {
    const tq = tsQuery(text);
    if (!tq) return [];
    const w = new Where();
    const q = w.param(tq.query);
    w.add(`e.tsv @@ to_tsquery('simple', ${q})`);
    if (opts.agent) w.add("e.agent = ?", opts.agent);
    if (opts.project) w.add("e.project_id = ?", opts.project);
    const sql = `SELECT ${EVENT_COLS.replace(/(\w+)/g, "e.$1")} FROM ${this.t("events")} e ${w.sql}
      ORDER BY ts_rank(e.tsv, to_tsquery('simple', ${q})) DESC, e.ts DESC LIMIT ${w.param(opts.limit ?? 50)}`;
    return (await this.q(sql, w.params)).map((r) => {
      const event = rowToEvent(r);
      return { event, snippet: snippet(searchableText(event) ?? "", tq.terms) };
    });
  }

  /** Approximate event count, for doctor/status output. */
  async countEvents(): Promise<number> {
    const [r] = await this.q<{ n: number }>(`SELECT count(*) AS n FROM ${this.t("events")}`);
    return r?.n ?? 0;
  }

  // ------------------------------------------------------------ sessions

  async upsertSession(s: Session): Promise<void> {
    await this.upsertSessionOn(this.pool, s);
  }

  /**
   * Rebuilds one session in one transaction under pg_advisory_xact_lock on its
   * id (keyed by schema): concurrent writers to the same session (serverless
   * instances, several serve processes) queue on the lock, and each reads the
   * events every earlier writer committed, so the last rebuild always sees them
   * all. Works through transaction-mode poolers (the lock ends with the transaction).
   */
  async rebuildSession(id: string, build: (prev: Session | undefined, events: AgentEvent[]) => Session | undefined): Promise<Session | undefined> {
    return withTx(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`coding.sh:session:${this.schema}:${id}`]);
      const [row] = (await c.query(`SELECT * FROM ${this.t("sessions")} WHERE id = $1`, [id])).rows;
      const events = (await c.query(`SELECT ${EVENT_COLS} FROM ${this.t("events")} WHERE session_id = $1 ORDER BY ts, seq`, [id])).rows.map(rowToEvent);
      const next = build(row ? rowToSession(row) : undefined, events);
      if (next) await this.upsertSessionOn(c, next);
      return next;
    });
  }

  private async upsertSessionOn(c: pg.Pool | pg.PoolClient, s: Session): Promise<void> {
    await c.query(
      `INSERT INTO ${this.t("sessions")} AS cur (id, project_id, agent, agent_version, model, cwd, repo, repo_root, title, started_at, ended_at,
         stats, flags, run_id, end_snapshot, parent, parent_session_id, trace_ids, parse_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (id) DO UPDATE SET
         project_id = excluded.project_id, agent = excluded.agent, agent_version = excluded.agent_version, model = excluded.model,
         cwd = excluded.cwd, repo = excluded.repo, repo_root = excluded.repo_root, title = excluded.title,
         started_at = excluded.started_at, ended_at = excluded.ended_at, stats = excluded.stats, flags = excluded.flags,
         run_id = excluded.run_id, end_snapshot = excluded.end_snapshot, parent = excluded.parent,
         parent_session_id = excluded.parent_session_id, trace_ids = excluded.trace_ids,
         parse_version = coalesce(excluded.parse_version, cur.parse_version)`,
      [
        txt(s.id), txt(projectOf(s.project)), txt(s.agent), txt(s.agentVersion), txt(s.model), txt(s.cwd), json(s.repo), txt(s.repo?.root),
        txt(s.title), s.startedAt, s.endedAt ?? null, JSON.stringify(s.provider ? { ...s.stats, provider: s.provider } : s.stats),
        JSON.stringify(s.flags ?? []), txt(s.runId), txt(s.endSnapshot), json(s.parent), txt(s.parent?.sessionId),
        s.traceIds?.length ? JSON.stringify(s.traceIds) : null, s.parseVersion ?? null,
      ],
    );
  }

  async getSession(id: string): Promise<Session | undefined> {
    const [r] = await this.q(`SELECT * FROM ${this.t("sessions")} WHERE id = $1`, [id]);
    return r ? rowToSession(r) : undefined;
  }

  async listSessions(f: SessionFilter = {}): Promise<Session[]> {
    const w = sessionFilter(new Where(), f);
    const sql = `SELECT * FROM ${this.t("sessions")} ${w.sql} ORDER BY started_at DESC, id
      LIMIT ${w.param(f.limit ?? null)} OFFSET ${w.param(f.offset ?? 0)}`;
    return (await this.q(sql, w.params)).map(rowToSession);
  }

  // ------------------------------------------------------------ --where (coding.sh src/query)

  /** The filter and the query as WHERE parts over `sessions s` (src/where.ts compiles the query). */
  private queryWhere(q: Query, o: QueryOpts): Where {
    const w = sessionFilter(new Where(), o.filter ?? {}, "s.");
    if (q.root) w.add(compileWhere(q.root, (v) => w.param(v), this.t("events")));
    return w;
  }

  async querySessions(q: Query, o: QueryOpts = {}): Promise<Session[]> {
    const w = this.queryWhere(q, o);
    const sql = `SELECT s.* FROM ${this.t("sessions")} s ${w.sql} ORDER BY ${orderBy(q.sort)}
      LIMIT ${w.param(o.limit ?? null)} OFFSET ${w.param(o.offset ?? 0)}`;
    return (await this.q(sql, w.params)).map(rowToSession);
  }

  async queryFacets(q: Query, key: string, o: QueryOpts = {}): Promise<FacetCount[]> {
    const w = this.queryWhere(q, o);
    const src = facetSource(key, (v) => w.param(v), this.t("sessions"), this.t("events"));
    if (src.where) w.add(src.where);
    const sql = `SELECT v, count(DISTINCT sid) AS n FROM (SELECT ${src.value} AS v, s.id AS sid FROM ${src.from} ${w.sql}) t
      WHERE v IS NOT NULL AND v <> '' GROUP BY v ORDER BY n DESC, v COLLATE "C" LIMIT ${w.param(o.limit ?? 20)}`;
    return (await this.q<{ v: string; n: number }>(sql, w.params)).map((r) => ({ value: r.v, count: r.n }));
  }

  /** Sessions with stored events and no row (doctor counts them; `coding.sh ingest` folds them). */
  async sessionsWithoutRow(): Promise<{ sessionId: string; agent: string }[]> {
    const rows = await this.q<{ id: string; agent: string }>(
      `SELECT e.session_id AS id, min(e.agent COLLATE "C") AS agent FROM ${this.t("events")} e
       WHERE NOT EXISTS (SELECT 1 FROM ${this.t("sessions")} s WHERE s.id = e.session_id)
       GROUP BY e.session_id ORDER BY e.session_id`,
    );
    return rows.map((r) => ({ sessionId: r.id, agent: r.agent }));
  }

  /** Distinct project ids with sessions (sessions_project index), for serve's GET /api/projects. */
  async listProjects(): Promise<string[]> {
    return (await this.q<{ p: string }>(`SELECT DISTINCT project_id AS p FROM ${this.t("sessions")} ORDER BY 1`)).map((r) => r.p);
  }

  /**
   * Retention: deletes sessions whose last activity is before the cutoff, with
   * their events and labels, in chunks of DELETE_CHUNK sessions per transaction.
   * Last activity is the latest of coalesce(ended_at, started_at) and every
   * event's end (ts + duration_ms), so a resumed session or one that never sent
   * session.end survives while it still gets events. Eval assets (tasks,
   * datasets, experiments, judges) are kept.
   */
  async deleteBefore(cutoffMs: number, opts: { project?: string } = {}): Promise<{ sessions: number; events: number }> {
    let sessions = 0;
    let events = 0;
    for (;;) {
      const n = await withTx(this.pool, async (c) => {
        const w = new Where().add("coalesce(ended_at, started_at) < ?", cutoffMs);
        w.add(`NOT EXISTS (SELECT 1 FROM ${this.t("events")} e WHERE e.session_id = ${this.t("sessions")}.id AND e.ts + coalesce(e.duration_ms, 0) >= ?)`, cutoffMs);
        if (opts.project) w.add("project_id = ?", opts.project);
        const { rows } = await c.query<{ id: string }>(
          `DELETE FROM ${this.t("sessions")} d USING (
             SELECT id FROM ${this.t("sessions")} ${w.sql} ORDER BY id LIMIT ${DELETE_CHUNK} FOR UPDATE SKIP LOCKED
           ) x WHERE d.id = x.id RETURNING d.id`,
          w.params,
        );
        if (!rows.length) return 0;
        const ids = rows.map((r) => r.id);
        const ev = await c.query(`DELETE FROM ${this.t("events")} WHERE session_id = ANY($1::text[])`, [ids]);
        await c.query(`DELETE FROM ${this.t("labels")} WHERE session_id = ANY($1::text[])`, [ids]);
        events += ev.rowCount ?? 0;
        return ids.length;
      });
      sessions += n;
      if (n < DELETE_CHUNK) break;
    }
    return { sessions, events };
  }

  /** Deletes these sessions, whatever their age, with their events and labels, DELETE_CHUNK sessions per transaction. */
  async deleteSessions(ids: string[]): Promise<{ sessions: number; events: number }> {
    let sessions = 0;
    let events = 0;
    const unique = [...new Set(ids)].sort();
    for (let i = 0; i < unique.length; i += DELETE_CHUNK) {
      const part = unique.slice(i, i + DELETE_CHUNK);
      await withTx(this.pool, async (c) => {
        const s = await c.query(`DELETE FROM ${this.t("sessions")} WHERE id = ANY($1::text[])`, [part]);
        const ev = await c.query(`DELETE FROM ${this.t("events")} WHERE session_id = ANY($1::text[])`, [part]);
        await c.query(`DELETE FROM ${this.t("labels")} WHERE session_id = ANY($1::text[])`, [part]);
        sessions += s.rowCount ?? 0;
        events += ev.rowCount ?? 0;
      });
    }
    return { sessions, events };
  }

  // ------------------------------------------------------------ cursors

  async getCursor(source: string): Promise<number> {
    const [r] = await this.q(`SELECT "offset" FROM ${this.t("cursors")} WHERE source = $1`, [source]);
    return num(r?.offset) ?? 0;
  }

  async setCursor(source: string, offset: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("cursors")} (source, "offset", updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (source) DO UPDATE SET "offset" = excluded."offset", updated_at = excluded.updated_at`,
      [txt(source), offset, Date.now()],
    );
  }

  // ------------------------------------------------------------ tasks / bundles / runs / labels

  async putTask(t: EvalTask): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("tasks")} (id, name, status, tags, source_session_id, created_at, doc) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, status = excluded.status, tags = excluded.tags,
         source_session_id = excluded.source_session_id, created_at = excluded.created_at, doc = excluded.doc`,
      [txt(t.id), txt(t.name), txt(t.status), JSON.stringify(t.tags ?? []), txt(t.sourceSessionId), t.createdAt, JSON.stringify(t)],
    );
  }

  async getTask(id: string): Promise<EvalTask | undefined> {
    const [r] = await this.q(`SELECT doc FROM ${this.t("tasks")} WHERE id = $1`, [id]);
    return parse<EvalTask>(r?.doc);
  }

  async listTasks(opts: { status?: EvalTask["status"]; tag?: string } = {}): Promise<EvalTask[]> {
    const w = new Where();
    if (opts.status) w.add("status = ?", opts.status);
    if (opts.tag) w.add("EXISTS (SELECT 1 FROM json_array_elements_text(tags::json) AS j(v) WHERE j.v = ?)", opts.tag);
    return (await this.q(`SELECT doc FROM ${this.t("tasks")} ${w.sql} ORDER BY created_at DESC, id`, w.params)).map((r) => parse<EvalTask>(r.doc)!);
  }

  async putBundle(b: HarnessBundle): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("bundles")} (id, name, agent, created_at, doc) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, agent = excluded.agent, created_at = excluded.created_at, doc = excluded.doc`,
      [txt(b.id), txt(b.name), txt(b.agent), b.createdAt, JSON.stringify(b)],
    );
  }

  async getBundle(idOrName: string): Promise<HarnessBundle | undefined> {
    const [byId] = await this.q(`SELECT doc FROM ${this.t("bundles")} WHERE id = $1`, [idOrName]);
    const r = byId ?? (await this.q(`SELECT doc FROM ${this.t("bundles")} WHERE name = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [idOrName]))[0];
    return parse<HarnessBundle>(r?.doc);
  }

  async listBundles(): Promise<HarnessBundle[]> {
    return (await this.q(`SELECT doc FROM ${this.t("bundles")} ORDER BY created_at DESC, id`)).map((r) => parse<HarnessBundle>(r.doc)!);
  }

  async putRun(run: RunResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("runs")} (id, experiment_id, task_id, bundle_id, session_id, pass, started_at, doc) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET experiment_id = excluded.experiment_id, task_id = excluded.task_id, bundle_id = excluded.bundle_id,
         session_id = excluded.session_id, pass = excluded.pass, started_at = excluded.started_at, doc = excluded.doc`,
      [txt(run.id), txt(run.experimentId), txt(run.taskId), txt(run.bundleId), txt(run.sessionId), run.pass, run.startedAt, JSON.stringify(run)],
    );
  }

  async listRuns(f: { taskId?: string; bundleId?: string; experimentId?: string } = {}): Promise<RunResult[]> {
    const w = new Where();
    if (f.taskId) w.add("task_id = ?", f.taskId);
    if (f.bundleId) w.add("bundle_id = ?", f.bundleId);
    if (f.experimentId) w.add("experiment_id = ?", f.experimentId);
    return (await this.q(`SELECT doc FROM ${this.t("runs")} ${w.sql} ORDER BY started_at, id`, w.params)).map((r) => parse<RunResult>(r.doc)!);
  }

  async putLabel(l: Label): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("labels")} (id, session_id, criterion, value, note, "by", ts) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, criterion = excluded.criterion, value = excluded.value,
         note = excluded.note, "by" = excluded."by", ts = excluded.ts`,
      [txt(l.id), txt(l.sessionId), txt(l.criterion), txt(l.value), txt(l.note), txt(l.by), l.ts],
    );
  }

  async listLabels(f: { sessionId?: string; criterion?: string } = {}): Promise<Label[]> {
    const w = new Where();
    if (f.sessionId) w.add("session_id = ?", f.sessionId);
    if (f.criterion) w.add("criterion = ?", f.criterion);
    return (await this.q(`SELECT * FROM ${this.t("labels")} ${w.sql} ORDER BY ts, id`, w.params)).map(rowToLabel);
  }

  // ------------------------------------------------------------ kv

  async kvGet(key: string): Promise<string | undefined> {
    const [r] = await this.q(`SELECT value FROM ${this.t("kv")} WHERE key = $1`, [key]);
    return str(r?.value);
  }

  async kvSet(key: string, value: string | undefined): Promise<void> {
    if (value === undefined) {
      await this.pool.query(`DELETE FROM ${this.t("kv")} WHERE key = $1`, [key]);
      return;
    }
    await this.pool.query(
      `INSERT INTO ${this.t("kv")} (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [txt(key), txt(value), Date.now()],
    );
  }

  // ------------------------------------------------------------ datasets / experiments / judges

  async putDataset(ds: Dataset, opts: { note?: string; now?: number } = {}): Promise<{ version: string; created: boolean }> {
    return withTx(this.pool, async (c) => {
      const createdAt = opts.now ?? ds.createdAt ?? Date.now();
      const stored: Dataset = { ...ds, createdAt };
      const ins = await c.query(
        `INSERT INTO ${this.t("datasets")} (id, version, name, cases, created_at, note, doc) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id, version) DO NOTHING`,
        [txt(ds.id), txt(ds.version), txt(ds.name), ds.cases.length, createdAt, txt(opts.note), JSON.stringify(stored)],
      );
      await c.query(
        `INSERT INTO ${this.t("dataset_latest")} (id, version) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET version = excluded.version`,
        [txt(ds.id), txt(ds.version)],
      );
      return { version: ds.version, created: (ins.rowCount ?? 0) > 0 };
    });
  }

  async getDataset(id: string, version = "latest"): Promise<Dataset | undefined> {
    const [r] = version === "latest"
      ? await this.q(`SELECT d.doc FROM ${this.t("dataset_latest")} l JOIN ${this.t("datasets")} d ON d.id = l.id AND d.version = l.version WHERE l.id = $1`, [id])
      : await this.q(`SELECT doc FROM ${this.t("datasets")} WHERE id = $1 AND version = $2`, [id, version]);
    return parse<Dataset>(r?.doc);
  }

  async listDatasetVersions(id: string): Promise<DatasetVersionInfo[]> {
    const rows = await this.q(`SELECT version, cases, created_at, note FROM ${this.t("datasets")} WHERE id = $1 ORDER BY seq`, [id]);
    return rows.map((r) => {
      const info: DatasetVersionInfo = { version: r.version as string, cases: num(r.cases)!, createdAt: num(r.created_at)! };
      if (typeof r.note === "string") info.note = r.note;
      return info;
    });
  }

  async listDatasets(): Promise<DatasetListing[]> {
    const rows = await this.q(`SELECT l.id, l.version AS latest, d.name, d.cases,
        (SELECT count(*) FROM ${this.t("datasets")} x WHERE x.id = l.id) AS versions
      FROM ${this.t("dataset_latest")} l JOIN ${this.t("datasets")} d ON d.id = l.id AND d.version = l.version ORDER BY l.id`);
    return rows.map((r) => ({ id: r.id as string, name: r.name as string, latest: r.latest as string, versions: num(r.versions)!, cases: num(r.cases)! }));
  }

  async putExperiment(r: ExperimentResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("experiments")} (id, name, dataset_id, created_at, doc) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, dataset_id = excluded.dataset_id, created_at = excluded.created_at, doc = excluded.doc`,
      [txt(r.id), txt(r.name), txt(r.dataset.id), r.createdAt, JSON.stringify(r)],
    );
  }

  async getExperiment(id: string): Promise<ExperimentResult | undefined> {
    const [r] = await this.q(`SELECT doc FROM ${this.t("experiments")} WHERE id = $1`, [id]);
    return parse<ExperimentResult>(r?.doc);
  }

  async listExperiments(f: { datasetId?: string; name?: string; limit?: number } = {}): Promise<ExperimentResult[]> {
    const w = new Where();
    if (f.datasetId) w.add("dataset_id = ?", f.datasetId);
    if (f.name) w.add("name = ?", f.name);
    // Contract: limit 0 returns none, undefined or negative means no limit (Postgres rejects a negative LIMIT).
    const limit = f.limit !== undefined && f.limit >= 0 ? f.limit : null;
    const sql = `SELECT doc FROM ${this.t("experiments")} ${w.sql} ORDER BY id DESC LIMIT ${w.param(limit)}`;
    return (await this.q(sql, w.params)).map((r) => parse<ExperimentResult>(r.doc)!);
  }

  async putJudge(v: JudgeVersion): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.t("judges")} (id, doc) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc`,
      [txt(v.id), JSON.stringify(v)],
    );
  }

  async getJudge(id: string): Promise<JudgeVersion | undefined> {
    const [r] = await this.q(`SELECT doc FROM ${this.t("judges")} WHERE id = $1`, [id]);
    return parse<JudgeVersion>(r?.doc);
  }

  async listJudges(): Promise<JudgeVersion[]> {
    return (await this.q(`SELECT doc FROM ${this.t("judges")} ORDER BY id`)).map((r) => parse<JudgeVersion>(r.doc)!);
  }

  // ------------------------------------------------------------ gc / maintenance

  /** SELECT of the refs at one BLOB_REF_FIELDS entry (paths are constants, not user input). */
  private refFieldSql(f: BlobRefField): string {
    const at = `(x.doc::json #> '{${f.path.join(",")}}')`;
    const from = `${this.t(f.table)} x`;
    if (f.shape === "ref") return `SELECT ${at} #>> '{}' FROM ${from} WHERE json_typeof(${at}) = 'string'`;
    const [each, type, empty] = f.shape === "list" ? ["json_array_elements", "array", "[]"] : ["json_each", "object", "{}"];
    return `SELECT j.value #>> '{}' FROM ${from}, ${each}(CASE WHEN json_typeof(${at}) = '${type}' THEN ${at} ELSE '${empty}'::json END) AS j
      WHERE json_typeof(j.value) = 'string'`;
  }

  /**
   * Every referenced blob, de-duplicated by Postgres and streamed through a
   * cursor so a large events table never lands in memory at once. `json` (not
   * jsonb) accepts any stored document, including escaped \u0000.
   */
  async *referencedBlobs(): AsyncIterable<BlobRef> {
    const sql = [
      `SELECT j.v AS ref FROM ${this.t("events")} e, json_array_elements_text(e.blobs::json) AS j(v) WHERE e.blobs IS NOT NULL`,
      ...BLOB_REF_FIELDS.map((f) => this.refFieldSql(f)),
    ].join("\n      UNION ");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN READ ONLY");
      // gc may scan a large table; the 30 s statement timeout is for request paths.
      await c.query("SET LOCAL statement_timeout = 0");
      await c.query(`DECLARE coding_sh_refs NO SCROLL CURSOR FOR ${sql}`);
      for (;;) {
        const { rows } = await c.query<{ ref: string | null }>("FETCH 5000 FROM coding_sh_refs");
        if (!rows.length) break;
        for (const r of rows) if (typeof r.ref === "string") yield r.ref;
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  async compact(): Promise<void> {
    const tables = ["events", "sessions", "cursors", "tasks", "bundles", "runs", "labels", "kv", "datasets", "dataset_latest", "experiments", "judges", "blobs"];
    const c = await this.pool.connect();
    try {
      await c.query("SET statement_timeout = 0");
      await c.query(`VACUUM (ANALYZE) ${tables.map((t) => this.t(t)).join(", ")}`);
    } finally {
      await c.query("RESET statement_timeout").catch(() => {});
      c.release();
    }
  }

  /**
   * The single-writer lock for `coding.sh serve`: a session advisory lock held
   * by a dedicated connection (outside the pool) for as long as this process
   * writes. Keyed by schema, so separate deployments in one database do not
   * block each other. Resolves undefined when another process holds it after
   * `waitMs`. Needs a direct (or session-mode pooled) connection: transaction
   * poolers do not keep session locks.
   */
  async acquireWriterLock(opts: { waitMs?: number } = {}): Promise<{ release(): Promise<void> } | undefined> {
    const key = `coding.sh:writer:${this.schema}`;
    const client = new pg.Client({ ...clientConfig(this.url), statement_timeout: 0 });
    client.on("error", () => {});
    await client.connect();
    this.lockClients.add(client);
    const drop = async () => {
      this.lockClients.delete(client);
      await client.end().catch(() => {});
    };
    try {
      const deadline = Date.now() + Math.max(0, opts.waitMs ?? 0);
      for (;;) {
        const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [key]);
        if (rows[0]?.ok) break;
        const left = deadline - Date.now();
        if (left <= 0) {
          await drop();
          return undefined;
        }
        await new Promise((r) => setTimeout(r, Math.min(250, left)));
      }
    } catch (err) {
      await drop();
      throw err;
    }
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => {});
        await drop();
      },
    };
  }
}
