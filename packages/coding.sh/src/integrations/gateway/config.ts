// Gateway settings (the [gateway] table in ~/.coding.sh/config.toml, plus one
// [gateway.<name>] table per other gateway) and a read-only scan of agent
// configs for gateway routing. Nothing here writes a
// file or returns a key value: findings name where routing was seen, and the
// key is reported only as "set" plus where it came from.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { interpolateEnv } from "../../core/config.ts";
import { paths, userHome } from "../../core/paths.ts";
import { parseToml, type TomlTable } from "../../core/toml.ts";
import { BASE_URL_VARS, GATEWAY_API_BASE } from "./ids.ts";
import { gatewayForProvider, gatewayForUrl, GATEWAY_IDS, GATEWAYS, isGatewayId, type GatewayId } from "./providers.ts";

export const DEFAULT_KEY_ENV = "AI_GATEWAY_API_KEY";

export interface GatewaySettings {
  /** REST base, default https://ai-gateway.vercel.sh/v1 (CODING_SH_GATEWAY_URL or [gateway] baseUrl override it). */
  baseUrl: string;
  /** Env var the key is read from (default AI_GATEWAY_API_KEY). */
  apiKeyEnv: string;
  /** The key itself. Never print, log or persist it. */
  apiKey?: string;
  /** Where the key came from, e.g. "env AI_GATEWAY_API_KEY" or "config gateway.apiKey". */
  keySource?: string;
}

const isTable = (v: unknown): v is TomlTable => typeof v === "object" && v !== null && !Array.isArray(v);

function gatewayTable(env: NodeJS.ProcessEnv): TomlTable {
  const file = paths(env).config;
  if (!existsSync(file)) return {};
  try {
    const t = parseToml(readFileSync(file, "utf8"), file).gateway;
    return isTable(t) ? t : {};
  } catch {
    return {}; // `coding.sh doctor` reports a broken config
  }
}

/** Settings for any gateway. Vercel's come from gatewaySettings(); the rest from [gateway.<id>]. */
export interface GatewayConfig {
  id: GatewayId;
  name: string;
  /** Lookup API base, when the gateway has one (self-hosted: its URL from config or env). */
  baseUrl?: string;
  apiKeyEnv: string;
  /** The key itself. Never print, log or persist it. */
  apiKey?: string;
  keySource?: string;
  /** Cloudflare only: account and gateway the logs live under. */
  accountId?: string;
  gatewayId?: string;
  /** A [gateway.<id>] table exists in config.toml. */
  configured: boolean;
}

const tableStr = (t: TomlTable, k: string): string | undefined => (typeof t[k] === "string" && (t[k] as string).trim() ? (t[k] as string).trim() : undefined);

/** Account and gateway id from a https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/… URL. */
export function cloudflareIdsFromUrl(url: unknown): { accountId: string; gatewayId: string } | undefined {
  if (typeof url !== "string") return undefined;
  const m = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([0-9a-f]{32})\/([A-Za-z0-9_-]+)/i.exec(url);
  return m ? { accountId: m[1]!, gatewayId: m[2]! } : undefined;
}

function keyFrom(env: NodeJS.ProcessEnv, t: TomlTable, apiKeyEnv: string, label: string): { apiKey?: string; keySource?: string } {
  const fromEnv = env[apiKeyEnv]?.trim();
  if (fromEnv) return { apiKey: fromEnv, keySource: `env ${apiKeyEnv}` };
  const raw = tableStr(t, "apiKey");
  if (!raw) return {};
  try {
    const v = interpolateEnv(raw, env, `${label}.apiKey`).trim();
    return v ? { apiKey: v, keySource: `config ${label}.apiKey` } : {};
  } catch {
    return {}; // ${VAR} unset: no key
  }
}

