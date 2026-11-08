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
import { isAbsolute, resolve } from "node:path";
import { parseHookCommand } from "../../adapters/_shared/hooks.ts";
import { detectAll, ADAPTERS } from "../../adapters/index.ts";
import { defaultConfigToml } from "../../core/config.ts";
import { paths } from "../../core/paths.ts";
import type { Adapter, FileChange, McpServerSpec } from "../../core/types.ts";
import { mcpLaunchSpec, runningCli } from "../../mcp/launch.ts";
import { applyProxyInstall, isProxyAgent, planProxyInstall, readProxyInstalls } from "../../proxy/install.ts";
import { proxySettings } from "../../proxy/state.ts";
import { spawnBackgroundIngest } from "../../spool/kick.ts";
import { suggest, UsageError } from "../args.ts";
import { changeJson, printChanges, shortPath } from "../changes.ts";
import { ingestCli, list, requireConsent, str, underImportLock, withContext } from "../common.ts";
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

/** Which hook.mjs `file` runs, and whether it is `hook` (this home's). */
export function hookTarget(file: string, hook: string): { hook: string | null; current: boolean } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { hook: null, current: true };
  }
  // JSON and TOML escape the quotes and backslashes of `node "<hook>" <agent> <event>`.
  const plain = text.replace(/\\(["\\])/g, "$1");
  const forms = [hook, hook.replace(/\\/g, "/")];
  if (forms.some((f) => plain.includes(f))) return { hook, current: true };
  const cmd = plain.split("\n").map((l) => parseHookCommand(l)).find((x) => x)?.hookPath;
  const found = cmd ?? /["']([^"'\n]*hook\.mjs)["']/.exec(plain)?.[1] ?? null;
  // Hook commands carry forward slashes on Windows; name the file the way this platform does,
  // like the settings `file` beside it.
  return { hook: found !== null && isAbsolute(found) ? resolve(found) : found, current: found === null };
}

/**
 * Files in the other scope that already hold this agent's coding.sh hooks,
 * found with a dry-run uninstall of that scope. Files this scope edits as well
 * (a project dir that is the home directory) don't count. With `hook`, neither
 * do files whose hooks run another hook.mjs: they feed another coding.sh home
 * (a temp CODING_SH_HOME run from a project hooked for the real one).
 */
export async function otherScopeHooks(a: Adapter, scope: "user" | "project", projectDir: string, planned: FileChange[], hook?: string): Promise<AgentScopeConflict | undefined> {
  if (a.tail) return undefined;
  const other = scope === "user" ? "project" : "user";
  try {
    const mine = new Set([...planned, ...(await a.uninstall({ scope, projectDir, dryRun: true }))].map((c) => resolve(c.path)));
    const files = [...new Set((await a.uninstall({ scope: other, projectDir, dryRun: true })).map((c) => resolve(c.path)))].filter((f) => !mine.has(f) && (hook === undefined || hookTarget(f, hook).current));
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
function renderPlan(out: Output, plans: AgentPlan[], own: FileChange[], scope: string, env: NodeJS.ProcessEnv, cwd: string, emit: (line: string) => void, stream: "out" | "err", importFrom: Adapter[] = []): void {
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
  if (importFrom.length) emit(`  then import past sessions from ${joinNames(importFrom.map((a) => a.displayName))} (--no-import skips)`);
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

/** The line after "Set up …": capture starts with the next session of the agents that just got hooks. */
export function firstSessionNote(names: string[]): string {
  const which = names.length === 1 ? `${names[0]} session` : "session of any of them";
  return `Recording starts with the next session: start a new ${which}. Sessions already open may not have loaded the hooks`;
}

/** How long init imports past sessions before it leaves the rest to a background import. */
export const IMPORT_BUDGET_MS = 8000;

/** The import budget: CODING_SH_INIT_IMPORT_BUDGET_MS when it is a number >= 0, else IMPORT_BUDGET_MS. */
export function importBudgetMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CODING_SH_INIT_IMPORT_BUDGET_MS?.trim();
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? v : IMPORT_BUDGET_MS;
}

export interface ImportOutcome {
  agents: string[];
  /** Sessions created or updated by this import. */
  sessions: number;
  events: number;
  /** Transcripts left for the background import (0 when it all fit in the budget). */
  pendingFiles: number;
  /** A background import was started for the pending files (or one was already running). */
  background: boolean;
  errors: string[];
  ms: number;
}

/**
 * Imports the past sessions of `agents` (adapter.backfill), stopping at the time budget and
 * starting `ingest --background --backfill` for the rest. Undefined when there is nothing to
 * import from or the store is not this machine's.
 */
async function importHistory(c: CommandContext, agents: Adapter[]): Promise<ImportOutcome | undefined> {
  const ids = agents.filter((a) => a.backfill).map((a) => a.id);
  if (!ids.length) return undefined;
  const { out, env } = c;
  const started = Date.now();
  const names = (id: string) => ADAPTERS.find((a) => a.id === id)?.displayName ?? id;
  return withContext(c, async (ctx) => {
    // A store from --store / CODING_SH_STORE_URL is shared: never push this machine's history into it.
    if (ctx.storeOverridden) return undefined;
    const spin = out.spin("Importing past sessions…");
    let bf;
    try {
      bf = await underImportLock(ctx, 0, () =>
        ctx.backfill({
          agents: ids,
          deadline: started + importBudgetMs(env),
          onProgress: (p) => spin.update(`Importing past ${names(p.agent)} sessions… ${plural(p.files, "transcript")} read`),
        }),
      );
    } finally {
      spin.stop();
    }
    // Name only the agents that had history to import.
    const found = bf?.agents.filter((a) => a.events > 0).map((a) => a.agent) ?? [];
    const outcome: ImportOutcome = { agents: found.length ? found : ids, sessions: bf?.sessions ?? 0, events: bf?.events ?? 0, pendingFiles: bf?.pendingFiles ?? 0, background: !bf, errors: (bf?.errors ?? []).map((e) => e.message), ms: Date.now() - started };
    if (bf?.pendingFiles && env.CODING_SH_NO_AUTO_INGEST !== "1") {
      outcome.background = !!spawnBackgroundIngest(ingestCli(ctx.paths.cliPointer), env, undefined, ["--backfill", ...ids.flatMap((id) => ["--agent", id])]);
    }
    return outcome;
  });
}

function reportImport(out: Output, r: ImportOutcome): void {
  const from = joinNames(r.agents.map((id) => ADAPTERS.find((a) => a.id === id)?.displayName ?? id));
  const secs = `${(r.ms / 1000).toFixed(1)} s`;
  if (r.background && !r.pendingFiles) out.ok("Past sessions: an import is already running in the background");
  else if (r.pendingFiles) {
    const rest = `${plural(r.pendingFiles, "transcript")} left`;
    if (r.background) out.ok(`Imported ${plural(r.sessions, "past session")} from ${from} in ${secs}; importing the rest (${rest}) in the background`);
    else out.warn(`Imported ${plural(r.sessions, "past session")} from ${from}; ${rest}. Import them: coding.sh ingest --backfill`);
  } else if (r.sessions) out.ok(`Imported ${plural(r.sessions, "past session")} from ${from} in ${secs}`);
  // Nothing found or nothing new: say nothing, so init still ends in its three lines.
  for (const e of r.errors.slice(0, 3)) out.note(e);
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
    const conflict = pl.hooks.error ? undefined : await otherScopeHooks(adapter, scope, c.cwd, pl.hooks.changes, p.hook);
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
  // Past sessions to import once set up: every planned agent that keeps its own history.
  const importFrom = c.flags.import === false ? [] : plans.map((pl) => pl.adapter).filter((a) => a.backfill);

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
        import: importFrom.length ? { agents: importFrom.map((a) => a.id), budgetMs: importBudgetMs(env) } : null,
        agents: plans.map((pl) => ({ id: pl.adapter.id, installed: pl.installed, hooked: pl.hooked, error: pl.hooks.error ?? null, changes: pl.hooks.changes.map(changeJson), mcp: partJson(pl.mcp, true), proxy: partJson(pl.proxy, true), warnings: pl.detectBlockers, blockers: planBlockers(pl, env, c.cwd).map((b) => b.text), otherScope: pl.otherScope ?? null, skipped: pl.skipped === true })),
      });
    } else {
      // The plan is the answer of a dry run: stdout.
      renderPlan(out, plans, own, scope, env, c.cwd, (l) => out.print(l), "out", importFrom);
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
  renderPlan(out, plans, own, scope, env, c.cwd, (l) => out.note(l.replace(/^  /, "")), "err", importFrom);

  if (total) {
    await requireConsent(c, `Set up coding.sh for ${plural(pending.length, "agent")} (${plural(total, "config file")}, backed up first)${importFrom.length ? " and import past sessions" : ""}?`, `coding.sh init${scope === "project" ? " --scope project" : ""} --yes`, {
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
  // Past sessions, so the first viewer screen shows the user's own history (never fails init).
  let imported: ImportOutcome | undefined;
  try {
    imported = await importHistory(c, importFrom);
  } catch (e) {
    imported = { agents: importFrom.map((a) => a.id), sessions: 0, events: 0, pendingFiles: 0, background: false, errors: [errText(e)], ms: 0 };
  }

  if (out.json) {
    out.data({
      outcome,
      scope,
      hook: hookCommand,
      mcpServer: withMcp ? server : null,
      proxy: proxyStart ? { url: proxyUrl, running: !proxyStart.error, started: proxyStart.started, ...(proxyStart.error ? { error: proxyStart.error } : { pid: proxyStart.pid }) } : null,
      changes: own.map((ch) => ({ path: ch.path, action: ch.action, summary: ch.summary })),
      remote: remote ? { url: remote.url, mode: remote.mode, sink: REMOTE_SINK } : null,
      import: imported ?? null,
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
  // Agents load hooks when a session starts: one open while init ran (often the one that ran it) is not recorded live.
  const hookedNow = ready.filter((x) => x.hooks.changes.length).map((x) => x.pl.adapter.displayName);
  if (hookedNow.length) out.note(firstSessionNote(hookedNow));
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
  if (imported) reportImport(out, imported);
  // Started with npx, `coding.sh` is not on PATH: name the next commands the way this one ran.
  const bin = env.npm_command === "exec" ? "npx coding.sh" : "coding.sh";
  out.note(`Open the viewer: ${out.style(`${bin} ui`, "cyan", "err")}`);
  out.note(`After a few sessions, see what to fix first: ${out.style(`${bin} improve`, "cyan", "err")}`);
  out.note(`Docs: ${DOCS_URL}`);
  return errors ? 1 : 0;
}
