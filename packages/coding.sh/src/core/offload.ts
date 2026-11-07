// Moves oversize payload values to the blob store, leaving a preview inline:
// `payload[key]` becomes a UTF-8-safe prefix, `payload[key + "Blob"]` the ref,
// and `payload.truncated = true`. Used by serve for native-ingest events (the
// OTLP mapper offloads while it maps).
import type { AgentEvent } from "../schema/index.ts";

const PREVIEW_BYTES = 1024;

function truncateUtf8(s: string, max: number): string {
  const buf = Buffer.from(s);
  if (buf.byteLength <= max) return s;
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export async function offloadPayload(e: AgentEvent, maxInlineBytes: number, put: (data: string) => Promise<string>): Promise<AgentEvent> {
  const payload = e.payload ?? {};
  let changed: Record<string, unknown> | undefined;
  let blobs = e.blobs;
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null || typeof v === "number" || typeof v === "boolean") continue;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    if (Buffer.byteLength(text) <= maxInlineBytes) continue;
    changed ??= { ...payload };
    const ref = await put(text);
    changed[k] = truncateUtf8(text, Math.min(PREVIEW_BYTES, maxInlineBytes));
    changed[`${k}Blob`] = ref;
    changed.truncated = true;
    blobs = blobs?.includes(ref) ? blobs : [...(blobs ?? []), ref];
  }
  if (!changed) return e;
  const out: AgentEvent = { ...e, payload: changed };
  if (blobs) out.blobs = blobs;
  return out;
}
