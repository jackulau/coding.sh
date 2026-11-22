// The status line has its own restore point: uninstalling it after `init` puts
// back the bytes init wrote (every hook), and a later `uninstall` still
// restores the file as it was before init.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { claudeCode } from "../../src/adapters/claude-code.ts";
import { run } from "../../src/cli/commands/statusline.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";

describe("statusline after init", () => {
  let t: TmpEnv;
  before(() => {
    t = tmpEnv();
  });
  after(() => t.restore());
  const settings = () => join(t.home, ".claude", "settings.json");
  const hook = () => join(t.dataHome, "bin", "hook.mjs");
  const env = (): NodeJS.ProcessEnv => ({ HOME: t.home, CODING_SH_HOME: t.dataHome, CLAUDE_CONFIG_DIR: join(t.home, ".claude"), PATH: process.env.PATH });
  const ctx = (action: string): CommandContext => {
    const e = env();
    const out = new Output({ json: false, env: e, stdout: { write: () => true, isTTY: false }, stderr: { write: () => true, isTTY: false }, stdin: { isTTY: false } });
    return { action, flags: {}, positionals: [], rest: [], out, env: e, cwd: t.home, debug: false, signal: new AbortController().signal };
  };

  for (const existing of [false, true]) {
    test(`init, status line install, uninstall (${existing ? "settings.json existed" : "init created it"})`, async () => {
      const original = '{\n  "model": "opus"\n}\n';
      if (existing) {
        mkdirSync(dirname(settings()), { recursive: true });
        writeFileSync(settings(), original);
      } else if (existsSync(settings())) await claudeCode.uninstall({ scope: "user", dryRun: false });
      await claudeCode.install({ hookCommand: hook(), scope: "user", dryRun: false });
      const afterInit = readFileSync(settings(), "utf8");
      assert.match(afterInit, /_codingsh/);

      assert.equal(await run(ctx("install")), 0);
      assert.match(readFileSync(settings(), "utf8"), /"statusLine"/);
      assert.equal(await run(ctx("uninstall")), 0);
      assert.ok(existsSync(settings()), "settings.json is still there");
      assert.equal(readFileSync(settings(), "utf8"), afterInit, "the bytes init wrote, every hook");

      await claudeCode.uninstall({ scope: "user", dryRun: false });
      if (existing) assert.equal(readFileSync(settings(), "utf8"), original, "uninstall restores the pre-init bytes");
      else assert.ok(!existsSync(settings()), "init created it, uninstall removes it");
    });
  }
});

// --json prints exactly one JSON document on stdout for every outcome, as other write commands do.
describe("statusline install and uninstall with --json", () => {
  let t: TmpEnv;
  before(() => {
    t = tmpEnv();
  });
  after(() => t.restore());
  const settings = () => join(t.home, ".claude", "settings.json");
  const runJson = async (action: string, flags: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const e: NodeJS.ProcessEnv = { HOME: t.home, CODING_SH_HOME: t.dataHome, CLAUDE_CONFIG_DIR: join(t.home, ".claude"), PATH: process.env.PATH };
    let stdout = "";
    const out = new Output({ json: true, env: e, stdout: { write: (s: string) => ((stdout += s), true), isTTY: false }, stderr: { write: () => true, isTTY: false }, stdin: { isTTY: false } });
    const ctx: CommandContext = { action, flags: { json: true, ...flags }, positionals: [], rest: [], out, env: e, cwd: t.home, debug: false, signal: new AbortController().signal };
    assert.equal(await run(ctx), 0);
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 1, `one JSON document for ${action} ${JSON.stringify(flags)}: ${stdout}`);
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  };

  test("planned, installed, unchanged, removed", async () => {
    assert.deepEqual(await runJson("install", { "dry-run": true }), { outcome: "planned", action: "install", path: settings() });
    assert.ok(!existsSync(settings()), "a dry run writes nothing");
    assert.deepEqual(await runJson("install"), { outcome: "installed", path: settings() });
    assert.match(readFileSync(settings(), "utf8"), /coding\.sh statusline/);
    assert.deepEqual(await runJson("install"), { outcome: "unchanged", path: settings() });
    assert.deepEqual(await runJson("uninstall", { "dry-run": true }), { outcome: "planned", action: "uninstall", path: settings() });
    assert.deepEqual(await runJson("uninstall"), { outcome: "removed", path: settings() });
    assert.deepEqual(await runJson("uninstall"), { outcome: "unchanged", path: settings() });
  });
});
