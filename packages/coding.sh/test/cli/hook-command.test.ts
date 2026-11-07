// The hook command `init` writes into an agent's config has to run from the
// shell that agent uses, even when the coding.sh home has spaces in it
// (C:\Users\First Last\.coding.sh). Runs the bundled CLI against a temp home,
// then runs the installed Claude Code hook command through each shell this
// platform has: sh (POSIX, and Git Bash on Windows, which Claude Code uses
// there), cmd.exe and PowerShell.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { bundle } from "../../scripts/bundle.mjs";
import { posixShell, resolveWindowsCommand } from "../../src/core/spawn.ts";

let root = "";
let CLI = "";
let env: Record<string, string> = {};
let home = "";

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-hookcmd-")));
  const b = await bundle(join(root, "dist"));
  CLI = b.cli;
  home = join(root, "First Last");
  mkdirSync(join(home, ".claude"), { recursive: true });
  env = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), CODING_SH_HOOK_SOURCE: b.hook, CODING_SH_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) delete env[k];
  const r = cli(["init", "--agent", "claude-code", "--yes", "--no-mcp"]);
  assert.equal(r.status, 0, r.stderr);
});
after(() => rmSync(root, { recursive: true, force: true }));

function cli(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 60_000 });
}

function hookCommand(event: string): string {
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const cmd = settings.hooks[event]?.[0]?.hooks[0]?.command;
  assert.ok(cmd, `no ${event} hook installed`);
  return cmd;
}

const win = process.platform === "win32";
const shells: { name: string; argv: (cmd: string) => [string, string[]] | undefined }[] = [
  { name: "sh", argv: (cmd) => (posixShell() ? [posixShell()!, ["-c", cmd]] : undefined) },
  { name: "cmd.exe", argv: (cmd) => (win ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${cmd}"`]] : undefined) },
  { name: "PowerShell", argv: (cmd) => (win && resolveWindowsCommand("powershell") ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd]] : undefined) },
];

describe("installed hook command", () => {
  it("points at the hook under a home with a space in it", () => {
    const cmd = hookCommand("UserPromptSubmit");
    assert.match(cmd, /^node "[^"]*First Last[^"]*hook\.mjs" claude-code UserPromptSubmit$/);
    if (win) assert.doesNotMatch(cmd, /\\/, "forward slashes only, so no shell eats a backslash");
  });

  for (const sh of shells) {
    it(`runs from ${sh.name} and records the event`, { skip: !sh.argv("x") && `${sh.name} is not on this platform` }, () => {
      const id = `hookcmd-${sh.name.replace(/\W/g, "")}`;
      const [file, args] = sh.argv(hookCommand("UserPromptSubmit"))!;
      const payload = { session_id: id, hook_event_name: "UserPromptSubmit", prompt: `hello from ${sh.name}`, cwd: home, transcript_path: join(home, "t.jsonl") };
      // node must be found on PATH by name, as an agent would run it.
      const r = spawnSync(file, args, { env: { ...env, PATH: [dirname(process.execPath), env.PATH ?? env.Path ?? ""].join(win ? ";" : ":") }, input: JSON.stringify(payload), encoding: "utf8", timeout: 60_000, windowsVerbatimArguments: sh.name === "cmd.exe" });
      assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
      const show = cli(["show", id]);
      assert.equal(show.status, 0, show.stderr);
      assert.match(show.stdout, new RegExp(`hello from ${sh.name.replace(".", "\\.")}`));
    });
  }
});
