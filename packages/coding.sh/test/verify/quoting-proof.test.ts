// A bounded proof that each quoting function writes a word the shell that reads it turns back into the
// string it was given: for every string of length 0 to K over ALPHABET, the model of that shell in
// test/verify/_shells.ts (checked against the real shells by test/verify/shell-models.test.ts) reads
// the output and gives back exactly the input. Where no form works, the string has to fall under a
// limit the function's doc comment names, and each limit must be needed by some string, so a stale one
// fails too. The functions (paths under packages/coding.sh/src):
//
// - cli/args.ts shellQuote, and cli/next-steps.ts quoteArg outside PowerShell and cmd: a word for
//   POSIX sh and for a shell a person types into (interactive bash, zsh).
// - cli/next-steps.ts quoteArg in PowerShell or cmd (windowsShell): a printed argument of a command
//   the user runs there. The readers are cmd.exe running node and npm's codingsh.cmd; Windows
//   PowerShell 5.1 and PowerShell 7 running node and npm's codingsh.ps1; and 5.1 running
//   codingsh.cmd. cmd runs with every variable set, so any %NAME% would expand.
// - adapters/_shared/hooks.ts buildHookCommand, powerShellHookCommand and quoteArg: the hook
//   command an agent's config holds, as the shell that runs it reads it. /bin/sh runs it outside
//   Windows. On Windows Git Bash runs it for Claude Code and PowerShell runs Copilot's `powershell`
//   command. For the other agents cmd or PowerShell may run it, so their command has to come back
//   the same in cmd, PowerShell 5.1 and PowerShell 7, or buildHookCommand has to refuse the path,
//   as it does for a %, $, backtick or curly double quote, which cmd or PowerShell read in quotes on
//   Windows. The path is under /home, or under C:\Users with a name Windows allows. The agent ids
//   and the words adapters add after the path (cursor's --echo-continue, antigravity's --reply={})
//   are checked at their source: the ids and --echo-continue are words sh, PowerShell and cmd read
//   as is, and cmd passes --reply={} on as is.
// - bench/schedule.ts shq and cronLine: the crontab line of a scheduled bench. cron cuts the
//   command at an unescaped %, then /bin/sh runs it. The working directory, the CLI's path, the
//   report folder and the coding.sh home vary with the string; the bench name follows NAME_RE.
//   cronLine refuses a value with a line break, which would end the line.
//
// ALPHABET is HOSTILE (the characters the shells treat specially, a letter and a non-ASCII letter),
// plus `.` and `:`, which PowerShell reads in a parameter. K is 3 (40,495 strings), about 7 s.
// CODING_SH_MODEL_BOUND=n raises it by n: 4 (1,376,831 strings) takes about 3 minutes.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { ADAPTERS } from "../../src/adapters/index.ts";
import type { Json } from "../../src/adapters/more/_util.ts";
import { agyHookDef } from "../../src/adapters/more/antigravity.ts";
import { buildHookCommand, hookPathForCommand, hookShFor, powerShellHookCommand, quoteArg as hookQuote } from "../../src/adapters/_shared/hooks.ts";
import { benchHome, NAME_RE } from "../../src/bench/define.ts";
import { cronLine, shq } from "../../src/bench/schedule.ts";
import { shellQuote } from "../../src/cli/args.ts";
import { quoteArg } from "../../src/cli/next-steps.ts";
import { cmdRun, cmdToNode, cmdToShim, cronCommand, crtArgv, everyEnv, HOSTILE, psCommand, psNative, psToCmdShim, psToNode, psToShim, shTokens, shWords, type PsVersion, type ShToken } from "./_shells.ts";

function boundFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.CODING_SH_MODEL_BOUND ?? "0";
  const extra = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(extra)) throw new Error(`CODING_SH_MODEL_BOUND must be a whole number, not ${raw}`);
  return extra;
}

const K = 3 + boundFrom(process.env);
const ALPHABET: readonly string[] = [...HOSTILE, ".", ":"];

/** Every string of length 0 to `k` over `alphabet`, shortest first. */
function* strings(alphabet: readonly string[], k: number): Generator<string> {
  for (let len = 0; len <= k; len++) {
    const at = new Array<number>(len).fill(0);
    for (;;) {
      yield at.map((i) => alphabet[i]).join("");
      let p = len - 1;
      while (p >= 0 && ++at[p]! === alphabet.length) at[p--] = 0;
      if (p < 0) break;
    }
  }
}

/** A string no form gets through to a reader, as the function's doc comment names it. */
interface Limit {
  name: string;
  holds: (s: string) => boolean;
}

