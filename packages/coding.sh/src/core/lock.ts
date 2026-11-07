// Cross-process advisory lock: a lockfile created with O_EXCL holding
// { pid, host, ts, nonce }. Two `coding.sh ingest` runs (a CLI call and the
// viewer's background ingest, say) would otherwise read the same spool range
// and both send it to every sink, so sinks would see duplicate batches.
//
// Stale detection: the holder refreshes the file's mtime every `heartbeatMs`.
// A lock is stale when its holder is a dead pid on this host, or its mtime is
// older than `staleMs` (holder hung, or on another host sharing the dir). A
// missing lock file is free, never stale: the contender just retries the
// O_EXCL create, which decides every race between creators.
//
// Breaking a stale lock is serialized: a breaker first takes `<lock>.break`
// (O_EXCL), judges the lock again under it, and removes it only if it is the
// same stale file (rename aside, compare inode/mtime/content, link back if
// not). A live lock is only ever created where no file exists, so a breaker
// never removes a lock a peer just took, and two breakers of one stale lock
// never both win.
//
// Fencing: the nonce identifies this acquisition. assertHeld() throws
// LockLostError once the file no longer carries it (broken by a peer after a
// stall longer than staleMs, e.g. a sleeping laptop), so the holder stops
// before writing cursors or sending to sinks.
//
// Locks still held when the process exits (process.exit(130) on a second
// Ctrl-C skips `finally`) are removed by an exit handler.
//
// Hot path: the hook imports this file (spool/kick.ts) for isLocked(); keep it
// to node:fs and node:os.
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
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
  /** Identifies one acquisition (absent in locks written by older versions). */
  nonce?: string;
}

export class LockBusyError extends Error {
  readonly holder?: LockInfo;
  constructor(path: string, holder?: LockInfo) {
    super(`${path} is held by ${holder ? `pid ${holder.pid} on ${holder.host}` : "another process"}; another ingest is running`);
    this.name = "LockBusyError";
    this.holder = holder;
  }
}

export class LockLostError extends Error {
  constructor(path: string) {
    super(`lost ${path}: another process broke it as stale; stopping before writing anything more`);
    this.name = "LockLostError";
  }
}

export interface Lock {
  readonly path: string;
  /** Throws LockLostError when the lock file no longer belongs to this acquisition. */
  assertHeld(): void;
  release(): void;
}

const DEFAULT_STALE_MS = 120_000;

