// `init --proxy`: point an agent's model API at the local proxy, in the agent's
// own user config, and undo it on `uninstall`.
//
// Claude Code: `env.ANTHROPIC_BASE_URL` in ~/.claude/settings.json.
// Codex: a `[model_providers.coding-sh]` table (the Responses API at the proxy,
// the user's own OpenAI or ChatGPT login) and a top-level `model_provider =
// "coding-sh"`. Codex's `openai_base_url` would also work, but makes Codex try
// a WebSocket first and wait out its retries before falling back to HTTP.
//
// Every write is backed up first. ~/.coding.sh/proxy-installs.json records,
// per agent, the URL we wrote, the value we replaced (if any), the sha256 of
// the text we wrote and the backup of the file before. Uninstall restores the
// backup byte-for-byte while the file is still exactly what we wrote, and
// otherwise removes only our entries (putting back a value we replaced).
// While that record exists, the hook restarts a stopped proxy on session start.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeConfigDir } from "../adapters/claude-code.ts";
import { codexHome } from "../adapters/codex.ts";
import { atomicWrite, backupFile, ConfigParseError, isObject, planEdit, readTextIfExists, resolveWriteTarget, stringifyJsonLike } from "../adapters/_shared/files.ts";
import { sha256 } from "../adapters/_shared/installs.ts";
import { editJsonc, parseJsonc } from "../adapters/_shared/jsonc.ts";
import { assertValidToml, removeTomlTable, upsertTomlTable } from "../adapters/_shared/toml-edit.ts";
import { paths } from "../core/paths.ts";
import { parseToml } from "../core/toml.ts";
import type { FileChange } from "../core/types.ts";

/** Agents `init --proxy` can route. Others take the variables from `coding.sh proxy env`. */
export const PROXY_AGENTS = ["claude-code", "codex"] as const;
export type ProxyAgent = (typeof PROXY_AGENTS)[number];

export const isProxyAgent = (id: string): id is ProxyAgent => (PROXY_AGENTS as readonly string[]).includes(id);

/** The Codex provider id coding.sh adds. */
export const CODEX_PROVIDER = "coding-sh";
const CODEX_TABLE = `model_providers.${CODEX_PROVIDER}`;
const MARKER = "proxy-provider";

export interface ProxyInstall {
  file: string;
  /** The proxy URL written (Codex gets `<url>/v1`). */
  url: string;
  /** The value replaced (Claude Code's ANTHROPIC_BASE_URL, Codex's model_provider); absent when there was none. */
  previous?: string;
  /** Claude Code: settings.json had no `env` object before. */
  envCreated?: boolean;
  /** sha256 of the text written. */
  sha256: string;
  /** Backup of the file as it was before, or null when coding.sh created it. */
  restore: string | null;
  ts: number;
}

interface InstallsFile {
  v: 1;
  agents: Partial<Record<ProxyAgent, ProxyInstall>>;
}

export function readProxyInstalls(env: NodeJS.ProcessEnv = process.env): InstallsFile["agents"] {
  try {
    const v = JSON.parse(readFileSync(paths(env).proxyInstalls, "utf8")) as Partial<InstallsFile>;
    if (v && isObject(v.agents)) return v.agents as InstallsFile["agents"];
  } catch {
    // missing or unreadable: nothing routed
  }
  return {};
}

function saveProxyInstalls(agents: InstallsFile["agents"], env: NodeJS.ProcessEnv): void {
  const file = resolveWriteTarget(paths(env).proxyInstalls);
  if (!Object.keys(agents).length) {
    rmSync(file, { force: true }); // no file = nothing for the hook to keep running
    return;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.codingsh-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, agents }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** The config file `init --proxy` edits for this agent. */
export function proxyConfigFile(agent: ProxyAgent, env: NodeJS.ProcessEnv = process.env): string {
  return agent === "claude-code" ? join(claudeConfigDir(env), "settings.json") : join(codexHome(env), "config.toml");
}

// ---------------------------------------------------------------- Claude Code

function parseSettings(file: string, text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === "") return {};
  let v: unknown;
  try {
    v = parseJsonc(text);
  } catch (e) {
    throw new ConfigParseError(file, e);
  }
  if (!isObject(v)) throw new ConfigParseError(file, new Error("top level is not an object"));
  if (v.env !== undefined && !isObject(v.env)) throw new Error(`${file}: "env" is not an object; refusing to modify it`);
  return v;
}

const jsonText = (before: string | undefined, next: Record<string, unknown>) => (before === undefined || before.trim() === "" ? stringifyJsonLike(next, before) : editJsonc(before, next));

