// A status line that 0.1.7 or earlier installed runs `coding.sh statusline`. Claude Code on Windows
// runs it through PowerShell when Git Bash is not installed, and PowerShell can't run it. On Windows,
// `update --refresh-bin`, an update and doctor name the command that reinstalls it, and none of them
// writes settings.json. Temp HOME, CODING_SH_HOME and CLAUDE_CONFIG_DIR; npm is never run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { staleStatusLine } from "../../src/cli/commands/statusline.ts";
import { runUpdate, type UpdateDeps } from "../../src/cli/commands/update.ts";
import { cliCommand } from "../../src/cli/next-steps.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import type { UpdateCache } from "../../src/update/index.ts";
import { AGENT_HOME_KEYS } from "../_agent-env.ts";
import { CLI } from "../_cli.ts";

const OLD = "coding.sh statusline";
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** settings.json as a user keeps it (CRLF, a one-line array), with `command` as the status line. */
function settingsText(command: string): string {
  return ["{", '  "permissions": { "allow": ["Bash(npm test)", "Read"] },', '  "statusLine": {', '    "type": "command",', `    "command": ${JSON.stringify(command)},`, '    "padding": 0', "  }", "}", ""].join("\r\n");
}

/** A temp home whose Claude Code settings.json holds `text` (no file when undefined). */
function home(text?: string): { env: NodeJS.ProcessEnv; root: string; settings: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-statusline-update-")));
  roots.push(root);
  const h = join(root, "home");
  const claude = join(h, ".claude");
  mkdirSync(claude, { recursive: true });
  const settings = join(claude, "settings.json");
  if (text !== undefined) writeFileSync(settings, text);
  // What --refresh-bin copies into the bin: a stub, so the test needs no built dist/.
  const hook = join(root, "new", "hook.mjs");
  mkdirSync(join(root, "new"));
  writeFileSync(hook, "// hook v2\n");
  const env: NodeJS.ProcessEnv = { HOME: h, USERPROFILE: h, CODING_SH_HOME: join(h, ".coding.sh"), CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(h, ".codex"), CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_AUTO_INGEST: "1", NO_UPDATE_NOTIFIER: "1", PATH: process.env.PATH };
  return { env, root, settings };
}

function captured(env: NodeJS.ProcessEnv, flags: Record<string, boolean>, json = false) {
  const text = { stdout: "", stderr: "" };
  const out = new Output({ json, env, stdout: { write: (s: string) => (text.stdout += s), isTTY: false }, stderr: { write: (s: string) => (text.stderr += s), isTTY: false }, stdin: { isTTY: false } });
  const c: CommandContext = { flags, positionals: [], rest: [], out, env, cwd: env.HOME!, debug: false, signal: new AbortController().signal };
  return { c, text };
}

/** An install npm wrote under `root/<name>`: the CLI path. */
function npmInstall(root: string, name: string, version: string): string {
  const pkg = join(root, name, "node_modules", "coding.sh");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "coding.sh", version }));
  writeFileSync(join(pkg, "dist", "cli.mjs"), "");
  return join(pkg, "dist", "cli.mjs");
}

/** A bin init set up from `owner`: an old hook, and cli-path naming it. */
function oldBin(env: NodeJS.ProcessEnv, owner: string): string {
  const bin = join(env.CODING_SH_HOME!, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "hook.mjs"), "// hook v1\n");
  writeFileSync(join(bin, "cli-path"), owner + "\n");
  return join(bin, "hook.mjs");
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What update prints for a stale line, ending with `next`. */
const hint = (next: string): RegExp =>
  new RegExp(`^! Claude Code's status line runs coding\\.sh statusline, which PowerShell and cmd can't run\\n\\n {2}Reinstall it to run codingsh\\.cmd statusline instead:\\n {4}${esc(next)}\\n`, "m");

describe("staleStatusLine", () => {
  test("on Windows, finds a status line that runs coding.sh statusline, by path too, and only reads the file", () => {
    for (const command of [OLD, `${OLD} --json`, "D:\\tools\\npm\\coding.sh statusline", "/opt/npm/bin/coding.sh statusline"]) {
      const { env, settings } = home(settingsText(command));
      const bytes = readFileSync(settings);
      assert.deepEqual(staleStatusLine(env, "win32"), { file: settings, command }, command);
      // Outside Windows Claude Code runs it in a shell that runs npm's sh script.
      assert.equal(staleStatusLine(env, "linux"), undefined, command);
      assert.equal(staleStatusLine(env, "darwin"), undefined, command);
      assert.deepEqual(readFileSync(settings), bytes);
    }
  });

  test("nothing for a line PowerShell runs, another status line, no status line, no file, or a file that isn't JSON", () => {
    const texts = [
      ...["codingsh.cmd statusline", "codingsh statusline", "npx coding.sh statusline", "bash ./my-line.sh", "coding.sh stats"].map(settingsText),
      '{ "model": "opus" }\r\n',
      '{ "statusLine": { "type": "command" } }\r\n',
      '{ "statusLine": "coding.sh statusline" }\r\n',
      '{ "statusLine": { "command": "coding.sh statusline" ',
      '["coding.sh statusline"]',
      "",
    ];
    for (const text of texts) assert.equal(staleStatusLine(home(text).env, "win32"), undefined, JSON.stringify(text));
    assert.equal(staleStatusLine(home().env, "win32"), undefined, "no settings.json");
  });
});