/** Effective settings for one gateway. Key order: env var ([gateway.<id>] apiKeyEnv or the gateway's standard one), then apiKey. */
export function gatewayConfig(id: GatewayId, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const def = GATEWAYS[id];
  const root = gatewayTable(env);
  if (id === "vercel") {
    const v = gatewaySettings(env);
    return { id, name: def.name, baseUrl: v.baseUrl, apiKeyEnv: v.apiKeyEnv, ...(v.apiKey ? { apiKey: v.apiKey, keySource: v.keySource! } : {}), configured: isTable(root.vercel) || Object.keys(root).some((k) => !isTable(root[k]) && k !== "default") };
  }
  const t = isTable(root[id]) ? root[id] : {};
  const named = tableStr(t, "apiKeyEnv");
  // The standard var, then the gateway's other conventions (LiteLLM: LITELLM_API_KEY, LITELLM_MASTER_KEY).
  const apiKeyEnv = named ?? [def.keyEnv, ...(def.keyEnvFallbacks ?? [])].find((k) => env[k]?.trim()) ?? def.keyEnv;
  const urlFromEnv = def.urlEnv.map((k) => env[k]?.trim()).find(Boolean);
  const baseUrl = (tableStr(t, "baseUrl") ?? urlFromEnv ?? def.apiBase)?.replace(/\/+$/, "");
  const c: GatewayConfig = { id, name: def.name, apiKeyEnv, ...keyFrom(env, t, apiKeyEnv, `gateway.${id}`), configured: isTable(root[id]) };
  if (baseUrl) c.baseUrl = baseUrl;
  if (id === "cloudflare") {
    const fromUrl = BASE_URL_VARS.map((k) => cloudflareIdsFromUrl(env[k])).find(Boolean);
    const accountId = tableStr(t, "accountId") ?? env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? fromUrl?.accountId;
    const gatewayId = tableStr(t, "gatewayId") ?? env.CLOUDFLARE_GATEWAY_ID?.trim() ?? fromUrl?.gatewayId;
    if (accountId) c.accountId = accountId;
    if (gatewayId) c.gatewayId = gatewayId;
  }
  return c;
}

/** Settings for every known gateway, in registry order. */
export const allGatewayConfigs = (env: NodeJS.ProcessEnv = process.env): GatewayConfig[] => GATEWAY_IDS.map((id) => gatewayConfig(id, env));

/**
 * The gateway `--gateway` without a name means: [gateway] default when set,
 * else Vercel when its key is set, else the one other gateway with a key, else
 * Vercel (whose missing-key error then says what to export).
 */
export function defaultGateway(env: NodeJS.ProcessEnv = process.env): GatewayId {
  const d = gatewayTable(env).default;
  if (isGatewayId(d)) return d;
  if (gatewaySettings(env).apiKey) return "vercel";
  const keyed = GATEWAY_IDS.filter((id) => id !== "vercel" && gatewayConfig(id, env).apiKey);
  return keyed.length === 1 ? keyed[0]! : "vercel";
}

/**
 * Effective settings. Key order: the env var named by [gateway] apiKeyEnv
 * (default AI_GATEWAY_API_KEY), then [gateway] apiKey (may be "${VAR}").
 */
export function gatewaySettings(env: NodeJS.ProcessEnv = process.env): GatewaySettings {
  const t = gatewayTable(env);
  const apiKeyEnv = typeof t.apiKeyEnv === "string" && t.apiKeyEnv ? t.apiKeyEnv : DEFAULT_KEY_ENV;
  const baseUrl = (env.CODING_SH_GATEWAY_URL || (typeof t.baseUrl === "string" && t.baseUrl) || GATEWAY_API_BASE).replace(/\/+$/, "");
  const s: GatewaySettings = { baseUrl, apiKeyEnv };
  const fromEnv = env[apiKeyEnv]?.trim();
  if (fromEnv) {
    s.apiKey = fromEnv;
    s.keySource = `env ${apiKeyEnv}`;
  } else if (typeof t.apiKey === "string" && t.apiKey.trim()) {
    try {
      const v = interpolateEnv(t.apiKey.trim(), env, "gateway.apiKey").trim();
      if (v) {
        s.apiKey = v;
        s.keySource = "config gateway.apiKey";
      }
    } catch {
      // ${VAR} unset: no key
    }
  }
  return s;
}

// ---------------------------------------------------------------- config scan

export interface GatewayFinding {
  /** Gateway the setting routes through. */
  gateway: GatewayId;
  /** Agent the setting routes, or "any" for shared env. */
  agent: string;
  /** File or "env", never a value. */
  where: string;
  /** What was seen, e.g. "ANTHROPIC_BASE_URL → ai-gateway.vercel.sh/claude-code". */
  detail: string;
  /** False when the routing is configured but not selected (a Codex provider that isn't model_provider). */
  active: boolean;
}

function readText(file: string): string | undefined {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text);
    return isTable(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Host + path of a gateway URL, safe to print (the gateway URL never carries credentials). */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** String values of a settings env block (URL-type vars only end up compared by host). */
function stringsOf(t: TomlTable): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(t)) if (typeof v === "string") o[k] = v;
  return o;
}

/** Hosted gateway hosts, for a plain-text search of configs we can't parse. */
const HOSTED = GATEWAY_IDS.flatMap((id) => GATEWAYS[id].hosts.filter((h) => !h.startsWith(".")).map((h) => [id, h] as const));

