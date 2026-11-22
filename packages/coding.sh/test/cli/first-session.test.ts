// The first minutes after `coding.sh init`: nothing is captured until the user
// starts a new agent session (one that was open while init ran may not have
// loaded the hooks). Every empty state must say that once capture is set up,
// instead of sending the user back to `coding.sh init`, which changes nothing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { captureSetUp, noSessionsHint, noSessionsNext, noSessionsNextLines } from "../../src/cli/first-session.ts";
import { nextStepBin } from "../../src/cli/next-steps.ts";
import { firstSessionNote } from "../../src/cli/commands/init.ts";
import { run as status } from "../../src/cli/commands/status.ts";
import { run as sessions } from "../../src/cli/commands/sessions.ts";
import { run as show } from "../../src/cli/commands/show.ts";
import { CliError, Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { RawClient, worldAt } from "../mcp/helpers.ts";

const roots: string[] = [];
const envs: TmpEnv[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  for (const t of envs.splice(0).reverse()) t.restore();
});

/**
 * An empty store under a temp HOME; `setUp` writes the hook bin the way init does.
 * process.env moves too (tmpEnv): adapters find agent transcripts through it.
 */
function home(setUp: boolean): { env: NodeJS.ProcessEnv } {
  const t = tmpEnv();
  envs.push(t);
  process.env.PATH = join(t.root, "nobin");
  mkdirSync(join(t.dataHome, "bin"), { recursive: true });
  if (setUp) writeFileSync(join(t.dataHome, "bin", "hook.mjs"), "// hook\n");
  return { env: { ...process.env, NO_COLOR: "1", CODING_SH_NO_AUTO_INGEST: "1", NO_UPDATE_NOTIFIER: "1" } };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function runCmd(fn: (c: CommandContext) => Promise<number>, env: NodeJS.ProcessEnv, positionals: string[] = [], json = false) {
  const cap = { stdout: "", stderr: "", code: undefined as number | undefined, error: undefined as unknown };
  const out = new Output({
    json,
    env,
    stdout: { write: (s: string) => ((cap.stdout += s), true), isTTY: false },
    stderr: { write: (s: string) => ((cap.stderr += s), true), isTTY: false },
    stdin: { isTTY: false },
  });
  const c: CommandContext = { flags: {}, positionals, rest: [], out, env, cwd: env.HOME!, debug: false, signal: new AbortController().signal };
  try {
    cap.code = await fn(c);
  } catch (e) {
    cap.error = e;
  }
  return cap;
}

describe("no sessions yet: the next step depends on whether init ran", () => {
  test("helpers: init before setup, a new agent session (and doctor) after", () => {
    const before = home(false).env;
    const after = home(true).env;
    assert.equal(captureSetUp(before), false);
    assert.equal(captureSetUp(after), true);
    assert.deepEqual(noSessionsNext(before, "linux"), { label: "Install capture hooks", command: `${nextStepBin(before, "linux")} init` });
    const n = noSessionsNext(after, "linux");
    assert.equal(n.command, `${nextStepBin(after, "linux")} doctor`);
    assert.match(n.label, /^Capture is set up\. Start a new agent session to record it\. Sessions that were already open may not have loaded the hooks/);
    assert.match(noSessionsHint(before), new RegExp(`Run \`${esc(nextStepBin(before))} init\``));
    assert.match(noSessionsHint(after), /Capture is set up: Start a new agent session/);
    assert.doesNotMatch(noSessionsHint(after), /coding\.?sh init/);
  });

  test("the step names the CLI as the user's shell runs it", () => {
    // PowerShell and cmd: no MSYSTEM or SHELL. There `coding.sh` opens npm's sh shim; `codingsh` runs.
    const ps = (setUp: boolean) => ({ ...home(setUp).env, MSYSTEM: undefined, SHELL: undefined, npm_command: undefined });
    const before = ps(false);
    const after = ps(true);
    assert.equal(noSessionsNext(before, "win32").command, "codingsh init");
    assert.deepEqual(noSessionsNextLines(after, "win32"), [`${noSessionsNext(after).label}:`, "codingsh doctor"]);
    assert.match(noSessionsHint(before, "win32"), /Run `codingsh init`/);
    assert.match(noSessionsHint(after, "win32"), /check capture with `codingsh doctor`/);
    // Git Bash keeps coding.sh; started with npx, the step runs through npx.
    assert.equal(noSessionsNext({ ...before, MSYSTEM: "MINGW64" }, "win32").command, "coding.sh init");
    assert.equal(noSessionsNext({ ...before, npm_command: "exec" }, "linux").command, "npx coding.sh init");
    assert.equal(noSessionsNext({ ...before, npm_command: "exec" }, "win32").command, "npx -p coding.sh codingsh init");
  });

  test("show latest, status and sessions on an empty store", async () => {
    for (const setUp of [false, true]) {
      const { env } = home(setUp);
      const want = `${nextStepBin(env)} ${setUp ? "doctor" : "init"}`;
      const s = await runCmd(show, env, ["latest"]);
      assert.ok(s.error instanceof CliError, String(s.error));
      assert.equal((s.error as CliError).next[1], want, `show latest (set up: ${setUp})`);
      if (setUp) assert.match((s.error as CliError).next[0]!, /Start a new agent session/);
      const st = await runCmd(status, env);
      assert.equal(st.code, 0);
      assert.match(st.stderr, new RegExp(`\\n {4}${esc(want)}\\n`), `status (set up: ${setUp}):\n${st.stderr}`);
      const ls = await runCmd(sessions, env);
      assert.equal(ls.code, 0);
      assert.match(ls.stderr, /No sessions/);
      assert.match(ls.stderr, new RegExp(esc(want)), `sessions (set up: ${setUp}):\n${ls.stderr}`);
    }
  });

  test("init's closing note names the agents that just got hooks", () => {
    assert.equal(firstSessionNote(["Claude Code"]), "Recording starts with the next session: start a new Claude Code session. Sessions already open may not have loaded the hooks");
    assert.match(firstSessionNote(["Claude Code", "Codex CLI"]), /start a new session of any of them/);
  });

  test("the MCP status tool and session_current say the same", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-first-mcp-")));
    roots.push(root);
    const w = worldAt(root);
    mkdirSync(join(w.env.CODING_SH_HOME!, "bin"), { recursive: true });
    writeFileSync(join(w.env.CODING_SH_HOME!, "bin", "hook.mjs"), "// hook\n");
    const c = new RawClient({ ...w.env, CODING_SH_NO_AUTO_INGEST: "1" }, w.repo);
    try {
      await c.initialize();
      const st = await c.call("status", {});
      assert.match(((st.structuredContent as { hints: string[] }).hints ?? []).join("\n"), /Capture is set up: Start a new agent session/);
      const cur = await c.call("session_current", {});
      assert.equal(cur.isError, true);
      assert.match(cur.content[0]!.text, /Capture is set up/);
    } finally {
      await c.close();
    }
  });
});
