// File-edit planning for install/uninstall: every change is computed first as
// a FileChange (full before/after text), then applied with a backup and an
// atomic rename. Dry runs stop after planning, so they never touch disk.
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { paths } from "../../core/paths.ts";
import type { FileChange } from "../../core/types.ts";

/** File text, or undefined when it does not exist. */
export function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw e;
  }
}

/**
 * Plans one file edit. `after === undefined` means "delete". Returns undefined
 * when nothing would change, which is what makes install idempotent.
 */
export function planEdit(path: string, before: string | undefined, after: string | undefined, summary: string): FileChange | undefined {
  if (before === after) return undefined;
  if (before === undefined && after === undefined) return undefined;
  const action: FileChange["action"] = before === undefined ? "create" : after === undefined ? "delete" : "modify";
  const change: FileChange = { path, action, summary };
  if (before !== undefined) change.before = before;
  if (after !== undefined) change.after = after;
  return change;
}

/** Plans an edit by running `transform` over the current text (undefined = missing). */
export function planTransform(
  path: string,
  transform: (before: string | undefined) => string | undefined,
  summary: string,
): FileChange | undefined {
  const before = readTextIfExists(path);
  return planEdit(path, before, transform(before), summary);
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Copies `path` to ~/.coding.sh/backups/<agent>/<ts>-<file>. Returns the backup path. */
export async function backupFile(agent: string, path: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  const dir = join(paths(env).backups, agent);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let dest = join(dir, `${stamp(now)}-${basename(path)}`);
  for (let n = 1; existsSync(dest); n++) dest = join(dir, `${stamp(now)}-${basename(path)}.${n}`);
  await copyFile(path, dest);
  return dest;
}

/**
 * The file a write to `path` must replace. A symlinked config (a dotfiles
 * repo managed with stow and the like) is followed to its target, so the
 * rename lands on the real file and the link stays a link. Dangling links
 * resolve too (the write creates the target).
 */
export function resolveWriteTarget(path: string): string {
  let p = resolve(path);
  for (let hops = 0; hops < 40; hops++) {
    try {
      if (!lstatSync(p).isSymbolicLink()) return p;
    } catch {
      return p; // missing: a new file at this path
    }
    p = resolve(dirname(p), readlinkSync(p));
  }
  throw Object.assign(new Error(`too many symbolic links at ${path}`), { code: "ELOOP" });
}

/**
 * Write via temp file + rename so a crash never leaves a half-written config.
 * Keeps the file mode; a symlink is written through (see resolveWriteTarget).
 */
export async function atomicWrite(linkOrPath: string, text: string, mode?: number): Promise<void> {
  const path = resolveWriteTarget(linkOrPath);
  await mkdir(dirname(path), { recursive: true });
  let keepMode = mode;
  if (keepMode === undefined) {
    try {
      keepMode = (await stat(path)).mode & 0o777;
    } catch {
      keepMode = undefined;
    }
  }
  const tmp = `${path}.codingsh-tmp-${process.pid}`;
  await writeFile(tmp, text, keepMode === undefined ? {} : { mode: keepMode });
  if (keepMode !== undefined) await chmod(tmp, keepMode);
  await rename(tmp, path);
}

export interface ApplyOpts {
  agent: string;
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  /** Skip backups (used for isolated run overlays, which are throwaway). */
  noBackup?: boolean;
  /** Called after each change is written, with the backup taken before it (if any). */
  onApplied?: (change: FileChange, backup: string | undefined) => void;
}

/**
 * Applies planned changes (backup first, then write/delete). With dryRun it
 * only returns the plan. Undefined entries (no-op plans) are dropped.
 */
export async function applyChanges(changes: (FileChange | undefined)[], opts: ApplyOpts): Promise<FileChange[]> {
  const real = changes.filter((c): c is FileChange => c !== undefined);
  if (opts.dryRun) return real;
  const now = Date.now();
  for (const c of real) {
    let backup: string | undefined;
    if (c.action !== "create" && !opts.noBackup) {
      backup = await backupFile(opts.agent, c.path, opts.env, now);
      if (backup) c.summary += ` (backup: ${backup})`;
    }
    if (c.action === "delete") await rm(c.path, { force: true });
    else await atomicWrite(c.path, c.after ?? "");
    opts.onApplied?.(c, backup);
  }
  return real;
}

// ---------------------------------------------------------------- JSON

/** Indent unit used by a JSON text (defaults to 2 spaces). */
export function detectIndent(text: string | undefined): string | number {
  if (!text) return 2;
  const m = /^[{[][^\n]*\n([ \t]+)\S/m.exec(text);
  if (!m || !m[1]) return 2;
  return m[1].startsWith("\t") ? "\t" : m[1].length;
}

export class ConfigParseError extends Error {
  readonly path: string;
  constructor(path: string, cause: unknown) {
    super(`cannot parse ${path} (${cause instanceof Error ? cause.message : String(cause)}); refusing to modify it`);
    this.name = "ConfigParseError";
    this.path = path;
  }
}

/** Parses a JSON object file's text; empty/missing → {}. Throws ConfigParseError on bad JSON or non-object. */
export function parseJsonObject(path: string, text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new ConfigParseError(path, e);
  }
  if (!isObject(v)) throw new ConfigParseError(path, new Error("top level is not an object"));
  return v;
}

/** Serializes like the original file: same indent, trailing newline if it had one (default yes). */
export function stringifyJsonLike(value: unknown, before: string | undefined): string {
  const nl = before === undefined || before.endsWith("\n") ? "\n" : "";
  return JSON.stringify(value, null, detectIndent(before)) + nl;
}

/**
 * Plans an edit of a JSON-object config file. `mutate` returns the new object,
 * or undefined to delete the file. Unchanged content → no change (idempotent).
 */
export function planJsonEdit(
  path: string,
  mutate: (obj: Record<string, unknown>, existed: boolean) => Record<string, unknown> | undefined,
  summary: string,
): FileChange | undefined {
  const before = readTextIfExists(path);
  const obj = parseJsonObject(path, before);
  const original = JSON.stringify(obj);
  const next = mutate(structuredClone(obj), before !== undefined);
  if (next === undefined) return planEdit(path, before, undefined, summary);
  if (before !== undefined && JSON.stringify(next) === original) return undefined;
  return planEdit(path, before, stringifyJsonLike(next, before), summary);
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
