// fetch with retries: 408/409/425/429/5xx (incl. Anthropic's 529) and network
// errors back off exponentially with jitter, honoring `retry-after-ms` and
// `retry-after` (seconds or HTTP date). Errors never contain request headers,
// and any provided secrets are scrubbed from response bodies before they can
// reach a log line.

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RetryOpts {
  /** Retries after the first attempt. Default 4. */
  retries?: number;
  baseDelayMs?: number;
  /** Cap for any single wait, including server-requested ones. Default 60 s. */
  maxDelayMs?: number;
  /** Per-attempt timeout. Default 120 s. */
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** [0, 1) source for jitter (inject for deterministic tests). */
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; status?: number; error?: string }) => void;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryable: boolean;
  constructor(message: string, status: number, body: string, retryable: boolean) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** Milliseconds the server asked us to wait, if it said so. */
export function parseRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "" && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = headers.get("retry-after");
  if (ra === null || ra.trim() === "") return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function scrub(text: string, secrets: readonly (string | undefined)[]): string {
  let t = text;
  for (const s of secrets) if (s && s.length >= 4) t = t.split(s).join("[redacted]");
  return t;
}

export interface FetchJsonOpts extends RetryOpts {
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Values (API keys) that must never appear in an error message. */
  secrets?: readonly (string | undefined)[];
  /** Name used in error messages, e.g. "anthropic". */
  label?: string;
}

/** POST/GET and parse JSON, retrying transient failures. */
export async function fetchJson(url: string, init: RequestInit, opts: FetchJsonOpts = {}): Promise<unknown> {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const label = opts.label ?? new URL(url).host;
  const secrets = opts.secrets ?? [];

  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    const onAbort = () => ctrl.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let res: Response | undefined;
    let netError: string | undefined;
    let body = "";
    try {
      res = await doFetch(url, { ...init, signal: ctrl.signal });
      body = await res.text();
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      netError = scrub(e instanceof Error ? e.message : String(e), secrets);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    if (res && res.ok) {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new HttpError(`${label}: response was not JSON: ${scrub(body.slice(0, 200), secrets)}`, res.status, scrub(body.slice(0, 2000), secrets), false);
      }
    }
    const status = res?.status;
    const retryable = status === undefined ? true : isRetryableStatus(status);
    if (!retryable || attempt >= retries) {
      const detail = status === undefined ? `request failed: ${netError}` : `HTTP ${status}: ${scrub(errorSummary(body), secrets)}`;
      const suffix = attempt > 0 ? ` (after ${attempt + 1} attempts)` : "";
      throw new HttpError(`${label}: ${detail}${suffix}`, status ?? 0, scrub(body.slice(0, 2000), secrets), retryable);
    }
    const backoff = Math.min(maxDelay, base * 2 ** attempt);
    const jittered = backoff / 2 + random() * (backoff / 2);
    const asked = res ? parseRetryAfter(res.headers) : undefined;
    const delayMs = Math.min(maxDelay, asked ?? jittered);
    const info: { attempt: number; delayMs: number; status?: number; error?: string } = { attempt: attempt + 1, delayMs };
    if (status !== undefined) info.status = status;
    if (netError !== undefined) info.error = netError;
    opts.onRetry?.(info);
    await sleep(delayMs, opts.signal);
  }
}

function errorSummary(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown; type?: unknown } | string; message?: unknown };
    if (typeof j.error === "string") return j.error.slice(0, 300);
    if (j.error && typeof j.error.message === "string") return `${j.error.type ? `${String(j.error.type)}: ` : ""}${j.error.message}`.slice(0, 300);
    if (typeof j.message === "string") return j.message.slice(0, 300);
  } catch {
    // not JSON
  }
  return body.slice(0, 300) || "(empty body)";
}
