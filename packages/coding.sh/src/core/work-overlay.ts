// Acks and snoozes for `coding.sh work` (core/work.ts), kept in
// <CODING_SH_HOME>/work.json. Both are keyed by member session ids and joined
// per item on read, so an item keeps them when its root leaves the time window.
// A snooze also holds its item's id, so the item's next snooze replaces it.
// An ack holds a cause's fingerprint (bucket, session, and the wait's tool call
// id or time), so acknowledging one prompt does not hide the next. The file is
// written to a temp file and renamed; a missing or corrupt file reads as empty.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dateMs } from "./dates.ts";
import type { Bucket } from "./work.ts";

export interface WorkSnooze {
  until: number;
  /** The bucket the item was in: a move to a more urgent one shows it again. */
  bucket: Bucket;
  /** The id of the item it snoozes (WorkItem.id). snoozeItem finds the item's earlier snooze by it, on a session outside the time window too. Unset in a file written before it was stored. */
  item?: string;
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
      const z = s as { until?: unknown; bucket?: unknown; item?: unknown } | null;
      if (z && typeof z.until === "number" && dateMs(z.until) !== undefined && typeof z.bucket === "string" && BUCKET_NAMES.has(z.bucket)) {
        const snooze: WorkSnooze = { until: z.until, bucket: z.bucket as Bucket };
        if (typeof z.item === "string") snooze.item = z.item;
        out.snoozes[id] = snooze;
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

/** Stores a snooze on each of the given session ids. snoozeItem snoozes a work item. */
export function addSnooze(o: WorkOverlay, sessionIds: readonly string[], snooze: WorkSnooze): void {
  for (const id of sessionIds) o.snoozes[id] = { ...snooze };
}

/** What snoozeItem needs of a work item (core/work.ts WorkItem). */
export interface SnoozeTarget {
  /** The item's id, the same through every time window. */
  id: string;
  primaryId: string;
  /** Every session of the item in the time window: the ones snoozeOf reads. */
  sessionIds: readonly string[];
  cause?: { sessionId: string };
}

/**
 * Snoozes a work item, as `coding.sh work snooze` and POST /api/work/snooze do: stored on its main
 * session and on the session behind its cause, with the item's id. It replaces the item's earlier
 * snooze, which goes first from every session that holds the item's id and from every session of the
 * item: a copy left on the session behind an earlier cause could end later than the new snooze and win
 * in snoozeOf, even on a session that a shorter time window leaves out of the item. Other items' snoozes
 * stay, even one that ends at the same time.
 */
export function snoozeItem(o: WorkOverlay, item: SnoozeTarget, snooze: WorkSnooze): void {
  for (const [id, z] of Object.entries(o.snoozes)) if (z.item === item.id) delete o.snoozes[id];
  for (const id of item.sessionIds) delete o.snoozes[id];
  addSnooze(o, [...new Set([item.primaryId, item.cause?.sessionId ?? item.primaryId])], { ...snooze, item: item.id });
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
