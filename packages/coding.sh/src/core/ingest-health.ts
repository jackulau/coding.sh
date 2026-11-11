// Whether the ingest the hook starts is working. The hook only appends to the
// spool and starts `coding.sh ingest --background` detached with no output, so
// when that ingest can't run (a store this coding.sh can't open, a migration
// that waits for `coding.sh upgrade-store`) nothing says so: captures pile up in
// the spool and every read shows an index that stopped at some point. A failed
// background ingest leaves a marker; `status`, the status line and `doctor`
// print it, and the next ingest that works removes it. A store that can't be
// opened counts at once; any other failure (a lock held too long) only when the
// next background ingest fails too.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
    if (!m || typeof m.since !== "number" || typeof m.why !== "string") return undefined;
    const marker: IngestStopped = {
      since: m.since,
      at: typeof m.at === "number" ? m.at : m.since,
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
  since: string;
  lastFailedAt: string;
  reason: string;
  message: string;
  next?: string;
}

/** The marker as `--json` documents carry it. */
export function ingestStoppedJson(s: IngestStopped): IngestStoppedJson {
  const doc: IngestStoppedJson = { since: new Date(s.since).toISOString(), lastFailedAt: new Date(s.at).toISOString(), reason: s.reason, message: s.why };
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
