// coding.sh doctor: an agent that cannot capture is a warning row with its blocker and the
// file and line to change, never a check mark and a closing "ok" (EZ-2). Temp HOME,
// CODING_SH_HOME and CODEX_HOME; no Codex trust state is written.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeBin, tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";
import { pluginPath } from "../../src/adapters/opencode.ts";
import { cliCommand, nextStepBin, runCommand } from "../../src/cli/next-steps.ts";
import { CLI, seed, session } from "../query/_seed.ts";

interface Warning {
  check: string;
  agent?: string;
  message: string;
  blockers?: string[];
  next?: string;
}
interface Doc {
  ok: boolean;
  warnings: Warning[];
  agents: { id: string; installed: boolean; hooked: boolean; blockers: string[] }[];
}

describe("doctor: an agent that cannot capture", () => {
  let env: TmpEnv;
  let config: string;
  let cwd: string;
  let hook: string;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd, env: { ...process.env, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1", ...extra }, encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  // The CLI as doctor names it in the shell running these tests: codingsh in PowerShell or cmd.
  const bin = nextStepBin(process.env);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  before(async () => {
    env = tmpEnv();
    // Outside any git repo, a codex on PATH, hooks switched off in its config, no coding.sh hook.
    cwd = join(env.home, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    // What init installs: a stub, so the test needs no built dist/.
    hook = join(env.root, "dist", "hook.mjs");
    writeFile(hook, "// hook\n");
    process.env.CODEX_HOME = join(env.home, ".codex");
    config = join(process.env.CODEX_HOME, "config.toml");
    writeFile(config, 'model = "gpt-5"\n\n[features]\nhooks = false\n');
    fakeBin(env, "codex", "codex-cli 0.166.0");
    // One Codex session that ended 10 seconds ago.
    const now = Date.now();
    await seed(env.dataHome, { sessions: [session("codex-recent", { agent: "codex", startedAt: now - 70_000, endedAt: now - 10_000 })] });
  });
  after(() => env.restore());

  test("the row is a warning with the blocker, the file and line to change, and no closing ok", () => {
    const r = run(["doctor"]);
    assert.equal(r.status, 0, r.stderr);
    const row = r.stderr.split("\n").find((l) => l.includes("Codex CLI"));
    assert.ok(row, r.stderr);
    assert.match(row, /^! Codex CLI\s+v0\.166\.0, events arriving, hook not in user config, last event \d+s ago$/);
    assert.doesNotMatch(r.stderr, /✓ Codex CLI/);
    assert.match(r.stderr, /hooks are disabled in config\.toml/);
    assert.ok(r.stderr.includes(`${config}:4`), `names the file and line: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`${esc(bin)} init --agent codex`));
    // Host apps found on this machine (T3 Code) can add to the count; with --agent it is exact.
    const last = r.stdout.trimEnd().split("\n").at(-1)!;
    assert.notEqual(last, "ok");
    assert.match(last, /^\d+ agents? not capturing$/);
    assert.equal(run(["doctor", "--agent", "codex"]).stdout, "1 agent not capturing\n");
  });

  test("--json lists it under warnings; ok and the exit code stay about the spool and the store", () => {
    const r = run(["doctor", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(r.stdout) as Doc;
    assert.equal(doc.ok, true);
    const codex = doc.agents.find((a) => a.id === "codex")!;
    assert.equal(codex.hooked, false);
    assert.equal(codex.blockers.length, 1);
    const w = doc.warnings.filter((x) => x.agent === "codex");
    assert.equal(w.length, 1, JSON.stringify(doc.warnings));
    assert.equal(w[0]!.check, "agent");
    assert.match(w[0]!.message, /^Codex CLI is not capturing: events arriving, hook not in user config$/);
    assert.match(w[0]!.blockers![0]!, /hooks are disabled in config\.toml/);
    assert.ok(w[0]!.blockers![0]!.includes(`${config}:4`));
    assert.equal(w[0]!.next, `${bin} init --agent codex`);
    assert.ok(!doc.warnings.some((x) => x.agent === "wrapper"), "the built-in wrapper is never a warning");
  });

  test("started with npx, every command it prints runs through npx", () => {
    // coding.sh is not on PATH then. The same nextStepBin names codingsh in PowerShell and cmd.
    const npxEnv = { ...process.env, npm_command: "exec" };
    const npx = process.platform === "win32" ? "npx -p coding.sh codingsh" : "npx coding.sh";
    const r = run(["doctor"], { npm_command: "exec" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`capture with ${esc(runCommand(npxEnv, "<cmd>"))}, `));
    assert.match(r.stderr, new RegExp(`Capture the agents without hooks:\\n\\s+${esc(npx)} init --agent codex`));
    assert.match(r.stderr, new RegExp(`route agents through it with ${esc(npx)} init --proxy`));
    assert.doesNotMatch(r.stderr, /(?<!npx |-p )coding\.sh (?:collector|doctor|ingest|init|proxy|run|show|uninstall|update)\b/);
    const doc = JSON.parse(run(["doctor", "--json"], { npm_command: "exec" }).stdout) as Doc;
    assert.equal(doc.warnings.find((x) => x.agent === "codex")!.next, `${npx} init --agent codex`);
    // A conformance flag without --conformance: the suggestion is a command too.
    const usage = run(["doctor", "--since", "7d", "--json"], { npm_command: "exec" });
    assert.equal(usage.status, 2, usage.stderr);
    assert.deepEqual((JSON.parse(usage.stderr) as { next: string[] }).next, ["Did you mean:", `${npx} doctor --conformance --since 7d`]);
  });

  test("with the hook installed and no blocker the row is a check mark and the last line is ok", () => {
    writeFile(config, 'model = "gpt-5"\n');
    try {
      // Claude Code's hooks need no trust step, so its row can be healthy in a test.
      fakeBin(env, "claude", "2.1.319 (Claude Code)");
      const PATH = process.env.PATH!;
      fakeBin(env, "codex", "codex-cli 0.166.0");
      assert.equal(process.env.PATH, PATH, "both stubs share one bin dir");
      const init = run(["init", "--yes", "--agent", "claude-code"]);
      assert.equal(init.status, 0, init.stderr);
      const r = run(["doctor", "--agent", "claude-code"]);
      assert.match(r.stderr, /^✓ Claude Code\s+v2\.1\.319, hooked in /m);
      assert.equal(r.stdout.trimEnd().split("\n").at(-1), "ok");
      const doc = JSON.parse(run(["doctor", "--agent", "claude-code", "--json"]).stdout) as Doc;
      assert.deepEqual(doc.warnings.filter((w) => w.check === "agent"), []);
      // Codex without the blocker is still a warning: events alone are not capture.
      const c = run(["doctor", "--agent", "codex"]);
      assert.match(c.stderr, /^! Codex CLI\s+v0\.166\.0, events arriving, hook not in user config, /m);
      assert.doesNotMatch(c.stderr, /hooks are disabled/);
      assert.equal(c.stdout.trimEnd().split("\n").at(-1), "1 agent not capturing");
    } finally {
      writeFile(config, 'model = "gpt-5"\n\n[features]\nhooks = false\n');
    }
  });
});

describe("doctor: an OpenCode plugin OpenCode will not run", () => {
  let env: TmpEnv;
  let cwd: string;
  let hook: string;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd, env: { ...process.env, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1", ...extra }, encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const setup = ["init", "--yes", "--agent", "opencode", "--no-mcp", "--no-import"];

  before(() => {
    env = tmpEnv();
    cwd = join(env.home, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    hook = join(env.root, "dist", "hook.mjs");
    writeFile(hook, "// hook\n");
  });
  after(() => env.restore());

  test("set up under OpenCode 1, run under OpenCode 2: a warning naming the command that rewrites the plugin, in Git Bash and PowerShell", () => {
    // OpenCode 1.x loads plugin/coding-sh.js, 2.x plugins/coding-sh.js; neither runs the other's.
    fakeBin(env, "opencode", "1.19.5");
    const init = run(setup);
    assert.equal(init.status, 0, init.stderr);
    fakeBin(env, "opencode", "opencode v2.3.2");
    const note = `${pluginPath({ scope: "user" }, 1)} is stale: OpenCode 2.3.2 will not run a plugin written for OpenCode 1.x`;
    for (const shell of [{ MSYSTEM: "MINGW64", SHELL: "/usr/bin/bash" }, { MSYSTEM: undefined, SHELL: undefined }]) {
      const fix = cliCommand({ ...process.env, ...shell }, ["init", "--agent", "opencode"]);
      const r = run(["doctor", "--agent", "opencode"], shell);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /^! OpenCode\s+v2\.3\.2, hooked but stale, no events yet$/m);
      assert.ok(r.stderr.includes(`\n  ${note}\n`), r.stderr);
      assert.match(r.stderr, new RegExp(`Rewrite the stale hooks:\\n\\s+${esc(fix)}\\n`));
      assert.equal(r.stdout, "1 agent not capturing\n");
      const doc = JSON.parse(run(["doctor", "--agent", "opencode", "--json"], shell).stdout) as Doc;
      assert.deepEqual(doc.agents.find((a) => a.id === "opencode")!.blockers, [note]);
      assert.deepEqual(
        doc.warnings.filter((w) => w.agent === "opencode").map((w) => [w.message, w.blockers, w.next]),
        [["OpenCode is not capturing: hooked but stale", [note], fix]],
      );
    }
    // init's plan writes the plugin for OpenCode 2 and removes the stale one, so it lists no blocker.
    interface Plan { agents: { id: string; changes: { path: string; action: string }[]; warnings: string[]; blockers: string[] }[] }
    const plan = JSON.parse(run([...setup, "--dry-run", "--json"]).stdout) as Plan;
    const oc = plan.agents.find((a) => a.id === "opencode")!;
    assert.deepEqual(oc.changes.map((ch) => [ch.path, ch.action]), [[pluginPath({ scope: "user" }, 2), "create"], [pluginPath({ scope: "user" }, 1), "delete"]]);
    assert.deepEqual([oc.warnings, oc.blockers], [[], []]);
    assert.doesNotMatch(run([...setup, "--dry-run"]).stdout, /stale/);
    // The command it names puts it right.
    assert.equal(run(setup).status, 0);
    const r = run(["doctor", "--agent", "opencode"]);
    assert.match(r.stderr, /^✓ OpenCode\s+v2\.3\.2, hooked/m);
    assert.doesNotMatch(r.stderr, /stale/);
    assert.equal(r.stdout, "ok\n");
  });
});

describe("doctor: an OpenCode plugin OpenCode still runs that differs from this CLI's", () => {
  let env: TmpEnv;
  let cwd: string;
  let hook: string;
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd, env: { ...process.env, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" }, encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  before(() => {
    env = tmpEnv();
    cwd = join(env.home, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    hook = join(env.root, "dist", "hook.mjs");
    writeFile(hook, "// hook\n");
  });
  after(() => env.restore());

  // An edited plugin still runs the hook, so OpenCode may be capturing. Before, doctor said it was
  // not, and the last line counted it with the agents that capture nothing.
  test("an edited plugin: may not be capturing, and the last line counts it as stale hooks", () => {
    fakeBin(env, "opencode", "1.19.5");
    assert.equal(run(["init", "--yes", "--agent", "opencode", "--no-mcp", "--no-import"]).status, 0);
    const plugin = pluginPath({ scope: "user" }, 1);
    writeFile(plugin, `${readFileSync(plugin, "utf8")}// edited by hand\n`);
    const note = `${plugin} is stale (differs from the plugin this CLI writes)`;
    const r = run(["doctor", "--agent", "opencode"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^! OpenCode\s+v1\.19\.5, hooked but stale, no events yet$/m);
    assert.ok(r.stderr.includes(`\n  ${note}\n`), r.stderr);
    assert.equal(r.stdout, "1 agent with stale hooks\n");
    const doc = JSON.parse(run(["doctor", "--agent", "opencode", "--json"]).stdout) as Doc;
    assert.deepEqual(
      doc.warnings.filter((w) => w.agent === "opencode").map((w) => [w.message, w.blockers, w.next]),
      [["OpenCode may not be capturing: hooked but stale", [note], cliCommand(process.env, ["init", "--agent", "opencode"])]],
    );
    // Next to an agent with no hooks, the last line counts each.
    fakeBin(env, "codex", "codex-cli 0.166.0");
    assert.equal(run(["doctor", "--agent", "opencode", "--agent", "codex"]).stdout, "1 agent not capturing, 1 with stale hooks\n");
  });
});

describe("doctor: no agent detected", () => {
  let env: TmpEnv;
  let cwd: string;
  let hook: string;
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd, env: { ...process.env, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1", ...extra }, encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  before(() => {
    env = tmpEnv();
    cwd = join(env.home, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    hook = join(env.root, "dist", "hook.mjs");
    writeFile(hook, "// hook\n");
    // A PATH with no agent on it.
    const bin = join(env.root, "bin");
    mkdirSync(bin, { recursive: true });
    process.env.PATH = bin;
  });
  after(() => env.restore());

  test("says so and names the wrapper command, in Git Bash, in PowerShell and in --json", () => {
    // The "Any command" row is always there, so a check for no rows at all never fired.
    for (const shell of [{ MSYSTEM: "MINGW64", SHELL: "/usr/bin/bash" }, { MSYSTEM: undefined, SHELL: undefined }]) {
      const cmd = runCommand({ ...process.env, ...shell }, "<cmd>");
      const r = run(["doctor"], shell);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /^✓ Any command\s+no hooks needed; /m);
      assert.match(r.stderr, new RegExp(`^! Agents\\s+none detected; capture any agent with ${esc(cmd)}$`, "m"));
      const doc = JSON.parse(run(["doctor", "--json"], shell).stdout) as Doc;
      assert.deepEqual(doc.agents.filter((a) => a.installed).map((a) => a.id), ["wrapper"]);
      assert.deepEqual(doc.warnings.filter((w) => w.check === "agents"), [{ check: "agents", message: "No agent detected", next: cmd }]);
    }
    // An agent on PATH: no such warning.
    fakeBin(env, "opencode", "1.19.5");
    const doc = JSON.parse(run(["doctor", "--json"]).stdout) as Doc;
    assert.deepEqual(doc.agents.filter((a) => a.installed).map((a) => a.id).sort(), ["opencode", "wrapper"]);
    assert.deepEqual(doc.warnings.filter((w) => w.check === "agents"), []);
    assert.doesNotMatch(run(["doctor"]).stderr, /none detected/);
  });
});
