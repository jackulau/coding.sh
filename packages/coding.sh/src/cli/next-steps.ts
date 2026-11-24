// How commands name the CLI in the commands they print, so the user's shell can run them as
// printed.
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
 * Text with commands in backticks, such as a work item's next step, as the
 * user's shell runs them: each backticked command that starts with
 * `coding.sh ` names nextStepBin. A backticked path or other command, text
 * outside backticks, and text with an odd backtick (no span to trust, as the
 * viewer reads it) stay as they are.
 */
export function codeSpansForShell(text: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const bin = nextStepBin(env, platform);
  const parts = text.split("`");
  if (bin === "coding.sh" || parts.length % 2 === 0) return text;
  return parts.map((p, i) => (i % 2 === 1 && p.startsWith("coding.sh ") ? bin + p.slice("coding.sh".length) : p)).join("`");
}

/**
 * One argument of a printed command, quoted so the user's shell passes it on
 * unchanged. sh gets shellQuote. PowerShell and cmd (windowsShell) get it bare
 * when both pass it on as is, else in double quotes, which both strip and cmd
 * needs (it keeps single quotes). `--` is quoted: PowerShell drops the first
 * bare one given to a script, and npm's codingsh.ps1 is one. So are `--%`,
 * PowerShell's stop-parsing token, and `-x:y`, `a,b` and `@x`, which
 * PowerShell splits or splats. An argument with `$`, a
 * backtick or a double quote has no form both shells keep: PowerShell expands
 * or splits it inside double quotes, so it gets PowerShell's single quotes.
 */
export function quoteArg(s: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (!windowsShell(env, platform)) return shellQuote(s);
  if (/^[\w%+=:./\\-][\w%+=:./\\@-]*$/.test(s) && s !== "--" && s !== "--%" && !(/^-[^-]/.test(s) && s.includes(":"))) return s;
  // Node reads `\"` as a quote, so backslashes before the closing quote are doubled.
  if (!/["$`\u201C\u201D\u201E]/.test(s)) return `"${s.replace(/\\+$/, "$&$&")}"`;
  return `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

/** A command to print: nextStepBin, then each argument quoted for the user's shell (quoteArg). */
export function cliCommand(env: NodeJS.ProcessEnv, args: readonly string[], platform: NodeJS.Platform = process.platform): string {
  return [nextStepBin(env, platform), ...args.map((a) => quoteArg(a, env, platform))].join(" ");
}

/** `run -- <what>`, the wrapper command, as the user's shell runs it. `what` is printed as given (a placeholder or an agent id). */
export function runCommand(env: NodeJS.ProcessEnv, what: string, platform: NodeJS.Platform = process.platform): string {
  return `${cliCommand(env, ["run", "--"], platform)} ${what}`;
}

/**
 * The rerun a consent prompt names: the command line as the user gave it, with
 * --yes added, so it does what they approved, every flag included (--agent,
 * --no-mcp, --remote…). Run in-process with no command line, `fallback` stands
 * in for it.
 */
export function rerunWithYes(c: Pick<CommandContext, "argv" | "env">, fallback: readonly string[], platform: NodeJS.Platform = process.platform): string {
  return cliCommand(c.env, [...(c.argv ?? fallback), "--yes"], platform);
}

/**
 * A printed line that sets an environment variable in the user's shell: `export NAME=value`,
 * which `eval "$(…)"` runs, in sh. PowerShell and cmd (windowsShell) get PowerShell's
 * `$env:NAME = 'value'`, which `… | Invoke-Expression` runs; no line runs in both, and cmd has
 * neither export nor a way to run a command's output. PowerShell's single quotes keep `$` and
 * backticks; a quote in the value, straight or curly, is doubled.
 */
export function envLine(env: NodeJS.ProcessEnv, name: string, value: string, platform: NodeJS.Platform = process.platform): string {
  if (!windowsShell(env, platform)) return `export ${name}=${shellQuote(value)}`;
  return `$env:${name} = '${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
}
