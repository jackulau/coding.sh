// Keys and credentials for `coding.sh serve`.
//
// Ingest keys (`csh_ik_…`) decide the project of what they send; read keys
// (`csh_rk_…`) open the viewer, /api and /metrics, for one project or all ("*").
// Only sha256 hashes are kept in memory and in config files; a presented key is
// hashed and looked up. Ingest keys cannot read and read keys cannot ingest.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { DEFAULT_PROJECT, isProjectId } from "./project.ts";

export const INGEST_KEY_PREFIX = "csh_ik_";
export const READ_KEY_PREFIX = "csh_rk_";
export const READ_COOKIE = "csh_rk";
/** The read cookie over HTTPS: `__Host-` makes the browser require Secure, Path=/ and no Domain. */
export const SECURE_READ_COOKIE = `__Host-${READ_COOKIE}`;

/** "*" = every project. */
export type ReadScope = string;

export interface BasicCredential {
  user: string;
  /** sha256 hex of the password. */
  passwordSha256: string;
}

export interface Credentials {
  /** sha256 hex of an ingest key → project. */
  ingest: Map<string, string>;
  /** sha256 hex of a read key → project or "*". */
  read: Map<string, ReadScope>;
  /** sha256 hex of a read key → its name (config `read_keys = [{…, name}]`), recorded as label `by`. */
  readNames?: Map<string, string>;
  basic?: BasicCredential;
}

export class KeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyFormatError";
  }
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A new key: prefix + 32 random bytes in base64url. */
export function generateKey(kind: "ingest" | "read"): string {
  return (kind === "ingest" ? INGEST_KEY_PREFIX : READ_KEY_PREFIX) + randomBytes(32).toString("base64url");
}

const SHA_ENTRY = /^sha256:([0-9a-f]{64})$/i;

/** A key or `sha256:<hex>` as the hash to look up. */
export function keyHash(entry: string): string {
  const m = SHA_ENTRY.exec(entry.trim());
  if (m) return m[1]!.toLowerCase();
  const k = entry.trim();
  if (k.length < 16) throw new KeyFormatError("a key must be at least 16 characters (generate one with `coding.sh serve keygen`)");
  return sha256(k);
}

/** keyHash, with the entry's position in front of its error. */
function entryHash(key: string, where: string): string {
  try {
    return keyHash(key);
  } catch (e) {
    if (e instanceof KeyFormatError) throw new KeyFormatError(`${where}: ${e.message}`);
    throw e;
  }
}

/** Splits `project:rest`, where rest may itself be `sha256:<hex>` or a key. A bare entry has no project. */
function splitEntry(entry: string): { project?: string; key: string } {
  const e = entry.trim();
  if (SHA_ENTRY.test(e)) return { key: e };
  const i = e.indexOf(":");
  if (i <= 0) return { key: e };
  return { project: e.slice(0, i), key: e.slice(i + 1) };
}

/** `CODING_SH_INGEST_KEYS`: comma-separated `project:key`, `project:sha256:<hex>`, or a bare key (project default). */
export function parseIngestKeys(value: string | undefined, into: Map<string, string> = new Map()): Map<string, string> {
  // An entry holds a secret, so an error names its position, never its text.
  let n = 0;
  for (const raw of (value ?? "").split(",")) {
    if (!raw.trim()) continue;
    const where = `CODING_SH_INGEST_KEYS entry ${++n}`;
    const { project = DEFAULT_PROJECT, key } = splitEntry(raw);
    if (!isProjectId(project)) throw new KeyFormatError(`${where} has an invalid project id before its ":" (use a-z, 0-9 and -, up to 63 chars; the form is project:key)`);
    into.set(entryHash(key, where), project);
  }
  return into;
}

/** `CODING_SH_READ_KEYS`: comma-separated `*:key` (all projects) or `project:key` (either may be `sha256:<hex>`). A bare key reads all. */
export function parseReadKeys(value: string | undefined, into: Map<string, ReadScope> = new Map()): Map<string, ReadScope> {
  let n = 0;
  for (const raw of (value ?? "").split(",")) {
    if (!raw.trim()) continue;
    const where = `CODING_SH_READ_KEYS entry ${++n}`;
    const { project = "*", key } = splitEntry(raw);
    if (project !== "*" && !isProjectId(project)) throw new KeyFormatError(`${where} has an invalid project before its ":" (use * or a project id; the form is project:key)`);
    into.set(entryHash(key, where), project);
  }
  return into;
}

/** `CODING_SH_BASIC_AUTH=user:password`. */
export function parseBasicAuth(value: string | undefined): BasicCredential | undefined {
  if (!value) return undefined;
  const i = value.indexOf(":");
  if (i <= 0 || i === value.length - 1) throw new KeyFormatError("CODING_SH_BASIC_AUTH must be user:password");
  return { user: value.slice(0, i), passwordSha256: sha256(value.slice(i + 1)) };
}

/**
 * Langfuse's OTLP traces path (LANGFUSE_TRACES_PATH in otel/receiver.ts, which this file does not
 * load). A Langfuse SDK sends Basic auth there: public key as the user, secret key as the password.
 */
