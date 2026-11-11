// coding.sh doctor: an agent that cannot capture is a warning row with its blocker and the
// file and line to change, never a check mark and a closing "ok" (EZ-2). Temp HOME,
// CODING_SH_HOME and CODEX_HOME; no Codex trust state is written.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fakeBin, tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";
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
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd, env: { ...process.env, CODING_SH_HOOK_SOURCE: hook, CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_COLOR: "1" }, encoding: "utf8", timeout: 60_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

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
    assert.match(r.stderr, /coding\.sh init --agent codex/);
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
    assert.equal(w[0]!.next, "coding.sh init --agent codex");
    assert.ok(!doc.warnings.some((x) => x.agent === "wrapper"), "the built-in wrapper is never a warning");
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
