// How init, uninstall and update name the CLI in the commands they print, so the user's shell can
// run them as printed.
import { shellQuote } from "./args.ts";
import type { CommandContext } from "./types.ts";

/**
 * PowerShell or cmd on Windows: no MSYSTEM or SHELL, which Git Bash, MSYS2 and
 * Cygwin set. There `coding.sh` resolves to npm's extensionless sh shim and
 * fails, and sh syntax such as `VAR=value cmd` or `curl … | sh` does not run.
 */
export function windowsShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && !env.MSYSTEM && !env.SHELL;
}

/**
 * The CLI as the user's shell runs it. Started with npx, `coding.sh` is not on
 * PATH: npx it. In PowerShell or cmd (windowsShell), name the dotless
 * `codingsh` bin. npx on Windows runs the command through cmd whatever the
 * shell, so it names that bin too.
 */
export function nextStepBin(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (env.npm_command === "exec") return platform === "win32" ? "npx -p coding.sh codingsh" : "npx coding.sh";
  return windowsShell(env, platform) ? "codingsh" : "coding.sh";
}

/**
 * The rerun a consent prompt names: the command line as the user gave it, with
 * --yes added, so it does what they approved, every flag included (--agent,
 * --no-mcp, --remote…). Run in-process with no command line, `fallback` stands
 * in for it.
 */
export function rerunWithYes(c: Pick<CommandContext, "argv" | "env">, fallback: readonly string[]): string {
  return [nextStepBin(c.env), ...(c.argv ?? fallback).map(shellQuote), "--yes"].join(" ");
}
