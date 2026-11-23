// coding.sh monitor add|list|rm|run: score new sessions automatically.
//
//   coding.sh monitor add tests-pass --run "node check.mjs"
//   coding.sh monitor add helpful --judge rubric.md --where 'agent:claude-code' --sample 0.2
//   coding.sh monitor add review --http https://evals.example.com/score
//   coding.sh monitor list --json
//   coding.sh monitor run helpful --since 7d
//
// Monitors run after each `coding.sh ingest`, in the viewer's ingest loop and
// in serve's writer (src/monitor/run.ts). Their definitions and state are in
// <CODING_SH_HOME>/monitors.json.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseSince, UsageError } from "../args.ts";
import { num, str, withContext } from "../common.ts";
import { ago, CliError, plural, usd } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { SIGNING_NOTES } from "../../alerts/notify.ts";
import { paths } from "../../core/paths.ts";
import { sleepUnless } from "../../jobs/retry.ts";
import { parseWhere } from "../../query/where.ts";
import { judgeProviderKind, KEY_ENV, NO_PROVIDER, runMonitors, type MonitorResult, type RunMonitorsResult } from "../../monitor/run.ts";
import { MONITOR_PROVIDERS, NAME_RE, publicMonitor, readMonitors, shownUrl, spentToday, updateMonitors, type MonitorDef, type MonitorProvider } from "../../monitor/state.ts";

export async function run(c: CommandContext): Promise<number> {
  switch (c.action) {
    case "add":
      return add(c);
    case "list":
      return list(c);
    case "rm":
      return rm(c);
    case "run":
      return runNow(c);
    default:
      throw new UsageError("monitor needs an action: add, list, rm or run", { reason: "bad_arg" });
  }
}

function checkName(name: string | undefined): string {
  if (!name) throw new UsageError("monitor add needs a name, e.g. coding.sh monitor add helpful --judge rubric.md", { reason: "bad_arg" });
  if (!NAME_RE.test(name)) throw new UsageError(`monitor name ${JSON.stringify(name)}: use 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit`, { reason: "bad_arg" });
  return name;
}

