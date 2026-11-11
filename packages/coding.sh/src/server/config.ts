// Effective configuration for `coding.sh serve`: flags > env > the --config file
// (or ~/.coding.sh/config.toml) > defaults. See docs/PRODUCTION.md §1.1.
import type { Config } from "../core/types.ts";
import { ConfigError, interpolateEnv, isPostgresUrl, loadConfig, readUserConfigTable } from "../core/config.ts";
import type { TomlTable } from "../core/toml.ts";
import { isLoopbackHost } from "../otel/receiver.ts";
import { proxySettings, upstreamProblem } from "../proxy/state.ts";
import type { Upstreams } from "../proxy/server.ts";
import { type BasicCredential, type Credentials, KeyFormatError, keyHash, parseBasicAuth, parseIngestKeys, parseReadKeys } from "./auth.ts";
import { DEFAULT_PROJECT, isProjectId } from "./project.ts";

export const DEFAULT_SERVE_PORT = 4318;
export const DEFAULT_QUEUE_MAX_EVENTS = 50_000;
export const DEFAULT_QUEUE_MAX_BYTES = 128 * 1024 * 1024;
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const MAX_EVENTS_PER_REQUEST = 10_000;
export const WRITER_TICK_EVENTS = 5_000;
export const DRAIN_TIMEOUT_MS = 25_000;
export const DEFAULT_FORWARD_MAX_BUFFER_SPANS = 20_000;

export type ServeRole = "all" | "viewer";

export interface ServeFlags {
  host?: string;
  port?: number;
  config?: string;
  role?: ServeRole;
  insecure?: boolean;
}

/** `[serve.forward]` / CODING_SH_FORWARD_URL: committed traces go on to an OTLP/HTTP collector. */
export interface ForwardConfig {
  /** Collector base URL (…/v1/traces is appended unless present). */
  endpoint: string;
  headers: Record<string, string>;
  /** metadata: an allowlist of attributes; full: every attribute, redacted. Default capture.mode. */
  mode: "full" | "metadata";
  /** Spans held while the collector is down; the oldest are dropped past this. */
  maxBufferSpans: number;
}

export interface ServeConfig {
  /** Core config (stores, capture, pricing); update.check forced off. */
  core: Config;
  host: string;
  port: number;
  role: ServeRole;
  credentials: Credentials;
  /** Every known project: configured, named by a key, plus default. */
  projects: string[];
  queueMaxEvents: number;
  queueMaxBytes: number;
  /** Days to keep, by project (0 = forever). */
  retentionDays: Map<string, number>;
  insecure: boolean;
  trustProxy: boolean;
  log: "json" | "text";
  corsOrigins: string[];
  /** Config file read (exists or not), for messages. */
  configFile: string;
  /** Unset: serve forwards nothing. */
  forward?: ForwardConfig;
  /**
   * Where /proxy/* forwards. With --config, only the [proxy] table of that file (the user's config.toml
   * and proxy.json are not read); otherwise the same settings `coding.sh proxy` uses.
   */
  proxyUpstreams: Partial<Upstreams>;
}

/** Thrown when serve must refuse to start (exit 2). */
export class ServeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeRefusal";
  }
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

function envInt(env: NodeJS.ProcessEnv, name: string, min = 0): number | undefined {
  const v = env[name]?.trim();
  if (!v) return undefined;
  if (!/^\d+$/.test(v) || Number(v) < min) throw new ConfigError(`${name} must be an integer >= ${min}, got ${JSON.stringify(v)}`);
  return Number(v);
}

function table(t: TomlTable | undefined, key: string, file: string): TomlTable | undefined {
  const v = t?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(`${key} must be a table`, file);
  return v as TomlTable;
}

function tomlInt(t: TomlTable | undefined, key: string, where: string, file: string, min = 0): number | undefined {
  const v = t?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new ConfigError(`${where} must be an integer >= ${min}, got ${JSON.stringify(v)}`, file);
  return v;
}

function tomlString(t: TomlTable | undefined, key: string, where: string, file: string): string | undefined {
  const v = t?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ConfigError(`${where} must be a string`, file);
  return v;
}

function tomlBool(t: TomlTable | undefined, key: string, where: string, file: string): boolean | undefined {
  const v = t?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ConfigError(`${where} must be true or false`, file);
  return v;
}