describe("update --refresh-bin and a status line PowerShell can't run", () => {
  const MAIN = realpathSync(CLI);

  test("on Windows it names statusline install after the refresh, in text and JSON, and leaves settings.json alone", async () => {
    const { env, settings } = home(settingsText(OLD));
    const bytes = readFileSync(settings);
    const hook = oldBin(env, MAIN);

    const human = captured(env, { "refresh-bin": true });
    assert.equal(await runUpdate(human.c, { cli: MAIN, platform: "win32" }), 0);
    assert.equal(readFileSync(hook, "utf8"), "// hook v2\n", "the refresh itself still runs");
    assert.match(human.text.stderr, /^✓ Refreshed /m);
    // PowerShell and cmd (no MSYSTEM, no SHELL) run codingsh; Git Bash runs coding.sh.
    assert.match(human.text.stderr, hint("codingsh statusline install"));
    const bash = captured({ ...env, MSYSTEM: "MINGW64" }, { "refresh-bin": true });
    assert.equal(await runUpdate(bash.c, { cli: MAIN, platform: "win32" }), 0);
    assert.match(bash.text.stderr, hint("coding.sh statusline install"));

    const json = captured(env, { "refresh-bin": true }, true);
    assert.equal(await runUpdate(json.c, { cli: MAIN, platform: "win32" }), 0);
    assert.deepEqual(JSON.parse(json.text.stdout), { bin: "current", hook, statusline: { file: settings, command: OLD, next: "codingsh statusline install" } });
    assert.deepEqual(readFileSync(settings), bytes, "settings.json is never rewritten");
  });

  test("with no bin to refresh, and when another install owns the store, it still names it", async () => {
    const { env, root } = home(settingsText(OLD));
    const none = captured(env, { "refresh-bin": true });
    assert.equal(await runUpdate(none.c, { cli: MAIN, platform: "win32" }), 0);
    assert.match(none.text.stderr, /Nothing to refresh/);
    assert.match(none.text.stderr, hint("codingsh statusline install"));

    const first = npmInstall(root, "first", "0.1.7");
    const hook = oldBin(env, first);
    const second = npmInstall(root, "second", "0.1.8");
    const human = captured(env, { "refresh-bin": true });
    assert.equal(await runUpdate(human.c, { cli: second, platform: "win32" }), 0);
    assert.match(human.text.stderr, /^! Hooks run the coding\.sh 0\.1\.7 at .*, another install/m);
    assert.match(human.text.stderr, hint("codingsh statusline install"));
    const json = captured(env, { "refresh-bin": true }, true);
    assert.equal(await runUpdate(json.c, { cli: second, platform: "win32" }), 0);
    const doc = JSON.parse(json.text.stdout) as Record<string, unknown>;
    assert.equal(doc.bin, "other_install");
    assert.equal(readFileSync(hook, "utf8"), "// hook v1\n");
    assert.deepEqual(doc.statusline, { file: join(env.CLAUDE_CONFIG_DIR!, "settings.json"), command: OLD, next: "codingsh statusline install" });
  });

  test("nothing outside Windows, for the line install writes now, or with no status line", async () => {
    const cases: [NodeJS.Platform, string | undefined][] = [["linux", settingsText(OLD)], ["darwin", settingsText(OLD)], ["win32", settingsText("codingsh.cmd statusline")], ["win32", undefined]];
    for (const [platform, text] of cases) {
      const { env } = home(text);
      oldBin(env, MAIN);
      const human = captured(env, { "refresh-bin": true });
      assert.equal(await runUpdate(human.c, { cli: MAIN, platform }), 0);
      assert.doesNotMatch(human.text.stderr, /Claude Code's status line|statusline install/, `${platform} ${text}`);
      const json = captured(env, { "refresh-bin": true }, true);
      assert.equal(await runUpdate(json.c, { cli: MAIN, platform }), 0);
      assert.equal((JSON.parse(json.text.stdout) as Record<string, unknown>).statusline, undefined);
    }
  });
});

describe("update and a status line PowerShell can't run", () => {
  const TGZ = "https://github.com/jackulau/coding.sh/releases/download/v0.2.0/coding.sh-0.2.0.tgz";
  const available: UpdateCache = { latest: "0.2.0", checkedAt: 1, url: "https://github.com/jackulau/coding.sh/releases/tag/v0.2.0", install: TGZ, source: "github" };
  /** An update to 0.2.0 that npm and the new CLI's --refresh-bin both get through, without running either. */
  const deps = (platform: NodeJS.Platform): UpdateDeps => ({
    current: "0.1.8",
    platform,
    check: async () => available,
    install: async () => ({ code: 0, output: "" }),
    refresh: async () => ({ status: "not_installed" }),
  });

  test("on Windows it names statusline install after the update, also when init never set up the bin", async () => {
    const { env, settings } = home(settingsText(OLD));
    const bytes = readFileSync(settings);
    const human = captured(env, {});
    assert.equal(await runUpdate(human.c, deps("win32")), 0);
    assert.match(human.text.stderr, /^✓ Updated coding\.sh 0\.1\.8 → 0\.2\.0$/m);
    assert.match(human.text.stderr, hint("codingsh statusline install"));
    assert.equal(human.text.stderr.match(/Claude Code's status line/g)?.length, 1, "once");

    const json = captured(env, {}, true);
    assert.equal(await runUpdate(json.c, deps("win32")), 0);
    const doc = JSON.parse(json.text.stdout) as Record<string, unknown>;
    assert.equal(doc.status, "updated");
    assert.deepEqual(doc.statusline, { file: settings, command: OLD, next: "codingsh statusline install" });
    assert.deepEqual(readFileSync(settings), bytes, "settings.json is never rewritten");
  });

  test("nothing outside Windows or for the line install writes now", async () => {
    for (const [platform, command] of [["linux", OLD], ["win32", "codingsh.cmd statusline"]] as const) {
      const { env } = home(settingsText(command));
      const human = captured(env, {});
      assert.equal(await runUpdate(human.c, deps(platform)), 0);
      assert.doesNotMatch(human.text.stderr, /Claude Code's status line|statusline install/, platform);
      const json = captured(env, {}, true);
      assert.equal(await runUpdate(json.c, deps(platform)), 0);
      assert.equal((JSON.parse(json.text.stdout) as Record<string, unknown>).statusline, undefined);
    }
  });
});

describe("doctor and a status line PowerShell can't run", () => {
  interface Warning {
    check: string;
    message: string;
    next?: string;
  }
  /** doctor as the user's shell runs it, in a temp home whose settings.json holds `command`. */
  const doctor = (command: string, json: boolean) => {
    const { env: own, settings } = home(settingsText(command));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["HOME", "USERPROFILE", "CODING_SH_HOME", ...AGENT_HOME_KEYS]) delete env[k];
    Object.assign(env, own, { CODING_SH_NO_UPDATE_CHECK: "1", NO_COLOR: "1" });
    const bytes = readFileSync(settings);
    const args = ["--no-warnings", CLI, "doctor"];
    if (json) args.push("--json");
    const r = spawnSync(process.execPath, args, { cwd: own.HOME, env, encoding: "utf8", timeout: 60_000 });
    assert.deepEqual(readFileSync(settings), bytes, "doctor never writes settings.json");
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, settings, next: cliCommand(env, ["statusline", "install"]) };
  };

  test("on Windows a warning row names statusline install; ok and the exit code stay about the spool and the store", () => {
    const stale = doctor(OLD, true);
    const doc = JSON.parse(stale.stdout) as { ok: boolean; warnings: Warning[] };
    const rows = doc.warnings.filter((w) => w.check === "statusline");
    const fixed = doctor("codingsh.cmd statusline", true);
    const after = JSON.parse(fixed.stdout) as { ok: boolean; warnings: Warning[] };
    assert.deepEqual(after.warnings.filter((w) => w.check === "statusline"), []);
    assert.equal(doc.ok, after.ok);
    assert.equal(stale.status, fixed.status);
    if (process.platform !== "win32") {
      assert.deepEqual(rows, [], "outside Windows the line runs");
      return;
    }
    assert.deepEqual(rows, [{ check: "statusline", message: `Claude Code's status line runs coding.sh statusline, which PowerShell and cmd can't run (${stale.settings})`, next: stale.next }]);

    const human = doctor(OLD, false);
    assert.match(human.stderr, new RegExp(`^! Status line +runs coding\\.sh statusline, which PowerShell and cmd can't run \\(${esc(human.settings)}\\); run ${esc(human.next)}$`, "m"));
  });
});
