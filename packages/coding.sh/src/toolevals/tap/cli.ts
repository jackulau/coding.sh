// CLI tap (§5.3): `bin/<bin>` in the sandbox is a standalone Node shim that
// execs the real command, passes stdin/stdout/stderr through unchanged, and
// appends one TapRecord per call to tap.jsonl. durationMs covers the real
// binary only (spawn → exit), so shim startup is excluded.
//
// The shim is generated source with no imports beyond node builtins, so it
// starts fast and works the same from src/ and from the dist bundle. The
// classifier is embedded via Function.prototype.toString, so it must stay
// self-contained (no references outside its own body).
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TapClass } from "../types.ts";

export interface CliClassifyConfig {
  usageExitCodes: number[];
  usagePatterns: string[];
}

export const DEFAULT_USAGE_PATTERNS = ["unknown (option|flag|command|subcommand|argument)", "unrecognized", "did you mean", "^usage:"];

/** Class and reason for one CLI call. Self-contained: embedded in the shim as source. */
export function classifyCli(argv: string[], exitCode: number | null, stderr: string, cfg: CliClassifyConfig): { class: TapClass; reason?: string } {
  const positionals = argv.filter((a) => !a.startsWith("-"));
  if (argv.includes("--help") || argv.includes("-h") || positionals[0] === "help") return { class: "help" };
  if (argv.includes("--version") && positionals.length === 0) return { class: exitCode === 0 ? "meta" : "invalid", reason: exitCode === 0 ? undefined : "unknown-flag" };
  if (exitCode === 127 || exitCode === 126) return { class: "invalid", reason: "not-found" };
  const reasonOf = (text: string): string => {
    if (/unknown (option|flag)|unrecognized (option|flag|argument)|invalid option|no such option/i.test(text)) return "unknown-flag";
    if (/unknown (sub)?command|did you mean|no such command|is not a .*command|unknown argument/i.test(text)) return "unknown-command";
    if (/missing|required|needs a value|expects? (an? )?(argument|value)|not enough arguments/i.test(text)) return "missing-arg";
    if (/not found|no such file/i.test(text)) return "not-found";
    return "usage";
  };
  const matches = (cfg.usagePatterns || []).some((p) => {
    try {
      return new RegExp(p, "im").test(stderr);
    } catch {
      return false;
    }
  });
  if ((exitCode !== null && (cfg.usageExitCodes || []).includes(exitCode)) || (exitCode !== 0 && matches)) return { class: "invalid", reason: reasonOf(stderr) };
  if (exitCode === 0 && matches && /unknown (option|flag|command)|unrecognized/i.test(stderr)) return { class: "invalid", reason: reasonOf(stderr) };
  if (exitCode === null) return { class: "failed", reason: "signal" };
  if (exitCode !== 0) return { class: "failed", reason: `exit-${exitCode}` };
  return { class: "ok" };
}

export interface CliShimOpts extends CliClassifyConfig {
  /** Real binary plus prefix args. */
  command: string[];
  /** Extra env for the real binary. */
  env: Record<string, string>;
  /** tap.jsonl; omitted for the check-time passthrough (no record). */
  tapLog?: string;
  /** Node binary for the shebang (default: this process's). */
  node?: string;
}

/** What the shim spawns for the target command. */
export interface ShimSpawn {
  file: string;
  args: string[];
  /** The args are already quoted for cmd.exe. */
  verbatim: boolean;
  /** The command is not on PATH outside the shim dirs: the shim exits 127 instead of spawning. */
  missing?: boolean;
}

/** The shim dirs a tapped call already passed through, so a nested shim never resolves to one of them. */
export const SHIM_DIRS_ENV = "CODING_SH_TAP_SHIM_DIRS";

