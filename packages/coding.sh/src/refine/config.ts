// `[refine]` settings: which harness lines are protected (refine/protect.ts),
// and how far a listed cost may rise for a pass-rate gain (refine/objectives.ts).
//
//   [refine]
//   protect = ["^Use pnpm", "staging"]   # regexes; a matching line is protected
//   autoProtect = false                  # user config only: turn off gate-word + safety-topic protection
//   maxCostRise = "50%"                  # --max-cost-rise's default; "none" for no limit
//   canary_model = "claude-haiku-4-5"    # user config only: the cheaper model suite rounds re-test removals under
//
// The repo's `.coding.sh/config.toml` may add `protect` patterns but cannot turn
// auto-protection off: an agent that edits the repo could otherwise unprotect a
// rule and then delete it. For the same reason it may lower maxCostRise but not
// raise it.
import { readFileSync } from "node:fs";
import { ConfigError, findRepoConfig, readUserConfigTable } from "../core/config.ts";
import { parseToml, type TomlTable } from "../core/toml.ts";
import { DEFAULT_MAX_COST_RISE, parseRise } from "./objectives.ts";
import { compileProtect, type ProtectOpts } from "./protect.ts";

function section(root: TomlTable, file: string): { protect: string[]; autoProtect?: boolean; maxCostRise?: number } {
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
  const m = r.maxCostRise;
  let maxCostRise: number | undefined;
  if (m !== undefined) {
    if (typeof m !== "string" && typeof m !== "number") throw new ConfigError('refine.maxCostRise must be a rise like "50%", 0.5 or "none"', file);
    try {
      maxCostRise = parseRise(m, "refine.maxCostRise");
    } catch (e) {
      throw new ConfigError((e as Error).message, file);
    }
  }
  return { protect, ...(a !== undefined ? { autoProtect: a } : {}), ...(maxCostRise !== undefined ? { maxCostRise } : {}) };
}

function readRepoSection(cwd: string, env: NodeJS.ProcessEnv): { file: string; section: ReturnType<typeof section> } | undefined {
  const repoFile = findRepoConfig(cwd, env);
  if (!repoFile) return undefined;
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
  return { file: repoFile, section: section(root, repoFile) };
}

/** `[refine] canary_model` from the user config (a repo config cannot set it). */
export function refineCanaryModel(env: NodeJS.ProcessEnv): string | undefined {
  const user = readUserConfigTable(env);
  const t = user.table.refine;
  if (!t || typeof t !== "object" || Array.isArray(t)) return undefined;
  const m = (t as TomlTable).canary_model;
  if (m === undefined) return undefined;
  if (typeof m !== "string" || !m.trim()) throw new ConfigError("refine.canary_model must be a model name", user.file);
  return m.trim();
}

/** The effective protect options: user config, plus the repo config's extra patterns. */
export function refineProtectConfig(env: NodeJS.ProcessEnv, cwd: string): ProtectOpts & { files: string[] } {
  const user = readUserConfigTable(env);
  const u = section(user.table, user.file);
  const files = Object.keys(user.table).length ? [user.file] : [];
  const repo = readRepoSection(cwd, env);
  if (repo) files.push(repo.file);
  return { protect: [...new Set([...u.protect, ...(repo?.section.protect ?? [])])], autoProtect: u.autoProtect !== false, files };
}

/**
 * `refine.maxCostRise`: the user config's value (else the default), lowered by
 * the repo config's when that is smaller. Undefined when neither sets it.
 */
export function refineMaxCostRise(env: NodeJS.ProcessEnv, cwd: string): number | undefined {
  const user = readUserConfigTable(env);
  const u = section(user.table, user.file).maxCostRise;
  const r = readRepoSection(cwd, env)?.section.maxCostRise;
  if (u === undefined && r === undefined) return undefined;
  return Math.min(u ?? DEFAULT_MAX_COST_RISE, r ?? Infinity);
}
