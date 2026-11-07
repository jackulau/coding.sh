// Registering the coding.sh MCP server in an agent's own config file, as
// FileChanges like hook installs: planned first (dry runs stop there), backed up
// to ~/.coding.sh/backups, written atomically.
//
// Uninstall is exact when it can be: install records the sha256 of the text it
// wrote and the backup of the file as it was before (installs.json). While the
// file still has that hash, uninstall puts the original bytes back (or deletes a
// file coding.sh created). Once the agent or the user has edited the file, only
// the coding.sh entry is removed.
import { rm } from "node:fs/promises";
import { parseToml } from "../../core/toml.ts";
import type { Adapter, FileChange, McpServerSpec } from "../../core/types.ts";
import { atomicWrite, backupFile, isObject, parseJsonObject, planEdit, planJsonEdit, readTextIfExists } from "./files.ts";
import { forgetInstall, installRecord, recordInstall, sha256 } from "./installs.ts";
import { assertValidToml, hasTomlBlock, removeTomlBlock, upsertTomlBlock } from "./toml-edit.ts";

export type McpTarget =
  | {
      agent: string;
      file: string;
      format: "json";
      /** Top-level key holding the servers object ("mcpServers", OpenCode's "mcp"). */
      key: string;
      /** The agent's entry for one server. */
      entry(s: McpServerSpec): Record<string, unknown>;
    }
  | { agent: string; file: string; format: "toml" };

/** Block id for Codex config.toml (`# >>> coding.sh:mcp-server`). */
const TOML_BLOCK = "mcp-server";

/** Standard `{ command, args }` entry (Cursor, Gemini CLI). */
export const commandArgsEntry = (s: McpServerSpec): Record<string, unknown> => ({ command: s.command, args: s.args });

function tomlString(s: string): string {
  // JSON string escapes are a subset of TOML basic-string escapes.
  return JSON.stringify(s);
}

export function tomlBody(s: McpServerSpec): string {
  return [`[mcp_servers.${s.name}]`, `command = ${tomlString(s.command)}`, `args = [${s.args.map(tomlString).join(", ")}]`].join("\n");
}

function jsonServers(t: Extract<McpTarget, { format: "json" }>, cfg: Record<string, unknown>): Record<string, unknown> | undefined {
  const v = cfg[t.key];
  if (v === undefined) return undefined;
  if (!isObject(v)) throw new Error(`${t.file}: "${t.key}" is not an object; refusing to modify it`);
  return v;
}

/** True when `text` (the target file's content) already has a server named `name`. */
export function hasMcpServer(t: McpTarget, text: string | undefined, name: string): boolean {
  if (text === undefined || text.trim() === "") return false;
  try {
    if (t.format === "json") return jsonServers(t, parseJsonObject(t.file, text))?.[name] !== undefined;
    const servers = parseToml(text, t.file).mcp_servers;
    return isObject(servers) && servers[name] !== undefined;
  } catch {
    return false;
  }
}

/** Plan: add or update our server entry. Undefined when it is already current. */
export function planMcpInstall(t: McpTarget, server: McpServerSpec): FileChange | undefined {
  const summary = `register the coding.sh MCP server (${server.name})`;
  if (t.format === "json") {
    return planJsonEdit(
      t.file,
      (cfg) => {
        const servers = { ...(jsonServers(t, cfg) ?? {}) };
        servers[server.name] = t.entry(server);
        cfg[t.key] = servers;
        return cfg;
      },
      summary,
    );
  }
  const before = readTextIfExists(t.file);
  if (before !== undefined && before.trim() !== "") assertValidToml(before, t.file);
  // A server of that name the user wrote by hand (outside our block) is theirs: leave it.
  if (!hasTomlBlock(before, TOML_BLOCK) && hasMcpServer(t, before, server.name)) return undefined;
  const after = upsertTomlBlock(before, TOML_BLOCK, tomlBody(server));
  assertValidToml(after, t.file);
  return planEdit(t.file, before, after, summary);
}

/** Plan: remove our server, restoring the original bytes when the file is untouched since install. */
export function planMcpUninstall(t: McpTarget, name: string, env: NodeJS.ProcessEnv = process.env): FileChange | undefined {
  const text = readTextIfExists(t.file);
  if (text === undefined) return undefined;
  const rec = installRecord(t.file, env);
  if (rec && rec.restore !== undefined && rec.sha256 === sha256(text)) {
    if (rec.restore === null) return planEdit(t.file, text, undefined, "remove the coding.sh MCP server (coding.sh created this file)");
    const original = readTextIfExists(rec.restore);
    if (original !== undefined) return planEdit(t.file, text, original, "remove the coding.sh MCP server (restore the file as it was)");
  }
  const summary = "remove the coding.sh MCP server";
  if (t.format === "toml") return hasTomlBlock(text, TOML_BLOCK) ? planEdit(t.file, text, removeTomlBlock(text, TOML_BLOCK), summary) : undefined;
  if (!hasMcpServer(t, text, name)) return undefined;
  return planJsonEdit(
    t.file,
    (cfg) => {
      const servers = { ...(jsonServers(t, cfg) ?? {}) };
      delete servers[name];
      if (Object.keys(servers).length) cfg[t.key] = servers;
      else delete cfg[t.key];
      return Object.keys(cfg).length ? cfg : undefined;
    },
    summary,
  );
}

/** Writes a planned install, backing up first and recording what to restore on uninstall. */
async function applyInstall(t: McpTarget, c: FileChange, server: McpServerSpec, env: NodeJS.ProcessEnv, now: number): Promise<void> {
  const before = c.before;
  const rec = installRecord(t.file, env);
  let restore: string | null | undefined;
  let fromBackup = false;
  if (before === undefined) restore = null;
  else if (rec && rec.restore !== undefined && rec.sha256 === sha256(before)) restore = rec.restore; // re-install over our own untouched write
  else if (!hasMcpServer(t, before, server.name)) fromBackup = true;
  const backup = await backupFile(t.agent, t.file, env, now);
  if (backup) c.summary += ` (backup: ${backup})`;
  if (fromBackup) restore = backup ?? null;
  await atomicWrite(t.file, c.after ?? "");
  recordInstall(t.agent, t.file, c.after ?? "", env, now, restore);
}

async function applyUninstall(t: McpTarget, c: FileChange, env: NodeJS.ProcessEnv, now: number): Promise<void> {
  const backup = await backupFile(t.agent, t.file, env, now);
  if (backup) c.summary += ` (backup: ${backup})`;
  if (c.action === "delete") await rm(t.file, { force: true });
  else await atomicWrite(t.file, c.after ?? "");
  forgetInstall(t.file, env);
}

/** installMcp/uninstallMcp for an adapter whose MCP config lives in `target()`. */
export function mcpInstaller(target: (env: NodeJS.ProcessEnv) => McpTarget): Required<Pick<Adapter, "installMcp" | "uninstallMcp">> {
  return {
    async installMcp({ server, dryRun }) {
      const env = process.env;
      const t = target(env);
      const c = planMcpInstall(t, server);
      if (!c) return [];
      if (!dryRun) await applyInstall(t, c, server, env, Date.now());
      return [c];
    },
    async uninstallMcp({ name, dryRun }) {
      const env = process.env;
      const t = target(env);
      const c = planMcpUninstall(t, name, env);
      if (!c) return [];
      if (!dryRun) await applyUninstall(t, c, env, Date.now());
      return [c];
    },
  };
}