function claudeFindings(env: NodeJS.ProcessEnv, cwd: string | undefined, out: GatewayFinding[]): void {
  const dir = env.CLAUDE_CONFIG_DIR || join(userHome(env), ".claude");
  const files = [join(dir, "settings.json")];
  if (cwd) files.push(join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"));
  for (const file of files) {
    const e = readJson(file)?.env;
    if (!isTable(e)) continue;
    const base = e.ANTHROPIC_BASE_URL;
    const gateway = gatewayForUrl(base, { ...env, ...stringsOf(e) });
    if (!gateway) continue;
    const headers = gateway === "vercel" && typeof e.ANTHROPIC_CUSTOM_HEADERS === "string" && /x-ai-gateway-api-key/i.test(e.ANTHROPIC_CUSTOM_HEADERS);
    out.push({ gateway, agent: "claude-code", where: file, detail: `ANTHROPIC_BASE_URL → ${shortUrl(base as string)}${headers ? " (Claude subscription + gateway key header)" : ""}`, active: true });
  }
}

function codexFindings(env: NodeJS.ProcessEnv, out: GatewayFinding[]): void {
  const file = join(env.CODEX_HOME || join(userHome(env), ".codex"), "config.toml");
  const text = readText(file);
  if (text === undefined) return;
  let doc: TomlTable | undefined;
  try {
    doc = parseToml(text, file);
  } catch {
    // Unparseable here (newer TOML than our parser): fall back to a plain search.
    for (const [gateway, host] of HOSTED) {
      if (new RegExp(`base_url\\s*=\\s*["']https://${host.replace(/\./g, "\\.")}`, "i").test(text)) out.push({ gateway, agent: "codex", where: file, detail: `a model provider's base_url → ${host}`, active: true });
    }
    return;
  }
  const providers = isTable(doc.model_providers) ? doc.model_providers : {};
  const selected = new Set<string>();
  if (typeof doc.model_provider === "string") selected.add(doc.model_provider);
  if (isTable(doc.profiles)) for (const p of Object.values(doc.profiles)) if (isTable(p) && typeof p.model_provider === "string") selected.add(p.model_provider);
  for (const [name, p] of Object.entries(providers)) {
    const gateway = isTable(p) ? gatewayForUrl(p.base_url, env) : undefined;
    if (!isTable(p) || !gateway) continue;
    const keyEnv = typeof p.env_key === "string" ? `, key from $${p.env_key}` : "";
    out.push({ gateway, agent: "codex", where: file, detail: `model_providers.${name}.base_url → ${shortUrl(p.base_url as string)}${keyEnv}`, active: selected.has(name) });
  }
}

function opencodeFindings(env: NodeJS.ProcessEnv, out: GatewayFinding[]): void {
  const dir = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(userHome(env), ".config"), "opencode");
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const file = join(dir, name);
    const text = readText(file);
    if (text === undefined) continue;
    // Built-in providers: `vercel/…`, `openrouter/…`, `requesty/…`.
    const model = /"model"\s*:\s*"(vercel|openrouter|requesty|helicone)\/([^"]+)"/.exec(text);
    const base = [...text.matchAll(/"baseURL"\s*:\s*"(https?:\/\/[^"]+)"/gi)].map((m) => [m[1]!, gatewayForUrl(m[1], env)] as const).find(([, g]) => g);
    const viaModel = model ? gatewayForProvider(model[1]) : undefined;
    if (model && viaModel) out.push({ gateway: viaModel, agent: "opencode", where: file, detail: `model → ${model[1]}/${model[2]} (built-in ${GATEWAYS[viaModel].name} provider)`, active: true });
    else if (base) out.push({ gateway: base[1]!, agent: "opencode", where: file, detail: `provider baseURL → ${shortUrl(base[0])}`, active: true });
  }
}

function piFindings(env: NodeJS.ProcessEnv, out: GatewayFinding[]): void {
  const file = join(env.PI_CODING_AGENT_DIR || join(userHome(env), ".pi", "agent"), "settings.json");
  const s = readJson(file);
  const gateway = s ? gatewayForProvider(s.defaultProvider) : undefined;
  if (s && gateway) out.push({ gateway, agent: "pi", where: file, detail: `defaultProvider → ${String(s.defaultProvider)}`, active: true });
}

/** Read-only scan of env and agent configs. `env` is the process env to inspect (names and URLs only). */
export function detectGatewaySetups(env: NodeJS.ProcessEnv = process.env, cwd?: string): GatewayFinding[] {
  const out: GatewayFinding[] = [];
  for (const k of BASE_URL_VARS) {
    const v = env[k];
    const gateway = gatewayForUrl(v, env);
    if (gateway) out.push({ gateway, agent: k.startsWith("ANTHROPIC") ? "claude-code" : "any", where: "env", detail: `${k} → ${shortUrl(v!)}`, active: true });
  }
  claudeFindings(env, cwd, out);
  codexFindings(env, out);
  opencodeFindings(env, out);
  piFindings(env, out);
  return out;
}
