// Root help and the READMEs say the same one-liner, internal flags stay out of help, and help
// names the CLI and writes its examples as the user's shell runs them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { signatureHeaders } from "../../src/alerts/notify.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { commandHelp, helpMetadata, rootHelp, SUMMARY } from "../../src/cli/main.ts";
import { COMMANDS, findCommand } from "../../src/cli/registry.ts";
import { resolveWindowsCommand } from "../../src/core/spawn.ts";
import { BUDGET_REFRESH_MS } from "../../src/proxy/budget.ts";

const plain = { heading: (s: string) => s, bold: (s: string) => s, faint: (s: string) => s };
const PKG = join(import.meta.dirname, "..", "..");

/** Help for a command, or one of its actions, for env's shell on platform. */
function help(name: string, action?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  const cmd = findCommand(name)!;
  return commandHelp(cmd, action === undefined ? undefined : cmd.actions!.find((a) => a.name === action)!, plain, env, platform);
}

/** A help page's Examples section, one string per line. */
const examples = (page: string) => page.split("\nExamples\n")[1]?.split("\n\n")[0]?.split("\n").filter(Boolean) ?? [];

describe("help summary", () => {
  it("root help leads with the summary both READMEs use", () => {
    assert.match(rootHelp(plain), new RegExp(`^  ${SUMMARY.replace(/[.]/g, "\\.")}$`, "m"));
    // The READMEs open with "coding.sh records …", so the summary's first letter is lowercase there.
    for (const readme of [join(PKG, "README.md"), join(PKG, "..", "..", "README.md")]) {
      const text = readFileSync(readme, "utf8").toLowerCase();
      assert.ok(text.includes(SUMMARY.toLowerCase()), `${readme} carries the CLI summary`);
    }
    assert.match(SUMMARY, /^Records what your AI agents do/);
  });
});

describe("hidden flags", () => {
  const update = findCommand("update")!;

  it("update --refresh-bin is accepted but not shown in help or --help --json", () => {
    const help = commandHelp(update, undefined, plain);
    assert.doesNotMatch(help, /refresh-bin/);
    assert.match(help, /--check/);
    assert.doesNotMatch(JSON.stringify(helpMetadata(update)), /refresh-bin/);
    assert.doesNotMatch(JSON.stringify(helpMetadata()), /refresh-bin/);
    const parsed = parseArgs(["--refresh-bin"], update.flags ?? []);
    assert.equal(parsed.flags["refresh-bin"], true);
  });

  it("a typo is never corrected to a hidden flag", () => {
    assert.throws(() => parseArgs(["--refresh-bim"], update.flags ?? []), (e: Error & { suggestion?: string }) => e.suggestion === undefined);
  });
});

describe("help that states what the code does", () => {
  const notes = (name: string) => commandHelp(findCommand(name)!, undefined, plain).replace(/\s+/g, " ");

  it("alert and monitor help name all three signature headers, which one covers the timestamp, and the 5-minute check", () => {
    for (const name of ["alert", "monitor"]) {
      const help = notes(name);
      for (const h of Object.keys(signatureHeaders("s", "{}"))) assert.ok(help.includes(`${h}:`) || help.includes(`${h} (`), `${name} help names ${h}`);
      assert.match(help, /X-Coding-Sh-Signature-V2: sha256=<HMAC-SHA256 of "<timestamp>\.<body>">, which covers the timestamp and the body/);
      assert.match(help, /X-Coding-Sh-Signature: sha256=<HMAC-SHA256 of the body alone>, which does not stop a replay/);
      assert.match(help, /refuses a timestamp more than 5 minutes from its own clock/);
    }
  });

  it("proxy help: only proxy-wide budgets stop a call, and a failed read stops none for the refresh interval with one warning", () => {
    const help = notes("proxy");
    assert.match(help, /A --repo or --where budget never stops one/);
    assert.match(help, new RegExp(`none stops a call for ${BUDGET_REFRESH_MS / 1000} s, and one warning prints`));
  });

  it("budget help: a budget that can't be read prints an error in place of its numbers, and status exits 1", () => {
    assert.match(notes("budget"), /error replaces spendUsd, percent and over.*status exits 1/);
  });

  it("monitor help: a pass stops after 2 unreachable sessions, a later answer moves past them, and list hides the query string", () => {
    const help = notes("monitor");
    assert.match(help, /for 2 sessions in a row, the pass stops/);
    assert.match(help, /An answer for a later session, a score or a refusal, moves the cursor past them/);
    assert.match(help, /without its query string or fragment/);
  });

  it("harness tools help: what removed means, and that a later pin does not pin a tool that is gone", () => {
    const help = notes("harness");
    assert.match(help, /a pinned tool that no tools array offered since its pin includes/);
    assert.match(help, /a later pin does not pin again a tool that is gone/);
  });
});

