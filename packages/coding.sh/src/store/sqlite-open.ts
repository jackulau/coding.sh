// Loading node:sqlite and opening a database in WAL mode, shared by the index
// (./sqlite.ts) and the blob store's pack (./fs-blobs.ts).
//
// node:sqlite is still flagged experimental and prints an ExperimentalWarning
// on load. That warning is noise for CLI users, so it is filtered once while
// the module is dynamically imported; every other warning passes through.
import type { DatabaseSync } from "node:sqlite";

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
      if ((e as { errcode?: number }).errcode !== 5 || i >= 50) throw e;
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
    }
  }
}
