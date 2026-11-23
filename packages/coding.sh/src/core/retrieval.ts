// How a session found what it worked on: each tool call is a read (a file's
// content: Read, `cat`, `sed`, `head`, `tail`, `less`, Get-Content,
// `git show <rev>:<path>`), a search (Grep, Glob, `grep`, `rg`, `find`, `fd`,
// `ls`, `git grep`, `git ls-files`, Select-String, Get-ChildItem), a web call
// (WebSearch, WebFetch) or none of these. MCP tools are never counted.
//
// A shell line is one call. Its parts come from shellParts
// (core/failing-command.ts), which drops keywords, `VAR=value` prefixes,
// wrappers, redirects and heredoc bodies, and splits on `&&`, `||`, `;`, `|` and
// newlines. A pipeline's first command decides what the pipeline is: `grep x |
// head` and `cat f | grep x` are searches, and a pipeline that ends in a
// removal (`find . | xargs rm`) is neither. A line may read and search. `cd`,
// `pushd` and Set-Location move the directory the later parts' paths resolve
// against.
//
// Read paths are keyed the way Session.stats.filesChanged keys an edit
// (sessions.ts changeKey): relative to the session's working directory when
// inside it, so a file read and later edited is one key. A path behind a
// variable, a glob or a substitution still counts the read, with no file.
// Pure: rules over strings, no I/O.
import { posix } from "node:path";
import { shellCommandOf } from "../adapters/_shared/tools.ts";
import type { AgentEvent, RetrievalStats, Session } from "../schema/index.ts";
import { exitCodeOf, isPowerShellTool, shellParts, type ShellPart } from "./failing-command.ts";
import type { ToolFailure } from "./failures.ts";
import { changeKeyer } from "./sessions.ts";
import { normalizeTracePath, operandsOf, slashed } from "./shell-diff.ts";
import { ABSOLUTE, PS_COMMON, shellWorkdir } from "./shell-files.ts";
// waste.ts imports sessions.ts, which imports this file: its sets are read inside functions only.
import { SEARCH_TOOLS, SHELL_SEARCHERS } from "./waste.ts";

/** Tools that search the web or fetch a page (lower case). */
const WEB = new Set(["websearch", "webfetch", "web_search", "web_fetch", "google_web_search", "fetchurl", "read_web_page", "read_url_content", "search_web"]);
/** Search and listing tools beyond waste.ts's SEARCH_TOOLS (lower case). */
const SEARCHES = new Set(["codebase_search", "glob_file_search", "find", "find_by_name", "list", "list_files", "search_files", "grep_files"]);
/** Tools that read a file's content (lower case). */
const READS = new Set(["read", "view", "read_file", "read_many_files", "view_file", "notebookread", "read_notebook"]);
/** Editor tools that read a file with `command: "view"`. */
const EDITOR = /^(?:str_replace_editor|str_replace_based_edit_tool|.*text_editor)$/;
/** Input fields that name the file a read tool reads: the first that holds a string. */
const PATH_KEYS = ["file_path", "filePath", "path", "absolute_path", "absolutePath", "AbsolutePath", "target_file", "targetFile", "notebook_path", "file"];

/** One tool call, as retrieval sees it. */
export interface RetrievalCall {
  /** It reads a file's content. */
  read: boolean;
  /** It searches for or lists files. */
  search: boolean;
  /** It searches the web or fetches a page. */
  web: boolean;
  /** The files it reads, `/`-separated: absolute, or relative to the directory the call ran in. */
  paths: string[];
  /** Its searches print no matches by design (`grep -q`, `Select-String -Quiet`) or send them elsewhere (`> out.txt`). */
  quiet?: true;
  /** A shell command. */
  shell?: true;
}

/** What a tool call retrieves, or undefined when it neither reads, searches nor goes to the web. */
export function classifyRetrieval(tool: unknown, input: unknown): RetrievalCall | undefined {
  if (typeof tool !== "string" || !tool) return undefined;
  const t = tool.toLowerCase();
  if (t.startsWith("mcp__")) return undefined;
  const command = shellCommandOf(tool, input);
  if (command !== undefined) return shellRetrieval(command, isPowerShellTool(tool) || /powershell/i.test(tool), startDir(input));
  if (WEB.has(t)) return { read: false, search: false, web: true, paths: [] };
  if (SEARCH_TOOLS.has(t) || SEARCHES.has(t)) return { read: false, search: true, web: false, paths: [] };
  const i = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (READS.has(t) || (EDITOR.test(t) && i.command === "view")) return { read: true, search: false, web: false, paths: readPaths(i) };
  return undefined;
}

/** The files a read tool's input names. A glob names no one file. */
function readPaths(i: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const p = v.trim().replace(/\\/g, "/");
    if (p && !/[*?[]/.test(p)) out.add(p);
  };
  const key = PATH_KEYS.find((k) => typeof i[k] === "string" && (i[k] as string).trim());
  if (key) add(i[key]);
  if (Array.isArray(i.paths)) for (const v of i.paths) add(v);
  return [...out];
}

/** The directory a shell call starts in, relative to the event's cwd: the folder its input names (shellWorkdir), else "" (the cwd itself). */
function startDir(input: unknown): string {
  return (shellWorkdir(input) ?? "").replace(/\\/g, "/");
}

// ---------------------------------------------------------------- shell lines

/** A pipeline's finding: a read of these paths (resolved against the directory it ran in), or a search. */
type Found = { kind: "read"; paths: string[] } | { kind: "search"; quiet: boolean };

/** A word that is not a literal path (a variable, a glob, a substitution): it counts as an operand with no file. */
const MARK = "\u0000";

