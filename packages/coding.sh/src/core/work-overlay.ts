// Acks and snoozes for `coding.sh work` (core/work.ts), kept in
// <CODING_SH_HOME>/work.json. Both are keyed by member session ids and joined
// per item on read, so an item keeps them when its root leaves the time window.
// An ack holds a cause's fingerprint (bucket, session, and the wait's tool call
// id or time), so acknowledging one prompt does not hide the next. The file is
// written to a temp file and renamed; a missing or corrupt file reads as empty.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Bucket } from "./work.ts";

export interface WorkSnooze {
  until: number;
  /** The bucket the item was in: a move to a more urgent one shows it again. */
  bucket: Bucket;
}

export interface WorkOverlay {
  v: 1;
  /** Session id → fingerprints of the causes acknowledged on it, oldest first. */
  acks: Record<string, string[]>;
  /** Session id → snooze. */
  snoozes: Record<string, WorkSnooze>;
}

/** Fingerprints kept per session; the oldest go first. */
const ACKS_PER_SESSION = 20;
/** Sessions with acks kept; the least recently acknowledged go first. */
const MAX_SESSIONS = 5000;

export const emptyOverlay = (): WorkOverlay => ({ v: 1, acks: {}, snoozes: {} });

const BUCKET_NAMES: ReadonlySet<string> = new Set(["blocked", "failed", "stalled", "turn", "review"]);

/** The overlay at `path`; empty when the file is missing, unreadable or not one. */
export function readOverlay(path: string): WorkOverlay {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyOverlay();
  }
  const out = emptyOverlay();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { acks?: unknown; snoozes?: unknown };
  if (r.acks && typeof r.acks === "object") {
    for (const [id, fps] of Object.entries(r.acks as Record<string, unknown>)) {
      if (Array.isArray(fps)) {
        const ok = fps.filter((f): f is string => typeof f === "string");
        if (ok.length) out.acks[id] = ok.slice(-ACKS_PER_SESSION);
      }
    }
  }
  if (r.snoozes && typeof r.snoozes === "object") {
    for (const [id, s] of Object.entries(r.snoozes as Record<string, unknown>)) {
      const z = s as { until?: unknown; bucket?: unknown } | null;
      if (z && typeof z.until === "number" && Number.isFinite(z.until) && typeof z.bucket === "string" && BUCKET_NAMES.has(z.bucket)) {
        out.snoozes[id] = { until: z.until, bucket: z.bucket as Bucket };
      }
    }
  }
  return out;
}

/** Writes the overlay: a temp file in the same folder, then a rename over the old one. */
export function writeOverlay(path: string, o: WorkOverlay, now = Date.now()): void {
  pruneOverlay(o, now);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${now}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(o)}\n`);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Drops expired snoozes and keeps the acks within their caps. */
export function pruneOverlay(o: WorkOverlay, now = Date.now()): WorkOverlay {
  for (const [id, z] of Object.entries(o.snoozes)) if (z.until <= now) delete o.snoozes[id];
  const ids = Object.keys(o.acks);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete o.acks[id];
  return o;
}

/** True when the cause with this fingerprint on this session was acknowledged. */
export const ackedFingerprint = (o: WorkOverlay, sessionId: string, fingerprint: string): boolean => o.acks[sessionId]?.includes(fingerprint) ?? false;

/** Records an ack of one cause. Re-adding moves the session to the end (most recent). */
export function addAck(o: WorkOverlay, sessionId: string, fingerprint: string): void {
  const prev = (o.acks[sessionId] ?? []).filter((f) => f !== fingerprint);
  delete o.acks[sessionId];
  o.acks[sessionId] = [...prev, fingerprint].slice(-ACKS_PER_SESSION);
}

/** Snoozes an item: stored on each of the given member session ids. */
export function addSnooze(o: WorkOverlay, sessionIds: readonly string[], snooze: WorkSnooze): void {
  for (const id of sessionIds) o.snoozes[id] = { ...snooze };
}

/** The active snooze on any of these sessions (the latest ending one), or undefined. */
export function snoozeOf(o: WorkOverlay, sessionIds: readonly string[], now: number): WorkSnooze | undefined {
  let best: WorkSnooze | undefined;
  for (const id of sessionIds) {
    const z = o.snoozes[id];
    if (z && z.until > now && (!best || z.until > best.until)) best = z;
  }
  return best;
}
