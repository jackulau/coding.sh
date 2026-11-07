// Cross-process advisory lock: a lockfile created with O_EXCL holding
// { pid, host, ts }. Two `coding.sh ingest` runs (a CLI call and the viewer's
// background ingest, say) would otherwise read the same spool range and both
// send it to every sink, so sinks would see duplicate batches.
//
// Stale detection: the holder refreshes the file's mtime every `heartbeatMs`.
// A lock is stale when its holder is a dead pid on this host, or its mtime is
// older than `staleMs` (holder hung, or on another host sharing the dir).
// A stale lock is removed and acquisition retried; the O_EXCL create decides
// races between two processes breaking the same stale lock.
import { closeSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { hostname } from "node:os";

export interface LockOptions {
  /** Give up after this long while a live holder keeps the lock (default 30 s; 0 = try once). */
  waitMs?: number;
  /** A lock whose mtime is older than this is stale (default 2 min). */
  staleMs?: number;
  /** Holder refresh interval (default 15 s). */
  heartbeatMs?: number;
  /** Poll interval while waiting (default 100 ms). */
  pollMs?: number;
}

export interface LockInfo {
  pid: number;
  host: string;
  ts: number;
}

export class LockBusyError extends Error {
  readonly holder?: LockInfo;
  constructor(path: string, holder?: LockInfo) {
    super(`${path} is held by ${holder ? `pid ${holder.pid} on ${holder.host}` : "another process"}; another ingest is running`);
    this.name = "LockBusyError";
    this.holder = holder;
  }
}

export interface Lock {
  readonly path: string;
  release(): void;
}

function readHolder(path: string): LockInfo | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    if (typeof v.pid === "number" && typeof v.host === "string" && typeof v.ts === "number") return v as LockInfo;
  } catch {
    // Missing, or torn mid-write by a crashed holder: judged by mtime alone.
  }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the lock at `path` (if any) can be broken. */
export function isStale(path: string, staleMs = 120_000, now = Date.now()): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return true; // gone
  }
  const holder = readHolder(path);
  if (holder && holder.host === hostname() && holder.pid !== process.pid && !pidAlive(holder.pid)) return true;
  return now - mtimeMs > staleMs;
}

function tryCreate(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now() } satisfies LockInfo));
  } finally {
    closeSync(fd);
  }
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function acquireLock(path: string, opts: LockOptions = {}): Promise<Lock> {
  const waitMs = opts.waitMs ?? 30_000;
  const staleMs = opts.staleMs ?? 120_000;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryCreate(path)) break;
    if (isStale(path, staleMs)) {
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new LockBusyError(path, readHolder(path));
    await sleep(opts.pollMs ?? 100);
  }
  const timer = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // Lock file removed under us (someone judged it stale): nothing to refresh.
    }
  }, heartbeatMs);
  timer.unref();
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      // Only remove the file if it is still ours.
      if (readHolder(path)?.pid === process.pid) rmSync(path, { force: true });
    },
  };
}