/** Programs that change the directory (sh). */
const SH_CD = new Set(["cd", "pushd", "popd"]);
/** Cmdlets and aliases that change the location (PowerShell, lower case). */
const PS_CD = new Set(["set-location", "sl", "cd", "chdir", "push-location", "pushd", "pop-location", "popd"]);
/** Programs that read their file operands, and their flags that take a value. */
const HEAD_FLAGS = ["-n", "-c", "--lines", "--bytes"];
const LESS_FLAGS = ["-p", "-P", "-x", "-y", "-b", "-h", "-j", "-o", "-O", "-T", "-z", "-#"];
const BAT_FLAGS = ["-l", "--language", "-r", "--line-range", "-H", "--highlight-line", "--style", "--theme", "--tabs", "-m", "--map-syntax", "--wrap", "--terminal-width", "--color", "--decorations", "--paging", "--pager", "--diff-context", "--file-name"];
const READERS = new Map<string, readonly string[]>([
  ["cat", []],
  ["bat", BAT_FLAGS],
  ["batcat", BAT_FLAGS],
  ["nl", ["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"]],
  ["less", LESS_FLAGS],
  ["more", LESS_FLAGS],
  ["head", HEAD_FLAGS],
  ["tail", [...HEAD_FLAGS, "-s", "--sleep-interval", "--pid"]],
]);
/** Programs that print the lines that match: a search at the head of a pipeline, a filter after it. */
const GREPS = new Set(["grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack", "findstr"]);
/** Programs that list files, beyond waste.ts's SHELL_SEARCHERS. */
const LISTERS = new Set(["fd", "fdfind", "ls", "dir", "tree"]);
/** Programs that change or remove files: a pipeline that ends in one is not a search. */
const DESTRUCTIVE = new Set(["rm", "rmdir", "mv", "cp", "chmod", "chown", "touch", "unlink", "truncate", "shred", "ln"]);
const PS_DESTRUCTIVE = new Set([
  "remove-item", "ri", "del", "erase", "rd", "move-item", "mi", "move", "copy-item", "cpi", "copy", "rename-item", "rni", "ren",
  "set-content", "sc", "add-content", "ac", "clear-content", "clc",
]);
/** Cmdlets that send what the pipeline printed to a file or nowhere (lower case): it does not reach the agent. */
const PS_AWAY = new Set(["out-null", "out-file", "set-content", "sc", "add-content", "ac"]);
/** PowerShell's pipeline cmdlets (as in core/failing-command.ts): they pass on what the command before them printed. */
const PS_PIPE = new Set([
  "select-object", "select", "out-string", "oss", "out-null", "out-host", "out-default", "out-file", "where-object", "where", "?", "foreach-object", "foreach", "%",
  "sort-object", "sort", "format-table", "ft", "format-list", "fl", "format-wide", "fw", "format-custom", "fc", "measure-object", "measure", "tee-object", "tee",
  "group-object", "group", "select-string", "sls", "get-unique", "gu", "convertto-json", "convertfrom-json", "convertto-csv", "convertfrom-csv", "out-gridview",
]);

/**
 * What a shell line retrieves: each pipeline decided by its first command, `cd` followed. A
 * pipeline whose output goes to a file (`> out.txt`, `| Out-File`) reads nothing the agent sees,
 * and its search is quiet.
 */
function shellRetrieval(command: string, ps: boolean, start: string | undefined): RetrievalCall | undefined {
  const parts = shellParts(command, ps ? "powershell" : "sh");
  const starts = pipelineStarts(parts);
  const found: (Found | undefined)[] = [];
  /** By pipeline start: its output goes to a file or nowhere. */
  const gone: boolean[] = [];
  const stack: (string | undefined)[] = [];
  let dir = start;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const pps = !!p.ps;
    const words = joinSubst(p.argv, pps ? "`" : "\\");
    const prog = p.prog?.toLowerCase().replace(/\.exe$/, "") ?? (pps && words[0] === "?" ? "?" : undefined);
    if (p.away || (pps && prog !== undefined && PS_AWAY.has(prog))) gone[starts[i]!] = true;
    if (!prog) continue;
    const raw = words.slice(1);
    const args = raw.map((w) => unq(w, pps));
    if (pps ? PS_CD.has(prog) : SH_CD.has(prog)) {
      dir = pps ? psCd(prog, raw, dir, stack) : shCd(prog, args, dir, stack);
      continue;
    }
    if (starts[i] === i) {
      let f = pps ? psFound(prog, raw, dir) : undefined;
      if (f === undefined) f = shFound(prog, args, dir);
      found[i] = f ?? undefined;
      continue;
    }
    const head = starts[i]!;
    const h = found[head];
    if (!h) continue;
    if (GREPS.has(prog) || (pps && (prog === "where-object" || prog === "where" || prog === "?" || prog === "select-string" || prog === "sls"))) {
      // A filter: what reaches the agent is what matched.
      const quiet = prog === "select-string" || prog === "sls" ? raw.some((w) => /^-quiet$/i.test(w)) : GREPS.has(prog) && prog !== "findstr" && grepQuiet(args, prog);
      if (h.kind === "read") found[head] = { kind: "search", quiet };
      else h.quiet ||= quiet;
    } else if (h.kind === "search" && (DESTRUCTIVE.has(prog) || (pps && PS_DESTRUCTIVE.has(prog)) || inPlace(prog, args))) found[head] = undefined;
  }
  let read = false;
  let search = false;
  let quiet = true;
  const paths = new Set<string>();
  for (let i = 0; i < found.length; i++) {
    const f = found[i];
    if (!f) continue;
    if (f.kind === "read") {
      // `cat a.ts > b.ts` copies a file; the agent reads nothing.
      if (gone[i]) continue;
      read = true;
      for (const x of f.paths) paths.add(x);
    } else {
      search = true;
      if (!f.quiet && !gone[i]) quiet = false;
    }
  }
  if (!read && !search) return undefined;
  const out: RetrievalCall = { read, search, web: false, paths: [...paths], shell: true };
  if (search && quiet) out.quiet = true;
  return out;
}

const isPipeCmd = (p: ShellPart): boolean => !!p.ps && !!p.prog && PS_PIPE.has(p.prog.toLowerCase());

