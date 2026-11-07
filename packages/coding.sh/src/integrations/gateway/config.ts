// Gateway settings (the [gateway] table in ~/.coding.sh/config.toml) and a
// read-only scan of agent configs for gateway routing. Nothing here writes a
// file or returns a key value: findings name where routing was seen, and the
// key is reported only as "set" plus where it came from.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { interpolateEnv } from "../../core/config.ts";
import { paths, userHome } from "../../core/paths.ts";
import { parseToml, type TomlTable } from "../../core/toml.ts";
import { BASE_URL_VARS, GATEWAY_API_BASE, isGatewayUrl } from "./ids.ts";

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

function claudeFindings(env: NodeJS.ProcessEnv, cwd: string | undefined, out: GatewayFinding[]): void {
  const dir = env.CLAUDE_CONFIG_DIR || join(userHome(env), ".claude");
  const files = [join(dir, "settings.json")];
  if (cwd) files.push(join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"));
  for (const file of files) {
    const e = readJson(file)?.env;
    if (!isTable(e)) continue;
    const base = e.ANTHROPIC_BASE_URL;
    if (!isGatewayUrl(base)) continue;
    const headers = typeof e.ANTHROPIC_CUSTOM_HEADERS === "string" && /x-ai-gateway-api-key/i.test(e.ANTHROPIC_CUSTOM_HEADERS);
    out.push({ agent: "claude-code", where: file, detail: `ANTHROPIC_BASE_URL → ${shortUrl(base as string)}${headers ? " (Claude subscription + gateway key header)" : ""}`, active: true });
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
    if (/base_url\s*=\s*["']https:\/\/ai-gateway\.vercel\.sh/i.test(text)) out.push({ agent: "codex", where: file, detail: "a model provider's base_url → ai-gateway.vercel.sh", active: true });
    return;
  }
  const providers = isTable(doc.model_providers) ? doc.model_providers : {};
  const selected = new Set<string>();
  if (typeof doc.model_provider === "string") selected.add(doc.model_provider);
  if (isTable(doc.profiles)) for (const p of Object.values(doc.profiles)) if (isTable(p) && typeof p.model_provider === "string") selected.add(p.model_provider);
  for (const [name, p] of Object.entries(providers)) {
    if (!isTable(p) || !isGatewayUrl(p.base_url)) continue;
    const keyEnv = typeof p.env_key === "string" ? `, key from $${p.env_key}` : "";
    out.push({ agent: "codex", where: file, detail: `model_providers.${name}.base_url → ${shortUrl(p.base_url as string)}${keyEnv}`, active: selected.has(name) });
  }
}

function opencodeFindings(env: NodeJS.ProcessEnv, out: GatewayFinding[]): void {
  const dir = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(userHome(env), ".config"), "opencode");
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const file = join(dir, name);
    const text = readText(file);
    if (text === undefined) continue;
    const model = /"model"\s*:\s*"vercel\/([^"]+)"/.exec(text);
    const base = /"baseURL"\s*:\s*"(https:\/\/ai-gateway\.vercel\.sh[^"]*)"/i.exec(text);
    if (model) out.push({ agent: "opencode", where: file, detail: `model → vercel/${model[1]} (built-in Vercel AI Gateway provider)`, active: true });
    else if (base) out.push({ agent: "opencode", where: file, detail: `provider baseURL → ${shortUrl(base[1]!)}`, active: true });
  }
}

function piFindings(env: NodeJS.ProcessEnv, out: GatewayFinding[]): void {
  const file = join(env.PI_CODING_AGENT_DIR || join(userHome(env), ".pi", "agent"), "settings.json");
  const s = readJson(file);
  if (s && s.defaultProvider === "vercel-ai-gateway") out.push({ agent: "pi", where: file, detail: "defaultProvider → vercel-ai-gateway", active: true });
}

/** Read-only scan of env and agent configs. `env` is the process env to inspect (names and URLs only). */
export function detectGatewaySetups(env: NodeJS.ProcessEnv = process.env, cwd?: string): GatewayFinding[] {
  const out: GatewayFinding[] = [];
  for (const k of BASE_URL_VARS) {
    const v = env[k];
    if (isGatewayUrl(v)) out.push({ agent: k.startsWith("ANTHROPIC") ? "claude-code" : "any", where: "env", detail: `${k} → ${shortUrl(v!)}`, active: true });
  }
  claudeFindings(env, cwd, out);
  codexFindings(env, out);
  opencodeFindings(env, out);
  piFindings(env, out);
  return out;
}
