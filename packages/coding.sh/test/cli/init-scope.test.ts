// INS-10: `coding.sh init --scope project` for an agent that already has the
// coding.sh hooks in user scope (or the reverse) would make agents that don't
// dedupe identical commands capture every event twice. init warns and skips
// those hooks unless --force.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { run } from "../../src/cli/commands/init.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

let t: TmpEnv;
beforeEach(() => {
  t = tmpEnv();
  process.env.PATH = join(t.root, "nobin"); // no agent binaries, no real installs found
  process.env.NO_UPDATE_NOTIFIER = "1";
  const hook = join(t.root, "dist", "hook.mjs");
  writeFile(hook, "// hook\n");
  process.env.CODING_SH_HOOK_SOURCE = hook;
});
afterEach(() => {
  delete process.env.CODING_SH_HOOK_SOURCE;
  t.restore();
});

async function init(cwd: string, flags: Record<string, string | string[] | boolean>, json = false): Promise<{ code: number; stderr: string; stdout: string }> {
  let stderr = "";
  let stdout = "";
  const out = new Output({ json, env: process.env, stdout: { write: (s: string) => ((stdout += s), true), isTTY: false }, stderr: { write: (s: string) => ((stderr += s), true), isTTY: false }, stdin: { isTTY: false } });
  const c: CommandContext = { flags: { agent: ["cursor"], yes: true, mcp: false, ...flags }, positionals: [], rest: [], out, env: process.env, cwd, debug: false, signal: new AbortController().signal };
  return { code: await run(c), stderr, stdout };
}

describe("init with coding.sh hooks already in the other scope", () => {
  test("project-scope init skips an agent hooked in user scope, and warns; --force installs both", async () => {
    const proj = join(t.root, "proj");
    mkdirSync(proj, { recursive: true });
    await init(proj, { scope: "user" });
    assert.ok(existsSync(join(t.home, ".cursor", "hooks.json")), "user scope installed");

    const r = await init(proj, { scope: "project" });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /skipping hooks: already installed in user scope/);
    assert.match(r.stderr, /--force/);
    assert.ok(!existsSync(join(proj, ".cursor", "hooks.json")), "project hooks not written");

    const f = await init(proj, { scope: "project", force: true });
    assert.equal(f.code, 0);
    assert.match(readFileSync(join(proj, ".cursor", "hooks.json"), "utf8"), /hook\.(?:mjs|sh)/);
    assert.match(f.stderr, /also hooked in user scope/);
  });

  test("user-scope init warns about project-scope hooks in the current project", async () => {
    const proj = join(t.root, "proj2");
    mkdirSync(proj, { recursive: true });
    await init(proj, { scope: "project" });
    const r = await init(proj, { scope: "user" });
    assert.match(r.stderr, /skipping hooks: already installed in project scope/);
    assert.ok(!existsSync(join(t.home, ".cursor", "hooks.json")));
  });

  // qa:capture-10: the repo root's .claude/settings.local.json and the user's settings both run in a
  // session started at the root; init run from packages/app looked only at packages/app/.claude.
  test("user-scope init in a subdirectory of a repo reports project-scope hooks at the repo root", async () => {
    const repo = join(t.root, "repo");
    const sub = join(repo, "packages", "app");
    mkdirSync(sub, { recursive: true });
    writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    const local = join(repo, ".claude", "settings.local.json");
    await init(repo, { agent: ["claude-code"], scope: "project", import: false });
    assert.match(readFileSync(local, "utf8"), /hook\.(?:mjs|sh)/);

    const plan = await init(sub, { agent: ["claude-code"], scope: "user", import: false, "dry-run": true }, true);
    const agent = (JSON.parse(plan.stdout) as { agents: { id: string; otherScope: unknown; skipped: boolean }[] }).agents[0]!;
    assert.deepEqual([agent.id, agent.otherScope, agent.skipped], ["claude-code", { scope: "project", files: [local] }, true]);

    const r = await init(sub, { agent: ["claude-code"], scope: "user", import: false });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /skipping hooks: already installed in project scope \(.*settings\.local\.json\)/);
    assert.ok(!existsSync(join(t.home, ".claude", "settings.json")), "user hooks not written");
    // Outside the repo nothing is in the way.
    const outside = join(t.root, "elsewhere");
    mkdirSync(outside, { recursive: true });
    assert.doesNotMatch((await init(outside, { agent: ["claude-code"], scope: "user", import: false, "dry-run": true })).stderr, /skipping hooks|also hooked in/);
  });

  test("a project dir that is the home directory is not a conflict with itself", async () => {
    // Cursor's project file under ~ is ~/.cursor/hooks.json, the user file.
    const r1 = await init(t.home, { scope: "user" });
    assert.equal(r1.code, 0);
    const r2 = await init(t.home, { scope: "user" });
    assert.doesNotMatch(r2.stderr, /skipping hooks|also hooked in|already installed in/);
  });
});
