// Ownership records for files coding.sh creates whole, in formats with no room
// for a `_codingsh` marker (Copilot CLI hook files). ~/.coding.sh/installs.json
// maps each absolute path to the agent and the sha256 of the text we wrote, so
// uninstall can tell "our file, untouched" from a file the user owns or edited.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { paths } from "../../core/paths.ts";

export interface InstallRecord {
  agent: string;
  sha256: string;
  /** ms since epoch of the write. */
  ts: number;
  /**
   * Edits to a file that existed (MCP registration): the backup holding the
   * text from before coding.sh first touched it, or null when coding.sh created
   * the file. While the file still hashes to `sha256`, uninstall restores this
   * byte-for-byte. Absent = no exact restore known.
   */
  restore?: string | null;
}

interface InstallsFile {
  v: 1;
  files: Record<string, InstallRecord>;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function load(env: NodeJS.ProcessEnv): InstallsFile {
  try {
    const v = JSON.parse(readFileSync(paths(env).installs, "utf8")) as Partial<InstallsFile>;
    if (v && typeof v === "object" && v.files && typeof v.files === "object" && !Array.isArray(v.files)) return { v: 1, files: v.files };
  } catch {
    // missing or unreadable: no records
  }
  return { v: 1, files: {} };
}

function save(f: InstallsFile, env: NodeJS.ProcessEnv): void {
  const file = paths(env).installs;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.codingsh-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** The ownership record for `path`, if coding.sh wrote it. */
export function installRecord(path: string, env: NodeJS.ProcessEnv = process.env): InstallRecord | undefined {
  return load(env).files[resolve(path)];
}

/** True when coding.sh wrote `path` and its current text is exactly what we wrote. */
export function ownsInstall(path: string, text: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (text === undefined) return false;
  const r = installRecord(path, env);
  return r !== undefined && r.sha256 === sha256(text);
}

/** Record that coding.sh wrote `text` to `path` (with the original to restore, when known). */
export function recordInstall(agent: string, path: string, text: string, env: NodeJS.ProcessEnv = process.env, now = Date.now(), restore?: string | null): void {
  const f = load(env);
  f.files[resolve(path)] = { agent, sha256: sha256(text), ts: now, ...(restore !== undefined ? { restore } : {}) };
  save(f, env);
}

/** Drop the record for `path` (after uninstall removed the file). */
export function forgetInstall(path: string, env: NodeJS.ProcessEnv = process.env): void {
  const f = load(env);
  const key = resolve(path);
  if (!(key in f.files)) return;
  delete f.files[key];
  save(f, env);
}

// ---------------------------------------------------------------- exact restore

/**
 * What uninstall should restore for a tracked install write: null when coding.sh
 * created the file; the earlier record's original when `before` is our own
 * untouched write (re-install, or a second coding.sh edit of the same file);
 * else `backup` when `before` held none of our entries (so the backup is the
 * user's file as it was). Undefined = no exact restore known.
 */
export function restoreForInstall(path: string, before: string | undefined, pristine: boolean, backup: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null | undefined {
  if (before === undefined) return null;
  const rec = installRecord(path, env);
  if (rec && rec.restore !== undefined && rec.sha256 === sha256(before)) return rec.restore;
  return pristine && backup ? backup : undefined;
}

/** True when the install record says the file existed before coding.sh first edited it. */
export function existedBeforeInstall(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof installRecord(path, env)?.restore === "string";
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/**
 * Comparison key for a JSON config: key order ignored, and so are the empty
 * containers an install/uninstall round trip adds or drops (an empty `hooks`
 * map or event list, and `ignore` keys at their default, e.g. Cursor's version: 1).
 */
export function configKey(v: unknown, ignore: Record<string, unknown> = {}): string {
  if (!isPlainObject(v)) return stableJson(v);
  const o: Record<string, unknown> = { ...v };
  if (isPlainObject(o.hooks)) {
    const hooks = Object.fromEntries(Object.entries(o.hooks).filter(([, x]) => !(Array.isArray(x) && x.length === 0)));
    if (Object.keys(hooks).length) o.hooks = hooks;
    else delete o.hooks;
  }
  for (const [k, d] of Object.entries(ignore)) if (k in o && stableJson(o[k]) === stableJson(d)) delete o[k];
  return stableJson(o);
}

export interface ExactUninstallOpts {
  env?: NodeJS.ProcessEnv;
  /** Parser for the original file (default JSON.parse; JSONC configs pass their own). */
  parse?: (text: string) => unknown;
  /** Keys whose default value does not count as content (see configKey). */
  ignore?: Record<string, unknown>;
}

/**
 * Exact uninstall for a tracked config file. Applies only while the file is
 * byte-identical to coding.sh's last write. Then, when what remains after
 * removing our entries (`remaining`, undefined = nothing) matches the original,
 * returns the original bytes; when coding.sh created the file and nothing else
 * remains, returns { after: undefined } (delete). Else undefined: the caller
 * falls back to stripping our entries.
 */
export function exactUninstall(path: string, current: string, remaining: unknown, opts: ExactUninstallOpts = {}): { after: string | undefined; summary: string } | undefined {
  const env = opts.env ?? process.env;
  const rec = installRecord(path, env);
  if (!rec || rec.restore === undefined || rec.sha256 !== sha256(current)) return undefined;
  const left = configKey(remaining ?? {}, opts.ignore);
  if (rec.restore === null) return left === configKey({}, opts.ignore) ? { after: undefined, summary: "coding.sh created this file" } : undefined;
  let original: string;
  try {
    original = readFileSync(rec.restore, "utf8");
  } catch {
    return undefined; // backup gone
  }
  let parsed: unknown;
  try {
    const t = original.charCodeAt(0) === 0xfeff ? original.slice(1) : original;
    parsed = t.trim() === "" ? {} : (opts.parse ?? JSON.parse)(t);
  } catch {
    return undefined;
  }
  return configKey(parsed, opts.ignore) === left ? { after: original, summary: "restore the file as it was" } : undefined;
}
