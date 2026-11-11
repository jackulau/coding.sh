// Progress for index upgrades (SqliteIndexStore.migrate), so the first command
// after an upgrade says what it is doing instead of hanging silently.
//
// A migration that rewrites a big store prints to stderr when it starts and then
// at most once a second; stdout is left to the command. The process running the
// upgrade also keeps `<db>.upgrade` up to date, so another process that has to
// wait for it (the CLI while the background ingest upgrades) can say how far it is.
//
// Also here, because a migration is one-way: the copy of the index kept before
// one (backupIndex, restoreBackup), the stamp that names the store's last writer
// (WRITER_KEY), and the error for a store a newer coding.sh migrated.
import { constants, copyFileSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

/** Stores with at least this many events print upgrade progress (smaller ones upgrade in well under a second). */
export const UPGRADE_PROGRESS_MIN_ROWS = 100_000;

/** What `<db>.upgrade` holds while a process upgrades the index. */
export interface UpgradeState {
  pid: number;
  host: string;
  from: number;
  to: number;
  startedAt: number;
  /** The step running now, in words ("search index"). */
  step: string;
  done?: number;
  total?: number;
}

export const upgradeStatePath = (dbPath: string): string => `${dbPath}.upgrade`;

const fmt = (n: number): string => n.toLocaleString("en-US");

/** "search index 312,000 of 740,614 events (42%)" */
export function describeStep(s: { step: string; done?: number; total?: number }): string {
  if (s.done === undefined || !s.total) return s.step;
  return `${s.step} ${fmt(s.done)} of ${fmt(s.total)} events (${Math.min(100, Math.floor((s.done / s.total) * 100))}%)`;
}

/** Reports one upgrade. Methods are cheap to call often: output is throttled to once a second. */
export class UpgradeProgress {
  private readonly started = Date.now();
  private lastPrint = 0;
  private readonly state: UpgradeState;
  private readonly statePath: string | undefined;
  /** Whether a line was printed, so the end can say it finished. */
  printed = false;

  readonly rows: number;
  private readonly write: ((line: string) => void) | undefined;

  /** `write` undefined: a small store, upgraded silently and without a state file. */
  constructor(dbPath: string, from: number, to: number, rows: number, write: ((line: string) => void) | undefined) {
    this.rows = rows;
    this.write = write;
    this.state = { pid: process.pid, host: hostname(), from, to, startedAt: this.started, step: "schema" };
    this.statePath = dbPath === ":memory:" || !write ? undefined : upgradeStatePath(dbPath);
  }

  /** Prints the opening line and writes the state file. */
  begin(): void {
    this.saveState();
    if (!this.write) return;
    const what = this.state.from === 0 ? "creating" : `upgrading it from schema v${this.state.from} to v${this.state.to}`;
    this.print(`coding.sh: the index holds ${fmt(this.rows)} events; ${what}. This runs once.`);
  }

  /** The schema the upgrade starts from. */
  get from(): number {
    return this.state.from;
  }

  /**
   * Progress of a loop that walks events by rowid (`at` of `last`), counted in
   * events: rowids have gaps wherever events were deleted, so the highest rowid
   * is not how many events the store holds.
   */
  stepRows(step: string, at: number, last: number): void {
    this.step(step, last > 0 ? Math.min(this.rows, Math.floor((this.rows * at) / last)) : this.rows, this.rows);
  }

  /** A new step, or progress within one. Printed at most once a second. */
  step(step: string, done?: number, total?: number): void {
    this.state.step = step;
    this.state.done = done;
    this.state.total = total;
    const now = Date.now();
    if (now - this.lastPrint < 1000) return;
    this.saveState();
    if (this.write) this.print(`coding.sh: upgrading the index: ${describeStep(this.state)}`);
  }

  /** Removes the state file and, when anything was printed, says how long it took and what to run next. */
  end(ok: boolean, hint?: string): void {
    if (this.statePath) rmSync(this.statePath, { force: true });
    if (!this.printed || !this.write) return;
    const secs = ((Date.now() - this.started) / 1000).toFixed(1);
    this.write(ok ? `coding.sh: index upgraded in ${secs}s.${hint ? ` ${hint}` : ""}\n` : `coding.sh: the index upgrade stopped after ${secs}s; nothing was changed.\n`);
  }

  private print(line: string): void {
    this.lastPrint = Date.now();
    this.printed = true;
    this.write?.(`${line}\n`);
  }

  private saveState(): void {
    if (!this.statePath) return;
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state));
    } catch {
      // a read-only directory: waiters just say they are waiting
    }
  }
}

