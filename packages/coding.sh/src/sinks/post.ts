// Shared JSON POST for remote sinks: bounded by a timeout, never throws, and
// maps HTTP status to a SinkAck that ingest uses to back off or keep going.
import type { SinkAck } from "../core/types.ts";

export const DEFAULT_TIMEOUT_MS = 10_000;
/** Backoff when the server is unreachable or doesn't say when to retry. */
export const DEFAULT_RETRY_MS = 30_000;

/** Retry-After as delta-seconds or an HTTP date → ms from now (bounded to 1h). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const s = value.trim();
  let ms: number | undefined;
  if (/^\d+$/.test(s)) ms = Number(s) * 1000;
  else {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) ms = Math.max(0, t - now);
  }
  return ms === undefined ? undefined : Math.min(ms, 3_600_000);
}

export async function postJson(
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<SinkAck> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "coding.sh", ...opts.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as Error;
    const reason = e.name === "TimeoutError" ? `timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : (e.cause as Error | undefined)?.message ?? e.message;
    return { ok: false, error: `POST ${redactUrl(url)} failed: ${reason}`, retryAfterMs: DEFAULT_RETRY_MS };
  }
  // Drain the body so the connection can be reused; keep a little for errors.
  const text = await res.text().catch(() => "");
  if (res.ok) return { ok: true };
  const error = `POST ${redactUrl(url)} → ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ""}`;
  if (res.status === 429 || res.status === 408 || res.status >= 500) {
    return { ok: false, error, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) ?? DEFAULT_RETRY_MS };
  }
  // Other 4xx: the request itself is wrong (auth, payload). Retrying won't help until config changes.
  return { ok: false, error };
}

/** Strips credentials from a URL for error messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
}
