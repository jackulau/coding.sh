// init on what it can't do or does not need to: an agent whose settings file it
// can't parse, the bin files a dry run names, and an agent that needs no hooks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeBin, tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";
import { CLI } from "../query/_seed.ts";

describe("init: failures, the dry-run plan, agents without hooks", () => {
  let env: TmpEnv;
  let cwd: string;
  let hook: string;
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd, env: { ...process.env, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  before(() => {
    env = tmpEnv();
    cwd = join(env.home, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    hook = join(env.root, "dist", "hook.mjs");
    writeFile(hook, "// hook\n");
    process.env.CLAUDE_CONFIG_DIR = join(env.home, ".claude");
    fakeBin(env, "claude", "2.1.319 (Claude Code)");
    fakeBin(env, "aider", "aider 0.86.1");
  });
  after(() => env.restore());

  test("a settings file it can't parse: exit 1, outcome failed, the next step, and the file byte for byte as it was", () => {
    const settings = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
    const text = '{ "hooks": {,, }\n';
    writeFile(settings, text);
    try {
      for (let pass = 0; pass < 2; pass++) {
        const r = run(["init", "--yes", "--agent", "claude-code", "--no-import", "--no-mcp"]);
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stderr, /can't install hooks: cannot parse .*settings\.json/);
        assert.match(r.stderr, /fix the file, then run coding\.sh init again/);
        assert.doesNotMatch(r.stderr, /Open the viewer/);
        const j = run(["init", "--yes", "--agent", "claude-code", "--no-import", "--no-mcp", "--json"]);
        assert.equal(j.status, 1);
        assert.equal((JSON.parse(j.stdout) as { outcome: string }).outcome, "failed");
        assert.equal(readFileSync(settings, "utf8"), text);
      }
    } finally {
      rmSync(settings);
    }
  });

  test("a settings file it can't parse: the MCP server is not registered either", () => {
    const settings = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
    const state = join(process.env.CLAUDE_CONFIG_DIR!, ".claude.json");
    writeFile(settings, '{ "hooks": { "PreToolUse": [ , ] }\n');
    rmSync(state, { force: true });
    try {
      const r = run(["init", "--yes", "--agent", "claude-code", "--no-import", "--json"]);
      assert.equal(r.status, 1, r.stderr);
      const j = JSON.parse(r.stdout) as { outcome: string; agents: { mcp: unknown }[] };
      assert.equal(j.outcome, "failed");
      assert.equal(j.agents[0]!.mcp, null);
      assert.equal(existsSync(state), false, "no .claude.json with an MCP entry");
    } finally {
      rmSync(settings);
    }
  });

  test("the dry-run plan names every file the run creates under bin/", () => {
    const bin = join(env.dataHome, "bin");
    rmSync(bin, { recursive: true, force: true });
    const plan = run(["init", "--dry-run", "--agent", "claude-code", "--no-import", "--json"]);
    assert.equal(plan.status, 0, plan.stderr);
    const planned = (JSON.parse(plan.stdout) as { changes: { path: string; action: string }[] }).changes.filter((ch) => ch.path.startsWith(bin)).map((ch) => ch.path.slice(bin.length + 1)).sort();
    const text = run(["init", "--dry-run", "--agent", "claude-code", "--no-import"]).stdout;
    for (const f of planned) assert.ok(text.includes(join(bin, f)) || text.includes(f), `${f} in the text plan: ${text}`);
    assert.equal(run(["init", "--yes", "--agent", "claude-code", "--no-import"]).status, 0);
    assert.deepEqual(planned, readdirSync(bin).sort());
    // Set up: the plan names nothing under bin/.
    const again = JSON.parse(run(["init", "--dry-run", "--agent", "claude-code", "--no-import", "--json"]).stdout) as { changes: { path: string }[] };
    assert.deepEqual(again.changes.filter((ch) => ch.path.startsWith(bin)), []);
  });

  test("Aider needs no hooks: init says how to capture it, not that it is already set up", () => {
    const r = run(["init", "--yes", "--agent", "aider", "--no-import"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /no hooks needed; capture with coding\.sh run -- aider/);
    assert.doesNotMatch(r.stderr, /already set up/i);
    assert.match(run(["init", "--dry-run", "--agent", "aider", "--no-import"]).stdout, /no hooks needed; capture with coding\.sh run -- aider/);
  });

  test("Aider not installed: the note says how to capture it, not that hooks fire", () => {
    const dir = join(env.root, "bin");
    for (const f of readdirSync(dir)) if (f.startsWith("aider")) rmSync(join(dir, f));
    try {
      const out = run(["init", "--dry-run", "--agent", "aider", "--no-import"]).stdout;
      assert.match(out, /Aider is not installed on this machine; capture it with coding\.sh run -- aider once it is/);
      assert.doesNotMatch(out, /hooks fire/);
    } finally {
      fakeBin(env, "aider", "aider 0.86.1");
    }
  });
});
