// Progress for index upgrades (SqliteIndexStore.migrate), so the first command
// after an upgrade says what it is doing instead of hanging silently.
//
// A migration that rewrites a big store prints to stderr when it starts and then
// at most once a second; stdout is left to the command. The process running the
// upgrade also keeps `<db>.upgrade` up to date, so another process that has to
// wait for it (the CLI while the background ingest upgrades) can say how far it is.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

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
