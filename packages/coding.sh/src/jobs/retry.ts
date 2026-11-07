// Retries for infrastructure errors only. A rate limit, a 5xx or a dropped
// connection says nothing about the agent, so the trial runs again after a
// backoff. A task failure (wrong answer, crash, its own timeout) is never
// retried: retrying failures until they pass would bias every pass rate up.
// Every attempt is counted, and a trial whose last attempt still hit an infra
// error is recorded as such (outcome unknown), not as a failure.

export type InfraKind = "rate-limit" | "server" | "network" | "tempfail";

export interface RetryPolicy {
  /** Retries after the first attempt. */
  retries: number;
  /** First backoff; doubles per retry (with jitter) up to maxMs. */
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 3, baseMs: 2000, maxMs: 60_000 };

/** The policy with `retries` from a flag and, for tests, CODING_SH_RETRY_BASE_MS. */
export function retryPolicy(env: NodeJS.ProcessEnv, retries?: number): RetryPolicy {
  const base = Number(env.CODING_SH_RETRY_BASE_MS);
  const baseMs = env.CODING_SH_RETRY_BASE_MS !== undefined && Number.isFinite(base) && base >= 0 ? base : DEFAULT_RETRY.baseMs;
  return { retries: retries ?? DEFAULT_RETRY.retries, baseMs, maxMs: Math.max(baseMs, DEFAULT_RETRY.maxMs) };
}

const OWN_TIMEOUT = /\btimed out after \d/i;
const RATE = /\b(rate[ _-]?limit(?:ed|s)?|too many requests|overloaded(?:_error)?|resource[ _]exhausted|(?:HTTP|status(?: code)?:?|error:?) ?(?:429|529))\b/i;
const SERVER = /\b(?:HTTP|status(?: code)?:?|API error:?) ?5\d\d\b|\b(?:internal server error|bad gateway|service unavailable|gateway time-?out)\b/i;
const NETWORK = /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)\b|\bsocket hang up\b|\bfetch failed\b|\bnetwork error\b/i;
/** EX_TEMPFAIL (sysexits.h): a command's way to say "temporary failure, try again". */
const TEMPFAIL = /\bexited 75\b/;

/**
 * Whether an error message is an infrastructure error. The task's own timeout
 * is a task failure (the agent was too slow), never infra.
 */
export function infraKind(error: string | undefined): InfraKind | undefined {
  if (!error || OWN_TIMEOUT.test(error)) return undefined;
  if (TEMPFAIL.test(error)) return "tempfail";
  if (RATE.test(error)) return "rate-limit";
  if (SERVER.test(error)) return "server";
  if (NETWORK.test(error)) return "network";
  return undefined;
}

/** A server's "retry after N seconds" hint, in ms. */
export function retryAfterMs(error: string | undefined): number | undefined {
  const m = error && /retry[- ]after[":= ]*\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds)?\b/i.exec(error);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === "ms" ? n : n * 1000;
}

/** Exponential backoff with jitter for retry `n` (1-based): base·2^(n−1), capped, then a random 50–100% of it. */
export function backoffMs(n: number, p: RetryPolicy, rand: () => number = Math.random): number {
  const d = Math.min(p.maxMs, p.baseMs * 2 ** (n - 1));
  return Math.round(d * (0.5 + 0.5 * rand()));
}

/** Resolves after `ms`, or as soon as any signal aborts (then true). */
export function sleepUnless(ms: number, signals: readonly (AbortSignal | undefined)[]): Promise<boolean> {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (live.some((s) => s.aborted)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (stopped: boolean) => {
      clearTimeout(t);
      for (const s of live) s.removeEventListener("abort", onAbort);
      resolve(stopped);
    };
    const onAbort = () => done(true);
    const t = setTimeout(() => done(false), ms);
    for (const s of live) s.addEventListener("abort", onAbort, { once: true });
  });
}

export interface Retried<R> {
  result: R;
  /** Attempts made (1 = no retry). */
  attempts: number;
  /** Set when the last attempt still hit an infrastructure error. */
  infra?: InfraKind;
  /** The infra errors of the attempts that were retried, oldest first. */
  retried: string[];
}

/**
 * Run `attempt` until it returns something that is not an infra error, the
 * retries run out, or a signal says stop (an interrupt: no new attempt
 * starts). `errorOf` reads the error to classify from a result.
 */
export async function withRetries<R>(
  attempt: (n: number) => Promise<R>,
  o: { policy: RetryPolicy; errorOf: (r: R) => string | undefined; classify?: (r: R) => InfraKind | undefined; stop?: readonly (AbortSignal | undefined)[]; onRetry?: (n: number, kind: InfraKind, waitMs: number, error: string) => void },
): Promise<Retried<R>> {
  const retried: string[] = [];
  for (let n = 1; ; n++) {
    const result = await attempt(n);
    const error = o.errorOf(result);
    const kind = o.classify ? o.classify(result) : infraKind(error);
    if (!kind) return { result, attempts: n, retried };
    const stopped = (o.stop ?? []).some((s) => s?.aborted);
    if (n > o.policy.retries || stopped) return { result, attempts: n, infra: kind, retried };
    const wait = Math.max(backoffMs(n, o.policy), Math.min(o.policy.maxMs, retryAfterMs(error) ?? 0));
    retried.push(error ?? kind);
    o.onRetry?.(n, kind, wait, error ?? kind);
    if (await sleepUnless(wait, o.stop ?? [])) return { result, attempts: n, infra: kind, retried };
  }
}
