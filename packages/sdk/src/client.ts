// The process-wide SDK state: config + transport, created from the
// environment on first use or by init().
import { type Config, type InitOptions, resolveConfig } from "./config.ts";
import { Transport, type ItemKind, type TransportStats } from "./transport.ts";

interface State {
  cfg: Config;
  transport: Transport;
}

let state: State | undefined;
let exitHooked = false;
/** Counts carried over from transports replaced by a later init(). */
const carried: Omit<TransportStats, "queued"> = { sent: 0, dropped: 0, failed: 0 };

const EXIT_FLUSH_MS = 5000;

function hookExit(): void {
  if (exitHooked || typeof process === "undefined" || typeof process.on !== "function") return;
  exitHooked = true;
  // beforeExit fires when the loop runs dry (not on process.exit): flush once, bounded.
  process.on("beforeExit", () => {
    const t = state?.transport;
    if (t && t.stats().queued > 0 && t.enabled) void t.close(EXIT_FLUSH_MS);
  });
}

function create(opts?: InitOptions): State {
  const cfg = resolveConfig(opts);
  const transport = new Transport(cfg);
  if (cfg.url) hookExit();
  if (cfg.debug) console.error(`[coding.sh] ${cfg.url ? `sending to ${cfg.url}${cfg.key ? " with an ingest key" : ""}` : "disabled (no CODING_SH_URL)"}`);
  return { cfg, transport };
}

/** Configures the SDK. Called implicitly (from env) on first use; call it to override env. */
export function init(opts?: InitOptions): void {
  const prev = state;
  state = create(opts);
  if (prev) {
    // Hand queued work to the old transport's final flush; keep its counters.
    void prev.transport.close(EXIT_FLUSH_MS).then(() => {
      const s = prev.transport.stats();
      carried.sent += s.sent;
      carried.dropped += s.dropped;
      carried.failed += s.failed;
    });
  }
}

export function current(): State {
  return (state ??= create());
}

export const config = (): Config => current().cfg;

export function enqueue(kind: ItemKind, value: unknown): void {
  current().transport.enqueue(kind, value);
}

/** True when events would be sent anywhere (a URL is configured and the SDK is on). */
export const isEnabled = (): boolean => current().transport.enabled;

/** Observations still reading a response (observeFetch); flush() waits for them. */
const pending = new Set<Promise<unknown>>();

export function track(p: Promise<unknown>): void {
  const t = p.then(
    () => undefined,
    () => undefined,
  );
  pending.add(t);
  void t.then(() => pending.delete(t));
}

/** Waits for pending observations, at most until deadline. */
async function settle(deadline: number): Promise<void> {
  if (!pending.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all([...pending]), new Promise<void>((r) => (timer = setTimeout(r, Math.max(0, deadline - Date.now()))))]);
  clearTimeout(timer);
}

/**
 * Waits until everything recorded so far is sent, or timeoutMs passes.
 * Serverless: `waitUntil(flush())`. Resolves true when the queue drained.
 */
export async function flush(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await settle(deadline);
  return state ? state.transport.flush(Math.max(0, deadline - Date.now())) : true;
}

/** Final flush, then stop sending. Apps that call process.exit should `await shutdown()` first. */
export async function shutdown(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await settle(deadline);
  return state ? state.transport.close(Math.max(0, deadline - Date.now())) : true;
}

export function stats(): TransportStats {
  const s = state?.transport.stats() ?? { queued: 0, sent: 0, dropped: 0, failed: 0 };
  return { queued: s.queued, sent: s.sent + carried.sent, dropped: s.dropped + carried.dropped, failed: s.failed + carried.failed };
}

/** Test hook: forget all state (does not flush). */
export function _reset(): void {
  state = undefined;
  carried.sent = carried.dropped = carried.failed = 0;
}
