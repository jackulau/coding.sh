// Waiting for the database at startup. In Compose, on platforms and in Kubernetes the database
// often comes up a few seconds after serve, or restarts once while it initializes (the ClickHouse
// image answers a health check from a temporary server, then refuses connections for ~2 s while
// the real one starts). serve retries opening the store on connection errors only; a wrong
// password, a bad URL or a failed migration still fails at once.

const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "57P03"]);
const TRANSIENT_TEXT = /\b(fetch failed|socket hang up|other side closed|Connection terminated|the database system is (starting up|shutting down|in recovery mode))\b/i;

/** True for "nobody is listening yet" errors, anywhere in the cause chain. */
export function isTransientConnectError(e: unknown): boolean {
  for (let cur = e, depth = 0; cur && depth < 6; depth++) {
    const err = cur as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof err.code === "string" && TRANSIENT_CODES.has(err.code)) return true;
    if (typeof err.message === "string" && TRANSIENT_TEXT.test(err.message)) return true;
    // AggregateError (happy-eyeballs connects): transient if any attempt was.
    if (Array.isArray(err.errors) && err.errors.some((x) => isTransientConnectError(x))) return true;
    cur = err.cause;
  }
  return false;
}

/** Runs fn, retrying transient connection errors every delayMs until timeoutMs has passed. */
export async function retryTransient<T>(fn: () => Promise<T>, opts: { timeoutMs: number; delayMs: number; onRetry?: (e: unknown, attempt: number) => void }): Promise<T> {
  const until = Date.now() + opts.timeoutMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransientConnectError(e) || Date.now() + opts.delayMs > until) throw e;
      opts.onRetry?.(e, attempt);
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }
}
