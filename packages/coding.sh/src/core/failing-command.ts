// Which part of a shell command failed. A shell tool call reports one exit
// status for the whole line, so `cd x && cat a.toml && cargo build` failing is
// not a failing `cat`. improve groups failures by command, and attributes a
// compound line (`&&`, `||`, `;`, `|`, newlines, loops) to the part that failed,
// on evidence only, first match:
//
//   1. a part the error names: `cat: a: No such file`, `foo: command not found`
//   2. a known tool's error signature: rustc's `error[E0308]`, a Python
//      traceback or `x.py:3: DeprecationWarning`, `npm error`, git's `fatal:`
//   3. exit status 124 from the one part run under `timeout`
//   4. only one part that runs a program
//   5. shell semantics: the last part of a pipeline sets its status, and tools
//      that always name themselves when they fail (cat, sed, ls, …) did not fail
//      when the error doesn't name them (unless their errors go to /dev/null);
//      grep, rg and diff exit 1 silently
//
// No part failed when nothing ran: a shell parse error (`bash: -c: line 9:
// unexpected EOF …`), or a removal check's denial, which is the removal's
// (`rm`) when one part removes. The shell's own messages never name a
// `bash x.sh` part. A stored command cut short (`…` at its end) hides parts,
// so rules 4 and 5, which work by elimination, give no answer for it.
//
// Keywords (for, do, done, if, then, …), variable assignments, redirects,
// flags and wrappers (sudo, env, nohup, timeout, xargs) are never the command.
// When the evidence leaves more than one part, there is no answer: improve
// says "compound command" instead of guessing. Pure.
//
// PowerShell is parsed as PowerShell: a line run by a PowerShell tool, or by
// `powershell`/`pwsh -Command`, whose launcher is dropped. Statements split on
// `;`, newlines, `&&`, `||` and script-block braces, pipelines on `|`; single
// quotes are literal and the backtick escapes. A pipeline cmdlet (Select-Object,
// Out-String, Where-Object, ForEach-Object, Sort-Object, …) only passes on what
// the command before it printed, so it is never the failing program unless the
// error names it.

/** The shell a command line is written for. */
export type Shell = "sh" | "powershell";

export interface ShellPart {
  /** The words from the program on: keywords, assignments, redirects and wrappers dropped. */
  argv: string[];
  /** The program's base name, or undefined when it is not a plain word (`"$BIN"`). */
  prog: string | undefined;
  /** The last part of its pipeline: the one whose exit status the pipeline returns. */
  last: boolean;
  /** Run under `timeout`. */
  timed: boolean;
  /** Its error output goes to /dev/null (`2>/dev/null`, `&>/dev/null`): it can fail without naming itself. */
  quiet?: true;
  /** Parsed as PowerShell. */
  ps?: true;
}

