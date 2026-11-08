// Claude Code plugins in harness bundles. A plugin is named (resolved read-only
// against the plugins installed in the Claude config dir) or given as a
// directory holding .claude-plugin/plugin.json. Its whole directory is stored
// as the bundle's "~/.coding.sh-plugins/<name>/…" files, so the bundle stays
// content-addressed; a run writes them under its isolated home and the
// claude-code overlay passes `--plugin-dir` for each.
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { userHome } from "../core/paths.ts";
import type { BlobRef, BlobStore, HarnessBundle, HarnessPlugin } from "../core/types.ts";

/** Under the run's isolated home: <home>/.coding.sh-plugins/<name>/. */
export const PLUGIN_ROOT = ".coding.sh-plugins";
const PREFIX = `~/${PLUGIN_ROOT}/`;
/** Agents that can load bundle plugins. */
export const PLUGIN_AGENTS: readonly string[] = ["claude-code"];

/** The bundle file-key prefix of a plugin's files. */
export const pluginKeyPrefix = (name: string): string => `${PREFIX}${name}/`;
/** Whether a bundle file key belongs to a plugin. */
export const isPluginKey = (key: string): boolean => key.startsWith(PREFIX);
/** Where a run writes a plugin (the dir passed to `claude --plugin-dir`). */
export const pluginDirIn = (home: string, name: string): string => join(home, PLUGIN_ROOT, name);

/** Why this bundle's plugins can't run under its agent, or undefined. */
export function pluginProblem(b: Pick<HarnessBundle, "agent" | "plugins">): string | undefined {
  if (!b.plugins?.length || PLUGIN_AGENTS.includes(b.agent)) return undefined;
  return `bundle carries Claude Code plugins (${b.plugins.map((p) => p.name).join(", ")}), but its agent is ${b.agent}; only claude-code loads them`;
}

/** $CLAUDE_CONFIG_DIR or ~/.claude, where installed plugins are listed. */
export function claudeDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(userHome(env), ".claude");
}

