// coding.sh config get [key] | set <key> <value> | path
//
// `set` edits one line of ~/.coding.sh/config.toml in place (comments and
// layout are kept), validates the result with the real loader, and writes
// it atomically with mode 0600. An invalid value fails and writes nothing.
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, defaultConfigToml, loadConfig, readUserConfigTable } from "../../core/config.ts";
import { paths } from "../../core/paths.ts";
import { parseToml, stringifyToml } from "../../core/toml.ts";
import { section as refineSection } from "../../refine/config.ts";
import { UsageError } from "../args.ts";
import { printChanges } from "../changes.ts";
import { CliError } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** Keys `config set` accepts (the dotted paths of Config scalars and arrays). */
export const SETTABLE = [
  "store.index",
  "store.blobs",
  "capture.mode",
  "capture.redact",
  "capture.redactPatterns",
  "capture.exclude",
  "capture.maxInlineBytes",
  "snapshot.enabled",
  "snapshot.maxFiles",
  "snapshot.timeoutMs",
  "retention.keepSpoolDays",
  "retention.toolOutputDays",
  "update.check",
  "refine.maxCostRise",
  "refine.canary_model",
  "serve.forward.endpoint",
] as const;

/**
 * Documented keys that the loaded Config does not carry: they sit in the user's file and the commands
 * that use them read them there. `config get` answers them from the file, and says "not set" when absent.
 */
export const FILE_KEYS = [
  "refine.protect", "refine.autoProtect", "refine.maxCostRise", "refine.canary_model",
  "serve.host", "serve.port", "serve.retention_days", "serve.log", "serve.queue_max_events", "serve.queue_max_bytes",
  "serve.insecure", "serve.trust_proxy", "serve.cors_origins",
  "serve.viewer.read_keys", "serve.viewer.basic_user", "serve.viewer.basic_password_sha256",
  "serve.forward.endpoint", "serve.forward.headers", "serve.forward.mode", "serve.forward.max_buffer_spans",
  "proxy.port", "proxy.host", "proxy.anthropic_upstream", "proxy.openai_upstream", "proxy.chatgpt_upstream",
] as const;

/** Gateway names that get their own `[gateway.<name>]` table (docs/reference/config.md). */
const GATEWAY_NAMES = ["openrouter", "litellm", "cloudflare", "portkey", "helicone", "requesty", "ramp", "truefoundry", "kong", "bifrost", "martian"];

/**
 * The `[gateway]` keys `config get` reads from the file: the top-level ones (Vercel AI Gateway, plus
 * `default`) and each named gateway's table. Not in the loaded Config: the gateway commands read them.
 */
export function isGatewayKey(key: string): boolean {
  const m = /^gateway\.(?:([a-z]+)\.)?([A-Za-z]+)$/.exec(key);
  if (!m) return false;
  const [, name, leaf] = m;
  if (name === undefined) return ["apiKeyEnv", "apiKey", "baseUrl", "default"].includes(leaf!);
  return GATEWAY_NAMES.includes(name) && (["apiKeyEnv", "apiKey", "baseUrl"].includes(leaf!) || (name === "cloudflare" && ["accountId", "gatewayId"].includes(leaf!)));
}

function getPath(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object" || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** True when two loaded configs differ at most at the dotted path `key`. */
export function onlyKeyChanged(before: unknown, after: unknown, key: string): boolean {
  const strip = (v: unknown) => {
    const c = structuredClone(v) as Record<string, unknown>;
    const parts = key.split(".");
    let cur: Record<string, unknown> | undefined = c;
    for (const p of parts.slice(0, -1)) cur = cur && typeof cur[p] === "object" && cur[p] !== null ? (cur[p] as Record<string, unknown>) : undefined;
    if (cur) delete cur[parts[parts.length - 1]!];
    return JSON.stringify(c);
  };
  return strip(before) === strip(after);
}

/** CLI text → TOML literal: numbers, booleans and JSON arrays stay typed; anything else is a string. */
export function tomlLiteral(raw: string): string {
  const t = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) || t === "true" || t === "false") return t;
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return stringifyToml({ v }).replace(/^v = /, "").trim();
    } catch {
      // fall through: a string that happens to start with "["
    }
  }
  return JSON.stringify(raw);
}

/**
 * The table a header line opens: "capture" for `[capture]`; for an
 * array-of-tables line (`[[sinks]]`) a name no settable key can match, so the
 * keys under it never count as part of the table before it.
 */