/** Node builtins the resolver uses, passed in so it stays self-contained. */
export interface ShimDeps {
  fs: Pick<typeof import("node:fs"), "accessSync" | "statSync" | "readFileSync" | "existsSync" | "constants">;
  path: Pick<typeof import("node:path"), "delimiter" | "dirname" | "extname" | "join" | "resolve">;
  win: boolean;
  /** Node for an npm cmd-shim's script when no node.exe sits next to it. */
  node: string;
}

/**
 * Resolves the target command like a shell, skipping the shim's own dir
 * (`self`) and every shim dir in CODING_SH_TAP_SHIM_DIRS, so a target whose
 * command equals its bin never re-enters a shim. A command found nowhere else
 * comes back `missing`: a bare name handed to spawn would find the shim again.
 * Windows: PATH + PATHEXT lookup; an npm cmd-shim runs its node script
 * directly, any other .cmd/.bat via cmd.exe with escaped args (the rules in
 * core/spawn.ts). Self-contained: embedded in the shim as source.
 */
export function resolveShimSpawn(cmd: string, args: string[], env: Record<string, string | undefined>, self: string, d: ShimDeps): ShimSpawn {
  const { fs, path, win } = d;
  const get = (name: string) => env[Object.keys(env).find((k) => k.toUpperCase() === name) ?? name] ?? "";
  const exts = win ? (get("PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [];
  const hasExt = exts.some((e) => e.toLowerCase() === path.extname(cmd).toLowerCase());
  const candidates = (base: string) => (win && !hasExt ? exts.map((e) => base + e) : [base]);
  const runnable = (p: string) => {
    try {
      if (win) return fs.statSync(p).isFile();
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const same = (a: string, b: string) => (win ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  const skip = [self, ...get("CODING_SH_TAP_SHIM_DIRS").split(path.delimiter).filter(Boolean)];
  let found: string | undefined;
  if (/[\\/]/.test(cmd)) found = win ? candidates(path.resolve(cmd)).find(runnable) : cmd;
  else {
    for (const dir of get("PATH").split(path.delimiter)) {
      if (!dir || skip.some((s) => same(dir, s))) continue;
      found = candidates(path.join(dir, cmd)).find(runnable);
      if (found) break;
    }
  }
  if (!found) return { file: cmd, args, verbatim: false, missing: true };
  if (!win || !/\.(cmd|bat)$/i.test(found)) return { file: found, args, verbatim: false };
  let text = "";
  try {
    text = fs.readFileSync(found, "utf8");
  } catch {
    // unreadable: cmd.exe below
  }
  const m = /SET "_prog=(?:%dp0%\\)?node(?:\.exe)?"/i.test(text) ? /"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/i.exec(text) : null;
  const script = m?.[1] ? path.join(path.dirname(found), m[1]) : "";
  if (script && fs.existsSync(script)) {
    const local = path.join(path.dirname(found), "node.exe");
    return { file: fs.existsSync(local) ? local : d.node, args: [script, ...args], verbatim: false };
  }
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  // Batch files in node_modules/.bin re-expand %* once more, so their args are escaped twice.
  const twice = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(found);
  const esc = (a: string) => {
    const s = `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(meta, "^$1");
    return twice ? s.replace(meta, "^$1") : s;
  };
  const line = [`"${found}"`.replace(meta, "^$1"), ...args.map(esc)].join(" ");
  return { file: get("COMSPEC") || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/** Source of the shim script. */
export function cliShimSource(o: CliShimOpts, platform: NodeJS.Platform = process.platform): string {
  const node = o.node ?? process.execPath;
  const cfg = { command: o.command, env: o.env, tapLog: o.tapLog ?? null, usageExitCodes: o.usageExitCodes, usagePatterns: o.usagePatterns };
  // Windows: a sh/node polyglot. Git Bash runs the extensionless file as sh (a
  // `#!C:\Program Files\…` shebang cannot be parsed), which execs node on it;
  // to node the second line is a string and a comment. `<bin>.cmd` covers
  // cmd.exe, PowerShell and spawn.
  const head = platform === "win32" ? `#!/bin/sh\n":" //; exec "${node.replace(/\\/g, "/")}" "$0" "$@"` : `#!${node}`;
  return `${head}
// coding.sh tool-eval tap (generated). Execs the real command and records one line per call.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
const CFG = ${JSON.stringify(cfg)};
const classify = ${classifyCli.toString()};
const resolveSpawn = ${resolveShimSpawn.toString()};
const argv = process.argv.slice(2);
const env = { ...process.env, ...CFG.env };
const self = path.dirname(path.resolve(process.argv[1] || ""));
const target = resolveSpawn(CFG.command[0], [...CFG.command.slice(1), ...argv], env, self, { fs, path, win: process.platform === "win32", node: process.execPath });
env.${SHIM_DIRS_ENV} = [self, env.${SHIM_DIRS_ENV}].filter(Boolean).join(path.delimiter);
let outBytes = 0, errBytes = 0, errHead = "";
const ts = Date.now();
const t0 = performance.now();
let t1 = 0;
const sigs = ["SIGINT", "SIGTERM", "SIGHUP"];
let child;
const fwd = (s) => { try { child && child.kill(s); } catch {} };
let done = false;
const finish = (code, signal) => {
  if (done) return;
  done = true;
  for (const s of sigs) process.off(s, fwd);
  if (!t1) t1 = performance.now();
  const exitCode = signal ? null : code;
  if (CFG.tapLog) {
    const c = classify(argv, exitCode, errHead, CFG);
    const rec = { ts, durationMs: Math.round((t1 - t0) * 1000) / 1000, target: "cli", class: c.class, argv, cwd: process.cwd(), exitCode, stdoutBytes: outBytes, stderrBytes: errBytes, stderrHead: errHead };
    if (c.reason) rec.reason = c.reason;
    try { fs.appendFileSync(CFG.tapLog, JSON.stringify(rec) + "\\n"); } catch {}
  }
  if (signal) { try { process.kill(process.pid, signal); } catch {} process.exitCode = 128 + 15; }
  else process.exitCode = code ?? 1;
};
const fail = (msg) => { errHead = msg; process.stderr.write(errHead + "\\n"); finish(127, null); };
if (target.missing) fail(CFG.command[0] + ": target command not found on PATH (set an absolute command in the target)");
else {
  child = spawn(target.file, target.args, { stdio: ["inherit", CFG.tapLog ? "pipe" : "inherit", CFG.tapLog ? "pipe" : "inherit"], env, windowsVerbatimArguments: target.verbatim });
  for (const s of sigs) process.on(s, fwd);
  if (CFG.tapLog) {
    child.stdout.on("data", (b) => { outBytes += b.length; process.stdout.write(b); });
    child.stderr.on("data", (b) => { errBytes += b.length; if (errHead.length < 2048) errHead = (errHead + b.toString("utf8")).slice(0, 2048); process.stderr.write(b); });
  }
  child.on("exit", () => { t1 = performance.now(); });
  child.on("error", (e) => fail(String(e && e.message || e)));
  child.on("close", (code, signal) => finish(code, signal));
}
`;
}

/** The `.cmd` npm's cmd-shim writes for a node script `target` next to it; core/spawn.ts runs such a target with node directly. */
export function npmCmdShim(target: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    "",
  ].join("\r\n");
}

/** Writes `<dir>/<bin>` (mode 755), plus `<bin>.cmd` on Windows, and returns the script's path. */
export async function writeCliShim(dir: string, bin: string, o: CliShimOpts): Promise<string> {
  await mkdir(dir, { recursive: true });
  const p = join(dir, bin);
  await writeFile(p, cliShimSource(o), "utf8");
  await chmod(p, 0o755);
  if (process.platform === "win32") await writeFile(`${p}.cmd`, npmCmdShim(bin), "utf8");
  return p;
}
