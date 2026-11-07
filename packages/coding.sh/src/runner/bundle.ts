// Harness bundles: the thing being A/B-tested. A bundle is a manifest (agent,
// model, flags, env, removals) plus overlay files stored as blobs; its id is
// the sha256 of that content, so "same harness" is decidable.
import { lstat, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { userHome } from "../core/paths.ts";
import { sha256Hex } from "../core/ids.ts";
import { parseToml } from "../core/toml.ts";
import type { AgentId, BlobRef, BlobStore, HarnessBundle } from "../core/types.ts";
import { safeJoin, safeWrite } from "./fsutil.ts";
import { hasGlob, matchGlob, staticPrefix } from "./glob.ts";

/** Typical harness files across agents; the default `include` for harness.toml. */
export const DEFAULT_INCLUDE = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".claude/**",
  ".codex/**",
  ".cursor/rules/**",
  ".gemini/**",
  ".mcp.json",
];

const SKIP_DIRS = new Set([".git", "node_modules"]);

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) o[k] = stable(x);
    }
    return o;
  }
  return v;
}

export function canonicalJson(v: unknown): string {
  return JSON.stringify(stable(v));
}

/**
 * Content identity. Includes the name (so an A/A test with two identically
 * configured arms still has two ids) but not note/createdAt. Flag order is
 * kept (it can matter to a CLI); file/env/remove order is not.
 */
export function bundleId(b: Pick<HarnessBundle, "name" | "agent" | "model" | "flags" | "env" | "files" | "remove">): string {
  return sha256Hex(
    canonicalJson({
      v: 0,
      name: b.name,
      agent: b.agent,
      model: b.model ?? null,
      flags: b.flags,
      env: b.env,
      files: b.files,
      remove: [...b.remove].sort(),
    }),
  );
}

async function walk(root: string, sub: string, out: string[]): Promise<void> {
  const here = sub ? join(root, sub) : root;
  let entries;
  try {
    entries = await readdir(here, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, rel, out);
    } else if (e.isFile()) out.push(rel);
  }
}

/** Files under base matching pattern (relative POSIX paths). */
export async function collect(base: string, pattern: string): Promise<string[]> {
  const pat = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (!hasGlob(pat)) {
    const abs = join(base, pat);
    let st;
    try {
      st = await stat(abs);
    } catch {
      return [];
    }
    if (st.isFile()) return [pat];
    if (!st.isDirectory()) return [];
    const out: string[] = [];
    await walk(base, pat, out);
    return out;
  }
  const prefix = staticPrefix(pat);
  const out: string[] = [];
  await walk(base, prefix, out);
  return out.filter((p) => matchGlob(p, pat));
}

export interface BundleFromDirOpts {
  name: string;
  agent: AgentId;
  /** Project dir the repo-relative includes are read from. */
  dir: string;
  /** Paths/globs, repo-relative ("CLAUDE.md", ".claude/**") or user-level ("~/.claude/CLAUDE.md"). */
  include: string[];
  /** Explicit overlay path → source file (absolute or relative to dir); wins over include. */
  files?: Record<string, string>;
  model?: string;
  flags?: string[];
  env?: Record<string, string>;
  remove?: string[];
  note?: string;
  blobs: BlobStore;
  /** Where "~/" includes are read from (default: the user's home; read-only). */
  home?: string;
  now?: number;
}

export async function bundleFromDir(o: BundleFromDirOpts): Promise<HarnessBundle> {
  const files: Record<string, BlobRef> = {};
  const home = o.home ?? userHome();
  for (const inc of o.include) {
    const user = inc.startsWith("~/");
    const base = user ? home : o.dir;
    const pat = user ? inc.slice(2) : inc;
    for (const rel of await collect(base, pat)) {
      files[user ? `~/${rel}` : rel] = await o.blobs.put(await readFile(join(base, rel)));
    }
  }
  for (const [target, src] of Object.entries(o.files ?? {})) {
    const abs = resolve(o.dir, src.startsWith("~/") ? join(home, src.slice(2)) : src);
    files[target] = await o.blobs.put(await readFile(abs));
  }
  const sorted: Record<string, BlobRef> = {};
  for (const k of Object.keys(files).sort()) sorted[k] = files[k] as BlobRef;
  const body = {
    name: o.name,
    agent: o.agent,
    model: o.model,
    flags: o.flags ?? [],
    env: o.env ?? {},
    files: sorted,
    remove: o.remove ?? [],
  };
  return { id: bundleId(body), ...body, createdAt: o.now ?? Date.now(), note: o.note };
}

function strArr(v: unknown, key: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`harness: "${key}" must be an array of strings`);
  return v as string[];
}

