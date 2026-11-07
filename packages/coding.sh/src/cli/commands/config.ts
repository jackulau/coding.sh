// coding.sh config get [key] | set <key> <value> | path
//
// `set` edits one line of ~/.coding.sh/config.toml in place (comments and
// layout are kept), validates the result with the real loader, and writes
// it atomically with mode 0600. An invalid value fails and writes nothing.
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, defaultConfigToml, loadConfig } from "../../core/config.ts";
import { paths } from "../../core/paths.ts";
import { stringifyToml } from "../../core/toml.ts";
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
] as const;

function getPath(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split(".")) {
    if (!cur || typeof cur !== "object" || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
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

const header = (line: string) => /^\s*\[([^\][]+)\]\s*(#.*)?$/.exec(line)?.[1]?.trim();

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
    const value = getPath(config, key);
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
  const dot = key.indexOf(".");
  const after = setTomlKey(before ?? defaultConfigToml(env), key.slice(0, dot), key.slice(dot + 1), tomlLiteral(raw));

  // Validate with the real loader before touching the file.
  const dir = await mkdtemp(join(tmpdir(), "codingsh-config-"));
  try {
    const probe = join(dir, "config.toml");
    await writeFile(probe, after);
    loadConfig({ env, file: probe });
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
  const value = getPath(loadConfig({ env }), key);
  if (out.json) out.data({ outcome: change ? "updated" : "unchanged", key, value, path: file });
  else {
    out.ok(change ? `Set ${key}` : `${key} is already ${raw}`);
    out.print(typeof value === "string" ? value : JSON.stringify(value));
  }
  return 0;
}
