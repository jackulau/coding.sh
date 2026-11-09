// First-start keys for `coding.sh serve`. A public bind with no ingest key, no read key, no
// basic auth and no --insecure would be refused. Instead serve makes one ingest key (project
// "default") and one read key (every project), keeps them in <CODING_SH_HOME>/serve-keys.json
// (mode 600, next to the SQLite index) and uses the same file on every later start. Configuring
// any key or basic auth turns this off. A viewer replica never makes keys: it must share them.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError } from "../core/config.ts";
import { dataHome } from "../core/paths.ts";
import { isLoopbackHost } from "../otel/receiver.ts";
import { generateKey, INGEST_KEY_PREFIX, READ_KEY_PREFIX, sha256 } from "./auth.ts";
import type { ServeConfig } from "./config.ts";
import { DEFAULT_PROJECT } from "./project.ts";

export interface FirstStartKeys {
  ingest: string;
  read: string;
  file: string;
  /** True when this start made the file. */
  created: boolean;
}

export const keysFile = (env: NodeJS.ProcessEnv): string => join(dataHome(env), "serve-keys.json");

/** True when serve would otherwise refuse to start for lack of credentials and may make its own. */
export function wantsFirstStartKeys(c: ServeConfig): boolean {
  if (c.insecure || isLoopbackHost(c.host) || c.role !== "all") return false;
  return c.credentials.ingest.size === 0 && c.credentials.read.size === 0 && !c.credentials.basic;
}

const KEY = (prefix: string) => new RegExp(`^${prefix}[A-Za-z0-9_-]{16,}$`);

/** Reads the keys file, or creates it (mode 600, written atomically). A damaged file is an error, never replaced. */
export function loadOrCreateKeys(env: NodeJS.ProcessEnv): FirstStartKeys {
  const file = keysFile(env);
  if (existsSync(file)) {
    let doc: { ingest?: unknown; read?: unknown };
    try {
      doc = JSON.parse(readFileSync(file, "utf8")) as typeof doc;
    } catch (e) {
      throw new ConfigError(`${file} is not valid JSON (${(e as Error).message}); fix it, or, with the user's approval, delete it to make new keys (clients holding the old keys stop working)`);
    }
    const { ingest, read } = doc ?? {};
    if (typeof ingest !== "string" || !KEY(INGEST_KEY_PREFIX).test(ingest) || typeof read !== "string" || !KEY(READ_KEY_PREFIX).test(read)) {
      throw new ConfigError(`${file} needs "ingest": "csh_ik_…" and "read": "csh_rk_…"; fix it, or, with the user's approval, delete it to make new keys (clients holding the old keys stop working)`);
    }
    return { ingest, read, file, created: false };
  }
  const keys = { ingest: generateKey("ingest"), read: generateKey("read") };
  const body = `${JSON.stringify({ ...keys, project: DEFAULT_PROJECT, createdAt: new Date().toISOString() }, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return { ...keys, file, created: true };
}

/** Adds the keys' hashes to the config: ingest into project "default", read for every project. */
export function applyFirstStartKeys(c: ServeConfig, keys: FirstStartKeys): void {
  c.credentials.ingest.set(sha256(keys.ingest), DEFAULT_PROJECT);
  c.credentials.read.set(sha256(keys.read), "*");
}

/** What serve prints on stdout after its URL, so `docker logs` shows how to connect. */
export function firstStartText(keys: FirstStartKeys, url: string): string[] {
  return [
    `No keys are configured, so serve uses the keys in ${keys.file}${keys.created ? " (made now)" : ""}:`,
    `  read key    ${keys.read}`,
    `  ingest key  ${keys.ingest}`,
    `  Open        ${url}/?t=${keys.read}`,
    `  Connect     coding.sh init --remote ${url} --key ${keys.ingest}`,
    "Use the server's public URL in place of the one above. Set CODING_SH_INGEST_KEYS and CODING_SH_READ_KEYS to use your own keys.",
  ];
}
