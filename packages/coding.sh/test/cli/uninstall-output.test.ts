// uninstall's help says what its --scope picks, and uninstall --dry-run ends as init --dry-run does:
// with "Dry run: nothing written." after the changes it prints.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { CLI } from "../_cli.ts";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

let t: TmpEnv;
let work: string;
let hook: string;
let nobin: string;

beforeEach(() => {
  t = tmpEnv();
  work = join(t.home, "work");
  mkdirSync(work);
  hook = join(t.root, "dist", "hook.mjs");
  writeFile(hook, "// hook\n");
  // No agent program on PATH: init sets up only the agent it is told to.
  nobin = join(t.root, "nobin");
  mkdirSync(nobin);
});
afterEach(() => t.restore());

function run(args: string[]) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], {
    cwd: work,
    env: { ...process.env, PATH: nobin, USERPROFILE: t.home, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("uninstall --help", () => {
  test("says --scope picks the config to remove coding.sh from", () => {
    const u = run(["uninstall", "--help"]);
    assert.equal(u.status, 0, u.stderr);
    assert.match(u.stdout, /^ +--scope <SCOPE> +Remove from user or project config \(default: user\)$/m);
    assert.doesNotMatch(u.stdout, /Install into/);
    // init keeps its own wording.
    assert.match(run(["init", "--help"]).stdout, /^ +--scope <SCOPE> +Install into user or project config \(default: user\)$/m);
  });
});

describe("uninstall --dry-run", () => {
  test("prints the changes, then Dry run: nothing written., as init --dry-run does", () => {
    assert.equal(run(["init", "--yes", "--agent", "claude-code", "--no-mcp", "--no-import"]).status, 0);
    const settings = join(t.home, ".claude", "settings.json");
    const text = readFileSync(settings, "utf8");

    const r = run(["uninstall", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /settings\.json {2}\(claude-code\)$/m, "the change is on stdout");
    assert.ok(r.stderr.endsWith("  Dry run: nothing written.\n"), r.stderr);
    assert.equal(readFileSync(settings, "utf8"), text, "nothing written");

    // Removed already: nothing to remove, so no dry run line.
    assert.equal(run(["uninstall", "--yes"]).status, 0);
    const again = run(["uninstall", "--dry-run"]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, "");
    assert.match(again.stderr, /No coding\.sh hooks or MCP entries installed/);
    assert.doesNotMatch(again.stderr, /Dry run/);
  });
});
