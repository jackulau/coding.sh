// coding.sh doctor: per agent, installed / hooked / last event age; then the
// hook bin (current with this CLI?), each registered MCP server (does its
// command exist?), the spool (writable), the store (opens, migrates; sessions
// with events but no row, rows whose fold failed), and the OTLP receiver port.
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { ADAPTERS, detectAll } from "../../adapters/index.ts";
import { mcpTargetOf, readMcpEntry } from "../../adapters/_shared/mcp.ts";
import type { Adapter } from "../../core/types.ts";
import { MCP_CONFIG_NAME } from "../../mcp/launch.ts";
import { proxyRoutes } from "../../proxy/install.ts";
import { pidAlive, probeProxy, readProxyState } from "../../proxy/state.ts";
import { hookBinHealth } from "../hookbin.ts";
import { openContext } from "../../core/context.ts";
import { FLAGS } from "../../core/sessions.ts";
import { paths, userHome } from "../../core/paths.ts";
import { allGatewayConfigs, detectGatewaySetups, gatewaySettings } from "../../integrations/gateway/config.ts";
import { GATEWAYS } from "../../integrations/gateway/providers.ts";
import { GATEWAY_FLAG } from "../../integrations/gateway/ids.ts";
import { UsageError } from "../args.ts";
import { list, port as portFlag } from "../common.ts";
import { ago, LABEL_WIDTH, plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { ingestStoppedField, readIngestStopped } from "../../core/ingest-health.ts";
import { blockingNotes, hookTarget, otherScopeHooks, pickAdapters } from "./init.ts";
import { ingestStoppedText } from "./status.ts";

/** Newest of the agent's spool files, and its mtime. */
function lastSpoolWrite(spool: string, agent: string): { file: string; mtimeMs: number } | undefined {
  const dir = join(spool, agent);
  if (!existsSync(dir)) return undefined;
  let newest: { file: string; mtimeMs: number } | undefined;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const m = statSync(join(dir, f)).mtimeMs;
    if (newest === undefined || m > newest.mtimeMs) newest = { file: join(dir, f), mtimeMs: m };
  }
  return newest;
}

/** Events this recent mean capture works, whatever the user config says. */
export const RECENT_EVENT_MS = 5 * 60_000;

/** Working directories named by the last lines of a spool file (the hook's cwd and the payload's). */
function spoolCwds(file: string, maxBytes = 64 * 1024): string[] {
  const out: string[] = [];
  try {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, maxBytes));
      readSync(fd, buf, 0, buf.length, size - buf.length);
      for (const line of buf.toString("utf8").split("\n").reverse()) {
        try {
          const l = JSON.parse(line) as { cwd?: unknown; raw?: { cwd?: unknown } };
          for (const c of [l.raw?.cwd, l.cwd]) if (typeof c === "string" && c) out.push(c);
        } catch {
          // a torn first or last line
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // unreadable spool: no hints
  }
  return out;
}

/** `dir` and its parents, stopping before the home directory and the filesystem root. */
function upward(dir: string, home: string): string[] {
  const out: string[] = [];
  for (let d = resolve(dir); d !== home && dirname(d) !== d; d = dirname(d)) out.push(d);
  return out;
}

/**
 * Project-level config files that hold this agent's coding.sh hooks
 * (`init --scope project`, or a hand-written `.claude/settings.local.json`),
 * looked for in `dirs` (deduped, at most 12). Found with the same dry-run
 * uninstall `init` uses, so every adapter with project scope is covered.
 */
export async function projectHookFiles(a: Adapter, dirs: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of [...new Set(dirs.map((d) => resolve(d)))].slice(0, 12)) {
    if (!existsSync(dir)) continue;
    const r = await otherScopeHooks(a, "user", dir, []);
    for (const f of r?.files ?? []) found.add(f);
  }
  return [...found];
}

/** A config file holding coding.sh hooks, as doctor read it. */
export interface HookFile {
  file: string;
  scope: "user" | "project";
  /** The hook.mjs its commands run, or null when no path could be read from the file. */
  hook: string | null;
  /** False only when the file runs a different hook.mjs than this coding.sh home's (another CODING_SH_HOME or HOME). */
  current: boolean;
}

