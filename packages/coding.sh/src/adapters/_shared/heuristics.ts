// Heuristics over tool calls: test-runner summaries from shell output, file
// changes from edit tools and apply_patch envelopes.

import { isVerifyCommand } from "../../core/sessions.ts";
import { stripHeredocs } from "../../core/shell-diff.ts";

export interface TestSummary {
  runner: string;
  passed: number;
  failed: number;
  skipped?: number;
}

// CSI codes (colors, cursor moves), and OSC strings (titles, links) ended by BEL or
// ESC \. An OSC string stops at the next ESC, so it can't run on to a later BEL.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

/** Commands that (probably) run a test suite. */
export const TEST_COMMAND_RE =
  /(?:^|[\s;&|(/])(?:vitest|jest|pytest|py\.test|mocha|ava|tap|bun\s+test|deno\s+test|go\s+test|cargo\s+(?:test|nextest)|node\s+(?:[^|;&]*\s)?--test\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w:-]+)?\b|npx\s+(?:vitest|jest|mocha)|python3?\s+-m\s+(?:pytest|unittest)|make\s+test|tox\b|rspec|phpunit|dotnet\s+test|mvn\s+(?:-\S+\s+)*test|gradle\w*\s+test)/;

export function isTestCommand(cmd: string | undefined): boolean {
  return !!cmd && TEST_COMMAND_RE.test(cmd);
}

/** Runner shapes isVerifyCommand leaves out: cargo nextest, and a package manager's options or workspace before `test`. */
const RUNS_TESTS_EXTRA = /\bcargo\s+nextest\b|\b(?:npm|pnpm|yarn|bun)\s+(?:\S+\s+)*?(?:run\s+)?test(?::[\w:-]+)?(?=\s|$)|\b(?:turbo|nx|lerna)\s+(?:run\s+)?test\b/i;
/** Commands that print, list or search text: a stage they start runs nothing, whatever its arguments name. */
const READERS = new Set(["cat", "tac", "head", "tail", "less", "more", "bat", "nl", "strings", "grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "cut", "sort", "uniq", "wc", "jq", "echo", "printf", "ls", "dir", "type", "gc", "get-content", "select-string", "sls", "findstr", "write-output", "write-host"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
/** Shell keywords that open a compound command: the stage is judged by the command after them (`until grep …; do sleep 15; done`). */
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "while", "until", "do", "done", "!", "{", "}"]);
/** A log or text file a command reads or writes: its name (`ci-tsc.log`) names no command. */
const LOG_FILE = /\.(?:log|txt|out|err)$/i;
/** A shell that runs a heredoc's body as commands (`bash <<EOF`): its body is not data. */
const SHELL_HEREDOC = /(?:^|[\s;&|(])(?:bash|sh|zsh|dash|pwsh|powershell)(?:\.exe)?\b[^\n]*<<(?!<)/m;

/** A command split into its stages on |, &&, ||, ;, & and line breaks outside quotes. */
function shellStages(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | undefined;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (q) {
      cur += c;
      if (c === "\\" && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else if (c === q) q = undefined;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += c + cmd[++i]; // an escaped character, or a line continuation
    } else if (c === "|" || c === "&" || c === ";" || c === "\n" || c === "\r") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

interface Word {
  raw: string;
  value: string;
  quoted: boolean;
}

/** A stage's words: quoted strings as one word (unquoted in `value`), and where each starts. */
function stageWords(stage: string): (Word & { at: number })[] {
  const out: (Word & { at: number })[] = [];
  for (const m of stage.matchAll(/"((?:[^"\\]|\\.)*)"?|'([^']*)'?|[^\s"']+/g)) {
    const quoted = m[1] !== undefined || m[2] !== undefined;
    out.push({ raw: m[0], value: quoted ? (m[1] ?? m[2])! : m[0], quoted, at: m.index });
  }
  return out;
}

const exeName = (w: string): string => w.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "");

