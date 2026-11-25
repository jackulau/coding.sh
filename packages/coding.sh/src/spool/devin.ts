// Devin CLI runs Claude Code's hooks too (read_config_from.claude, on by
// default): the hooks coding.sh installed for Claude Code in ~/.claude fire
// inside a Devin session with `claude-code` on their command line. The hook
// (./hook.ts) asks devinHookAgent what such a call is:
// - "devin": a Devin session ran it, and no coding.sh hook for Devin fires for
//   this event, so the line is Devin's and is labeled `devin`.
// - "drop": a coding.sh hook for Devin is installed where this session reads
//   hooks and fires for this event too, so this call is a copy of its line.
// - undefined: not Devin. Devin sets DEVIN_PROJECT_DIR for every hook it runs;
//   Claude Code's payload names its transcript
//   (<config dir>/projects/<project>/<session uuid>.jsonl), Devin's does not.
//
// Where Devin reads hooks (docs.devin.ai/cli/extensibility/hooks): the user
// config (devinConfigDir()/config.json, under "hooks") and, in the session's
// folder and each parent up to the project root, .devin/hooks.v1.json (the
// event map itself), .devin/config.json and .devin/config.local.json (under
// "hooks"). A hook counts only when its hook.mjs or hook.sh exists here: a
// committed .devin/hooks.v1.json that names another machine's path runs
// nothing. Any such hook writes to this spool, since it gets the same env.
//
// The project root is DEVIN_PROJECT_DIR: the repository root, or the session's
// folder outside a repository (Devin 3000.14 sets it so for every hook, and
// reads no parent's .devin outside a repository). So the walk needs no git.
// Devin's payloads carry no cwd: a hook from the user config runs in the
// session's folder, a project's hook in the project root. From the root, a
// .devin folder between the session's folder and the root is not seen.
//
// Loads node:fs and node:path, from process.getBuiltinModule as ./hook.ts says, and imports
// ../core/paths.ts only: the hook bundles it.
import { userHome } from "../core/paths.ts";

const fs = process.getBuiltinModule("node:fs");
const { isAbsolute, join, relative, resolve, sep } = process.getBuiltinModule("node:path");

/** Devin CLI's user config folder: $DEVIN_CONFIG_HOME/devin, else %APPDATA%\devin on Windows and ~/.config/devin elsewhere. */
export function devinConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.DEVIN_CONFIG_HOME) return join(env.DEVIN_CONFIG_HOME, "devin");
  if (platform === "win32") return join(env.APPDATA || join(userHome(env), "AppData", "Roaming"), "devin");
  return join(userHome(env), ".config", "devin");
}

/** The files in a project's .devin folder that hold hooks: hooks.v1.json is the event map, the others hold it under "hooks". */
export const DEVIN_PROJECT_HOOK_FILES = ["hooks.v1.json", "config.json", "config.local.json"] as const;