/** Checks `back(s)` equals `want(s)` for every string, or that the string falls under a limit, and that each limit is needed. */
function prove(t: { diagnostic: (m: string) => void }, label: string, alphabet: readonly string[], back: (s: string) => unknown, want: (s: string) => unknown, limits: readonly Limit[] = []): void {
  const t0 = performance.now();
  let n = 0;
  let broken = 0;
  const used = new Map<string, number>();
  const bad: string[] = [];
  for (const s of strings(alphabet, K)) {
    n++;
    if (isDeepStrictEqual(back(s), want(s))) continue;
    broken++;
    const l = limits.find((x) => x.holds(s));
    if (l) used.set(l.name, (used.get(l.name) ?? 0) + 1);
    else if (bad.push(s) > 20) bad.pop();
  }
  t.diagnostic(`${label}: ${n} strings up to length ${K}, ${broken} under a limit${[...used].map(([k, v]) => `; ${k}: ${v}`).join("")}, ${Math.round(performance.now() - t0)} ms`);
  assert.deepEqual(bad.map((s) => [JSON.stringify(s), back(s)]), [], `${label}: strings that come back changed`);
  for (const l of limits) assert.ok(used.has(l.name), `${label}: no string needs the limit "${l.name}"`);
}

const after = (prefix: string) => (w: string[] | undefined) => (w && w[0] === prefix ? w.slice(1) : undefined);

test("shellQuote and quoteArg outside Windows: sh reads each string back", (t) => {
  prove(t, "sh", ALPHABET, (s) => after("x")(shWords(`x ${shellQuote(s)}`)), (s) => [s]);
  prove(t, "next steps, sh", ALPHABET, (s) => after("x")(shWords(`x ${quoteArg(s, {}, "linux")}`)), (s) => [s]);
  prove(t, "next steps, Git Bash", ALPHABET, (s) => after("x")(shWords(`x ${quoteArg(s, { SHELL: "/usr/bin/bash" }, "win32")}`)), (s) => [s]);
});

test("shellQuote: a shell a person types into reads each string back", (t) => {
  prove(t, "interactive bash or zsh", ALPHABET, (s) => after("x")(shWords(`x ${shellQuote(s)}`, { prompt: true })), (s) => [s]);
  prove(t, "next steps, interactive bash or zsh", ALPHABET, (s) => after("x")(shWords(`x ${quoteArg(s, {}, "linux")}`, { prompt: true })), (s) => [s]);
});

