// Registering the coding.sh MCP server in an agent's own config file, as
// FileChanges like hook installs: planned first (dry runs stop there), backed up
// to ~/.coding.sh/backups, written atomically.
//
// Uninstall is exact when it can be: install records the sha256 of the text it
// wrote and the backup of the file as it was before (installs.json). While the
// file still has that hash, uninstall puts the original bytes back (or deletes a
// file coding.sh created). Once the agent or the user has edited the file, only
// the coding.sh entry is removed.
//
// JSON configs are edited as JSONC in place (Gemini CLI settings.json carries
// comments): only our server entry changes. The Codex TOML entry is found by
// its [mcp_servers.<name>] header, and it is ours when it matches what
// installs.json says we wrote (or still carries our legacy block markers), so
// `codex mcp add`, which rewrites the file and drops comments, can't orphan it.
import { rm } from "node:fs/promises";
import { parseToml } from "../../core/toml.ts";
import type { Adapter, FileChange, McpServerSpec } from "../../core/types.ts";
import { atomicWrite, backupFile, ConfigParseError, isObject, planEdit, readTextIfExists, stringifyJsonLike } from "./files.ts";
import { forgetInstall, installRecord, recordInstall, sha256 } from "./installs.ts";
import { editJsonc, jsonEqual, parseJsonc } from "./jsonc.ts";
import { assertValidToml, hasTomlMarker, removeTomlTable, upsertTomlTable } from "./toml-edit.ts";

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

/** Legacy block id for Codex config.toml (`# >>> coding.sh:mcp-server`); markers are cleaned up, no longer written. */
const TOML_BLOCK = "mcp-server";

/** Standard `{ command, args }` entry (Cursor, Gemini CLI). */
export const commandArgsEntry = (s: McpServerSpec): Record<string, unknown> => ({ command: s.command, args: s.args });

function tomlString(s: string): string {
  // JSON string escapes are a subset of TOML basic-string escapes.
  return JSON.stringify(s);
}

const tomlKey = (name: string) => (/^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name));

export function tomlBody(s: McpServerSpec): string {
  return [`[mcp_servers.${tomlKey(s.name)}]`, `command = ${tomlString(s.command)}`, `args = [${s.args.map(tomlString).join(", ")}]`].join("\n");
}

/** Parses a JSON(C) object config; empty/missing → {}. Throws ConfigParseError when it can't be parsed. */
function parseJsonConfig(file: string, text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === "") return {};
  let v: unknown;
  try {
    v = parseJsonc(text);
  } catch (e) {
    throw new ConfigParseError(file, e);
  }
  if (!isObject(v)) throw new ConfigParseError(file, new Error("top level is not an object"));
  return v;
}

/** New text for a JSON(C) config: edited in place (comments kept), or fresh JSON for a new file. */
function jsonText(before: string | undefined, next: Record<string, unknown>): string {
  return before === undefined || before.trim() === "" ? stringifyJsonLike(next, before) : editJsonc(before, next);
}

function jsonServers(t: Extract<McpTarget, { format: "json" }>, cfg: Record<string, unknown>): Record<string, unknown> | undefined {
  const v = cfg[t.key];
  if (v === undefined) return undefined;
  if (!isObject(v)) throw new Error(`${t.file}: "${t.key}" is not an object; refusing to modify it`);
  return v;
}

function tomlServers(file: string, text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === "") return {};
  const servers = parseToml(text, file).mcp_servers;
  return isObject(servers) ? servers : {};
}

/** True when `text` (the target file's content) already has a server named `name`. */
export function hasMcpServer(t: McpTarget, text: string | undefined, name: string): boolean {
  try {
    if (t.format === "json") return jsonServers(t, parseJsonConfig(t.file, text))?.[name] !== undefined;
    return tomlServers(t.file, text)[name] !== undefined;
  } catch {
    return false;
  }
}

/** `{ command, args }` of a registered entry in any agent's shape (OpenCode keeps one `command` array). */
export function entryCommand(entry: unknown): { command: string; args: string[] } | undefined {
  if (!isObject(entry)) return undefined;
  const strs = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
  const arr = strs(entry.command);
  if (arr && arr.length) return { command: arr[0]!, args: arr.slice(1) };
  if (typeof entry.command !== "string") return undefined;
  return { command: entry.command, args: strs(entry.args) ?? [] };
}

/** The server entry registered under `name` in the agent's config, or undefined. */
export function readMcpEntry(t: McpTarget, name: string): { command: string; args: string[] } | undefined {
  const text = readTextIfExists(t.file);
  try {
    const entry = t.format === "json" ? jsonServers(t, parseJsonConfig(t.file, text))?.[name] : tomlServers(t.file, text)[name];
    return entryCommand(entry);
  } catch {
    return undefined;
  }
}

/**
 * Whether the Codex [mcp_servers.<name>] entry in `text` is coding.sh's: it
 * matches the entry installs.json records as written by us, or the file still
 * carries our legacy block markers (a whole block, or the orphan END a
 * rewrite left behind). A hand-written entry of the same name is the user's.
 */
function ownsTomlEntry(t: McpTarget, text: string | undefined, name: string, env: NodeJS.ProcessEnv): boolean {
  if (hasTomlMarker(text, TOML_BLOCK)) return true;
  const cur = entryCommand(tomlServers(t.file, text)[name]);
  const rec = installRecord(t.file, env);
  return !!cur && !!rec?.mcp && jsonEqual(cur, rec.mcp);
}

