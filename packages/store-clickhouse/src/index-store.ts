// IndexStore on ClickHouse. Mirrors the SQLite and Postgres stores table for
// table so the conformance suite holds for all of them. ClickHouse has no
// unique keys, no row locks and no multi-statement transactions, so:
// - upserts write a new row version and reads use FINAL (ReplacingMergeTree);
// - putEvents looks up which ids exist before it writes, serialized within the
//   process, so `inserted` counts are exact for one writer (serve holds the
//   writer lock); a race between two processes can store an event twice, and
//   FINAL hides the copy;
// - deletes are lightweight DELETEs, and the single-writer lock is a lease row
//   with a heartbeat.
import { randomUUID } from "node:crypto";
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
  type HarnessBundle,
  type IndexStore,
  type JudgeVersion,
  type Label,
  type RunResult,
  type SearchHit,
  type Session,
  type SessionFilter,
  type WriterLock,
} from "coding.sh/store";
import { ChClient, migrateDatabase, nextVer, openError, Params, parseChUrl, quoteIdent, quoteLiteral, type RequestOpts } from "./client.ts";

/** Rows per INSERT request. */
const INSERT_CHUNK = 5000;
/** Ids per lookup (each id travels in the request URL). */
const LOOKUP_CHUNK = 1000;
/** Sessions deleted per retention round. */
const DELETE_CHUNK = 500;
/** Cap on indexed text per event, as the Postgres store. */
const SEARCH_TEXT_CAP = 200_000;
/** No LIMIT, as a UInt64 bound. */
const NO_LIMIT = "18446744073709551615";

/** Writer lock: how long a lease lasts without a heartbeat, and how long a claim waits for a rival's to land. */
const LOCK_TTL_MS = 30_000;
const LOCK_SETTLE_MS = 300;

type Row = Record<string, unknown>;

const EVENT_COLS = `id, session_id, project_id, seq, turn_id, parent_id, ts, duration_ms, trace_id, span_id, parent_span_id,
  subagent_id, agent, agent_version, model, kind, run_id, cwd, repo, payload, blobs, usage, source`;

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = <T>(v: unknown): T | undefined => (typeof v === "string" ? (JSON.parse(v) as T) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined);
const opt = (v: string | undefined | null): string | null => (v === undefined ? null : v);
const projectOf = (p: string | undefined): string => p || DEFAULT_PROJECT;

/** Folded search text with a leading space, so a word-prefix match is `LIKE '% term%'`. Empty when the event has none. */
export function searchText(e: AgentEvent): string {
  const text = searchableText(e);
  if (text === undefined) return "";
  let folded = searchTerms(text).join(" ");
  if (!folded) return "";
  if (folded.length > SEARCH_TEXT_CAP) {
    const cut = folded.lastIndexOf(" ", SEARCH_TEXT_CAP);
    folded = folded.slice(0, cut > 0 ? cut : SEARCH_TEXT_CAP);
  }
  return ` ${folded}`;
}

/**
 * Query terms: folded letters and digits only, so a term can hold no LIKE
 * wildcard (% _ \). Each still travels as a bound parameter.
 */
export function likeTerms(text: string): string[] {
  return searchTerms(text).flatMap((t) => t.match(/[\p{L}\p{N}]+/gu) ?? []);
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
  if (Array.isArray(r.blobs) && r.blobs.length) e.blobs = r.blobs as BlobRef[];
  set("usage", parse(r.usage));
  set("source", str(r.source));
  if (typeof r.project_id === "string" && r.project_id !== DEFAULT_PROJECT) e.project = r.project_id;
  return e;
}

function eventRow(e: AgentEvent, seq: number, ver: number): Row {
  const p = e.payload ?? {};
  return {
    id: e.id,
    session_id: e.sessionId,
    project_id: projectOf(e.project),
    seq,
    ver,
    turn_id: opt(e.turnId),
    parent_id: opt(e.parentId),
    ts: e.ts,
    duration_ms: e.durationMs ?? null,
    trace_id: opt(e.traceId),
    span_id: opt(e.spanId),
    parent_span_id: opt(e.parentSpanId),
    subagent_id: opt(e.subagentId),
    agent: e.agent,
    agent_version: opt(e.agentVersion),
    model: opt(e.model),
    kind: e.kind,
    tool: typeof p.tool === "string" ? p.tool : null,
    ok: typeof p.ok === "boolean" ? p.ok : null,
    run_id: opt(e.runId),
    cwd: opt(e.cwd),
    repo: json(e.repo),
    payload: JSON.stringify(p),
    blobs: e.blobs ?? [],
    usage: json(e.usage),
    source: opt(e.source),
    search_text: searchText(e),
  };
}

