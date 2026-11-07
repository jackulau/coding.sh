// Canonical JSON + content hashes. Every version id in the eval engine
// (dataset, grader, judge) is a hash over canonical JSON, so key order and
// whitespace never change an id while any value change always does.
import { sha256Hex } from "../core/ids.ts";

/**
 * JSON with object keys sorted recursively. `undefined` object members are
 * dropped (as JSON.stringify does); non-finite numbers become null. Functions,
 * symbols and bigint throw, because they cannot round-trip.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value, new Set()));
}

function sortKeys(v: unknown, seen: Set<object>): unknown {
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "boolean") return v;
  if (t === "number") return Number.isFinite(v as number) ? v : null;
  if (t === "undefined") return undefined;
  if (t === "bigint" || t === "function" || t === "symbol") throw new TypeError(`canonicalJson: cannot encode ${t}`);
  const o = v as object;
  if (seen.has(o)) throw new TypeError("canonicalJson: circular structure");
  seen.add(o);
  try {
    if (Array.isArray(o)) return o.map((x) => (x === undefined ? null : sortKeys(x, seen)));
    if (o instanceof Date) return o.toISOString();
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      const x = sortKeys((o as Record<string, unknown>)[k], seen);
      if (x !== undefined) out[k] = x;
    }
    return out;
  } finally {
    seen.delete(o);
  }
}

/** sha256 hex of canonical JSON. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Short (16 hex = 64-bit) content hash for human-facing version ids. */
export function shortHash(value: unknown, length = 16): string {
  return contentHash(value).slice(0, length);
}

/** Structural deep equality via canonical JSON (so key order is irrelevant). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

/** Uniform [0, 1) from a hash of the parts — stable across runs and machines. */
export function hashUnit(...parts: string[]): number {
  const h = sha256Hex(parts.join("\u001f"));
  return parseInt(h.slice(0, 8), 16) / 0x1_0000_0000;
}
