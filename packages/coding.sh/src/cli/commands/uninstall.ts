// coding.sh uninstall: remove coding.sh hooks and MCP server entries from
// agents. An MCP config untouched since init is restored byte-for-byte;
// otherwise only the coding.sh entry goes. Captured data and the hook bin in
// ~/.coding.sh are kept (other scopes may still use the bin). Proxy routing
// from `init --proxy` goes first; --proxy removes only that.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ADAPTERS } from "../../adapters/index.ts";
import { paths } from "../../core/paths.ts";
import type { Adapter, FileChange } from "../../core/types.ts";
import { MCP_CONFIG_NAME } from "../../mcp/launch.ts";
import { applyProxyUninstall, isProxyAgent, planProxyUninstall, readProxyInstalls } from "../../proxy/install.ts";
import { changeJson, printChanges } from "../changes.ts";
import { list, requireConsent, shellQuote, str } from "../common.ts";
import { nextStepBin, rerunWithYes, windowsShell } from "../next-steps.ts";
import { plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { pickAdapters } from "./init.ts";

interface RemoveOpts {
  scope: "user" | "project";
  projectDir: string;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  proxyOnly: boolean;
}

/** The variable that names an agent's config dir, where the recorded file sits right in it. */
const DIR_VAR: Record<string, string> = { opencode: "OPENCODE_CONFIG_DIR" };

/** A path as installs.json keys it, compared case-blind on Windows. */
const pathKey = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

/**
 * MCP registrations installs.json records for these agents whose files still exist and that no
 * planned change touches: an install made under another config dir (OPENCODE_CONFIG_DIR set at
 * init, unset now), which the adapters' uninstall cannot see. Uninstall names them instead of
 * reporting full success. Only MCP records: those are user scope, as a plain uninstall is, while
 * a hook file may belong to a project's own install.
 */
export function leftInPlace(agents: readonly Adapter[], touched: readonly string[], env: NodeJS.ProcessEnv): { agent: string; name: string; path: string }[] {
  let files: Record<string, { agent?: unknown; mcp?: unknown }> = {};
  try {
    const v = JSON.parse(readFileSync(paths(env).installs, "utf8")) as { files?: unknown };
    if (v.files && typeof v.files === "object" && !Array.isArray(v.files)) files = v.files as typeof files;
  } catch {
    return [];
  }
  const seen = new Set(touched.map(pathKey));
  const out: { agent: string; name: string; path: string }[] = [];
  for (const [path, rec] of Object.entries(files)) {
    const a = agents.find((x) => x.id === rec?.agent);
    if (!a || !rec.mcp || seen.has(pathKey(path)) || !existsSync(path)) continue;
    out.push({ agent: a.id, name: a.displayName, path });
  }
  return out;
}

/** What removing coding.sh from one agent changes, and why each part that failed did. */
interface Removal {
  changes: FileChange[];
  errors: string[];
}

/** The errors as one `--json` field, null when none. */
const errorJson = (r: Removal) => (r.errors.length ? r.errors.join("; ") : null);

/**
 * In reverse order of init's writes, so each exact restore sees the file as it
 * wrote it: proxy routing, then MCP entries, then hooks. A part that fails (a
 * file it can't read) leaves its file as it is; the parts after it still run.
 */
async function removeAll(a: Adapter, opts: RemoveOpts): Promise<Removal> {
  const changes: FileChange[] = [];
  const errors: string[] = [];
  const part = async (remove: () => Promise<FileChange[]>) => {
    try {
      changes.push(...(await remove()));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!errors.includes(msg)) errors.push(msg);
    }
  };
  const id = a.id;
  if (opts.scope === "user" && isProxyAgent(id)) {
    await part(async () => {
      const c = planProxyUninstall(id, opts.env);
      if (!c) return [];
      if (!opts.dryRun) await applyProxyUninstall(id, c, opts.env);
      return [c];
    });
  }
  if (!opts.proxyOnly) {
    if (opts.scope === "user" && a.uninstallMcp) await part(async () => (await a.uninstallMcp?.({ name: MCP_CONFIG_NAME, dryRun: opts.dryRun })) ?? []);
    await part(() => a.uninstall(opts));
  }
  return { changes, errors };
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  // How the user's shell runs this CLI, for the commands uninstall names.
  const bin = nextStepBin(c.env);
  const named = list(c.flags.agent);
  const scope = (str(c.flags.scope) ?? "user") as "user" | "project";
  const dryRun = c.flags["dry-run"] === true;
  const proxyOnly = c.flags.proxy === true;
  const adapters = named.length ? pickAdapters(named) : ADAPTERS;
  const opts = (dry: boolean): RemoveOpts => ({ scope, projectDir: c.cwd, dryRun: dry, env: c.env, proxyOnly });
  const what = proxyOnly ? "No agents routed through the coding.sh proxy" : "No coding.sh hooks or MCP entries installed";

  const plans: ({ id: string; name: string } & Removal)[] = [];
  for (const a of adapters) plans.push({ id: a.id, name: a.displayName, ...(await removeAll(a, opts(true))) });
  const pending = plans.filter((p) => p.changes.length);
  const total = pending.reduce((n, p) => n + p.changes.length, 0);
  for (const p of plans) {
    for (const e of p.errors) out.row(p.name, `can't plan: ${e}`, "fail");
    if (p.changes.length) out.row(p.name, `${plural(p.changes.length, "file")} to change`);
  }
  const failed = plans.some((p) => p.errors.length);
  // Proxy-only runs leave hooks and MCP entries by design. An agent with a file it couldn't
  // read is left out: that file may be the one the record names, in the config dir after all.
  const left = proxyOnly || scope !== "user" ? [] : leftInPlace(adapters.filter((a) => !plans.some((p) => p.id === a.id && p.errors.length)), plans.flatMap((p) => p.changes.map((ch) => ch.path)), c.env);
  const warnLeft = () => {
    for (const l of left) out.warn(`${l.name}: ${l.path} holds a coding.sh install outside the config dir uninstall looked in; it is left in place`);
    for (const l of left.filter((x, i) => left.findIndex((y) => y.agent === x.agent && dirname(y.path) === dirname(x.path)) === i)) {
      const v = DIR_VAR[l.agent];
      const cmd = `${bin} uninstall --agent ${l.agent}`;
      // `VAR=value cmd` is sh syntax: PowerShell and cmd get the variable to set instead.
      if (v && !windowsShell(c.env)) out.next("Remove it with the config dir it had at init", `${v}=${shellQuote(dirname(l.path))} ${cmd}`);
      else out.next(`Remove it: set ${v ?? `${l.name}'s config dir`} to ${dirname(l.path)} as at init, then run`, cmd);
    }
  };
  const leftJson = () => (left.length ? { leftInPlace: left.map((l) => ({ id: l.agent, path: l.path })) } : {});

  if (dryRun) {
    if (out.json) out.data({ outcome: "planned", scope, agents: plans.map((p) => ({ id: p.id, error: errorJson(p), changes: p.changes.map(changeJson) })), ...leftJson() });
    else {
      for (const p of pending) printChanges(out, p.changes, p.id);
      if (total) out.note("Dry run: nothing written.");
      else if (!left.length && !failed) out.ok(what);
      warnLeft();
    }
    return failed ? 1 : 0;
  }
  if (!total) {
    // A routing record whose entry is already gone (edited by hand): forget it, so the hook stops restarting the proxy.
    if (scope === "user") for (const a of adapters) if (isProxyAgent(a.id) && readProxyInstalls(c.env)[a.id]) await applyProxyUninstall(a.id, undefined, c.env);
    if (out.json) out.data({ outcome: failed || left.length ? "partial" : "unchanged", scope, agents: plans.filter((p) => p.errors.length).map((p) => ({ id: p.id, error: errorJson(p), changes: [] })), ...leftJson() });
    else if (left.length) warnLeft();
    // Nothing to change is not nothing installed when a file couldn't be read: its row says which.
    else if (!failed) out.ok(what);
    return failed || left.length ? 1 : 0;
  }
  // The command line, for a run in-process without one.
  const asRun = scope === "project" ? ["uninstall", "--scope", "project"] : ["uninstall"];
  if (proxyOnly) asRun.push("--proxy");
  await requireConsent(
    c,
    proxyOnly ? `Stop routing ${plural(pending.length, "agent")} through the proxy (${plural(total, "file")})?` : `Remove coding.sh from ${plural(pending.length, "agent")} (${plural(total, "file")})?`,
    rerunWithYes(c, asRun),
  );

  // Every agent with a change or an error, in plan order; one whose plan failed outright stays as planned.
  const done: ({ id: string } & Removal)[] = [];
  for (const p of plans) {
    if (!p.changes.length) {
      if (p.errors.length) done.push({ id: p.id, changes: [], errors: p.errors });
      continue;
    }
    const a = adapters.find((x) => x.id === p.id)!;
    const r = await removeAll(a, opts(false));
    done.push({ id: p.id, ...r });
    if (r.changes.length || !r.errors.length) out.row(p.name, "removed", "ok");
    // The plan's rows already named its errors.
    for (const e of r.errors) if (!p.errors.includes(e)) out.row(p.name, `couldn't remove: ${e}`, "fail");
  }
  const errors = failed || done.some((d) => d.errors.length);
  if (out.json) out.data({ outcome: errors || left.length ? "partial" : "removed", scope, agents: done.map((d) => ({ id: d.id, error: errorJson(d), changes: d.changes.map((ch) => ({ path: ch.path, action: ch.action, summary: ch.summary })) })), ...leftJson() });
  else {
    for (const d of done) for (const ch of d.changes) out.print(ch.path);
    warnLeft();
  }
  return errors || left.length ? 1 : 0;
}