function strMap(v: unknown, key: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`harness: [${key}] must be a table`);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string") throw new Error(`harness: ${key}.${k} must be a string`);
    out[k] = x;
  }
  return out;
}

/**
 * Read a harness.toml (or harness.json):
 *
 *   name = "terse-claude-md"        # default: the containing dir's name
 *   agent = "claude-code"
 *   model = "claude-sonnet-5-5"
 *   flags = ["--max-turns", "40"]
 *   include = ["CLAUDE.md", ".claude/**"]   # relative to `dir`, default DEFAULT_INCLUDE
 *   remove = ["AGENTS.md"]
 *   dir = "."                        # where includes are read from, relative to this file
 *   note = "..."
 *   [env]
 *   MAX_THINKING_TOKENS = "8000"
 *   [files]                          # overlay path = source file (relative to this file)
 *   "CLAUDE.md" = "variants/terse.md"
 */
export async function bundleFromToml(path: string, opts: { blobs: BlobStore; home?: string; now?: number }): Promise<HarnessBundle> {
  const text = await readFile(path, "utf8");
  const doc: Record<string, unknown> = extname(path) === ".json" ? JSON.parse(text) : (parseToml(text, path) as Record<string, unknown>);
  const here = dirname(resolve(path));
  const agent = doc.agent;
  if (typeof agent !== "string" || !agent) throw new Error(`${path}: "agent" is required`);
  const name = typeof doc.name === "string" && doc.name ? doc.name : basename(here);
  const dir = typeof doc.dir === "string" ? resolve(here, doc.dir) : here;
  const files = strMap(doc.files, "files");
  return bundleFromDir({
    name,
    agent,
    dir,
    include: strArr(doc.include, "include") ?? DEFAULT_INCLUDE,
    files: files && Object.fromEntries(Object.entries(files).map(([t, s]) => [t, resolve(here, s)])),
    model: typeof doc.model === "string" ? doc.model : undefined,
    flags: strArr(doc.flags, "flags"),
    env: strMap(doc.env, "env"),
    remove: strArr(doc.remove, "remove"),
    note: typeof doc.note === "string" ? doc.note : undefined,
    blobs: opts.blobs,
    home: opts.home,
    now: opts.now,
  });
}

export interface ApplyResult {
  written: string[];
  removed: string[];
  /** The isolated HOME used for "~/" paths. */
  home: string;
  /** True when the bundle placed anything under the isolated HOME (the run should export HOME). */
  usesHome: boolean;
}

/**
 * Write a bundle's overlay into runDir. Removals happen first, so a bundle
 * can replace a directory wholesale. "~/" paths go to `home` (default
 * runDir/.coding.sh-home) — never the real home. Paths that are absolute,
 * climb out, touch .git, or pass through a symlink are refused.
 */
export async function applyBundle(bundle: HarnessBundle, runDir: string, blobs: BlobStore, opts: { home?: string } = {}): Promise<ApplyResult> {
  const home = resolve(opts.home ?? join(runDir, ".coding.sh-home"));
  const removed: string[] = [];
  const written: string[] = [];
  const split = (p: string): [string, string] => (p.startsWith("~/") ? [home, p.slice(2)] : [runDir, p]);

  for (const r of bundle.remove) {
    const [root, rel] = split(r);
    const targets = hasGlob(rel) ? await collect(root, rel) : [rel];
    for (const t of targets) {
      const abs = safeJoin(root, t);
      try {
        await lstat(abs);
      } catch {
        continue;
      }
      await rm(abs, { recursive: true, force: true });
      removed.push(root === home ? `~/${t}` : t);
    }
  }
  let usesHome = false;
  for (const [p, ref] of Object.entries(bundle.files)) {
    const [root, rel] = split(p);
    const data = await blobs.get(ref);
    if (!data) throw new Error(`bundle ${bundle.name}: blob for ${p} (${ref}) not found`);
    if (root === home) usesHome = true;
    await safeWrite(root, rel, data);
    written.push(p);
  }
  return { written, removed, home, usesHome };
}

export interface Ablation {
  bundle: HarnessBundle;
  /** Normalized paths (or globs) that were ablated, in the order given. */
  paths: string[];
  /** File keys removed from the bundle. */
  dropped: string[];
  /** Paths that matched no bundle file; they only remove from the task's repo. */
  unmatched: string[];
}

/** POSIX-normalize a bundle path: "./a/b/" → "a/b"; a "~/" prefix is kept. */
export function normalizeBundlePath(p: string): string {
  const s = p.replace(/\\/g, "/");
  const home = s.startsWith("~/");
  const rest = posix.normalize(home ? s.slice(2) : s).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  return home ? `~/${rest}` : rest;
}

