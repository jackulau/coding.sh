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
//      when the error doesn't name them; grep, rg and diff exit 1 silently
//
// Keywords (for, do, done, if, then, …), variable assignments, redirects,
// flags and wrappers (sudo, env, nohup, timeout, xargs) are never the command.
// When the evidence leaves more than one part, there is no answer: improve
// says "compound command" instead of guessing. Pure.

export interface ShellPart {
  /** The words from the program on: keywords, assignments, redirects and wrappers dropped. */
  argv: string[];
  /** The program's base name, or undefined when it is not a plain word (`"$BIN"`). */
  prog: string | undefined;
  /** The last part of its pipeline: the one whose exit status the pipeline returns. */
  last: boolean;
  /** Run under `timeout`. */
  timed: boolean;
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
  for (let i = 0; i < w.length; i++) {
    const x = w[i]!;
    if (REDIRECT.test(x)) {
      if (REDIRECT.exec(x)![0].length === x.length) i++;
      continue;
    }
    argv.push(x);
  }
  if (!argv.length) return undefined;
  const raw = unquote(argv[0]!);
  const base = raw.split(/[\\/]/).filter(Boolean).pop() ?? raw;
  const prog = raw === "[" || raw === "[[" ? raw : !raw.startsWith("-") && !raw.startsWith("$") && PROG.test(base) ? base : undefined;
  return { argv, prog, last, timed };
}

/** Every part of `cmd` that runs a program (headers, keywords and empty parts dropped), in order. */
export function shellParts(cmd: string): ShellPart[] {
  return splitParts(cmd)
    .map((p) => partOf(p.text, p.last))
    .filter((p): p is ShellPart => p !== undefined);
}

/** Shell plumbing: a builtin, a setup step or a file tool. It never runs a test suite, whatever its output holds. */
export const isPlumbing = (prog: string | undefined): boolean => prog !== undefined && (SETUP.has(prog) || SELF_NAMING.has(prog));

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where the output last names `prog` as the one complaining (-1: never). */
function namedAt(prog: string, output: string): number {
  const p = escape(prog);
  // `cat: x`, `/usr/bin/find: x`, bash's `bash: line 1: cd: x`, zsh's `(eval):cd:1: x`, sh's `foo: not found`.
  const re = new RegExp(`(?:^|\\n)[^\\S\\n]*(?:[\\w.~-]*\\/)*${p}(?:\\[\\d+\\])?: |: ${p}: |:${p}:\\d+: |\\b${p}: (?:command )?not found|command not found: ${p}(?![\\w.-])`, "g");
  let at = -1;
  for (const m of output.matchAll(re)) at = m.index;
  return at;
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
export function failingPart(cmd: string, o: { output?: string; exitCode?: number } = {}): ShellPart | undefined {
  const parts = shellParts(cmd);
  if (parts.length <= 1) return parts[0]?.prog ? parts[0] : undefined;
  const output = (o.output ?? "").replace(/^\s*(?:Error: )?Exit code \d+[^\n]*\n?/, "");
  const exit = o.exitCode ?? exitCodeOf(undefined, o.output);
  const pick = (p: ShellPart | undefined) => (p?.prog ? p : undefined);
  // 1. The part the error names, the last one named when several are.
  let named: ShellPart | undefined;
  let at = -1;
  for (const p of parts) {
    if (!p.prog) continue;
    const k = namedAt(p.prog, output);
    if (k > at || (k === at && k >= 0)) [named, at] = [p, k];
  }
  if (named) return named;
  const real = parts.filter((p) => !SETUP.has(p.prog ?? ""));
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
  // 4. One part runs a program; or, with none, one setup step does (`cd missing`).
  if (real.length === 1) return pick(real[0]);
  if (!real.length) return pick(only(parts));
  // 5. A pipeline returns its last part's status, and a self-naming tool the error doesn't name did not fail.
  const failable = (p: ShellPart) => !p.prog || !SELF_NAMING.has(p.prog) || (SILENT_ON_1.has(p.prog) && (exit === undefined || exit === 1) && !output.trim());
  const finals = real.filter((p) => p.last && failable(p));
  if (finals.length) return pick(only(finals));
  return pick(only(real.filter(failable)));
}