/** The files in `scope` that hold this agent's coding.sh hooks: the same dry-run uninstall init uses. */
async function hookFilesIn(a: Adapter, scope: "user" | "project", projectDir: string, hook: string): Promise<HookFile[]> {
  let files: string[];
  try {
    files = [...new Set((await a.uninstall({ scope, projectDir, dryRun: true })).map((c) => resolve(c.path)))];
  } catch {
    return [];
  }
  const all = files.map((file) => ({ file, scope, ...hookTarget(file, hook) }));
  // The uninstall also names files without hooks (the MCP entry's): keep the ones that run a hook when any do.
  const withHook = all.filter((f) => f.hook !== null);
  return withHook.length ? withHook : all;
}

function spoolWritable(spool: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(spool, { recursive: true });
    accessSync(spool, constants.W_OK);
    const probe = join(spool, `.doctor-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** True when `cmd` names an existing file (absolute) or an executable on PATH. */
function commandExists(cmd: string, env: NodeJS.ProcessEnv): boolean {
  if (isAbsolute(cmd)) return existsSync(cmd);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").concat("") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, cmd + ext), constants.X_OK);
        return true;
      } catch {
        // keep looking
      }
    }
  }
  return false;
}

export interface McpCheck {
  agent: string;
  file: string;
  command: string;
  args: string[];
  ok: boolean;
  problem?: string;
}

/** The coding.sh MCP entry each agent has registered, and whether what it launches exists. */
export function checkMcpEntries(adapters: readonly Adapter[], env: NodeJS.ProcessEnv): McpCheck[] {
  const p = paths(env);
  const out: McpCheck[] = [];
  for (const a of adapters) {
    const t = mcpTargetOf(a, env);
    const entry = t && readMcpEntry(t, MCP_CONFIG_NAME);
    if (!t || !entry) continue;
    let problem: string | undefined;
    if (!commandExists(entry.command, env)) problem = `${entry.command} not found`;
    else {
      // Scripts it runs by absolute path (cli.mjs, the launcher) must still be there.
      const gone = entry.args.find((x) => isAbsolute(x) && /\.[cm]?js$/.test(x) && !existsSync(x));
      if (gone) problem = `${gone} not found`;
      else if (entry.args[0] === p.mcpLauncher) {
        const h = hookBinHealth(env);
        if (!h.cliPathExists) problem = h.cliPath ? `the launcher's CLI ${h.cliPath} is gone` : "the launcher has no cli-path";
      }
    }
    out.push({ agent: a.id, file: t.file, command: entry.command, args: entry.args, ok: !problem, ...(problem ? { problem } : {}) });
  }
  return out;
}