/** For each part, the index of the first part of its pipeline. */
function pipelineStarts(parts: readonly ShellPart[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < parts.length; i++) out.push(i > 0 && !!parts[i - 1]!.ps === !!parts[i]!.ps && continues(parts, i) ? out[i - 1]! : i);
  return out;
}

/**
 * Whether part `i` is in the same pipeline as part `i - 1`. A sh part says so itself: `last` is
 * false when it pipes into the next. PowerShell marks only the last part of a pipeline that is not
 * a pipeline cmdlet, so the cmdlets after it (`| Select-Object -First 5`) belong to it too.
 */
function continues(parts: readonly ShellPart[], i: number): boolean {
  const p = parts[i]!;
  const q = parts[i - 1]!;
  if (!p.ps) return !q.last;
  if (q.last) return isPipeCmd(p) && !p.last;
  if (!isPipeCmd(q)) return true;
  if (isPipeCmd(p) && !p.last) return true;
  // q ends a run of pipeline cmdlets: they follow the last part of a pipeline, or start the one p ends.
  let r = i - 2;
  while (r >= 0 && parts[r]!.ps && isPipeCmd(parts[r]!) && !parts[r]!.last) r--;
  const before = parts[r];
  return !before || !before.ps || !before.last;
}

/** Words that a `$( … )` or `( … )` split apart, joined again. `esc`: the shell's escape character. */
function joinSubst(argv: readonly string[], esc: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const w of argv) {
    if (depth > 0) out[out.length - 1] += ` ${w}`;
    else out.push(w);
    depth = Math.max(0, depth + parenDelta(w, esc));
  }
  return out;
}

/** Opening minus closing parentheses outside quotes and escapes. */
function parenDelta(w: string, esc: string): number {
  let d = 0;
  let quote = "";
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    if (c === esc && quote !== "'") i++;
    else if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(") d++;
    else if (c === ")") d--;
  }
  return d;
}

/** A sh word without its quotes and escapes, and whether it names one literal thing (no variable, glob or substitution). */
function shWord(w: string): { text: string; literal: boolean } {
  let text = "";
  let literal = true;
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    if (c === "'") {
      const end = w.indexOf("'", i + 1);
      text += w.slice(i + 1, end < 0 ? w.length : end);
      i = end < 0 ? w.length : end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < w.length && w[j] !== '"'; j++) {
        const d = w[j]!;
        if (d === "\\" && /["\\$`]/.test(w[j + 1] ?? "")) text += w[++j];
        else {
          if (d === "$" || d === "`") literal = false;
          text += d;
        }
      }
      i = j;
    } else if (c === "\\") text += w[++i] ?? "";
    else {
      if (/[$`*?[\]{}]/.test(c)) literal = false;
      text += c;
    }
  }
  return { text, literal };
}

/** A PowerShell word without its quotes and escapes (the backtick, doubled quotes), and whether it is literal. */
function psWord(w: string): { text: string; literal: boolean } {
  let text = "";
  let literal = true;
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    if (c === "'") {
      let j = i + 1;
      for (; j < w.length; j++) {
        if (w[j] === "'") {
          if (w[j + 1] !== "'") break;
          j++;
        }
        text += w[j];
      }
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < w.length; j++) {
        const d = w[j]!;
        if (d === "`") text += w[++j] ?? "";
        else if (d === '"') {
          if (w[j + 1] !== '"') break;
          text += '"';
          j++;
        } else {
          if (d === "$") literal = false;
          text += d;
        }
      }
      i = j;
    } else if (c === "`") text += w[++i] ?? "";
    else {
      if (/[$*?[\](){}]/.test(c) || (c === "@" && i === 0)) literal = false;
      text += c;
    }
  }
  return { text, literal };
}

/** Words with no quote, escape, variable, glob or backslash: each is its own text (sh, PowerShell). */
const SH_PLAIN = /^[^'"\\$`*?[\]{}]*$/;
const PS_PLAIN = /^[^'"`$*?[\](){}@\\]*$/;

/** A word as an operand: its literal text with `/` separators, or MARK and the word when it is not literal. A flag stays as written. */
function unq(raw: string, ps: boolean): string {
  if (raw.startsWith("-") || (ps ? PS_PLAIN : SH_PLAIN).test(raw)) return raw;
  const { text, literal } = ps ? psWord(raw) : shWord(raw);
  return literal ? text.replace(/\\/g, "/") : MARK + raw;
}

/** The longest path a `cd` or `git -C` chain builds before its directory counts as unknown. */
const MAX_PATH = 4096;

/** `p` under `dir`: an absolute path as it is, "" for the directory the call started in, undefined when `dir` is unknown. */
function resolve(p: string, dir: string | undefined): string | undefined {
  if (ABSOLUTE.test(p)) return posix.normalize(p);
  if (dir === undefined || dir.length + p.length > MAX_PATH) return undefined;
  return dir ? posix.join(dir, p) : posix.normalize(p);
}

/**
 * An operand that names a file: not stdin (`-`), a device or a directory. Its quotes are gone
 * (unq), so `"notes (1).md"` is a file here; shell-files.ts, which reads raw words, refuses
 * any word with a parenthesis.
 */
function fileOperand(a: string): boolean {
  if (!a || a === "-" || a === "." || a === ".." || a.endsWith("/")) return false;
  return !/^\/dev\//.test(a) && !/^(?:nul|con|prn|aux)(?:\.\w*)?$/i.test(a);
}

/** The read of `ops`, a reader's operands: a file each, or none for stdin, a device or a directory. */
function readOf(ops: readonly string[], dir: string | undefined): Found | undefined {
  const paths: string[] = [];
  let any = false;
  for (const a of ops) {
    if (a.startsWith(MARK)) any = true;
    else if (fileOperand(a)) {
      any = true;
      const r = resolve(a, dir);
      if (r !== undefined) paths.push(r);
    }
  }
  return any ? { kind: "read", paths } : undefined;
}

/** The directory after a sh `cd`, `pushd` or `popd`; undefined when it can't be known (`cd -`, `cd "$x"`). */
function shCd(prog: string, args: readonly string[], dir: string | undefined, stack: (string | undefined)[]): string | undefined {
  if (prog === "popd") return stack.length ? stack.pop() : undefined;
  const ops = args.filter((a) => a === "-" || !a.startsWith("-"));
  if (prog === "pushd") {
    if (!ops.length || /^[+-]\d+$/.test(ops[0]!)) return undefined;
    stack.push(dir);
  }
  const t = ops[0];
  if (t === undefined) return "~";
  if (t === "-" || t.startsWith(MARK)) return undefined;
  return resolve(t, dir);
}

/** The location after Set-Location, Push-Location or Pop-Location; undefined when it can't be known (a provider drive, a variable). */
function psCd(prog: string, raw: readonly string[], dir: string | undefined, stack: (string | undefined)[]): string | undefined {
  if (prog === "pop-location" || prog === "popd") return stack.length ? stack.pop() : undefined;
  if (prog === "push-location" || prog === "pushd") stack.push(dir);
  const t = pathArg(psArgs(raw, ["-stackname"]), 0)?.[0];
  if (t === undefined || t === "-" || t.startsWith(MARK) || /^[a-z]{2,}:/i.test(t) || /^[a-z]:$/i.test(t)) return undefined;
  return resolve(t, dir);
}

/** What a sh command at the head of its pipeline retrieves. */
function shFound(prog: string, args: readonly string[], dir: string | undefined): Found | undefined {
  const flags = READERS.get(prog);
  // `tail +5 f`, `less +G f`: a `+` word is a start line or a command, not a file.
  if (flags) return readOf(operandsOf(args, flags).filter((a) => !a.startsWith("+")), dir);
  if (prog === "sed" || prog === "gsed") {
    const ops = sedRead(args);
    return ops ? readOf(ops, dir) : undefined;
  }
  if (prog === "git") return gitFound(args, dir);
  if (GREPS.has(prog)) return { kind: "search", quiet: prog !== "findstr" && grepQuiet(args, prog) };
  if (prog === "find") return findDestroys(args) ? undefined : { kind: "search", quiet: false };
  if (SHELL_SEARCHERS.has(prog) || LISTERS.has(prog)) return { kind: "search", quiet: false };
  return undefined;
}

/** `sed -i`, `perl -i`: the command edits files in place. */
function inPlace(prog: string, args: readonly string[]): boolean {
  if (prog === "sed" || prog === "gsed") return args.some((a) => /^-[^-]*i/.test(a) || a.startsWith("--in-place"));
  return prog === "perl" && args.some((a) => /^-[^-]*i/.test(a));
}

/** The files `sed` prints: its operands after the script, or none when it edits them in place (`-i`). */
function sedRead(args: readonly string[]): string[] | undefined {
  let script = false;
  const ops: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      ops.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (a.startsWith("--in-place")) return undefined;
      if (a === "--expression" || a === "--file") {
        script = true;
        i++;
      } else if (a.startsWith("--expression=") || a.startsWith("--file=")) script = true;
      else if (a === "--line-length") i++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (c === "i") return undefined;
        if (c === "e" || c === "f" || c === "l") {
          if (c !== "l") script = true;
          if (k === a.length - 1) i++;
          break;
        }
      }
      continue;
    }
    ops.push(a);
  }
  return script ? ops : ops.slice(1);
}

