// `init --proxy`: point an agent's model API at the local proxy, in the agent's
// own user config, and undo it on `uninstall`.
//
// Claude Code: `env.ANTHROPIC_BASE_URL` in ~/.claude/settings.json.
// Codex: a `[model_providers.coding-sh]` table (the Responses API at the proxy,
// the user's own OpenAI or ChatGPT login) and a top-level `model_provider =
// "coding-sh"`. Codex's `openai_base_url` would also work, but makes Codex try
// a WebSocket first and wait out its retries before falling back to HTTP.
//
// Chaining: when the agent already calls another base URL (a gateway, a
// CLIProxyAPI), the proxy goes in front of it instead of replacing it. That URL
// is Claude Code's ANTHROPIC_BASE_URL (in settings.json, else in the
// environment init runs in), or for Codex the base_url of its own
// model_provider, else `openai_base_url`, else OPENAI_BASE_URL. The agent gets
// the proxy's origin with that URL's path (`https://gw.example.com/anthropic`
// becomes `http://127.0.0.1:4319/anthropic`) and the URL's origin becomes the
// proxy's upstream for that provider (chainedUpstreams in state.ts), so every
// request reaches the same URL as before. A custom Codex provider keeps its
// table (auth, headers, wire API): only its base_url changes. `--force`
// replaces the URL instead of chaining through it.
//
// Every write is backed up first. ~/.coding.sh/proxy-installs.json records,
// per agent, the URL we wrote, the URL we chain through, the value we replaced
// (if any), the sha256 of the text we wrote and the backup of the file before.
// Uninstall restores the backup byte-for-byte while the file is still exactly
// what we wrote, and otherwise removes only our entries (putting back a value
// we replaced). While that record exists, the hook restarts a stopped proxy on
// session start.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeConfigDir } from "../adapters/claude-code.ts";
import { codexHome } from "../adapters/codex.ts";
import { atomicWrite, backupFile, ConfigParseError, isObject, planEdit, readTextIfExists, resolveWriteTarget, stringifyJsonLike } from "../adapters/_shared/files.ts";
import { sha256 } from "../adapters/_shared/installs.ts";
import { editJsonc, parseJsonc } from "../adapters/_shared/jsonc.ts";
import { assertValidToml, ensureTomlKey, removeTomlTable, revertTomlKey, upsertTomlTable } from "../adapters/_shared/toml-edit.ts";
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

/** Where an agent's calls go: the URL written into its config, and the base URL behind the proxy. */
export interface ProxyRoute {
  /** The value written: Claude Code's ANTHROPIC_BASE_URL, or the Codex provider's base_url. */
  target: string;
  /** The base URL the agent called before, now behind the proxy; absent when it called the provider's own API. */
  chained?: string;
  /** The origin of `chained`: where the proxy sends this provider's calls. */
  upstream?: string;
  /** Codex: the provider whose base_url points at the proxy (coding-sh, or the user's own). */
  provider?: string;
}

/** A planned install, with the route it sets up. */
export type ProxyChange = FileChange & { route: ProxyRoute };

export interface ProxyInstall extends ProxyRoute {
  file: string;
  /** The proxy's URL (its origin). */
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

// ---------------------------------------------------------------- routes

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** Whether `base` already points at the proxy at `proxy` (any path). */
function atProxy(base: string, proxy: string): boolean {
  try {
    return new URL(base).origin === new URL(proxy).origin;
  } catch {
    return false;
  }
}

/**
 * The route for an agent that calls `chained` (or the provider's own API when
 * undefined). `suffix` is the path the agent gets without a chain.
 */
function routeFor(proxy: string, chained: string | undefined, suffix: string, what: string): ProxyRoute {
  const root = trimSlash(proxy);
  if (chained === undefined) return { target: `${root}${suffix}` };
  let u: URL | undefined;
  try {
    u = new URL(chained);
  } catch {
    u = undefined;
  }
  // Credentials in the URL would end up in the install record: never chain through those.
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.search || u.hash || u.username || u.password) {
    throw new Error(`${what} is not a plain http(s) URL the proxy can chain through; run init --proxy --force to replace it`);
  }
  return { target: `${root}${trimSlash(u.pathname)}`, chained, upstream: u.origin };
}