function claudeBaseUrl(cfg: Record<string, unknown>): string | undefined {
  const v = (cfg.env as Record<string, unknown> | undefined)?.ANTHROPIC_BASE_URL;
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------- Codex

const tomlStr = (s: string) => JSON.stringify(s);

function codexBody(url: string): string {
  return [
    `[${CODEX_TABLE}]`,
    `name = "coding.sh proxy"`,
    `base_url = ${tomlStr(`${url.replace(/\/+$/, "")}/v1`)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    `supports_websockets = false`,
  ].join("\n");
}

const PROVIDER_LINE = /^\s*(model_provider|"model_provider")\s*=/;
const isHeader = (l: string) => /^\s*\[/.test(l);

/** Sets (or, with value undefined, removes) the top-level `model_provider` line. */
function setTopLevelProvider(text: string, value: string | undefined): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  const header = lines.findIndex(isHeader);
  const top = header < 0 ? lines.length : header;
  const at = lines.slice(0, top).findIndex((l) => PROVIDER_LINE.test(l));
  const line = value === undefined ? undefined : `model_provider = ${tomlStr(value)}${value === CODEX_PROVIDER ? " # coding.sh proxy; undo with coding.sh uninstall --proxy" : ""}`;
  if (at >= 0) {
    if (line === undefined) lines.splice(at, 1);
    else lines[at] = line;
    return lines.join(nl);
  }
  if (line === undefined) return text;
  if (!lines.length) return `${line}${nl}`;
  // Before the first table (or at the end of a file of top-level keys), as a top-level key must be.
  if (header < 0) {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return [...lines, line, ""].join(nl);
  }
  // Right after the last top-level line, keeping the blank line before the table.
  let at2 = header;
  while (at2 > 0 && lines[at2 - 1]!.trim() === "") at2--;
  return [...lines.slice(0, at2), line, ...(at2 < header ? [] : [""]), ...lines.slice(at2)].join(nl);
}

function codexState(file: string, text: string | undefined): { provider?: string; table?: Record<string, unknown> } {
  if (text === undefined || text.trim() === "") return {};
  const v = parseToml(text, file);
  const providers = isObject(v.model_providers) ? v.model_providers : {};
  const table = providers[CODEX_PROVIDER];
  return { ...(typeof v.model_provider === "string" ? { provider: v.model_provider } : {}), ...(isObject(table) ? { table } : {}) };
}

// ---------------------------------------------------------------- plan

export interface ProxyPlanOpts {
  url: string;
  env?: NodeJS.ProcessEnv;
  /** Replace a base URL / provider the user set themselves. */
  force?: boolean;
}

/** The file change that routes `agent` through the proxy at `url`; undefined when it already is. Throws on a conflict. */
export function planProxyInstall(agent: ProxyAgent, o: ProxyPlanOpts): FileChange | undefined {
  const env = o.env ?? process.env;
  const file = proxyConfigFile(agent, env);
  const before = readTextIfExists(file);
  const rec = readProxyInstalls(env)[agent];
  if (agent === "claude-code") {
    const cfg = parseSettings(file, before);
    const cur = claudeBaseUrl(cfg);
    if (cur === o.url) return undefined;
    if (cur !== undefined && cur !== rec?.url && !o.force) {
      throw new Error(
        `${file} already sets ANTHROPIC_BASE_URL to ${cur}. Keep it as the proxy's upstream with \`anthropic_upstream = "${cur}"\` under [proxy] in ~/.coding.sh/config.toml, then run init --proxy --force`,
      );
    }
    const next = structuredClone(cfg);
    next.env = { ...((cfg.env as Record<string, unknown> | undefined) ?? {}), ANTHROPIC_BASE_URL: o.url };
    return planEdit(file, before, jsonText(before, next), `route Claude Code through the proxy (env.ANTHROPIC_BASE_URL = ${o.url})`);
  }
  if (before !== undefined && before.trim() !== "") assertValidToml(before, file);
  const st = codexState(file, before);
  if (st.table && !(rec && before !== undefined)) {
    // A provider of that id we never wrote is the user's.
    throw new Error(`${file} already has [${CODEX_TABLE}], not written by coding.sh; refusing to modify it`);
  }
  if (st.provider !== undefined && st.provider !== CODEX_PROVIDER && st.provider !== "openai" && !o.force) {
    throw new Error(
      `${file} uses model_provider = "${st.provider}". Point that provider's base_url at ${o.url}/v1 and set openai_upstream under [proxy] in ~/.coding.sh/config.toml to its old base_url, or run init --proxy --force to switch Codex to OpenAI through the proxy`,
    );
  }
  let after = upsertTomlTable(before, CODEX_TABLE, codexBody(o.url), MARKER);
  if (after === undefined) throw new Error(`${file}: [${CODEX_TABLE}] is written inline; refusing to modify it`);
  after = setTopLevelProvider(after, CODEX_PROVIDER);
  assertValidToml(after, file);
  const check = codexState(file, after);
  if (check.provider !== CODEX_PROVIDER || check.table?.base_url !== `${o.url.replace(/\/+$/, "")}/v1`) throw new Error(`${file}: could not write the coding.sh provider; refusing to modify it`);
  if (after === before) return undefined;
  return planEdit(file, before, after, `route Codex through the proxy (model_provider = "${CODEX_PROVIDER}", ${o.url}/v1)`);
}

