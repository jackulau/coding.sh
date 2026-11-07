// coding.sh init: detect agents, show ONE plan (capture hooks, plus the
// coding.sh MCP server for agents that speak MCP), ask once (Y/n, or --yes),
// then copy the hook to ~/.coding.sh/bin and edit each agent's config. Every
// edited file is backed up first; `coding.sh uninstall` reverts the edits.
// --dry-run prints the exact FileChanges and writes nothing. --no-mcp skips
// the MCP registration. Ends with at most three lines: what was set up, how to
// open the viewer, and the docs URL.
import { existsSync } from "node:fs";
import { detectAll, ADAPTERS } from "../../adapters/index.ts";
import { defaultConfigToml } from "../../core/config.ts";
import { paths } from "../../core/paths.ts";
import type { Adapter, FileChange, McpServerSpec } from "../../core/types.ts";
import { mcpLaunchSpec, runningCli } from "../../mcp/launch.ts";
import { suggest, UsageError } from "../args.ts";
import { changeJson, printChanges } from "../changes.ts";
import { list, requireConsent, str } from "../common.ts";
import { planHookBin, writeHookBin } from "../hookbin.ts";
import { CliError, plural } from "../output.ts";
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

interface AgentPlan {
  adapter: Adapter;
  installed: boolean;
  hooked: boolean;
  version?: string;
  /** Detect notes that mean capture will not work even after install. */
  blockers: string[];
  hooks: Part;
  /** Undefined when the agent has no MCP support, or MCP is off (--no-mcp, project scope). */
  mcp?: Part;
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
  const p = paths(env);
  const hookCommand = p.hook;
  const server: McpServerSpec = mcpLaunchSpec(runningCli());

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
      blockers: blockingNotes(result.notes),
      hooks: await plan(() => adapter.install({ hookCommand, scope, projectDir: c.cwd, dryRun: true })),
    };
    if (result.version) pl.version = result.version;
    if (withMcp && adapter.installMcp) pl.mcp = await plan(() => adapter.installMcp!({ server, dryRun: true }));
    plans.push(pl);
  }

  if (plans.length === 0) {
    throw new CliError(named.length ? "None of the named agents can be installed" : "No supported agents found on this machine", {
      reason: "no_agents",
      next: ["Capture any agent with the wrapper:", "coding.sh run -- <agent command>"],
    });
  }

  const hookChange = planHookBin(env);
  const configChange: FileChange | undefined = existsSync(p.config) ? undefined : { path: p.config, action: "create", summary: "write the default coding.sh config", after: defaultConfigToml(env) };
  const own = [hookChange, configChange].filter((x): x is FileChange => x !== undefined);
  const agentChanges = (pl: AgentPlan) => [...pl.hooks.changes, ...(pl.mcp?.changes ?? [])];
  const pending = plans.filter((pl) => agentChanges(pl).length);
  const total = pending.reduce((n, pl) => n + agentChanges(pl).length, 0);
  const failed = plans.some((pl) => pl.hooks.error || pl.mcp?.error);

  // ---- the plan (stderr): one row per agent
  for (const pl of plans) {
    const label = pl.adapter.displayName;
    if (pl.hooks.error) out.row(label, `can't install hooks: ${pl.hooks.error}`, "fail");
    if (pl.mcp?.error) out.row(label, `can't register the MCP server: ${pl.mcp.error}`, "fail");
    const todo = [pl.hooks.changes.length ? "hooks" : "", pl.mcp?.changes.length ? "MCP server" : ""].filter(Boolean);
    if (todo.length) out.row(label, `${todo.join(" + ")}${pl.installed ? "" : " (agent not detected)"}`);
    else if (pl.adapter.tail && !pl.hooks.error) out.row(label, "no hooks needed; imports from its store", "ok");
    else if (!pl.hooks.error && !pl.mcp?.error) out.row(label, "already set up", "ok");
  }

  if (dryRun) {
    if (out.json) {
      out.data({
        outcome: "planned",
        scope,
        hook: hookCommand,
        mcpServer: withMcp ? server : null,
        changes: own.map(changeJson),
        agents: plans.map((pl) => ({ id: pl.adapter.id, installed: pl.installed, hooked: pl.hooked, error: pl.hooks.error ?? null, changes: pl.hooks.changes.map(changeJson), mcp: partJson(pl.mcp, true), warnings: pl.blockers })),
      });
    } else {
      for (const ch of own) printChanges(out, [ch]);
      for (const pl of plans) printChanges(out, agentChanges(pl), pl.adapter.id);
      if (own.length + total === 0) out.ok("Nothing to change");
    }
    return failed ? 1 : 0;
  }

  if (total) {
    await requireConsent(c, `Set up coding.sh for ${plural(pending.length, "agent")} (${plural(total, "config file")}, backed up first)?`, `coding.sh init${scope === "project" ? " --scope project" : ""} --yes`, {
      defaultYes: true,
    });
  }

  // ---- apply: own files first, so hooks never point at a missing bin.
  if (hookChange) await writeHookBin(env);
  if (configChange) {
    const { writeDefaultConfig } = await import("../../core/config.ts");
    writeDefaultConfig(env);
  }
  const applied: { pl: AgentPlan; hooks: Part; mcp?: Part }[] = [];
  for (const pl of plans) {
    const a = pl.adapter;
    const hooks: Part = pl.hooks.error || !pl.hooks.changes.length ? pl.hooks : await plan(() => a.install({ hookCommand, scope, projectDir: c.cwd, dryRun: false }));
    // MCP after hooks: for agents that keep both in one file, the MCP record is the last write (exact uninstall).
    const mcp: Part | undefined = !pl.mcp || pl.mcp.error || !pl.mcp.changes.length ? pl.mcp : await plan(() => a.installMcp!({ server, dryRun: false }));
    if (hooks !== pl.hooks && hooks.error) out.row(a.displayName, `couldn't install hooks: ${hooks.error}`, "fail");
    if (mcp && mcp !== pl.mcp && mcp.error) out.row(a.displayName, `couldn't register the MCP server: ${mcp.error}`, "fail");
    applied.push({ pl, hooks, ...(mcp ? { mcp } : {}) });
  }
  const errors = applied.some((x) => x.hooks.error || x.mcp?.error);
  const outcome = total + own.length === 0 ? "unchanged" : errors ? "partial" : "installed";

  if (out.json) {
    out.data({
      outcome,
      scope,
      hook: hookCommand,
      mcpServer: withMcp ? server : null,
      changes: own.map((ch) => ({ path: ch.path, action: ch.action, summary: ch.summary })),
      agents: applied.map((x) => ({ id: x.pl.adapter.id, error: x.hooks.error ?? null, changes: x.hooks.changes.map((ch) => ({ path: ch.path, action: ch.action, summary: ch.summary })), mcp: partJson(x.mcp, false), warnings: x.pl.blockers })),
    });
    return errors ? 1 : 0;
  }

  // Codex runs new hooks only once the user approves them (we never write trust state).
  const codexTrust = applied.some((x) => x.pl.adapter.id === "codex" && !x.hooks.error && x.hooks.changes.length);
  if (codexTrust) out.warn("Codex: start codex, run /hooks and approve the coding.sh hooks once");
  const ready = applied.filter((x) => !x.hooks.error);
  // Notes that mean the hooks just written (or already there) capture nothing.
  for (const x of ready) {
    for (const n of x.pl.blockers) {
      if (codexTrust && x.pl.adapter.id === "codex" && /not trusted yet/i.test(n)) continue;
      out.warn(`${x.pl.adapter.displayName}: ${n}`);
    }
  }
  // Store-read agents (T3 Code) get no hooks: listed by their plan row, not here.
  const summary = setupSummary(ready.filter((x) => !x.pl.adapter.tail || x.mcp).map((x) => ({ name: x.pl.adapter.displayName, mcp: x.mcp !== undefined && !x.mcp.error })));
  if (summary) out.ok(`${outcome === "unchanged" ? "Already set up:" : "Set up"} ${summary}`);
  out.note(`Open the viewer: ${out.style("coding.sh", "cyan", "err")}`);
  out.note(`Docs: ${DOCS_URL}`);
  return errors ? 1 : 0;
}