function hashEntry(v: unknown, where: string, file: string): string {
  if (typeof v !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(v)) {
    throw new ConfigError(`${where} must be "sha256:<64 hex chars>"; config files hold hashes, never keys (coding.sh serve keygen prints the line)`, file);
  }
  return keyHash(v);
}

/** Resolves the effective serve config. Throws ConfigError / KeyFormatError on bad input. */
export function resolveServeConfig(flags: ServeFlags, envIn: NodeJS.ProcessEnv): ServeConfig {
  const env: NodeJS.ProcessEnv = { ...envIn };
  // DATABASE_URL (what hosting platforms inject) is the store when nothing more specific is set.
  // Serve only: the CLI never picks up an app's DATABASE_URL on its own.
  if (!env.CODING_SH_STORE_URL?.trim() && env.DATABASE_URL && isPostgresUrl(env.DATABASE_URL.trim())) env.CODING_SH_STORE_URL = env.DATABASE_URL.trim();
  if (env.CODING_SH_CAPTURE_MODE !== undefined && !["full", "metadata"].includes(env.CODING_SH_CAPTURE_MODE)) {
    throw new ConfigError(`CODING_SH_CAPTURE_MODE must be "full" or "metadata", got ${JSON.stringify(env.CODING_SH_CAPTURE_MODE)}`);
  }
  const core = loadConfig({ env, ...(flags.config ? { file: flags.config } : {}) });
  core.update = { ...core.update, check: false };
  if (env.CODING_SH_CAPTURE_MODE) core.capture = { ...core.capture, mode: env.CODING_SH_CAPTURE_MODE as "full" | "metadata" };

  const { table: root, file } = readUserConfigTable(env, flags.config);
  const serve = table(root, "serve", file);
  const viewer = table(serve, "viewer", file);

  // ---- credentials
  const credentials: Credentials = { ingest: new Map(), read: new Map() };
  const projects = new Set<string>([DEFAULT_PROJECT]);
  const retentionDays = new Map<string, number>();
  const rawProjects = serve?.projects;
  if (rawProjects !== undefined) {
    if (!Array.isArray(rawProjects)) throw new ConfigError("serve.projects must be an array of tables ([[serve.projects]])", file);
    rawProjects.forEach((p, i) => {
      const where = `serve.projects[${i}]`;
      if (typeof p !== "object" || p === null || Array.isArray(p)) throw new ConfigError(`${where} must be a table`, file);
      const t = p as TomlTable;
      const id = tomlString(t, "id", `${where}.id`, file);
      if (!id || !isProjectId(id)) throw new ConfigError(`${where}.id must match ^[a-z0-9][a-z0-9-]{0,62}$`, file);
      projects.add(id);
      const keys = t.ingest_keys;
      if (keys !== undefined) {
        if (!Array.isArray(keys)) throw new ConfigError(`${where}.ingest_keys must be an array of "sha256:<hex>" strings`, file);
        keys.forEach((k, j) => credentials.ingest.set(hashEntry(k, `${where}.ingest_keys[${j}]`, file), id));
      }
      const days = tomlInt(t, "retention_days", `${where}.retention_days`, file);
      if (days !== undefined) retentionDays.set(id, days);
    });
  }
  const readKeys = viewer?.read_keys;
  if (readKeys !== undefined) {
    if (!Array.isArray(readKeys)) throw new ConfigError('serve.viewer.read_keys must be an array of {project, key = "sha256:<hex>"}', file);
    readKeys.forEach((k, i) => {
      const where = `serve.viewer.read_keys[${i}]`;
      if (typeof k !== "object" || k === null || Array.isArray(k)) throw new ConfigError(`${where} must be {project = "*", key = "sha256:<hex>"}`, file);
      const t = k as TomlTable;
      const project = tomlString(t, "project", `${where}.project`, file) ?? "*";
      if (project !== "*" && !isProjectId(project)) throw new ConfigError(`${where}.project must be "*" or a project id`, file);
      const hash = hashEntry(t.key, `${where}.key`, file);
      credentials.read.set(hash, project);
      const name = tomlString(t, "name", `${where}.name`, file);
      if (name !== undefined) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(name)) throw new ConfigError(`${where}.name must be 1-64 letters, digits, ".", "_", "@" or "-"`, file);
        (credentials.readNames ??= new Map()).set(hash, name);
      }
    });
  }
  const basicUser = tomlString(viewer, "basic_user", "serve.viewer.basic_user", file);
  const basicHash = tomlString(viewer, "basic_password_sha256", "serve.viewer.basic_password_sha256", file);
  let basic: BasicCredential | undefined;
  if (basicUser !== undefined || basicHash !== undefined) {
    const hex = basicHash?.replace(/^sha256:/i, "");
    if (!basicUser || !hex || !/^[0-9a-f]{64}$/i.test(hex)) throw new ConfigError("serve.viewer needs both basic_user and basic_password_sha256 (64 hex chars)", file);
    basic = { user: basicUser, passwordSha256: hex.toLowerCase() };
  }
  // Env adds to (and for basic auth, replaces) what the file has.
  try {
    parseIngestKeys(env.CODING_SH_INGEST_KEYS, credentials.ingest);
    parseReadKeys(env.CODING_SH_READ_KEYS, credentials.read);
    basic = parseBasicAuth(env.CODING_SH_BASIC_AUTH) ?? basic;
  } catch (e) {
    if (e instanceof KeyFormatError) throw new ConfigError(e.message);
    throw e;
  }
  if (basic) credentials.basic = basic;
  for (const p of credentials.ingest.values()) projects.add(p);
  for (const p of credentials.read.values()) if (p !== "*") projects.add(p);

  // ---- listener and limits
  const host = flags.host ?? (env.CODING_SH_HOST?.trim() || undefined) ?? tomlString(serve, "host", "serve.host", file) ?? "127.0.0.1";
  const port = flags.port ?? envInt(env, "CODING_SH_PORT") ?? envInt(env, "PORT") ?? tomlInt(serve, "port", "serve.port", file) ?? DEFAULT_SERVE_PORT;
  if (port > 65535) throw new ConfigError(`port must be 0-65535, got ${port}`);
  const globalDays = envInt(env, "CODING_SH_RETENTION_DAYS") ?? tomlInt(serve, "retention_days", "serve.retention_days", file) ?? 0;
  for (const p of projects) if (!retentionDays.has(p)) retentionDays.set(p, globalDays);
  const logFormat = env.CODING_SH_LOG?.trim() || tomlString(serve, "log", "serve.log", file);
  if (logFormat !== undefined && logFormat !== "json" && logFormat !== "text") throw new ConfigError(`CODING_SH_LOG / serve.log must be "json" or "text", got ${JSON.stringify(logFormat)}`);
  const cors = serve?.cors_origins;
  if (cors !== undefined && (!Array.isArray(cors) || !cors.every((c) => typeof c === "string"))) throw new ConfigError("serve.cors_origins must be an array of origins", file);

  const forward = resolveForward(serve, env, core.capture.mode, file);
  const proxyUpstreams = flags.config ? resolveProxyUpstreams(table(root, "proxy", file), file) : proxySettings(env).upstreams;

  return {
    core,
    host,
    port,
    role: flags.role ?? "all",
    credentials,
    projects: [...projects].sort(),
    queueMaxEvents: envInt(env, "CODING_SH_QUEUE_MAX_EVENTS", 1) ?? tomlInt(serve, "queue_max_events", "serve.queue_max_events", file, 1) ?? DEFAULT_QUEUE_MAX_EVENTS,
    queueMaxBytes: envInt(env, "CODING_SH_QUEUE_MAX_BYTES", 1) ?? tomlInt(serve, "queue_max_bytes", "serve.queue_max_bytes", file, 1) ?? DEFAULT_QUEUE_MAX_BYTES,
    retentionDays,
    insecure: flags.insecure === true || truthy(env.CODING_SH_INSECURE) || tomlBool(serve, "insecure", "serve.insecure", file) === true,
    trustProxy: truthy(env.CODING_SH_TRUST_PROXY) || tomlBool(serve, "trust_proxy", "serve.trust_proxy", file) === true,
    log: (logFormat as "json" | "text" | undefined) ?? (process.stderr.isTTY ? "text" : "json"),
    corsOrigins: (cors as string[] | undefined) ?? [],
    configFile: file,
    proxyUpstreams,
    ...(forward ? { forward } : {}),
  };
}