const envUrl = (env: NodeJS.ProcessEnv, name: string, proxy: string): string | undefined => {
  const v = env[name]?.trim();
  return v && !atProxy(v, proxy) ? v : undefined;
};

/** The value written for this record (records from before `target` existed hold only the proxy URL). */
const targetOf = (agent: ProxyAgent, rec: ProxyInstall): string => rec.target ?? (agent === "codex" ? `${trimSlash(rec.url)}/v1` : rec.url);

const withRoute = (c: FileChange | undefined, route: ProxyRoute): ProxyChange | undefined => (c ? Object.assign(c, { route }) : undefined);

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

function codexBody(baseUrl: string): string {
  return [`[${CODEX_TABLE}]`, `name = "coding.sh proxy"`, `base_url = ${tomlStr(baseUrl)}`, `wire_api = "responses"`, `requires_openai_auth = true`, `supports_websockets = false`].join("\n");
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

interface CodexState {
  provider?: string;
  /** Our [model_providers.coding-sh] table. */
  table?: Record<string, unknown>;
  providers: Record<string, unknown>;
  openaiBaseUrl?: string;
}

function codexState(file: string, text: string | undefined): CodexState {
  if (text === undefined || text.trim() === "") return { providers: {} };
  const v = parseToml(text, file);
  const providers = isObject(v.model_providers) ? v.model_providers : {};
  const table = providers[CODEX_PROVIDER];
  return {
    ...(typeof v.model_provider === "string" ? { provider: v.model_provider } : {}),
    ...(isObject(table) ? { table } : {}),
    providers,
    ...(typeof v.openai_base_url === "string" && v.openai_base_url.trim() ? { openaiBaseUrl: v.openai_base_url.trim() } : {}),
  };
}

const providerBaseUrl = (st: CodexState, id: string): string | undefined => {
  const t = st.providers[id];
  return isObject(t) && typeof t.base_url === "string" ? t.base_url : undefined;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Points the user's provider `id` back from `target` to `chained`: our tagged line first, else the line holding `target`. */
function unrouteProvider(file: string, text: string, id: string, target: string, chained: string): string | undefined {
  const reverted = revertTomlKey(text, `model_providers.${id}`, "base_url");
  if (providerBaseUrl(codexState(file, reverted), id) === chained) return reverted;
  const replaced = text.replace(new RegExp(`^(\\s*"?base_url"?\\s*=\\s*)${escapeRe(tomlStr(target))}[^\\r\\n]*`, "m"), (_m, pre: string) => `${pre}${tomlStr(chained)}`);
  return providerBaseUrl(codexState(file, replaced), id) === chained ? replaced : undefined;
}

/** Codex's own provider `id` (a gateway, a CLIProxyAPI): its base_url goes through the proxy, the rest stays. */
function planCodexProvider(file: string, before: string, st: CodexState, id: string, o: ProxyPlanOpts, rec: ProxyInstall | undefined): ProxyChange | undefined {
  const base = providerBaseUrl(st, id);
  if (base === undefined) {
    throw new Error(`${file} uses model_provider = "${id}" with no base_url to chain through. Run init --proxy --force to switch Codex to OpenAI through the proxy`);
  }
  let text = before;
  let chained = base;
  if (rec?.provider === id && rec.chained !== undefined && base === targetOf("codex", rec)) {
    // Our own earlier write (a new port): start again from the URL it replaced.
    const back = unrouteProvider(file, before, id, base, rec.chained);
    if (back === undefined) throw new Error(`${file}: could not find [model_providers.${id}] base_url to update; refusing to modify it`);
    text = back;
    chained = rec.chained;
  } else if (atProxy(base, o.url)) {
    return undefined; // pointed at the proxy by hand
  }
  const route: ProxyRoute = { ...routeFor(o.url, chained, "", `${file}: [model_providers.${id}] base_url`), provider: id };
  if (base === route.target) return undefined;
  const after = ensureTomlKey(text, `model_providers.${id}`, "base_url", tomlStr(route.target));
  assertValidToml(after, file);
  const check = codexState(file, after);
  if (check.provider !== id || providerBaseUrl(check, id) !== route.target) throw new Error(`${file}: could not point [model_providers.${id}] at the proxy; refusing to modify it`);
  return withRoute(planEdit(file, before, after, `route Codex's "${id}" provider through the proxy (base_url = ${route.target}; calls go on to ${chained})`), route);
}

// ---------------------------------------------------------------- plan

export interface ProxyPlanOpts {
  url: string;
  env?: NodeJS.ProcessEnv;
  /** Replace a base URL / provider the user set themselves instead of chaining through it. */
  force?: boolean;
}

/** The file change that routes `agent` through the proxy at `url`; undefined when it already is. Throws on a conflict. */
export function planProxyInstall(agent: ProxyAgent, o: ProxyPlanOpts): ProxyChange | undefined {
  const env = o.env ?? process.env;
  const file = proxyConfigFile(agent, env);
  const before = readTextIfExists(file);
  const rec = readProxyInstalls(env)[agent];
  if (agent === "claude-code") {
    const cfg = parseSettings(file, before);
    const cur = claudeBaseUrl(cfg);
    const mine = cur !== undefined && ((rec !== undefined && cur === targetOf(agent, rec)) || atProxy(cur, o.url));
    const fromFile = cur !== undefined && !mine;
    const chained = o.force ? undefined : mine ? rec?.chained : fromFile ? cur : envUrl(env, "ANTHROPIC_BASE_URL", o.url);
    const route = routeFor(o.url, chained, "", fromFile ? `${file}: ANTHROPIC_BASE_URL` : "ANTHROPIC_BASE_URL in your environment");
    if (cur === route.target) return undefined;
    const next = structuredClone(cfg);
    next.env = { ...((cfg.env as Record<string, unknown> | undefined) ?? {}), ANTHROPIC_BASE_URL: route.target };
    const via = route.chained ? `; calls go on to ${route.chained}` : "";
    return withRoute(planEdit(file, before, jsonText(before, next), `route Claude Code through the proxy (env.ANTHROPIC_BASE_URL = ${route.target}${via})`), route);
  }
  if (before !== undefined && before.trim() !== "") assertValidToml(before, file);
  const st = codexState(file, before);
  if (st.table && !(rec && before !== undefined)) {
    // A provider of that id we never wrote is the user's.
    throw new Error(`${file} already has [${CODEX_TABLE}], not written by coding.sh; refusing to modify it`);
  }
  if (st.provider !== undefined && st.provider !== CODEX_PROVIDER && st.provider !== "openai" && !o.force) return planCodexProvider(file, before ?? "", st, st.provider, o, rec);
  const ours = st.provider === CODEX_PROVIDER && rec?.provider === CODEX_PROVIDER;
  const chained = o.force ? undefined : ours ? rec?.chained : st.openaiBaseUrl !== undefined && !atProxy(st.openaiBaseUrl, o.url) ? st.openaiBaseUrl : envUrl(env, "OPENAI_BASE_URL", o.url);
  const route: ProxyRoute = { ...routeFor(o.url, chained, "/v1", st.openaiBaseUrl !== undefined ? `${file}: openai_base_url` : "OPENAI_BASE_URL in your environment"), provider: CODEX_PROVIDER };
  let after = upsertTomlTable(before, CODEX_TABLE, codexBody(route.target), MARKER);
  if (after === undefined) throw new Error(`${file}: [${CODEX_TABLE}] is written inline; refusing to modify it`);
  after = setTopLevelProvider(after, CODEX_PROVIDER);
  assertValidToml(after, file);
  const check = codexState(file, after);
  if (check.provider !== CODEX_PROVIDER || check.table?.base_url !== route.target) throw new Error(`${file}: could not write the coding.sh provider; refusing to modify it`);
  if (after === before) return undefined;
  const via = route.chained ? `; calls go on to ${route.chained}` : "";
  return withRoute(planEdit(file, before, after, `route Codex through the proxy (model_provider = "${CODEX_PROVIDER}", ${route.target}${via})`), route);
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
  const target = targetOf(agent, rec);
  if (agent === "claude-code") {
    const cfg = parseSettings(file, text);
    if (claudeBaseUrl(cfg) !== target) return undefined; // changed since: no longer ours
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
  if (rec.provider !== undefined && rec.provider !== CODEX_PROVIDER) {
    // The user's own provider: put its base_url back.
    if (rec.chained === undefined || providerBaseUrl(st, rec.provider) !== target) return undefined;
    const after = unrouteProvider(file, text, rec.provider, target, rec.chained);
    if (after === undefined) return undefined;
    assertValidToml(after, file);
    return planEdit(file, text, after, summary);
  }
  let after = text;
  if (st.provider === CODEX_PROVIDER) after = setTopLevelProvider(after, rec.previous);
  if (st.table && st.table.base_url === target) after = removeTomlTable(after, CODEX_TABLE, MARKER) ?? after;
  if (after === text) return undefined;
  assertValidToml(after, file);
  return planEdit(file, text, after, summary);
}

// ---------------------------------------------------------------- apply

/** Writes a planned install (backup first) and records it. */
export async function applyProxyInstall(agent: ProxyAgent, c: FileChange & { route?: ProxyRoute }, url: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<void> {
  const all = readProxyInstalls(env);
  const prev = all[agent];
  const file = c.path;
  const route: ProxyRoute = c.route ?? { target: agent === "codex" ? `${trimSlash(url)}/v1` : url, ...(agent === "codex" ? { provider: CODEX_PROVIDER } : {}) };
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
      previous = cur !== undefined && (!prev || cur !== targetOf(agent, prev)) ? cur : prev?.previous;
      envCreated = cfg.env === undefined;
    } else if (route.provider === CODEX_PROVIDER) {
      const cur = codexState(file, c.before).provider;
      previous = cur !== undefined && cur !== CODEX_PROVIDER ? cur : prev?.previous;
    }
  }
  await atomicWrite(file, c.after ?? "");
  const { target, chained, upstream, provider } = route;
  all[agent] = {
    file,
    url,
    target,
    ...(chained !== undefined ? { chained } : {}),
    ...(upstream !== undefined ? { upstream } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(previous !== undefined ? { previous } : {}),
    ...(envCreated ? { envCreated } : {}),
    sha256: sha256(c.after ?? ""),
    restore,
    ts: now,
  };
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

export interface ProxyRouteStatus {
  agent: ProxyAgent;
  file: string;
  /** What the agent's config holds now; undefined when the entry is gone. */
  url?: string;
  /** What init --proxy wrote. */
  expected: string;
  /** The base URL behind the proxy, when chained. */
  chained?: string;
}

/** Where each routed agent points now (doctor). */
export function proxyRoutes(env: NodeJS.ProcessEnv = process.env): ProxyRouteStatus[] {
  const out: ProxyRouteStatus[] = [];
  for (const [agent, rec] of Object.entries(readProxyInstalls(env)) as [ProxyAgent, ProxyInstall][]) {
    const text = readTextIfExists(rec.file);
    let url: string | undefined;
    try {
      if (agent === "claude-code") url = claudeBaseUrl(parseSettings(rec.file, text));
      else {
        const st = codexState(rec.file, text);
        const provider = rec.provider ?? CODEX_PROVIDER;
        url = st.provider === provider ? providerBaseUrl(st, provider) : undefined;
      }
    } catch {
      url = undefined;
    }
    out.push({ agent, file: rec.file, ...(url !== undefined ? { url } : {}), expected: targetOf(agent, rec), ...(rec.chained !== undefined ? { chained: rec.chained } : {}) });
  }
  return out;
}
