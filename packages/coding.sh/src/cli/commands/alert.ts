// coding.sh alert add|list|rm|check|test
//
// Thresholds on failures, cost, sessions, a flag or a score over a rolling window, with a
// webhook or a command told about each change of state (OK, WARNING, ALERT,
// NO_DATA). Definitions and states live in <CODING_SH_HOME>/alerts.json. `check`
// is what cron or Task Scheduler runs; `coding.sh serve` runs it every minute.
import { randomBytes } from "node:crypto";
import { paths } from "../../core/paths.ts";
import { LockBusyError } from "../../core/lock.ts";
import { type AlertResult, payloadOf, recordDelivery, runAlertChecks } from "../../alerts/check.ts";
import { parseMeasure } from "../../alerts/measure.ts";
import { deliver, type DeliverOptions, SIGNING_NOTES, targetText } from "../../alerts/notify.ts";
import { ALERT_WINDOWS, type AlertDef, type AlertState, type AlertTarget, type AlertWindow, isAlertName, loadAlerts, MAX_FAILED_DELIVERIES, NO_DATA_POLICIES, type NoDataPolicy, publicAlert, saveAlerts, withAlertsLock } from "../../alerts/store.ts";
import { UsageError } from "../args.ts";
import { autoIngest, num, readIngest, str, whereFlag, withContext } from "../common.ts";
import { cliCommand } from "../next-steps.ts";
import { CliError, plural, usd } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  const file = paths(c.env).alerts;
  switch (c.action) {
    case "add":
      return add(c, file);
    case "list":
      return list(c, file);
    case "rm":
      return rm(c, file);
    case "check":
      return check(c, file);
    case "test":
      return test(c, file);
    default:
      throw new UsageError(`unknown action ${JSON.stringify(c.action)}`);
  }
}

/** A measure's value as a table cell. */
export function valueText(measure: string, v: number | null): string {
  if (v === null) return "-";
  if (measure === "failure-rate") return `${Math.round(v * 1000) / 10}%`;
  if (measure === "cost") return usd(v);
  return String(v);
}

/** A threshold as a table cell: `> 50%`, or `< 0.5` for an alert that fires below it. */
export function thresholdText(a: { measure: string; direction?: "under" }, v: number): string {
  return `${a.direction === "under" ? "<" : ">"} ${valueText(a.measure, v)}`;
}

const MEASURES_TEXT = "failure-rate, cost, sessions, flag:<FLAG> or score:<NAME>";

function parseTarget(raw: string): AlertTarget {
  if (raw.startsWith("webhook:")) {
    const url = raw.slice("webhook:".length).trim();
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new UsageError(`--notify webhook: needs an http or https URL, got ${JSON.stringify(url)}`, { reason: "invalid_value" });
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`--notify webhook: needs an http or https URL, got ${u.protocol}`, { reason: "invalid_value" });
    return { kind: "webhook", url };
  }
  if (raw.startsWith("command:")) {
    const command = raw.slice("command:".length).trim();
    if (!command) throw new UsageError("--notify command: needs a command, e.g. command:\"notify-send coding.sh\"", { reason: "invalid_value" });
    return { kind: "command", command };
  }
  throw new UsageError(`--notify must be webhook:<URL> or command:"<CMD>", got ${JSON.stringify(raw)}`, { reason: "invalid_value" });
}

function requireName(c: CommandContext): string {
  const name = c.positionals[0]!;
  if (!isAlertName(name)) throw new UsageError(`alert names are letters, digits, dot, dash and underscore (up to 64), got ${JSON.stringify(name)}`, { reason: "invalid_value" });
  return name;
}

function notFound(env: NodeJS.ProcessEnv, name: string): CliError {
  return new CliError(`No alert named ${JSON.stringify(name)}`, { reason: "not_found", next: ["List the alerts:", cliCommand(env, ["alert", "list"])] });
}

/** The alert the empty states suggest, as the user's shell runs it. */
const addExample = (env: NodeJS.ProcessEnv): string => cliCommand(env, ["alert", "add", "failures", "--measure", "failure-rate", "--over", "0.5", "--window", "1d", "--notify", "webhook:https://example.com/hook"]);

