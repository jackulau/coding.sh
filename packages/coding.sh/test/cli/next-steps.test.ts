// init, uninstall and update name the CLI as the user's shell runs it. Started with npx,
// `coding.sh` is not on PATH; in PowerShell or cmd on Windows it opens npm's sh shim, and
// sh lines such as `curl … | sh` do not run. Commands run in-process in a throwaway home.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { UsageError } from "../../src/cli/args.ts";
import * as init from "../../src/cli/commands/init.ts";
import * as uninstall from "../../src/cli/commands/uninstall.ts";
import { checkFailed, reinstallCommand, runUpdate, type UpdateDeps } from "../../src/cli/commands/update.ts";
import { cliCommand, codeSpansForShell, nextStepBin, quoteArg, rerunWithYes, runCommand } from "../../src/cli/next-steps.ts";
import { CliError } from "../../src/cli/output.ts";
import type { CommandModule } from "../../src/cli/types.ts";
import { resolveWindowsCommand } from "../../src/core/spawn.ts";
import type { UpdateCache } from "../../src/update/index.ts";
import { writeFile } from "../adapters/_helpers.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const CURL = "curl -fsSL https://coding.sh/install | sh";
/** The CLI under npx. On Windows npx runs the command through cmd, which needs the dotless bin. */
const NPX = process.platform === "win32" ? "npx -p coding.sh codingsh" : "npx coding.sh";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const boxes: Sandbox[] = [];
after(() => boxes.forEach((b) => b.cleanup()));

/** A throwaway home, with a stand-in for dist/hook.mjs, which init installs. No agent on PATH. */
function box(extra: NodeJS.ProcessEnv = {}): Sandbox {
  const sb = sandbox({ PATH: dirname(process.execPath), ...extra });
  boxes.push(sb);
  const hook = join(sb.root, "dist", "hook.mjs");
  writeFile(hook, "// hook\n");
  sb.env.CODING_SH_HOOK_SOURCE = hook;
  return sb;
}

/** npm sets npm_command=exec in the CLI it starts for npx. */
const npxBox = () => box({ npm_command: "exec" });

const update = (deps: UpdateDeps): CommandModule => ({ run: (c) => runUpdate(c, deps) });
const setup = { agent: ["claude-code"], mcp: false, import: false };

describe("started with npx", () => {
  test("init without a terminal names the npx command to rerun with --yes", async () => {
    const r = await runCmd(init, npxBox(), { flags: setup });
    assert.ok(r.error instanceof UsageError, String(r.error));
    assert.equal(r.error.suggestion, `${NPX} init --yes`);
  });

  test("uninstall without a terminal names the npx command to rerun with --yes", async () => {
    const sb = npxBox();
    const set = await runCmd(init, sb, { flags: { ...setup, yes: true } });
    assert.equal(set.code, 0, String(set.error ?? set.stderr));
    const r = await runCmd(uninstall, sb, { flags: { agent: ["claude-code"] } });
    assert.ok(r.error instanceof UsageError, String(r.error));
    assert.equal(r.error.suggestion, `${NPX} uninstall --yes`);
  });

  test("update names the npx command that installs the release, and the one that sets up capture", async () => {
    const sb = npxBox();
    const available: UpdateCache = { latest: "0.2.0", checkedAt: 1, url: "https://github.com/jackulau/coding.sh/releases/tag/v0.2.0", install: "https://github.com/jackulau/coding.sh/releases/download/v0.2.0/coding.sh-0.2.0.tgz", source: "github" };
    const deps: UpdateDeps = { current: "0.1.0", check: async () => available };
    const check = await runCmd(update(deps), sb, { flags: { check: true } });
    assert.equal(check.code, 0, String(check.error));
    assert.match(check.stderr, new RegExp(`Install it:\\n {4}${esc(NPX)} update$`, "m"));
    const dry = await runCmd(update(deps), sb, { flags: { "dry-run": true } });
    assert.match(dry.stderr, new RegExp(`Run the command above, or ${esc(NPX)} update\\.`));
    // No hook installed yet: --refresh-bin points at init.
    const refresh = await runCmd(update({}), sb, { flags: { "refresh-bin": true } });
    assert.equal(refresh.code, 0, String(refresh.error));
    assert.match(refresh.stderr, new RegExp(`Nothing to refresh: run ${esc(NPX)} init to set up capture`));
  });
});

describe("the rerun a consent prompt names", () => {
  test("is the command as given, with --yes: init keeps --agent, --no-mcp and --no-import", async () => {
    const sb = box();
    const r = await runCmd(init, sb, { flags: setup, argv: ["init", "--agent", "claude-code", "--no-mcp", "--no-import"] });
    assert.ok(r.error instanceof UsageError, String(r.error));
    assert.equal(r.error.suggestion, `${nextStepBin(sb.env)} init --agent claude-code --no-mcp --no-import --yes`);
  });

  test("started with npx, uninstall names the npx command with the flags given", async () => {
    const sb = npxBox();
    const set = await runCmd(init, sb, { flags: { ...setup, yes: true } });
    assert.equal(set.code, 0, String(set.error ?? set.stderr));
    const r = await runCmd(uninstall, sb, { flags: { agent: ["claude-code"] }, argv: ["uninstall", "--agent", "claude-code"] });
    assert.ok(r.error instanceof UsageError, String(r.error));
    assert.equal(r.error.suggestion, `${NPX} uninstall --agent claude-code --yes`);
  });
});

