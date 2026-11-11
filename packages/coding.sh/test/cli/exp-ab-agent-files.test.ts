// `coding.sh exp ab` gives each arm the files the session's agent loads. Claude
// Code never reads AGENTS.md, so an AGENTS.md-only edit tested on Claude Code
// sessions is the same context in A and B: the command stops with "no arm
// difference" before any model call, and warns when only some sessions skip it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { unloadedEdits } from "../../src/cli/commands/exp-ab.ts";
import { importedBy, loadedBy } from "../../src/core/harness-paths.ts";
import { injectContext, type FrozenPrefix } from "../../src/experiments/continuation.ts";
import { claimSession, putSession } from "../helpers-decision.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
let root = "";

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-expab-agent-")));
});
after(() => rmSync(root, { recursive: true, force: true }));

async function setup(name: string, agents: string[], claudeMd = "Keep answers short.\n"): Promise<{ repo: string; env: NodeJS.ProcessEnv }> {
  const home = join(root, name, "home");
  const repo = join(root, name, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    CODING_SH_NO_AUTO_INGEST: "1",
    ANTHROPIC_API_KEY: "sk-stub",
    // Nothing listens here: a dry run makes no model call.
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
  };
  const git = (...a: string[]) => assert.equal(spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  writeFileSync(join(repo, "AGENTS.md"), "Keep answers short.\n");
  writeFileSync(join(repo, "CLAUDE.md"), claudeMd);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    const now = Date.now();
    for (const [i, agent] of agents.entries()) await putSession(ctx.index, claimSession(`sess-${name}-${i}`, { cwd: repo, startedAt: now - (i + 1) * 3600_000, agent }, `src/mod${i}.js`));
  } finally {
    await ctx.close();
  }
  // Only AGENTS.md changes.
  writeFileSync(join(repo, "AGENTS.md"), "Keep answers short.\nRun the tests before you say you are done, and say what it printed.\n");
  return { repo, env };
}

const cli = (e: { repo: string; env: NodeJS.ProcessEnv }, args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: e.repo, env: e.env, encoding: "utf8" });

describe("exp ab: files the session's agent loads", () => {
  it("an AGENTS.md-only edit on Claude Code sessions stops with no arm difference", async () => {
    const e = await setup("claude", ["claude-code", "claude-code"]);
    const r = cli(e, ["exp", "ab", "--dry-run"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /No arm difference: Claude Code does not load AGENTS\.md/);
    assert.match(r.stderr, /CLAUDE\.md for Claude Code/);
    // The store has no Codex sessions: --agent codex would find nothing to test.
    assert.doesNotMatch(r.stderr, /--agent codex/);
  });

  it("with Codex sessions in the store too, it suggests --agent codex", async () => {
    const e = await setup("claude-and-codex", ["claude-code", "claude-code"]);
    const { openContext } = await import("../../src/core/context.ts");
    const ctx = await openContext({ env: e.env, cwd: e.repo });
    try {
      // Before the --since window: in the store, but not a case of this A/B.
      await putSession(ctx.index, claimSession("sess-old-codex", { cwd: e.repo, startedAt: Date.now() - 90 * 86400_000, agent: "codex" }, "src/old.js"));
    } finally {
      await ctx.close();
    }
    const r = cli(e, ["exp", "ab", "--dry-run"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--agent codex/);
  });

  it("a CLAUDE.md that imports AGENTS.md (@AGENTS.md) makes an AGENTS.md edit a real difference for Claude Code", async () => {
    const e = await setup("imports", ["claude-code", "claude-code"], "@AGENTS.md\n");
    const r = cli(e, ["exp", "ab", "--dry-run"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /2 decision points from 2 sessions/);
    assert.doesNotMatch(r.stderr, /does not load/);
  });

  it("on Codex sessions the same edit is a real difference", async () => {
    const e = await setup("codex", ["codex", "codex"]);
    const r = cli(e, ["exp", "ab", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 decision points from 2 sessions/);
    assert.doesNotMatch(r.stderr, /does not load/);
  });

  it("mixed sessions run, with a warning naming how many cases see no change", async () => {
    const e = await setup("mixed", ["claude-code", "codex"]);
    const r = cli(e, ["exp", "ab", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Claude Code does not load AGENTS\.md: the edit changes nothing for 1 of 2 cases/);
  });

  it("unloadedEdits and injectContext agree on what each agent reads", () => {
    const a = [{ path: "AGENTS.md", text: "x\n" }, { path: "CLAUDE.md", text: "y\n" }];
    const b = [{ path: "AGENTS.md", text: "x\nmore\n" }, { path: "CLAUDE.md", text: "y\n" }];
    assert.equal(unloadedEdits(a, b, ["claude-code"]).none, true);
    assert.equal(unloadedEdits(a, b, ["codex"]).none, false);
    assert.equal(unloadedEdits(a, b, [undefined]).none, false, "an unknown agent may load anything");
    assert.equal(loadedBy("claude-code", ".claude/skills/pdf/SKILL.md"), true);
    assert.equal(loadedBy("codex", "CLAUDE.md"), false);
    assert.equal(loadedBy("codex", "src/a.ts"), undefined);
    const prefix = (agent: string): FrozenPrefix => ({ v: 1, agent, tools: [], messages: [{ role: "user", text: "hi" }] });
    assert.deepEqual(injectContext(b, prefix("claude-code")).map((f) => f.path), ["CLAUDE.md"]);
    assert.deepEqual(injectContext(b, prefix("codex")).map((f) => f.path), ["AGENTS.md"]);
    // An import pulls the file in for the agent whose file imports it, and only then.
    const ia = [{ path: "AGENTS.md", text: "x\n" }, { path: "CLAUDE.md", text: "See `@not-this` and:\n@AGENTS.md\n" }];
    const ib = [{ path: "AGENTS.md", text: "x\nmore\n" }, ia[1]!];
    assert.equal(unloadedEdits(ia, ib, ["claude-code"]).none, false);
    assert.deepEqual(injectContext(ib, prefix("claude-code")).map((f) => f.path).sort(), ["AGENTS.md", "CLAUDE.md"]);
    assert.deepEqual([...importedBy("claude-code", ib)], ["AGENTS.md"]);
    assert.deepEqual([...importedBy("codex", ib)], [], "Codex does not load CLAUDE.md, so its import does not count");
  });
});