/** The upgrade another live process on this host is running on `dbPath`, if any. */
export function runningUpgrade(dbPath: string): UpgradeState | undefined {
  let s: UpgradeState;
  try {
    s = JSON.parse(readFileSync(upgradeStatePath(dbPath), "utf8")) as UpgradeState;
  } catch {
    return undefined;
  }
  if (typeof s?.pid !== "number" || s.pid === process.pid) return undefined;
  if (s.host !== hostname()) return s; // can't check a pid on another host; trust the file
  try {
    process.kill(s.pid, 0);
    return s;
  } catch (e) {
    // EPERM: alive but someone else's process
    return (e as NodeJS.ErrnoException).code === "EPERM" ? s : undefined;
  }
}

/**
 * Splits a migration's SQL into statements, so progress can be reported between
 * them. Understands '…' and "…" quoting and -- comments; migrations hold no
 * triggers or BEGIN…END blocks.
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length : nl;
      cur += sql.slice(i, end);
      i = end - 1;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      cur += sql.slice(i, j + 1);
      i = j;
    } else if (c === ";") {
      if (cur.replace(/--[^\n]*/g, "").trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.replace(/--[^\n]*/g, "").trim()) out.push(cur.trim());
  return out;
}

// ---------------------------------------------------------------- last writer

/** kv key of the stamp below. A row, not a column: no schema change, and an older coding.sh ignores it. */
export const WRITER_KEY = "store:writer";

/**
 * The newest coding.sh that opened the store for writing at its current schema.
 * A build that is not newer than `version` and still wants to migrate the store
 * is not a release that follows it (a source build, an older install with a
 * newer schema), so it migrates only when asked to (core/store-guard.ts).
 */
export interface StoreWriter {
  version: string;
  schema: number;
  at: number;
}

export function parseWriter(value: unknown): StoreWriter | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const w = JSON.parse(value) as Partial<StoreWriter> | null;
    if (!w || typeof w.version !== "string" || typeof w.schema !== "number") return undefined;
    return { version: w.version, schema: w.schema, at: typeof w.at === "number" ? w.at : 0 };
  } catch {
    return undefined;
  }
}

/** A store a newer coding.sh migrated: this one can't open it. Nothing is lost, the hook keeps spooling. */
export class StoreNewerError extends Error {
  readonly path: string;
  /** The schema the store is at. */
  readonly schema: number;
  /** The newest schema this coding.sh knows. */
  readonly known: number;
  /** The coding.sh that wrote it, when it left a stamp. */
  readonly writer?: StoreWriter;
  constructor(o: { path: string; schema: number; known: number; writer?: StoreWriter }) {
    const by = o.writer ? `, written by coding.sh ${o.writer.version}` : "";
    super(`${o.path} uses index schema v${o.schema}${by}, but this coding.sh only knows up to v${o.known}. Captures stay safe in the spool until a coding.sh that knows v${o.schema} indexes them: coding.sh update`);
    this.name = "StoreNewerError";
    this.path = o.path;
    this.schema = o.schema;
    this.known = o.known;
    if (o.writer) this.writer = o.writer;
  }
}

// ---------------------------------------------------------------- backup

/** Where the index as it was at `schema` is kept while a migration replaces it. */
export const backupPath = (dbPath: string, schema: number): string => `${dbPath}.v${schema}.bak`;
/** Where `upgrade-store --restore` leaves the migrated index it replaced. */
export const undonePath = (dbPath: string, schema: number): string => `${dbPath}.v${schema}.undone`;

/** A full copy keeps this much free on top of the copy itself (the migration writes too). */
const BACKUP_HEADROOM = 64 * 1024 * 1024;

/** The filesystem calls backupIndex makes (replaced in tests: no copy-on-write, a full disk). */
export interface BackupIo {
  /** A copy-on-write clone; throws where the filesystem has none. */
  clone(src: string, dest: string): void;
  copy(src: string, dest: string): void;
  size(path: string): number;
  /** Bytes free for this user in `dir`, or undefined when the platform can't tell. */
  free(dir: string): number | undefined;
}

const BACKUP_IO: BackupIo = {
  clone: (src, dest) => copyFileSync(src, dest, constants.COPYFILE_FICLONE_FORCE),
  copy: (src, dest) => copyFileSync(src, dest),
  size: (path) => statSync(path).size,
  free: (dir) => {
    try {
      const s = statfsSync(dir);
      return s.bavail * s.bsize;
    } catch {
      return undefined;
    }
  },
};

