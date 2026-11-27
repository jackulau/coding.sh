// Whether the ingest the hook starts is working. The hook only appends to the
// spool and starts `coding.sh ingest --background` detached with no output, so
// when that ingest can't run (a store this coding.sh can't open, a migration
// that waits for `coding.sh upgrade-store`) nothing says so: captures pile up in
// the spool and every read shows an index that stopped at some point. A failed
// background ingest leaves a marker; `status`, the status line and `doctor`
// print it, and the next ingest that works removes it. A store that can't be
// opened counts at once; any other failure (a lock held too long) only when the
// next background ingest fails too.
//
// Every ingest and backfill that finishes also records when (`ingest-last.json`):
// a read can then say how old the index is, and `work` judges waits and stalls
// as of that time while it is old, so a stuck ingest does not read as a fleet of
// stalled agents.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dateMs, isoMs } from "./dates.ts";
import { DERAIL_THRESHOLDS } from "./derail.ts";
import { isLocked } from "./lock.ts";

/** What `<home>/ingest-stopped.json` holds. */
export interface IngestStopped {
  /** When the first of the failures in a row happened. */
  since: number;
  /** When the latest one did. */
  at: number;
  /** The error's reason (`store_newer`, `store_owned`, …). */
  reason: string;
  /** Why, in a few words, for a status row. */
  why: string;
  /** The command that gets it going again, when there is one. */
  next?: string;
  /** The coding.sh version that failed. */
  version: string;
  /** Background ingests that failed in a row. */
  failures: number;
}

function readMarker(file: string): IngestStopped | undefined {
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as Partial<IngestStopped> | null;
    if (!m || typeof m.since !== "number" || dateMs(m.since) === undefined || typeof m.why !== "string") return undefined;
    const marker: IngestStopped = {
      since: m.since,
      at: typeof m.at === "number" && dateMs(m.at) !== undefined ? m.at : m.since,
      reason: typeof m.reason === "string" ? m.reason : "error",
      why: m.why,
      version: typeof m.version === "string" ? m.version : "",
      failures: typeof m.failures === "number" ? m.failures : 1,
    };
    if (typeof m.next === "string") marker.next = m.next;
    return marker;
  } catch {
    return undefined;
  }
}

/** The marker, once it means ingest is stopped: a store that can't be opened, or two failures in a row. */
export function readIngestStopped(file: string): IngestStopped | undefined {
  const m = readMarker(file);
  return m && (m.reason.startsWith("store_") || m.failures >= 2) ? m : undefined;
}

/** Records a failed background ingest; `since` stays that of the first failure in a row. Never throws. */
export function markIngestStopped(file: string, failure: Omit<IngestStopped, "since" | "at" | "failures">, now = Date.now()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const before = readMarker(file);
    writeFileSync(file, JSON.stringify({ since: before?.since ?? now, at: now, ...failure, failures: (before?.failures ?? 0) + 1 } satisfies IngestStopped) + "\n", { mode: 0o600 });
  } catch {
    // a home that can't be written: the error itself is all there is
  }
}

/** An ingest ran: whatever stopped it is over. Never throws. */
export function clearIngestStopped(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // left for the next ingest
  }
}

export interface IngestStoppedJson {
  since: string | null;
  lastFailedAt: string | null;
  reason: string;
  message: string;
  next?: string;
}

/** The marker as `--json` documents carry it. */
export function ingestStoppedJson(s: IngestStopped): IngestStoppedJson {
  const doc: IngestStoppedJson = { since: isoMs(s.since) ?? null, lastFailedAt: isoMs(s.at) ?? null, reason: s.reason, message: s.why };
  if (s.next) doc.next = s.next;
  return doc;
}

/** `ingestStopped` for a `--json` document: there only while ingest is stopped. */
export function ingestStoppedField(s: IngestStopped | undefined): { ingestStopped?: IngestStoppedJson } {
  return s ? { ingestStopped: ingestStoppedJson(s) } : {};
}