/** grep's short flags that take a value (`-e`, `-m`, `-A`, …), and ripgrep's and the other searchers' (`-g`, `-t`, `-T`, …). */
const GREP_VALUED = "efmABCdD";
const SEARCHER_VALUED = "efmABCgtTMj";

/** `grep -q`, `--quiet`, `--silent`: the exit status is the answer and nothing prints. */
function grepQuiet(args: readonly string[], prog: string): boolean {
  const valued = /^[efz]?grep$/.test(prog) ? GREP_VALUED : SEARCHER_VALUED;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a === "--quiet" || a === "--silent") return true;
    if (!/^-[^-]/.test(a)) continue;
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if (c === "q") return true;
      // A flag that takes a value: the rest of the word is the value, or the next word when it ends the word (`grep -e -q`).
      if (valued.includes(c)) {
        if (j === a.length - 1) i++;
        break;
      }
    }
  }
  return false;
}

/** `find … -delete` or `-exec rm …`: a cleanup, not a search. */
function findDestroys(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-delete") return true;
    if (a !== "-exec" && a !== "-execdir" && a !== "-ok" && a !== "-okdir") continue;
    const prog = (args[i + 1] ?? "").replace(/^.*\//, "");
    let end = i + 2;
    while (end < args.length && args[end] !== ";" && args[end] !== "+") end++;
    if (DESTRUCTIVE.has(prog) || inPlace(prog, args.slice(i + 2, end))) return true;
    i = end;
  }
  return false;
}

/** Global git options that take a value (`-C` moves the directory and is read on its own). */
const GIT_VALUED = new Set(["-c", "--git-dir", "--work-tree", "--namespace"]);

