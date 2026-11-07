// `[refine]` settings: which harness lines are protected (refine/protect.ts).
//
//   [refine]
//   protect = ["^Use pnpm", "staging"]   # regexes; a matching line is protected
//   autoProtect = false                  # user config only: turn off gate-word + safety-topic protection
//
// The repo's `.coding.sh/config.toml` may add `protect` patterns but cannot turn
// auto-protection off: an agent that edits the repo could otherwise unprotect a
// rule and then delete it.
import { readFileSync } from "node:fs";
import { ConfigError, findRepoConfig, readUserConfigTable } from "../core/config.ts";
import { parseToml, type TomlTable } from "../core/toml.ts";
import { compileProtect, type ProtectOpts } from "./protect.ts";

function section(root: TomlTable, file: string): { protect: string[]; autoProtect?: boolean } {
  const t = root.refine;
  if (t === undefined) return { protect: [] };
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new ConfigError("[refine] must be a table", file);
  const r = t as TomlTable;
  const p = r.protect;
  if (p !== undefined && !(Array.isArray(p) && p.every((x) => typeof x === "string"))) throw new ConfigError("refine.protect must be an array of regex strings", file);
  const a = r.autoProtect;
  if (a !== undefined && typeof a !== "boolean") throw new ConfigError("refine.autoProtect must be true or false", file);
  const protect = (p as string[] | undefined) ?? [];
  try {
    compileProtect(protect);
  } catch (e) {
    throw new ConfigError((e as Error).message, file);
  }
  return { protect, ...(a !== undefined ? { autoProtect: a } : {}) };
}

/** The effective protect options: user config, plus the repo config's extra patterns. */
export function refineProtectConfig(env: NodeJS.ProcessEnv, cwd: string): ProtectOpts & { files: string[] } {
  const user = readUserConfigTable(env);
  const u = section(user.table, user.file);
  const files = Object.keys(user.table).length ? [user.file] : [];
  const repoFile = findRepoConfig(cwd, env);
  let repo: string[] = [];
  if (repoFile) {
    let text: string;
    try {
      text = readFileSync(repoFile, "utf8");
    } catch (e) {
      throw new ConfigError(`cannot read config: ${(e as Error).message}`, repoFile);
    }
    let root: TomlTable;
    try {
      root = parseToml(text, repoFile);
    } catch (e) {
      throw new ConfigError(`invalid TOML: ${(e as Error).message}`, repoFile);
    }
    repo = section(root, repoFile).protect;
    files.push(repoFile);
  }
  return { protect: [...new Set([...u.protect, ...repo])], autoProtect: u.autoProtect !== false, files };
}
