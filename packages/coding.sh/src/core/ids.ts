// Id helpers. Event ids are content-derived so re-ingesting the same spool
// line is a no-op; run/task ids are time-sortable so lists order naturally.
import { createHash, randomBytes } from "node:crypto";

/** sha256 hex of a string (utf8) or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * sha256 over parts joined by U+001F (unit separator). The separator cannot
 * appear in ids/paths we hash, so ("ab","c") and ("a","bc") never collide.
 */
export function hashParts(...parts: (string | number)[]): string {
  return sha256Hex(parts.map(String).join("\u001f"));
}

/**
 * Deterministic event id for the `index`-th event normalized from the spool
 * line at `offset` in `source`. Same line → same ids, so re-ingest inserts 0.
 */
export function eventId(agent: string, sessionId: string, source: string, offset: number, index = 0): string {
  return hashParts("event", agent, sessionId, source, offset, index);
}

/** True for a lowercase 64-char sha256 hex string. */
export function isSha256Hex(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

// ---------------------------------------------------------------- sortable ids

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRandom: Uint8Array = new Uint8Array(10);

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits → 16 base32 chars, big-endian.
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

function incrementRandom(bytes: Uint8Array): Uint8Array {
  const next = new Uint8Array(bytes);
  for (let i = next.length - 1; i >= 0; i--) {
    const v = next[i]! + 1;
    next[i] = v & 0xff;
    if (v <= 0xff) return next;
  }
  // 80-bit overflow within one millisecond is practically impossible; reseed.
  return new Uint8Array(randomBytes(10));
}

/**
 * ULID-style id: 10 chars of ms timestamp + 16 chars of randomness, Crockford
 * base32. Lexicographic order == creation order, monotonic within a process
 * even for ids minted in the same millisecond.
 */
export function sortableId(prefix = "", now: number = Date.now()): string {
  if (now <= lastTime) {
    lastRandom = incrementRandom(lastRandom);
    now = lastTime;
  } else {
    lastTime = now;
    lastRandom = new Uint8Array(randomBytes(10));
  }
  return prefix + encodeTime(now) + encodeRandom(lastRandom);
}

/** Milliseconds encoded in a sortableId (prefix length must be given if used). */
export function sortableIdTime(id: string, prefixLength = 0): number {
  const t = id.slice(prefixLength, prefixLength + 10).toUpperCase();
  let ms = 0;
  for (const ch of t) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new Error(`not a sortable id: ${id}`);
    ms = ms * 32 + v;
  }
  return ms;
}
