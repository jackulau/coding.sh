// Cross-process advisory lock: a lockfile created with O_EXCL holding
// { pid, host, ts, nonce }. Two `coding.sh ingest` runs (a CLI call and the
// viewer's background ingest, say) would otherwise read the same spool range
// and both send it to every sink, so sinks would see duplicate batches. The
// lock keeps them apart unless a process stalls (the windows are below).
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
// not). A live lock is only ever created where no file exists. That keeps a
// breaker off a peer's lock unless a process stalls past its limit:
// - release reads the lock, then removes it. A holder that stalls past staleMs
//   between the two removes the lock a peer took meanwhile.
// - A holder that stalled past staleMs can release, or a second breaker remove,
//   the stale file between a breaker's judgment and its rename. The breaker
//   then renames a peer's fresh lock aside and links it back (the peer's fence
//   fails meanwhile), or removes it when a third process creates the lock in
//   that moment or the file system has no hard links.
// - A breaker that stalls past BREAK_STALE_MS under the guard has its guard
//   judged stale and removed, so a second breaker works at the same time. When
//   the first judged the lock before its stall, the lock the second then takes
//   fares as above.
// The exit handler and the guard's own release are the same read, then remove.
//
// Fencing: the nonce identifies this acquisition. assertHeld() throws
// LockLostError once the file no longer carries it (broken by a peer after a
// stall longer than staleMs, e.g. a sleeping laptop), so the holder stops
// before writing cursors or sending to sinks. A check and the write it guards
// are two steps: a holder that stalls past staleMs between them writes after a
// peer took the lock, and after the windows above, a holder that never stalled
// can too. Ingest checks before a commit's cursor writes inside the store's
// transaction, which with SQLite holds the write lock; a sink send is the
// write left exposed.
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
  /** Stop waiting on abort, with LockBusyError (Ctrl-C while another process holds the lock). */
  signal?: AbortSignal;
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
 * Breaks a stale lock. Breakers take `<lock>.break` (O_EXCL) first, so one
 * process at a time judges and removes the lock, unless a breaker stalls past
 * BREAK_STALE_MS and a second one takes the guard over. The lock is judged
 * again under the guard and removed with removeIfSame, which links back a file
 * created since the judgment. A file is created only where none exists, so
 * that keeps the breaker off a lock a peer just took, unless the judged file
 * goes away by another path first (the release of a holder that stalled past
 * staleMs, a second breaker): then the peer's fresh lock is renamed aside for
 * a moment, and removed if a third process creates the lock in that moment or
 * the file system has no hard links (see the header). Returns false when
 * another breaker holds the guard (the caller waits like for a live holder).
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
    // A read, then a remove, like release: a stall between them removes a guard a second breaker took.
    if (readHolder(guard)?.nonce === nonce) rmSync(guard, { force: true });
  }
  return true;
}

/** True unless `path` is definitely absent (a file Windows is still deleting fails stat with EPERM). */
function present(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function tryCreate(path: string, info: LockInfo, retry = true): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    // Windows: a released lock that another process still has open (reading
    // it) lingers as delete-pending, and creating over it fails with EPERM.
    // That is a busy lock; EPERM with nothing there (twice) is a real error.
    if (code === "EPERM" && process.platform === "win32") {
      if (present(path)) return false;
      if (retry) return tryCreate(path, info, false);
    }
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
      // The same read, then remove, as release.
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
    if (Date.now() >= deadline || opts.signal?.aborted) throw new LockBusyError(path, readHolder(path));
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
      // Remove the file only if it is still ours: a read, then a remove. A stall past staleMs between
      // the two removes the lock a peer took meanwhile (see the header).
      if (ours()) rmSync(path, { force: true });
    },
  };
}

/**
 * Wake-up marker next to a lock (`.ingest.lock` → `.ingest.pending`): a
 * producer touches it when work arrives that a live holder may have missed.
 * Ingest clears it before each pass and runs another pass after release when
 * it is back, up to three; when the last one ends with it back, it hands it to
 * a new background ingest (core/ingest.ts, onPassesExhausted).
 */
export function wakeMarker(lockPath: string): string {
  return lockPath.replace(/\.lock$/, "") + ".pending";
}
