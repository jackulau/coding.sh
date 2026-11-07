// Config: built-in defaults ← ~/.coding.sh/config.toml ← <repo>/.coding.sh/config.toml.
//
// A repo-level file is untrusted (it arrives with `git clone`), so it may only
// touch capture/snapshot settings, and only in ways that keep or add privacy:
// redactors and patterns are unioned, never removed. It can never add sinks or
// move the stores, which would let a repository exfiltrate your sessions.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config, SinkConfig } from "./types.ts";
import { dataHome, expandHome, paths } from "./paths.ts";
import { parseToml, stringifyToml, TomlError, type TomlTable } from "./toml.ts";

export class ConfigError extends Error {
  readonly file?: string;
  constructor(message: string, file?: string) {
    super(file ? `${file}: ${message}` : message);
    this.name = "ConfigError";
    this.file = file;
  }
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Directory to search upward for a per-repo `.coding.sh/config.toml`. */
  cwd?: string;
  /** Explicit user config file (default: paths(env).config). */
  file?: string;
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = dataHome(env);
  return {
    home,
    store: {
      index: `sqlite://${join(home, "index.db")}`,
      blobs: `file://${join(home, "blobs")}`,
    },
    capture: {
      mode: "full",
      redact: ["secrets"],
      redactPatterns: [],
      exclude: [],
      maxInlineBytes: 4096,
    },
    snapshot: { enabled: true, maxFiles: 20000, timeoutMs: 2000 },
    sinks: [],
    retention: { keepSpoolDays: 7, toolOutputDays: 90 },
    update: { check: true },
  };
}

function isOptions(x: LoadConfigOptions | NodeJS.ProcessEnv): x is LoadConfigOptions {
  // Env var names are conventionally upper-case; these lower-case keys mark an options bag.
  return "env" in x || "cwd" in x || "file" in x;
}

/**
 * Loads the effective config. Accepts either options or a bare env object
 * (`loadConfig(process.env)`) for convenience.
 */
export function loadConfig(arg: LoadConfigOptions | NodeJS.ProcessEnv = {}): Config {
  const opts: LoadConfigOptions = isOptions(arg) ? arg : { env: arg };
  const env = opts.env ?? process.env;
  const base = defaultConfig(env);
  const file = opts.file ?? paths(env).config;
  let config = base;
  if (existsSync(file)) config = applyUserConfig(base, readToml(file), file, env);
  config = applyStoreEnv(config, base, env);
  return opts.cwd ? resolveRepoConfig(config, opts.cwd, env) : config;
}

/** True for URLs served by the Postgres plugin, which keeps blobs in the same database by default. */
export const isPostgresUrl = (url: string): boolean => /^postgres(?:ql)?:\/\//i.test(url);

/**
 * CODING_SH_STORE_URL / CODING_SH_BLOB_URL override the file (so a container or the
 * `--store`/`--blobs` flags can point any command at a shared store). A Postgres index
 * with no blob store chosen keeps blobs in the same database.
 */
function applyStoreEnv(config: Config, base: Config, env: NodeJS.ProcessEnv): Config {
  const index = env.CODING_SH_STORE_URL?.trim();
  const blobs = env.CODING_SH_BLOB_URL?.trim();
  if (!index && !blobs) return config;
  const out: Config = { ...config, store: { ...config.store } };
  if (index) out.store.index = expandStoreUrl(index, env);
  if (blobs) out.store.blobs = expandStoreUrl(blobs, env);
  else if (isPostgresUrl(out.store.index) && out.store.blobs === base.store.blobs) out.store.blobs = out.store.index;
  return out;
}

/** The user config file as a raw table (for sections other modules own, like [serve]). Empty when absent. */
export function readUserConfigTable(env: NodeJS.ProcessEnv = process.env, file?: string): { table: TomlTable; file: string } {
  const path = file ?? paths(env).config;
  return { table: existsSync(path) ? readToml(path) : {}, file: path };
}

/** Applies the nearest `.coding.sh/config.toml` above `cwd` (if any) onto `base`. */
export function resolveRepoConfig(base: Config, cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = findRepoConfig(cwd, env);
  if (!file) return base;
  return applyRepoConfig(base, readToml(file), file);
}