/** [proxy] anthropic_upstream, openai_upstream and chatgpt_upstream of a serve config file. */
function resolveProxyUpstreams(t: TomlTable | undefined, file: string): Partial<Upstreams> {
  const out: Partial<Upstreams> = {};
  for (const name of ["anthropic", "openai", "chatgpt"] as const) {
    const where = `proxy.${name}_upstream`;
    const v = tomlString(t, `${name}_upstream`, where, file);
    if (v === undefined) continue;
    const problem = upstreamProblem(v);
    if (problem) throw new ConfigError(`${where} ${problem}`, file);
    out[name] = v;
  }
  return out;
}

/** `k=v,k2=v2`, each part URL-decoded (the OTEL_EXPORTER_OTLP_HEADERS format). */
export function parseHeaderList(raw: string, where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    if (!part.trim()) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) throw new ConfigError(`${where} must be k=v pairs separated by commas, got ${JSON.stringify(part.trim().replace(/=.*/, "=…"))}`);
    let k: string;
    let v: string;
    try {
      k = decodeURIComponent(part.slice(0, eq).trim());
      v = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      throw new ConfigError(`${where} has a value that is not valid URL encoding`);
    }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw new ConfigError(`${where}: ${JSON.stringify(k)} is not a valid header name`);
    out[k] = v;
  }
  return out;
}

