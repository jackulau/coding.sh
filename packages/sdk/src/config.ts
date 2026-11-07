// SDK options, from init() and the environment (init wins).
//
//   CODING_SH_URL           base URL of a coding.sh server (no URL: the SDK does nothing)
//   CODING_SH_INGEST_KEY    csh_ik_… ingest key (optional on a loopback server with no keys)
//   CODING_SH_SERVICE       service name, the agent id on the server (else OTEL_SERVICE_NAME)
//   CODING_SH_CAPTURE_MODE  full | metadata (metadata drops message text and tool I/O)
//   CODING_SH_DISABLED=1    turn the SDK off
//   CODING_SH_DEBUG=1       log each send to stderr (never keys or bodies)

export type CaptureMode = "full" | "metadata";

export interface InitOptions {
  /** Base URL of the coding.sh server, e.g. https://obs.example.com. */
  url?: string;
  /** Ingest key (csh_ik_…). */
  key?: string;
  /** Service name; the server turns it into the agent id. */
  service?: string;
  /** "metadata" drops message text and tool inputs/outputs before they leave the process. */
  capture?: CaptureMode;
  flushIntervalMs?: number;
  /** Events per request (at most 500). */
  maxBatch?: number;
  /** Events held in memory; newer events are dropped (and counted) when full. */
  maxQueue?: number;
  disabled?: boolean;
  debug?: boolean;
  /** fetch used to talk to the server (defaults to the global fetch, never an observed one). */
  fetch?: typeof fetch;
}

export interface Config {
  /** Base URL without a trailing slash, or undefined when the SDK is off. */
  url: string | undefined;
  key: string | undefined;
  service: string | undefined;
  capture: CaptureMode;
  flushIntervalMs: number;
  maxBatch: number;
  maxQueue: number;
  debug: boolean;
  fetch: typeof fetch | undefined;
}

/** Hard limits from the contract (docs/PRODUCTION.md §4.1). */
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;

type Env = Record<string, string | undefined>;

const env = (): Env => (typeof process !== "undefined" && process.env ? process.env : {});

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

const posInt = (v: unknown, dflt: number, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : dflt;

/** "https://h/v1/ingest/" → "https://h". Accepts a base URL or a full ingest/traces URL. */
export function baseUrl(u: string | undefined): string | undefined {
  const s = u?.trim();
  if (!s) return undefined;
  return s.replace(/\/+$/, "").replace(/\/v1\/(ingest|traces)$/, "");
}

export function resolveConfig(opts: InitOptions = {}, e: Env = env()): Config {
  const disabled = opts.disabled ?? truthy(e.CODING_SH_DISABLED);
  const capture = opts.capture ?? (e.CODING_SH_CAPTURE_MODE?.trim() === "metadata" ? "metadata" : "full");
  return {
    url: disabled ? undefined : baseUrl(opts.url ?? e.CODING_SH_URL),
    key: opts.key ?? (e.CODING_SH_INGEST_KEY?.trim() || undefined),
    service: opts.service ?? (e.CODING_SH_SERVICE?.trim() || e.OTEL_SERVICE_NAME?.trim() || undefined),
    capture: capture === "metadata" ? "metadata" : "full",
    flushIntervalMs: posInt(opts.flushIntervalMs, 1000),
    maxBatch: posInt(opts.maxBatch, MAX_BATCH_EVENTS, MAX_BATCH_EVENTS),
    maxQueue: posInt(opts.maxQueue, 10_000),
    debug: opts.debug ?? truthy(e.CODING_SH_DEBUG),
    fetch: opts.fetch,
  };
}