async function add(c: CommandContext): Promise<number> {
  const name = checkName(c.positionals[0]);
  const judge = str(c.flags.judge);
  const command = str(c.flags.run);
  const url = str(c.flags.http);
  const kinds = [judge, command, url].filter((x) => x !== undefined).length;
  if (kinds > 1) throw new UsageError("monitor add takes one of --judge, --run or --http: a monitor scores with a rubric, a command or an evaluator service", { reason: "bad_arg" });
  if (!kinds) throw new UsageError("monitor add needs one of --judge <rubric.md>, --run \"<command>\" or --http <URL>", { reason: "bad_arg" });
  if (url !== undefined) checkUrl(url);
  const where = str(c.flags.where);
  if (where !== undefined) {
    try {
      parseWhere(where);
    } catch (e) {
      throw new UsageError(`--where: ${(e as Error).message}`, { reason: "bad_query" });
    }
  }
  const sample = num(c.flags.sample);
  if (sample !== undefined && !(sample >= 0 && sample <= 1)) throw new UsageError("--sample takes a fraction from 0 to 1, e.g. 0.2", { reason: "bad_arg" });
  const maxUsdDay = num(c.flags["max-usd-day"]) ?? 1;
  if (!(maxUsdDay >= 0) || !Number.isFinite(maxUsdDay)) throw new UsageError("--max-usd-day takes a dollar amount, e.g. 2.5", { reason: "bad_arg" });
  const provider = str(c.flags.provider) as MonitorProvider | undefined;
  if (provider !== undefined && !(MONITOR_PROVIDERS as readonly string[]).includes(provider)) throw new UsageError(`--provider: one of ${MONITOR_PROVIDERS.join(", ")}`, { reason: "bad_arg" });
  const model = str(c.flags.model);
  if (!judge && (provider || model)) throw new UsageError("--provider and --model go with --judge", { reason: "bad_arg" });
  const def: MonitorDef = { name, kind: judge ? "judge" : url !== undefined ? "http" : "run", cwd: c.cwd, maxUsdDay, createdAt: Date.now() };
  if (judge) {
    const file = resolve(c.cwd, judge);
    if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`--judge: no rubric file at ${judge}`, { reason: "not_found" });
    if (!readFileSync(file, "utf8").trim()) throw new UsageError(`--judge: ${judge} is empty; write the rubric the judge scores against`, { reason: "bad_arg" });
    def.rubric = file;
    if (provider) def.provider = provider;
    if (model) def.model = model;
  } else if (url !== undefined) {
    def.url = url;
    def.secret = randomBytes(32).toString("hex");
  } else def.command = command!;
  if (where !== undefined) def.where = where;
  if (sample !== undefined) def.sample = sample;
  const file = paths(c.env).monitors;
  const replaced = await updateMonitors(file, (doc) => {
    const prev = doc.monitors.findIndex((m) => m.name === name);
    if (prev >= 0 && c.flags.force !== true) return { result: undefined as boolean | undefined };
    if (prev >= 0) doc.monitors.splice(prev, 1, def);
    else doc.monitors.push(def);
    return { doc, result: prev >= 0 };
  });
  if (replaced === undefined) {
    throw new CliError(`monitor ${name} exists`, { reason: "conflict", askUser: true, next: ["Replace it (its cursor starts again; its scores stay):", `coding.sh monitor add ${name} ... --force`] });
  }
  const noProvider = def.kind === "judge" && !judgeProviderKind(def, c.env);
  if (c.out.json) {
    const data: Record<string, unknown> = { monitor: publicMonitor(def), replaced };
    if (def.secret) data.secret = def.secret;
    if (noProvider) data.warning = NO_PROVIDER;
    c.out.data(data);
    return 0;
  }
  c.out.ok(`${replaced ? "Replaced" : "Added"} monitor ${name}`);
  if (def.secret) {
    c.out.print(`Signing secret (shown once): ${def.secret}`);
    for (const n of SIGNING_NOTES) c.out.note(n);
  }
  if (noProvider) {
    const keys = Object.values(KEY_ENV);
    c.out.warn(def.provider ? `No judge provider: set ${KEY_ENV[def.provider]} for --provider ${def.provider}` : `No judge provider: set ${keys.slice(0, -1).join(", ")} or ${keys[keys.length - 1]}, or pass --provider`);
  }
  c.out.note("It scores sessions that end from now on, after each coding.sh ingest, in the viewer and in serve (sessions from the past day on its first run).");
  c.out.next("Score the past week now", `coding.sh monitor run ${name} --since 7d`);
  return 0;
}

/** --http: an http or https URL, with no user name or password in it (the secret signs the request instead). */
function checkUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`--http takes an http or https URL, got ${JSON.stringify(raw)}`, { reason: "bad_arg" });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`--http takes an http or https URL, got ${JSON.stringify(u.protocol)}`, { reason: "bad_arg" });
  if (u.username || u.password) throw new UsageError("--http: put no credentials in the URL; check the signature header the monitor sends instead", { reason: "bad_arg" });
}

function describe(m: MonitorDef): string {
  return m.kind === "run" ? `run: ${m.command}` : m.kind === "http" ? `http: ${shownUrl(m.url!)}` : `judge: ${m.rubric}`;
}

