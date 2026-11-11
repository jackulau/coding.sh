// In-memory IndexStore and BlobStore. Used by tests of other modules and as
// the reference implementation third-party backends can read alongside the
// conformance suite. Everything is cloned in and out, like a real database.
import type { AgentEvent, BlobRef, Session } from "../schema/index.ts";
import type { Dataset, DatasetVersionInfo, ExperimentResult, JudgeVersion } from "../datasets/types.ts";
import type {
  BlobMeta,
  DatasetListing,
  BlobStore,
  EvalTask,
  EventCost,
  HarnessBundle,
  IndexStore,
  Label,
  RunResult,
  Score,
  ScoreConfig,
  ScoreFilter,
  SearchHit,
  SearchOpts,
  SessionFilter,
  WriterLock,
} from "../core/types.ts";
import { sha256Hex } from "../core/ids.ts";
import { memoryEventOf, type MemoryEvent } from "../core/memory-events.ts";
import { labelToScore, scoreToLabel } from "../scores/labels.ts";
import {
  assertBlobRef,
  bundleBlobs,
  runBlobs,
  searchableText,
  searchTerms,
  termMatches,
  snippet,
  taskBlobs,
  toBytes,
} from "./common.ts";

const clone = <T>(v: T): T => structuredClone(v);
const projectOf = (x: { project?: string }): string => x.project ?? "default";
/** Stores keep "default" as the absence of a project, like the SQL column default. */
function normProject<T extends { project?: string }>(x: T): T {
  if (x.project === "default") delete x.project;
  return x;
}

