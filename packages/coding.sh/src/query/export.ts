// `coding.sh export sessions|events|labels`: stream stored rows as JSONL or CSV.
//
// Works on every index store (it only uses the IndexStore interface): sessions are
// read a page at a time with the `sessions` filters, events a page at a time per
// session, so memory stays flat however large the store is. Rows are what the store
// holds, which is already redacted at ingest.
import type { IndexStore, Label, SessionFilter } from "../core/types.ts";
import type { AgentEvent, Session } from "../schema/index.ts";
import { csvRow } from "./csv.ts";

export const EXPORT_KINDS = ["sessions", "events", "labels"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const EXPORT_FORMATS = ["jsonl", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  /** Which sessions (limit and offset are ignored; use maxSessions). */
  filter: Omit<SessionFilter, "limit" | "offset">;
  /** Stop after this many sessions (newest first). */
  maxSessions?: number;
  format: ExportFormat;
  /** Receives the output in order; awaited, so a slow consumer applies backpressure. */
  write(chunk: string): void | Promise<void>;
  /** Rows per store read (tests use small pages). */
  pageSize?: number;
}

const iso = (ms: number | undefined): string | null => (ms === undefined ? null : new Date(ms).toISOString());

export const CSV_COLUMNS: Record<ExportKind, readonly string[]> = {
  sessions: ["id", "agent", "model", "title", "started_at", "ended_at", "duration_ms", "repo_root", "branch", "parent_session_id", "project", "events", "turns", "tool_calls", "tool_errors", "files_changed", "input_tokens", "output_tokens", "cost_usd", "flags"],
  events: ["id", "session_id", "ts", "kind", "agent", "model", "tool", "ok", "duration_ms", "turn_id", "subagent_id", "input_tokens", "output_tokens", "cost_usd", "payload"],
  labels: ["id", "session_id", "case_id", "criterion", "value", "note", "by", "ts"],
};

function sessionCells(s: Session): unknown[] {
  const u = s.stats.usage;
  return [
    s.id, s.agent, s.model ?? null, s.title ?? null, iso(s.startedAt), iso(s.endedAt), s.endedAt !== undefined ? s.endedAt - s.startedAt : null,
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

/** Sessions matching the filter, newest first, a page at a time. */
async function* sessionsOf(index: IndexStore, o: ExportOptions): AsyncGenerator<Session> {
  const page = o.pageSize ?? 500;
  let seen = 0;
  for (let offset = 0; ; offset += page) {
    const want = o.maxSessions !== undefined ? Math.min(page, o.maxSessions - seen) : page;
    if (want <= 0) return;
    const batch = await index.listSessions({ ...o.filter, limit: want, offset });
    for (const s of batch) {
      seen++;
      yield s;
    }
    if (batch.length < want) return;
  }
}

/** True when the filter selects every session, so labels can be read in one call. */
const unfiltered = (o: ExportOptions): boolean =>
  o.maxSessions === undefined && Object.entries(o.filter).every(([k, v]) => v === undefined || (k === "parentSessionId" && v === null));

/** Streams the rows; returns how many were written. */
export async function exportRows(index: IndexStore, kind: ExportKind, o: ExportOptions): Promise<{ rows: number }> {
  let rows = 0;
  const emit = async (record: unknown, cells: () => unknown[]) => {
    rows++;
    await o.write(o.format === "jsonl" ? JSON.stringify(record) + "\n" : csvRow(cells()));
  };
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