/** Finds `<dir>/.coding.sh/config.toml` walking up from cwd, stopping at the repo root or $HOME. */
export function findRepoConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = resolve(expandHome("~", env));
  const userConfig = resolve(paths(env).config);
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".coding.sh", "config.toml");
    // ~/.coding.sh/config.toml is the user config, not a repo override.
    if (candidate !== userConfig && existsSync(candidate)) return candidate;
    if (dir === home || existsSync(join(dir, ".git"))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readToml(file: string): TomlTable {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config: ${(err as Error).message}`, file);
  }
  try {
    return parseToml(text, file);
  } catch (err) {
    if (err instanceof TomlError) throw new ConfigError(`invalid TOML: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------- validation

type Reader = {
  table(key: string): TomlTable | undefined;
  string(t: TomlTable, key: string, path: string): string | undefined;
  int(t: TomlTable, key: string, path: string, min?: number): number | undefined;
  bool(t: TomlTable, key: string, path: string): boolean | undefined;
  strings(t: TomlTable, key: string, path: string): string[] | undefined;
  oneOf<T extends string>(t: TomlTable, key: string, path: string, allowed: readonly T[]): T | undefined;
};

function reader(root: TomlTable, file: string): Reader {
  const bad = (path: string, want: string, got: unknown): never => {
    throw new ConfigError(`${path} must be ${want}, got ${Array.isArray(got) ? "array" : typeof got} ${JSON.stringify(got)}`, file);
  };
  const r: Reader = {
    table(key) {
      const v = root[key];
      if (v === undefined) return undefined;
      if (typeof v !== "object" || Array.isArray(v)) bad(key, "a table", v);
      return v as TomlTable;
    },
    string(t, key, path) {
      const v = t[key];
      if (v === undefined) return undefined;
      return typeof v === "string" ? v : bad(path, "a string", v);
    },
    int(t, key, path, min = 0) {
      const v = t[key];
      if (v === undefined) return undefined;
      if (typeof v !== "number" || !Number.isInteger(v) || v < min) bad(path, `an integer >= ${min}`, v);
      return v as number;
    },
    bool(t, key, path) {
      const v = t[key];
      if (v === undefined) return undefined;
      return typeof v === "boolean" ? v : bad(path, "true or false", v);
    },
    strings(t, key, path) {
      const v = t[key];
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) bad(path, "an array of strings", v);
      return v as string[];
    },
    oneOf<T extends string>(t: TomlTable, key: string, path: string, allowed: readonly T[]): T | undefined {
      const v = r.string(t, key, path);
      if (v === undefined) return undefined;
      if (!(allowed as readonly string[]).includes(v)) throw new ConfigError(`${path} must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}, got ${JSON.stringify(v)}`, file);
      return v as T;
    },
  };
  return r;
}

/** Expands `scheme://~/x` and bare `~/x` against the user's home. */
export function expandStoreUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(~(?:\/.*)?)$/i.exec(url);
  if (m) return m[1]! + expandHome(m[2]!, env);
  return expandHome(url, env);
}

/** Replaces ${NAME} with env values so tokens can stay out of config files. */
export function interpolateEnv(s: string, env: NodeJS.ProcessEnv, where: string, file?: string): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) throw new ConfigError(`${where} references \${${name}}, which is not set in the environment`, file);
    return v;
  });
}

function applyUserConfig(base: Config, root: TomlTable, file: string, env: NodeJS.ProcessEnv): Config {
  const r = reader(root, file);
  const out: Config = structuredClone(base);

  const store = r.table("store");
  if (store) {
    const index = r.string(store, "index", "store.index");
    const blobs = r.string(store, "blobs", "store.blobs");
    if (index !== undefined) out.store.index = expandStoreUrl(interpolateEnv(index, env, "store.index", file), env);
    if (blobs !== undefined) out.store.blobs = expandStoreUrl(interpolateEnv(blobs, env, "store.blobs", file), env);
  }

  applyCapture(out, r, "replace", file);
  applySnapshot(out, r);

  const retention = r.table("retention");
  if (retention) {
    out.retention.keepSpoolDays = r.int(retention, "keepSpoolDays", "retention.keepSpoolDays") ?? out.retention.keepSpoolDays;
    out.retention.toolOutputDays = r.int(retention, "toolOutputDays", "retention.toolOutputDays") ?? out.retention.toolOutputDays;
  }

  const update = r.table("update");
  if (update) out.update.check = r.bool(update, "check", "update.check") ?? out.update.check;

  const pricing = r.table("pricing");
  if (pricing) out.pricing = parsePricing(pricing, file);

  const sinks = root.sinks;
  if (sinks !== undefined) {
    if (!Array.isArray(sinks) || !sinks.every((s) => typeof s === "object" && s !== null && !Array.isArray(s))) {
      throw new ConfigError("sinks must be an array of tables ([[sinks]])", file);
    }
    out.sinks = (sinks as TomlTable[]).map((s, i) => parseSink(s, i, r, env, file));
    const names = new Set<string>();
    for (const s of out.sinks) {
      const name = s.name ?? s.kind;
      if (names.has(name)) throw new ConfigError(`two sinks are named ${JSON.stringify(name)}; give each [[sinks]] a unique name`, file);
      names.add(name);
    }
  }
  return out;
}

