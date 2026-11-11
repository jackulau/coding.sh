// `coding.sh refine mine --agent <name>` where no session in the window is of
// that agent: the empty result names the agents the sessions here are from and
// suggests the closest one, instead of "0 sessions" with no way forward.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { putSession, sessionEvents } from "../helpers-decision.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
let root = "";
let repo = "";
let env: NodeJS.ProcessEnv = {};

const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-mine-agent-")));
  const home = join(root, "home");
  repo = join(root, "repo");
  for (const d of [home, repo]) mkdirSync(d);
  env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), NO_COLOR: "1", CODING_SH_NO_UPDATE_CHECK: "1", CODING_SH_NO_AUTO_INGEST: "1" };
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo, env }).status, 0);
  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    const t0 = Date.now() - 3600_000;
    for (const [i, agent] of ["claude-code", "codex", "codex"].entries()) {
      await putSession(ctx.index, sessionEvents(`s${i}`, { cwd: repo, startedAt: t0 + i * 60_000, agent }, [["session.start", {}], ["user.message", { text: "Fix it." }], ["assistant.message", { text: "Done." }]]));
    }
  } finally {
    await ctx.close();
  }
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("refine mine --agent with no matching session", () => {
  it("names the agents seen and suggests the closest", () => {
    const r = cli("refine", "mine", "--agent", "codx");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /No session of codx since \d{4}-\d\d-\d\d under .*repo: the 3 sessions are codex \(2\), claude-code \(1\)/);
    assert.match(r.stderr, /coding\.sh refine mine --agent codex\n/);
    assert.doesNotMatch(r.stderr, /--min-support 2,1/);
  });

  it("an unrelated name suggests the agent with the most sessions", () => {
    const r = cli("refine", "mine", "--agent", "nosuchagent");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /No session of nosuchagent since /);
    assert.match(r.stderr, /coding\.sh refine mine --agent codex\n/);
  });

  it("--json carries the agents seen; a matching agent leaves them out", () => {
    const miss = JSON.parse(cli("refine", "mine", "--agent", "nosuchagent", "--json").stdout) as { analyzed: number; agentsSeen?: { agent: string; sessions: number }[] };
    assert.equal(miss.analyzed, 0);
    assert.deepEqual(miss.agentsSeen, [{ agent: "codex", sessions: 2 }, { agent: "claude-code", sessions: 1 }]);
    const hit = JSON.parse(cli("refine", "mine", "--agent", "codex", "--json").stdout) as { analyzed: number; agentsSeen?: { agent: string; sessions: number }[] };
    assert.equal(hit.analyzed, 2);
    assert.equal(hit.agentsSeen, undefined);
  });
});
