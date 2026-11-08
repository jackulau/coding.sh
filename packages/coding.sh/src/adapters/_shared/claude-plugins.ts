// Which plugin a Claude Code hook belongs to. A transcript records each hook's
// command as written in its config (`node "${CLAUDE_PLUGIN_ROOT}/hooks/x.js"`),
// never the plugin's name, so the name comes from the plugins installed under
// the config dir: plugins/installed_plugins.json lists each install's
// directory, and each plugin's hooks/hooks.json (or the `hooks` of its
// .claude-plugin/plugin.json) lists its commands. Read only, cached per config
// dir until installed_plugins.json changes.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { arr, isObj, obj, str } from "./normalize.ts";

/** The source of a hook's command: `plugin:<name>`, `plugin` (a plugin hook whose plugin is not installed here), `settings`, or `unknown` (no command recorded). */
export function hookSource(command: string | undefined, plugins: ReadonlyMap<string, string>): string {
  if (!command) return "unknown";
  const name = plugins.get(command.trim());
  if (name) return `plugin:${name}`;
  return /\bCLAUDE_PLUGIN_ROOT\b/.test(command) ? "plugin" : "settings";
}

const EMPTY: ReadonlyMap<string, string> = new Map();
const cache = new Map<string, { mtimeMs: number; index: ReadonlyMap<string, string> }>();

/**
 * Hook command → plugin name, for the plugins installed under `configDir`. A
 * command two plugins share maps to neither. Empty when nothing is installed.
 */
export function pluginHookCommands(configDir: string): ReadonlyMap<string, string> {
  const file = join(configDir, "plugins", "installed_plugins.json");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return EMPTY;
  }
  const hit = cache.get(configDir);
  if (hit?.mtimeMs === mtimeMs) return hit.index;
  const names = new Map<string, Set<string>>();
  try {
    for (const [key, installs] of Object.entries(obj(obj(JSON.parse(readFileSync(file, "utf8"))).plugins))) {
      const name = key.split("@")[0]!;
      // Version 2 lists the installs of a plugin (one per scope); version 1 had one.
      for (const install of Array.isArray(installs) ? installs : [installs]) {
        const root = installRoot(configDir, str(obj(install).installPath));
        if (!root) continue;
        for (const cmd of hookCommands(root)) (names.get(cmd) ?? names.set(cmd, new Set()).get(cmd)!).add(name);
      }
    }
  } catch {
    // Unreadable install record: no names.
  }
  const index = new Map<string, string>();
  for (const [cmd, n] of names) if (n.size === 1) index.set(cmd, [...n][0]!);
  cache.set(configDir, { mtimeMs, index });
  return index;
}

/** The install's directory; when the recorded path is gone (a moved or mounted config dir), the same path under this config dir's plugins/cache. */
function installRoot(configDir: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (existsSync(path)) return path;
  const m = /[\\/]plugins[\\/]cache[\\/](.+)$/.exec(path);
  const moved = m ? join(configDir, "plugins", "cache", ...m[1]!.split(/[\\/]/)) : undefined;
  return moved && existsSync(moved) ? moved : undefined;
}

/** Every hook command a plugin registers: hooks/hooks.json, and the hooks its manifest names (paths or inline). */
function hookCommands(root: string): string[] {
  const configs: unknown[] = [];
  const read = (p: string) => {
    try {
      configs.push(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      // Missing or broken file: no hooks from it.
    }
  };
  read(join(root, "hooks", "hooks.json"));
  let manifest: Record<string, unknown> = {};
  try {
    manifest = obj(JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")));
  } catch {
    // No manifest.
  }
  const h = manifest.hooks;
  for (const p of typeof h === "string" ? [h] : Array.isArray(h) ? h : []) if (typeof p === "string") read(resolve(root, p));
  if (isObj(h)) configs.push(h);
  const out: string[] = [];
  for (const c of configs) {
    const byEvent = isObj(obj(c).hooks) ? obj(obj(c).hooks) : obj(c);
    for (const groups of Object.values(byEvent)) {
      for (const g of arr(groups)) for (const hook of arr(obj(g).hooks)) {
        const cmd = str(obj(hook).command)?.trim();
        if (cmd) out.push(cmd);
      }
    }
  }
  return out;
}