/** The capture files waiting in the spool (`<spool>/<agent>/*.jsonl`) and their size. */
export function spoolSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let total = 0;
  if (!existsSync(dir)) return { files, bytes: total };
  for (const agent of readdirSync(dir)) {
    const sub = join(dir, agent);
    let st;
    try {
      st = statSync(sub);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(sub)) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        total += statSync(join(sub, f)).size;
        files++;
      } catch {
        // ingested and removed meanwhile
      }
    }
  }
  return { files, bytes: total };
}

/** What `<home>/ingest-last.json` holds: when the latest ingest or backfill finished without error. */
export interface LastIngest {
  /** When it finished (ms epoch). */
  at: number;
  /** The coding.sh version that ran it. */
  version: string;
}

/** `<home>/ingest-last.json`. */
export const lastIngestFile = (home: string): string => join(home, "ingest-last.json");

/**
 * Records that an ingest or a backfill finished: written to a temp file beside the record and
 * renamed over it, so a reader never sees half a record. A home that does not exist is left alone.
 * Never throws.
 */
export function recordLastIngest(home: string, version: string, at = Date.now()): void {
  const file = lastIngestFile(home);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    if (!existsSync(home)) return;
    writeFileSync(tmp, JSON.stringify({ at, version } satisfies LastIngest) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // a home that can't be written, or a reader holding the record open (Windows): the next ingest writes it
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing more to do
    }
  }
}

/** The record, or undefined when no ingest has finished since it was introduced (or it can't be read). */
export function readLastIngest(home: string): LastIngest | undefined {
  try {
    const r = JSON.parse(readFileSync(lastIngestFile(home), "utf8")) as Partial<LastIngest> | null;
    if (!r || typeof r.at !== "number" || dateMs(r.at) === undefined) return undefined;
    return { at: r.at, version: typeof r.version === "string" ? r.version : "" };
  } catch {
    return undefined;
  }
}

/** How old the index is. */
export interface IndexAge {
  /** When the latest ingest or backfill finished (ms epoch). */
  at: number;
  /** now - at, never below 0. */
  ageMs: number;
  /** An ingest or an import holds its lock now: the index is being brought up to date. */
  running: boolean;
  /** Older than the stall threshold (STALL_MS in core/work.ts) while no ingest runs: waits and stalls are then as of `at`. */
  stale: boolean;
}

/** The index's age from `<home>/ingest-last.json`; undefined without a record. */
export function indexAge(home: string, now = Date.now()): IndexAge | undefined {
  const last = readLastIngest(home);
  if (!last) return undefined;
  const ageMs = Math.max(0, now - last.at);
  // The locks paths() names: `<home>/spool/.ingest.lock` (spool ingest) and `<home>/import.lock` (backfill).
  const running = isLocked(join(home, "spool", ".ingest.lock"), undefined, now) || isLocked(join(home, "import.lock"), undefined, now);
  return { at: last.at, ageMs, running, stale: !running && ageMs >= DERAIL_THRESHOLDS.stallMs };
}

/** An age floored to one unit, as `work` gives ages: 27s, 4m, 3h, 2d. */
function ageWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1e3));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** "updated 4m ago": a status row's value next to its "Index" label. */
export function indexUpdatedText(age: Pick<IndexAge, "ageMs">): string {
  return `updated ${ageWords(age.ageMs)} ago`;
}

/** "index updated 4m ago": how the CLI, MCP and the viewer word the index's age. */
export function indexAgeText(age: Pick<IndexAge, "ageMs">): string {
  return `index ${indexUpdatedText(age)}`;
}

/** `index` for a `--json` document: `{ updatedAt, stale? }`, absent without a record. */
export function indexAgeField(age: IndexAge | undefined): { index?: { updatedAt: string; stale?: true } } {
  const updatedAt = age ? isoMs(age.at) : undefined;
  if (!age || updatedAt === undefined) return {};
  const index: { updatedAt: string; stale?: true } = { updatedAt };
  if (age.stale) index.stale = true;
  return { index };
}

/** "index updated 3h ago: waits and stalls are as of then; run coding.sh ingest": the line a work queue judged as of an old index starts with. */
export function staleIndexText(age: Pick<IndexAge, "ageMs">): string {
  return `${indexAgeText(age)}: waits and stalls are as of then; run coding.sh ingest`;
}