/** A Claude Code transcript: <config dir>/projects/<project>/<session uuid>.jsonl. */
const CLAUDE_TRANSCRIPT = /[\\/]projects[\\/][^\\/]+[\\/][0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i;
/**
 * A coding.sh hook command for Devin: the hook file's path, quoted or bare, then `devin`. In a quoted
 * path only `\"`, `\\`, `\$` and `` \` `` are escape pairs; any other backslash is part of the path.
 */
const DEVIN_HOOK = /(?:"((?:[^"\\]|\\["\\$`]|\\(?!["\\$`]))*hook\.(?:mjs|sh))"|(\S*hook\.(?:mjs|sh)))\s+devin(?:\s|$)/;
/** Compaction events: Devin's own hook fires PostCompaction, Claude Code's PreCompact, for one compaction. */
const COMPACT = /^(?:pre|post)compact(?:ion)?$/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The payload's transcript_path: from the parsed payload, else from the first 64 KB of its text. */
function transcriptPathOf(raw: unknown, text: string): string | undefined {
  if (isObj(raw)) return typeof raw.transcript_path === "string" ? raw.transcript_path : undefined;
  const m = /"transcript_path"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text.slice(0, 65536));
  if (!m?.[1]) return undefined;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return undefined;
  }
}

/** JSON with `//` and `/* *\/` comments and trailing commas, as an installer that keeps comments leaves it. */
function parseLoose(text: string): unknown {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    // comments or trailing commas: strip them below
  }
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      out += " ";
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Every "command" string in a hooks value (groups, then their hooks). */
function commands(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || typeof value !== "object" || value === null) return out;
  for (const [k, v] of Object.entries(value)) {
    if (k === "command" && typeof v === "string") out.push(v);
    else commands(v, depth + 1, out);
  }
  return out;
}

/**
 * True when `cmd` runs a coding.sh hook for Devin whose file exists on this machine. In a quoted path
 * only `\"`, `\\`, `\$` and `` \` `` are escapes (as buildHookCommand writes them and sh reads them):
 * any other backslash stays, so a hand-written C:\Users\… path is read as written.
 */
function isLiveDevinHook(cmd: string): boolean {
  const m = DEVIN_HOOK.exec(cmd);
  const path = m?.[1]?.replace(/\\(["\\$`])/g, "$1") ?? m?.[2];
  return !!path && fs.existsSync(path);
}

/** Adds to `out` the events of `file`'s hooks that run a coding.sh hook for Devin. `wrapped`: the hooks sit under "hooks". */
function addHookEvents(file: string, wrapped: boolean, out: Set<string>): void {
  let value: unknown;
  try {
    value = parseLoose(fs.readFileSync(file, "utf8"));
  } catch {
    return; // missing or unreadable: no hooks there (Devin cannot read it either)
  }
  const map = wrapped ? (isObj(value) ? value.hooks : undefined) : value;
  if (!isObj(map)) return;
  for (const [event, groups] of Object.entries(map)) if (commands(groups).some(isLiveDevinHook)) out.add(event);
}

/**
 * The folders whose .devin hook files a Devin session in `cwd` reads: `cwd` and each parent up to
 * `root` (DEVIN_PROJECT_DIR); the two alone when `cwd` is not inside `root`, and `cwd` alone without one.
 */
function projectDirs(cwd: string, root: string | undefined): string[] {
  const from = resolve(cwd);
  if (!root) return [from];
  const top = resolve(root);
  const rel = relative(top, from);
  if (!rel) return [top];
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return [from, top];
  const dirs = [top];
  let dir = top;
  for (const part of rel.split(sep)) dirs.push((dir = join(dir, part)));
  return dirs;
}

/** The events a coding.sh hook for Devin is installed for, where a Devin session in `cwd` under project root env.DEVIN_PROJECT_DIR reads hooks. */
export function devinHookEvents(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Set<string> {
  const out = new Set<string>();
  addHookEvents(join(devinConfigDir(env), "config.json"), true, out);
  for (const dir of projectDirs(cwd, env.DEVIN_PROJECT_DIR)) {
    const devin = join(dir, ".devin");
    if (!fs.existsSync(devin)) continue;
    for (const f of DEVIN_PROJECT_HOOK_FILES) addHookEvents(join(devin, f), f !== "hooks.v1.json", out);
  }
  return out;
}

/**
 * What a `claude-code` hook call is when Devin may have run it: "devin" (relabel
 * it), "drop" (a coding.sh hook for Devin writes this event's line too) or
 * undefined (Claude Code's own call, or no Devin marker in the env). `raw`: the
 * parsed payload, or anything else when it was not parsed (`text` is searched).
 */
export function devinHookAgent(event: string, raw: unknown, text: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): "devin" | "drop" | undefined {
  if (!env.DEVIN_PROJECT_DIR) return undefined;
  const transcript = transcriptPathOf(raw, text);
  if (transcript && CLAUDE_TRANSCRIPT.test(transcript)) return undefined;
  const name = (isObj(raw) && typeof raw.hook_event_name === "string" && raw.hook_event_name) || event;
  for (const e of devinHookEvents(env, cwd)) if (e === name || (COMPACT.test(e) && COMPACT.test(name))) return "drop";
  return "devin";
}