function rowToSession(r: Row): Session {
  const s: Session = {
    id: r.id as string,
    agent: r.agent as string,
    startedAt: num(r.started_at)!,
    stats: parse<Session["stats"]>(r.stats)!,
    flags: Array.isArray(r.flags) ? (r.flags as string[]) : [],
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

/** WHERE clauses with bound parameters. */
class Where {
  readonly parts: string[] = [];
  readonly p = new Params();
  add(sql: string): this {
    this.parts.push(sql);
    return this;
  }
  bind(type: string, v: Parameters<Params["bind"]>[1]): string {
    return this.p.bind(type, v);
  }
  get sql(): string {
    return this.parts.length ? `WHERE ${this.parts.join(" AND ")}` : "";
  }
}

const chunks = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uniqueById = (batch: AgentEvent[]): AgentEvent[] => {
  const seen = new Set<string>();
  return batch.filter((e) => !seen.has(e.id) && (seen.add(e.id), true));
};

export interface ChIndexOptions {
  /** Test hook: drop the whole database on close. */
  dropDatabaseOnClose?: boolean;
  /** Writer lock lease length (default 30 s); a heartbeat renews it every third of that. */
  lockTtlMs?: number;
  /** How long a lock claim waits for a rival claim to land before it reads the winner (default 300 ms). */
  lockSettleMs?: number;
}

export class ChIndexStore implements IndexStore {
  readonly kind = "clickhouse";
  readonly database: string;
  readonly client: ChClient;
  private readonly d: string;
  private readonly opts: ChIndexOptions;
  private readonly locks = new Set<WriterLock>();
  /** Serializes this process's event writes, so the exists-then-insert of putEvents is exact. */
  private writes: Promise<unknown> = Promise.resolve();
  private migrated = false;
  private closed = false;

  constructor(url: string, opts: ChIndexOptions = {}) {
    this.client = new ChClient(parseChUrl(url));
    this.database = this.client.url.database;
    this.d = quoteIdent(this.database);
    this.opts = opts;
  }

  /** Connects, creates the database if missing and migrates it. */
  static async open(url: string, opts: ChIndexOptions = {}): Promise<ChIndexStore> {
    let store: ChIndexStore;
    try {
      store = new ChIndexStore(url, opts);
      await store.migrate();
    } catch (err) {
      throw openError(url, err);
    }
    return store;
  }

  private t(table: string): string {
    return `${this.d}.${table}`;
  }

  private q<T = Row>(sql: string, p?: Params, o: RequestOpts = {}): Promise<T[]> {
    return this.client.query<T>(sql, { ...o, params: p?.values ?? {} });
  }

  private exec(sql: string, p?: Params, o: RequestOpts = {}): Promise<void> {
    return this.client.exec(sql, { ...o, params: p?.values ?? {} });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn);
    this.writes = run.catch(() => {});
    return run;
  }

  async migrate(): Promise<void> {
    if (this.migrated) return;
    await migrateDatabase(this.client);
    this.migrated = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const l of [...this.locks]) await l.release().catch(() => {});
    await this.writes.catch(() => {});
    if (this.opts.dropDatabaseOnClose) await this.client.exec(`DROP DATABASE IF EXISTS ${this.d}`);
  }

  async ping(): Promise<void> {
    await this.client.query("SELECT 1");
  }

  // ------------------------------------------------------------ events

  async putEvents(batch: AgentEvent[]): Promise<{ inserted: number }> {
    const unique = uniqueById(batch);
    if (!unique.length) return { inserted: 0 };
    return this.serial(async () => {
      const existing = await this.existingIds(unique.map((e) => e.id));
      const fresh = unique.filter((e) => !existing.has(e.id));
      await this.insertEvents(fresh);
      return { inserted: fresh.length };
    });
  }

  /** Which of these ids are stored (any session). Uses the id bloom filter index. */
  private async existingIds(ids: string[], sessionId?: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const part of chunks(ids, LOOKUP_CHUNK)) {
      const w = new Where();
      if (sessionId !== undefined) w.add(`session_id = ${w.bind("String", sessionId)}`);
      w.add(`id IN ${w.bind("Array(String)", part)}`);
      for (const r of await this.q<{ id: string }>(`SELECT DISTINCT id FROM ${this.t("events")} ${w.sql}`, w.p)) out.add(r.id);
    }
    return out;
  }

  /** Inserts events in batch order (seq breaks ties between equal timestamps, like SQLite's rowid). */
  private async insertEvents(events: AgentEvent[]): Promise<void> {
    const rows = events.map((e) => {
      const v = nextVer();
      return eventRow(e, v, v);
    });
    for (const part of chunks(rows, INSERT_CHUNK)) await this.client.insert(this.t("events"), part);
  }

  /**
   * Re-parse: replaces these events of one session (ids of other sessions are
   * ignored) with `add` (idempotent on id, as putEvents). ClickHouse has no
   * multi-statement transactions, so this inserts first and deletes after: the
   * new rows get versions above `floor`, then every older version of a removed
   * id goes. A reader in between sees the old rows and the new ones, never a
   * session missing events; a re-added id already reads as its new version.
   */
  async replaceSessionEvents(sessionId: string, removeIds: string[], add: AgentEvent[]): Promise<{ removed: number; inserted: number }> {
    const unique = uniqueById(add);
    return this.serial(async () => {
      const remove = removeIds.length ? await this.existingIds([...new Set(removeIds)], sessionId) : new Set<string>();
      const stillThere = await this.existingIds(unique.map((e) => e.id).filter((id) => !remove.has(id)));
      const fresh = unique.filter((e) => !stillThere.has(e.id));
      const floor = nextVer();
      await this.insertEvents(fresh);
      for (const part of chunks([...remove], LOOKUP_CHUNK)) {
        const p = new Params();
        await this.exec(
          `DELETE FROM ${this.t("events")} WHERE session_id = ${p.bind("String", sessionId)} AND id IN ${p.bind("Array(String)", part)} AND ver < ${p.bind("UInt64", floor)}`,
          p,
        );
      }
      return { removed: remove.size, inserted: fresh.length };
    });
  }

  /**
   * Sets an estimated cost on stored events: each changed event gets a new row
   * version (same id, seq and search text), which FINAL reads in place of the old.
   */
  async setEventCosts(costs: { id: string; costUsd: number; pricedAs?: string }[]): Promise<number> {
    if (!costs.length) return 0;
    const byId = new Map(costs.map((c) => [c.id, c]));
    return this.serial(async () => {
      let found = 0;
      for (const part of chunks([...byId.keys()], LOOKUP_CHUNK)) {
        const p = new Params();
        const rows = await this.q(`SELECT * FROM ${this.t("events")} FINAL WHERE id IN ${p.bind("Array(String)", part)}`, p);
        const out = rows.map((r) => {
          const c = byId.get(r.id as string)!;
          const { pricedAs: _was, ...payload } = parse<Record<string, unknown>>(r.payload) ?? {};
          const usage = { ...parse<Record<string, unknown>>(r.usage), costUsd: c.costUsd };
          return {
            ...r,
            ver: nextVer(),
            usage: JSON.stringify(usage),
            payload: JSON.stringify({ ...payload, costEstimated: true, ...(c.pricedAs ? { pricedAs: c.pricedAs } : {}) }),
          };
        });
        await this.client.insert(this.t("events"), out);
        found += out.length;
      }
      return found;
    });
  }

  async listEvents(sessionId: string, opts: { kinds?: string[]; limit?: number; offset?: number } = {}): Promise<AgentEvent[]> {
    const w = new Where();
    w.add(`session_id = ${w.bind("String", sessionId)}`);
    if (opts.kinds?.length) w.add(`kind IN ${w.bind("Array(String)", opts.kinds)}`);
    const limit = opts.limit === undefined ? NO_LIMIT : String(Math.max(0, Math.floor(opts.limit)));
    const sql = `SELECT ${EVENT_COLS} FROM ${this.t("events")} FINAL ${w.sql} ORDER BY ts, seq
      LIMIT ${w.bind("UInt64", limit)} OFFSET ${w.bind("UInt64", Math.max(0, Math.floor(opts.offset ?? 0)))}`;
    return (await this.q(sql, w.p)).map(rowToEvent);
  }

  /**
   * Every term must start a word of the event's folded search text
   * (`LIKE '% term%'`), which the ngram skip index narrows to the granules
   * that can match. Newest first.
   */
  async search(text: string, opts: { limit?: number; agent?: AgentId; project?: string } = {}): Promise<SearchHit[]> {
    const terms = likeTerms(text);
    if (!terms.length) return [];
    const w = new Where();
    for (const t of terms) w.add(`search_text LIKE ${w.bind("String", `% ${t}%`)}`);
    if (opts.agent) w.add(`agent = ${w.bind("String", opts.agent)}`);
    if (opts.project) w.add(`project_id = ${w.bind("String", opts.project)}`);
    const sql = `SELECT ${EVENT_COLS} FROM ${this.t("events")} FINAL ${w.sql} ORDER BY ts DESC, id LIMIT ${w.bind("UInt64", opts.limit ?? 50)}`;
    // Every version of an event has the same search text, so skipping granules before FINAL is exact.
    const rows = await this.q(sql, w.p, { settings: { use_skip_indexes_if_final: "1" } });
    return rows.map((r) => {
      const event = rowToEvent(r);
      return { event, snippet: snippet(searchableText(event) ?? "", terms) };
    });
  }

  /** Event count, for doctor/status output and tests. */
  async countEvents(): Promise<number> {
    const [r] = await this.q<{ n: number }>(`SELECT count() AS n FROM ${this.t("events")} FINAL`);
    return r?.n ?? 0;
  }

  // ------------------------------------------------------------ sessions

  async upsertSession(s: Session): Promise<void> {
    let parseVersion = s.parseVersion;
    if (parseVersion === undefined) {
      // An upsert without a parse version keeps the stored one (as the other stores' coalesce).
      const p = new Params();
      const [r] = await this.q(`SELECT parse_version FROM ${this.t("sessions")} FINAL WHERE id = ${p.bind("String", s.id)}`, p);
      parseVersion = num(r?.parse_version);
    }
    await this.client.insert(this.t("sessions"), [{
      id: s.id,
      ver: nextVer(),
      project_id: projectOf(s.project),
      agent: s.agent,
      agent_version: opt(s.agentVersion),
      model: opt(s.model),
      cwd: opt(s.cwd),
      repo: json(s.repo),
      repo_root: opt(s.repo?.root),
      title: opt(s.title),
      started_at: s.startedAt,
      ended_at: s.endedAt ?? null,
      stats: JSON.stringify(s.provider ? { ...s.stats, provider: s.provider } : s.stats),
      flags: s.flags ?? [],
      run_id: opt(s.runId),
      end_snapshot: opt(s.endSnapshot),
      parent: json(s.parent),
      parent_session_id: opt(s.parent?.sessionId),
      trace_ids: s.traceIds?.length ? JSON.stringify(s.traceIds) : null,
      parse_version: parseVersion ?? null,
    }]);
  }

  async getSession(id: string): Promise<Session | undefined> {
    const p = new Params();
    const [r] = await this.q(`SELECT * FROM ${this.t("sessions")} FINAL WHERE id = ${p.bind("String", id)}`, p);
    return r ? rowToSession(r) : undefined;
  }

  async listSessions(f: SessionFilter = {}): Promise<Session[]> {
    const w = new Where();
    if (f.project) w.add(`project_id = ${w.bind("String", f.project)}`);
    if (f.agent) w.add(`agent = ${w.bind("String", f.agent)}`);
    if (f.parentSessionId === null) w.add("parent_session_id IS NULL");
    else if (f.parentSessionId !== undefined) w.add(`parent_session_id = ${w.bind("String", f.parentSessionId)}`);
    if (f.repoRoot) w.add(`repo_root = ${w.bind("String", f.repoRoot)}`);
    if (f.runId === null) w.add("run_id IS NULL");
    else if (f.runId !== undefined) w.add(`run_id = ${w.bind("String", f.runId)}`);
    if (f.flag) w.add(`has(flags, ${w.bind("String", f.flag)})`);
    if (f.since !== undefined) w.add(`started_at >= ${w.bind("Float64", f.since)}`);
    if (f.until !== undefined) w.add(`started_at < ${w.bind("Float64", f.until)}`);
    const limit = f.limit === undefined ? NO_LIMIT : String(Math.max(0, Math.floor(f.limit)));
    const sql = `SELECT * FROM ${this.t("sessions")} FINAL ${w.sql} ORDER BY started_at DESC, id
      LIMIT ${w.bind("UInt64", limit)} OFFSET ${w.bind("UInt64", Math.max(0, Math.floor(f.offset ?? 0)))}`;
    return (await this.q(sql, w.p)).map(rowToSession);
  }

  async sessionIdsByPrefix(prefix: string, limit: number): Promise<string[]> {
    const p = new Params();
    const sql = `SELECT id FROM ${this.t("sessions")} FINAL WHERE startsWith(id, ${p.bind("String", prefix)}) ORDER BY id LIMIT ${p.bind("UInt64", Math.max(0, Math.floor(limit)))}`;
    return (await this.q<{ id: string }>(sql, p)).map((r) => r.id);
  }

  async listProjects(): Promise<string[]> {
    return (await this.q<{ p: string }>(`SELECT DISTINCT project_id AS p FROM ${this.t("sessions")} FINAL ORDER BY p`)).map((r) => r.p);
  }

  /**
   * Retention: deletes sessions whose last activity is before the cutoff, with
   * their events and labels, DELETE_CHUNK sessions per round. Last activity is
   * the latest of coalesce(ended_at, started_at) and every event's end
   * (ts + duration_ms). Events and labels go first, then the session row, so an
   * interrupted sweep leaves sessions the next sweep finds again. Eval assets
   * are kept.
   */
  async deleteBefore(cutoffMs: number, opts: { project?: string } = {}): Promise<{ sessions: number; events: number }> {
    let sessions = 0;
    let events = 0;
    for (;;) {
      const w = new Where();
      const cut = w.bind("Float64", cutoffMs);
      w.add(`coalesce(ended_at, started_at) < ${cut}`);
      if (opts.project) w.add(`project_id = ${w.bind("String", opts.project)}`);
      w.add(`id NOT IN (SELECT DISTINCT session_id FROM ${this.t("events")} WHERE ts + ifNull(duration_ms, 0) >= ${cut})`);
      const ids = (await this.q<{ id: string }>(`SELECT id FROM ${this.t("sessions")} FINAL ${w.sql} ORDER BY id LIMIT ${DELETE_CHUNK}`, w.p, { timeoutMs: 0 })).map((r) => r.id);
      if (!ids.length) break;
      const p = new Params();
      const inIds = p.bind("Array(String)", ids);
      const [c] = await this.q<{ n: number }>(`SELECT count() AS n FROM ${this.t("events")} FINAL WHERE session_id IN ${inIds}`, p, { timeoutMs: 0 });
      await this.exec(`DELETE FROM ${this.t("events")} WHERE session_id IN ${inIds}`, p, { timeoutMs: 0 });
      await this.exec(`DELETE FROM ${this.t("labels")} WHERE session_id IN ${inIds}`, p, { timeoutMs: 0 });
      await this.exec(`DELETE FROM ${this.t("sessions")} WHERE id IN ${inIds}`, p, { timeoutMs: 0 });
      sessions += ids.length;
      events += c?.n ?? 0;
      if (ids.length < DELETE_CHUNK) break;
    }
    return { sessions, events };
  }

  // ------------------------------------------------------------ cursors

  async getCursor(source: string): Promise<number> {
    const p = new Params();
    const [r] = await this.q(`SELECT \`offset\` AS o FROM ${this.t("cursors")} FINAL WHERE source = ${p.bind("String", source)}`, p);
    return num(r?.o) ?? 0;
  }

  async setCursor(source: string, offset: number): Promise<void> {
    await this.client.insert(this.t("cursors"), [{ source, ver: nextVer(), offset, updated_at: Date.now() }]);
  }

  // ------------------------------------------------------------ tasks / bundles / runs / labels

  async putTask(t: EvalTask): Promise<void> {
    await this.client.insert(this.t("tasks"), [{
      id: t.id, ver: nextVer(), name: t.name, status: t.status, tags: t.tags ?? [],
      source_session_id: opt(t.sourceSessionId), created_at: t.createdAt, doc: JSON.stringify(t),
    }]);
  }

  async getTask(id: string): Promise<EvalTask | undefined> {
    const p = new Params();
    const [r] = await this.q(`SELECT doc FROM ${this.t("tasks")} FINAL WHERE id = ${p.bind("String", id)}`, p);
    return parse<EvalTask>(r?.doc);
  }

  async listTasks(opts: { status?: EvalTask["status"]; tag?: string } = {}): Promise<EvalTask[]> {
    const w = new Where();
    if (opts.status) w.add(`status = ${w.bind("String", opts.status)}`);
    if (opts.tag) w.add(`has(tags, ${w.bind("String", opts.tag)})`);
    return (await this.q(`SELECT doc FROM ${this.t("tasks")} FINAL ${w.sql} ORDER BY created_at DESC, id`, w.p)).map((r) => parse<EvalTask>(r.doc)!);
  }

  async putBundle(b: HarnessBundle): Promise<void> {
    await this.client.insert(this.t("bundles"), [{ id: b.id, ver: nextVer(), name: b.name, agent: b.agent, created_at: b.createdAt, doc: JSON.stringify(b) }]);
  }

  async getBundle(idOrName: string): Promise<HarnessBundle | undefined> {
    const p = new Params();
    const v = p.bind("String", idOrName);
    const [r] = await this.q(
      `SELECT doc FROM ${this.t("bundles")} FINAL WHERE id = ${v} OR name = ${v} ORDER BY id = ${v} DESC, created_at DESC, id DESC LIMIT 1`,
      p,
    );
    return parse<HarnessBundle>(r?.doc);
  }

  async listBundles(): Promise<HarnessBundle[]> {
    return (await this.q(`SELECT doc FROM ${this.t("bundles")} FINAL ORDER BY created_at DESC, id`)).map((r) => parse<HarnessBundle>(r.doc)!);
  }

  async putRun(run: RunResult): Promise<void> {
    await this.client.insert(this.t("runs"), [{
      id: run.id, ver: nextVer(), experiment_id: opt(run.experimentId), task_id: run.taskId, bundle_id: run.bundleId,
      session_id: opt(run.sessionId), pass: run.pass, started_at: run.startedAt, doc: JSON.stringify(run),
    }]);
  }

  async listRuns(f: { taskId?: string; bundleId?: string; experimentId?: string } = {}): Promise<RunResult[]> {
    const w = new Where();
    if (f.taskId) w.add(`task_id = ${w.bind("String", f.taskId)}`);
    if (f.bundleId) w.add(`bundle_id = ${w.bind("String", f.bundleId)}`);
    if (f.experimentId) w.add(`experiment_id = ${w.bind("String", f.experimentId)}`);
    return (await this.q(`SELECT doc FROM ${this.t("runs")} FINAL ${w.sql} ORDER BY started_at, id`, w.p)).map((r) => parse<RunResult>(r.doc)!);
  }

  async putLabel(l: Label): Promise<void> {
    await this.client.insert(this.t("labels"), [{
      id: l.id, ver: nextVer(), session_id: l.sessionId, criterion: l.criterion, value: l.value, note: opt(l.note), by: l.by, ts: l.ts,
    }]);
  }

  async listLabels(f: { sessionId?: string; criterion?: string } = {}): Promise<Label[]> {
    const w = new Where();
    if (f.sessionId) w.add(`session_id = ${w.bind("String", f.sessionId)}`);
    if (f.criterion) w.add(`criterion = ${w.bind("String", f.criterion)}`);
    return (await this.q(`SELECT * FROM ${this.t("labels")} FINAL ${w.sql} ORDER BY ts, id`, w.p)).map(rowToLabel);
  }

  // ------------------------------------------------------------ kv

  async kvGet(key: string): Promise<string | undefined> {
    const p = new Params();
    const [r] = await this.q(`SELECT value FROM ${this.t("kv")} FINAL WHERE \`key\` = ${p.bind("String", key)}`, p);
    return str(r?.value);
  }

  async kvSet(key: string, value: string | undefined): Promise<void> {
    await this.client.insert(this.t("kv"), [{ key, ver: nextVer(), deleted: value === undefined ? 1 : 0, value: value ?? "", updated_at: Date.now() }]);
  }

  // ------------------------------------------------------------ datasets / experiments / judges

  async putDataset(ds: Dataset, opts: { note?: string; now?: number } = {}): Promise<{ version: string; created: boolean }> {
    return this.serial(async () => {
      const p = new Params();
      const [had] = await this.q(`SELECT 1 AS x FROM ${this.t("datasets")} WHERE id = ${p.bind("String", ds.id)} AND version = ${p.bind("String", ds.version)} LIMIT 1`, p);
      if (!had) {
        const createdAt = opts.now ?? ds.createdAt ?? Date.now();
        const stored: Dataset = { ...ds, createdAt };
        await this.client.insert(this.t("datasets"), [{
          id: ds.id, version: ds.version, seq: nextVer(), name: ds.name, cases: ds.cases.length, created_at: createdAt, note: opt(opts.note), doc: JSON.stringify(stored),
        }]);
      }
      await this.client.insert(this.t("dataset_latest"), [{ id: ds.id, ver: nextVer(), version: ds.version }]);
      return { version: ds.version, created: !had };
    });
  }

  async getDataset(id: string, version = "latest"): Promise<Dataset | undefined> {
    const p = new Params();
    const at = version === "latest"
      ? `(SELECT version FROM ${this.t("dataset_latest")} FINAL WHERE id = ${p.bind("String", id)})`
      : p.bind("String", version);
    const [r] = await this.q(`SELECT doc FROM ${this.t("datasets")} FINAL WHERE id = ${p.bind("String", id)} AND version = ${at} LIMIT 1`, p);
    return parse<Dataset>(r?.doc);
  }

  async listDatasetVersions(id: string): Promise<DatasetVersionInfo[]> {
    const p = new Params();
    const rows = await this.q(`SELECT version, cases, created_at, note FROM ${this.t("datasets")} FINAL WHERE id = ${p.bind("String", id)} ORDER BY seq`, p);
    return rows.map((r) => {
      const info: DatasetVersionInfo = { version: r.version as string, cases: num(r.cases)!, createdAt: num(r.created_at)! };
      if (typeof r.note === "string") info.note = r.note;
      return info;
    });
  }

  async listDatasets(): Promise<DatasetListing[]> {
    const rows = await this.q(`SELECT l.id AS id, l.version AS latest, d.name AS name, d.cases AS cases, v.n AS versions
      FROM (SELECT id, version FROM ${this.t("dataset_latest")} FINAL) AS l
      INNER JOIN (SELECT id, version, name, cases FROM ${this.t("datasets")} FINAL) AS d ON d.id = l.id AND d.version = l.version
      INNER JOIN (SELECT id, count() AS n FROM ${this.t("datasets")} FINAL GROUP BY id) AS v ON v.id = l.id
      ORDER BY l.id`);
    return rows.map((r) => ({ id: r.id as string, name: r.name as string, latest: r.latest as string, versions: num(r.versions)!, cases: num(r.cases)! }));
  }

  async putExperiment(r: ExperimentResult): Promise<void> {
    await this.client.insert(this.t("experiments"), [{ id: r.id, ver: nextVer(), name: r.name, dataset_id: r.dataset.id, created_at: r.createdAt, doc: JSON.stringify(r) }]);
  }

  async getExperiment(id: string): Promise<ExperimentResult | undefined> {
    const p = new Params();
    const [r] = await this.q(`SELECT doc FROM ${this.t("experiments")} FINAL WHERE id = ${p.bind("String", id)}`, p);
    return parse<ExperimentResult>(r?.doc);
  }

  async listExperiments(f: { datasetId?: string; name?: string; limit?: number } = {}): Promise<ExperimentResult[]> {
    const w = new Where();
    if (f.datasetId) w.add(`dataset_id = ${w.bind("String", f.datasetId)}`);
    if (f.name) w.add(`name = ${w.bind("String", f.name)}`);
    // Contract: limit 0 returns none, undefined or negative means no limit.
    const limit = f.limit !== undefined && f.limit >= 0 ? String(Math.floor(f.limit)) : NO_LIMIT;
    const sql = `SELECT doc FROM ${this.t("experiments")} FINAL ${w.sql} ORDER BY id DESC LIMIT ${w.bind("UInt64", limit)}`;
    return (await this.q(sql, w.p)).map((r) => parse<ExperimentResult>(r.doc)!);
  }

  async putJudge(v: JudgeVersion): Promise<void> {
    await this.client.insert(this.t("judges"), [{ id: v.id, ver: nextVer(), doc: JSON.stringify(v) }]);
  }

  async getJudge(id: string): Promise<JudgeVersion | undefined> {
    const p = new Params();
    const [r] = await this.q(`SELECT doc FROM ${this.t("judges")} FINAL WHERE id = ${p.bind("String", id)}`, p);
    return parse<JudgeVersion>(r?.doc);
  }

  async listJudges(): Promise<JudgeVersion[]> {
    return (await this.q(`SELECT doc FROM ${this.t("judges")} FINAL ORDER BY id`)).map((r) => parse<JudgeVersion>(r.doc)!);
  }

  // ------------------------------------------------------------ gc / maintenance

  /** SELECT of the refs at one BLOB_REF_FIELDS entry. Paths are constants from the core package, quoted as literals. */
  private refFieldSql(f: BlobRefField): string {
    const path = f.path.map(quoteLiteral).join(", ");
    const from = `${this.t(f.table)} FINAL`;
    // Values of the wrong JSON type extract as '' (or []), and are filtered out below.
    if (f.shape === "ref") return `SELECT JSONExtractString(doc, ${path}) AS ref FROM ${from}`;
    if (f.shape === "list") return `SELECT arrayJoin(JSONExtract(doc, ${path}, 'Array(Nullable(String))')) AS ref FROM ${from}`;
    return `SELECT arrayJoin(arrayMap(kv -> kv.2, JSONExtractKeysAndValues(doc, ${path}, 'Nullable(String)'))) AS ref FROM ${from}`;
  }

  /** Every referenced blob, de-duplicated by ClickHouse and streamed, so a large events table never lands in memory. */
  async *referencedBlobs(): AsyncIterable<BlobRef> {
    const parts = [
      `SELECT arrayJoin(blobs) AS ref FROM ${this.t("events")} WHERE notEmpty(blobs)`,
      ...BLOB_REF_FIELDS.map((f) => this.refFieldSql(f)),
    ];
    const sql = `SELECT DISTINCT ref FROM (${parts.join("\n      UNION ALL ")}) WHERE ref IS NOT NULL AND ref != ''`;
    for await (const r of this.client.stream<{ ref: string | null }>(sql, { timeoutMs: 0 })) {
      if (typeof r.ref === "string") yield r.ref;
    }
  }

  /** Merges every table down (OPTIMIZE … FINAL): drops replaced row versions and rows removed by DELETE. */
  async compact(): Promise<void> {
    const tables = ["events", "sessions", "cursors", "tasks", "bundles", "runs", "labels", "kv", "datasets", "dataset_latest", "experiments", "judges", "locks"];
    for (const t of tables) await this.client.exec(`OPTIMIZE TABLE ${this.t(t)} FINAL`, { timeoutMs: 0 });
  }

  // ------------------------------------------------------------ writer lock

  /** Live (unreleased, unexpired by the server's clock) claims, oldest first: the first is the holder. */
  private async liveClaims(name: string): Promise<{ holder: string; claimed_at: number }[]> {
    const p = new Params();
    return this.q(
      `SELECT holder, claimed_at FROM ${this.t("locks")} FINAL
       WHERE name = ${p.bind("String", name)} AND released = 0 AND expires_at > toUnixTimestamp64Milli(now64(3))
       ORDER BY claimed_at, holder`,
      p,
    );
  }

  /** Writes (or renews) a claim row; claimedAt null stamps it with the server's clock. */
  private async writeClaim(name: string, holder: string, claimedAt: number | null, ttlMs: number, released = false): Promise<void> {
    const p = new Params();
    const claimed = claimedAt === null ? "toUnixTimestamp64Milli(now64(3))" : p.bind("Int64", claimedAt);
    await this.exec(
      `INSERT INTO ${this.t("locks")} (name, holder, ver, claimed_at, expires_at, released)
       SELECT ${p.bind("String", name)}, ${p.bind("String", holder)}, ${p.bind("UInt64", nextVer())}, ${claimed},
         toUnixTimestamp64Milli(now64(3)) + ${p.bind("Int64", ttlMs)}, ${released ? 1 : 0}`,
      p,
      { settings: { async_insert: "0" } },
    );
  }

  /**
   * The single-writer lock for `coding.sh serve`, as a lease: a claim row that
   * expires after lockTtlMs unless its holder's heartbeat renews it (every
   * third of that). ClickHouse has no compare-and-set, so a claimant writes its
   * row, waits lockSettleMs for a rival's to land, and holds the lock only if
   * its claim is the oldest live one. A replica that crashes frees the lock
   * when its lease runs out; `assertHeld` throws once this holder's lease may
   * have lapsed or another claim took over, so serve stops writing.
   * Resolves undefined when another process holds it after `waitMs`.
   */
  async acquireWriterLock(opts: { waitMs?: number } = {}): Promise<WriterLock | undefined> {
    const name = "writer";
    const ttl = this.opts.lockTtlMs ?? LOCK_TTL_MS;
    const settle = this.opts.lockSettleMs ?? LOCK_SETTLE_MS;
    const holder = randomUUID();
    const deadline = Date.now() + Math.max(0, opts.waitMs ?? 0);
    for (;;) {
      if (!(await this.liveClaims(name)).length) {
        await this.writeClaim(name, holder, null, ttl);
        await sleep(settle);
        const live = await this.liveClaims(name);
        if (live[0]?.holder === holder) return this.holdLock(name, holder, live[0].claimed_at, ttl);
        await this.writeClaim(name, holder, 0, 0, true).catch(() => {});
      }
      const left = deadline - Date.now();
      if (left <= 0) return undefined;
      await sleep(Math.min(250, left));
    }
  }

  private holdLock(name: string, holder: string, claimedAt: number, ttl: number): WriterLock {
    let renewedAt = Date.now();
    let lost: string | undefined;
    let released = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          await this.writeClaim(name, holder, claimedAt, ttl);
          const live = await this.liveClaims(name);
          if (live[0]?.holder !== holder) lost = "another replica took the writer lock";
          else renewedAt = Date.now();
        } catch {
          // A missed heartbeat is retried on the next tick; assertHeld fails once the lease may have run out.
        }
      })();
    }, Math.max(50, Math.floor(ttl / 3)));
    timer.unref();
    const lock: WriterLock = {
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        this.locks.delete(lock);
        await this.writeClaim(name, holder, claimedAt, 0, true).catch(() => {});
      },
      assertHeld: () => {
        if (released) throw new Error("the writer lock was released");
        if (lost) throw new Error(lost);
        // Margin for the clock difference between this host and the server.
        if (Date.now() - renewedAt > ttl - Math.min(2_000, ttl / 4)) throw new Error("the writer lock lease ran out (heartbeat failed)");
      },
    };
    this.locks.add(lock);
    return lock;
  }
}
