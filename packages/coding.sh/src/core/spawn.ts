// Portable spawn: the same argv works on POSIX and Windows.
//
// On POSIX this is node's spawn/execFile unchanged. On Windows, node (libuv)
// only finds `.exe`/`.com` on PATH and refuses to run `.cmd`/`.bat` without a
// shell, but most agent CLIs and every npm-installed tool (npm, npx, claude,
// codex, amp, …) are `.cmd` shims there. So on win32 the command is resolved
// with PATHEXT first:
//   - an npm cmd-shim runs its target directly: `node <script> …args`, with
//     no cmd.exe in between, so arguments (multi-line prompts, quotes, `&`)
//     arrive byte for byte;
//   - any other `.cmd`/`.bat` runs as `cmd.exe /d /s /c "…"` with every
//     argument escaped for cmd (the cross-spawn rules);
//   - `.exe` and unknown names pass through to node unchanged.
import * as cp from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

const isWin = () => process.platform === "win32";

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const p = env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  return p.split(delimiter).filter(Boolean);
}

function pathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase());
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Windows lookup of `cmd` the way cmd.exe does it: a name with a path is
 * resolved against `cwd`, a bare name against PATH, and an extension from
 * PATHEXT is added unless the name already has one. Undefined when not found.
 */
export function resolveWindowsCommand(cmd: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  const exts = pathExts(env);
  const hasExt = exts.includes(extname(cmd).toLowerCase());
  const candidates = (base: string) => (hasExt ? [base] : exts.map((e) => base + e));
  if (isAbsolute(cmd) || /[\\/]/.test(cmd)) return candidates(resolve(cwd, cmd)).find(isFile);
  for (const dir of pathDirs(env)) {
    const hit = candidates(join(dir, cmd)).find(isFile);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The script an npm cmd-shim runs with node, from the shim's lines:
 *   SET "_prog=node"
 *   … "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
 * Undefined for any other batch file (including shims for non-node programs).
 */
export function cmdShimTarget(shimPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  if (!/SET "_prog=(?:%dp0%\\)?node(?:\.exe)?"/i.test(text)) return undefined;
  const m = /"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/i.exec(text);
  if (!m?.[1]) return undefined;
  const target = join(dirname(shimPath), m[1]);
  return existsSync(target) ? target : undefined;
}

// cmd.exe metacharacters (cross-spawn's set).
const META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArg(arg: string, twice: boolean): string {
  // CommandLineToArgvW quoting: double the backslashes before a quote, escape the quote.
  let s = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  s = `"${s}"`.replace(META, "^$1");
  return twice ? s.replace(META, "^$1") : s;
}

export interface Resolved {
  file: string;
  args: string[];
  /** Pass to spawn: the args are already quoted for cmd.exe. */
  windowsVerbatimArguments?: boolean;
}

/** What to actually spawn for `file args` on this platform (identity off Windows). */
export function resolveSpawn(file: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd?: string): Resolved {
  if (!isWin()) return { file, args: [...args] };
  const found = resolveWindowsCommand(file, env, cwd);
  if (!found) return { file, args: [...args] };
  const ext = extname(found).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { file: found, args: [...args] };
  const target = cmdShimTarget(found);
  if (target) {
    const local = join(dirname(found), "node.exe");
    return { file: existsSync(local) ? local : process.execPath, args: [target, ...args] };
  }
  // Batch files in node_modules/.bin re-expand %* once more, so their args are escaped twice.
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(found);
  const line = [`"${found}"`.replace(META, "^$1"), ...args.map((a) => escapeCmdArg(a, twice))].join(" ");
  return { file: env.ComSpec ?? process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/** node's spawn, with Windows command resolution (see the header). */
export function spawn(file: string, args: readonly string[], options: cp.SpawnOptionsWithoutStdio): cp.ChildProcessWithoutNullStreams;
export function spawn(file: string, args?: readonly string[], options?: cp.SpawnOptions): cp.ChildProcess;
export function spawn(file: string, args: readonly string[] = [], options: cp.SpawnOptions = {}): cp.ChildProcess {
  const r = resolveSpawn(file, args, options.env ?? process.env, typeof options.cwd === "string" ? options.cwd : undefined);
  return cp.spawn(r.file, r.args, r.windowsVerbatimArguments ? { ...options, windowsVerbatimArguments: true } : options);
}

type ExecCallback = (error: cp.ExecFileException | null, stdout: string, stderr: string) => void;

/** node's execFile (string output), with Windows command resolution. */
export function execFile(file: string, args: readonly string[], options: cp.ExecFileOptions, callback: ExecCallback): cp.ChildProcess {
  const r = resolveSpawn(file, args, options.env ?? process.env, typeof options.cwd === "string" ? options.cwd : undefined);
  const o = { ...options, encoding: "utf8" as const, ...(r.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) };
  return cp.execFile(r.file, r.args, o, (e, out, err) => callback(e, String(out ?? ""), String(err ?? "")));
}

/** node's execFileSync (string output), with Windows command resolution. */
export function execFileSync(file: string, args: readonly string[], options: cp.ExecFileSyncOptions = {}): string {
  const r = resolveSpawn(file, args, options.env ?? process.env, typeof options.cwd === "string" ? options.cwd : undefined);
  const o = { ...options, encoding: "utf8" as const, ...(r.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) };
  return String(cp.execFileSync(r.file, r.args, o));
}

/** node's spawnSync (string output), with Windows command resolution. */
export function spawnSync(file: string, args: readonly string[], options: cp.SpawnSyncOptions = {}): cp.SpawnSyncReturns<string> {
  const r = resolveSpawn(file, args, options.env ?? process.env, typeof options.cwd === "string" ? options.cwd : undefined);
  const o = { ...options, encoding: "utf8" as const, ...(r.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) };
  return cp.spawnSync(r.file, r.args, o);
}

/**
 * A POSIX shell for command lines written in sh syntax (task setup and
 * verifier commands). /bin/sh off Windows. On Windows: sh or bash on PATH,
 * else the bash that ships with Git for Windows (found next to git.exe),
 * else undefined.
 */
export function posixShell(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isWin()) return "/bin/sh";
  for (const name of ["sh", "bash"]) {
    const p = resolveWindowsCommand(name, { ...env, PATHEXT: ".EXE" });
    // Skip WSL's launcher (System32\bash.exe): it runs in another filesystem.
    if (p && !/\\system32\\/i.test(p)) return p;
  }
  const git = resolveWindowsCommand("git", { ...env, PATHEXT: ".EXE" });
  if (git) {
    // <Git>\cmd\git.exe or <Git>\mingw64\bin\git.exe → <Git>\bin\bash.exe
    for (const up of ["..", "../..", "../../.."]) {
      const p = join(dirname(git), up, "bin", "bash.exe");
      if (isFile(p)) return resolve(p);
    }
  }
  return undefined;
}

/**
 * Kill each pid and everything it started (Windows; POSIX callers signal the
 * process group themselves). There are no groups on Windows, so this asks
 * taskkill to end the whole tree. taskkill takes most of a second, so by
 * default it runs in the background and the caller sees the child exit as
 * usual; `sync` waits for it, for an 'exit' handler.
 */
export function killTree(pids: number | number[], sync = false): void {
  const list = [pids].flat();
  if (list.length === 0) return;
  const args = [...list.flatMap((p) => ["/pid", String(p)]), "/T", "/F"];
  try {
    if (sync) cp.spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    else cp.spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch {
    // already gone
  }
}