async function add(c: CommandContext, file: string): Promise<number> {
  const { out } = c;
  const name = requireName(c);
  const measure = str(c.flags.measure);
  if (!measure) throw new UsageError(`--measure is required: ${MEASURES_TEXT}`, { reason: "missing_value" });
  if (!parseMeasure(measure)) throw new UsageError(`--measure must be ${MEASURES_TEXT}, got ${JSON.stringify(measure)}`, { reason: "invalid_value" });
  // --over/--warn fire above the threshold, --under/--warn-under below it: one pair or the other.
  const under = c.flags.under !== undefined || c.flags["warn-under"] !== undefined;
  if (under && (c.flags.over !== undefined || c.flags.warn !== undefined)) throw new UsageError("--under and --warn-under can't be used with --over or --warn: an alert fires above its threshold or below it", { reason: "invalid_usage" });
  const [hi, lo] = under ? ["under", "warn-under"] : ["over", "warn"];
  const over = num(c.flags[hi]);
  if (over === undefined || !Number.isFinite(over) || over < 0) throw new UsageError(`--over or --under is required: the value ${under ? "below" : "above"} which the alert fires, a number >= 0`, { reason: over === undefined ? "missing_value" : "invalid_value" });
  if (measure === "failure-rate" && over > 1) throw new UsageError(`failure-rate is a share from 0 to 1: --${hi} 0.5 is 50%, got ${over}`, { reason: "invalid_value" });
  const warn = num(c.flags[lo]);
  if (warn !== undefined && !(Number.isFinite(warn) && warn >= 0 && (under ? warn > over : warn < over))) throw new UsageError(`--${lo} must be >= 0 and ${under ? "above --under" : "below --over"} (${over}), got ${warn}`, { reason: "invalid_value" });
  const window = str(c.flags.window) as AlertWindow | undefined;
  if (!window) throw new UsageError(`--window is required: ${Object.keys(ALERT_WINDOWS).join(", ")}`, { reason: "missing_value" });
  const notifyRaw = str(c.flags.notify);
  if (!notifyRaw) throw new UsageError('--notify is required: webhook:<URL> or command:"<CMD>"', { reason: "missing_value" });
  const notify = parseTarget(notifyRaw);
  const noData = str(c.flags["no-data"]) as NoDataPolicy | undefined;
  if (noData !== undefined && !(NO_DATA_POLICIES as readonly string[]).includes(noData)) throw new UsageError(`--no-data must be one of ${NO_DATA_POLICIES.join(", ")}`, { reason: "invalid_value" });
  whereFlag(c); // a bad query fails now, not at the first check
  const where = str(c.flags.where);
  const by = str(c.flags.by) as "agent" | undefined;

  const def: AlertDef = { name, measure, over, window, notify, createdAt: Date.now(), states: {}, delivery: { failures: 0 } };
  if (where) def.where = where;
  if (by) def.by = by;
  if (warn !== undefined) def.warn = warn;
  if (under) def.direction = "under";
  if (noData) def.noData = noData;
  if (notify.kind === "webhook") def.secret = `csh_whsec_${randomBytes(24).toString("hex")}`;

  await withAlertsLock(file, async () => {
    const doc = loadAlerts(file);
    if (doc.alerts.some((a) => a.name === name)) throw new CliError(`An alert named ${JSON.stringify(name)} exists`, { reason: "exists", exitCode: 2, next: ["Remove it first:", cliCommand(c.env, ["alert", "rm", name])] });
    doc.alerts.push(def);
    await saveAlerts(file, doc);
  });

  if (out.json) {
    const doc: { alert: AlertDef; secret?: string } = { alert: publicAlert(def) };
    if (def.secret) doc.secret = def.secret;
    out.data(doc);
    return 0;
  }
  const side = under ? "under" : "over";
  out.ok(`Added alert ${name}: ${measure} ${side} ${valueText(measure, over)}${warn !== undefined ? ` (warning ${side} ${valueText(measure, warn)})` : ""} in the last ${window}${by ? " per agent" : ""}, to ${targetText(notify)}`);
  if (def.secret) {
    out.print(`Signing secret (shown once): ${def.secret}`);
    for (const n of SIGNING_NOTES) out.note(n);
  }
  out.next("Send a test notification", cliCommand(c.env, ["alert", "test", name]));
  return 0;
}

function stateText(a: AlertDef): { state: string; value: string } {
  const groups = Object.entries(a.states);
  if (!groups.length) return { state: "-", value: "-" };
  if (!a.by) return { state: groups[0]![1].state, value: valueText(a.measure, groups[0]![1].value) };
  return { state: groups.map(([k, g]) => `${k}:${g.state}`).join(" "), value: groups.map(([k, g]) => `${k}:${valueText(a.measure, g.value)}`).join(" ") };
}

async function list(c: CommandContext, file: string): Promise<number> {
  const { out } = c;
  const doc = loadAlerts(file);
  if (out.json) {
    out.data({ alerts: doc.alerts.map((a) => ({ ...publicAlert(a), disabled: a.delivery.disabledAt !== undefined })) });
    return 0;
  }
  if (!doc.alerts.length) {
    out.note("No alerts yet");
    out.next("Add one", addExample(c.env));
    return 0;
  }
  out.table(
    ["NAME", "MEASURE", "ALERT AT", "WARN AT", "WINDOW", "BY", "STATE", "VALUE", "NOTIFY"],
    doc.alerts.map((a) => {
      const s = stateText(a);
      const target = targetText(a.notify) + (a.delivery.disabledAt !== undefined ? " (disabled)" : "");
      return [a.name, a.measure, thresholdText(a, a.over), a.warn === undefined ? "-" : thresholdText(a, a.warn), a.window, a.by ?? "-", s.state, s.value, target];
    }),
  );
  for (const a of doc.alerts) {
    if (a.delivery.disabledAt !== undefined) {
      out.warn(`${a.name}: notifications are off after ${MAX_FAILED_DELIVERIES} failed deliveries in a row (${a.delivery.lastError ?? "no error recorded"}). Fix the target, then run: ${cliCommand(c.env, ["alert", "test", a.name])}`);
    } else if (a.delivery.failures) out.warn(`${a.name}: the last ${plural(a.delivery.failures, "delivery", "deliveries")} failed (${a.delivery.lastError ?? "no error recorded"})`);
  }
  return 0;
}

