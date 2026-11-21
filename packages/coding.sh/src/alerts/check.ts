// One pass over every alert: read its measure, work out each group's state, and
// notify the target of each change of state. `coding.sh alert check` runs it (cron,
// Task Scheduler) and `coding.sh serve` runs it every minute. Nothing else does:
// not the hook, and not a read command.
import type { IndexStore } from "../core/types.ts";
import { type AlertPayload, deliver, type DeliverOptions } from "./notify.ts";
import { readMeasure } from "./measure.ts";
import { type AlertDef, type AlertState, loadAlerts, MAX_FAILED_DELIVERIES, saveAlerts, withAlertsLock } from "./store.ts";

/** A group's state for a value; null is no data, which --no-data maps. Direction "under" fires below the thresholds. */
export function classify(def: Pick<AlertDef, "over" | "warn" | "noData" | "direction">, value: number | null, previous: AlertState): AlertState {
  if (value === null) {
    if (def.noData === "ok") return "OK";
    if (def.noData === "alert") return "ALERT";
    if (def.noData === "keep") return previous;
    return "NO_DATA";
  }
  const past = def.direction === "under" ? (t: number) => value < t : (t: number) => value > t;
  if (past(def.over)) return "ALERT";
  if (def.warn !== undefined && past(def.warn)) return "WARNING";
  return "OK";
}

/** The threshold a state is about: --warn for WARNING, --over otherwise. */
export const thresholdOf = (def: Pick<AlertDef, "over" | "warn">, state: AlertState): number => (state === "WARNING" && def.warn !== undefined ? def.warn : def.over);

const RANK: Record<AlertState, number> = { ALERT: 3, WARNING: 2, OK: 1, NO_DATA: 0 };

export interface GroupResult {
  /** The agent (with --by agent). */
  agent?: string;
  state: AlertState;
  previous: AlertState;
  value: number | null;
  changed: boolean;
}

export interface AlertResult {
  name: string;
  measure: string;
  window: string;
  over: number;
  warn?: number;
  /** "under": the thresholds are lower bounds (--under). */
  direction?: "under";
  by?: "agent";
  /** The worst group's state; NO_DATA when no group has data. */
  state: AlertState;
  value: number | null;
  groups: GroupResult[];
  /** Notifications sent, failed, and skipped because the target is disabled. */
  notified: number;
  failed: number;
  skipped: number;
  disabled: boolean;
  /** The measure could not be read (bad --where, store error); states are unchanged. */
  error?: string;
  /** The last delivery error. */
  deliveryError?: string;
  truncated?: boolean;
}

export interface CheckOptions extends DeliverOptions {
  file: string;
  index: IndexStore;
  now?: number;
  /** How long to wait for another check or edit to finish (default 30 s). */
  lockWaitMs?: number;
}

export function payloadOf(def: AlertDef, g: Pick<GroupResult, "agent" | "state" | "previous" | "value">, at: number): AlertPayload {
  // Key order is the documented body order: ..., threshold, direction?, window, by?, at.
  const dir = def.direction === "under" ? { direction: "under" as const } : {};
  const head = { alert: def.name, state: g.state, previous: g.previous, value: g.value, threshold: thresholdOf(def, g.state), ...dir, window: def.window };
  const iso = new Date(at).toISOString();
  return g.agent !== undefined ? { ...head, by: { agent: g.agent }, at: iso } : { ...head, at: iso };
}

/** Records one delivery on the alert: a success resets the count, the 5th failure in a row disables the target. */
export function recordDelivery(def: AlertDef, d: { ok: boolean; error?: string }, now: number): void {
  if (d.ok) {
    def.delivery = { failures: 0, lastOkAt: now };
    return;
  }
  def.delivery.failures++;
  def.delivery.lastError = d.error;
  if (def.delivery.failures >= MAX_FAILED_DELIVERIES && def.delivery.disabledAt === undefined) def.delivery.disabledAt = now;
}

async function checkOne(def: AlertDef, o: CheckOptions, now: number): Promise<AlertResult> {
  const r: AlertResult = { name: def.name, measure: def.measure, window: def.window, over: def.over, state: "NO_DATA", value: null, groups: [], notified: 0, failed: 0, skipped: 0, disabled: def.delivery.disabledAt !== undefined };
  if (def.warn !== undefined) r.warn = def.warn;
  if (def.direction === "under") r.direction = "under";
  if (def.by) r.by = def.by;
  let values: Map<string, number | null>;
  try {
    const reading = await readMeasure(o.index, def, now);
    values = reading.values;
    if (reading.truncated) r.truncated = true;
  } catch (e) {
    r.error = (e as Error).message;
    return r;
  }
  // Groups seen before and absent now have no data.
  const keys = [...new Set([...values.keys(), ...Object.keys(def.states)])].sort();
  for (const key of keys) {
    const prev = def.states[key];
    const previous = prev?.state ?? "OK";
    const value = values.get(key) ?? null;
    const state = classify(def, value, previous);
    const changed = state !== previous;
    def.states[key] = { state, value, since: changed || !prev ? now : prev.since, checkedAt: now };
    const group: GroupResult = { state, previous, value, changed };
    if (def.by) group.agent = key;
    r.groups.push(group);
  }
  const worst = r.groups.reduce<GroupResult | undefined>((w, g) => (!w || RANK[g.state] > RANK[w.state] ? g : w), undefined);
  if (worst) {
    r.state = worst.state;
    r.value = worst.value;
  }
  for (const g of r.groups) {
    if (!g.changed) continue;
    if (def.delivery.disabledAt !== undefined) {
      r.skipped++;
      continue;
    }
    const opts: DeliverOptions = { ...o };
    if (def.secret) opts.secret = def.secret;
    const d = await deliver(def.notify, payloadOf(def, g, now), opts);
    recordDelivery(def, d, now);
    if (d.ok) r.notified++;
    else r.failed++;
  }
  r.disabled = def.delivery.disabledAt !== undefined;
  if (def.delivery.lastError && def.delivery.failures) r.deliveryError = def.delivery.lastError;
  return r;
}

/** Checks every alert in the file under its lock, notifies each change of state, and saves the states. */
export async function runAlertChecks(o: CheckOptions): Promise<AlertResult[]> {
  return withAlertsLock(
    o.file,
    async () => {
      const doc = loadAlerts(o.file);
      if (!doc.alerts.length) return [];
      const now = o.now ?? Date.now();
      const results: AlertResult[] = [];
      for (const def of doc.alerts) results.push(await checkOne(def, o, now));
      await saveAlerts(o.file, doc);
      return results;
    },
    o.lockWaitMs,
  );
}
