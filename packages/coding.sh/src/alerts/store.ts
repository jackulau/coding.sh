// Alert definitions and their states, in <CODING_SH_HOME>/alerts.json (mode 600:
// it holds each webhook's signing secret). Every change is a whole-file write to a
// temp file, then a rename, under a lock file next to it, so `coding.sh alert
// check` from cron and the check `coding.sh serve` runs every minute never lose
// each other's states or send one change twice.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { acquireLock } from "../core/lock.ts";
import { renameOver } from "../store/durable.ts";

export const ALERT_STATES = ["OK", "WARNING", "ALERT", "NO_DATA"] as const;
export type AlertState = (typeof ALERT_STATES)[number];

/** Rolling windows: an alert reads the sessions that started in the last hour, day or week. */
export const ALERT_WINDOWS = { "1h": 3_600_000, "1d": 86_400_000, "7d": 7 * 86_400_000 } as const;
export type AlertWindow = keyof typeof ALERT_WINDOWS;

/** What a window with no data counts as: OK, ALERT, or the state it had. Unset: NO_DATA. */
export const NO_DATA_POLICIES = ["ok", "alert", "keep"] as const;
export type NoDataPolicy = (typeof NO_DATA_POLICIES)[number];

export type AlertTarget = { kind: "webhook"; url: string } | { kind: "command"; command: string };

/** Failed deliveries in a row that disable a target until `alert test` gets through. */
export const MAX_FAILED_DELIVERIES = 5;

export interface GroupState {
  state: AlertState;
  value: number | null;
  /** When the group entered this state (ms). */
  since: number;
  checkedAt: number;
}

export interface AlertDef {
  name: string;
  /** failure-rate, cost, sessions or flag:<flag>. */
  measure: string;
  /** A --where query the sessions must match too. */
  where?: string;
  by?: "agent";
  over: number;
  warn?: number;
  window: AlertWindow;
  notify: AlertTarget;
  noData?: NoDataPolicy;
  /** HMAC-SHA256 key for X-Coding-Sh-Signature (webhooks). Printed once, by `alert add`. */
  secret?: string;
  createdAt: number;
  /** By group: "" for the whole window, else the agent (with by: agent). A group with no entry is OK. */
  states: Record<string, GroupState>;
  delivery: { failures: number; lastError?: string; lastOkAt?: number; disabledAt?: number };
}

export interface AlertsDoc {
  v: 1;
  alerts: AlertDef[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isAlertName = (s: string): boolean => NAME.test(s);

/** The file's alerts; none when it does not exist. Throws on a file that is not an alerts document. */
export function loadAlerts(file: string): AlertsDoc {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, alerts: [] };
    throw e;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; fix or remove it`);
  }
  const alerts = (doc as { alerts?: unknown })?.alerts;
  if (!Array.isArray(alerts)) throw new Error(`${file} has no "alerts" list; fix or remove it`);
  for (const a of alerts as AlertDef[]) {
    a.states ??= {};
    a.delivery ??= { failures: 0 };
  }
  return { v: 1, alerts: alerts as AlertDef[] };
}

/** Writes the whole document: a temp file made with mode 600, then a rename over the old one. */
export async function saveAlerts(file: string, doc: AlertsDoc): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(doc, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    await renameOver(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw e;
  }
}

/** Runs fn holding `<file>.lock`; waits up to waitMs for another check or edit to finish. */
export async function withAlertsLock<T>(file: string, fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
  mkdirSync(dirname(file), { recursive: true });
  const lock = await acquireLock(`${file}.lock`, { waitMs });
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/** The alert as list and check show it: everything but the secret. */
export function publicAlert(a: AlertDef): Omit<AlertDef, "secret"> {
  const out: AlertDef = { ...a };
  delete out.secret;
  return out;
}