/**
 * Whether one stage runs tests or checks: past env assignments, cd, time and timeout <n>, a shell
 * launcher (powershell/pwsh -Command, bash/sh -c, cmd /c) is judged by the command it runs; a
 * stage that starts with a reader (cat, tail, grep, Get-Content, …) runs nothing; else the stage,
 * its quoted strings removed, must name a test or check command.
 */
function stageRunsTests(stage: string, depth: number): boolean {
  const s = stage.replace(/^[({!\s]+/, "");
  const words = stageWords(s);
  let i = 0;
  for (;;) {
    const w = words[i];
    if (!w || w.quoted) break;
    const name = w.value.toLowerCase();
    if (ENV_ASSIGN.test(w.value) || name === "env" || name === "time" || KEYWORDS.has(name)) i++;
    else if (name === "cd" || name === "pushd" || name === "set-location" || name === "sl") i += 2;
    else if (name === "timeout") {
      i++;
      while (words[i] && /^-/.test(words[i]!.value)) i++;
      if (words[i] && DURATION.test(words[i]!.value)) i++;
    } else break;
  }
  const first = words[i];
  if (!first) return false;
  const rest = words.slice(i + 1);
  const name = exeName(first.value);
  // The launcher's command: a quoted last word as its text, else the stage from that word on.
  const argAfter = (flag: RegExp): string | undefined => {
    const k = rest.findIndex((w) => !w.quoted && flag.test(w.value));
    const next = k < 0 ? undefined : rest[k + 1];
    if (!next) return undefined;
    return next.quoted && k + 2 === rest.length ? next.value : s.slice(next.at);
  };
  if (depth < 4 && (name === "powershell" || name === "pwsh")) {
    const arg = argAfter(/^[-/](?:c|command)$/i);
    if (arg !== undefined) return runsTestsAt(arg, depth + 1);
  } else if (depth < 4 && (name === "bash" || name === "sh" || name === "zsh" || name === "dash")) {
    // A flag word that holds `c` (`-c`, `-lc`). The letters before its first `c` are not `c`, so the time is linear.
    const k = rest.findIndex((w) => !w.quoted && /^-[abd-z]*c[a-z]*$/.test(w.value));
    if (k >= 0 && rest[k + 1]) return runsTestsAt(rest[k + 1]!.value, depth + 1);
  } else if (depth < 4 && name === "cmd") {
    const arg = argAfter(/^\/[ck]$/i);
    if (arg !== undefined) return runsTestsAt(arg, depth + 1);
  }
  if (READERS.has(name)) return false;
  const bare = words.slice(i).filter((w, k) => !w.quoted && (k === 0 || !LOG_FILE.test(w.value))).map((w) => w.raw).join(" ");
  return isVerifyCommand(bare) || RUNS_TESTS_EXTRA.test(bare);
}

const runsTestsAt = (cmd: string, depth: number): boolean => shellStages(cmd).some((st) => stageRunsTests(st, depth));

/**
 * Whether a shell command runs tests or checks, so its output can carry a test result: some
 * stage of it (split on |, &&, ||, ; and line breaks outside quotes) does, by isVerifyCommand.
 * `tail -50 ci.log`, `grep -n "test result" log` and `Get-Content test.log` run none;
 * `npm test 2>&1 | tail -40` and `powershell -Command "npm test"` do. A heredoc's body is data
 * (`python3 - <<'EOF' … EOF`, even one cut off before its end), unless a shell reads it.
 */
export function runsTests(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return runsTestsAt(SHELL_HEREDOC.test(cmd) ? cmd : stripHeredocs(cmd), 0);
}

// ------------------------------------------------- shell calls that change no files here

/** Programs that write no file in the working tree (a redirect aside): readers, and shell built-ins. */
const QUIET = new Set([...READERS, "pwd", "true", "false", "test", "[", "export", "set", "unset", "which", "where", "date", "sleep", "mkdir", "cd", "pushd", "popd", "exit", "whoami", "hostname", "uname"]);
/** git subcommands that leave the working tree as it is. */
const GIT_READS = new Set(["status", "log", "diff", "show", "fetch", "rev-parse", "merge-base", "ls-files", "ls-remote", "ls-tree", "blame", "describe", "shortlog", "grep", "remote", "config", "rev-list", "cat-file", "for-each-ref", "show-ref", "reflog", "version", "help", "branch"]);
/** gh commands that read: `gh auth token`, `gh run view`, `gh pr view 12`. */
const GH_READ = /^(?:auth|run|api|status|search|(?:pr|issue|repo|release)\s+(?:view|list|checks|diff|status))\b/;
const QUIET_TARGET = /^(?:\/dev\/null|nul|\$null|&\d)$/i;

/** A stage's shell words: quoted and unquoted parts written together (`a='b c'`) are one word. */
function shellWords(stage: string): Word[] {
  const out: (Word & { end: number })[] = [];
  for (const w of stageWords(stage)) {
    const prev = out[out.length - 1];
    if (prev && prev.end === w.at) {
      prev.raw += w.raw;
      prev.value += w.value;
      prev.quoted ||= w.quoted;
      prev.end += w.raw.length;
    } else out.push({ raw: w.raw, value: w.value, quoted: w.quoted, end: w.at + w.raw.length });
  }
  return out;
}

/** Whether one stage writes no file: no redirect to a file, and a quiet program (or a shell running quiet stages). */
function stageQuiet(stage: string, depth: number): boolean {
  const words = shellWords(stage.replace(/^[({!\s]+/, ""));
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    const r = w.quoted ? null : /^\d*>>?(.*)$/.exec(w.value);
    if (r && !QUIET_TARGET.test(r[1] || words[k + 1]?.value || "")) return false;
  }
  let i = 0;
  for (;;) {
    const w = words[i];
    if (!w || w.quoted) break;
    const name = w.value.toLowerCase();
    if (ENV_ASSIGN.test(w.value) || name === "env" || name === "time" || KEYWORDS.has(name)) i++;
    else if (name === "timeout") {
      i++;
      while (words[i] && /^-/.test(words[i]!.value)) i++;
      if (words[i] && DURATION.test(words[i]!.value)) i++;
    } else break;
  }
  const first = words[i];
  if (!first) return true;
  const name = exeName(first.value);
  const args = words.slice(i + 1).map((w) => w.value);
  if (name === "bash" || name === "sh" || name === "zsh" || name === "dash") {
    // A flag word that holds `c` (`-c`, `-lc`). The letters before its first `c` are not `c`, so the time is linear.
    const k = args.findIndex((a) => /^-[abd-z]*c[a-z]*$/.test(a));
    return depth < 4 && k >= 0 && args[k + 1] !== undefined && quietAt(args[k + 1]!, depth + 1);
  }
  if (name === "git") {
    let k = 0;
    while (args[k] !== undefined && args[k]!.startsWith("-")) k += args[k] === "-c" || args[k] === "-C" ? 2 : 1;
    return GIT_READS.has(args[k] ?? "");
  }
  if (name === "gh") return GH_READ.test(args.join(" "));
  if (name === "sed") return !args.some((a) => /^-[a-z]*i|^--in-place/.test(a));
  return QUIET.has(name);
}

// A redirection to a descriptor (`2>&1`, `>&2`) becomes a space, and `&>` or `>&` becomes `>`. The
// descriptor before `>&` is read from its first digit, `(?<!\d)`, so the time is linear.
const quietAt = (cmd: string, depth: number): boolean =>
  shellStages(stripHeredocs(cmd).replace(/(?<!\d)\d+>&\d+|>&\d+|&>|>&/g, (m) => (m === "&>" || m === ">&" ? ">" : " "))).every((st) => stageQuiet(st, depth));

/**
 * Whether a shell command writes no file: every stage runs a program that only reads, waits or
 * prints (cat, grep, git status, git fetch, gh auth token, mkdir, sleep, …) and redirects nowhere
 * but /dev/null. A file a dirty-tree diff shows changed after such a command was changed by
 * another process. Unknown programs count as writers.
 */
export function writesNothing(cmd: string): boolean {
  return quietAt(cmd, 0);
}

/** A directory as one form: forward slashes, no trailing slash, Git Bash's /c/… as c:/…, a drive path lower-cased. */
function dirKey(p: string): string {
  // The trailing slashes are matched from the first one, `(?<!\/)`, so the time is linear.
  let s = p.replace(/\\/g, "/").replace(/(?<!\/)\/+$/, "");
  const m = /^\/([a-zA-Z])(?=\/|$)/.exec(s);
  if (m) s = `${m[1]}:${s.slice(2)}`;
  return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
}

/**
 * Whether a shell command runs in another directory than `cwd`: its first stage is `cd` to an
 * absolute path outside `cwd`, and every later `cd` is relative (`cd /d/other/pkg && npm test`).
 */
export function runsElsewhere(cmd: string, cwd: string | undefined): boolean {
  if (!cwd) return false;
  const here = dirKey(cwd);
  let first = true;
  for (const st of shellStages(stripHeredocs(cmd))) {
    const words = shellWords(st.replace(/^[({\s]+/, ""));
    const name = words[0]?.value.toLowerCase();
    const isCd = name === "cd" || name === "pushd" || name === "set-location" || name === "sl";
    if (!isCd) {
      if (first) return false;
      continue;
    }
    const to = words.find((w, k) => k > 0 && !w.value.startsWith("-"))?.value;
    if (!to || to.includes("$") || to === "-" || to.startsWith("~")) return false;
    const abs = /^(?:\/|[a-zA-Z]:[\\/])/.test(to);
    if (first && !abs) return false;
    if (abs) {
      const there = dirKey(to);
      if (there === here || there.startsWith(`${here}/`)) return false;
    }
    first = false;
  }
  return !first;
}

const n = (s: string | undefined) => (s ? Number.parseInt(s, 10) : 0);

/**
 * The count in the first match of `re`, for a field within one summary line. A count pattern starts
 * at the first digit of a number, `(?<!\d)`, so each number is read once and the time is linear.
 */
function pick(text: string, re: RegExp): number | undefined {
  const m = re.exec(text);
  return m ? n(m[1]) : undefined;
}

/**
 * The last match of a global `re`: a rerun or a watch mode prints a summary per
 * run, and the last one is the outcome. The line patterns use [ \t], not \s, so a
 * match can't run past its line: \s after ^ makes a long run of blank lines quadratic.
 */
function lastMatch(text: string, re: RegExp): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m;
  return last;
}

const lastCount = (text: string, re: RegExp): number | undefined => {
  const m = lastMatch(text, re);
  return m ? n(m[1]) : undefined;
};

/**
 * Whether a line holds a pytest summary: a count ("2 passed", "1 error"), then
 * "in 0.12s" with no line break between them. It looks for the time after the first
 * count: one regex with .* between the two retries from every count, which is
 * quadratic on a long line of counts.
 */
function isPytestSummary(line: string): boolean {
  return line.split(/[\r\u2028\u2029]/).some((part) => {
    // The summary starts its line, after any "=" rule: a count inside other text (an assertion
    // message, a diff line) is not one.
    if (!/^[ \t]*(?:=+[ \t]*)?\d+ [a-z]/.test(part)) return false;
    const m = /\b\d+ (?:passed|failed|error|errors)\b/.exec(part);
    return !!m && /\bin [\d.]+s\b/.test(part.slice(m.index + m[0].length));
  });
}

type Parser = (t: string) => TestSummary | undefined;

const PARSERS: Parser[] = [
  // cargo: "test result: ok. 10 passed; 0 failed; 1 ignored; …" (one per crate/binary → sum)
  (t) => {
    const re = /^[ \t]*test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm;
    let m: RegExpExecArray | null;
    let hit = false;
    const s = { runner: "cargo", passed: 0, failed: 0, skipped: 0 };
    while ((m = re.exec(t))) {
      hit = true;
      s.passed += n(m[1]);
      s.failed += n(m[2]);
      s.skipped += n(m[3]);
    }
    return hit ? s : undefined;
  },
  // jest: "Tests:       1 failed, 2 skipped, 10 passed, 13 total". The counts start at the first
  // non-space character after "Tests:" and end at " total" after a digit, so the time is linear.
  (t) => {
    const m = lastMatch(t, /^[ \t]*Tests:[ \t]+(?![ \t])(.*\d total)[ \t]*$/gm);
    if (!m) return undefined;
    const l = m[1]!;
    return { runner: "jest", passed: pick(l, /(?<!\d)(\d+) passed/) ?? 0, failed: pick(l, /(?<!\d)(\d+) failed/) ?? 0, skipped: (pick(l, /(?<!\d)(\d+) skipped/) ?? 0) + (pick(l, /(?<!\d)(\d+) todo/) ?? 0) };
  },
  // vitest: " Tests  3 failed | 12 passed | 1 skipped (16)". The counts start at the first non-space
  // character after "Tests", so the time is linear.
  (t) => {
    const m = lastMatch(t, /^[ \t]*Tests[ \t]{2,}(?![ \t])(.*\(\d+\))[ \t]*$/gm);
    if (!m) return undefined;
    const l = m[1]!;
    return { runner: "vitest", passed: pick(l, /(?<!\d)(\d+) passed/) ?? 0, failed: pick(l, /(?<!\d)(\d+) failed/) ?? 0, skipped: (pick(l, /(?<!\d)(\d+) skipped/) ?? 0) + (pick(l, /(?<!\d)(\d+) todo/) ?? 0) };
  },
  // pytest: "==== 2 failed, 10 passed, 1 skipped, 1 error in 0.12s ====" or "10 passed in 0.50s"
  (t) => {
    const lines = t.split("\n").filter(isPytestSummary);
    const l = lines[lines.length - 1];
    if (!l) return undefined;
    return {
      runner: "pytest",
      passed: pick(l, /(?<!\d)(\d+) passed/) ?? 0,
      failed: (pick(l, /(?<!\d)(\d+) failed/) ?? 0) + (pick(l, /(?<!\d)(\d+) errors?/) ?? 0),
      skipped: (pick(l, /(?<!\d)(\d+) skipped/) ?? 0) + (pick(l, /(?<!\d)(\d+) xfailed/) ?? 0),
    };
  },
  // node:test: TAP "# pass 10 / # fail 0 / # skipped 1" or spec "ℹ pass 10", read from the last pass line on
  (t) => {
    const pass = lastMatch(t, /^[#ℹ][ \t]*pass (\d+)[ \t]*$/gm);
    const rest = pass ? t.slice(pass.index) : t;
    const fail = lastCount(rest, /^[#ℹ][ \t]*fail (\d+)[ \t]*$/gm);
    if (!pass && fail === undefined) return undefined;
    return { runner: "node:test", passed: pass ? n(pass[1]) : 0, failed: fail ?? 0, skipped: (lastCount(rest, /^[#ℹ][ \t]*skipped (\d+)[ \t]*$/gm) ?? 0) + (lastCount(rest, /^[#ℹ][ \t]*todo (\d+)[ \t]*$/gm) ?? 0) };
  },
  // mocha: "10 passing (20ms)", then "1 pending" and "2 failing" when there are any, read from the last passing line on
  (t) => {
    const pass = lastMatch(t, /^[ \t]*(\d+) passing\b/gm);
    if (!pass) return undefined;
    const rest = t.slice(pass.index);
    return { runner: "mocha", passed: n(pass[1]), failed: pick(rest, /^[ \t]*(\d+) failing\b/m) ?? 0, skipped: pick(rest, /^[ \t]*(\d+) pending\b/m) ?? 0 };
  },
  // go test -v: "--- PASS: TestX", "--- FAIL: TestY", "--- SKIP:"; else package lines "ok  pkg" / "FAIL pkg"
  (t) => {
    const pass = (t.match(/^[ \t]*--- PASS: /gm) ?? []).length;
    const fail = (t.match(/^[ \t]*--- FAIL: /gm) ?? []).length;
    const skip = (t.match(/^[ \t]*--- SKIP: /gm) ?? []).length;
    if (pass + fail + skip > 0) return { runner: "go", passed: pass, failed: fail, skipped: skip };
    const okPk = (t.match(/^ok[ \t]+\S+[ \t]+(?:[\d.]+s|\(cached\))/gm) ?? []).length;
    const failPk = (t.match(/^FAIL[ \t]+\S+[ \t]+[\d.]+s/gm) ?? []).length;
    if (okPk + failPk > 0) return { runner: "go", passed: okPk, failed: failPk };
    return undefined;
  },
];

/** The runner a command names, by the summary it prints: its own summary outranks other runners' text in the output. */
const COMMAND_RUNNERS: [string, RegExp][] = [
  ["cargo", /\bcargo\s+(?:\S+\s+)*?(?:test|nextest)\b/],
  ["jest", /\bjest\b/],
  ["vitest", /\bvitest\b/],
  ["pytest", /\bpy\.?test\b/],
  ["node:test", /\bnode\s+(?:\S+\s+)*?--test\b/],
  ["mocha", /\bmocha\b/],
  ["go", /\bgo\s+(?:\S+\s+)*?test\b/],
];

/** The runners a command names, outside heredoc bodies. */
function runnersNamed(command: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!command) return out;
  const c = stripHeredocs(command.length > 20_000 ? command.slice(0, 20_000) : command);
  for (const [runner, re] of COMMAND_RUNNERS) if (re.test(c)) out.add(runner);
  return out;
}

/**
 * Test summary from a shell command's output: the one parser every adapter uses.
 * A runner the command names goes first (`node --test` is read from node's own summary,
 * not from a pytest or cargo line a failing assertion or a printed fixture holds); then the
 * first runner whose summary appears wins, in the order above. Within a runner
 * the last summary counts, except cargo (sums its per-target lines) and go
 * (counts its per-test or per-package lines). Mocha and go summaries are weaker
 * signals: they count only when `testRun` says the output comes from a test run,
 * which by default is when `command` looks like one. A summary with nothing in
 * it is no summary, and skipped is absent when it is 0.
 */
export function parseTestOutput(output: string | undefined, command?: string, testRun = isTestCommand(command)): TestSummary | undefined {
  if (!output) return undefined;
  const t = stripAnsi(output.length > 200_000 ? output.slice(-200_000) : output);
  const named = runnersNamed(command);
  const accept = (s: TestSummary | undefined): s is TestSummary => {
    if (!s) return false;
    if (!testRun && !named.has(s.runner) && (s.runner === "mocha" || s.runner === "go")) return false; // weaker signals
    return s.passed + s.failed + (s.skipped ?? 0) > 0;
  };
  const parsers = named.size ? [...PARSERS.map((p) => (x: string) => { const s = p(x); return s && named.has(s.runner) ? s : undefined; }), ...PARSERS] : PARSERS;
  for (const p of parsers) {
    const s = p(t);
    if (!accept(s)) continue;
    if (s.skipped === 0) delete s.skipped;
    return s;
  }
  return undefined;
}

// ---------------------------------------------------------------- file changes

export interface FileChangeInfo {
  path: string;
  op: "add" | "modify" | "delete";
  additions?: number;
  deletions?: number;
  movedTo?: string;
  /** Unified diff of the change (with ---/+++ header), when the call carries enough to build one. */
  diff?: string;
}

function lines(s: string): string[] {
  if (s === "") return [];
  return s.replace(/\n$/, "").split("\n");
}

/** Added/removed line counts for replacing `before` with `after` (common prefix/suffix trimmed). */
export function editStats(before: string, after: string): { additions: number; deletions: number } {
  const a = lines(before);
  const b = lines(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  // Exact line diff (LCS) for the changed middle when small; prefix/suffix estimate otherwise.
  if (am.length * bm.length > 0 && am.length * bm.length <= 1_000_000) {
    let prev = new Uint32Array(bm.length + 1);
    for (let i = 1; i <= am.length; i++) {
      const cur = new Uint32Array(bm.length + 1);
      for (let j = 1; j <= bm.length; j++) cur[j] = am[i - 1] === bm[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
      prev = cur;
    }
    const common = prev[bm.length]!;
    return { additions: bm.length - common, deletions: am.length - common };
  }
  return { additions: bm.length, deletions: am.length };
}

/**
 * Parses an apply_patch envelope (Codex/OpenCode style):
 *   *** Begin Patch / *** Add File: p / *** Update File: p / *** Move to: q / *** Delete File: p / *** End Patch
 * Also accepts unified git diffs (diff --git a/x b/x … +/- lines).
 */
export function parsePatch(patch: string): FileChangeInfo[] {
  const out: FileChangeInfo[] = [];
  let cur: FileChangeInfo | undefined;
  const push = (c: FileChangeInfo) => {
    out.push(c);
    cur = c;
  };
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) push({ path: m[1]!.trim(), op: "add", additions: 0, deletions: 0 });
    else if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) push({ path: m[1]!.trim(), op: "modify", additions: 0, deletions: 0 });
    else if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) push({ path: m[1]!.trim(), op: "delete" });
    else if ((m = /^\*\*\* Move to: (.+)$/.exec(line)) && cur) cur.movedTo = m[1]!.trim();
    else if ((m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line))) push({ path: m[2]!, op: "modify", additions: 0, deletions: 0 });
    else if (/^new file mode/.test(line) && cur) cur.op = "add";
    else if (/^deleted file mode/.test(line) && cur) cur.op = "delete";
    else if (/^(\*\*\*|\+\+\+|---) /.test(line) || line.startsWith("@@")) continue;
    else if (cur && cur.op !== "delete" && line.startsWith("+")) cur.additions = (cur.additions ?? 0) + 1;
    else if (cur && cur.op !== "delete" && line.startsWith("-")) cur.deletions = (cur.deletions ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------- unified diffs

const CONTEXT = 3;
/** Above this many line pairs in the changed middle, the diff is a plain remove-all/add-all. */
const MAX_LCS_CELLS = 1_000_000;

/** `--- a/path` / `+++ b/path` header (/dev/null for adds and deletes). */
export function diffHeader(path: string, op: "add" | "modify" | "delete" = "modify"): string {
  return `--- ${op === "add" ? "/dev/null" : `a/${path}`}\n+++ ${op === "delete" ? "/dev/null" : `b/${path}`}\n`;
}

/** Line ops (" " keep, "-" remove, "+" add) turning `a` into `b`: common prefix/suffix, then LCS when small. */
function lineOps(a: string[], b: string[]): [string, string][] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const ops: [string, string][] = a.slice(0, p).map((l) => [" ", l]);
  if (am.length && bm.length && am.length * bm.length <= MAX_LCS_CELLS) {
    // LCS table, then walk it forward.
    const w = bm.length + 1;
    const t = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) for (let j = bm.length - 1; j >= 0; j--) t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < am.length && j < bm.length) {
      if (am[i] === bm[j]) {
        ops.push([" ", am[i]!]);
        i++;
        j++;
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) ops.push(["-", am[i++]!]);
      else ops.push(["+", bm[j++]!]);
    }
    while (i < am.length) ops.push(["-", am[i++]!]);
    while (j < bm.length) ops.push(["+", bm[j++]!]);
  } else {
    for (const l of am) ops.push(["-", l]);
    for (const l of bm) ops.push(["+", l]);
  }
  for (const l of a.slice(a.length - s)) ops.push([" ", l]);
  return ops;
}

/** Hunks of a unified diff (no file header) replacing `before` with `after`; `start` = 1-based line of `before` in its file. */
export function diffHunks(before: string, after: string, start = 1): string {
  const ops = lineOps(lines(before), lines(after));
  const out: string[] = [];
  let i = 0;
  let oldLine = start;
  let newLine = start;
  while (i < ops.length) {
    // Next change, with up to CONTEXT lines of context around each run of changes.
    let c = i;
    while (c < ops.length && ops[c]![0] === " ") c++;
    if (c === ops.length) break;
    const from = Math.max(i, c - CONTEXT);
    oldLine += from - i;
    newLine += from - i;
    let end = c;
    let lastChange = c;
    while (end < ops.length && end - lastChange <= 2 * CONTEXT) {
      if (ops[end]![0] !== " ") lastChange = end;
      end++;
    }
    const to = Math.min(ops.length, lastChange + 1 + CONTEXT);
    const body = ops.slice(from, to);
    const oldN = body.filter((o) => o[0] !== "+").length;
    const newN = body.filter((o) => o[0] !== "-").length;
    out.push(`@@ -${oldN ? oldLine : oldLine - 1},${oldN} +${newN ? newLine : newLine - 1},${newN} @@`, ...body.map(([k, l]) => k + l));
    oldLine += oldN;
    newLine += newN;
    i = to;
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/** Unified diff of one file (with ---/+++ header), or undefined when nothing changed. */
export function unifiedDiff(path: string, before: string, after: string, op: "add" | "modify" | "delete" = "modify"): string | undefined {
  const hunks = diffHunks(before, after);
  return hunks ? diffHeader(path, op) + hunks : undefined;
}

/** Claude Code's structuredPatch ([{oldStart, oldLines, newStart, newLines, lines}]) as a unified diff. */
export function structuredPatchDiff(path: string, patch: unknown, op: "add" | "modify" | "delete" = "modify"): string | undefined {
  if (!Array.isArray(patch) || !patch.length) return undefined;
  const out: string[] = [];
  for (const h of patch) {
    if (typeof h !== "object" || h === null) return undefined;
    const o = h as Record<string, unknown>;
    if (!Array.isArray(o.lines) || ![o.oldStart, o.oldLines, o.newStart, o.newLines].every((n) => typeof n === "number")) return undefined;
    out.push(`@@ -${o.oldStart},${o.oldLines} +${o.newStart},${o.newLines} @@`, ...o.lines.filter((l): l is string => typeof l === "string"));
  }
  return diffHeader(path, op) + out.join("\n") + "\n";
}

/**
 * Per-file unified diffs from an apply_patch envelope (*** Update File: … with
 * @@ hunks of " "/"-"/"+" lines) or a git diff (kept as is, split per file).
 */
export function patchDiffs(patch: string): Map<string, string> {
  const out = new Map<string, string>();
  let path: string | undefined;
  let buf: string[] = [];
  let git = false;
  const flush = () => {
    if (path !== undefined && buf.some((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))) out.set(path, `${buf.join("\n")}\n`);
    path = undefined;
    buf = [];
  };
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line))) {
      flush();
      git = false;
      path = m[2]!.trim();
      const op = m[1] === "Add" ? "add" : m[1] === "Delete" ? "delete" : "modify";
      buf = diffHeader(path, op).replace(/\n$/, "").split("\n");
    } else if ((m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line))) {
      flush();
      git = true;
      path = m[2]!;
      buf = [line];
    } else if (path === undefined || /^\*\*\* (End Patch|Begin Patch|Move to: )/.test(line) || line === "*** End of File") {
      continue;
    } else if (git || line.startsWith("@@") || /^[ +-]/.test(line)) {
      buf.push(line);
    }
  }
  flush();
  return out;
}