/** `[pricing."<model>"] input, output, cache_read?, cache_write?` in USD per 1M tokens. */
function parsePricing(t: TomlTable, file: string): NonNullable<Config["pricing"]> {
  const out: NonNullable<Config["pricing"]> = {};
  for (const [model, v] of Object.entries(t)) {
    const where = `pricing.${JSON.stringify(model)}`;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(`${where} must be a table with input and output prices`, file);
    const p = v as TomlTable;
    const num = (key: string, alt: string): number | undefined => {
      const x = p[key] ?? p[alt];
      if (x === undefined) return undefined;
      if (typeof x !== "number" || !Number.isFinite(x) || x < 0) throw new ConfigError(`${where}.${key} must be a number >= 0 (USD per 1M tokens), got ${JSON.stringify(x)}`, file);
      return x;
    };
    const input = num("input", "input");
    const output = num("output", "output");
    if (input === undefined || output === undefined) throw new ConfigError(`${where} needs both input and output (USD per 1M tokens)`, file);
    const cacheRead = num("cache_read", "cacheRead");
    const cacheWrite = num("cache_write", "cacheWrite");
    out[model] = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
  }
  return out;
}

function parseSink(s: TomlTable, i: number, r: Reader, env: NodeJS.ProcessEnv, file: string): SinkConfig {
  const p = `sinks[${i}]`;
  const kind = r.string(s, "kind", `${p}.kind`);
  const endpoint = r.string(s, "endpoint", `${p}.endpoint`);
  if (!kind) throw new ConfigError(`${p}.kind is required (e.g. "otlp" or "http")`, file);
  if (!endpoint) throw new ConfigError(`${p}.endpoint is required`, file);
  const sink: SinkConfig = {
    kind,
    endpoint: interpolateEnv(endpoint, env, `${p}.endpoint`, file),
    // Remote sinks default to metadata-only: content leaves the machine only when asked for.
    mode: r.oneOf(s, "mode", `${p}.mode`, ["full", "metadata"] as const) ?? "metadata",
  };
  const name = r.string(s, "name", `${p}.name`);
  if (name !== undefined) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new ConfigError(`${p}.name may only contain letters, digits, ".", "_" and "-"`, file);
    sink.name = name;
  }
  const batchSize = r.int(s, "batchSize", `${p}.batchSize`, 1);
  if (batchSize !== undefined) sink.batchSize = batchSize;
  const headers = s.headers;
  if (headers !== undefined) {
    if (typeof headers !== "object" || Array.isArray(headers)) throw new ConfigError(`${p}.headers must be a table`, file);
    sink.headers = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== "string") throw new ConfigError(`${p}.headers.${k} must be a string`, file);
      sink.headers[k] = interpolateEnv(v, env, `${p}.headers.${k}`, file);
    }
  }
  return sink;
}