describe("reinstalling the latest release", () => {
  test("PowerShell and cmd get npm install -g; Git Bash, Cygwin, Linux and macOS get the installer", () => {
    assert.equal(reinstallCommand({}, "win32"), "npm install -g coding.sh");
    assert.equal(reinstallCommand({ PSModulePath: "C:/x" }, "win32"), "npm install -g coding.sh");
    assert.equal(reinstallCommand({ MSYSTEM: "MINGW64" }, "win32"), CURL);
    assert.equal(reinstallCommand({ SHELL: "/usr/bin/bash" }, "win32"), CURL);
    assert.equal(reinstallCommand({}, "linux"), CURL);
    assert.equal(reinstallCommand({}, "darwin"), CURL);
  });

  test("a failed check names the reinstall the user's shell can run", () => {
    const cache = { error: "GitHub: x; npm: y", errorKind: "network" } as UpdateCache;
    assert.equal(checkFailed(cache, "0.1.0", { MSYSTEM: "MINGW64" }).next[1], CURL);
    assert.equal(checkFailed(cache, "0.1.0", {}).next[1], process.platform === "win32" ? "npm install -g coding.sh" : CURL);
  });

  test("a release with no package names the reinstall the user's shell can run", async () => {
    // No SHELL or MSYSTEM in the sandbox: PowerShell or cmd on Windows.
    const r = await runCmd(update({ current: "0.1.0", check: async () => ({ latest: "0.2.0", checkedAt: 1, source: "github" }) }), box(), {});
    assert.ok(r.error instanceof CliError, String(r.error));
    assert.equal(r.error.reason, "no_install_target");
    assert.deepEqual(r.error.next, ["Reinstall the latest release:", process.platform === "win32" ? "npm install -g coding.sh" : CURL]);
  });
});

describe("commands in backticks, as in a work item's next step", () => {
  const step = "review: `git -C /work/demo diff`, then `coding.sh work ack w1a2b3c`";

  test("in PowerShell and cmd, each one that runs coding.sh names codingsh; other commands, paths and prose stay", () => {
    const win = (s: string) => codeSpansForShell(s, {}, "win32");
    assert.equal(win(step), "review: `git -C /work/demo diff`, then `codingsh work ack w1a2b3c`");
    assert.equal(win("`coding.sh show s1`, then `claude --resume s1`"), "`codingsh show s1`, then `claude --resume s1`");
    // A file named coding.sh is a path, not a command; text outside backticks is prose.
    assert.equal(win("review: `coding.sh`, `src/a.ts` (outside /work/demo)"), "review: `coding.sh`, `src/a.ts` (outside /work/demo)");
    assert.equal(win("run coding.sh work ack w1"), "run coding.sh work ack w1");
    // An odd backtick leaves no span to trust.
    assert.equal(win("a ` and `coding.sh work ack w1`"), "a ` and `coding.sh work ack w1`");
    // A second pass changes nothing.
    assert.equal(win(win(step)), win(step));
  });

  test("under npx it is the npx form; Git Bash, Cygwin, Linux and macOS keep coding.sh", () => {
    assert.equal(codeSpansForShell(step, { npm_command: "exec" }, "win32"), step.replace("`coding.sh ", "`npx -p coding.sh codingsh "));
    assert.equal(codeSpansForShell(step, { npm_command: "exec" }, "linux"), step.replace("`coding.sh ", "`npx coding.sh "));
    for (const [env, platform] of [[{ MSYSTEM: "MINGW64" }, "win32"], [{ SHELL: "/usr/bin/bash" }, "win32"], [{}, "linux"], [{}, "darwin"]] as const) {
      assert.equal(codeSpansForShell(step, env, platform), step, `${platform} ${JSON.stringify(env)}`);
    }
  });
});