export const LANGFUSE_INGEST_PATH = "/api/public/otel/v1/traces";

const bearer = (req: IncomingMessage): string | undefined => {
  const h = req.headers.authorization;
  if (typeof h !== "string") return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1];
};

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(sha256(a));
  const y = Buffer.from(sha256(b));
  return timingSafeEqual(x, y);
};

/**
 * Who a read key is, as recorded on labels (`by`): its configured name, else
 * `reader:` plus the first 12 hex of its sha256 (the hash config files hold; never the key).
 */
export const readKeyId = (hash: string, names?: Map<string, string>): string => names?.get(hash) ?? `reader:${hash.slice(0, 12)}`;

export interface Authenticator {
  /** Project for an ingest request, or undefined (401). With no ingest keys configured, `open` decides. */
  ingest(req: IncomingMessage): string | undefined;
  /** Same, for a raw key from elsewhere than Authorization (the proxy routes' x-coding-sh-key). */
  ingestKey(key: string | undefined, req: IncomingMessage): string | undefined;
  /** Read access for the viewer, /api and /metrics, or undefined (401). */
  read(req: IncomingMessage): { project?: string; by?: string } | undefined;
  /** The read scope of a raw read key (for the viewer's `?t=` exchange). */
  readScope(key: string): ReadScope | undefined;
  readonly hasIngestKeys: boolean;
  readonly hasReadCredentials: boolean;
}

/** A request that a proxy passed on: it names a forwarded client, host or hop. */
export function viaProxy(req: IncomingMessage): boolean {
  return Object.keys(req.headers).some((h) => h.startsWith("x-forwarded-") || h === "forwarded" || h === "via");
}

/**
 * openIngest: no ingest keys configured and the server may run open (loopback or
 * --insecure), so ingest lands in project default. openRead: same for reading.
 * directOnly: the open fallback serves only requests that did not come through a
 * proxy (a loopback bind is open because only this machine can reach it).
 */
export function createAuthenticator(creds: Credentials, o: { openIngest: boolean; openRead: boolean; directOnly?: boolean; onProxied?: () => void }): Authenticator {
  const hasIngestKeys = creds.ingest.size > 0;
  const hasReadCredentials = creds.read.size > 0 || !!creds.basic;
  const readScope = (key: string): ReadScope | undefined => (key ? creds.read.get(sha256(key)) : undefined);
  const reader = (key: string) => {
    const hash = sha256(key);
    const scope = creds.read.get(hash);
    return scope === undefined ? undefined : { ...scoped(scope), by: readKeyId(hash, creds.readNames) };
  };
  const scoped = (scope: ReadScope) => (scope === "*" ? {} : { project: scope });
  const openTo = (req: IncomingMessage) => {
    if (!o.directOnly || !viaProxy(req)) return true;
    o.onProxied?.();
    return false;
  };
  const ingestKey = (key: string | undefined, req: IncomingMessage): string | undefined => {
    if (key) return creds.ingest.get(sha256(key));
    return !hasIngestKeys && o.openIngest && openTo(req) ? DEFAULT_PROJECT : undefined;
  };
  // On Langfuse's path only: the Basic user or password that is an ingest key, so a Langfuse SDK keeps
  // its two keys and one of them is the ingest key. Neither: no key (401 unless the server runs open).
  const langfuseKey = (req: IncomingMessage): string | undefined => {
    if ((req.url ?? "").split("?")[0] !== LANGFUSE_INGEST_PATH) return undefined;
    const m = /^Basic\s+(\S+)\s*$/i.exec(typeof req.headers.authorization === "string" ? req.headers.authorization : "");
    if (!m) return undefined;
    const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
    const i = decoded.indexOf(":");
    const parts = i < 0 ? [decoded] : [decoded.slice(0, i), decoded.slice(i + 1)];
    return parts.find((p) => p !== "" && creds.ingest.has(sha256(p)));
  };

  return {
    hasIngestKeys,
    hasReadCredentials,
    readScope,
    ingest: (req) => ingestKey(bearer(req) ?? langfuseKey(req), req),
    ingestKey,
    read(req) {
      const key = bearer(req);
      const byKey = key ? reader(key) : undefined;
      if (byKey) return byKey;
      // Either name: a browser signed in before HTTPS was detected still holds the plain one.
      const cookie = readCookie(req.headers.cookie, SECURE_READ_COOKIE) ?? readCookie(req.headers.cookie, READ_COOKIE);
      const byCookie = cookie ? reader(cookie) : undefined;
      if (byCookie) return byCookie;
      const h = req.headers.authorization;
      if (creds.basic && typeof h === "string" && /^Basic\s+/i.test(h)) {
        const decoded = Buffer.from(h.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
        const i = decoded.indexOf(":");
        if (i > 0) {
          const user = decoded.slice(0, i);
          const okUser = sameText(user, creds.basic.user);
          const okPass = timingSafeEqual(Buffer.from(sha256(decoded.slice(i + 1))), Buffer.from(creds.basic.passwordSha256.toLowerCase()));
          if (okUser && okPass) return { by: user };
        }
      }
      if (!hasReadCredentials && o.openRead && openTo(req)) return {};
      return undefined;
    },
  };
}
