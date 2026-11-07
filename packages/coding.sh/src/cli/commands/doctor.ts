// coding.sh doctor: per agent, installed / hooked / last event age; then the
// hook bin (current with this CLI?), each registered MCP server (does its
// command exist?), the spool (writable), the store (opens, migrates), and the
// OTLP receiver port.
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { ADAPTERS, detectAll } from "../../adapters/index.ts";
import { mcpTargetOf, readMcpEntry } from "../../adapters/_shared/mcp.ts";
import type { Adapter } from "../../core/types.ts";
import { MCP_CONFIG_NAME } from "../../mcp/launch.ts";
import { hookBinHealth } from "../hookbin.ts";
import { openContext } from "../../core/context.ts";
import { paths, userHome } from "../../core/paths.ts";
import { allGatewayConfigs, detectGatewaySetups, gatewaySettings } from "../../integrations/gateway/config.ts";
import { GATEWAYS } from "../../integrations/gateway/providers.ts";
import { GATEWAY_FLAG } from "../../integrations/gateway/ids.ts";
import { list, port as portFlag } from "../common.ts";
import { ago, LABEL_WIDTH } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { blockingNotes, otherScopeHooks, pickAdapters } from "./init.ts";

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

/** Not hooked in the user config, but captured anyway: project-level hooks, or events within the last few minutes. */
function capturing(a: { projectHooks: string[]; lastEventAgeMs: number | null }): boolean {
  return a.projectHooks.length > 0 || (a.lastEventAgeMs !== null && a.lastEventAgeMs < RECENT_EVENT_MS);
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const named = list(c.flags.agent);
  const port = portFlag(c.flags.port, 4318);
  const p = paths(env);

  const spin = out.spin("Checking agents…");
  const detected = await detectAll(named.length ? pickAdapters(named) : ADAPTERS);
  spin.stop();

  // Store: opens and answers a query.
  const store: { ok: boolean; kind?: string; url?: string; error?: string; lastEventAt?: Record<string, number> } = { ok: false };
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
      store.ok = true;
    } finally {
      await ctx.close();
    }
  } catch (e) {
    store.error = e instanceof Error ? e.message : String(e);
  }

  const home = resolve(userHome(env));
  const agents = [];
  for (const { adapter, result } of detected) {
    const newest = lastSpoolWrite(p.spool, adapter.id);
    const indexed = lastByAgent[adapter.id];
    const last = Math.max(newest?.mtimeMs ?? 0, indexed ?? 0) || undefined;
    const capture = adapter.tail !== undefined ? "store" : adapter.tier === "C" ? "wrapper" : "hooks";
    // No hook in the user config: look for one in the projects the agent ran in
    // (Claude Code also reads <project>/.claude/settings.json and settings.local.json).
    const shown = result.installed || named.includes(adapter.id);
    const dirs = shown && capture === "hooks" && !result.hooked ? [...upward(c.cwd, home), ...(newest ? spoolCwds(newest.file) : []), ...(cwdsByAgent[adapter.id] ?? [])] : [];
    const projectHooks = dirs.length ? await projectHookFiles(adapter, dirs) : [];
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
      // Captured by reading the agent's own store (T3 Code), not by hooks.
      store: adapter.tail !== undefined,
      // How this agent is captured: its hooks, its own store, or the `coding.sh run --` wrapper (tier C: nothing to install).
      capture,
      lastEventAt: last !== undefined ? new Date(last).toISOString() : null,
      lastEventAgeMs: last !== undefined ? Date.now() - last : null,
      notes: result.notes ?? [],
      // Hooks are installed but will not fire (agent too old, hooks disabled,
      // not trusted yet): "hooked" alone would read as working capture.
      blockers: blockingNotes(result.notes),
    });
  }

  const spool = { path: p.spool, ...spoolWritable(p.spool) };
  // After an update the bin can lag the CLI (stale hook.mjs, cli-path naming an old install).
  const health = hookBinHealth(env);
  const hookBin = { path: p.hook, installed: existsSync(p.hook), ...health, stale: existsSync(p.hook) && (health.hookCurrent === false || health.cliPathCurrent === false || (health.cliPath !== null && !health.cliPathExists)) };
  const mcp = checkMcpEntries(
    detected.filter((d) => d.result.installed || named.includes(d.adapter.id)).map((d) => d.adapter),
    env,
  );
  const receiver = { port, listening: await listening(port) };
  const problems = (spool.ok ? 0 : 1) + (store.ok ? 0 : 1);
  // LLM gateways: read-only config scan; keys are reported as set or not, never shown.
  // `key` and `sessions` are Vercel AI Gateway's; `others` lists other gateways with a key set.
  const gs = gatewaySettings(env);
  const others = allGatewayConfigs(env)
    .filter((g) => g.id !== "vercel" && g.apiKey)
    .map((g) => ({ id: g.id, key: { set: true, source: g.keySource } }));
  const gateway = { configured: detectGatewaySetups(env, c.cwd), key: gs.apiKey ? { set: true, source: gs.keySource } : { set: false, env: gs.apiKeyEnv }, sessions: gatewaySessions, others };

  if (out.json) {
    out.data({ ok: problems === 0, agents, hook: hookBin, mcp, spool, store, receiver, gateway });
    return problems ? 1 : 0;
  }

  const shown = agents.filter((a) => a.installed || named.includes(a.id));
  for (const a of shown) {
    const wrapper = a.capture === "wrapper";
    // The built-in wrapper is not something "installed": it is part of coding.sh.
    const parts = a.id === "wrapper" ? [] : [a.version ? `v${a.version}` : "installed"];
    const blocked = !a.store && a.hooked && a.blockers.length > 0;
    const captured = capturing(a);
    parts.push(
      a.store ? (a.hooked ? "reads its store" : "no store yet")
      : wrapper ? `no hooks needed; capture with coding.sh run -- ${a.id === "wrapper" ? "<cmd>" : a.id}`
      : blocked ? "hooked but not firing" : a.hooked ? "hooked"
      : a.projectHooks.length ? `hooked in ${a.projectHooks[0]} (project)${a.projectHooks.length > 1 ? ` and ${a.projectHooks.length - 1} more` : ""}`
      : captured ? "events arriving, hook not in user config" : "not hooked",
    );
    if (a.lastEventAt) {
      parts.push(`last event ${ago(Date.parse(a.lastEventAt))}`);
    } else parts.push(wrapper ? "no runs yet" : "no events yet");
    // "Any command (coding.sh run --)" reads better as "Any command" than cut off.
    const label = a.name.length >= LABEL_WIDTH ? a.name.replace(/\s*\(.*\)$/, "") : a.name;
    out.row(label, parts.join(", "), wrapper || (a.hooked && !blocked) || (!a.hooked && captured) ? "ok" : "warn");
    if (a.store) for (const n of a.notes) out.note(n);
    else if (blocked) for (const n of a.blockers) out.note(n);
  }
  if (!shown.length) out.row("Agents", "none detected; capture any agent with coding.sh run -- <cmd>", "warn");
  if (!hookBin.installed) out.row("Hook", `missing at ${hookBin.path}; run coding.sh init`, "warn");
  else if (hookBin.stale) {
    const why = hookBin.hookCurrent === false ? "differs from the hook this CLI ships" : hookBin.cliPath && !hookBin.cliPathExists ? `cli-path names a missing ${hookBin.cliPath}` : `cli-path names ${hookBin.cliPath ?? "nothing"}, not this CLI`;
    // Only the bin lags: refreshing it leaves the agent configs alone (init would rewrite them).
    out.row("Hook", `${hookBin.path} is stale (${why}); run coding.sh update --refresh-bin`, "warn");
  } else out.row("Hook", hookBin.path, "ok");
  for (const m of mcp.filter((x) => !x.ok)) out.row("MCP", `${m.agent}: ${m.problem} (${m.file}); run coding.sh init`, "warn");
  out.row("Spool", spool.ok ? `${spool.path} writable` : `${spool.path} not writable: ${spool.error}`, spool.ok ? "ok" : "fail");
  out.row("Store", store.ok ? `${store.kind} ${store.url}` : `can't open: ${store.error}`, store.ok ? "ok" : "fail");
  out.row("Receiver", receiver.listening ? `port ${port} in use (collector running?)` : `port ${port} free; start with coding.sh collector`, receiver.listening ? "ok" : "none");
  const routed = [...new Set(gateway.configured.filter((f) => f.active).map((f) => (f.gateway === "vercel" ? f.agent : `${f.agent} via ${f.gateway}`)))];
  const gwParts = [routed.length ? `routes ${routed.join(", ")}` : "not configured", gateway.key.set ? `key set (${gateway.key.source})` : "no key", `${gateway.sessions >= 1000 ? "1000+" : gateway.sessions} tagged sessions`];
  out.row("AI Gateway", gwParts.join(", "), routed.length || gateway.key.set || gateway.sessions ? "ok" : "none");
  if (others.length) out.row("Gateways", `keys set for ${others.map((g) => GATEWAYS[g.id].name).join(", ")}`, "ok");
  for (const f of gateway.configured) out.note(`${f.gateway === "vercel" ? "" : `${GATEWAYS[f.gateway].name}: `}${f.detail} (${f.where}${f.active ? "" : ", not selected"})`);
  const unhooked = shown.filter((a) => a.capture === "hooks" && !a.hooked && !capturing(a));
  if (unhooked.length) out.next("Capture the agents without hooks", `coding.sh init ${unhooked.map((a) => `--agent ${a.id}`).join(" ")}`);
  out.print(problems ? "problems found" : "ok");
  return problems ? 1 : 0;
}
