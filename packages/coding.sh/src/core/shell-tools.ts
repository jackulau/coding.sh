// Which tool calls run a shell command, and the command line they run. Every reader of a tool
// call's command uses this one list of shell tools and this one list of command keys
// (adapters/_shared/tools.ts, core/shell-diff.ts, core/failures.ts, core/sessions.ts,
// core/derail.ts, core/replay.ts, core/memory-events.ts, eval/task.ts, toolevals/classify.ts), so
// a shell tool or key one of them reads, they all read. A reader keeps its own rules on top, such
// as a patch passed as `command` not being a command (shell-diff.ts).
//
// No imports: core/memory-events.ts reads COMMAND_KEYS, and the stores load that file.

/** Shell tools (lower case). Antigravity's `run_command` takes `{CommandLine, Cwd}`. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "shell", "shell_command", "exec_command", "local_shell", "local_shell_call", "run_terminal_cmd", "terminal", "command_execution", "run_shell_command", "execute_command", "powershell", "run_command"]);
/** Tool names too generic to be a shell by name: a shell call only with a command line. */
const SHELL_IF_COMMAND: ReadonlySet<string> = new Set(["exec", "execute"]);

/** Where a shell call's input holds its command line, in the order they are read. Antigravity's `run_command` names it `CommandLine`. */
export const COMMAND_KEYS = ["command", "cmd", "script", "commandLine", "CommandLine"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A shell tool, by name in any case. */
export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool.toLowerCase());
}

/**
 * A shell call: a shell tool, or an `exec` or `execute` call with a command line (Devin's shell
 * tool, `{command, shell_id}`; Droid's `Execute`, `{command}`). Those names alone are too generic
 * to count: a Codex code-mode cell is an `exec` call whose input is JavaScript, and an `execute`
 * tool may run a query.
 */
export function isShellCall(tool: string, input: unknown): boolean {
  return isShellTool(tool) || (SHELL_IF_COMMAND.has(tool.toLowerCase()) && isRecord(input) && typeof input.command === "string");
}

/** The first command key of a tool input that holds a string or an argv array of strings, as written. */
export function commandField(input: unknown): string | readonly string[] | undefined {
  if (!isRecord(input)) return undefined;
  for (const k of COMMAND_KEYS) {
    const v = input[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  }
  return undefined;
}

/** An argv array as one command line: the script of a `bash -lc <script>` wrapper, else the words joined with spaces. */
export function argvCommand(argv: readonly string[]): string {
  if (argv.length >= 3 && /(^|\/)(ba|z|)sh$/.test(argv[0]!) && /^-\w*c$/.test(argv[1]!)) return argv.slice(2).join(" ");
  return argv.join(" ");
}

/** The command line of a tool input: a bare string, or the first command key (commandField) with a `bash -lc` wrapper unwrapped. */
export function commandLineOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  const c = commandField(input);
  return typeof c === "string" ? c : c && argvCommand(c);
}