export interface InstalledPlugin {
  /** "<name>@<marketplace>". */
  key: string;
  name: string;
  marketplace?: string;
  installPath: string;
  version?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * The plugins listed in <configDir>/plugins/installed_plugins.json: v2
 * (`{"version":2,"plugins":{"name@mk":[{scope,installPath,version}]}}`, the
 * user-scope entry preferred) or v1 (`{"plugins":{"name@mk":{installPath}}}`).
 * Read only; a missing or unreadable file lists none.
 */
export async function installedPlugins(configDir: string): Promise<InstalledPlugin[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(join(configDir, "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    return [];
  }
  const plugins = isObj(doc) && isObj(doc.plugins) ? doc.plugins : {};
  const out: InstalledPlugin[] = [];
  for (const [key, v] of Object.entries(plugins)) {
    const entries = (Array.isArray(v) ? v : [v]).filter(isObj);
    const e = entries.find((x) => x.scope === "user" && str(x.installPath)) ?? entries.find((x) => str(x.installPath));
    if (!e) continue;
    const at = key.lastIndexOf("@");
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : undefined;
    const version = str(e.version);
    out.push({ key, name, installPath: e.installPath as string, ...(marketplace ? { marketplace } : {}), ...(version ? { version } : {}) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** A spec is a path when it has a separator or starts with "." or "~". */
export function isPluginPath(spec: string): boolean {
  return /[\\/]/.test(spec) || spec.startsWith(".") || spec.startsWith("~");
}

export interface ResolvedPlugin {
  name: string;
  marketplace?: string;
  version?: string;
  dir: string;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function manifest(dir: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, ".claude-plugin", "plugin.json"), "utf8");
  } catch {
    return undefined;
  }
  try {
    const m = JSON.parse(text) as unknown;
    if (isObj(m)) return m;
  } catch {
    // fall through
  }
  throw new Error(`${join(dir, ".claude-plugin", "plugin.json")} is not a JSON object`);
}

/**
 * A plugin by `name`, `name@marketplace` (installed in `claudeDir`) or a
 * directory path (relative to `cwd`; "~/" is the user's home). Unknown and
 * ambiguous names throw, listing what is installed.
 */
export async function resolvePlugin(spec: string, opts: { cwd: string; claudeDir: string; home?: string }): Promise<ResolvedPlugin> {
  if (isPluginPath(spec)) {
    const dir = spec === "~" || spec.startsWith("~/") ? join(opts.home ?? userHome(), spec.slice(1)) : isAbsolute(spec) ? spec : resolve(opts.cwd, spec);
    const st = await stat(dir).catch(() => undefined);
    if (!st?.isDirectory()) throw new Error(`plugin ${spec}: no such directory`);
    const m = await manifest(dir);
    const name = str(m?.name);
    if (!name) throw new Error(`plugin ${spec}: not a Claude Code plugin (needs .claude-plugin/plugin.json with a "name")`);
    if (!SAFE_NAME.test(name)) throw new Error(`plugin ${spec}: name ${JSON.stringify(name)} must be letters, digits, ".", "_" or "-"`);
    const version = str(m?.version);
    return { name, dir, ...(version ? { version } : {}) };
  }
  const all = await installedPlugins(opts.claudeDir);
  const hits = all.filter((p) => (spec.includes("@") ? p.key === spec : p.name === spec));
  const listed = all.length ? `installed: ${all.map((p) => p.key).join(", ")}` : `no plugins are installed in ${opts.claudeDir}`;
  if (!hits.length) throw new Error(`plugin ${spec} is not installed (${listed}); pass a plugin directory to use one that isn't`);
  if (hits.length > 1) throw new Error(`plugin ${spec} is ambiguous: ${hits.map((p) => p.key).join(", ")}; name one as <name>@<marketplace>`);
  const p = hits[0] as InstalledPlugin;
  const st = await stat(p.installPath).catch(() => undefined);
  if (!st?.isDirectory()) throw new Error(`plugin ${p.key}: its install dir ${p.installPath} is missing; reinstall it in Claude Code`);
  const m = await manifest(p.installPath).catch(() => undefined);
  const name = str(m?.name) ?? p.name;
  if (!SAFE_NAME.test(name)) throw new Error(`plugin ${p.key}: name ${JSON.stringify(name)} must be letters, digits, ".", "_" or "-"`);
  const version = str(m?.version) ?? p.version;
  return { name, dir: p.installPath, ...(p.marketplace ? { marketplace: p.marketplace } : {}), ...(version ? { version } : {}) };
}

/** Every regular file under dir (relative POSIX paths, .git skipped), with whether it is executable. */
async function walkPlugin(root: string, sub: string, out: { rel: string; exec: boolean }[]): Promise<void> {
  const here = sub ? join(root, sub) : root;
  for (const e of await readdir(here, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) await walkPlugin(root, rel, out);
    else if (e.isFile() || e.isSymbolicLink()) {
      // A symlinked file is stored as its target's content; a symlinked dir is skipped (no loops).
      const st = await stat(join(root, rel)).catch(() => undefined);
      if (st?.isFile()) out.push({ rel, exec: process.platform !== "win32" && (st.mode & 0o111) !== 0 });
    }
  }
}

/** A resolved plugin's files as blobs (bundle keys under its prefix) and its manifest entry. */
export async function storePlugin(p: ResolvedPlugin, blobs: BlobStore): Promise<{ plugin: HarnessPlugin; files: Record<string, BlobRef> }> {
  const found: { rel: string; exec: boolean }[] = [];
  await walkPlugin(p.dir, "", found);
  found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const files: Record<string, BlobRef> = {};
  for (const f of found) files[`${pluginKeyPrefix(p.name)}${f.rel}`] = await blobs.put(await readFile(join(p.dir, f.rel)));
  const exec = found.filter((f) => f.exec).map((f) => f.rel);
  const plugin: HarnessPlugin = { name: p.name, ...(p.marketplace ? { marketplace: p.marketplace } : {}), ...(p.version ? { version: p.version } : {}), ...(exec.length ? { exec } : {}) };
  return { plugin, files };
}

/** Plugins sorted by name; throws on a name given twice. */
export function sortPlugins(plugins: readonly HarnessPlugin[]): HarnessPlugin[] {
  const seen = new Set<string>();
  for (const p of plugins) {
    if (seen.has(p.name)) throw new Error(`plugin ${p.name} is given twice`);
    seen.add(p.name);
  }
  return [...plugins].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