test("quoteArg in PowerShell and cmd: each reader gets each string back, or the doc comment names why not", (t) => {
  const q = (s: string) => quoteArg(s, {}, "win32");
  const lineBreak: Limit = { name: "a line break", holds: (s) => /[\r\n]/.test(s) };
  const percent: Limit = { name: "%NAME%, which cmd expands", holds: (s) => /%[^%]+%/.test(s) };
  const singleQuoted: Limit = { name: "$, ` or a double quote, in single quotes cmd keeps", holds: (s) => /["$`\u201C\u201D\u201E]/.test(s) };
  const empty: Limit = { name: "an empty argument, which 5.1 drops", holds: (s) => s === "" };
  const innerQuote: Limit = { name: "a double quote, which 5.1 passes unescaped", holds: (s) => s.includes('"') };
  const backslash: Limit = { name: "a trailing backslash in quotes", holds: (s) => s.endsWith("\\") && q(s) !== s };
  const cmdSigns: Limit = { name: "& | < > ( ) ^, which cmd reads where PowerShell drops the quotes", holds: (s) => /[&|<>()^]/.test(s) };
  const readers: [string, (s: string) => string[] | undefined, Limit[]][] = [
    ["cmd, node", (s) => cmdToNode(`node x.mjs ${q(s)}`, everyEnv), [lineBreak, percent, singleQuoted]],
    ["cmd, codingsh.cmd", (s) => cmdToShim(`codingsh ${q(s)}`, everyEnv), [lineBreak, percent, singleQuoted]],
  ];
  for (const v of ["5.1", "7"] as PsVersion[]) {
    const old = v === "5.1" ? [empty, innerQuote] : [];
    readers.push([`PowerShell ${v}, node`, (s) => psToNode(`node x.mjs ${q(s)}`, v), [...old, backslash]]);
    readers.push([`PowerShell ${v}, codingsh.ps1`, (s) => psToShim(`codingsh ${q(s)}`, v), [...old, backslash]]);
  }
  readers.push(["PowerShell 5.1, codingsh.cmd", (s) => psToCmdShim(`codingsh.cmd ${q(s)}`, everyEnv), [empty, innerQuote, backslash, lineBreak, percent, cmdSigns]]);
  for (const [label, back, limits] of readers) prove(t, label, ALPHABET, back, (s) => [s], limits);
});

test("the hook command: each shell that runs it gets the hook's path back, or buildHookCommand refuses the path", (t) => {
  // The characters a Windows path can hold (a backslash starts a folder below), and a curly double
  // and single quote, which PowerShell reads as quotes.
  const windowsName = [...ALPHABET.filter((c) => !'"<>|?*:\t\n'.includes(c)), "\u201C", "\u2019"];
  const words = (line: string) => shWords(line);
  const win = (s: string) => `C:\\Users\\${s}\\.coding.sh\\hook.mjs`;
  // The program and the arguments node gets when cmd or PowerShell runs a command line.
  const cmd = (line: string) => {
    const r = cmdRun(line, everyEnv);
    return r === undefined ? undefined : crtArgv(r);
  };
  const ps = (v: PsVersion) => (line: string) => {
    const c = psCommand(line);
    return c ? [c.name, ...crtArgv(`node ${psNative(c.args.map((a) => a.value), v)}`).slice(1)] : undefined;
  };
  const readers: [string, (line: string) => string[] | undefined][] = [["cmd", cmd], ["PowerShell 5.1", ps("5.1")], ["PowerShell 7", ps("7")]];
  for (const extra of [[], ["--echo-continue"]]) {
    const how = extra.length ? "with --echo-continue" : "no extra";
    prove(t, `sh, ${how}`, ALPHABET, (s) => words(buildHookCommand(`/home/${s}/.coding.sh/hook.mjs`, "cursor", "beforeSubmitPrompt", extra, "linux")), (s) => ["/bin/sh", hookShFor(`/home/${s}/.coding.sh/hook.mjs`), "cursor", "beforeSubmitPrompt", ...extra]);
    prove(t, `Git Bash, ${how}`, windowsName, (s) => words(buildHookCommand(win(s), "claude-code", "PreToolUse", extra, "win32")), (s) => ["node", hookPathForCommand(win(s)), "claude-code", "PreToolUse", ...extra]);
    // Another agent's command: each of cmd and PowerShell reads it back, or buildHookCommand refuses
    // the path, and it refuses just the paths with a %, $, backtick or curly double quote.
    const want = (s: string) => (/[%$`\u201C-\u201E]/.test(s) ? "refused" : ["node", hookPathForCommand(win(s)), "cursor", "beforeSubmitPrompt", ...extra]);
    for (const [shell, read] of readers) {
      prove(t, `${shell}, ${how}`, windowsName, (s) => {
        let line: string;
        try {
          line = buildHookCommand(win(s), "cursor", "beforeSubmitPrompt", extra, "win32");
        } catch {
          return "refused";
        }
        return read(line);
      }, want);
    }
  }
  for (const v of ["5.1", "7"] as PsVersion[]) {
    prove(t, `Copilot's powershell command, PowerShell ${v}`, windowsName, (s) => ps(v)(powerShellHookCommand(win(s), "copilot-cli", "preToolUse")), (s) => ["node", hookPathForCommand(win(s)), "copilot-cli", "preToolUse"]);
  }
  prove(t, "quoteArg under sh", ALPHABET, (s) => after("x")(words(`x ${hookQuote(s)}`)), (s) => [s]);
});

test("the hook command's other words are ones the shells that run it read as is", () => {
  // A word with only these characters is bare in sh, PowerShell and cmd, and no shell expands it.
  const plain = /^[A-Za-z][A-Za-z0-9_-]*$/;
  for (const a of ADAPTERS) assert.match(a.id, plain, `agent id ${a.id}`);
  // The only extra argument an adapter gives buildHookCommand (cursor's beforeSubmitPrompt).
  assert.match("--echo-continue", /^--[a-z][a-z-]*$/);
  assert.equal(hookQuote("--echo-continue"), "--echo-continue");
  // antigravity appends --reply={} to the command. cmd reads it as is, checked here. sh has no brace
  // expansion and bash expands braces only around a comma or `..`, so both read it as is too; the sh
  // model does not read braces, so that is not checked here.
  const win = "C:\\Users\\user\\.coding.sh\\hook.mjs";
  const command = (agyHookDef(win, "win32").Stop as Json[])[0]!.command;
  assert.equal(typeof command, "string");
  const r = cmdRun(String(command), everyEnv);
  assert.deepEqual(r === undefined ? undefined : crtArgv(r).slice(1), [hookPathForCommand(win), "antigravity", "Stop", "--reply={}"]);
});

test("shq and cronLine: cron and sh read each path back, and cronLine refuses a line break", (t) => {
  prove(t, "shq under sh", ALPHABET, (s) => after("x")(shWords(`x ${shq(s)}`)), (s) => [s]);
  const name = "daily";
  assert.match(name, NAME_RE);
  const opts = (s: string) => ({ name, at: "07:05", cwd: `/w/${s}`, cli: ["/usr/bin/node", `/p/${s}/cli.mjs`], reportDir: `/r/${s}`, env: { CODING_SH_HOME: `/h/${s}` } });
  const want = (s: string): ShToken[] | "refused" => {
    if (/[\r\n]/.test(s)) return "refused";
    const o = opts(s);
    const cli = [...o.cli];
    return ["cd", o.cwd, { op: "&&" }, ...cli, "bench", "run", name, { op: "&&" }, ...cli, "bench", "report", name, "--out", o.reportDir, { op: ">>" }, join(benchHome(o.env), name, "cron.log"), { op: "2>&1" }];
  };
  const back = (s: string) => {
    let line: string;
    try {
      line = cronLine(opts(s));
    } catch {
      return "refused";
    }
    const cmd = cronCommand(line);
    return cmd === undefined ? undefined : shTokens(cmd);
  };
  prove(t, "cronLine", ALPHABET, back, want);
});
