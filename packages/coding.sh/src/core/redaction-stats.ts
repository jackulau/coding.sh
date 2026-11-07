// Secret exposure per session: how many values redaction replaced, by kind
// (Session.stats.redactions), and the `secret:exposed` tag when one of them was a
// vendor token. The redacted value never reaches the store, but it reached the
// agent and its model provider, so the credential should be rotated; the tag is
// how to find those sessions (and `coding.sh purge` removes what redaction missed).
//
// Each event counts its `payload.redactions` (written at ingest, blobs included).
// Events stored before that field existed count the markers in their payload.
import type { AgentEvent } from "../schema/index.ts";
import { countMarkers, HIGH_CONFIDENCE_KINDS, redactionCounts } from "./redact.ts";

/** A tag (namespaced, so failureFlags() leaves it out): the session held a vendor token. */
export const SECRET_EXPOSED = "secret:exposed";

export interface RedactionState {
  kinds: Record<string, number>;
}

export const redactionState = (): RedactionState => ({ kinds: {} });

function countPayload(v: unknown, into: Record<string, number>, depth = 0): void {
  if (typeof v === "string") countMarkers(v, into);
  else if (Array.isArray(v)) for (const x of v) countPayload(x, into, depth + 1);
  else if (v && typeof v === "object" && depth < 64) for (const x of Object.values(v)) countPayload(x, into, depth + 1);
}

export function foldRedactions(s: RedactionState, e: AgentEvent): void {
  const counted = redactionCounts(e.payload?.redactions);
  if (counted) {
    for (const [k, n] of Object.entries(counted)) if (n > 0) s.kinds[k] = (s.kinds[k] ?? 0) + n;
    return;
  }
  countPayload(e.payload, s.kinds);
}

/** Counts by kind, or undefined when nothing was redacted. */
export function redactionsOf(s: RedactionState): Record<string, number> | undefined {
  const entries = Object.entries(s.kinds).filter(([, n]) => n > 0);
  return entries.length ? Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) : undefined;
}

/** True when any count is of a vendor token kind. */
export const exposesSecret = (counts: Record<string, number> | undefined): boolean => !!counts && Object.keys(counts).some((k) => HIGH_CONFIDENCE_KINDS.has(k));