const slug = (p: string) =>
  p
    .replace(/^~\//, "home-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The same bundle without `paths` (a skill dir, AGENTS.md, .mcp.json, …):
 * file keys equal to a path or under it are dropped, and the path joins
 * `remove`, so it is also deleted from the task's repo. Globs drop keys via
 * matchGlob and go to `remove` unchanged. Pure; the id is deterministic.
 */
export function ablateBundle(b: HarnessBundle, paths: readonly string[], opts: { now?: number } = {}): Ablation {
  const norm = [...new Set(paths.map(normalizeBundlePath).filter((p) => p && p !== "." && p !== "~/" && p !== "~/."))];
  const files: Record<string, BlobRef> = {};
  const dropped: string[] = [];
  const hit = new Set<string>();
  for (const [key, ref] of Object.entries(b.files)) {
    const by = norm.filter((p) => matchGlob(key, p));
    if (by.length) {
      dropped.push(key);
      for (const p of by) hit.add(p);
    } else files[key] = ref;
  }
  const remove = [...new Set([...b.remove, ...norm])];
  const body = { name: `${b.name}-without-${norm.map(slug).join("-")}`, agent: b.agent, model: b.model, flags: b.flags, env: b.env, files, remove };
  return {
    bundle: { id: bundleId(body), ...body, createdAt: opts.now ?? Date.now(), note: `ablation of ${b.name}: without ${norm.join(", ")}` },
    paths: norm,
    dropped: dropped.sort(),
    unmatched: norm.filter((p) => !hit.has(p)),
  };
}

export interface BundleDiff {
  same: boolean;
  agent?: { from: string; to: string };
  model?: { from?: string; to?: string };
  files: { added: string[]; removed: string[]; changed: string[] };
  flags: { from: string[]; to: string[]; added: string[]; removed: string[] } | undefined;
  env: { added: string[]; removed: string[]; changed: string[] };
  remove: { added: string[]; removed: string[] };
}

function setDiff(a: readonly string[], b: readonly string[]): { added: string[]; removed: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return { added: b.filter((x) => !sa.has(x)), removed: a.filter((x) => !sb.has(x)) };
}

/** What changed from a → b. Env values are compared but never echoed (they may be secrets). */
export function diffBundles(a: HarnessBundle, b: HarnessBundle): BundleDiff {
  const fa = Object.keys(a.files);
  const fb = Object.keys(b.files);
  const files = { ...setDiff(fa, fb), changed: fa.filter((p) => p in b.files && b.files[p] !== a.files[p]).sort() };
  files.added.sort();
  files.removed.sort();
  const ea = Object.keys(a.env);
  const eb = Object.keys(b.env);
  const env = { ...setDiff(ea, eb), changed: ea.filter((k) => k in b.env && b.env[k] !== a.env[k]).sort() };
  const flagsSame = a.flags.length === b.flags.length && a.flags.every((f, i) => f === b.flags[i]);
  const flags = flagsSame ? undefined : { from: a.flags, to: b.flags, ...setDiff(a.flags, b.flags) };
  const remove = setDiff(a.remove, b.remove);
  const d: BundleDiff = {
    same: false,
    agent: a.agent !== b.agent ? { from: a.agent, to: b.agent } : undefined,
    model: a.model !== b.model ? { from: a.model, to: b.model } : undefined,
    files,
    flags,
    env,
    remove,
  };
  d.same =
    !d.agent &&
    !d.model &&
    !flags &&
    files.added.length + files.removed.length + files.changed.length === 0 &&
    env.added.length + env.removed.length + env.changed.length === 0 &&
    remove.added.length + remove.removed.length === 0;
  return d;
}

export function formatBundleDiff(d: BundleDiff): string[] {
  if (d.same) return ["harnesses are identical (apart from name)"];
  const out: string[] = [];
  if (d.agent) out.push(`agent: ${d.agent.from} → ${d.agent.to}`);
  if (d.model) out.push(`model: ${d.model.from ?? "(default)"} → ${d.model.to ?? "(default)"}`);
  for (const f of d.files.added) out.push(`+ ${f}`);
  for (const f of d.files.removed) out.push(`- ${f}`);
  for (const f of d.files.changed) out.push(`~ ${f}`);
  if (d.flags) out.push(`flags: ${d.flags.from.join(" ") || "(none)"} → ${d.flags.to.join(" ") || "(none)"}`);
  for (const k of d.env.added) out.push(`+ env ${k}`);
  for (const k of d.env.removed) out.push(`- env ${k}`);
  for (const k of d.env.changed) out.push(`~ env ${k}`);
  for (const r of d.remove.added) out.push(`+ remove ${r}`);
  for (const r of d.remove.removed) out.push(`- remove ${r}`);
  return out;
}