function resolveForward(serve: TomlTable | undefined, env: NodeJS.ProcessEnv, captureMode: "full" | "metadata", file: string): ForwardConfig | undefined {
  const t = table(serve, "forward", file);
  const fileEndpoint = tomlString(t, "endpoint", "serve.forward.endpoint", file);
  const endpoint = env.CODING_SH_FORWARD_URL?.trim() || (fileEndpoint !== undefined ? interpolateEnv(fileEndpoint, env, "serve.forward.endpoint", file).trim() : undefined);
  if (!endpoint) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigError(`CODING_SH_FORWARD_URL / serve.forward.endpoint is not a URL: ${JSON.stringify(endpoint.replace(/\/\/[^@/]*@/, "//…@"))}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`CODING_SH_FORWARD_URL / serve.forward.endpoint must be an http:// or https:// OTLP endpoint, got ${url.protocol}//`);
  }
  const headers: Record<string, string> = {};
  const h = t?.headers;
  if (h !== undefined) {
    if (typeof h !== "object" || h === null || Array.isArray(h)) throw new ConfigError("serve.forward.headers must be a table", file);
    for (const [k, v] of Object.entries(h)) {
      if (typeof v !== "string") throw new ConfigError(`serve.forward.headers.${k} must be a string`, file);
      headers[k] = interpolateEnv(v, env, `serve.forward.headers.${k}`, file);
    }
  }
  if (env.CODING_SH_FORWARD_HEADERS?.trim()) Object.assign(headers, parseHeaderList(env.CODING_SH_FORWARD_HEADERS, "CODING_SH_FORWARD_HEADERS"));
  const mode = env.CODING_SH_FORWARD_MODE?.trim() || tomlString(t, "mode", "serve.forward.mode", file) || captureMode;
  if (mode !== "full" && mode !== "metadata") throw new ConfigError(`CODING_SH_FORWARD_MODE / serve.forward.mode must be "full" or "metadata", got ${JSON.stringify(mode)}`);
  const maxBufferSpans = envInt(env, "CODING_SH_FORWARD_MAX_BUFFER_SPANS", 1) ?? tomlInt(t, "max_buffer_spans", "serve.forward.max_buffer_spans", file, 1) ?? DEFAULT_FORWARD_MAX_BUFFER_SPANS;
  return { endpoint, headers, mode, maxBufferSpans };
}

/**
 * The refusal rule: a non-loopback bind needs at least one ingest key and a read
 * key or basic auth, unless --insecure. (A viewer-role replica needs read credentials only.)
 */
export function checkExposure(c: ServeConfig): void {
  if (c.insecure || isLoopbackHost(c.host)) return;
  const ingest = c.credentials.ingest.size > 0;
  const read = c.credentials.read.size > 0 || !!c.credentials.basic;
  if ((c.role === "viewer" || ingest) && read) return;
  const missing = [
    ...(c.role !== "viewer" && !ingest ? ["an ingest key (CODING_SH_INGEST_KEYS, or [[serve.projects]] ingest_keys)"] : []),
    ...(!read ? ["a read key or basic auth (CODING_SH_READ_KEYS or CODING_SH_BASIC_AUTH)"] : []),
  ];
  throw new ServeRefusal(
    `refusing to listen on ${c.host} without auth: set ${missing.join(" and ")}, or pass --insecure (CODING_SH_INSECURE=1) to run open. ` +
      "Generate keys with `coding.sh serve keygen --project <id>`.",
  );
}
