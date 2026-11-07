// coding.sh uninstall: remove coding.sh hooks and MCP server entries from
// agents. An MCP config untouched since init is restored byte-for-byte;
// otherwise only the coding.sh entry goes. Captured data and the hook bin in
// ~/.coding.sh are kept (other scopes may still use the bin).
import { ADAPTERS } from "../../adapters/index.ts";
import type { Adapter, FileChange } from "../../core/types.ts";
import { MCP_CONFIG_NAME } from "../../mcp/launch.ts";
import { changeJson, printChanges } from "../changes.ts";
import { list, requireConsent, str } from "../common.ts";
import { plural } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { pickAdapters } from "./init.ts";

/** MCP entries first: for agents that keep hooks and MCP in one file, the exact restore applies before hooks are stripped. */
async function removeAll(a: Adapter, opts: { scope: "user" | "project"; projectDir: string; dryRun: boolean }): Promise<FileChange[]> {
  const mcp = opts.scope === "user" && a.uninstallMcp ? await a.uninstallMcp({ name: MCP_CONFIG_NAME, dryRun: opts.dryRun }) : [];
  return [...mcp, ...(await a.uninstall(opts))];
}

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const named = list(c.flags.agent);
  const scope = (str(c.flags.scope) ?? "user") as "user" | "project";
  const dryRun = c.flags["dry-run"] === true;
  const adapters = named.length ? pickAdapters(named) : ADAPTERS;

  const plans: { id: string; name: string; changes: FileChange[]; error?: string }[] = [];
  for (const a of adapters) {
    try {
      plans.push({ id: a.id, name: a.displayName, changes: await removeAll(a, { scope, projectDir: c.cwd, dryRun: true }) });
    } catch (e) {
      plans.push({ id: a.id, name: a.displayName, changes: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  const pending = plans.filter((p) => p.changes.length);
  const total = pending.reduce((n, p) => n + p.changes.length, 0);
  for (const p of plans) {
    if (p.error) out.row(p.name, `can't plan: ${p.error}`, "fail");
    else if (p.changes.length) out.row(p.name, `${plural(p.changes.length, "file")} to change`);
  }
  const failed = plans.some((p) => p.error);

  if (dryRun) {
    if (out.json) out.data({ outcome: "planned", scope, agents: plans.map((p) => ({ id: p.id, error: p.error ?? null, changes: p.changes.map(changeJson) })) });
    else {
      for (const p of pending) printChanges(out, p.changes, p.id);
      if (!total) out.ok("No coding.sh hooks or MCP entries installed");
    }
    return failed ? 1 : 0;
  }
  if (!total) {
    if (out.json) out.data({ outcome: "unchanged", scope, agents: [] });
    else out.ok("No coding.sh hooks or MCP entries installed");
    return failed ? 1 : 0;
  }
  await requireConsent(c, `Remove coding.sh from ${plural(pending.length, "agent")} (${plural(total, "file")})?`, `coding.sh uninstall${scope === "project" ? " --scope project" : ""} --yes`);

  const done: { id: string; changes: FileChange[]; error?: string }[] = [];
  for (const p of pending) {
    const a = adapters.find((x) => x.id === p.id)!;
    try {
      const changes = await removeAll(a, { scope, projectDir: c.cwd, dryRun: false });
      done.push({ id: p.id, changes });
      out.row(p.name, "removed", "ok");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      done.push({ id: p.id, changes: [], error: msg });
      out.row(p.name, `couldn't remove: ${msg}`, "fail");
    }
  }
  const errors = done.some((d) => d.error);
  if (out.json) out.data({ outcome: errors ? "partial" : "removed", scope, agents: done.map((d) => ({ id: d.id, error: d.error ?? null, changes: d.changes.map((ch) => ({ path: ch.path, action: ch.action, summary: ch.summary })) })) });
  else for (const d of done) for (const ch of d.changes) out.print(ch.path);
  return errors || failed ? 1 : 0;
}
