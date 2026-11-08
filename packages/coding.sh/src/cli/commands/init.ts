// coding.sh init: detect agents, show ONE plan (capture hooks, plus the
// coding.sh MCP server for agents that speak MCP), ask once (Y/n, or --yes),
// then copy the hook to ~/.coding.sh/bin and edit each agent's config. Every
// edited file is backed up first; `coding.sh uninstall` reverts the edits.
// --dry-run prints the short plan (agent, scope, files, blockers) and writes
// nothing; --diff adds every edit as a diff. --no-mcp skips
// the MCP registration. --remote <url> --key <ingest key> also adds an http sink
// that sends new sessions to a team's `coding.sh serve` (see ../remote.ts).
// --proxy also points Claude Code and Codex at the local model API proxy
// (src/proxy/install.ts) and starts it in the background.
// Ends with a few lines: what was set up, how to open the viewer, and the docs URL.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectAll, ADAPTERS } from "../../adapters/index.ts";
import { defaultConfigToml } from "../../core/config.ts";
import { paths } from "../../core/paths.ts";
import type { Adapter, FileChange, McpServerSpec } from "../../core/types.ts";
import { mcpLaunchSpec, runningCli } from "../../mcp/launch.ts";
import { applyProxyInstall, isProxyAgent, planProxyInstall, readProxyInstalls } from "../../proxy/install.ts";
import { proxySettings } from "../../proxy/state.ts";
import { suggest, UsageError } from "../args.ts";
import { changeJson, printChanges, shortPath } from "../changes.ts";
import { list, requireConsent, str } from "../common.ts";
import { planHookBin, writeHookBin } from "../hookbin.ts";
import { parseRemote, probeRemote, REMOTE_SINK, validateConfigText, withRemoteSink } from "../remote.ts";
import { CliError, plural, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";

export const DOCS_URL = "https://coding.sh/docs";

export function pickAdapters(names: string[]): Adapter[] {
  return names.map((n) => {
    const a = ADAPTERS.find((x) => x.id === n);
    if (!a) {
      const s = suggest(n, ADAPTERS.map((x) => x.id));
      throw new UsageError(`Unknown agent ${JSON.stringify(n)}`, { suggestion: s ? `--agent ${s}` : undefined, reason: "unknown_agent" });
    }
    return a;
  });
}

interface Part {
  changes: FileChange[];
  error?: string;
}

interface AgentScopeConflict {
  scope: "user" | "project";
  files: string[];
}

interface AgentPlan {
  adapter: Adapter;
  installed: boolean;
  hooked: boolean;
  version?: string;
  /** Detect notes that mean capture will not work even after install. */
  detectBlockers: string[];
  hooks: Part;
  /** The agent already has coding.sh hooks in the other scope (its hooks would capture each event twice). */
  otherScope?: AgentScopeConflict;
  /** Hooks not installed because of otherScope (no --force). */
  skipped?: boolean;
  /** Undefined when the agent has no MCP support, or MCP is off (--no-mcp, project scope). */
  mcp?: Part;
  /** With --proxy: routing the agent's model API through the local proxy. */
  proxy?: Part;
  /** With --proxy, for a named agent init can't route (it reads `coding.sh proxy env` instead). */
  proxyUnsupported?: boolean;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function plan(fn: () => Promise<FileChange[]>): Promise<Part> {
  try {
    return { changes: await fn() };
  } catch (e) {
    return { changes: [], error: errText(e) };
  }
}

const partJson = (p: Part | undefined, full: boolean) =>
  p ? { error: p.error ?? null, changes: p.changes.map((ch) => (full ? changeJson(ch) : { path: ch.path, action: ch.action, summary: ch.summary })) } : null;

/**
 * Files in the other scope that already hold this agent's coding.sh hooks,
 * found with a dry-run uninstall of that scope. Files this scope edits as well
 * (a project dir that is the home directory) don't count.
 */
export async function otherScopeHooks(a: Adapter, scope: "user" | "project", projectDir: string, planned: FileChange[]): Promise<AgentScopeConflict | undefined> {
  if (a.tail) return undefined;
  const other = scope === "user" ? "project" : "user";
  try {
    const mine = new Set([...planned, ...(await a.uninstall({ scope, projectDir, dryRun: true }))].map((c) => resolve(c.path)));
    const files = [...new Set((await a.uninstall({ scope: other, projectDir, dryRun: true })).map((c) => resolve(c.path)))].filter((f) => !mine.has(f));
    return files.length ? { scope: other, files } : undefined;
  } catch {
    return undefined; // an unreadable config in the other scope is not this init's problem
  }
}

/** "a", "a and b", "a, b and c". */
export function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// DetectResult.notes is free text that mixes tips with real problems; these
// phrasings mark the notes that mean the installed hooks will not capture
// anything (an agent too old for hooks, hooks disabled, hooks not trusted).
const BLOCKING_NOTE = /\bpredates\b|\bwill not run\b|\bnot trusted yet\b/i;

/** The detect notes that block capture. */
export function blockingNotes(notes: readonly string[] | undefined): string[] {
  return (notes ?? []).filter((n) => BLOCKING_NOTE.test(n));
}

interface Blocker {
  text: string;
  /** The planned edit itself fails (vs capture that won't work until the user acts). */
  fatal: boolean;
}

/** What keeps this agent's capture from working. Shown in the plan, before the Y/n prompt. */
function planBlockers(pl: AgentPlan, env: NodeJS.ProcessEnv, cwd: string): Blocker[] {
  const out: Blocker[] = [];
  if (pl.hooks.error) out.push({ text: `can't install hooks: ${pl.hooks.error}`, fatal: true });
  if (pl.mcp?.error) out.push({ text: `can't register the MCP server: ${pl.mcp.error}`, fatal: true });
  if (pl.proxy?.error) out.push({ text: `can't route through the proxy: ${pl.proxy.error}`, fatal: true });
  if (pl.proxyUnsupported) out.push({ text: "init --proxy can't route this agent; point it at the variables from coding.sh proxy env", fatal: false });
  if (!pl.installed) out.push({ text: `${pl.adapter.displayName} is not installed on this machine; its hooks fire once it is`, fatal: false });
  if (pl.otherScope) {
    const where = `${pl.otherScope.scope} scope (${pl.otherScope.files.map((f) => shortPath(f, env, cwd)).join(", ")})`;
    out.push({ text: pl.skipped ? `skipping hooks: already installed in ${where}; --force installs both` : `also hooked in ${where}; events may be captured twice`, fatal: false });
  }
  // Codex runs new hooks only once the user approves them (we never write trust state).
  const codexTrust = pl.adapter.id === "codex" && pl.hooks.changes.length > 0;
  if (codexTrust) out.push({ text: "after setup, start codex, run /hooks and approve the coding.sh hooks once", fatal: false });
  for (const n of pl.detectBlockers) if (!(codexTrust && /not trusted yet/i.test(n))) out.push({ text: n, fatal: false });
  return out;
}

/**
 * The plan, one block per agent: its scope, the files it would change, and
 * what blocks capture. `emit` gets each line (stdout for --dry-run, stderr
 * ahead of the Y/n prompt).
 */
function renderPlan(out: Output, plans: AgentPlan[], own: FileChange[], scope: string, env: NodeJS.ProcessEnv, cwd: string, emit: (line: string) => void, stream: "out" | "err"): void {
  type Row = [FileChange, string];
  const rowsOf = (pl: AgentPlan): Row[] => [
    ...pl.hooks.changes.map((ch): Row => [ch, "hooks"]),
    ...(pl.mcp?.changes ?? []).map((ch): Row => [ch, "MCP server"]),
    ...(pl.proxy?.changes ?? []).map((ch): Row => [ch, "proxy"]),
  ];
  // Align the "hooks"/"MCP server" column over the agent rows (coding.sh's own files have none).
  const width = Math.max(0, ...plans.flatMap(rowsOf).map(([ch]) => shortPath(ch.path, env, cwd).length));
  const file = ([ch, what]: Row) => `    ${ch.action.padEnd(8)}${what ? `${shortPath(ch.path, env, cwd).padEnd(width)}  ${what}` : shortPath(ch.path, env, cwd)}`;
  for (const pl of plans) {
    emit(`  ${out.style(pl.adapter.displayName, "bold", stream)} (${scope} scope)`);
    const rows = rowsOf(pl);
    for (const r of rows) emit(file(r));
    if (!rows.length && !pl.hooks.error && !pl.mcp?.error && !pl.proxy?.error && !pl.skipped) emit(pl.adapter.tail ? "    no hooks needed; imports from its store" : "    already set up");
    for (const b of planBlockers(pl, env, cwd)) emit(`    ${b.fatal ? out.style("✗", "red", stream) : out.style("!", "yellow", stream)} ${b.text}`);
  }
  if (own.length) {
    emit(`  ${out.style("coding.sh", "bold", stream)}`);
    for (const ch of own) emit(file([ch, ""]));
  }
}

/** "Set up A and B (hooks + MCP server); C (hooks)" from what each agent actually got. */
export function setupSummary(ready: { name: string; mcp: boolean }[]): string {
  const groups: [string[], string][] = [
    [ready.filter((x) => x.mcp).map((x) => x.name), "hooks + MCP server"],
    [ready.filter((x) => !x.mcp).map((x) => x.name), "hooks"],
  ];
  return groups
    .filter(([names]) => names.length)
    .map(([names, what]) => `${joinNames(names)} (${what})`)
    .join("; ");
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const named = list(c.flags.agent);
  const scope = (str(c.flags.scope) ?? "user") as "user" | "project";
  const dryRun = c.flags["dry-run"] === true;
  // MCP servers are registered per user; project scope stays hooks-only.
  const withMcp = c.flags.mcp !== false && scope === "user";
  const force = c.flags.force === true;
  const withProxy = c.flags.proxy === true;
  if (withProxy && scope === "project") throw new UsageError("--proxy edits each agent's user config; drop --scope project", { reason: "invalid_argument" });
  // The URL agents get: always loopback, whatever address the proxy listens on.
  const proxyUrl = `http://127.0.0.1:${proxySettings(env).port}`;
  const p = paths(env);
  const hookCommand = p.hook;
  // --remote: check the server takes the key before planning anything, so a typo writes nothing.
  const remoteUrl = str(c.flags.remote);
  if (remoteUrl === undefined && (c.flags.key !== undefined || c.flags["remote-mode"] !== undefined)) {
    throw new UsageError("--key and --remote-mode go with --remote <url>", { reason: "missing_value" });
  }
  const remote = remoteUrl === undefined ? undefined : parseRemote(remoteUrl, str(c.flags.key) ?? env.CODING_SH_INGEST_KEY, str(c.flags["remote-mode"]));
  if (remote) {
    const check = out.spin(`Checking ${remote.url}…`);
    try {
      await probeRemote(remote);
    } finally {
      check.stop();
    }
  }
  // From a bundle: node ~/.coding.sh/bin/mcp.mjs (written below with the hook), a path that survives node and package moves.
  const server: McpServerSpec = mcpLaunchSpec(runningCli(), env);

  const spin = out.spin("Detecting agents…");
  const detected = await detectAll(named.length ? pickAdapters(named) : ADAPTERS);
  spin.stop();

  const plans: AgentPlan[] = [];
  for (const { adapter, result } of detected) {
    // Only agents found on this machine, unless named explicitly. Tier C
    // (wrapper-only) agents have nothing to install.
    if (!named.includes(adapter.id) && (!result.installed || adapter.tier === "C")) continue;
    const pl: AgentPlan = {
      adapter,
      installed: result.installed,
      hooked: result.hooked,
      detectBlockers: blockingNotes(result.notes),
      hooks: await plan(() => adapter.install({ hookCommand, scope, projectDir: c.cwd, dryRun: true })),
    };
    if (result.version) pl.version = result.version;
    // User and project hooks both fire in agents that don't dedupe identical commands: every event twice.
    const conflict = pl.hooks.error ? undefined : await otherScopeHooks(adapter, scope, c.cwd, pl.hooks.changes);
    if (conflict) {
      pl.otherScope = conflict;
      if (pl.hooks.changes.length && !force) {
        pl.skipped = true;
        pl.hooks = { changes: [] };
      }
    }
    if (withMcp && adapter.installMcp) pl.mcp = await plan(() => adapter.installMcp!({ server, dryRun: true }));
    if (withProxy && isProxyAgent(adapter.id)) {
      const id = adapter.id;
      pl.proxy = await plan(async () => [planProxyInstall(id, { url: proxyUrl, env, force })].filter((x) => x !== undefined));
    } else if (withProxy && named.includes(adapter.id)) pl.proxyUnsupported = true;
    plans.push(pl);
  }

  // With --remote and no agents here, the sink is still worth writing (apps, `coding.sh run`, agents installed later).
  if (plans.length === 0 && !remote) {
    throw new CliError(named.length ? "None of the named agents can be installed" : "No supported agents found on this machine", {
      reason: "no_agents",
      next: ["Wrap any agent: coding.sh run -- <agent command>", "Trace an agent you built: https://coding.sh/docs/how-to/trace-your-agent"],
    });
  }

  const hookChange = planHookBin(env);
  const configBefore = existsSync(p.config) ? readFileSync(p.config, "utf8") : undefined;
  let configChange: FileChange | undefined = configBefore === undefined ? { path: p.config, action: "create", summary: "write the default coding.sh config", after: defaultConfigToml(env) } : undefined;
  if (remote) {
    const after = withRemoteSink(configBefore ?? defaultConfigToml(env), remote);
    validateConfigText(after, env);
    if (after !== configBefore) {
      const summary = `send sessions to ${remote.url} (${remote.mode})`;
      configChange = configBefore === undefined ? { path: p.config, action: "create", summary: `write the default coding.sh config and ${summary}`, after } : { path: p.config, action: "modify", summary, before: configBefore, after };
    }
  }
  const own = [hookChange, configChange].filter((x): x is FileChange => x !== undefined);
  const agentChanges = (pl: AgentPlan) => [...pl.hooks.changes, ...(pl.mcp?.changes ?? []), ...(pl.proxy?.changes ?? [])];
  const pending = plans.filter((pl) => agentChanges(pl).length);
  const total = pending.reduce((n, pl) => n + agentChanges(pl).length, 0);
  const failed = plans.some((pl) => pl.hooks.error || pl.mcp?.error || pl.proxy?.error);

  if (dryRun) {
    if (out.json) {
      out.data({
        outcome: "planned",
        scope,
        hook: hookCommand,
        mcpServer: withMcp ? server : null,
        proxy: withProxy ? proxyUrl : null,
        changes: own.map(changeJson),
        remote: remote ? { url: remote.url, mode: remote.mode, sink: REMOTE_SINK } : null,
        agents: plans.map((pl) => ({ id: pl.adapter.id, installed: pl.installed, hooked: pl.hooked, error: pl.hooks.error ?? null, changes: pl.hooks.changes.map(changeJson), mcp: partJson(pl.mcp, true), proxy: partJson(pl.proxy, true), warnings: pl.detectBlockers, blockers: planBlockers(pl, env, c.cwd).map((b) => b.text), otherScope: pl.otherScope ?? null, skipped: pl.skipped === true })),
      });
    } else {
      // The plan is the answer of a dry run: stdout.
      renderPlan(out, plans, own, scope, env, c.cwd, (l) => out.print(l), "out");
      if (c.flags.diff === true) {
        out.print();
        for (const ch of own) printChanges(out, [ch]);
        for (const pl of plans) printChanges(out, agentChanges(pl), pl.adapter.id);
      }
      if (own.length + total === 0) out.ok("Nothing to change");
      else out.note(`Dry run: nothing written.${c.flags.diff === true ? "" : " Add --diff for the full edits."}`);
    }
    return failed ? 1 : 0;
  }

  // ---- the plan (stderr), blockers included, before the one question.
  renderPlan(out, plans, own, scope, env, c.cwd, (l) => out.note(l.replace(/^  /, "")), "err");

  if (total) {
    await requireConsent(c, `Set up coding.sh for ${plural(pending.length, "agent")} (${plural(total, "config file")}, backed up first)?`, `coding.sh init${scope === "project" ? " --scope project" : ""} --yes`, {
      defaultYes: true,
    });
  }

  // ---- apply: own files first, so hooks never point at a missing bin.
  if (hookChange) await writeHookBin(env);
  if (configChange) {
    // Mode 600: with --remote the file holds an ingest key.
    const { atomicWrite } = await import("../../adapters/_shared/files.ts");
    await atomicWrite(p.config, configChange.after!, 0o600);
  }
  const applied: { pl: AgentPlan; hooks: Part; mcp?: Part; proxy?: Part }[] = [];
  for (const pl of plans) {
    const a = pl.adapter;
    const hooks: Part = pl.hooks.error || !pl.hooks.changes.length ? pl.hooks : await plan(() => a.install({ hookCommand, scope, projectDir: c.cwd, dryRun: false }));
    // MCP after hooks: for agents that keep both in one file, the MCP record is the last write (exact uninstall).
    const mcp: Part | undefined = !pl.mcp || pl.mcp.error || !pl.mcp.changes.length ? pl.mcp : await plan(() => a.installMcp!({ server, dryRun: false }));
    // The proxy last: it is the final write to a file it shares (Claude Code settings.json), so its exact restore applies first on uninstall.
    const proxy: Part | undefined =
      !pl.proxy || pl.proxy.error || !pl.proxy.changes.length
        ? pl.proxy
        : await plan(async () => {
            // Planned again: the hooks or MCP writes above may have changed the same file.
            const id = a.id as "claude-code" | "codex";
            const ch = planProxyInstall(id, { url: proxyUrl, env, force });
            if (!ch) return [];
            await applyProxyInstall(id, ch, proxyUrl, env);
            return [ch];
          });
    if (hooks !== pl.hooks && hooks.error) out.row(a.displayName, `couldn't install hooks: ${hooks.error}`, "fail");
    if (mcp && mcp !== pl.mcp && mcp.error) out.row(a.displayName, `couldn't register the MCP server: ${mcp.error}`, "fail");
    if (proxy && proxy !== pl.proxy && proxy.error) out.row(a.displayName, `couldn't route through the proxy: ${proxy.error}`, "fail");
    applied.push({ pl, hooks, ...(mcp ? { mcp } : {}), ...(proxy ? { proxy } : {}) });
  }
  const errors = applied.some((x) => x.hooks.error || x.mcp?.error || x.proxy?.error);
  // Routed agents need the proxy up: start it now (the hook restarts it on later session starts).
  const routed = applied.filter((x) => x.proxy && !x.proxy.error);
  let proxyStart: { url: string; pid: number; started: boolean; restarted?: boolean; error?: string } | undefined;
  if (routed.length) {
    try {
      const { ensureRunning } = await import("./proxy.ts");
      const r = await ensureRunning(env);
      proxyStart = { url: r.state.url, pid: r.state.pid, started: r.started, ...(r.restarted ? { restarted: true } : {}) };
    } catch (e) {
      proxyStart = { url: proxyUrl, pid: 0, started: false, error: errText(e) };
    }
  }
  const outcome = total + own.length === 0 ? "unchanged" : errors ? "partial" : "installed";

  if (out.json) {
    out.data({
      outcome,
      scope,
      hook: hookCommand,
      mcpServer: withMcp ? server : null,
      proxy: proxyStart ? { url: proxyUrl, running: !proxyStart.error, started: proxyStart.started, ...(proxyStart.error ? { error: proxyStart.error } : { pid: proxyStart.pid }) } : null,
      changes: own.map((ch) => ({ path: ch.path, action: ch.action, summary: ch.summary })),
      remote: remote ? { url: remote.url, mode: remote.mode, sink: REMOTE_SINK } : null,
      agents: applied.map((x) => ({ id: x.pl.adapter.id, error: x.hooks.error ?? null, changes: x.hooks.changes.map((ch) => ({ path: ch.path, action: ch.action, summary: ch.summary })), mcp: partJson(x.mcp, false), proxy: partJson(x.proxy, false), warnings: x.pl.detectBlockers, blockers: planBlockers(x.pl, env, c.cwd).map((b) => b.text), otherScope: x.pl.otherScope ?? null, skipped: x.pl.skipped === true })),
    });
    return errors ? 1 : 0;
  }

  // Blockers were listed with the plan; the one step left to do is repeated as the last thing before the summary.
  const codexTrust = applied.some((x) => x.pl.adapter.id === "codex" && !x.hooks.error && x.hooks.changes.length);
  if (codexTrust) out.warn("Codex: start codex, run /hooks and approve the coding.sh hooks once");
  const ready = applied.filter((x) => !x.hooks.error && !x.pl.skipped);
  // Store-read agents (T3 Code) and wrapper-only agents (tier C: Aider) get no hooks: listed by their plan row, not here.
  const summary = setupSummary(ready.filter((x) => (!x.pl.adapter.tail && x.pl.adapter.tier !== "C") || x.mcp).map((x) => ({ name: x.pl.adapter.displayName, mcp: x.mcp !== undefined && !x.mcp.error })));
  if (summary) out.ok(`${outcome === "unchanged" ? "Already set up:" : "Set up"} ${summary}`);
  if (remote) {
    if (!plans.length) out.warn("No supported agents found on this machine; apps and `coding.sh run -- <cmd>` still send");
    out.ok(`Sending new sessions to ${remote.url} (${remote.mode === "full" ? "full content" : "metadata only"}). Sessions from before stay on this machine`);
    out.note(`Team viewer: ${out.style(remote.url, "cyan", "err")}`);
  }
  if (routed.length) {
    const names = joinNames(routed.map((x) => x.pl.adapter.displayName));
    if (proxyStart?.error) out.warn(`${names} now call ${proxyUrl}, but the proxy did not start (${proxyStart.error}). Start it: coding.sh proxy --background`);
    else out.ok(`${names} → proxy at ${proxyUrl}${proxyStart?.started ? ` (${proxyStart.restarted ? "restarted" : "started"}, pid ${proxyStart.pid})` : ""}; restart running sessions to pick it up`);
    const recs = readProxyInstalls(env);
    for (const x of routed) {
      const chained = isProxyAgent(x.pl.adapter.id) ? recs[x.pl.adapter.id]?.chained : undefined;
      if (chained) out.note(`${x.pl.adapter.displayName} calls go on to ${chained}, the base URL it used before`);
    }
  }
  out.note(`Open the viewer: ${out.style("coding.sh", "cyan", "err")}`);
  out.note(`Docs: ${DOCS_URL}`);
  return errors ? 1 : 0;
}