/** `git grep` and `git ls-files` search; `git show <rev>:<path>` reads a file. */
function gitFound(args: readonly string[], dir: string | undefined): Found | undefined {
  let at = dir;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C") {
      const t = args[++i];
      at = t === undefined || t.startsWith(MARK) ? undefined : resolve(t, at);
    } else if (GIT_VALUED.has(a)) i++;
    else if (!a.startsWith("-")) break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === "grep") return { kind: "search", quiet: rest.some((a) => a === "-q" || a === "--quiet") };
  if (sub === "ls-files") return { kind: "search", quiet: false };
  if (sub !== "show") return undefined;
  const paths: string[] = [];
  let any = false;
  let tree = false;
  for (const a of operandsOf(rest)) {
    if (a.startsWith(MARK)) {
      if (a.includes(":")) any = true;
      continue;
    }
    const m = /^([^:]*):(.*)$/.exec(a);
    if (!m) continue;
    // `:path` and `:0:path` name the index's copy.
    const p = m[1] ? m[2]! : m[2]!.replace(/^[0-3]:/, "");
    if (p.startsWith("/")) continue;
    // `HEAD:` and `HEAD:src/` name a tree, which git lists.
    if (m[1] && (!p || p.endsWith("/"))) {
      tree = true;
      continue;
    }
    if (!p) continue;
    any = true;
    const k = gitPath(p, at);
    if (k !== undefined) paths.push(k);
  }
  return any ? { kind: "read", paths } : tree ? { kind: "search", quiet: false } : undefined;
}

/**
 * A `git show <rev>:<path>` path, relative to the directory the call started in. git reads it from
 * the repository root (or from git's own directory with `./`); the root is taken to be the
 * directory the call started in, or the absolute directory a `cd` moved to.
 */
function gitPath(p: string, dir: string | undefined): string | undefined {
  if (dir === undefined) return undefined;
  if (p.startsWith("./") || p.startsWith("../")) return dir ? posix.join(dir, p) : posix.normalize(p);
  return ABSOLUTE.test(dir) ? posix.join(dir, p) : posix.normalize(p);
}

// ---------------------------------------------------------------- PowerShell

/** Path parameters of the file cmdlets. */
const PS_PATH = ["-path", "-literalpath", "-lp", "-pspath"];
const GC_VALUES = ["-totalcount", "-head", "-first", "-tail", "-last", "-readcount", "-encoding", "-delimiter", "-filter", "-include", "-exclude", "-stream", "-credential"];
const GCI_VALUES = ["-filter", "-include", "-exclude", "-depth", "-attributes", "-credential"];
const SLS_VALUES = ["-pattern", "-inputobject", "-encoding", "-context", "-include", "-exclude", "-culture"];
/** PowerShell drives that are not the file system. */
const PROVIDER = /^(?:env|variable|function|alias|cert|hk\w*|wsman):/i;

interface PsArgs {
  /** Named parameters (lower case) and their values, each comma list split. */
  named: Map<string, string[]>;
  /** Positional values in order, each a comma list split. */
  positional: string[][];
  /** Parameters without a value (lower case). */
  switches: Set<string>;
}

/** A cmdlet's arguments. `valued`: its parameters that take a value, besides the paths and the common ones. */
function psArgs(raw: readonly string[], valued: readonly string[]): PsArgs {
  const out: PsArgs = { named: new Map(), positional: [], switches: new Set() };
  const items = (text: string) => splitCommas(text).map((w) => unq(w, true));
  // `a, b` is three words and `a,b` one: a comma list goes on while a word ends or starts with a comma.
  const take = (i: number): [string[], number] => {
    let text = raw[i] ?? "";
    // `tail`, the last word that is not empty, ends as `text` does. `text.endsWith` would copy all
    // of `text`, built by `+=`, on every step.
    let tail = text;
    while (i + 1 < raw.length && (tail.endsWith(",") || raw[i + 1]!.startsWith(","))) {
      const w = raw[++i]!;
      text += w;
      if (w) tail = w;
    }
    return [items(text), i];
  };
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i]!;
    if (/^-[A-Za-z]/.test(w)) {
      const colon = w.indexOf(":");
      const name = (colon > 0 ? w.slice(0, colon) : w).toLowerCase();
      if (colon > 0) out.named.set(name, items(w.slice(colon + 1)));
      else if (PS_PATH.includes(name) || valued.includes(name) || PS_COMMON.includes(name)) {
        const [v, j] = take(i + 1);
        out.named.set(name, v);
        i = j;
      } else out.switches.add(name);
      continue;
    }
    const [v, j] = take(i);
    out.positional.push(v);
    i = j;
  }
  return out;
}

