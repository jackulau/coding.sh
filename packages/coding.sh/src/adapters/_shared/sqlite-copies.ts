// Temporary copies of agents' SQLite stores (more/_util.ts openSqliteCopy).
//
// Each copy is a <tmpdir>/csh-sqlite-XXXXXX dir holding the database, its WAL and SHM,
// and an owner file with the pid of the process that made it. A copy can be large
// (T3 Code's store is 1.7 GB), and the process that made it can be killed before it
// removes it: a read's tail import runs in a child that the read kills at its deadline,
// and on Windows a kill runs no cleanup at all. So whoever opens the next copy, and the
// read that killed the child, removes the copies whose owner is no longer running.
// Only node: built-ins and core/remove.ts here: the read's process imports this without the adapters.
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeSync } from "../../core/remove.ts";

export const SQLITE_COPY_PREFIX = "csh-sqlite-";
/** The file in a copy's dir that names its owner's pid. */
export const SQLITE_COPY_OWNER = "owner.pid";
/** A copy dir without an owner file (made before owner files, or being made right now) is removed once it is this old. */
export const UNOWNED_COPY_AGE_MS = 60 * 60 * 1000;

/** Copies this process made and has not removed yet: removed at exit, and never reaped while open. */
const live = new Map<string, () => void>();
let exitHook = false;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function remove(dir: string, retries = 3): boolean {
  // Retries, with a linear backoff (6 wait 1 s in all): on Windows a just-killed owner's handles outlive it a moment.
  const opts = { maxRetries: retries, retryDelay: 50 };
  try {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw e;
    }
    // The database, WAL and SHM first and the owner file last. A removal cut short keeps the owner file, so the
    // next reap knows the copy is a dead process's and removes the rest. Cut short: a read's tail child stops by
    // itself just before its deadline and is still removing its copy (a 1.7 GB file) when the read kills it, or a
    // file is still held open. Without the owner file the rest looked like a copy being made and stayed an hour.
    for (const n of names) if (n !== SQLITE_COPY_OWNER) removeSync(join(dir, n), opts);
    removeSync(dir, opts);
    return true;
  } catch {
    return false; // still in use: the next reap tries again
  }
}

function newestMtime(dir: string): number {
  let t = statSync(dir).mtimeMs;
  for (const n of readdirSync(dir)) {
    try {
      t = Math.max(t, statSync(join(dir, n)).mtimeMs);
    } catch {
      // removed meanwhile
    }
  }
  return t;
}

/**
 * Removes the copy dirs in tmpdir() whose owner process is no longer running, and those
 * without an owner file older than UNOWNED_COPY_AGE_MS. Never touches this process's open
 * copies or another live process's. `killed`: a child this process has just killed, whose
 * copies go even if it is still exiting. Returns how many it removed. Never throws.
 */
export function reapSqliteCopies(o: { now?: number; killed?: number } = {}): number {
  const root = tmpdir();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  const now = o.now ?? Date.now();
  let n = 0;
  for (const name of names) {
    if (!name.startsWith(SQLITE_COPY_PREFIX)) continue;
    const dir = join(root, name);
    if (live.has(dir)) continue;
    try {
      if (!statSync(dir).isDirectory()) continue;
      let owner: number | undefined;
      try {
        const pid = Number(readFileSync(join(dir, SQLITE_COPY_OWNER), "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) owner = pid;
      } catch {
        // no owner file
      }
      const killed = owner !== undefined && owner === o.killed;
      const stale = owner !== undefined ? killed || owner === process.pid || !pidAlive(owner) : now - newestMtime(dir) > UNOWNED_COPY_AGE_MS;
      if (!stale) continue;
      // A child killed a moment ago can hold its files open until it is gone: wait up to a second for that.
      if (remove(dir, killed ? 6 : 3)) n++;
    } catch {
      // removed meanwhile, or unreadable: not ours to judge
    }
  }
  return n;
}

/** A new, empty copy dir in tmpdir(), owned by this process. Throws when it can't be made. */
export function makeSqliteCopyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), SQLITE_COPY_PREFIX));
  live.set(dir, () => {});
  try {
    writeFileSync(join(dir, SQLITE_COPY_OWNER), String(process.pid));
  } catch (e) {
    releaseSqliteCopyDir(dir);
    throw e;
  }
  if (!exitHook) {
    exitHook = true;
    // A process that exits with a copy still open (process.exit mid-import) removes it on the way out.
    process.once("exit", () => {
      for (const dir of [...live.keys()]) releaseSqliteCopyDir(dir);
    });
  }
  return dir;
}

/** Sets what closes the database opened in a copy dir, so exit can close it before removing the files. */
export function onSqliteCopyRelease(dir: string, close: () => void): void {
  if (live.has(dir)) live.set(dir, close);
}

/** Closes what is open in a copy dir and removes it. */
export function releaseSqliteCopyDir(dir: string): void {
  const close = live.get(dir);
  live.delete(dir);
  try {
    close?.();
  } finally {
    remove(dir);
  }
}
