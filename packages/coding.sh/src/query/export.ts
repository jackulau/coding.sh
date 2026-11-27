// `coding.sh export sessions|events|labels|scores`: stream stored rows as JSONL or CSV.
//
// Works on every index store (it only uses the IndexStore interface): sessions are
// read a page at a time with the `sessions` filters, events a page at a time per
// session, so memory stays flat however large the store is. Sessions and events are
// already redacted at ingest; score text fields are redacted on export.
import { dateMs, isoMs } from "../core/dates.ts";
import { createRedactor, type Redactor } from "../core/redact.ts";
import type { IndexStore, Label, Score, ScoreFilter, ScoreSource, SessionFilter } from "../core/types.ts";
import type { AgentEvent, Session } from "../schema/index.ts";
import { ScoreError } from "../scores/scores.ts";
import { csvRow } from "./csv.ts";
import { findSessions, sessionMatcher } from "./run.ts";
import type { Query } from "./where.ts";

export const EXPORT_KINDS = ["sessions", "events", "labels", "scores"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const EXPORT_FORMATS = ["jsonl", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  /** Which sessions (limit and offset are ignored; use maxSessions). */
  filter: Omit<SessionFilter, "limit" | "offset">;
  /** Stop after this many sessions (newest first, or by query.sort), or scores when exporting scores without session filters. */
  maxSessions?: number;
  /** `--where`: only sessions matching it (src/query). */
  query?: Query;
  /** With `scores`: only scores with this name. */
  scoreName?: string;
  /** With `scores`: only scores from this source. */
  scoreSource?: ScoreSource;
  /** With `scores`: redactor for text values and comments (default: built-in secret rules; null disables). */
  redactor?: Redactor | null;
  format: ExportFormat;
  /** Receives the output in order; awaited, so a slow consumer applies backpressure. */
  write(chunk: string): void | Promise<void>;
  /** Rows per store read (tests use small pages). */
  pageSize?: number;
}

const iso = (ms: number | undefined): string | null => isoMs(ms) ?? null;

export const CSV_COLUMNS: Record<ExportKind, readonly string[]> = {
  sessions: ["id", "agent", "model", "title", "started_at", "ended_at", "duration_ms", "repo_root", "branch", "parent_session_id", "project", "events", "turns", "tool_calls", "tool_errors", "files_changed", "input_tokens", "output_tokens", "cost_usd", "flags"],
  events: ["id", "session_id", "ts", "kind", "agent", "model", "tool", "ok", "duration_ms", "turn_id", "subagent_id", "input_tokens", "output_tokens", "cost_usd", "payload"],
  labels: ["id", "session_id", "case_id", "criterion", "value", "note", "by", "ts"],
  scores: ["id", "target", "target_id", "session_id", "name", "data_type", "value", "source", "config_id", "judge_version", "calibrated", "comment", "by", "ts"],
};

function sessionCells(s: Session): unknown[] {
  const u = s.stats.usage;
  const start = dateMs(s.startedAt);
  const end = dateMs(s.endedAt);
  return [
    s.id, s.agent, s.model ?? null, s.title ?? null, iso(start), iso(end), start !== undefined && end !== undefined ? end - start : null,
    s.repo?.root ?? null, s.repo?.branch ?? null, s.parent?.sessionId ?? null, s.project ?? null, s.stats.events, s.stats.turns, s.stats.toolCalls,
    s.stats.toolErrors, s.stats.filesChanged, u?.inputTokens ?? null, u?.outputTokens ?? null, u?.costUsd ?? null, s.flags.join(" "),
  ];
}

function eventCells(e: AgentEvent): unknown[] {
  const p = e.payload ?? {};
  return [
    e.id, e.sessionId, iso(e.ts), e.kind, e.agent, e.model ?? null, typeof p.tool === "string" ? p.tool : null, typeof p.ok === "boolean" ? p.ok : null,
    e.durationMs ?? null, e.turnId ?? null, e.subagentId ?? null, e.usage?.inputTokens ?? null, e.usage?.outputTokens ?? null, e.usage?.costUsd ?? null,
    JSON.stringify(p),
  ];
}

const labelCells = (l: Label): unknown[] => [l.id, l.sessionId, l.caseId ?? null, l.criterion, l.value, l.note ?? null, l.by, iso(l.ts)];

const scoreCells = (s: Score): unknown[] => [
  s.id,
  s.target,
  s.targetId,
  s.sessionId ?? null,
  s.name,
  s.dataType,
  s.value,
  s.source,
  s.configId ?? null,
  s.judgeVersion ?? null,
  s.calibrated ?? null,
  s.comment ?? null,
  s.by,
  iso(s.ts),
];

function redactScore(s: Score, redactor: Redactor | undefined): Score {
  if (!redactor) return s;
  const value = typeof s.value === "string" ? redactor.string(s.value) : s.value;
  const comment = s.comment !== undefined ? redactor.string(s.comment) : undefined;
  if (value === s.value && comment === s.comment) return s;
  const out: Score = { ...s, value };
  if (comment !== undefined) out.comment = comment;
  return out;
}

/**
 * Sessions matching the filter (and the query), newest first, a page at a time.
 * A store with a query path pages the query itself; otherwise each page of
 * listSessions is filtered in memory.
 */
export async function* sessionsOf(index: IndexStore, o: Pick<ExportOptions, "filter" | "maxSessions" | "query" | "pageSize">): AsyncGenerator<Session> {
  const page = o.pageSize ?? 500;
  const q = o.query?.root || o.query?.sort ? o.query : undefined;
  const native = q && index.querySessions ? index.querySessions.bind(index) : undefined;
  if (q?.sort && !native) {
    // Sorting by a stat needs every match first: the scan fallback collects and sorts them.
    yield* (await findSessions(index, q, { filter: o.filter, ...(o.maxSessions !== undefined ? { limit: o.maxSessions } : {}) })).sessions;
    return;
  }
  const match = q && !native ? sessionMatcher(index, q.root) : undefined;
  let seen = 0;
  for (let offset = 0; ; offset += page) {
    const want = o.maxSessions !== undefined && !match ? Math.min(page, o.maxSessions - seen) : page;
    if (want <= 0) return;
    const batch = native ? await native(q!, { filter: o.filter, limit: want, offset }) : await index.listSessions({ ...o.filter, limit: want, offset });
    for (const s of batch) {
      if (match && !(await match(s))) continue;
      if (o.maxSessions !== undefined && seen >= o.maxSessions) return;
      seen++;
      yield s;
    }
    if (batch.length < want) return;
  }
}

/** True when the filter selects every session, so labels can be read in one call. */
const unfiltered = (o: ExportOptions): boolean =>
  o.maxSessions === undefined && !o.query?.root && Object.entries(o.filter).every(([k, v]) => v === undefined || (k === "parentSessionId" && v === null));

/** True when any session-scoped filter is set (agent, repo, flag, project, runId, or --where). */
const hasSessionFilter = (o: ExportOptions): boolean =>
  Boolean(o.query?.root || o.query?.sort) ||
  Object.entries(o.filter).some(([k, v]) => v !== undefined && k !== "since" && k !== "until" && !(k === "parentSessionId" && v === null));

/** Streams the rows; returns how many were written. */
export async function exportRows(index: IndexStore, kind: ExportKind, o: ExportOptions): Promise<{ rows: number }> {
  let rows = 0;
  const emit = async (record: unknown, cells: () => unknown[]) => {
    rows++;
    await o.write(o.format === "jsonl" ? JSON.stringify(record) + "\n" : csvRow(cells()));
  };
  if (kind === "scores") {
    if (!index.listScores) throw new ScoreError(501, `the ${index.kind} store does not keep scores yet (use the default SQLite store)`);
    const redactor = o.redactor === undefined ? createRedactor({ redact: ["secrets"], patterns: [] }) : (o.redactor ?? undefined);
    const emitScore = async (raw: Score) => {
      const s = redactScore(raw, redactor);
      await emit(s, () => scoreCells(s));
    };
    if (o.format === "csv") await o.write(csvRow(CSV_COLUMNS.scores));
    const baseFilter: ScoreFilter = {};
    if (o.scoreName !== undefined) baseFilter.name = o.scoreName;
    if (o.scoreSource !== undefined) baseFilter.source = o.scoreSource;
    if (!hasSessionFilter(o)) {
      const sf: ScoreFilter = { ...baseFilter };
      if (o.filter.since !== undefined) sf.since = o.filter.since;
      if (o.filter.until !== undefined) sf.until = o.filter.until;
      if (o.maxSessions !== undefined) sf.limit = o.maxSessions;
      for (const s of await index.listScores(sf)) await emitScore(s);
      return { rows };
    }
    for await (const sess of sessionsOf(index, o)) {
      for (const s of await index.listScores({ ...baseFilter, sessionId: sess.id })) await emitScore(s);
    }
    return { rows };
  }
  if (o.format === "csv") await o.write(csvRow(CSV_COLUMNS[kind]));
  if (kind === "labels" && unfiltered(o)) {
    for (const l of await index.listLabels()) await emit(l, () => labelCells(l));
    return { rows };
  }
  const page = o.pageSize ?? 2000;
  for await (const s of sessionsOf(index, o)) {
    if (kind === "sessions") await emit(s, () => sessionCells(s));
    else if (kind === "labels") for (const l of await index.listLabels({ sessionId: s.id })) await emit(l, () => labelCells(l));
    else {
      for (let offset = 0; ; offset += page) {
        const events = await index.listEvents(s.id, { limit: page, offset });
        for (const e of events) await emit(e, () => eventCells(e));
        if (events.length < page) break;
      }
    }
  }
  return { rows };
}