export class MemoryIndexStore implements IndexStore {
  readonly kind = "memory";
  private readonly events = new Map<string, { seq: number; event: AgentEvent }>();
  private readonly sessions = new Map<string, Session>();
  private readonly cursors = new Map<string, number>();
  private readonly tasks = new Map<string, EvalTask>();
  private readonly bundles = new Map<string, HarnessBundle>();
  private readonly runs = new Map<string, RunResult>();
  private readonly scores = new Map<string, Score>();
  private readonly scoreConfigs = new Map<string, ScoreConfig>();
  private readonly kv = new Map<string, string>();
  /** dataset id → version → { doc, info } (insertion order = history order). */
  private readonly datasets = new Map<string, Map<string, { doc: Dataset; info: DatasetVersionInfo }>>();
  private readonly datasetLatest = new Map<string, string>();
  private readonly experiments = new Map<string, ExperimentResult>();
  private readonly judges = new Map<string, JudgeVersion>();
  private seq = 0;
  private writerHeld = false;

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}
  async ping(): Promise<void> {}

  async acquireWriterLock(): Promise<WriterLock | undefined> {
    if (this.writerHeld) return undefined;
    this.writerHeld = true;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.writerHeld = false;
      },
    };
  }

  async listProjects(): Promise<string[]> {
    return [...new Set([...this.sessions.values()].map(projectOf))].sort();
  }

  async deleteBefore(cutoffMs: number, opts: { project?: string } = {}): Promise<{ sessions: number; events: number }> {
    // Last activity: the recorded end (or start) and every event's end (see IndexStore.deleteBefore).
    const lastActivity = new Map<string, number>();
    for (const s of this.sessions.values()) lastActivity.set(s.id, s.endedAt ?? s.startedAt);
    for (const { event: e } of this.events.values()) {
      const at = lastActivity.get(e.sessionId);
      if (at !== undefined) lastActivity.set(e.sessionId, Math.max(at, e.ts + (e.durationMs ?? 0)));
    }
    const doomed = new Set<string>();
    for (const s of this.sessions.values()) {
      if (opts.project !== undefined && projectOf(s) !== opts.project) continue;
      if (lastActivity.get(s.id)! < cutoffMs) doomed.add(s.id);
    }
    return this.dropSessions(doomed);
  }

  async deleteSessions(ids: string[]): Promise<{ sessions: number; events: number }> {
    return this.dropSessions(new Set(ids));
  }

  private dropSessions(doomed: Set<string>): { sessions: number; events: number } {
    let events = 0;
    for (const [id, r] of this.events) {
      if (doomed.has(r.event.sessionId)) {
        this.events.delete(id);
        events++;
      }
    }
    for (const [id, s] of this.scores) if (s.sessionId !== undefined && doomed.has(s.sessionId)) this.scores.delete(id);
    let sessions = 0;
    for (const id of doomed) if (this.sessions.delete(id)) sessions++;
    return { sessions, events };
  }

  async putEvents(batch: AgentEvent[]): Promise<{ inserted: number }> {
    return { inserted: this.insertEvents(batch).length };
  }

  async putEventsReturningIds(batch: AgentEvent[]): Promise<{ inserted: number; ids: string[] }> {
    const ids = this.insertEvents(batch);
    return { inserted: ids.length, ids };
  }

  /** Stores the events whose id is new; returns those ids. */
  private insertEvents(batch: AgentEvent[]): string[] {
    const ids: string[] = [];
    for (const e of batch) {
      if (this.events.has(e.id)) continue;
      this.events.set(e.id, { seq: this.seq++, event: normProject(clone(e)) });
      ids.push(e.id);
    }
    return ids;
  }

  async replaceSessionEvents(sessionId: string, removeIds: string[], add: AgentEvent[]): Promise<{ removed: number; inserted: number }> {
    let removed = 0;
    for (const id of new Set(removeIds)) {
      if (this.events.get(id)?.event.sessionId !== sessionId) continue;
      this.events.delete(id);
      removed++;
    }
    return { removed, ...(await this.putEvents(add)) };
  }

  async setEventCosts(costs: EventCost[]): Promise<number> {
    let found = 0;
    for (const { id, costUsd, pricedAs, priceTier } of costs) {
      const r = this.events.get(id);
      if (!r) continue;
      const { pricedAs: _was, priceTier: _tier, ...payload } = r.event.payload;
      r.event = { ...r.event, usage: { ...r.event.usage, costUsd }, payload: { ...payload, costEstimated: true, ...(pricedAs ? { pricedAs } : {}), ...(priceTier ? { priceTier } : {}) } };
      found++;
    }
    return found;
  }

  async listEvents(sessionId: string, opts: { kinds?: string[]; limit?: number; offset?: number } = {}): Promise<AgentEvent[]> {
    const rows = [...this.events.values()]
      .filter(({ event: e }) => e.sessionId === sessionId && (!opts.kinds?.length || opts.kinds.includes(e.kind)))
      .sort((a, b) => a.event.ts - b.event.ts || a.seq - b.seq)
      .map((r) => clone(r.event));
    return page(rows, opts.limit, opts.offset);
  }

  async memoryEvents(sessionIds: readonly string[]): Promise<MemoryEvent[]> {
    const ids = new Set(sessionIds);
    return [...this.events.values()]
      .filter(({ event: e }) => ids.has(e.sessionId))
      .sort((a, b) => a.event.ts - b.event.ts || a.seq - b.seq)
      .flatMap(({ event: e }) => {
        const m = memoryEventOf(e);
        return m ? [clone(m)] : [];
      });
  }

  async search(text: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const terms = searchTerms(text);
    if (!terms.length) return [];
    const hits: { hit: SearchHit; score: number }[] = [];
    for (const { event } of this.events.values()) {
      if (opts.agent && event.agent !== opts.agent) continue;
      if (opts.project !== undefined && projectOf(event) !== opts.project) continue;
      const body = searchableText(event);
      if (!body) continue;
      const words = searchTerms(body);
      // Every term must appear as a word, the last as a word prefix (mirrors ftsQuery, minus stemming).
      if (!terms.every((_, i) => words.some((w) => termMatches(w, terms, i)))) continue;
      const score = terms.reduce((n, _, i) => n + words.filter((w) => termMatches(w, terms, i)).length, 0);
      hits.push({ hit: { event: clone(event), snippet: snippet(body, terms) }, score });
    }
    hits.sort((a, b) => b.score - a.score || b.hit.event.ts - a.hit.event.ts);
    return hits.slice(0, opts.limit ?? 50).map((h) => h.hit);
  }

  async upsertSession(s: Session): Promise<void> {
    const prev = this.sessions.get(s.id)?.parseVersion;
    const next = normProject(clone(s));
    // Unset keeps the stored parse version (IndexStore contract, as the SQL stores' coalesce).
    if (next.parseVersion === undefined && prev !== undefined) next.parseVersion = prev;
    this.sessions.set(s.id, next);
  }

  async getSession(id: string): Promise<Session | undefined> {
    const s = this.sessions.get(id);
    return s ? clone(s) : undefined;
  }

  async sessionIdsByPrefix(prefix: string, limit: number): Promise<string[]> {
    return [...this.sessions.keys()].filter((id) => id.startsWith(prefix)).sort().slice(0, limit);
  }

  async sessionsWithoutRow(): Promise<{ sessionId: string; agent: string }[]> {
    const out = new Map<string, string>();
    for (const { event: e } of this.events.values()) {
      if (this.sessions.has(e.sessionId)) continue;
      const agent = out.get(e.sessionId);
      if (agent === undefined || e.agent < agent) out.set(e.sessionId, e.agent);
    }
    return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([sessionId, agent]) => ({ sessionId, agent }));
  }

  async eventsByIdPrefix(prefix: string, limit: number): Promise<AgentEvent[]> {
    return [...this.events.values()]
      .map((r) => r.event)
      .filter((e) => e.id.startsWith(prefix))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map(clone);
  }

  async childCounts(parentIds: string[], opts: { project?: string } = {}): Promise<Record<string, number>> {
    const want = new Set(parentIds);
    const out: Record<string, number> = {};
    for (const s of this.sessions.values()) {
      const p = s.parent?.sessionId;
      if (p === undefined || !want.has(p) || (opts.project !== undefined && projectOf(s) !== opts.project)) continue;
      out[p] = (out[p] ?? 0) + 1;
    }
    return out;
  }

  async listSessions(f: SessionFilter = {}): Promise<Session[]> {
    const rows = [...this.sessions.values()]
      .filter((s) =>
        (!f.agent || s.agent === f.agent) &&
        (f.parentSessionId === undefined || (f.parentSessionId === null ? !s.parent : s.parent?.sessionId === f.parentSessionId)) &&
        (!f.repoRoot || s.repo?.root === f.repoRoot) &&
        (f.runId === undefined || (f.runId === null ? s.runId === undefined : s.runId === f.runId)) &&
        (!f.flag || s.flags.includes(f.flag)) &&
        (f.since === undefined || s.startedAt >= f.since) &&
        (f.until === undefined || s.startedAt < f.until) &&
        (f.project === undefined || projectOf(s) === f.project))
      .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(clone);
    return page(rows, f.limit, f.offset);
  }

  async getCursor(source: string): Promise<number> {
    return this.cursors.get(source) ?? 0;
  }

  async setCursor(source: string, offset: number): Promise<void> {
    if (offset === 0) this.cursors.delete(source);
    else this.cursors.set(source, offset);
  }

  async putTask(t: EvalTask): Promise<void> {
    this.tasks.set(t.id, clone(t));
  }

  async getTask(id: string): Promise<EvalTask | undefined> {
    const t = this.tasks.get(id);
    return t ? clone(t) : undefined;
  }

  async listTasks(opts: { status?: EvalTask["status"]; tag?: string } = {}): Promise<EvalTask[]> {
    return [...this.tasks.values()]
      .filter((t) => (!opts.status || t.status === opts.status) && (!opts.tag || t.tags.includes(opts.tag)))
      .sort(byCreatedDesc)
      .map(clone);
  }

  async putBundle(b: HarnessBundle): Promise<void> {
    this.bundles.set(b.id, clone(b));
  }

  async getBundle(idOrName: string): Promise<HarnessBundle | undefined> {
    // Newest createdAt, ties to the greatest id (like the SQL stores' ORDER BY created_at DESC, id DESC).
    const b = this.bundles.get(idOrName) ??
      [...this.bundles.values()].filter((x) => x.name === idOrName).sort((x, y) => y.createdAt - x.createdAt || cmp(y.id, x.id))[0];
    return b ? clone(b) : undefined;
  }

  async listBundles(): Promise<HarnessBundle[]> {
    return [...this.bundles.values()].sort(byCreatedDesc).map(clone);
  }

  async putRun(r: RunResult): Promise<void> {
    this.runs.set(r.id, clone(r));
  }

  async listRuns(f: { taskId?: string; bundleId?: string; experimentId?: string } = {}): Promise<RunResult[]> {
    return [...this.runs.values()]
      .filter((r) => (!f.taskId || r.taskId === f.taskId) && (!f.bundleId || r.bundleId === f.bundleId) && (!f.experimentId || r.experimentId === f.experimentId))
      .sort((a, b) => a.startedAt - b.startedAt || cmp(a.id, b.id))
      .map(clone);
  }

  // Labels are human scores (src/scores/labels.ts).
  async putLabel(l: Label): Promise<void> {
    await this.putScore(labelToScore(l));
  }

  async listLabels(f: { sessionId?: string; criterion?: string } = {}): Promise<Label[]> {
    const out: Label[] = [];
    for (const s of this.scores.values()) {
      const l = scoreToLabel(s);
      if (l && (!f.sessionId || l.sessionId === f.sessionId) && (!f.criterion || l.criterion === f.criterion)) out.push(l);
    }
    return out.sort((a, b) => a.ts - b.ts || cmp(a.id, b.id));
  }

  async putScore(s: Score): Promise<void> {
    this.scores.set(s.id, clone(s));
  }

  async listScores(f: ScoreFilter = {}): Promise<Score[]> {
    const rows = [...this.scores.values()]
      .filter(
        (s) =>
          (f.id === undefined || s.id === f.id) &&
          (f.target === undefined || s.target === f.target) &&
          (f.targetId === undefined || s.targetId === f.targetId) &&
          (f.sessionId === undefined || s.sessionId === f.sessionId) &&
          (f.name === undefined || s.name === f.name) &&
          (f.source === undefined || s.source === f.source) &&
          (f.since === undefined || s.ts >= f.since) &&
          (f.until === undefined || s.ts < f.until),
      )
      .sort((a, b) => b.ts - a.ts || cmp(b.id, a.id));
    return (f.limit === undefined ? rows : rows.slice(0, Math.max(0, Math.floor(f.limit)))).map(clone);
  }

  async putScoreConfig(c: ScoreConfig): Promise<void> {
    this.scoreConfigs.set(c.id, clone(c));
  }

  async listScoreConfigs(): Promise<ScoreConfig[]> {
    return [...this.scoreConfigs.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id)).map(clone);
  }

  async kvGet(key: string): Promise<string | undefined> {
    return this.kv.get(key);
  }

  async kvSet(key: string, value: string | undefined): Promise<void> {
    if (value === undefined) this.kv.delete(key);
    else this.kv.set(key, value);
  }

  async putDataset(ds: Dataset, opts: { note?: string; now?: number } = {}): Promise<{ version: string; created: boolean }> {
    let versions = this.datasets.get(ds.id);
    if (!versions) this.datasets.set(ds.id, (versions = new Map()));
    let created = false;
    if (!versions.has(ds.version)) {
      const createdAt = opts.now ?? ds.createdAt ?? Date.now();
      const info: DatasetVersionInfo = { version: ds.version, cases: ds.cases.length, createdAt };
      if (opts.note) info.note = opts.note;
      versions.set(ds.version, { doc: clone({ ...ds, createdAt }), info });
      created = true;
    }
    this.datasetLatest.set(ds.id, ds.version);
    return { version: ds.version, created };
  }

  async getDataset(id: string, version = "latest"): Promise<Dataset | undefined> {
    const v = version === "latest" ? this.datasetLatest.get(id) : version;
    const d = v === undefined ? undefined : this.datasets.get(id)?.get(v);
    return d ? clone(d.doc) : undefined;
  }

  async listDatasetVersions(id: string): Promise<DatasetVersionInfo[]> {
    return [...(this.datasets.get(id)?.values() ?? [])].map((d) => clone(d.info));
  }

  async listDatasets(): Promise<DatasetListing[]> {
    return [...this.datasetLatest.keys()].sort(cmp).map((id) => {
      const versions = this.datasets.get(id)!;
      const doc = versions.get(this.datasetLatest.get(id)!)!.doc;
      return { id, name: doc.name, latest: doc.version, versions: versions.size, cases: doc.cases.length };
    });
  }

  async putExperiment(r: ExperimentResult): Promise<void> {
    this.experiments.set(r.id, clone(r));
  }

  async getExperiment(id: string): Promise<ExperimentResult | undefined> {
    const r = this.experiments.get(id);
    return r ? clone(r) : undefined;
  }

  async listExperiments(f: { datasetId?: string; name?: string; limit?: number } = {}): Promise<ExperimentResult[]> {
    const rows = [...this.experiments.values()]
      .filter((r) => (!f.datasetId || r.dataset.id === f.datasetId) && (!f.name || r.name === f.name))
      .sort((a, b) => cmp(b.id, a.id))
      .map(clone);
    return page(rows, f.limit); // 0 → none, undefined or negative → all
  }

  async putJudge(v: JudgeVersion): Promise<void> {
    this.judges.set(v.id, clone(v));
  }

  async getJudge(id: string): Promise<JudgeVersion | undefined> {
    const v = this.judges.get(id);
    return v ? clone(v) : undefined;
  }

  async listJudges(): Promise<JudgeVersion[]> {
    return [...this.judges.values()].sort((a, b) => cmp(a.id, b.id)).map(clone);
  }

  async *referencedBlobs(): AsyncIterable<BlobRef> {
    const seen = new Set<BlobRef>();
    const all = [
      ...[...this.events.values()].flatMap((r) => r.event.blobs ?? []),
      ...[...this.tasks.values()].flatMap(taskBlobs),
      ...[...this.bundles.values()].flatMap(bundleBlobs),
      ...[...this.runs.values()].flatMap(runBlobs),
    ];
    for (const ref of all) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      yield ref;
    }
  }
}

