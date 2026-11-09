// Retries for infrastructure errors only. A rate limit, a 5xx or a dropped
// connection says nothing about the agent, so the trial runs again after a
// backoff. A task failure (wrong answer, crash, its own timeout) is never
// retried: retrying failures until they pass would bias every pass rate up.
// Every attempt is counted, and a trial whose last attempt still hit an infra
// error is recorded as such (outcome unknown), not as a failure.
//
// Two kinds are not about the network. An agent that is not logged in (an
// expired login, a refused API key) fails every trial the same way, and a
// backoff does not fix it, so it is never retried. A setup step that failed
// before the agent started (the work folder missing, a setup command exiting
// non-zero) is retried once. A run stops once `stopAfter` trials in a row end
// on infra (InfraStop below): with a dead login, the rest of the round would
// only add more unknowns.

export type InfraKind = "rate-limit" | "server" | "network" | "tempfail" | "auth" | "setup";

/** Retries per kind, at most: a login does not come back after a backoff, and a setup step gets one more try. */
const KIND_RETRIES: Partial<Record<InfraKind, number>> = { auth: 0, setup: 1 };

export interface RetryPolicy {
  /** Retries after the first attempt. */
  retries: number;
  /** First backoff; doubles per retry (with jitter) up to maxMs. */
  baseMs: number;
  maxMs: number;
  /**
   * Stop the run once this many trials in a row ended on an infrastructure
   * error after their retries: no new trial starts. 0 or absent: never.
   */
  stopAfter?: number;
}

/** Trials in a row that end on infrastructure before a run stops (`--stop-after-infra`). */
export const DEFAULT_STOP_AFTER = 5;

export const DEFAULT_RETRY: RetryPolicy = { retries: 3, baseMs: 2000, maxMs: 60_000, stopAfter: DEFAULT_STOP_AFTER };

/** The policy with `retries` and `stopAfter` from flags and, for tests, CODING_SH_RETRY_BASE_MS. */
export function retryPolicy(env: NodeJS.ProcessEnv, retries?: number, stopAfter?: number): RetryPolicy {
  const base = Number(env.CODING_SH_RETRY_BASE_MS);
  const baseMs = env.CODING_SH_RETRY_BASE_MS !== undefined && Number.isFinite(base) && base >= 0 ? base : DEFAULT_RETRY.baseMs;
  return { retries: retries ?? DEFAULT_RETRY.retries, baseMs, maxMs: Math.max(baseMs, DEFAULT_RETRY.maxMs), stopAfter: stopAfter ?? DEFAULT_STOP_AFTER };
}

const OWN_TIMEOUT = /\btimed out after \d/i;
const RATE = /\b(rate[ _-]?limit(?:ed|s)?|too many requests|overloaded(?:_error)?|resource[ _]exhausted|(?:HTTP|status(?: code)?:?|error:?) ?(?:429|529))\b/i;
const SERVER = /\b(?:HTTP|status(?: code)?:?|API error:?) ?5\d\d\b|\b(?:internal server error|bad gateway|service unavailable|gateway time-?out)\b/i;
const NETWORK = /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z_]+)\b|\bsocket hang up\b|\bfetch failed\b|\bnetwork error\b/i;
/** EX_TEMPFAIL (sysexits.h): a command's way to say "temporary failure, try again". */
const TEMPFAIL = /\bexited 75\b/;
/**
 * The agent, or the model API under it, refused its credentials: not logged
 * in, an invalid or expired key or token, an HTTP 401. Claude Code says
 * "Invalid API key · Please run /login"; Codex says "Not logged in" or
 * "401 Unauthorized".
 */
const AUTH =
  /\b(?:not logged in|please (?:run \/login|log ?in|sign ?in|re-?authenticate)|run \/login|login required|invalid (?:x-)?api[ _-]?key|incorrect api key|api[ _-]?key (?:is )?(?:invalid|expired|missing|not set)|authentication[ _](?:error|failed)|(?:oauth |access |auth )?token (?:has )?expired|(?:HTTP|status(?: code)?:?|error:?|API error:?) ?401|401 unauthorized)\b/i;

/**
 * Whether an error message is an infrastructure error. The task's own timeout
 * is a task failure (the agent was too slow), never infra. A setup failure is
 * never read from a message: the runner that ran the setup says so.
 */