/** True when something accepts TCP connections on host:port. */
function listening(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Hooks that feed this coding.sh home: in the user config or a project file, running this home's hook.mjs. */
function hooksHere(a: { hooked: boolean; hookFiles: HookFile[] }): HookFile | true | undefined {
  const user = a.hookFiles.filter((f) => f.scope === "user");
  const here = a.hookFiles.find((f) => f.current);
  // Hooked in the user config with no file to read (an adapter whose dry-run uninstall names none): trust detect.
  return here ?? (a.hooked && !user.length ? true : undefined);
}

/** One agent as doctor reports it (the `agents` rows of --json). */
interface DoctorAgent {
  id: string;
  name: string;
  tier: Adapter["tier"];
  installed: boolean;
  version: string | null;
  /** coding.sh hooks in the agent's user config. */
  hooked: boolean;
  /** Project-level config files holding coding.sh hooks, looked for only when the user config has none. */
  projectHooks: string[];
  /** Every settings file doctor read holding its hooks (user config and projects), with the hook.mjs each runs and whether that is this home's (current). */
  hookFiles: HookFile[];
  /** Captured by reading the agent's own store (T3 Code), not by hooks. */
  store: boolean;
  /** How this agent is captured: its hooks, its own store, or the `coding.sh run --` wrapper (tier C: nothing to install). */
  capture: "hooks" | "store" | "wrapper";
  lastEventAt: string | null;
  lastEventAgeMs: number | null;
  notes: string[];
  /** What keeps its hooks from firing (agent too old, hooks disabled, not trusted yet), hooked or not. */
  blockers: string[];
}

/** A row doctor marks with "!": what is wrong, and the command that fixes it when one does. */
export interface DoctorWarning {
  check: "agent" | "agents" | "hook" | "mcp" | "sessions" | "ingest" | "proxy";
  agent?: string;
  message: string;
  /** For an agent: why its hooks will not fire, with the file and line to change when there is one. */
  blockers?: string[];
  next?: string;
}

/**
 * One agent's row: what it says, whether capture works, and the lines under it.
 * A hook-captured agent is ok only when hooks that run this home's hook.mjs are in a config
 * doctor read, that file exists, and nothing blocks them. Recent events alone are not capture:
 * they also come from an import, the proxy or a project doctor did not look in.
 */
function agentRow(a: DoctorAgent, hookInstalled: boolean): { state: string; ok: boolean; notes: string[] } {
  if (a.capture === "wrapper") return { state: `no hooks needed; capture with coding.sh run -- ${a.id === "wrapper" ? "<cmd>" : a.id}`, ok: true, notes: [] };
  const recent = a.lastEventAgeMs !== null && a.lastEventAgeMs < RECENT_EVENT_MS;
  if (a.store) return { state: a.hooked ? "reads its store" : "no store yet", ok: a.hooked || recent, notes: a.notes };
  const here = hooksHere(a);
  const elsewhere = a.hookFiles.find((f) => !f.current);
  const where = (f: HookFile) => `${f.file}${f.scope === "project" ? " (project)" : ""}`;
  const more = (n: number) => (n > 1 ? ` and ${n - 1} more` : "");
  const state =
    here !== undefined && a.blockers.length ? "hooked but not firing"
    : here !== undefined ? `hooked${here === true ? "" : ` in ${where(here)}${more(a.hookFiles.filter((f) => f.current).length)}`}${hookInstalled ? "" : ", but the hook it runs is missing"}`
    : elsewhere ? `hooks in ${where(elsewhere)} run ${elsewhere.hook}, not this home's hook`
    : recent ? "events arriving, hook not in user config" : "not hooked";
  return { state, ok: here !== undefined && hookInstalled && a.blockers.length === 0, notes: a.blockers };
}

export async function run(c: CommandContext): Promise<number> {
  if (c.flags.conformance) return (await import("../../conformance/doctor.ts")).runConformance(c);
  for (const f of ["since", "max-events"]) if (c.flags[f] !== undefined) throw new UsageError(`--${f} works only with --conformance`, { suggestion: `coding.sh doctor --conformance --${f} ${String(c.flags[f])}` });
  const { out, env } = c;
  const named = list(c.flags.agent);
  const port = portFlag(c.flags.port, 4318);
  const p = paths(env);

  const spin = out.spin("Checking agents…");
  const detected = await detectAll(named.length ? pickAdapters(named) : ADAPTERS);
  spin.stop();

  // Store: opens and answers a query.
  const store: {
    ok: boolean;
    kind?: string;
    url?: string;
    error?: string;
    lastEventAt?: Record<string, number>;
    /** Sessions with stored events and no row, by agent: invisible to sessions, the viewer and stats until `coding.sh ingest` folds them. Unset when the store can't tell. */
    missingRows?: { count: number; byAgent: Record<string, number> };
    /** Rows tagged fold:error (Session.stats.foldError). */
    foldErrors?: number;
  } = { ok: false };
  const lastByAgent: Record<string, number> = {};
  // Where the agent's recent sessions ran: project-level hooks are looked for there.
  const cwdsByAgent: Record<string, string[]> = {};
  let gatewaySessions = 0;
  try {
    const ctx = await openContext({ env, cwd: c.cwd });
    try {
      store.kind = ctx.index.kind;
      store.url = ctx.config.store.index;
      for (const { adapter } of detected) {
        const recent = await ctx.index.listSessions({ agent: adapter.id, limit: 5 });
        const s = recent[0];
        if (s) lastByAgent[adapter.id] = s.endedAt ?? s.startedAt;
        cwdsByAgent[adapter.id] = recent.map((r) => r.cwd).filter((d): d is string => !!d);
      }
      gatewaySessions = (await ctx.index.listSessions({ flag: GATEWAY_FLAG, limit: 1000 })).length;
      const missing = await ctx.index.sessionsWithoutRow?.();
      if (missing) {
        const byAgent: Record<string, number> = {};
        for (const m of missing) byAgent[m.agent] = (byAgent[m.agent] ?? 0) + 1;
        store.missingRows = { count: missing.length, byAgent };
      }
      store.foldErrors = (await ctx.index.listSessions({ flag: FLAGS.foldError })).length;
      store.ok = true;
    } finally {
      await ctx.close();
    }
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
  }

  // After an update the bin can lag the CLI (stale hook.mjs, cli-path naming an old install).
  const health = hookBinHealth(env);
  const hookBin = { path: p.hook, installed: existsSync(p.hook), ...health, stale: existsSync(p.hook) && (health.hookCurrent === false || health.cliPathCurrent === false || (health.cliPath !== null && !health.cliPathExists)) };
  const home = resolve(userHome(env));
  const agents: DoctorAgent[] = [];
  for (const { adapter, result } of detected) {
    const newest = lastSpoolWrite(p.spool, adapter.id);
    const indexed = lastByAgent[adapter.id];
    const last = Math.max(newest?.mtimeMs ?? 0, indexed ?? 0) || undefined;
    const capture: DoctorAgent["capture"] = adapter.tail !== undefined ? "store" : adapter.tier === "C" ? "wrapper" : "hooks";
    // No hook in the user config: look for one in the projects the agent ran in
    // (Claude Code also reads <project>/.claude/settings.json and settings.local.json).
    const shown = result.installed || named.includes(adapter.id);
    const dirs = shown && capture === "hooks" && !result.hooked ? [...upward(c.cwd, home), ...(newest ? spoolCwds(newest.file) : []), ...(cwdsByAgent[adapter.id] ?? [])] : [];
    const projectHooks = dirs.length ? await projectHookFiles(adapter, dirs) : [];
    // Which settings file each hook lives in, and whether it runs this home's hook.mjs
    // (a project file written under another HOME or CODING_SH_HOME feeds that home, not this one).
    const hookFiles: HookFile[] =
      capture !== "hooks" || !shown ? []
      : [...(result.hooked ? await hookFilesIn(adapter, "user", c.cwd, p.hook) : []), ...projectHooks.map((file): HookFile => ({ file, scope: "project", ...hookTarget(file, p.hook) }))];
    agents.push({
      id: adapter.id,
      name: adapter.displayName,
      tier: adapter.tier,
      installed: result.installed,
      version: result.version ?? null,
      // coding.sh hooks in the agent's user config.
      hooked: result.hooked,
      // Project-level config files holding coding.sh hooks, looked for only when the user config has none.
      projectHooks,
      // Every settings file doctor read holding its hooks (user config and projects), with the hook.mjs each runs and whether that is this home's (current).
      hookFiles,
      // Captured by reading the agent's own store (T3 Code), not by hooks.
      store: adapter.tail !== undefined,
      // How this agent is captured: its hooks, its own store, or the `coding.sh run --` wrapper (tier C: nothing to install).
      capture,
      lastEventAt: last !== undefined ? new Date(last).toISOString() : null,
      lastEventAgeMs: last !== undefined ? Date.now() - last : null,
      notes: result.notes ?? [],
      // Hooks will not fire (agent too old, hooks disabled, not trusted yet):
      // "hooked" alone would read as working capture.
      blockers: blockingNotes(result.notes),
    });
  }

  const spool = { path: p.spool, ...spoolWritable(p.spool) };
  const mcp = checkMcpEntries(
    detected.filter((d) => d.result.installed || named.includes(d.adapter.id)).map((d) => d.adapter),
    env,
  );
  const receiver = { port, listening: await listening(port) };
  // The model API proxy: running or not, and the agents init --proxy routed through it.
  const ps = readProxyState(env);
  const proxyUp = !!ps && pidAlive(ps.pid) && (await probeProxy(ps.url)) !== undefined;
  const proxy = {
    running: proxyUp,
    ...(proxyUp ? { url: ps!.url, pid: ps!.pid } : {}),
    routes: proxyRoutes(env).map((r) => ({ agent: r.agent, file: r.file, url: r.url ?? null, ok: r.url === r.expected, chained: r.chained ?? null })),
  };
  const problems = (spool.ok ? 0 : 1) + (store.ok ? 0 : 1);
  // LLM gateways: read-only config scan; keys are reported as set or not, never shown.
  // `key` and `sessions` are Vercel AI Gateway's; `others` lists other gateways with a key set.
  const gs = gatewaySettings(env);
  const others = allGatewayConfigs(env)
    .filter((g) => g.id !== "vercel" && g.apiKey)
    .map((g) => ({ id: g.id, key: { set: true, source: g.keySource } }));
  const gateway = { configured: detectGatewaySetups(env, c.cwd), key: gs.apiKey ? { set: true, source: gs.keySource } : { set: false, env: gs.apiKeyEnv }, sessions: gatewaySessions, others };

  // The rows below print nothing with --json (the document is the answer); every "!" row is also a warning in it.
  const warnings: DoctorWarning[] = [];
  const warn = (label: string, value: string, w: DoctorWarning) => {
    warnings.push(w);
    out.row(label, value, "warn");
  };
  const shown = agents.filter((a) => a.installed || named.includes(a.id));
  let notCapturing = 0;
  for (const a of shown) {
    const r = agentRow(a, hookBin.installed);
    // The built-in wrapper is not something "installed": it is part of coding.sh.
    const parts = a.id === "wrapper" ? [r.state] : [a.version ? `v${a.version}` : "installed", r.state];
    if (a.lastEventAt) {
      parts.push(`last event ${ago(Date.parse(a.lastEventAt))}`);
    } else parts.push(a.capture === "wrapper" ? "no runs yet" : "no events yet");
    // "Any command (coding.sh run --)" reads better as "Any command" than cut off.
    const label = a.name.length >= LABEL_WIDTH ? a.name.replace(/\s*\(.*\)$/, "") : a.name;
    if (r.ok) out.row(label, parts.join(", "), "ok");
    else {
      notCapturing++;
      const hooks = a.capture === "hooks";
      const w: DoctorWarning = { check: "agent", agent: a.id, message: `${a.name} is not capturing: ${r.state}` };
      if (hooks && a.blockers.length) w.blockers = a.blockers;
      if (hooks && hooksHere(a) === undefined) w.next = `coding.sh init --agent ${a.id}`;
      warn(label, parts.join(", "), w);
    }
    // Every blocker, hooked or not: each names what to change.
    for (const n of r.notes) out.note(n);
  }
  if (!shown.length) warn("Agents", "none detected; capture any agent with coding.sh run -- <cmd>", { check: "agents", message: "No agent detected", next: "coding.sh run -- <cmd>" });
  if (!hookBin.installed) warn("Hook", `missing at ${hookBin.path}; run coding.sh init`, { check: "hook", message: `The hook is missing at ${hookBin.path}`, next: "coding.sh init" });
  else if (hookBin.stale) {
    const why = hookBin.hookCurrent === false ? "differs from the hook this CLI ships" : hookBin.cliPath && !hookBin.cliPathExists ? `cli-path names a missing ${hookBin.cliPath}` : `cli-path names ${hookBin.cliPath ?? "nothing"}, not this CLI`;
    // Only the bin lags: refreshing it leaves the agent configs alone (init would rewrite them).
    warn("Hook", `${hookBin.path} is stale (${why}); run coding.sh update --refresh-bin`, { check: "hook", message: `${hookBin.path} is stale (${why})`, next: "coding.sh update --refresh-bin" });
  } else out.row("Hook", hookBin.path, "ok");
  for (const m of mcp.filter((x) => !x.ok)) warn("MCP", `${m.agent}: ${m.problem} (${m.file}); run coding.sh init`, { check: "mcp", agent: m.agent, message: `${m.problem} (${m.file})`, next: "coding.sh init" });
  out.row("Spool", spool.ok ? `${spool.path} writable` : `${spool.path} not writable: ${spool.error}`, spool.ok ? "ok" : "fail");
  out.row("Store", store.ok ? `${store.kind} ${store.url}` : `can't open: ${store.error}`, store.ok ? "ok" : "fail");
  // The ingest the hook starts runs unseen: a failed one leaves a marker (core/ingest-health.ts).
  const stopped = readIngestStopped(p.ingestStopped);
  if (stopped) {
    const message = `Ingest ${ingestStoppedText(stopped)}`;
    warn("Ingest", ingestStoppedText(stopped), { check: "ingest", message, next: stopped.next });
  }
  const missing = store.missingRows;
  if (missing?.count) {
    const byAgent = Object.entries(missing.byAgent).sort((a, b) => b[1] - a[1]).map(([agent, n]) => `${agent} ${n}`);
    const message = `${plural(missing.count, "session")} ${missing.count === 1 ? "has" : "have"} events but no session row (${byAgent.join(", ")})`;
    warn("Sessions", `${message}; run coding.sh ingest`, { check: "sessions", message, next: "coding.sh ingest" });
  }
  if (store.foldErrors) {
    const message = `${plural(store.foldErrors, "session")} could not be folded (tagged ${FLAGS.foldError})`;
    warn("Sessions", `${message}; update coding.sh, then run coding.sh ingest`, { check: "sessions", message, next: "coding.sh ingest" });
  }
  out.row("Receiver", receiver.listening ? `port ${port} in use (collector running?)` : `port ${port} free; start with coding.sh collector`, receiver.listening ? "ok" : "none");
  const routedNames = proxy.routes.filter((r) => r.ok).map((r) => `${ADAPTERS.find((a) => a.id === r.agent)?.displayName ?? r.agent}${r.chained ? ` (then ${r.chained})` : ""}`);
  if (proxy.running) out.row("Proxy", `${proxy.url} (pid ${proxy.pid})${routedNames.length ? `, routes ${routedNames.join(", ")}` : ""}`, "ok");
  else if (routedNames.length) {
    const message = `not running, but ${routedNames.join(" and ")} call it`;
    warn("Proxy", `${message}; it restarts on the next session start, or now with coding.sh proxy --background`, { check: "proxy", message: `The proxy is ${message}`, next: "coding.sh proxy --background" });
  }
  else out.row("Proxy", "not running; route agents through it with coding.sh init --proxy", "none");
  for (const r of proxy.routes.filter((x) => !x.ok)) {
    const message = `${r.agent} no longer points at the proxy (${r.file})`;
    warn("Proxy", `${message}; with the user's approval, coding.sh init --proxy or coding.sh uninstall --proxy`, { check: "proxy", agent: r.agent, message });
  }
  const routed = [...new Set(gateway.configured.filter((f) => f.active).map((f) => (f.gateway === "vercel" ? f.agent : `${f.agent} via ${f.gateway}`)))];
  const gwParts = [routed.length ? `routes ${routed.join(", ")}` : "not configured", gateway.key.set ? `key set (${gateway.key.source})` : "no key", `${gateway.sessions >= 1000 ? "1000+" : gateway.sessions} tagged sessions`];
  out.row("AI Gateway", gwParts.join(", "), routed.length || gateway.key.set || gateway.sessions ? "ok" : "none");
  if (others.length) out.row("Gateways", `keys set for ${others.map((g) => GATEWAYS[g.id].name).join(", ")}`, "ok");
  for (const f of gateway.configured) out.note(`${f.gateway === "vercel" ? "" : `${GATEWAYS[f.gateway].name}: `}${f.detail} (${f.where}${f.active ? "" : ", not selected"})`);
  const unhooked = shown.filter((a) => a.capture === "hooks" && hooksHere(a) === undefined);
  if (unhooked.length) out.next("Capture the agents without hooks", `coding.sh init ${unhooked.map((a) => `--agent ${a.id}`).join(" ")}`);
  // `ok` and the exit code are about the spool and the store, so a script that checks them keeps
  // working; an agent that cannot capture is in `warnings` and on the last line.
  out.data({ ok: problems === 0, warnings, agents, hook: hookBin, mcp, spool, store, ...ingestStoppedField(stopped), receiver, proxy, gateway });
  out.print(problems ? "problems found" : notCapturing ? `${plural(notCapturing, "agent")} not capturing` : "ok");
  return problems ? 1 : 0;
}