export class MemoryBlobStore implements BlobStore {
  readonly kind = "memory";
  private readonly blobs = new Map<BlobRef, { data: Uint8Array; mtimeMs: number; contentType?: string }>();

  async put(data: Uint8Array | string, meta?: BlobMeta): Promise<BlobRef> {
    const bytes = toBytes(data);
    const ref = sha256Hex(bytes);
    const existing = this.blobs.get(ref);
    if (existing) existing.mtimeMs = Date.now();
    else this.blobs.set(ref, { data: new Uint8Array(bytes), mtimeMs: Date.now(), contentType: meta?.contentType });
    return ref;
  }

  async get(ref: BlobRef): Promise<Uint8Array | undefined> {
    assertBlobRef(ref);
    const b = this.blobs.get(ref);
    return b ? new Uint8Array(b.data) : undefined;
  }

  async getText(ref: BlobRef): Promise<string | undefined> {
    const b = await this.get(ref);
    return b ? new TextDecoder().decode(b) : undefined;
  }

  async has(refs: BlobRef[]): Promise<boolean[]> {
    return refs.map((r) => this.blobs.has(r));
  }

  async *list(): AsyncIterable<BlobRef> {
    yield* [...this.blobs.keys()];
  }

  async delete(ref: BlobRef): Promise<void> {
    assertBlobRef(ref);
    this.blobs.delete(ref);
  }

  async size(): Promise<number> {
    let n = 0;
    for (const b of this.blobs.values()) n += b.data.byteLength;
    return n;
  }

  /** Size and last write/dedupe time, used by gc to spare young blobs. */
  async stat(ref: BlobRef): Promise<{ size: number; mtimeMs: number } | undefined> {
    const b = this.blobs.get(ref);
    return b ? { size: b.data.byteLength, mtimeMs: b.mtimeMs } : undefined;
  }

  /** Test hook: backdate a blob so gc treats it as old. */
  touch(ref: BlobRef, mtimeMs: number): void {
    const b = this.blobs.get(ref);
    if (b) b.mtimeMs = mtimeMs;
  }
}

function page<T>(rows: T[], limit?: number, offset?: number): T[] {
  const start = offset ?? 0;
  return limit === undefined || limit < 0 ? rows.slice(start) : rows.slice(start, start + limit);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byCreatedDesc(a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number {
  return b.createdAt - a.createdAt || cmp(a.id, b.id);
}