async function rm(c: CommandContext, file: string): Promise<number> {
  const name = requireName(c);
  await withAlertsLock(file, async () => {
    const doc = loadAlerts(file);
    const i = doc.alerts.findIndex((a) => a.name === name);
    if (i === -1) throw notFound(c.env, name);
    doc.alerts.splice(i, 1);
    await saveAlerts(file, doc);
  });
  if (c.out.json) c.out.data({ removed: name });
  else c.out.ok(`Removed alert ${name}`);
  return 0;
}

function resultRows(r: AlertResult): string[][] {
  const threshold = (state: string) => thresholdText(r, state === "WARNING" && r.warn !== undefined ? r.warn : r.over);
  if (r.error) return [[r.name, "ERROR", "-", thresholdText(r, r.over), r.window, r.error]];
  if (!r.groups.length) return [[r.name, r.state, "-", threshold(r.state), r.window, ""]];
  return r.groups.map((g) => [g.agent !== undefined ? `${r.name} (${g.agent})` : r.name, g.state, valueText(r.measure, g.value), threshold(g.state), r.window, g.changed ? `was ${g.previous}` : ""]);
}

/** Exit 0 whatever the alerts say: a scheduler reads states from --json, not from the exit code. */
async function check(c: CommandContext, file: string): Promise<number> {
  const { out } = c;
  const fail = (message: string): number => {
    if (out.json) out.data({ alerts: [], error: message });
    else out.warn(`Alert check did not run: ${message}`);
    return 0;
  };
  let defs: AlertDef[];
  try {
    defs = loadAlerts(file).alerts;
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!defs.length) {
    if (out.json) out.data({ alerts: [] });
    else {
      out.note("No alerts to check");
      out.next("Add one", addExample(c.env));
    }
    return 0;
  }
  let results: AlertResult[];
  try {
    results = await withContext(
      c,
      async (ctx) => {
        await autoIngest(ctx, readIngest(c));
        return runAlertChecks({ file, index: ctx.index, signal: c.signal });
      },
      { create: false },
    );
  } catch (e) {
    if (e instanceof LockBusyError) return fail("another alert check or edit held alerts.json for 30 s");
    return fail((e as Error).message);
  }
  if (out.json) {
    out.data({ alerts: results });
    return 0;
  }
  out.table(["ALERT", "STATE", "VALUE", "THRESHOLD", "WINDOW", "CHANGE"], results.flatMap(resultRows));
  const sent = results.reduce((n, r) => n + r.notified, 0);
  if (sent) out.note(`Sent ${plural(sent, "notification")}.`);
  for (const r of results) {
    if (r.failed) out.warn(`${r.name}: ${plural(r.failed, "notification")} not delivered (${r.deliveryError ?? "no error recorded"})`);
    if (r.skipped || (r.disabled && r.failed)) out.warn(`${r.name}: notifications are off after ${MAX_FAILED_DELIVERIES} failed deliveries in a row. Fix the target, then run: ${cliCommand(c.env, ["alert", "test", r.name])}`);
    if (r.truncated) out.warn(`${r.name}: read only the first 100,000 sessions of the window`);
  }
  return 0;
}

async function test(c: CommandContext, file: string): Promise<number> {
  const { out } = c;
  const name = requireName(c);
  return withAlertsLock(file, async () => {
    const doc = loadAlerts(file);
    const def = doc.alerts.find((a) => a.name === name);
    if (!def) throw notFound(c.env, name);
    const now = Date.now();
    const [key, g] = Object.entries(def.states)[0] ?? ["", undefined];
    const state = g?.state ?? "OK";
    const group: { agent?: string; state: AlertState; previous: AlertState; value: number | null } = { state, previous: state, value: g?.value ?? null };
    if (def.by && key) group.agent = key;
    const payload = { ...payloadOf(def, group, now), test: true as const };
    const opts: DeliverOptions = { signal: c.signal };
    if (def.secret) opts.secret = def.secret;
    const d = await deliver(def.notify, payload, opts);
    if (!d.ok) throw new CliError(`Test notification to ${targetText(def.notify)} failed after ${plural(d.attempts, "try", "tries")}: ${d.error}`, { reason: "delivery_failed" });
    const wasDisabled = def.delivery.disabledAt !== undefined;
    recordDelivery(def, d, now);
    await saveAlerts(file, doc);
    if (out.json) out.data({ alert: name, delivered: true, attempts: d.attempts, reenabled: wasDisabled });
    else {
      out.ok(`Delivered a test notification to ${targetText(def.notify)}`);
      if (wasDisabled) out.note("Notifications are on again.");
    }
    return 0;
  });
}
