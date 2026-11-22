// Monitors (`coding.sh monitor`): definitions and their state in
// <CODING_SH_HOME>/monitors.json. Each monitor keeps a cursor (the latest
// session end it has scored up to), the day's estimated judge spend and its
// last error. The file is written beside itself (mode 600: an --http monitor
// keeps its signing secret here) and renamed over, so a reader never sees half
// of it; a lock file next to it serializes changes.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { acquireLock } from "../core/lock.ts";

export type MonitorKind = "judge" | "run" | "http";

/** Judge providers a monitor may name. The subscription CLIs are left out: they are not metered by tokens. */
export const MONITOR_PROVIDERS = ["anthropic", "openai", "gateway", "gemini", "mock"] as const;
export type MonitorProvider = (typeof MONITOR_PROVIDERS)[number];

export interface MonitorError {
  message: string;
  at: number;
  sessionId?: string;
}

export interface MonitorDef {
  name: string;
  kind: MonitorKind;
  /** --judge: absolute path of the rubric file, read on every run. */
  rubric?: string;
  /** --run: the command line, run by the shell. */
  command?: string;
  /** --http: the evaluator's http(s) URL, without credentials. */
  url?: string;
  /** --http: the HMAC-SHA256 key each POST is signed with, 32 random bytes in hex. Never listed. */
  secret?: string;
  /** Where the monitor was added: the command runs here. */
  cwd: string;
  /** A `--where` query sessions must match. */
  where?: string;
  /** Fraction of sessions scored, 0..1, picked by a hash of the session id. Absent = all. */
  sample?: number;
  /** --judge: the day's estimated spend at which the monitor stops until the next day. */
  maxUsdDay: number;
  provider?: MonitorProvider;
  model?: string;
  createdAt: number;
  /** The latest session endedAt this monitor has handled. */
  cursor?: number;
  /** Estimated judge spend on one local day (YYYY-MM-DD). */
  spend?: { day: string; usd: number };
  lastError?: MonitorError;
  lastRunAt?: number;
  /** Scores written, all time. */
  scored?: number;
}

export interface MonitorsFile {
  version: 1;
  monitors: MonitorDef[];
}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function readMonitors(file: string): MonitorsFile {
  if (!existsSync(file)) return { version: 1, monitors: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}); fix or remove it`);
  }
  const list = doc && typeof doc === "object" ? (doc as { monitors?: unknown }).monitors : undefined;
  if (!Array.isArray(list)) throw new Error(`${file} has no "monitors" list; fix or remove it`);
  return { version: 1, monitors: list.filter(validDef) };
}

function validDef(d: unknown): d is MonitorDef {
  if (!d || typeof d !== "object") return false;
  const m = d as Partial<MonitorDef>;
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) return false;
  if (m.kind === "run") return typeof m.command === "string" && m.command.length > 0;
  if (m.kind === "judge") return typeof m.rubric === "string" && m.rubric.length > 0;
  if (m.kind === "http") return typeof m.url === "string" && m.url.length > 0 && typeof m.secret === "string" && m.secret.length > 0;
  return false;
}

/** An --http URL as list and errors show it: without its query string or fragment, which may hold a token. */
export function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url.replace(/[?#][\s\S]*$/, "");
  }
}

/** A definition as list and add print it: without its secret, and an --http URL without its query string. */
export function publicMonitor(m: MonitorDef): MonitorDef {
  const { secret: _secret, ...rest } = m;
  if (rest.url !== undefined) rest.url = shownUrl(rest.url);
  return rest;
}

/** Writes the file beside itself with mode 600 (where the OS has modes), then renames it over. */
export function writeMonitors(file: string, doc: MonitorsFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Runs `fn` on the file under its lock and writes what it returns (undefined = no change). */
export async function updateMonitors<T>(file: string, fn: (doc: MonitorsFile) => { doc?: MonitorsFile; result: T }, opts: { waitMs?: number } = {}): Promise<T> {
  mkdirSync(dirname(file), { recursive: true });
  const lock = await acquireLock(`${file}.lock`, { waitMs: opts.waitMs ?? 10_000 });
  try {
    const r = fn(readMonitors(file));
    if (r.doc) {
      lock.assertHeld();
      writeMonitors(file, r.doc);
    }
    return r.result;
  } finally {
    lock.release();
  }
}

/** The lock a run pass holds, so two processes never score the same sessions at once. */
export const runLockPath = (file: string): string => `${file}.run.lock`;

/** Local calendar day, YYYY-MM-DD. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today's estimated spend for a monitor (0 on a new day). */
export function spentToday(m: MonitorDef, now: number): number {
  return m.spend && m.spend.day === localDay(now) ? m.spend.usd : 0;
}
