// Loading node:sqlite and opening a database in WAL mode, shared by the index
// (./sqlite.ts) and the blob store's pack (./fs-blobs.ts).
//
// node:sqlite is still flagged experimental and prints an ExperimentalWarning
// on load. That warning is noise for CLI users, so it is filtered once while
// the module is dynamically imported; every other warning passes through.
import { chmodSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";

type SqliteModule = typeof import("node:sqlite");
let sqliteModule: Promise<SqliteModule> | undefined;

export function loadSqlite(): Promise<SqliteModule> {
  sqliteModule ??= (async () => {
    const original = process.emitWarning;
    process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
      const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : undefined);
      const message = typeof warning === "string" ? warning : warning.message;
      if (type === "ExperimentalWarning" && /SQLite/i.test(message)) return;
      return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
    } as typeof process.emitWarning;
    try {
      return await import("node:sqlite");
    } finally {
      process.emitWarning = original;
    }
  })();
  return sqliteModule;
}

/**
 * PRAGMA journal_mode = WAL, retried on SQLITE_BUSY. Switching a fresh database out of
 * rollback mode needs an exclusive lock, and SQLite skips the busy handler when waiting
 * could deadlock, so several processes opening a new database together (the hook's
 * background ingest and the CLI) can get "database is locked" despite busy_timeout.
 */
export async function switchToWal(db: DatabaseSync): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (e) {
      if (!isBusy(e) || i >= 50) throw e;
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
    }
  }
}

/** SQLITE_BUSY or one of its extended codes (SQLITE_BUSY_RECOVERY, SQLITE_BUSY_SNAPSHOT, ...). */
export function isBusy(err: unknown): boolean {
  return ((err as { errcode?: number }).errcode ?? 0) % 256 === 5;
}

const retryOff = new WeakMap<object, number>();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Runs `fn` with the busy retry of retryOnBusy() off, for code that sets a short busy_timeout on purpose. */
export function withoutBusyRetry<T>(db: object, fn: () => T): T {
  retryOff.set(db, (retryOff.get(db) ?? 0) + 1);
  try {
    return fn();
  } finally {
    retryOff.set(db, (retryOff.get(db) ?? 1) - 1);
  }
}

/**
 * Wraps a connection so a statement that fails with SQLITE_BUSY is tried again, for up to
 * `budgetMs`, after the busy_timeout already waited. SQLite skips the busy handler in some
 * cases (a WAL being recovered or reset by a closing process, a lock upgrade that could
 * deadlock), and a read command that starts while the hook's background ingest opens or
 * closes the index would otherwise fail with "database is locked". Applies to exec() and to
 * run/get/all of prepared statements; iterate() and close() pass through.
 */
export function retryOnBusy(db: DatabaseSync, budgetMs = 5000): DatabaseSync {
  const retry = <T>(fn: () => T): T => {
    let deadline = 0;
    for (let i = 0; ; i++) {
      try {
        return fn();
      } catch (e) {
        if (!isBusy(e) || retryOff.get(proxy)) throw e;
        deadline ||= Date.now() + budgetMs;
        if (Date.now() >= deadline) throw e;
        Atomics.wait(sleeper, 0, 0, Math.min(5 * 2 ** Math.min(i, 4), 80) * (0.5 + Math.random()));
      }
    }
  };
  const wrapStatement = (st: StatementSync): StatementSync =>
    new Proxy(st, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof v !== "function") return v;
        if (prop === "run" || prop === "get" || prop === "all") return (...a: unknown[]) => retry(() => (v as (...x: unknown[]) => unknown).apply(target, a));
        return v.bind(target);
      },
    });
  const proxy: DatabaseSync = new Proxy(db, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (typeof v !== "function") return v;
      if (prop === "exec") return (sql: string) => retry(() => target.exec(sql));
      if (prop === "prepare") return (sql: string) => wrapStatement(retry(() => target.prepare(sql)));
      return v.bind(target);
    },
  });
  return proxy;
}

const POSIX = process.platform !== "win32";

/** Creates `dir` (and its parents) as owner-only (0700); a dir that exists keeps its mode. */
export function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Makes a database file and its -wal and -shm owner-only (0600): they hold prompts,
 * tool output and file contents. SQLite creates the -wal and -shm with the database
 * file's mode, so calling this right after the file is created covers them too.
 * A missing file or one this user can't change is left as it is. No-op on Windows.
 */
export function ownerOnly(path: string): void {
  if (!POSIX || path === ":memory:") return;
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(p, 0o600);
    } catch {
      // ENOENT (no WAL yet) or EPERM (another user's file): nothing to tighten.
    }
  }
}