function applyCapture(out: Config, r: Reader, how: "replace" | "union", file: string): void {
  const capture = r.table("capture");
  if (!capture) return;
  const mode = r.oneOf(capture, "mode", "capture.mode", ["full", "metadata"] as const);
  const redact = r.strings(capture, "redact", "capture.redact");
  const patterns = r.strings(capture, "redactPatterns", "capture.redactPatterns");
  const exclude = r.strings(capture, "exclude", "capture.exclude");
  const maxInline = r.int(capture, "maxInlineBytes", "capture.maxInlineBytes", 256);
  for (const name of redact ?? []) {
    if (!["secrets", "env", "none"].includes(name)) {
      throw new ConfigError(`capture.redact: unknown redactor ${JSON.stringify(name)} (expected "secrets", "env" or "none")`, file);
    }
  }
  for (const [i, src] of (patterns ?? []).entries()) {
    try {
      new RegExp(src);
    } catch (err) {
      throw new ConfigError(`capture.redactPatterns[${i}] is not a valid regular expression: ${(err as Error).message}`, file);
    }
  }
  const union = (a: string[], b: string[] | undefined) => (b ? [...new Set([...a, ...b])] : a);
  if (how === "replace") {
    if (mode) out.capture.mode = mode;
    if (redact) out.capture.redact = redact.filter((x) => x !== "none");
    if (patterns) out.capture.redactPatterns = patterns;
    if (exclude) out.capture.exclude = exclude;
    if (maxInline !== undefined) out.capture.maxInlineBytes = maxInline;
  } else {
    // Repo overrides may only tighten privacy.
    if (mode === "metadata") out.capture.mode = "metadata";
    out.capture.redact = union(out.capture.redact, redact?.filter((x) => x !== "none"));
    out.capture.redactPatterns = union(out.capture.redactPatterns, patterns);
    out.capture.exclude = union(out.capture.exclude, exclude);
    if (maxInline !== undefined) out.capture.maxInlineBytes = Math.min(out.capture.maxInlineBytes, maxInline);
  }
}

function applySnapshot(out: Config, r: Reader): void {
  const snapshot = r.table("snapshot");
  if (!snapshot) return;
  out.snapshot.enabled = r.bool(snapshot, "enabled", "snapshot.enabled") ?? out.snapshot.enabled;
  out.snapshot.maxFiles = r.int(snapshot, "maxFiles", "snapshot.maxFiles", 1) ?? out.snapshot.maxFiles;
  out.snapshot.timeoutMs = r.int(snapshot, "timeoutMs", "snapshot.timeoutMs", 1) ?? out.snapshot.timeoutMs;
}

function applyRepoConfig(base: Config, root: TomlTable, file: string): Config {
  const r = reader(root, file);
  const out: Config = structuredClone(base);
  applyCapture(out, r, "union", file);
  applySnapshot(out, r);
  return out;
}

// ---------------------------------------------------------------- exclude globs

/** Converts a path glob (`*`, `**`, `?`, leading `~`) to an anchored RegExp. */
export function globToRegExp(glob: string, env: NodeJS.ProcessEnv = process.env): RegExp {
  const g = expandHome(glob, env).replace(/\/+$/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** True when `path` or any of its ancestors matches one of the exclude globs. */
export function isExcluded(path: string, globs: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (!globs.length || !path) return false;
  const res = globs.map((g) => globToRegExp(g, env));
  let p = resolve(path);
  for (;;) {
    if (res.some((re) => re.test(p))) return true;
    const parent = dirname(p);
    if (parent === p) return false;
    p = parent;
  }
}

// ---------------------------------------------------------------- default file

/** TOML text for a fresh config.toml. Store URLs are left commented so CODING_SH_HOME keeps working. */
export function defaultConfigToml(env: NodeJS.ProcessEnv = process.env): string {
  const d = defaultConfig(env);
  const body = stringifyToml({ capture: d.capture, snapshot: d.snapshot, retention: d.retention });
  return [
    "# coding.sh config. Docs: https://coding.sh/docs/config",
    "# Per-repo overrides live in <repo>/.coding.sh/config.toml (capture/snapshot only).",
    "",
    "# [store]",
    '# index = "sqlite://~/.coding.sh/index.db"',
    '# blobs = "file://~/.coding.sh/blobs"',
    "",
    body.trimEnd(),
    "",
    "# Remote mirrors. mode defaults to \"metadata\" (no prompts, code or tool output).",
    "# [[sinks]]",
    '# kind = "otlp"',
    '# endpoint = "http://localhost:4318"',
    '# mode = "metadata"',
    '# headers = { Authorization = "Bearer ${OTEL_TOKEN}" }',
    "",
  ].join("\n");
}

/** Writes the default config if none exists (or `force`). Returns the path and whether it wrote. */
export function writeDefaultConfig(env: NodeJS.ProcessEnv = process.env, opts: { force?: boolean } = {}): { path: string; written: boolean } {
  const file = paths(env).config;
  if (existsSync(file) && !opts.force) return { path: file, written: false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, defaultConfigToml(env), { mode: 0o600 });
  return { path: file, written: true };
}
