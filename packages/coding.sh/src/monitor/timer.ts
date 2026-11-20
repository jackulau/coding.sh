// Runs monitors on a timer for long-lived writers (`coding.sh serve`): one pass
// at a time, unref'd, and only while monitors.json has monitors.
import { hasMonitors, MONITOR_INTERVAL_MS, runMonitors, type MonitorDeps } from "./run.ts";

export interface MonitorTimerOptions extends MonitorDeps {
  /** Default 60 s. */
  intervalMs?: number;
  /** Wraps each score write (the writer's lane). */
  write?: <T>(fn: () => Promise<T>) => Promise<T>;
  log?: (message: string) => void;
}

/** Starts the timer. The returned stop() aborts a running pass and waits for it to end. */
export function startMonitorTimer(o: MonitorTimerOptions): () => Promise<void> {
  const ac = new AbortController();
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running || ac.signal.aborted || !hasMonitors(o.paths.monitors)) return;
    running = runMonitors(o, { signal: ac.signal, write: o.write, log: o.log })
      .then(() => undefined)
      .catch((e: Error) => o.log?.(`monitors failed: ${e.message}`))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, o.intervalMs ?? MONITOR_INTERVAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    ac.abort();
    await running;
  };
}