/** Every help page: the root and each command and action, for env's shell on platform. */
function pages(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[] {
  return [rootHelp(plain, env, platform), ...COMMANDS.flatMap((c) => [commandHelp(c, undefined, plain, env, platform), ...(c.actions ?? []).map((a) => commandHelp(c, a, plain, env, platform))])];
}

// PowerShell and cmd start the CLI on Windows with no MSYSTEM or SHELL set (windowsShell).
describe("help in PowerShell and cmd", () => {
  const win = pages({}, "win32");

  it("names codingsh in the usage line, every example and Learn More", () => {
    assert.match(win[0]!, /^codingsh <command> \[options\]$/m);
    assert.match(win[0]!, /^    codingsh sessions --since 7d$/m);
    assert.match(win[0]!, /^  Run codingsh <command> --help for a command's options\.$/m);
    assert.match(help("dataset", "add", {}, "win32"), /^codingsh dataset add <NAME> \[options\]$/m);
    for (const page of win) {
      assert.match(page, /^codingsh /, page.split("\n")[0]);
      for (const line of examples(page).filter((l) => !l.startsWith("      "))) {
        assert.match(line, /(?<=^|\s)codingsh(?=\s|$)/, line);
        assert.doesNotMatch(line, /(?<=^|\s)coding\.sh(?=\s|$)/, line);
      }
    }
    // Under npx, the form nextStepBin names there.
    assert.match(rootHelp(plain, { npm_command: "exec" }, "win32"), /^npx -p coding\.sh codingsh <command> \[options\]$/m);
    assert.match(help("init", undefined, { npm_command: "exec" }, "win32"), /^    npx -p coding\.sh codingsh init --agent claude-code --yes$/m);
  });

  it("shows no inline JSON: a JSON value for a <JSON|FILE> flag is a file, with the same JSON on the line below", () => {
    for (const page of win) {
      const lines = examples(page);
      for (const [i, line] of lines.entries()) {
        const note = /^      (\S+\.json): (.*)$/.exec(line);
        if (!note) {
          // An argument that starts with { or [, quoted or not, is inline JSON.
          assert.doesNotMatch(line, /(?:^|\s)["']?[{[]/, line);
          continue;
        }
        // A note names a file the example above it passes, and holds JSON.
        const example = lines.slice(0, i).findLast((l) => !l.startsWith("      "))!;
        assert.ok(example.split(" ").includes(note[1]!), `${example} passes ${note[1]}`);
        assert.doesNotThrow(() => JSON.parse(note[2]!), line);
      }
    }
    assert.deepEqual(examples(help("eval", "new", {}, "win32")).slice(-2), ['    codingsh eval new latest --statement ledger --judge judge.json --verifier "npm test"', '      judge.json: {"provider":"anthropic"}']);
    assert.deepEqual(examples(help("exp", "aa", {}, "win32")).slice(0, 3), ["    codingsh exp aa --dataset smoke --task task.json --grader grader.json", '      task.json: {"kind":"command","command":"node agent.mjs"}', '      grader.json: {"kind":"exact"}']);
    assert.deepEqual(examples(help("dataset", "add", {}, "win32")).slice(0, 2), ["    codingsh dataset add smoke --case case.json", '      case.json: {"input":"2+2","expected":"4"}']);
    // Each file holds the value the sh example passes inline, in the same order.
    for (const [name, action] of [["eval", "new"], ["exp", "aa"], ["exp", "sweep"], ["bench", "new"], ["dataset", "add"], ["judge", "grade"]] as const) {
      const inline = examples(help(name, action)).flatMap((l) => [...l.matchAll(/'([{[][^']*)'/g)].map((m) => JSON.parse(m[1]!) as unknown));
      const files = examples(help(name, action, {}, "win32")).flatMap((l) => /^      \S+\.json: (.*)$/.exec(l)?.slice(1).map((j) => JSON.parse(j) as unknown) ?? []);
      assert.ok(inline.length, `${name} ${action} has an inline JSON example`);
      assert.deepEqual(files, inline, `${name} ${action}`);
    }
  });

  it("quotes each argument for both shells, and pipes proxy env to Invoke-Expression", () => {
    assert.deepEqual(examples(help("run", undefined, {}, "win32")), ['    codingsh run "--" aider --message "fix the tests"']);
    assert.deepEqual(examples(help("proxy", "env", {}, "win32")), ["    codingsh proxy env | Invoke-Expression"]);
    assert.match(help("sql", undefined, {}, "win32"), /^    codingsh sql "select tool, count\(\*\) from events where kind = 'tool\.end' and ok = 0 group by tool order by 2 desc" --csv$/m);
    assert.match(help("export", undefined, {}, "win32"), /^    codingsh export events --where "agent:codex tool\.errors>0" > events\.jsonl$/m);
  });
});

describe("help in sh", () => {
  it("is the same on Linux, macOS, Git Bash and Cygwin as the form docs/reference/cli.md shows", () => {
    const sh = pages();
    const shells = [[{}, "linux"], [{}, "darwin"], [{ npm_command: "exec" }, "linux"], [{ MSYSTEM: "MINGW64" }, "win32"], [{ SHELL: "/usr/bin/bash" }, "win32"], [{ npm_command: "exec", MSYSTEM: "MINGW64" }, "win32"]] as const;
    for (const [env, platform] of shells) assert.deepEqual(pages(env, platform), sh, `${platform} ${JSON.stringify(env)}`);
    assert.match(sh[0]!, /^coding\.sh <command> \[options\]$/m);
    assert.match(sh[0]!, /^  Run coding\.sh <command> --help for a command's options\.$/m);
    assert.deepEqual(examples(help("dataset", "add")).slice(0, 1), [`    coding.sh dataset add smoke --case '{"input":"2+2","expected":"4"}'`]);
    assert.deepEqual(examples(help("proxy", "env")), [`    eval "$(coding.sh proxy env)"`]);
  });
});

// Examples as help prints them in PowerShell and cmd, run in those shells with codingsh replaced
// by a script that prints its arguments: each argument arrives as the sh example passes it, with a
// file name in place of inline JSON.
describe("a help example, run as printed in PowerShell and cmd", () => {
  const win = process.platform === "win32";
  const shells = [
    { name: "cmd", shim: "cmd", skip: !win && "cmd: Windows" },
    { name: "PowerShell 5.1", shim: "ps1", skip: !(win && resolveWindowsCommand("powershell")) && "PowerShell: Windows" },
    { name: "PowerShell 7", shim: "ps1", skip: !(win && resolveWindowsCommand("pwsh")) && "PowerShell 7: not installed" },
  ] as const;
  // The page, a piece of the example that picks it from the page, and the arguments it passes.
  const cases = [
    { name: "eval", action: "new", has: "--judge judge.json", argv: ["eval", "new", "latest", "--statement", "ledger", "--judge", "judge.json", "--verifier", "npm test"] },
    { name: "exp", action: "aa", has: "--task task.json", argv: ["exp", "aa", "--dataset", "smoke", "--task", "task.json", "--grader", "grader.json"] },
    { name: "bench", action: "new", has: "-g grader.json", argv: ["bench", "new", "answers", "--command", "node gen.mjs", "-c", "fast=node fast.mjs", "-c", "big=node big.mjs", "-g", "grader.json"] },
    { name: "run", action: undefined, has: "aider", argv: ["run", "--", "aider", "--message", "fix the tests"] },
    { name: "sql", action: undefined, has: "tool.end", argv: ["sql", "select tool, count(*) from events where kind = 'tool.end' and ok = 0 group by tool order by 2 desc", "--csv"] },
  ];

  let bin = "";
  before(() => {
    bin = mkdtempSync(join(tmpdir(), "csh-help-run-"));
    writeFileSync(join(bin, "argv.mjs"), "console.log(JSON.stringify({ shim: process.env.CSH_SHIM, argv: process.argv.slice(2) }));\n");
    // Stand-ins for npm's cmd and PowerShell shims (cmd-shim), running argv.mjs and marking which one ran.
    writeFileSync(join(bin, "codingsh.cmd"), ["@ECHO off", "SET CSH_SHIM=cmd", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", 'SET "_prog=node"', 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\argv.mjs" %*', ""].join("\r\n"));
    writeFileSync(join(bin, "codingsh.ps1"), ['$env:CSH_SHIM="ps1"', "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent", '$exe=""', 'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) { $exe=".exe" }', '& "node$exe"  "$basedir/argv.mjs" $args', "exit $LASTEXITCODE", ""].join("\n"));
  });
  after(() => rmSync(bin, { recursive: true, force: true }));

  function run(shell: string, line: string): unknown {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = [bin, dirname(process.execPath), env[key]].join(delimiter);
    for (const k of ["MSYSTEM", "SHELL", "CSH_SHIM"]) delete env[k];
    const [file, args]: [string, string[]] =
      shell === "cmd" ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`]]
      // -EncodedCommand hands PowerShell the line as typed, with no quoting on the way.
      : [shell === "PowerShell 7" ? "pwsh.exe" : "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(line, "utf16le").toString("base64")]];
    const r = spawnSync(file, args, { cwd: bin, env, encoding: "utf8", timeout: 60_000, windowsVerbatimArguments: shell === "cmd" });
    assert.equal(r.status, 0, `${line}\n${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "");
  }

  for (const sh of shells) {
    it(`in ${sh.name}, each argument arrives as given`, { skip: sh.skip }, () => {
      for (const c of cases) {
        const line = examples(help(c.name, c.action, {}, "win32")).find((l) => l.startsWith("    codingsh ") && l.includes(c.has));
        assert.ok(line, `${c.name} ${c.action ?? ""} has an example with ${c.has}`);
        assert.match(line, /^[\x20-\x7e]+$/, "the line is ASCII");
        assert.deepEqual(run(sh.name, line.trim()), { shim: sh.shim, argv: c.argv });
      }
    });
  }
});