async function list(c: CommandContext): Promise<number> {
  const doc = readMonitors(paths(c.env).monitors);
  const now = Date.now();
  if (c.out.json) {
    c.out.data({ monitors: doc.monitors.map((m) => ({ ...publicMonitor(m), spentToday: spentToday(m, now) })) });
    return 0;
  }
  if (!doc.monitors.length) {
    c.out.note("No monitors yet");
    c.out.next("Score every new session with a command", 'coding.sh monitor add tests-pass --run "node check.mjs"');
    return 0;
  }
  c.out.table(
    ["NAME", "SCORES WITH", "WHERE", "SAMPLE", "SCORED", "LAST RUN", "LAST ERROR"],
    doc.monitors.map((m) => [
      m.name,
      describe(m),
      m.where ?? "",
      m.sample !== undefined ? String(m.sample) : "all",
      String(m.scored ?? 0) + (m.kind === "judge" ? ` (${usd(spentToday(m, now))}/${usd(m.maxUsdDay)} today)` : ""),
      m.lastRunAt ? ago(m.lastRunAt) : "never",
      m.lastError ? `${m.lastError.message} (${ago(m.lastError.at)})` : "",
    ]),
  );
  return 0;
}

async function rm(c: CommandContext): Promise<number> {
  const name = c.positionals[0];
  if (!name) throw new UsageError("monitor rm needs a name; coding.sh monitor list shows them", { reason: "bad_arg" });
  const removed = await updateMonitors(paths(c.env).monitors, (doc) => {
    const i = doc.monitors.findIndex((m) => m.name === name);
    if (i < 0) return { result: false };
    doc.monitors.splice(i, 1);
    return { doc, result: true };
  });
  if (!removed) throw new CliError(`no monitor named ${name}`, { reason: "not_found", next: ["List monitors:", "coding.sh monitor list"] });
  if (c.out.json) c.out.data({ removed: name });
  else c.out.ok(`Removed monitor ${name} (its scores stay)`);
  return 0;
}

async function runNow(c: CommandContext): Promise<number> {
  const file = paths(c.env).monitors;
  const name = c.positionals[0];
  const doc = readMonitors(file);
  if (name && !doc.monitors.some((m) => m.name === name)) throw new CliError(`no monitor named ${name}`, { reason: "not_found", next: ["List monitors:", "coding.sh monitor list"] });
  if (!doc.monitors.length) throw new CliError("no monitors yet", { reason: "not_found", next: ["Add one:", 'coding.sh monitor add tests-pass --run "node check.mjs"'] });
  let since: number | undefined;
  try {
    since = parseSince(str(c.flags.since) ?? "1d");
  } catch (e) {
    throw new UsageError((e as Error).message, { reason: "bad_arg" });
  }
  const watch = c.flags.watch === true;
  return withContext(c, async (ctx) => {
    let failed = false;
    for (let first = true; first || (watch && !c.signal.aborted); first = false) {
      if (!first) {
        if (await sleepUnless(10_000, [c.signal])) break;
        // Pick up what agents wrote since the last pass, then score it.
        await ctx.ingest({ lock: { waitMs: 0 }, signal: c.signal }).catch(() => undefined);
      }
      // --watch passes after the first take sessions that ended after each cursor.
      const r = await runMonitors(ctx, { force: true, all: true, signal: c.signal, since: first ? since : undefined, names: name ? [name] : undefined });
      failed = report(c, r, watch) || failed;
    }
    return failed && !watch ? 1 : 0;
  });
}

/** Prints one pass; true when a monitor failed. */
function report(c: CommandContext, r: RunMonitorsResult, watch: boolean): boolean {
  if (c.out.json) {
    c.out.data(watch ? { ts: Date.now(), ...r } : r);
    return r.monitors.some((m) => m.error !== undefined);
  }
  if (r.busy) {
    c.out.warn("Another process is running the monitors; try again in a minute");
    return false;
  }
  for (const m of r.monitors) line(c, m);
  return r.monitors.some((m) => m.error !== undefined);
}

function line(c: CommandContext, m: MonitorResult): void {
  const parts = [plural(m.scored, "session") + " scored"];
  if (m.skipped) parts.push(`${m.skipped} already scored or empty`);
  if (m.sampledOut) parts.push(`${m.sampledOut} left out by --sample`);
  if (m.failed) parts.push(`${m.failed} failed`);
  c.out.row(m.name, parts.join(", "), m.error ? "warn" : "ok");
  if (m.error) c.out.note(`${m.name}: ${m.error}`);
}
