// Which failed tool calls are real failures. A tool call with ok:false is not
// always a problem: `rg foo src` exits 1 when nothing matches, `test -f x` exits 1
// when x is absent, and `diff a b` exits 1 when the files differ. Those report a
// result, and the agent reads it as one. A call the user stopped (Ctrl-C, a
// rejected permission prompt) did not fail either.
//
// classifyToolFailure sorts a failed call into
// - benign:      a shell command whose exit 1 is an answer: no-match (grep, rg,
//                git grep, pgrep, a search tool's "No files found"), probe
//                (test, [ ], which, command -v, type) or files-differ (diff,
//                cmp, git diff --exit-code). Output that is an error message
//                (exit 2, "No such file") is real;
// - interrupted: the user or the harness stopped it before it finished;
// - real:        everything else, a failing `vitest` or `npm test` included.
//
// Conservative: a compound line is benign only when every part that could fail
// silently is one of the commands above (with empty output), or when the part
// the output points at is (core/failing-command.ts). Unknown tools stay real.
// Session.stats.toolErrors counts real failures only (core/sessions.ts). Pure.
import type { AgentEvent } from "../schema/index.ts";
import { exitCodeOf, failingPart, isPlumbing, shellParts, type ShellPart } from "./failing-command.ts";

export type FailureClass = "real" | "benign" | "interrupted";
export type BenignReason = "no-match" | "probe" | "files-differ";

export interface ToolFailure {
  cls: FailureClass;
  /** Why a benign failure is benign. */
  reason?: BenignReason;
}

const REAL: ToolFailure = { cls: "real" };
const INTERRUPTED: ToolFailure = { cls: "interrupted" };

/** Tools that take a bare command string as input. */
const SHELL_TOOL = /^(?:bash|sh|zsh|shell|local_shell|exec|exec_command|run_shell_command|run_terminal_cmd|run_command|execute_command|terminal|command)$/i;
const COMMAND_KEYS = ["command", "cmd", "script", "commandLine"] as const;

/** Search tools whose ok:false "No files found" is an empty result. */
const SEARCH_TOOL = /grep|search|glob|find/i;
const NO_RESULTS = /^\s*(?:No (?:files|matches|results)(?: were)? found|Found 0 (?:files|matches|results))\b/i;

/** What a harness writes when the user or the harness stopped a call. */
const INTERRUPT_TEXT = /^\s*(?:\[Request interrupted by user[^\]\n]*\]|Interrupted by user\b|The user doesn't want to proceed with this tool use|(?:The )?user (?:rejected|denied|cancell?ed|aborted) (?:this |the )?(?:tool|command|call)|(?:exec )?command (?:was )?(?:rejected|aborted|cancell?ed|interrupted) by (?:the )?user|aborted by user\b|Tool (?:call|use) (?:was )?(?:aborted|cancell?ed|interrupted)\b)/i;

/** Header lines a harness puts before a command's own output (Claude Code, Codex). */
const HEADER_LINE = /^(?:Error: )?Exit code:? -?\d+[^\n]*$|^Process exited with code -?\d+[^\n]*$|^Wall time:[^\n]*$|^Original token count:[^\n]*$|^Chunk ID:[^\n]*$|^Output:\s*$/;
const EXIT_LINE = /^(?:(?:Error: )?Exit code:?|Process exited with code) (-?\d+)/m;

const NO_MATCH = new Set(["grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack", "pgrep"]);
const PROBE = new Set(["test", "[", "[[", "which", "type", "hash"]);
const DIFFER = new Set(["diff", "cmp", "colordiff"]);
/** Plumbing (core/failing-command.ts) that can exit non-zero without a word. */
const SILENT_FAIL = new Set(["exit", "false", "return", "read", "wait"]);

function textOf(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/**
 * The shell command a tool call ran, or undefined for a call that is not a
 * shell command. A REPL cell (`code`) is not: its exit status is the cell's.
 */
export function shellCommandOf(tool: string, input: unknown): string | undefined {
  if (typeof input === "string") return SHELL_TOOL.test(tool) && input.trim() ? input : undefined;
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  for (const k of COMMAND_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) {
      // ["bash", "-lc", "rg foo"]: the script is the command.
      if (v.length === 3 && /^(?:ba|z|da|k)?sh$/.test(v[0]!.split("/").pop()!) && /^-\w*c$/.test(v[1]!)) return v[2];
      return v.join(" ");
    }
  }
  return undefined;
}

/** The exit status: the event's, else the harness's "Exit code N" / "Process exited with code N" line near the top. */
function exitOf(exitCode: unknown, text: string): number | undefined {
  const n = exitCodeOf(exitCode, text);
  if (n !== undefined) return n;
  const m = EXIT_LINE.exec(text.slice(0, 512));
  return m ? Number(m[1]) : undefined;
}

/** The command's own output: the harness's header lines (exit code, wall time) dropped. */
function bodyOf(output: string): string {
  const lines = output.split("\n");
  let i = 0;
  while (i < lines.length && (HEADER_LINE.test(lines[i]!.trim()) || (i === 0 && !lines[i]!.trim()))) i++;
  return lines.slice(i).join("\n");
}