/** A comma list's items, commas inside quotes or parentheses kept. */
function splitCommas(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      cur += c;
      if (c === "`" && quote === '"') cur += text[++i] ?? "";
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "`") cur += c + (text[++i] ?? "");
    else if (c === "," && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** A cmdlet's path: its named path parameter, else its positional value at `at`. */
function pathArg(a: PsArgs, at: number): string[] | undefined {
  for (const n of PS_PATH) {
    const v = a.named.get(n);
    if (v) return v;
  }
  return a.positional[at];
}

/**
 * What a PowerShell command at the head of its pipeline retrieves: null for a file cmdlet that
 * retrieves nothing here, undefined for any other command (shFound decides: `rg`, `git show`).
 */
function psFound(prog: string, raw: readonly string[], dir: string | undefined): Found | null | undefined {
  switch (prog) {
    case "get-content":
    case "gc":
    case "cat":
    case "type": {
      const paths = pathArg(psArgs(raw, GC_VALUES), 0);
      return (paths && readOf(paths, dir)) ?? null;
    }
    case "get-childitem":
    case "gci":
    case "dir":
    case "ls": {
      const paths = pathArg(psArgs(raw, GCI_VALUES), 0) ?? [];
      return paths.some((p) => PROVIDER.test(p)) ? null : { kind: "search", quiet: false };
    }
    case "select-string":
    case "sls": {
      const a = psArgs(raw, SLS_VALUES);
      const paths = pathArg(a, a.named.has("-pattern") ? 0 : 1);
      return paths?.length ? { kind: "search", quiet: a.switches.has("-quiet") } : null;
    }
    case "where-object":
    case "where":
    case "?":
      return null;
  }
  return undefined;
}

// ---------------------------------------------------------------- empty searches

/** What a search tool or a harness prints for no match. */
const NO_RESULTS = /^\s*(?:No (?:files|matches|results)(?: were)? found|Found 0 (?:files|matches|results))\b/i;
/** A shell command's whole output that says no match: `grep "No files found" log` prints matches that start the same way. */
const NO_RESULTS_ONLY = /^(?:No (?:files|matches|results)(?: were)? found|Found 0 (?:files|matches|results))[.!]?$/i;
/** What a harness prints for a command that printed nothing. */
const NO_OUTPUT = /^\((?:[\w -]+ completed with no output|no output|no content|empty|none)\)$/i;
/** Header lines a harness puts before a command's own output (Claude Code, Codex), as in core/failures.ts. */
const HEADER_LINE = /^(?:Error: )?Exit code:? -?\d+[^\n]*$|^Process exited with code -?\d+[^\n]*$|^Wall time:[^\n]*$|^Original token count:[^\n]*$|^Chunk ID:[^\n]*$|^Output:\s*$/;
const EXIT_LINE = /^(?:(?:Error: )?Exit code:?|Process exited with code) (-?\d+)/m;
/** Gemini CLI's shell result: labeled sections, the command's output under Output: (or Stdout: and Stderr:). */
const GEMINI_LABEL = /^(Command|Directory|Output|Stdout|Stderr|Error|Exit Code|Signal|Background PIDs|Process Group PGID):\s?/;

function textOf(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** What a command printed: the harness's headers, labels and trailers dropped. */
function bodyText(v: unknown): string {
  let t = textOf(v);
  if (/^Command: /.test(t)) {
    const keep: string[] = [];
    let on = false;
    for (const line of t.split("\n")) {
      const m = GEMINI_LABEL.exec(line);
      if (m) {
        on = m[1] === "Output" || m[1] === "Stdout" || m[1] === "Stderr";
        if (on) keep.push(line.slice(m[0].length));
      } else if (on) keep.push(line);
    }
    t = keep.filter((l) => !NO_OUTPUT.test(l.trim())).join("\n");
  }
  // Copilot CLI ends a shell result with `<shellId: 3 completed with exit code 1>`.
  if (t.includes("<shellId: ")) t = t.replace(/\n?<shellId: [^>\n]*>\s*$/, "");
  // Header lines, and a blank first line, come off the top; the body is the text from the first other line.
  let start = 0;
  for (let first = true; ; first = false) {
    const nl = t.indexOf("\n", start);
    const line = t.slice(start, nl < 0 ? t.length : nl).trim();
    if (!HEADER_LINE.test(line) && (!first || line)) break;
    if (nl < 0) return "";
    start = nl + 1;
  }
  const body = t.slice(start).trim();
  return NO_OUTPUT.test(body) ? "" : body;
}

/** A search's structured result (Claude Code's Grep and Glob, a shell's stdout and stderr): whether it found nothing, or undefined when it is not one. */
function shapeEmpty(output: unknown): boolean | undefined {
  let o = output;
  if (typeof o === "string") {
    if (!o.trimStart().startsWith("{")) return undefined;
    try {
      o = JSON.parse(o);
    } catch {
      return undefined;
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return undefined;
  const r = o as Record<string, unknown>;
  if (r.mode === "content") return typeof r.numLines === "number" ? r.numLines === 0 : typeof r.content === "string" ? !r.content.trim() : undefined;
  if (r.mode === "count" && typeof r.numMatches === "number") return r.numMatches === 0;
  if (typeof r.numFiles === "number") return r.numFiles === 0;
  if (Array.isArray(r.filenames)) return r.filenames.length === 0;
  if (typeof r.stdout === "string" || typeof r.stderr === "string") return blank(r.stdout) && blank(r.stderr);
  return undefined;
}

/** Not a string, or only white space. */
const blank = (v: unknown): boolean => typeof v !== "string" || !v.trim();

const num = (m: RegExpExecArray | null): number | undefined => (m ? Number(m[1]) : undefined);

/** A shell call's exit status: the event's, else the one its harness printed. */
function exitStatus(p: Record<string, unknown>): number | undefined {
  const text = `${textOf(p.output)}\n${textOf(p.error)}`;
  return exitCodeOf(p.exitCode, text) ?? num(EXIT_LINE.exec(text.slice(0, 512))) ?? num(/^Exit Code: (-?\d+)/m.exec(text)) ?? num(/<shellId: \S+ completed with exit code (-?\d+)>/.exec(text));
}

/**
 * A search that found nothing: it printed nothing, its tool said "No matches found" or "No files
 * found" (a shell command: that line and nothing else), or it exited 1 (grep's and rg's "no
 * match") with nothing printed. A search whose output was cut, that was stopped, or whose matches
 * went elsewhere (`quiet`) did not find nothing.
 */
function foundNothing(e: AgentEvent, failure: ToolFailure | undefined, quiet: boolean, shell: boolean): boolean {
  const p = e.payload;
  if (failure?.cls === "interrupted" || p.interrupted === true) return false;
  if (p.cut && typeof p.cut === "object") return false;
  const shape = shapeEmpty(p.output);
  if (shape === false) return false;
  // A quiet search prints nothing by design: only its exit status says it found nothing.
  if (shape && !quiet) return true;
  const printed = `${shape ? "" : bodyText(p.output)}\n${bodyText(p.error)}`.trim();
  const none = shell ? NO_RESULTS_ONLY : NO_RESULTS;
  if (failure?.cls === "benign" && failure.reason === "no-match") return !printed || none.test(printed);
  if (p.ok === false) return !printed && exitStatus(p) === 1;
  if (none.test(printed)) return true;
  if (quiet || ((p.output === undefined || p.output === null) && (p.error === undefined || p.error === null))) return false;
  return !printed;
}

// ---------------------------------------------------------------- the fold

/** A read or search that started and has not ended. */
interface Pending {
  /** The keys of the files it reads. */
  keys: string[];
  shell?: true;
  /** It searches and reads nothing: its result may be empty. */
  search?: true;
  quiet?: true;
}

/** The fold state behind Session.stats.retrieval. Plain data (Maps, Sets, arrays), saved with the session's fold. */
export interface RetrievalState {
  reads: number;
  searches: number;
  /** Searches that found nothing. */
  empty: number;
  web: number;
  /** Calls that read or searched (a call that does both counts once). */
  calls: number;
  /** `calls` when the session first edited a file. */
  firstEdit?: number;
  /** Files read, by key: how many reads named it (a read that failed takes its own back). */
  files: Map<string, number>;
  /** Files read, then edited. */
  edited: Set<string>;
  /** Reads and searches by tool-use id, from their start to their end. */
  open: Map<string, Pending>;
  /** Reads and searches without an id, in order, by subagent and tool; null for a call that is neither. */
  idless: Map<string, (Pending | null)[]>;
}

export const retrievalState = (): RetrievalState => ({ reads: 0, searches: 0, empty: 0, web: 0, calls: 0, files: new Map(), edited: new Set(), open: new Map(), idless: new Map() });

const MAX_OPEN = 256;
const MAX_IDLESS = 64;
const MAX_QUEUES = 64;
/** A shell error that says a file was not read. */
const NOT_READ = /no such file|not found|cannot find|can't (?:open|read|find)|cannot (?:open|read|access)|does not exist|is a directory|permission denied|access (?:is )?denied/i;

/**
 * Read paths as filesChanged keys (sessions.ts changeKey): relative to the session's cwd when
 * inside it, else absolute. A relative path is joined to the event's cwd first; Git Bash's `/c/x`
 * is `C:/x`, with the drive letter in the cwd's case. The cwds are read once for all of a call's paths.
 */
function keyer(eventCwd: string | undefined, cwd: string | undefined): (path: string) => string | undefined {
  const base = (eventCwd ?? cwd)?.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = base && /^[A-Za-z]:/.test(base) ? base[0]! : undefined;
  const rooted = !!base && /^(?:\/|[A-Za-z]:\/)/.test(base);
  const change = changeKeyer(eventCwd, cwd);
  return (path) => {
    let p = slashed(path);
    if (drive) {
      if (p[0] === "/") p = p.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:");
      if (/^[A-Za-z]:/.test(p) && p[0]!.toLowerCase() === drive.toLowerCase()) p = drive + p.slice(1);
    }
    if (rooted && !ABSOLUTE.test(p)) p = posix.join(base!, p);
    const k = posix.normalize(change(p));
    return k === "" || k === "." ? undefined : k;
  };
}

/** An edit's filesChanged key in keyer's form: `.` and `..` resolved, Git Bash's `/c/x` as `C:/x`, the drive letter in the cwd's case. */
function editKey(key: string, cwd: string | undefined): string {
  let k = posix.normalize(key.replace(/\\/g, "/"));
  const c = cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (c && /^[A-Za-z]:/.test(c)) k = k.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:");
  if (c && /^[A-Za-z]:/.test(c) && /^[A-Za-z]:/.test(k) && k[0]!.toLowerCase() === c[0]!.toLowerCase()) k = c[0] + k.slice(1);
  k = normalizeTracePath(k, c);
  if (c && ABSOLUTE.test(c) && k.startsWith("../")) k = normalizeTracePath(posix.join(c, k), c);
  return k;
}

/** Counts a call as it starts; the Pending to settle at its end, or undefined when it neither reads nor searches. */
function begin(s: RetrievalState, e: AgentEvent, cwd: string | undefined): Pending | undefined {
  const c = classifyRetrieval(e.payload.tool, e.payload.input);
  if (!c) return undefined;
  if (c.web) s.web++;
  if (!c.read && !c.search) return undefined;
  if (c.read) s.reads++;
  if (c.search) s.searches++;
  s.calls++;
  const keys = [...new Set(c.paths.map(keyer(e.cwd, cwd)).filter((k): k is string => k !== undefined))];
  for (const k of keys) s.files.set(k, (s.files.get(k) ?? 0) + 1);
  const pending: Pending = { keys };
  if (c.shell) pending.shell = true;
  if (c.search && !c.read) pending.search = true;
  if (c.quiet) pending.quiet = true;
  return pending;
}

function drop(s: RetrievalState, key: string): void {
  const n = (s.files.get(key) ?? 0) - 1;
  if (n > 0) s.files.set(key, n);
  else {
    s.files.delete(key);
    s.edited.delete(key);
  }
}

/**
 * The needles that some line holds, as `lines.some((l) => l.includes(n))` finds each, in one pass
 * over the lines (Aho–Corasick): a failed `cat` of many files is not a scan of the output per file.
 */
function heldBy(needles: readonly string[], lines: readonly string[]): Set<string> {
  const held = new Set<string>();
  if (!lines.length) return held;
  // A trie of the needles by UTF-16 code unit, the unit `includes` compares; ends[s]: the needles that end at state s.
  const next: Map<number, number>[] = [new Map()];
  const ends: string[][] = [[]];
  for (const n of needles) {
    // Every line holds "".
    if (!n) held.add(n);
    let s = 0;
    for (let i = 0; i < n.length; i++) {
      const c = n.charCodeAt(i);
      let t = next[s]!.get(c);
      if (t === undefined) {
        t = next.length;
        next[s]!.set(c, t);
        next.push(new Map());
        ends.push([]);
      }
      s = t;
    }
    ends[s]!.push(n);
  }
  // fail[s]: the state of the longest proper suffix of s's text that starts a needle, breadth first.
  const fail: number[] = new Array<number>(next.length).fill(0);
  const order = [...next[0]!.values()];
  for (let q = 0; q < order.length; q++) {
    const s = order[q]!;
    for (const [c, t] of next[s]!) {
      let f = fail[s]!;
      while (f && !next[f]!.has(c)) f = fail[f]!;
      fail[t] = next[f]!.get(c) ?? 0;
      order.push(t);
    }
  }
  /** States whose needles, and their suffixes' needles, are in `held`. */
  const done = new Uint8Array(next.length);
  for (const line of lines) {
    let s = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      while (s && !next[s]!.has(c)) s = fail[s]!;
      s = next[s]!.get(c) ?? 0;
      for (let o = s; o && !done[o]; o = fail[o]!) {
        done[o] = 1;
        for (const n of ends[o]!) held.add(n);
      }
    }
  }
  return held;
}

/** Settles a call at its end: a read that failed reads no file, a search may have found nothing. */
function settle(s: RetrievalState, e: AgentEvent, pending: Pending, failure: ToolFailure | undefined): void {
  const p = e.payload;
  if (failure?.cls === "interrupted" || p.interrupted === true || (p.ok === false && !pending.shell)) for (const k of pending.keys) drop(s, k);
  else if (p.ok === false && pending.keys.length) {
    // A shell line fails as a whole: a file counts as not read when an error line names it.
    const lines = `${textOf(p.output)}\n${textOf(p.error)}`.split("\n").filter((l) => NOT_READ.test(l));
    const names = pending.keys.map((k) => posix.basename(k));
    const named = heldBy(names, lines);
    for (let i = 0; i < names.length; i++) if (named.has(names[i]!)) drop(s, pending.keys[i]!);
  }
  if (pending.search && foundNothing(e, failure, !!pending.quiet, !!pending.shell)) s.empty++;
}

/** The queue a call without a tool-use id waits in: by subagent and tool. Built only for such calls. */
const queueOf = (e: AgentEvent): string => `${e.subagentId ?? ""}\u0000${typeof e.payload.tool === "string" ? e.payload.tool.toLowerCase() : ""}`;

/**
 * Folds the next event. `cwd`: the session's working directory. `seen`: the tool-use ids the
 * session saw before this event (sessions.ts SessionState.toolIds), so a call seen live and from
 * its transcript counts once. `failure`: how this event failed (core/failures.ts foldFailure).
 */
export function foldRetrieval(s: RetrievalState, e: AgentEvent, o: { cwd?: string; seen: ReadonlySet<string>; failure?: ToolFailure }): void {
  if (e.kind !== "tool.start" && e.kind !== "tool.end") return;
  const p = e.payload;
  if (p.wrapper === true) return;
  const id = typeof p.toolUseId === "string" && p.toolUseId ? p.toolUseId : undefined;
  if (e.kind === "tool.start") {
    if (id) {
      if (o.seen.has(id)) return;
      const pending = begin(s, e, o.cwd);
      if (!pending) return;
      s.open.set(id, pending);
      if (s.open.size > MAX_OPEN) s.open.delete(s.open.keys().next().value!);
      return;
    }
    const queue = queueOf(e);
    let q = s.idless.get(queue);
    if (!q) {
      if (s.idless.size >= MAX_QUEUES) s.idless.delete(s.idless.keys().next().value!);
      s.idless.set(queue, (q = []));
    }
    q.push(begin(s, e, o.cwd) ?? null);
    if (q.length > MAX_IDLESS) q.shift();
    return;
  }
  if (id) {
    const pending = s.open.get(id);
    if (pending) {
      s.open.delete(id);
      settle(s, e, pending, o.failure);
      return;
    }
    if (o.seen.has(id)) return;
  } else {
    const queue = queueOf(e);
    const q = s.idless.get(queue);
    if (q) {
      const pending = q.shift();
      if (!q.length) s.idless.delete(queue);
      if (pending) settle(s, e, pending, o.failure);
      return;
    }
  }
  // An end whose start was never seen: classified from its own input.
  const pending = begin(s, e, o.cwd);
  if (pending) settle(s, e, pending, o.failure);
}

/** Notes an edit (a file.change, a shell call's write) of `key`, a filesChanged key. */
export function markRetrievalEdit(s: RetrievalState, key: string, cwd: string | undefined): void {
  s.firstEdit ??= s.calls;
  const k = editKey(key, cwd);
  if (s.files.has(k)) s.edited.add(k);
}

/** Session.stats.retrieval, or undefined when the session read, searched and fetched nothing. */
export function retrievalOf(s: RetrievalState): RetrievalStats | undefined {
  if (!s.reads && !s.searches && !s.web) return undefined;
  const out: RetrievalStats = { reads: s.reads, filesRead: s.files.size, editedAfterRead: s.edited.size, searches: s.searches };
  if (s.empty) out.emptySearches = s.empty;
  if (s.web) out.web = s.web;
  if (s.firstEdit !== undefined) out.beforeFirstEdit = s.firstEdit;
  return out;
}

/** Retrieval over many sessions: each count summed, beforeFirstEdit over the sessions that edited (editedSessions). */
export interface RetrievalTotals {
  /** Sessions with retrieval stats. */
  sessions: number;
  reads: number;
  filesRead: number;
  editedAfterRead: number;
  searches: number;
  emptySearches: number;
  web: number;
  beforeFirstEdit: number;
  editedSessions: number;
}

/** The retrieval totals of `sessions`, or undefined when none read, searched or fetched. */
export function retrievalTotals(sessions: readonly Session[]): RetrievalTotals | undefined {
  const t: RetrievalTotals = { sessions: 0, reads: 0, filesRead: 0, editedAfterRead: 0, searches: 0, emptySearches: 0, web: 0, beforeFirstEdit: 0, editedSessions: 0 };
  for (const x of sessions) {
    const r = x.stats.retrieval;
    if (!r) continue;
    t.sessions++;
    t.reads += r.reads;
    t.filesRead += r.filesRead;
    t.editedAfterRead += r.editedAfterRead;
    t.searches += r.searches;
    t.emptySearches += r.emptySearches ?? 0;
    t.web += r.web ?? 0;
    if (r.beforeFirstEdit !== undefined) {
      t.beforeFirstEdit += r.beforeFirstEdit;
      t.editedSessions++;
    }
  }
  return t.sessions ? t : undefined;
}