describe("an argument in a printed command", () => {
  test("gets sh quoting in sh: Linux, macOS, Git Bash and Cygwin", () => {
    for (const [env, platform] of [[{}, "linux"], [{}, "darwin"], [{ MSYSTEM: "MINGW64" }, "win32"], [{ SHELL: "/usr/bin/bash" }, "win32"]] as const) {
      assert.equal(quoteArg("C:\\my store", env, platform), "'C:\\my store'");
      assert.equal(quoteArg("it's", env, platform), "'it'\\''s'");
      // zsh reads a word that starts with = as a command's path.
      assert.equal(quoteArg("=x", env, platform), "'=x'");
      assert.equal(quoteArg("a=b", env, platform), "a=b");
      assert.equal(runCommand(env, "<cmd>", platform), "coding.sh run -- <cmd>");
    }
  });

  test("in PowerShell and cmd, is bare where both keep it, else in double quotes, which both strip", () => {
    const q = (s: string) => quoteArg(s, {}, "win32");
    for (const s of ["claude-code", "--agent", "C:\\work\\demo", "pkg@1.0", "--store=C:/x"]) assert.equal(q(s), s);
    assert.equal(q("C:\\my store"), '"C:\\my store"');
    // cmd keeps single quotes.
    assert.equal(q("it's"), `"it's"`);
    assert.equal(q("x&y"), '"x&y"');
    // PowerShell drops the first bare -- given to a script, stops parsing at --%, splits -x:y and a,b, and splats @x.
    for (const s of ["--", "--%", "-x:y", "a,b", "@scope/pkg"]) assert.equal(q(s), `"${s}"`);
    // Node reads \" as a quote: a trailing backslash is doubled inside the quotes.
    assert.equal(q("C:\\my store\\"), '"C:\\my store\\\\"');
    assert.equal(q(""), '""');
    // $, a backtick or a double quote: no form keeps it in both, so PowerShell's single quotes.
    assert.equal(q("$HOME"), "'$HOME'");
    assert.equal(q("it's $5"), "'it''s $5'");
    assert.equal(q('say "hi"'), `'say "hi"'`);
  });

  test("follows the bin the shell runs, and `run --` keeps its -- in PowerShell", () => {
    assert.equal(cliCommand({}, ["init", "--scope", "project"], "linux"), "coding.sh init --scope project");
    assert.equal(cliCommand({}, ["init", "--scope", "project"], "win32"), "codingsh init --scope project");
    assert.equal(cliCommand({ npm_command: "exec" }, ["init"], "linux"), "npx coding.sh init");
    assert.equal(runCommand({}, "<cmd>", "win32"), 'codingsh run "--" <cmd>');
    assert.equal(runCommand({ npm_command: "exec" }, "aider", "win32"), 'npx -p coding.sh codingsh run "--" aider');
  });

  test("a rerun keeps an argument with a space in it", () => {
    const c = { argv: ["compare", "--store", "C:\\my store", "a"], env: {} };
    assert.equal(rerunWithYes(c, [], "win32"), 'codingsh compare --store "C:\\my store" a --yes');
    assert.equal(rerunWithYes(c, [], "linux"), "coding.sh compare --store 'C:\\my store' a --yes");
  });
});

describe("a printed command, run as printed", () => {
  const win = process.platform === "win32";
  // Arguments a shell would split, expand, drop or keep quotes on, printed bare.
  const both = ["compare", "--store", "C:\\my store\\", "two words", "it's", "a,b", "-x:y", "--", "@scope/pkg", "x&y", "--label=a b", "pkg@1.0"];
  // No form keeps these in both PowerShell and cmd: they get PowerShell's quoting.
  const dollar = ["$HOME", "a`b", "it's $5"];
  const shells = [
    { name: "sh", shim: "sh", platform: "linux", args: [...both, ...dollar, 'say "hi"'], skip: win && "sh: Linux and macOS" },
    { name: "cmd", shim: "cmd", platform: "win32", args: both, skip: !win && "cmd: Windows" },
    { name: "PowerShell", shim: "ps1", platform: "win32", args: [...both, ...dollar], skip: !(win && resolveWindowsCommand("powershell")) && "PowerShell: Windows" },
  ] as const;

  let bin = "";
  before(() => {
    bin = mkdtempSync(join(tmpdir(), "csh-printed-"));
    writeFileSync(join(bin, "argv.mjs"), "console.log(JSON.stringify({ shim: process.env.CSH_SHIM ?? 'sh', argv: process.argv.slice(2) }));\n");
    // Stand-ins for the bins npm installs, running argv.mjs instead of the CLI: a script on PATH,
    // and on Windows npm's cmd and PowerShell shims (cmd-shim), each marking which one ran.
    writeFileSync(join(bin, "coding.sh"), '#!/bin/sh\nexec node "$(dirname "$0")/argv.mjs" "$@"\n', { mode: 0o755 });
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
      shell === "sh" ? ["/bin/sh", ["-c", line]]
      : shell === "cmd" ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`]]
      // -EncodedCommand hands PowerShell the line as typed, with no quoting on the way.
      : ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(line, "utf16le").toString("base64")]];
    const r = spawnSync(file, args, { env, encoding: "utf8", timeout: 60_000, windowsVerbatimArguments: shell === "cmd" });
    assert.equal(r.status, 0, `${line}\n${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "");
  }

  for (const sh of shells) {
    test(`in ${sh.name}, passes on every argument as given`, { skip: sh.skip }, () => {
      const line = cliCommand({}, sh.args, sh.platform);
      assert.deepEqual(run(sh.name, line), { shim: sh.shim, argv: sh.args });
    });
  }
});