export function infraKind(error: string | undefined): InfraKind | undefined {
  if (!error || OWN_TIMEOUT.test(error)) return undefined;
  if (TEMPFAIL.test(error)) return "tempfail";
  if (AUTH.test(error)) return "auth";
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
    if (n > Math.min(o.policy.retries, KIND_RETRIES[kind] ?? Infinity) || stopped) return { result, attempts: n, infra: kind, retried };
    const wait = Math.max(backoffMs(n, o.policy), Math.min(o.policy.maxMs, retryAfterMs(error) ?? 0));
    retried.push(error ?? kind);
    o.onRetry?.(n, kind, wait, error ?? kind);
    if (await sleepUnless(wait, o.stop ?? [])) return { result, attempts: n, infra: kind, retried };
  }
}

/** Why a run stopped early on infrastructure errors. */
export interface InfraStopReport {
  /** Trials in a row that ended on an infrastructure error (the policy's `stopAfter`). */
  after: number;
  /** Those trials by kind. */
  kinds: Partial<Record<InfraKind, number>>;
}

/**
 * Counts the trials that end on an infrastructure error in a row. Once `limit`
 * have, `signal` aborts (the caller starts no new trial) and `report` says
 * why. A trial with a known outcome resets the count.
 */
export class InfraStop {
  readonly limit: number;
  report?: InfraStopReport;
  #streak: InfraKind[] = [];
  #ctl = new AbortController();
  constructor(limit: number) {
    this.limit = limit;
  }
  get signal(): AbortSignal {
    return this.#ctl.signal;
  }
  /** A finished trial: its infra kind, or undefined when its outcome is known. */
  add(kind: InfraKind | undefined): void {
    if (this.report) return;
    if (!kind) {
      this.#streak = [];
      return;
    }
    this.#streak.push(kind);
    if (this.#streak.length < this.limit) return;
    this.report = { after: this.#streak.length, kinds: infraKinds(this.#streak.map((infra) => ({ infra }))) };
    this.#ctl.abort();
  }
}

/** The stop a policy asks for; undefined when it never stops. */
export function infraStopFor(policy: RetryPolicy | undefined): InfraStop | undefined {
  return policy?.stopAfter && policy.stopAfter > 0 ? new InfraStop(policy.stopAfter) : undefined;
}

/** Infra counts by kind over records that carry an `infra` kind. */
export function infraKinds(records: readonly { infra?: InfraKind }[]): Partial<Record<InfraKind, number>> {
  const out: Partial<Record<InfraKind, number>> = {};
  for (const r of records) if (r.infra) out[r.infra] = (out[r.infra] ?? 0) + 1;
  return out;
}

const KIND_TEXT: Record<InfraKind, string> = { auth: "login", setup: "setup", "rate-limit": "rate limit", server: "5xx", network: "network", tempfail: "temporary failure" };

/** "login 4, setup 1": infra counts by kind, largest first. */
export function infraKindsText(kinds: Partial<Record<InfraKind, number>>): string {
  return (Object.entries(kinds) as [InfraKind, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${KIND_TEXT[k]} ${n}`)
    .join(", ");
}

/** What to do about the commonest kind. */
export function infraHint(kinds: Partial<Record<InfraKind, number>>): string {
  const top = (Object.entries(kinds) as [InfraKind, number][]).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top === "auth") return "The agent is not logged in or its API key was refused: log in again, then resume.";
  if (top === "setup") return "A setup step failed before the agent started: fix the task's setup or work folder, then resume.";
  return "The model API or the network kept failing: wait, then resume.";
}

/** The plain line a run stopped by InfraStop prints. */
export function infraStopText(r: InfraStopReport): string {
  return `Stopped: ${r.after} trials in a row failed on infrastructure (${infraKindsText(r.kinds)}), so the rest did not run and this is no quality verdict. ${infraHint(r.kinds)}`;
}

/** The verdict line when trials lost to infrastructure leave nothing to compare. */
export function voidText(n: number, kinds: Partial<Record<InfraKind, number>>): string {
  return `void: ${n} trial${n === 1 ? "" : "s"} failed on infrastructure (${infraKindsText(kinds)}), leaving no outcome to compare, so this is no quality verdict. ${infraHint(kinds)}`;
}