/** Everything in a TOML config except mcp_servers.<name>, for checking that an edit touched nothing else. */
function tomlWithout(file: string, text: string, name: string): string {
  const v = text.trim() ? parseToml(text, file) : {};
  const servers = isObject(v.mcp_servers) ? { ...v.mcp_servers } : undefined;
  if (servers) {
    delete servers[name];
    if (Object.keys(servers).length) v.mcp_servers = servers;
    else delete v.mcp_servers;
  }
  return JSON.stringify(v);
}

function assertOnlyEntryChanged(t: McpTarget, before: string, after: string, name: string): void {
  if (tomlWithout(t.file, before, name) !== tomlWithout(t.file, after, name)) {
    throw new Error(`${t.file}: editing [mcp_servers.${name}] would change other settings; refusing to modify it`);
  }
}

/** Plan: add or update our server entry. Undefined when it is already current. */
export function planMcpInstall(t: McpTarget, server: McpServerSpec, env: NodeJS.ProcessEnv = process.env): FileChange | undefined {
  const summary = `register the coding.sh MCP server (${server.name})`;
  const before = readTextIfExists(t.file);
  if (t.format === "json") {
    const cfg = parseJsonConfig(t.file, before);
    const next = structuredClone(cfg);
    next[t.key] = { ...(jsonServers(t, cfg) ?? {}), [server.name]: t.entry(server) };
    if (before !== undefined && jsonEqual(cfg, next)) return undefined;
    return planEdit(t.file, before, jsonText(before, next), summary);
  }
  if (before !== undefined && before.trim() !== "") assertValidToml(before, t.file);
  // A server of that name the user wrote by hand is theirs: leave it.
  if (hasMcpServer(t, before, server.name) && !ownsTomlEntry(t, before, server.name, env)) return undefined;
  const after = upsertTomlTable(before, `mcp_servers.${server.name}`, tomlBody(server), TOML_BLOCK);
  if (after === undefined) return undefined; // inline or dotted-key form: not a table we can edit safely
  assertValidToml(after, t.file);
  const entry = entryCommand(tomlServers(t.file, after)[server.name]);
  if (!entry || !jsonEqual(entry, { command: server.command, args: server.args })) throw new Error(`${t.file}: could not write [mcp_servers.${server.name}]; refusing to modify it`);
  assertOnlyEntryChanged(t, before ?? "", after, server.name);
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
  if (t.format === "toml") {
    if (!hasMcpServer(t, text, name)) {
      // No entry, but orphan markers from an older install: tidy them away.
      if (!hasTomlMarker(text, TOML_BLOCK)) return undefined;
      const after = text.split(/\r?\n/).filter((l) => !hasTomlMarker(l, TOML_BLOCK)).join(text.includes("\r\n") ? "\r\n" : "\n");
      return planEdit(t.file, text, after, summary);
    }
    if (!ownsTomlEntry(t, text, name, env)) return undefined;
    const after = removeTomlTable(text, `mcp_servers.${name}`, TOML_BLOCK);
    if (after === undefined) return undefined;
    assertValidToml(after, t.file);
    assertOnlyEntryChanged(t, text, after, name);
    if (hasMcpServer(t, after, name)) return undefined;
    return planEdit(t.file, text, after, summary);
  }
  const cfg = parseJsonConfig(t.file, text);
  const servers = jsonServers(t, cfg);
  if (servers?.[name] === undefined) return undefined;
  const next = structuredClone(cfg);
  const left = { ...servers };
  delete left[name];
  if (Object.keys(left).length) next[t.key] = left;
  else delete next[t.key];
  return planEdit(t.file, text, Object.keys(next).length ? jsonText(text, next) : undefined, summary);
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
  recordInstall(t.agent, t.file, c.after ?? "", env, now, restore, { command: server.command, args: server.args });
}

async function applyUninstall(t: McpTarget, c: FileChange, env: NodeJS.ProcessEnv, now: number): Promise<void> {
  const backup = await backupFile(t.agent, t.file, env, now);
  if (backup) c.summary += ` (backup: ${backup})`;
  if (c.action === "delete") await rm(t.file, { force: true });
  else await atomicWrite(t.file, c.after ?? "");
  forgetInstall(t.file, env);
}

/** Each adapter's MCP target, keyed by its installMcp function (see mcpTargetOf). */
const TARGETS = new WeakMap<object, (env: NodeJS.ProcessEnv) => McpTarget>();

/** Where an adapter registers the MCP server, when it uses mcpInstaller (doctor reads the entry back). */
export function mcpTargetOf(a: Pick<Adapter, "installMcp">, env: NodeJS.ProcessEnv = process.env): McpTarget | undefined {
  const f = a.installMcp && TARGETS.get(a.installMcp);
  return f ? f(env) : undefined;
}

/** installMcp/uninstallMcp for an adapter whose MCP config lives in `target()`. */
export function mcpInstaller(target: (env: NodeJS.ProcessEnv) => McpTarget): Required<Pick<Adapter, "installMcp" | "uninstallMcp">> {
  const installer: Required<Pick<Adapter, "installMcp" | "uninstallMcp">> = {
    async installMcp({ server, dryRun }) {
      const env = process.env;
      const t = target(env);
      const c = planMcpInstall(t, server, env);
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
  TARGETS.set(installer.installMcp, target);
  return installer;
}
