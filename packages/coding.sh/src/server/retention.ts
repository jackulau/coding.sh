// Retention (docs/PRODUCTION.md §1.6): at start and hourly, delete each project's
// sessions older than its retention_days (with their events and labels); daily,
// sweep unreferenced blobs. Both run in the writer's exclusive lane, so they never
// race a tick. Eval assets (tasks, datasets, experiments, judges) are never touched.
import type { BlobStore, Config, IndexStore } from "../core/types.ts";
import type { Logger } from "./log.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface RetentionOptions {
  store: IndexStore;
  blobs: BlobStore;
  config: Config;
  /** Days to keep by project; 0 keeps forever. */
  days: Map<string, number>;
  /** Wraps each job (the writer's exclusive lane). */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** One retention pass. Returns what was deleted per project. */
export async function applyRetention(o: Pick<RetentionOptions, "store" | "days" | "now">): Promise<Record<string, { sessions: number; events: number }>> {
  const out: Record<string, { sessions: number; events: number }> = {};
  if (!o.store.deleteBefore) return out;
  const now = (o.now ?? Date.now)();
  for (const [project, days] of o.days) {
    if (!(days > 0)) continue;
    out[project] = await o.store.deleteBefore(now - days * DAY, { project });
  }
  return out;
}

/** Starts the hourly retention and daily gc timers (unref'd). Returns a stop function. */
export function startRetention(o: RetentionOptions): () => void {
  const timers: NodeJS.Timeout[] = [];
  const any = [...o.days.values()].some((d) => d > 0);
  const retention = async () => {
    try {
      const r = await o.run(() => applyRetention(o));
      const deleted = Object.values(r).reduce((n, x) => n + x.sessions, 0);
      if (deleted) o.log?.info("retention", { deleted: r });
    } catch (e) {
      o.log?.error("retention failed", { error: (e as Error).message });
    }
  };
  const sweep = async () => {
    try {
      const { gc } = await import("../core/gc.ts");
      const r = await o.run(() => gc({ index: o.store, blobs: o.blobs, config: o.config, env: o.env, minBlobAgeMs: HOUR, judgeCacheDir: false }));
      if (r.blobs.deleted) o.log?.info("gc", { blobsDeleted: r.blobs.deleted, bytes: r.blobs.bytes });
    } catch (e) {
      o.log?.error("gc failed", { error: (e as Error).message });
    }
  };
  if (any) {
    void retention();
    timers.push(setInterval(() => void retention(), HOUR));
  }
  timers.push(setInterval(() => void sweep(), DAY));
  for (const t of timers) t.unref();
  return () => {
    for (const t of timers) clearInterval(t);
  };
}