/** The file change that undoes `init --proxy` for `agent`; undefined when it is not routed. */
export function planProxyUninstall(agent: ProxyAgent, env: NodeJS.ProcessEnv = process.env): FileChange | undefined {
  const rec = readProxyInstalls(env)[agent];
  if (!rec) return undefined;
  const file = rec.file;
  const text = readTextIfExists(file);
  if (text === undefined) return undefined;
  const summary = agent === "claude-code" ? "stop routing Claude Code through the proxy" : "stop routing Codex through the proxy";
  if (rec.sha256 === sha256(text)) {
    if (rec.restore === null) return planEdit(file, text, undefined, `${summary} (coding.sh created this file)`);
    const original = readTextIfExists(rec.restore);
    if (original !== undefined) return planEdit(file, text, original, `${summary} (restore the file as it was)`);
  }
  if (agent === "claude-code") {
    const cfg = parseSettings(file, text);
    if (claudeBaseUrl(cfg) !== rec.url) return undefined; // changed since: no longer ours
    const next = structuredClone(cfg);
    const envObj = { ...(next.env as Record<string, unknown>) };
    if (rec.previous !== undefined) envObj.ANTHROPIC_BASE_URL = rec.previous;
    else delete envObj.ANTHROPIC_BASE_URL;
    if (Object.keys(envObj).length || !rec.envCreated) next.env = envObj;
    else delete next.env;
    return planEdit(file, text, jsonText(text, next), summary);
  }
  assertValidToml(text, file);
  const st = codexState(file, text);
  let after = text;
  if (st.provider === CODEX_PROVIDER) after = setTopLevelProvider(after, rec.previous);
  if (st.table && st.table.base_url === `${rec.url.replace(/\/+$/, "")}/v1`) after = removeTomlTable(after, CODEX_TABLE, MARKER) ?? after;
  if (after === text) return undefined;
  assertValidToml(after, file);
  return planEdit(file, text, after, summary);
}

// ---------------------------------------------------------------- apply

/** Writes a planned install (backup first) and records it. */
export async function applyProxyInstall(agent: ProxyAgent, c: FileChange, url: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<void> {
  const all = readProxyInstalls(env);
  const prev = all[agent];
  const file = c.path;
  let restore: string | null;
  let previous: string | undefined;
  let envCreated: boolean | undefined;
  const backup = await backupFile(agent, file, env, now);
  if (backup) c.summary += ` (backup: ${backup})`;
  if (prev && c.before !== undefined && prev.sha256 === sha256(c.before)) {
    // Re-install over our own untouched write (a new port): keep what was there first.
    restore = prev.restore;
    previous = prev.previous;
    envCreated = prev.envCreated;
  } else {
    restore = c.before === undefined ? null : (backup ?? null);
    if (agent === "claude-code") {
      const cfg = parseSettings(file, c.before);
      const cur = claudeBaseUrl(cfg);
      previous = cur !== undefined && cur !== prev?.url ? cur : prev?.previous;
      envCreated = cfg.env === undefined;
    } else {
      const cur = codexState(file, c.before).provider;
      previous = cur !== undefined && cur !== CODEX_PROVIDER ? cur : prev?.previous;
    }
  }
  await atomicWrite(file, c.after ?? "");
  all[agent] = { file, url, ...(previous !== undefined ? { previous } : {}), ...(envCreated ? { envCreated } : {}), sha256: sha256(c.after ?? ""), restore, ts: now };
  saveProxyInstalls(all, env);
}

/** Writes a planned uninstall (backup first) and drops the record. */
export async function applyProxyUninstall(agent: ProxyAgent, c: FileChange | undefined, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<void> {
  if (c) {
    const backup = await backupFile(agent, c.path, env, now);
    if (backup) c.summary += ` (backup: ${backup})`;
    if (c.action === "delete") await rm(c.path, { force: true });
    else await atomicWrite(c.path, c.after ?? "");
  }
  const all = readProxyInstalls(env);
  if (!all[agent]) return;
  delete all[agent];
  saveProxyInstalls(all, env);
}

/** Where each routed agent points now (doctor): the configured URL, or undefined when the entry is gone. */
export function proxyRoutes(env: NodeJS.ProcessEnv = process.env): { agent: ProxyAgent; file: string; url?: string; expected: string }[] {
  const out: { agent: ProxyAgent; file: string; url?: string; expected: string }[] = [];
  for (const [agent, rec] of Object.entries(readProxyInstalls(env)) as [ProxyAgent, ProxyInstall][]) {
    const text = readTextIfExists(rec.file);
    let url: string | undefined;
    try {
      if (agent === "claude-code") url = claudeBaseUrl(parseSettings(rec.file, text));
      else {
        const st = codexState(rec.file, text);
        const base = st.provider === CODEX_PROVIDER ? st.table?.base_url : undefined;
        url = typeof base === "string" ? base.replace(/\/v1\/?$/, "") : undefined;
      }
    } catch {
      url = undefined;
    }
    out.push({ agent, file: rec.file, ...(url !== undefined ? { url } : {}), expected: rec.url });
  }
  return out;
}
