// First-start keys for `coding.sh serve`. A public bind with no ingest key, no read key, no
// basic auth and no --insecure would be refused. Instead serve makes one ingest key (project
// "default") and one read key (every project), keeps them in <CODING_SH_HOME>/serve-keys.json
// (mode 600, next to the SQLite index) and uses the same file on every later start. Configuring
// any key or basic auth turns this off. A viewer replica never makes keys: it must share them.
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

function readKeys(file: string): FirstStartKeys | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let doc: { ingest?: unknown; read?: unknown };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    // The parser's message quotes the start of the file, which may be a key.
    throw new ConfigError(`${file} is not valid JSON; fix it, or, with the user's approval, delete it to make new keys (clients holding the old keys stop working)`);
  }
  const { ingest, read } = doc ?? {};
  if (typeof ingest !== "string" || !KEY(INGEST_KEY_PREFIX).test(ingest) || typeof read !== "string" || !KEY(READ_KEY_PREFIX).test(read)) {
    throw new ConfigError(`${file} needs "ingest": "csh_ik_…" and "read": "csh_rk_…"; fix it, or, with the user's approval, delete it to make new keys (clients holding the old keys stop working)`);
  }
  return { ingest, read, file, created: false };
}

/**
 * Writes `body` to `file` (mode 600) only if no file is there yet: the body goes to a temp file
 * that is then hard-linked into place, which fails when another start made the file first.
 * False when the file already existed.
 */
export function writeKeysOnce(file: string, body: string): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(tmp, 0o600);
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    unlinkSync(tmp);
  }
}

/** Reads the keys file, or creates it (mode 600, never over another start's). A damaged file is an error, never replaced. */
export function loadOrCreateKeys(env: NodeJS.ProcessEnv): FirstStartKeys {
  const file = keysFile(env);
  const found = readKeys(file);
  if (found) return found;
  const keys = { ingest: generateKey("ingest"), read: generateKey("read") };
  const body = `${JSON.stringify({ ...keys, project: DEFAULT_PROJECT, createdAt: new Date().toISOString() }, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  if (writeKeysOnce(file, body)) return { ...keys, file, created: true };
  const theirs = readKeys(file);
  if (!theirs) throw new ConfigError(`${file} was made and removed while serve was starting; start serve again`);
  return theirs;
}

/** Removes the keys file this start made, when serve then failed to start: its keys were never printed. */
export function dropUnprintedKeys(keys: FirstStartKeys | undefined): void {
  if (keys?.created) rmSync(keys.file, { force: true });
}

/** Adds the keys' hashes to the config: ingest into project "default", read for every project. */
export function applyFirstStartKeys(c: ServeConfig, keys: FirstStartKeys): void {
  c.credentials.ingest.set(sha256(keys.ingest), DEFAULT_PROJECT);
  c.credentials.read.set(sha256(keys.read), "*");
}

/**
 * What serve prints on stdout after its URL, so `docker logs` shows how to connect. The keys are
 * printed once, on the start that makes them; a later start names the file that holds them.
 */
export function firstStartText(keys: FirstStartKeys, url: string): string[] {
  if (!keys.created) {
    return [
      `No keys are configured, so serve uses the keys in ${keys.file}. They were printed on the start that made them; read them from that file.`,
      "Use the server's public URL in place of the one above. Set CODING_SH_INGEST_KEYS and CODING_SH_READ_KEYS to use your own keys.",
    ];
  }
  return [
    `No keys are configured, so serve uses the keys in ${keys.file} (made now; they are not printed again):`,
    `  read key    ${keys.read}`,
    `  ingest key  ${keys.ingest}`,
    `  Open        ${url}/?t=${keys.read}`,
    `  Connect     coding.sh init --remote ${url} --key ${keys.ingest}`,
    "Use the server's public URL in place of the one above. Set CODING_SH_INGEST_KEYS and CODING_SH_READ_KEYS to use your own keys.",
  ];
}