const header = (line: string): string | undefined => {
  const m = /^\s*(\[\[?)\s*([^\][]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
  if (!m) return undefined;
  return m[1] === "[[" ? `[[${m[2]}]]` : m[2]!.replace(/\s*\.\s*/g, ".").replace(/"/g, "");
};

/** Sets `[table] key = literal` in TOML text, keeping everything else byte-for-byte. */
export function setTomlKey(text: string, table: string, key: string, literal: string): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let current = "";
  let headerIdx = -1;
  let lastInTable = -1;
  const keyRe = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*)(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = header(line);
    if (h !== undefined) {
      current = h;
      if (h === table) headerIdx = lastInTable = i;
      continue;
    }
    if (current === table) {
      if (line.trim() && !line.trim().startsWith("#")) lastInTable = i;
      const m = keyRe.exec(line);
      if (m) {
        lines[i] = `${m[1]}${literal}`;
        return lines.join(nl);
      }
    }
  }
  if (headerIdx >= 0) {
    lines.splice(lastInTable + 1, 0, `${key} = ${literal}`);
    return lines.join(nl);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return [...lines, ...(lines.length ? [""] : []), `[${table}]`, `${key} = ${literal}`, ""].join(nl);
}

export async function run(c: CommandContext): Promise<number> {
  const { out, env } = c;
  const file = paths(env).config;
  if (c.action === "path") {
    if (out.json) out.data({ path: file, exists: existsSync(file) });
    else out.print(file);
    return 0;
  }

  if (c.action === "get") {
    let config;
    try {
      config = loadConfig({ env, cwd: c.cwd });
    } catch (e) {
      if (e instanceof ConfigError) throw new CliError(`Can't read config: ${e.message}`, { reason: "invalid_config", next: ["Fix the file at:", file] });
      throw e;
    }
    const key = c.positionals[0];
    if (key === undefined) {
      if (out.json) out.data({ config });
      else out.print(stringifyToml(config as unknown as Record<string, unknown>).trimEnd());
      return 0;
    }
    let value = getPath(config, key);
    if (value === undefined && ((FILE_KEYS as readonly string[]).includes(key) || isGatewayKey(key))) {
      value = getPath(readUserConfigTable(env).table, key);
      if (value === undefined) {
        if (out.json) out.data({ key, value: null });
        else out.print(`${key} is not set`);
        return 0;
      }
      // A gateway key is never printed (docs/reference/config.md): say only that it is set.
      if (isGatewayKey(key) && key.endsWith(".apiKey")) {
        if (out.json) out.data({ key, set: true });
        else out.print(`${key} is set (keys are never printed)`);
        return 0;
      }
    }
    if (value === undefined) throw new UsageError(`Unknown config key ${JSON.stringify(key)}`, { reason: "unknown_key", suggestion: SETTABLE.find((k) => k.endsWith(key.split(".").pop() ?? "")) });
    if (out.json) out.data({ key, value });
    else out.print(typeof value === "string" ? value : JSON.stringify(value));
    return 0;
  }

  // set
  const [key, raw] = c.positionals as [string, string];
  if (!(SETTABLE as readonly string[]).includes(key)) {
    const { suggest } = await import("../args.ts");
    const s = suggest(key, SETTABLE);
    throw new UsageError(`Can't set ${JSON.stringify(key)}. Settable keys: ${SETTABLE.join(", ")}`, { reason: "unknown_key", suggestion: s ? `coding.sh config set ${s} ${raw}` : undefined });
  }
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  // What the key read before this edit (the default when the file did not set it), for the confirmation.
  let previous: unknown;
  try {
    previous = getPath(loadConfig({ env }), key) ?? getPath(readUserConfigTable(env).table, key);
  } catch {
    previous = undefined; // an unreadable config: nothing to compare against
  }
  const dot = key.lastIndexOf(".");
  const after = setTomlKey(before ?? defaultConfigToml(env), key.slice(0, dot), key.slice(dot + 1), tomlLiteral(raw));

  // Validate with the real loader before touching the file, and check that the
  // edit changed exactly the key asked for and nothing else (a line edit in the
  // wrong table would otherwise pass: sinks[].mode takes the same values).
  const dir = await mkdtemp(join(tmpdir(), "codingsh-config-"));
  // Store env overrides would mask (or derive from) the file's store keys.
  const fileEnv = { ...env, CODING_SH_STORE_URL: undefined, CODING_SH_BLOB_URL: undefined };
  try {
    const probe = join(dir, "config.toml");
    let was: unknown;
    if (before !== undefined) {
      await writeFile(probe, before);
      try {
        was = loadConfig({ env: fileEnv, file: probe });
      } catch {
        was = undefined; // already invalid: nothing to compare against
      }
    }
    await writeFile(probe, after);
    const now = loadConfig({ env: fileEnv, file: probe });
    // Keys the loader does not carry are checked where the commands that use them read them.
    if (key === "serve.forward.endpoint" && !/^https?:\/\/[^\s/]+/i.test(raw.trim())) throw new ConfigError("serve.forward.endpoint must be an http:// or https:// URL", probe);
    if (key.startsWith("refine.")) {
      refineSection(parseToml(after, probe), probe);
      if (key === "refine.canary_model" && !raw.trim()) throw new ConfigError("refine.canary_model must be a model name", probe);
    }
    if (was !== undefined && !onlyKeyChanged(was, now, key)) {
      throw new CliError(`Can't set ${key}: the edit would change other settings too`, {
        reason: "unsafe_edit",
        next: ["Edit the file by hand:", file],
      });
    }
  } catch (e) {
    if (e instanceof ConfigError) throw new UsageError(`Invalid value for ${key}: ${e.message.replace(/^.*?: /, "")}`, { reason: "invalid_value" });
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const change = before === after ? undefined : { path: file, action: before === undefined ? ("create" as const) : ("modify" as const), summary: `set ${key}`, ...(before !== undefined ? { before } : {}), after };
  if (c.flags["dry-run"] === true) {
    if (out.json) out.data({ outcome: change ? "planned" : "unchanged", key, path: file, before: before ?? null, after });
    else if (change) printChanges(out, [change]);
    else out.ok(`${key} is already ${raw}`);
    return 0;
  }
  if (change) {
    const { atomicWrite } = await import("../../adapters/_shared/files.ts");
    await atomicWrite(file, after, 0o600);
  }
  const value = getPath(loadConfig({ env }), key) ?? getPath(readUserConfigTable(env).table, key);
  const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  if (out.json) {
    const doc: Record<string, unknown> = { outcome: change ? "updated" : "unchanged", key, value };
    if (previous !== undefined) doc.previous = previous;
    doc.path = file;
    out.data(doc);
  }
  else {
    out.ok(change ? `Set ${key}${previous !== undefined ? ` (was ${show(previous)})` : ""}` : `${key} is already ${raw}`);
    out.print(typeof value === "string" ? value : JSON.stringify(value));
  }
  return 0;
}