/** Shell keywords that open, continue or close a compound command. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}", "!", "time", "esac", "function", "coproc"]);
/** Keywords whose part is a header, not a command: `for f in *.py`, `case $x in`. */
const HEADERS = new Set(["for", "select", "case"]);
/** Programs that run another: the command is what follows them. */
const WRAPPERS = new Set(["sudo", "env", "nohup", "command", "exec", "nice", "builtin", "stdbuf", "caffeinate", "timeout", "gtimeout", "xargs"]);
/** xargs and timeout flags that take a value. */
const FLAG_VALUE: Record<string, Set<string>> = {
  xargs: new Set(["-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a", "--max-args", "--max-procs", "--delimiter"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  gtimeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  nice: new Set(["-n"]),
  sudo: new Set(["-u", "-g", "-C", "-D"]),
};
/** Builtins and setup steps: what the line does around the command, not the command (unless nothing else runs). */
const SETUP = new Set(["cd", "pushd", "popd", "export", "unset", "set", "source", ".", "echo", "printf", "true", "false", ":", "sleep", "local", "declare", "typeset", "readonly", "read", "wait", "shift", "exit", "return", "trap", "ulimit", "umask", "alias", "unalias", "let", "break", "continue", "[", "[[", "test", "shopt", "hash", "type"]);
/** Tools whose every error message starts with their own name. */
const SELF_NAMING = new Set([
  "cat", "head", "tail", "ls", "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown", "ln", "wc", "sort", "uniq", "cut", "tr", "sed", "gsed", "awk", "gawk",
  "find", "tee", "stat", "du", "df", "file", "basename", "dirname", "readlink", "realpath", "date", "tar", "gzip", "gunzip", "unzip", "jq", "yq", "nl", "column",
  "grep", "egrep", "fgrep", "rg", "diff", "cmp", "xxd", "od", "comm", "paste", "split", "seq", "tree", "less", "more",
]);
/** Self-naming tools that exit 1 without a word: no match, files differ. */
const SILENT_ON_1 = new Set(["grep", "egrep", "fgrep", "rg", "diff", "cmp"]);

/** Self-naming tools that print nothing when they work. */
const QUIET = new Set(["cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown", "ln"]);

/** Error signatures and the programs that print them. */
const SIGNATURES: readonly [RegExp, RegExp][] = [
  [/^error(?:\[E\d{4}\])?: |^\s*--> \S+\.rs:\d+|could not compile `|^warning: unused /m, /^(?:cargo|rustc|cargo-\w+|rustup)$/],
  [/Traceback \(most recent call last\)|^\s*File "[^"\n]+", line \d+|\.py:\d+: \w*(?:Warning|Error)\b|^ModuleNotFoundError: /m, /^(?:python[\d.]*|pytest|py\.test|uv|uvx|poetry|pip[\d.]*|pipenv|tox|nox|mypy|ruff|black|isort|flake8|pylint|django-admin|manage\.py)$/],
  [/^npm (?:ERR!|error) /m, /^npm$/],
  [/ERR_PNPM_/, /^pnpm$/],
  [/^error Command failed with exit code|^error An unexpected error occurred/m, /^yarn$/],
  [/^fatal: |^error: (?:pathspec|src refspec|failed to push|Your local changes)/m, /^git$/],
  [/^gh: |^HTTP \d{3}: /m, /^gh$/],
  [/^go: |^\S+\.go:\d+:\d+: /m, /^go$/],
];

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const REDIRECT = /^(?:\d*(?:>>?|<<?<?|>&|<&|>\|)|&>>?)/;
const PROG = /^[\w.+@:,-]+$/;

/** The parts of a command line, split on `&&`, `||`, `;`, `|`, `&` and newlines outside quotes, substitutions and heredocs. */
function splitParts(cmd: string): { text: string; last: boolean }[] {
  const out: { text: string; last: boolean }[] = [];
  let cur = "";
  let quote = "";
  let subst = 0;
  const heredocs: string[] = [];
  const push = (pipe: boolean) => {
    if (cur.trim()) out.push({ text: cur.trim(), last: !pipe });
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const next = cmd[i + 1];
    if (quote) {
      if (c === "\\" && quote === '"') {
        cur += c + (next ?? "");
        i++;
      } else {
        cur += c;
        if (c === quote) quote = "";
      }
      continue;
    }
    if (c === "\\") {
      // A line continuation joins the next line; any other escape keeps its character.
      if (next === "\n") cur += " ";
      else cur += c + (next ?? "");
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "$" && next === "(") {
      subst++;
      cur += "$(";
      i++;
      continue;
    }
    if (subst > 0) {
      if (c === "(") subst++;
      else if (c === ")") subst--;
      cur += c;
      continue;
    }
    if (c === "#" && (cur === "" || /\s$/.test(cur))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "<" && next === "<" && cmd[i + 2] !== "<") {
      const m = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(cmd.slice(i));
      if (m) {
        heredocs.push(m[2]!);
        cur += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "\n") {
      push(false);
      // A heredoc's body is text, not commands: skip to each delimiter line.
      let j = i + 1;
      for (const delim of heredocs.splice(0)) {
        while (j < cmd.length) {
          const nl = cmd.indexOf("\n", j);
          const line = cmd.slice(j, nl < 0 ? cmd.length : nl);
          j = nl < 0 ? cmd.length : nl + 1;
          if (line.trim() === delim) break;
        }
      }
      i = j - 1;
      continue;
    }
    if (c === ";") {
      if (next === ";") i++;
      push(false);
      continue;
    }
    if (c === "&") {
      if (next === "&") {
        i++;
        push(false);
      } else if (/[<>]$/.test(cur) || next === ">") cur += c;
      else push(false);
      continue;
    }
    if (c === "|") {
      if (next === "|") {
        i++;
        push(false);
      } else {
        if (next === "&") i++;
        push(true);
      }
      continue;
    }
    // Subshell parentheses group parts; the parts inside still run.
    cur += c === "(" || c === ")" ? " " : c;
  }
  push(false);
  return out;
}

/** Words of one part, quotes kept with the word they belong to. */
const words = (text: string): string[] => text.match(/(?:[^\s"'`]+|"(?:\\.|[^"\\])*"?|'[^']*'?|`[^`]*`?)+/g) ?? [];
const unquote = (w: string): string => w.replace(/^(["'])(.*)\1$/s, "$2");

/** One part's program and arguments, or undefined for a header or a part with no program. */
function partOf(text: string, last: boolean): ShellPart | undefined {
  let w = words(text);
  if (HEADERS.has(w[0] ?? "")) return undefined;
  let timed = false;
  for (;;) {
    const x = w[0];
    if (x === undefined) return undefined;
    if (KEYWORDS.has(x) || ASSIGNMENT.test(x)) w = w.slice(1);
    else if (REDIRECT.test(x)) w = w.slice(REDIRECT.exec(x)![0].length === x.length ? 2 : 1);
    else if (WRAPPERS.has(unquote(x))) {
      const name = unquote(x);
      if (name === "timeout" || name === "gtimeout") timed = true;
      w = w.slice(1);
      const valued = FLAG_VALUE[name];
      while (w[0] !== undefined && (w[0].startsWith("-") || (name === "env" && ASSIGNMENT.test(w[0])))) w = w.slice(valued?.has(w[0]) ? 2 : 1);
      // timeout's duration (60, 5m, 1.5s) comes before the command.
      if ((name === "timeout" || name === "gtimeout") && /^\d/.test(w[0] ?? "")) w = w.slice(1);
    } else break;
  }
  const argv: string[] = [];
  let quiet = false;
  for (let i = 0; i < w.length; i++) {
    const x = w[i]!;
    if (REDIRECT.test(x)) {
      const op = REDIRECT.exec(x)![0];
      const target = op.length === x.length ? (w[i + 1] ?? "") : x.slice(op.length);
      if (/^(?:2>>?|&>>?)$/.test(op) && /^(?:\/dev\/null|nul)$/i.test(unquote(target))) quiet = true;
      if (op.length === x.length) i++;
      continue;
    }
    argv.push(x);
  }
  if (!argv.length) return undefined;
  const raw = unquote(argv[0]!);
  const base = raw.split(/[\\/]/).filter(Boolean).pop() ?? raw;
  const prog = raw === "[" || raw === "[[" ? raw : !raw.startsWith("-") && !raw.startsWith("$") && PROG.test(base) ? base : undefined;
  const part: ShellPart = { argv, prog, last, timed };
  if (quiet) part.quiet = true;
  return part;
}

/** A PowerShell launcher: `powershell.exe`, `pwsh`, by path or not, quoted or not. */
const PS_LAUNCHER = /^(?:powershell|pwsh)(?:\.exe)?$/i;
const PS_LAUNCH = /^\s*("[^"]+"|'[^']+'|\S+)\s+((?:\S+\s+)*?)-c(?:ommand)?\s+([\s\S]*\S)\s*$/i;

/**
 * The command a PowerShell launcher runs: `powershell.exe -NoProfile -Command <cmd>` → `<cmd>`.
 * Codex on Windows records every shell call this way, so the shell is never the failing program.
 * Any other line comes back as it is.
 */
export function launchedCommand(cmd: string): string {
  const m = PS_LAUNCH.exec(cmd);
  if (!m) return cmd;
  const prog = unquote(m[1]!);
  if (!PS_LAUNCHER.test(prog.split(/[\\/]/).filter(Boolean).pop() ?? prog)) return cmd;
  // Between the launcher and -Command: flags and the values they take (-ExecutionPolicy Bypass).
  const flags = m[2]!.split(/\s+/).filter(Boolean);
  if (flags.some((f, i) => !f.startsWith("-") && !flags[i - 1]?.startsWith("-"))) return cmd;
  const script = m[3]!;
  // A POSIX shell kept its escapes inside double quotes: `\"` is a quote in the script.
  return /^"[\s\S]*"$/.test(script) ? script.slice(1, -1).replace(/\\(["\\$`])/g, "$1") : unquote(script);
}

/** A tool that runs PowerShell itself (Claude Code's PowerShell tool on Windows). */
export const isPowerShellTool = (tool: string | undefined): boolean => tool !== undefined && /^(?:powershell|pwsh)$/i.test(tool);

/** PowerShell setup steps: what the line does around the command (lower case: PowerShell ignores case). */
const PS_SETUP = new Set([
  "set-location", "sl", "cd", "chdir", "push-location", "pushd", "pop-location", "popd", "write-host", "write-output", "write-verbose", "write-information", "write-debug",
  "echo", "write", "start-sleep", "sleep", "test-path", "set-variable", "set", "set-strictmode", "clear-host", "cls", "exit", "return", "import-module",
]);
/** Pipeline cmdlets: they pass on, filter or format what the command before them printed. */
const PS_PIPE = new Set([
  "select-object", "select", "out-string", "oss", "out-null", "out-host", "out-default", "out-file", "where-object", "where", "?", "foreach-object", "foreach", "%",
  "sort-object", "sort", "format-table", "ft", "format-list", "fl", "format-wide", "fw", "format-custom", "fc", "measure-object", "measure", "tee-object", "tee",
  "group-object", "group", "select-string", "sls", "get-unique", "gu", "convertto-json", "convertfrom-json", "convertto-csv", "convertfrom-csv", "out-gridview",
]);
/** PowerShell keywords whose statement is a header (`if (…)`, `foreach ($x in …)`): its commands run in the braces after it. */
const PS_HEADERS = new Set(["if", "elseif", "while", "for", "foreach", "switch", "until", "catch", "function", "filter", "workflow", "param", "trap", "throw", "break", "continue", "class", "enum", "data"]);
/** PowerShell words that start a statement without being its command: `try`, `else`, the call operator `&`, dot-sourcing. */
const PS_SKIP = new Set(["try", "else", "finally", "do", "begin", "process", "end", "&", "."]);
const PS_REDIRECT = /^(?:[\d*]?>>?(?:&[1-6])?|<)/;

const psLower = (p: ShellPart): string => (p.ps && p.prog ? p.prog.toLowerCase() : "");
/** A setup step: a shell builtin, or PowerShell's own. */
const isSetup = (p: ShellPart): boolean => SETUP.has(p.prog ?? "") || PS_SETUP.has(psLower(p));
/** A PowerShell pipeline cmdlet. */
const isPipe = (p: ShellPart): boolean => PS_PIPE.has(psLower(p));

/** A PowerShell script's statements, split on `;`, newlines, `&&`, `||`, braces and `|` outside quotes, here-strings and parentheses. */
function splitPowerShell(cmd: string): { text: string; pipe: boolean }[] {
  const out: { text: string; pipe: boolean }[] = [];
  let cur = "";
  let quote = "";
  let here = "";
  const nest: string[] = [];
  const push = (pipe: boolean) => {
    if (cur.trim()) out.push({ text: cur.trim(), pipe });
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const next = cmd[i + 1];
    if (here) {
      cur += c;
      if (c === "\n" && cmd.startsWith(here, i + 1)) {
        cur += here;
        i += here.length;
        here = "";
      }
      continue;
    }
    if (quote) {
      if (c === "`" && quote === '"') {
        cur += c + (next ?? "");
        i++;
        continue;
      }
      cur += c;
      // A doubled quote is one quote inside the string ('it''s', "say ""hi""").
      if (c === quote) {
        if (next === quote) {
          cur += next;
          i++;
        } else quote = "";
      }
      continue;
    }
    if (c === "@" && (next === "'" || next === '"') && /^\r?\n/.test(cmd.slice(i + 2))) {
      here = `${next}@`;
      cur += c + next;
      i++;
      continue;
    }
    if (c === "`") {
      // A backtick escapes the next character; at a line end it continues the line.
      const nl = /^\r?\n/.exec(cmd.slice(i + 1));
      if (nl) {
        cur += " ";
        i += nl[0].length;
      } else {
        cur += c + (next ?? "");
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "<" && next === "#") {
      const end = cmd.indexOf("#>", i + 2);
      i = end < 0 ? cmd.length : end + 1;
      cur += " ";
      continue;
    }
    if (c === "#" && (cur === "" || /\s$/.test(cur))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "$" && next === "{") {
      const end = cmd.indexOf("}", i + 2);
      cur += cmd.slice(i, end < 0 ? cmd.length : end + 1);
      i = end < 0 ? cmd.length : end;
      continue;
    }
    // Parentheses, $( ), @( ) and a hashtable's @{ } hold an expression, not statements of the line.
    if (c === "(" || (c === "@" && next === "{") || (c === "{" && nest.length)) {
      nest.push(c === "(" ? ")" : "}");
      cur += c === "@" ? "@{" : c;
      if (c === "@") i++;
      continue;
    }
    if (nest.length) {
      if (c === nest[nest.length - 1]) nest.pop();
      cur += c;
      continue;
    }
    // A script block's statements run too (`ForEach-Object { npm test }`, `if (…) { … }`).
    if (c === "{" || c === "}" || c === "\n" || c === "\r" || c === ";") {
      push(false);
      continue;
    }
    if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
      i++;
      push(false);
      continue;
    }
    if (c === "|") {
      push(true);
      continue;
    }
    cur += c;
  }
  push(false);
  return out;
}

/** Words of one PowerShell statement, quotes kept with the word they belong to. */
const psWords = (text: string): string[] => text.match(/(?:[^\s"'`]+|`[\s\S]?|"(?:`[\s\S]|""|[^"`])*"?|'(?:''|[^'])*'?)+/g) ?? [];

/** One PowerShell statement's program and arguments, or undefined for a header, an expression or an empty statement. */
function psPartOf(text: string): ShellPart | undefined {
  let w = psWords(text);
  // `& $exe`, `& "C:\x\tool.exe"`: the call operator runs what follows, a value included.
  let called = false;
  for (;;) {
    const x = w[0];
    if (x === undefined) return undefined;
    const lower = x.toLowerCase();
    if (PS_HEADERS.has(lower)) return undefined;
    if (PS_SKIP.has(lower)) {
      if (lower === "&" || lower === ".") called = true;
      w = w.slice(1);
    }
    // `$out = npm test`, `$env:CI = 1`: the command is what comes after the assignment.
    else if (/^\$[\w:?]+$/.test(x) && /^(?:[-+*/%]|\?\?)?=$/.test(w[1] ?? "")) w = w.slice(2);
    else if (/^\$[\w:]+[-+*/%]?=(?!=)/.test(x)) {
      const rest = x.replace(/^\$[\w:]+[-+*/%]?=/, "");
      w = rest ? [rest, ...w.slice(1)] : w.slice(1);
    } else break;
  }
  const argv: string[] = [];
  for (let i = 0; i < w.length; i++) {
    const x = w[i]!;
    const r = PS_REDIRECT.exec(x);
    if (r) {
      if (r[0].length === x.length && !x.includes("&")) i++;
      continue;
    }
    argv.push(x);
  }
  if (!argv.length) return undefined;
  // A statement that is a value (`$_`, `$out`, `"text"`, `(1 + 2)`) prints it and runs nothing.
  if (!called && /^[$(@['"-]|^\d/.test(argv[0]!)) return undefined;
  const raw = unquote(argv[0]!);
  const base = raw.split(/[\\/]/).filter(Boolean).pop() ?? raw;
  // A variable, a string, a number or a sub-expression is a value, not a program.
  const prog = /^[$(@[-]|^\d/.test(raw) || !PROG.test(base) ? undefined : base;
  return { argv, prog, last: false, timed: false, ps: true };
}

/** The statements of a PowerShell script that run a program. The last of a pipeline is its last part that is not a pipeline cmdlet. */
function powerShellParts(script: string): ShellPart[] {
  const out: ShellPart[] = [];
  let pipeline: ShellPart[] = [];
  const close = () => {
    const end = pipeline.findLast((p) => !isPipe(p)) ?? pipeline.at(-1);
    if (end) end.last = true;
    out.push(...pipeline);
    pipeline = [];
  };
  for (const s of splitPowerShell(script)) {
    const p = psPartOf(s.text);
    if (p) pipeline.push(p);
    if (!s.pipe) close();
  }
  close();
  return out;
}

/**
 * Every part of `cmd` that runs a program (headers, keywords and empty parts dropped), in order.
 * `shell` is the shell that ran it: PowerShell for a PowerShell tool. A PowerShell launcher
 * (`powershell -Command …`, `pwsh -c …`) is dropped and its script parsed as PowerShell, whatever ran it.
 */
export function shellParts(cmd: string, shell: Shell = "sh"): ShellPart[] {
  const script = launchedCommand(cmd);
  if (shell === "powershell" || script !== cmd) return powerShellParts(script);
  return splitParts(cmd).flatMap((p) => {
    // `cd x && powershell -Command "npm test"`: the launcher's script, as PowerShell.
    const inner = launchedCommand(p.text);
    if (inner !== p.text) return powerShellParts(inner);
    const part = partOf(p.text, p.last);
    return part ? [part] : [];
  });
}

/** Shell plumbing: a builtin, a setup step, a file tool or a PowerShell pipeline cmdlet. It never runs a test suite, whatever its output holds. */
export const isPlumbing = (prog: string | undefined): boolean => prog !== undefined && (SETUP.has(prog) || SELF_NAMING.has(prog) || PS_SETUP.has(prog.toLowerCase()) || PS_PIPE.has(prog.toLowerCase()));

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where the output last names `prog` as the one complaining (-1: never). `ps`: PowerShell's error records name it too. */
function namedAt(prog: string, output: string, ps = false): number {
  const p = escape(prog);
  // `cat: x`, `/usr/bin/find: x`, bash's `bash: line 1: cd: x`, zsh's `(eval):cd:1: x`, sh's `foo: not found`.
  const re = new RegExp(`(?:^|\\n)[^\\S\\n]*(?:[\\w.~-]*\\/)*${p}(?:\\[\\d+\\])?: |: ${p}: |:${p}:\\d+: |\\b${p}: (?:command )?not found|command not found: ${p}(?![\\w.-])`, "g");
  let at = -1;
  for (const m of output.matchAll(re)) {
    // `bash: -c: line 3: …`, `bash: eval: line 1: …`: the shell that ran the line, not a `bash x.sh` part.
    if (SHELLS.has(prog) && /^(?:-c|eval|line \d+):/.test(output.slice(m.index + m[0].length))) continue;
    at = m.index;
  }
  if (ps) {
    // `Get-ChildItem : Cannot find path …` (5.1), `[Get-ChildItem], ItemNotFoundException`, `The term 'foo' is not recognized`.
    const psRe = new RegExp(`(?:^|\\n)[^\\S\\n]*${p}[^\\S\\n]+: |\\[${p}\\], |The term '(?:[^'\\n]*[\\\\/])?${p}' is not recognized`, "gi");
    for (const m of output.matchAll(psRe)) at = Math.max(at, m.index);
  }
  return at;
}

/** POSIX shells: their own messages (`bash: -c: line 3: …`) speak for the line that ran, not for a part. */
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** The shell could not parse the line, so no part of it ran. */
const PARSE_ERROR = /^[^\S\n]*(?:[\w.~-]*\/)*(?:ba|z|da|k)?sh: (?:-c: |eval: )?line \d+: (?:unexpected EOF while looking for matching|syntax error)/m;
/** The command was refused before it ran: a removal check's denial. */
const REMOVAL_DENIED = /removal safety check denied this command/i;
/** Programs that remove files: what a removal check refuses. */
const REMOVERS = /^(?:rm|rmdir|unlink|shred|del|erase|rd|remove-item|ri)$/i;
/** A stored command cut short (`…` at its end): the parts after the cut are not seen. */
const isCut = (cmd: string): boolean => /…\s*$/.test(cmd);

/** A line that reads as an error: a strong word first (`error`, `fatal`, `TypeError`), else a weaker one (`cannot`, `not found`). */
const STRONG_ERROR = /\b(?:[Ee]rror|ERROR|[Ff]atal|FATAL|[Ee]xception|Traceback|panic)\b|[a-z](?:Error|Exception)\b/;
const WEAK_ERROR = /cannot|not found|failed|no such|denied|missing|invalid|unknown|not recognized/i;
export const errorLine = (lines: readonly string[]): string | undefined => lines.find((l) => STRONG_ERROR.test(l)) ?? lines.find((l) => WEAK_ERROR.test(l));

/**
 * A line of source code (bash's `Terminated` job report echoes the command it stopped, a script prints
 * its own lines): a declaration, an assignment, a call statement (`console.log(…)`), or a line ending in
 * `;` or `) {`, or a `//` comment. Code, not a message, whatever words it holds.
 */
const CODE_LINE = /^(?:\/\/|\/\*|(?:const|let|var)\s+[\w${[]|function\b|import\s|export\s|return\s|(?:if|for|while)\s*\()|^[A-Za-z_$][\w$.]*\s*=[^=]|^[A-Za-z_$][\w$.]*\(.*\);?$|;$|\)\s*\{$/;
/** An error word anywhere in a line, as `improve` samples read them. */
const ERROR_WORD = /error|cannot|not found|failed|no such|denied|missing|invalid|unknown/i;
/** Prefixes of status lines (`exit: 0`, `status: ok`) rather than a program's message. */
const STATUS_PREFIX = /^(?:exit|status|code|rc|result|done|ok)$/i;

/**
 * The line of a failed command's output that reads as its error, for a failure sample: the first
 * line with an error word, else the first line a program prefixed with its name (`which: no x in …`).
 * A JSON record, a line of source code, a status line (`exit: 0`) and an all-caps notice from another
 * program (taskkill's `SUCCESS: …`) are output, not the error. Undefined when no line qualifies.
 */
export function failureSampleLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^[[{]["{[]/.test(l) && !CODE_LINE.test(l));
  return (
    lines.find((l) => ERROR_WORD.test(l)) ??
    lines.find((l) => {
      const m = /^([\w.-]+): (\S.*)$/.exec(l);
      // A message is a phrase (`no codingsh in PATH`): a one- or two-word value (`owner: someone`, `exit: 0`) is a field.
      return !!m && /[a-z]/.test(m[1]!) && !STATUS_PREFIX.test(m[1]!) && m[2]!.trim().split(/\s+/).length >= 3;
    })
  );
}

/** The exit status: the event's, or the "Exit code N" line Claude Code puts first. */
export function exitCodeOf(exitCode: unknown, output: string | undefined): number | undefined {
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) return exitCode;
  const m = /^(?:Error: )?Exit code (\d+)\b/.exec(output?.trimStart() ?? "");
  return m ? Number(m[1]) : undefined;
}

/** The one part in `parts` whose program is among them, by distinct program+arguments; undefined when none or several. */
function only(parts: readonly ShellPart[]): ShellPart | undefined {
  const distinct = new Map(parts.map((p) => [p.argv.join(" "), p]));
  return distinct.size === 1 ? [...distinct.values()][0] : undefined;
}

/**
 * The part of `cmd` that failed, from its output and exit status, or undefined
 * when the evidence does not single one out (or the part's program is not a
 * plain word). A single command is its own part.
 */
export function failingPart(cmd: string, o: { output?: string; exitCode?: number; shell?: Shell } = {}): ShellPart | undefined {
  const parts = shellParts(cmd, o.shell);
  const output = (o.output ?? "").replace(/^\s*(?:Error: )?Exit code \d+[^\n]*\n?/, "");
  // Nothing ran: the shell could not parse the line, or a removal check refused it (then the removal is the part).
  if (o.shell !== "powershell" && PARSE_ERROR.test(output)) return undefined;
  if (REMOVAL_DENIED.test(output)) {
    const hit = only(parts.filter((p) => p.prog && REMOVERS.test(p.prog)));
    return hit?.prog ? hit : undefined;
  }
  // A cut command hides parts: only evidence that names a part counts, never elimination.
  const cut = isCut(cmd);
  if (parts.length <= 1 && !cut) return parts[0]?.prog ? parts[0] : undefined;
  const exit = o.exitCode ?? exitCodeOf(undefined, o.output);
  const pick = (p: ShellPart | undefined) => (p?.prog ? p : undefined);
  // 1. The part the error names, the last one named when several are.
  let named: ShellPart | undefined;
  let at = -1;
  for (const p of parts) {
    if (!p.prog) continue;
    const k = namedAt(p.prog, output, p.ps);
    if (k > at || (k === at && k >= 0)) [named, at] = [p, k];
  }
  if (named) return named;
  // A pipeline cmdlet only passes on what the part before it printed: never the fallback.
  const real = parts.filter((p) => !isSetup(p) && !isPipe(p));
  // 2. A known tool's error signature, when one part runs that tool.
  for (const [sig, progs] of SIGNATURES) {
    if (!sig.test(output)) continue;
    const hit = only(real.filter((p) => p.prog && progs.test(p.prog)));
    if (hit) return pick(hit);
  }
  // 3. timeout exits 124 when it stops the command it runs.
  if (exit === 124) {
    const hit = only(parts.filter((p) => p.timed));
    if (hit) return pick(hit);
  }
  if (cut) return undefined;
  // 4. One part runs a program; or, with none, one setup step does (`cd missing`).
  if (real.length === 1) return pick(real[0]);
  if (!real.length) return pick(only(parts.filter((p) => !isPipe(p))));
  // 5. A pipeline returns its last part's status, and a self-naming tool the error doesn't name did not fail.
  const failable = (p: ShellPart) => !p.prog || !SELF_NAMING.has(p.prog) || p.quiet === true || (SILENT_ON_1.has(p.prog) && (exit === undefined || exit === 1) && !output.trim());
  const finals = real.filter((p) => p.last && failable(p));
  if (finals.length) return pick(only(finals));
  return pick(only(real.filter(failable)));
}

/**
 * The output of `cmd` that belongs to `part`, the part that failed: all of it
 * when every other part is a setup step (`cd x && npm test`), else the line
 * that names the part (`ls: cannot access …`, `which: no vercel in …`), else
 * the first line of a known tool's error signature that the part runs, else
 * the first error line once the lines that name another part are removed.
 * Undefined when none is left: another part's error (a curl line before a
 * failing `which`) is not this part's.
 */
export function partOutput(cmd: string, part: ShellPart, output: string | undefined, shell?: Shell): string | undefined {
  if (!output?.trim()) return undefined;
  const parts = shellParts(cmd, shell);
  const text = output.replace(/^\s*(?:Error: )?Exit code \d+[^\n]*\n?/, "");
  // A part that prints nothing when it works, and that the output doesn't name, printed nothing.
  // A pipeline cmdlet passes on the output of the part before it.
  const quiet = (p: ShellPart) => isSetup(p) || isPipe(p) || (QUIET.has(p.prog ?? "") && namedAt(p.prog!, text) < 0);
  if (parts.length <= 1 || parts.every((p) => p === part || p.argv.join(" ") === part.argv.join(" ") || quiet(p))) return output;
  if (!part.prog) return undefined;
  const at = namedAt(part.prog, text, part.ps);
  if (at >= 0) {
    const from = text[at] === "\n" ? at + 1 : at;
    const start = text.lastIndexOf("\n", from - 1) + 1;
    const end = text.indexOf("\n", from);
    const line = text.slice(start, end < 0 ? text.length : end).trim();
    // `which` names the whole PATH it searched: the PATH is not the error.
    return line.replace(/^(which: no \S+ in )\(.*$/, "$1PATH");
  }
  for (const [sig, progs] of SIGNATURES) {
    if (!progs.test(part.prog)) continue;
    const lines = text.split("\n").filter((l) => sig.test(l));
    const line = lines.find((l) => /error|exception/i.test(l)) ?? lines[0];
    if (line?.trim()) return line.trim();
  }
  // No line names the part: the first error line no other part's name claims (`ls dist && node x.mjs`: node's error, not a file name ls listed).
  const same = (p: ShellPart) => p === part || p.argv.join(" ") === part.argv.join(" ");
  const others = parts.filter((p) => !same(p) && p.prog);
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !others.some((p) => namedAt(p.prog!, l, p.ps) >= 0));
  return errorLine(lines);
}