/** No room for the copy of the index a migration keeps: nothing was copied and nothing migrated. */
export class BackupSpaceError extends Error {
  readonly path: string;
  readonly needed: number;
  readonly free: number;
  constructor(path: string, needed: number, free: number) {
    const gb = (n: number): string => `${(n / 1e9).toFixed(n < 1e8 ? 3 : 1)} GB`;
    super(`${path} is not upgraded: a migration is one-way, so coding.sh keeps a copy of the index first, and that needs ${gb(needed)} free in ${dirname(path)} (${gb(free)} is free). Free some space, then run this again.`);
    this.name = "BackupSpaceError";
    this.path = path;
    this.needed = needed;
    this.free = free;
  }
}

/**
 * Copies the index at `dbPath` (schema `from`) to backupPath before a migration
 * rewrites it, and returns that path. The caller holds the write lock with an
 * empty WAL, so the file alone is the whole store. A copy-on-write clone where
 * the filesystem has one (APFS, Btrfs, XFS: no time, no space until the pages
 * diverge); else a full copy, refused with a BackupSpaceError when it would
 * not fit. Replaces an older copy of the same schema.
 */
export function backupIndex(dbPath: string, from: number, io: BackupIo = BACKUP_IO): string {
  const dest = backupPath(dbPath, from);
  const tmp = `${dest}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  try {
    try {
      io.clone(dbPath, tmp);
    } catch {
      rmSync(tmp, { force: true });
      const needed = io.size(dbPath) + BACKUP_HEADROOM;
      const free = io.free(dirname(dbPath));
      if (free !== undefined && free < needed) throw new BackupSpaceError(dbPath, needed, free);
      io.copy(dbPath, tmp);
    }
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return dest;
}

export interface IndexBackup {
  path: string;
  schema: number;
  bytes: number;
}

/** The copies backupIndex left next to `dbPath`, newest schema first. */
export function listBackups(dbPath: string): IndexBackup[] {
  const prefix = `${basename(dbPath)}.v`;
  let names: string[];
  try {
    names = readdirSync(dirname(dbPath));
  } catch {
    return [];
  }
  const out: IndexBackup[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".bak")) continue;
    const schema = name.slice(prefix.length, -".bak".length);
    if (!/^\d+$/.test(schema)) continue;
    const path = join(dirname(dbPath), name);
    try {
      out.push({ path, schema: Number(schema), bytes: statSync(path).size });
    } catch {
      // removed meanwhile
    }
  }
  return out.sort((a, b) => b.schema - a.schema);
}

/** After the index's name: `.v<N>.bak`, `.v<N>.undone`, a killed backupIndex's `.v<N>.bak.tmp-<pid>`, and a WAL or journal beside one. */
const INDEX_COPY = /^\.v\d+\.(?:bak(?:\.tmp-\d+)?|undone)(?:-wal|-shm|-journal)?$/;

/**
 * Every copy of the index kept next to `dbPath`, of any schema: the ones from before a
 * migration (backupPath), the ones `upgrade-store --restore` replaced (undonePath) and what a
 * killed backupIndex left behind. Each holds every event as it was when the copy was made, so
 * `coding.sh purge` deletes them (./purge.ts removeIndexCopies).
 */
export function listIndexCopies(dbPath: string): string[] {
  const name = basename(dbPath);
  let names: string[];
  try {
    names = readdirSync(dirname(dbPath));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(name) && INDEX_COPY.test(n.slice(name.length)))
    .sort()
    .map((n) => join(dirname(dbPath), n));
}

/** Drops the copies older than the one a finished migration from `from` kept: one way back is kept, not every one. */
export function pruneBackups(dbPath: string, from: number): void {
  for (const b of listBackups(dbPath)) if (b.schema < from) rmSync(b.path, { force: true });
}

/**
 * Puts `backup` back as the index and keeps the index it replaces (schema
 * `current`) at undonePath, which it returns. The caller has emptied the WAL
 * and closed the database; both moves are renames, so no space is needed.
 */
export function restoreBackup(dbPath: string, backup: IndexBackup, current: number): string {
  const undone = undonePath(dbPath, current);
  rmSync(undone, { force: true });
  renameSync(dbPath, undone);
  try {
    // What is left of the migrated index's WAL would be replayed over the restored file.
    for (const ext of ["-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
    renameSync(backup.path, dbPath);
  } catch (e) {
    renameSync(undone, dbPath);
    throw e;
  }
  return undone;
}
