// What init prints after its plan: one outcome per agent, the one its plan row gave it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { CLI } from "../_cli.ts";
import { fakeBin, tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

describe("init's summary agrees with the plan rows above it", () => {
  let env: TmpEnv;
  let hook: string;
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: env.home, env: { ...process.env, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stderr: r.stderr };
  };

  before(() => {
    env = tmpEnv();
    hook = join(env.root, "dist", "hook.mjs");
    writeFile(hook, "// hook\n");
    process.env.CLAUDE_CONFIG_DIR = join(env.home, ".claude");
    fakeBin(env, "agy", "1.3.0");
    fakeBin(env, "claude", "2.1.319 (Claude Code)");
  });
  after(() => env.restore());

  test("an agent set up by an earlier run is already set up, whatever else this run writes", () => {
    const init = ["init", "--yes", "--no-mcp", "--no-import", "--agent", "antigravity"];
    assert.equal(run(init).status, 0);

    // Claude Code is new. Antigravity CLI was set up by the run above.
    const r = run([...init, "--agent", "claude-code"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^ {2}Antigravity CLI \(user scope\)\n {4}already set up$/m);
    assert.match(r.stderr, /^✓ Already set up: Antigravity CLI \(hooks\)\n✓ Set up Claude Code \(hooks\)\n {2}Recording starts with the next session: start a new Claude Code session\./m);
    assert.doesNotMatch(r.stderr, /Set up Antigravity|Antigravity CLI and Claude Code/);

    // Only coding.sh's own config is written again: no agent is set up by this run.
    rmSync(join(env.dataHome, "config.toml"));
    const again = run([...init, "--agent", "claude-code"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /^ {4}create {2}.*config\.toml$/m);
    assert.match(again.stderr, /^✓ Already set up: Antigravity CLI and Claude Code \(hooks\)$/m);
    assert.doesNotMatch(again.stderr, /^✓ Set up/m);
    assert.doesNotMatch(again.stderr, /Recording starts/);
  });
});