function parseHolder(text: string): LockInfo | undefined {
  try {
    const v = JSON.parse(text) as Partial<LockInfo>;
    if (typeof v.pid === "number" && typeof v.host === "string" && typeof v.ts === "number") return v as LockInfo;
  } catch {
    // Torn mid-write by a crashed holder: judged by mtime alone.
  }
  return undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readHolder(path: string): LockInfo | undefined {
  const t = readText(path);
  return t === undefined ? undefined : parseHolder(t);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What a contender saw at `path`: enough to recognize the same file later. */
interface Seen {
  state: "free" | "held" | "stale";
  ino?: number;
  mtimeMs?: number;
  text?: string;
}

function inspect(path: string, staleMs: number, now: number): Seen {
  let ino: number, mtimeMs: number;
  try {
    ({ ino, mtimeMs } = statSync(path));
  } catch {
    return { state: "free" };
  }
  const text = readText(path);
  if (text === undefined) return { state: "free" }; // removed between stat and read
  const holder = parseHolder(text);
  const deadHolder = !!holder && holder.host === hostname() && holder.pid !== process.pid && !pidAlive(holder.pid);
  return { state: deadHolder || now - mtimeMs > staleMs ? "stale" : "held", ino, mtimeMs, text };
}

/** True when a lock file exists at `path` and can be broken. A missing file is not stale. */
export function isStale(path: string, staleMs = DEFAULT_STALE_MS, now = Date.now()): boolean {
  return inspect(path, staleMs, now).state === "stale";
}

/** True when a live holder owns the lock at `path` (the file exists and is not stale). */
export function isLocked(path: string, staleMs = DEFAULT_STALE_MS, now = Date.now()): boolean {
  return inspect(path, staleMs, now).state === "held";
}

/** A breaker holds `<lock>.break` for microseconds; one older than this died mid-break. */
const BREAK_STALE_MS = 10_000;

/**
 * Removes the file judged in `seen` from `path`, unless it was replaced in
 * the meantime: rename it aside, check it is the same file (inode, mtime,
 * content), and link it back otherwise.
 */
function removeIfSame(path: string, seen: Seen): void {
  const moved = `${path}.stale.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    renameSync(path, moved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  let same = false;
  try {
    const s = statSync(moved);
    same = s.ino === seen.ino && s.mtimeMs === seen.mtimeMs && readText(moved) === seen.text;
  } catch {
    // vanished: nothing to restore
  }
  if (!same) {
    try {
      linkSync(moved, path);
    } catch {
      // EEXIST, or no hard links on this filesystem
    }
  }
  rmSync(moved, { force: true });
}

/**
 * Breaks a stale lock. Breakers take `<lock>.break` (O_EXCL) first, so only one
 * process at a time judges and removes the lock: a stale file can only be
 * replaced through this guard (a live lock is created only where no file
 * exists), so the breaker never removes a lock a peer just took. Returns false
 * when another breaker holds the guard (the caller waits like for a live
 * holder).
 */
function breakStale(path: string, staleMs: number, nonce: string): boolean {
  const guard = `${path}.break`;
  if (!tryCreate(guard, { pid: process.pid, host: hostname(), ts: Date.now(), nonce })) {
    const g = inspect(guard, BREAK_STALE_MS, Date.now());
    if (g.state === "stale") removeIfSame(guard, g);
    return g.state !== "held";
  }
  try {
    // Judged again under the guard: a peer may have broken it and taken a fresh lock since.
    const now = inspect(path, staleMs, Date.now());
    if (now.state === "stale") removeIfSame(path, now);
  } finally {
    if (readHolder(guard)?.nonce === nonce) rmSync(guard, { force: true });
  }
  return true;
}

function tryCreate(path: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  return true;
}

// Locks this process holds, by path → nonce, removed on exit if `finally` never ran.
const held = new Map<string, string>();
let exitHook = false;
function releaseAllOnExit(): void {
  for (const [path, nonce] of held) {
    try {
      if (readHolder(path)?.nonce === nonce) rmSync(path, { force: true });
    } catch {
      // exiting anyway
    }
  }
  held.clear();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function acquireLock(path: string, opts: LockOptions = {}): Promise<Lock> {
  const waitMs = opts.waitMs ?? 30_000;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const deadline = Date.now() + waitMs;
  const nonce = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  for (;;) {
    if (tryCreate(path, { pid: process.pid, host: hostname(), ts: Date.now(), nonce })) break;
    const seen = inspect(path, staleMs, Date.now());
    if (seen.state === "free") continue; // released between our create and the look
    if (seen.state === "stale" && breakStale(path, staleMs, nonce)) continue;
    if (Date.now() >= deadline) throw new LockBusyError(path, readHolder(path));
    await sleep(opts.pollMs ?? 100);
  }
  held.set(path, nonce);
  if (!exitHook) {
    exitHook = true;
    process.on("exit", releaseAllOnExit);
  }
  let released = false;
  let lost = false;
  const ours = () => readHolder(path)?.nonce === nonce;
  const timer = setInterval(() => {
    // Refresh only our own file: never keep a successor's lock looking fresh.
    if (!ours()) {
      lost = true;
      return;
    }
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      lost = true;
    }
  }, heartbeatMs);
  timer.unref();
  return {
    path,
    assertHeld() {
      if (!released && !lost && ours()) return;
      if (!released) lost = true;
      throw new LockLostError(path);
    },
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (held.get(path) === nonce) held.delete(path);
      // Only remove the file if it is still ours.
      if (ours()) rmSync(path, { force: true });
    },
  };
}

/**
 * Wake-up marker next to a lock (`.ingest.lock` → `.ingest.pending`): a
 * producer touches it when work arrives that a live holder may have missed;
 * the holder clears it before a pass and re-runs after release when it is
 * back (see core/ingest.ts).
 */
export function wakeMarker(lockPath: string): string {
  return lockPath.replace(/\.lock$/, "") + ".pending";
}