/** The first argument that is not an option of `git` itself (`git -C dir grep x` → grep). */
function gitSub(argv: readonly string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree") i++;
    else if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/** Why exit 1 from this part is an answer, not a failure; undefined when it is not one of those commands. */
function benignReason(p: ShellPart): BenignReason | undefined {
  const prog = p.prog;
  if (!prog) return undefined;
  if (NO_MATCH.has(prog)) return "no-match";
  if (PROBE.has(prog)) return "probe";
  if (DIFFER.has(prog)) return "files-differ";
  if (prog === "git") {
    const sub = gitSub(p.argv);
    if (sub === "grep") return "no-match";
    if (sub === "diff" && p.argv.some((a) => a === "--exit-code" || a === "--quiet" || a === "--no-index")) return "files-differ";
  }
  return undefined;
}

/** `command -v foo` is a probe; failing-command reads `command` as a wrapper, so name it `which`. */
const asProbe = (cmd: string): string => cmd.replace(/(^|[\s;&|(!])command\s+-[vV]\s+/g, "$1which ");

/**
 * Classify one failed tool call (its `ok` was false). `exitCode` is the event's
 * when it has one; otherwise the "Exit code N" line Claude Code and Codex put
 * first in the output is read. `o.interrupted` is the adapter's own flag.
 */
export function classifyToolFailure(tool: string, input: unknown, output: unknown, exitCode?: unknown, o: { interrupted?: boolean } = {}): ToolFailure {
  if (o.interrupted === true) return INTERRUPTED;
  const text = textOf(output);
  if (INTERRUPT_TEXT.test(text)) return INTERRUPTED;
  const cmd = shellCommandOf(tool, input);
  if (cmd === undefined) {
    if (SEARCH_TOOL.test(tool) && NO_RESULTS.test(text)) return { cls: "benign", reason: "no-match" };
    return REAL;
  }
  const exit = exitOf(exitCode, text);
  // 130: SIGINT, the user pressed Ctrl-C.
  if (exit === 130) return INTERRUPTED;
  if (exit !== undefined && exit !== 1) return REAL;
  const body = bodyOf(text);
  const parts = shellParts(asProbe(cmd));
  if (!parts.length) return REAL;
  if (!body.trim()) {
    // Nothing printed: the part that failed failed silently. Tools that always
    // name themselves when they fail (cat, ls, sed, …) and builtins like cd and
    // echo did not, and a part piped into another does not set the status
    // (unless pipefail is on); anything else that might fail silently must be benign.
    const pipefail = /\bpipefail\b/.test(cmd);
    let reason: BenignReason | undefined;
    for (const p of parts) {
      if (!p.last && !pipefail) continue;
      const r = benignReason(p);
      if (r) reason = r;
      else if (!isPlumbing(p.prog) || SILENT_FAIL.has(p.prog!)) return REAL;
    }
    return reason ? { cls: "benign", reason } : REAL;
  }
  // Output and no exit status: no telling whether it is an error message.
  if (exit === undefined) return REAL;
  const part = failingPart(asProbe(cmd), { output: body, exitCode: exit });
  const reason = part ? benignReason(part) : undefined;
  return reason ? { cls: "benign", reason } : REAL;
}

/** Tool calls kept for classifying their ends: enough for calls in flight and a second capture path's copy of an end. */
const MAX_PENDING = 256;
/** A command this long is cut: the parts that decide are near its start and end, and the fold is saved. */
const MAX_COMMAND = 4096;

/**
 * Started calls' shell commands by toolUseId, so a tool.end that leaves its
 * input out (most do) can be classified. The newest MAX_PENDING are kept, and an
 * end does not drop its start: a session seen live and from its transcript has
 * two ends per call. Plain data, saved with the session's fold.
 */
export interface FailureState {
  commands: Map<string, string>;
}

export const failureState = (): FailureState => ({ commands: new Map() });

/** Folds the next event; for a failed tool.end returns how it failed, else undefined. */
export function foldFailure(s: FailureState, e: AgentEvent): ToolFailure | undefined {
  const p = e.payload;
  const id = typeof p.toolUseId === "string" && p.toolUseId ? p.toolUseId : undefined;
  const tool = typeof p.tool === "string" ? p.tool : "";
  if (e.kind === "tool.start") {
    if (!id) return undefined;
    const cmd = shellCommandOf(tool, p.input);
    s.commands.delete(id);
    if (cmd === undefined) return undefined;
    s.commands.set(id, cmd.length > MAX_COMMAND ? cmd.slice(0, MAX_COMMAND) : cmd);
    if (s.commands.size > MAX_PENDING) s.commands.delete(s.commands.keys().next().value!);
    return undefined;
  }
  if (e.kind !== "tool.end" || p.ok !== false) return undefined;
  const started = id ? s.commands.get(id) : undefined;
  const input = p.input !== undefined && p.input !== null ? p.input : started !== undefined ? { command: started } : undefined;
  return classifyToolFailure(tool, input, p.output ?? p.error, p.exitCode, { interrupted: p.interrupted === true });
}

/** Classifies every failed tool.end in time-sorted events, by event id. */
export function toolFailures(sorted: readonly AgentEvent[]): Map<string, ToolFailure> {
  const s = failureState();
  const out = new Map<string, ToolFailure>();
  for (const e of sorted) {
    const f = foldFailure(s, e);
    if (f) out.set(e.id, f);
  }
  return out;
}
