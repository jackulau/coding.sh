// init imports each agent's past sessions, so the viewer the installer opens shows the
// user's history instead of an empty list. Real fixture transcripts (Claude Code from a
// pinned release against the stub model, Codex rollouts) in a throwaway HOME.
import assert from "node:assert/strict";
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { run as ingest } from "../../src/cli/commands/ingest.ts";
import { run as init } from "../../src/cli/commands/init.ts";
import { Output } from "../../src/cli/output.ts";
import type { CommandContext } from "../../src/cli/types.ts";
import { openContext } from "../../src/core/context.ts";
import { acquireLock } from "../../src/core/lock.ts";
import { paths } from "../../src/core/paths.ts";
import { FIXTURES, tmpEnv, writeFile, type TmpEnv } from "../adapters/_helpers.ts";

let t: TmpEnv;
beforeEach(() => {
  t = tmpEnv();
  process.env.PATH = join(t.root, "nobin"); // no agent binaries: agents are named with --agent
  process.env.NO_UPDATE_NOTIFIER = "1";
  process.env.CODING_SH_NO_AUTO_INGEST = "1"; // never start a detached ingest from a test
  process.env.CLAUDE_CONFIG_DIR = join(t.home, ".claude");
  process.env.CODEX_HOME = join(t.home, ".codex");
  const hook = join(t.root, "dist", "hook.mjs");
  writeFile(hook, "// hook\n");
  process.env.CODING_SH_HOOK_SOURCE = hook;
  // Past sessions, as each agent keeps them.
  cpSync(join(FIXTURES, "claude-code", "real", "config", "projects"), join(process.env.CLAUDE_CONFIG_DIR, "projects"), { recursive: true });
  cpSync(join(FIXTURES, "claude-code", "config", "projects"), join(process.env.CLAUDE_CONFIG_DIR, "projects"), { recursive: true });
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  cpSync(join(FIXTURES, "codex", "home", "sessions"), join(process.env.CODEX_HOME, "sessions"), { recursive: true });
});
afterEach(() => {
  for (const k of ["CODING_SH_HOOK_SOURCE", "CODING_SH_NO_AUTO_INGEST", "CODING_SH_INIT_IMPORT_BUDGET_MS", "NO_UPDATE_NOTIFIER"]) delete process.env[k];
  t.restore();
});

interface Run {
  stdout: string;
  stderr: string;
  code?: number;
  error?: unknown;
}

function ctxFor(flags: CommandContext["flags"], json: boolean, cap: Run): CommandContext {
  const env = { ...process.env, NO_COLOR: "1", CI: "" };
  const out = new Output({
    json,
    env,
    stdout: { write: (s: string) => ((cap.stdout += s), true), isTTY: false },
    stderr: { write: (s: string) => ((cap.stderr += s), true), isTTY: false },
    stdin: { isTTY: false },
  });
  return { flags, positionals: [], rest: [], out, env, cwd: t.home, debug: false, signal: new AbortController().signal };
}

async function runInit(flags: CommandContext["flags"], json = false): Promise<Run> {
  const cap: Run = { stdout: "", stderr: "" };
  try {
    cap.code = await init(ctxFor({ mcp: false, agent: ["claude-code", "codex"], yes: true, ...flags }, json, cap));
  } catch (e) {
    cap.error = e;
  }
  return cap;
}

async function stored(): Promise<{ agent: string; id: string }[]> {
  const ctx = await openContext({ env: process.env });
  try {
    return (await ctx.index.listSessions({ limit: 100 })).map((s) => ({ agent: s.agent, id: s.id }));
  } finally {
    await ctx.close();
  }
}

describe("init imports past sessions", () => {
  test("by default: the store holds each agent's history when init returns", async () => {
    const r = await runInit({});
    assert.equal(r.code, 0, String(r.error ?? r.stderr));
    const s = await stored();
    assert.ok(s.some((x) => x.agent === "claude-code"), "Claude Code history imported");
    assert.ok(s.some((x) => x.agent === "codex"), "Codex history imported");
    assert.match(r.stderr, /then import past sessions from Claude Code and Codex CLI \(--no-import skips\)/);
    assert.match(r.stderr, /✓ Imported \d+ past sessions from Claude Code and Codex CLI in \d+\.\d s/);
    // The question names the import too (asked when not --yes).
    assert.doesNotMatch(r.stderr, /transcripts? left/);
  });

  test("--json reports the import; running init again reads only what changed", async () => {
    const first = await runInit({}, true);
    assert.equal(first.code, 0, String(first.error ?? first.stderr));
    const a = JSON.parse(first.stdout) as { import: { sessions: number; events: number; pendingFiles: number; agents: string[]; background: boolean } };
    assert.ok(a.import.sessions > 0 && a.import.events > 0);
    assert.equal(a.import.pendingFiles, 0);
    assert.deepEqual(a.import.agents.sort(), ["claude-code", "codex"]);
    const again = await runInit({}, true);
    const b = JSON.parse(again.stdout) as { outcome: string; import: { sessions: number; events: number } };
    assert.equal(b.outcome, "unchanged");
    assert.equal(b.import.events, 0, "no transcript changed: nothing read again");
  });

  test("--no-import leaves history alone and says nothing about it", async () => {
    const r = await runInit({ import: false });
    assert.equal(r.code, 0, String(r.error ?? r.stderr));
    assert.deepEqual(await stored(), []);
    assert.doesNotMatch(r.stderr, /past session/);
    const j = await runInit({ import: false }, true);
    assert.equal((JSON.parse(j.stdout) as { import: unknown }).import, null);
  });

  test("--dry-run lists the import in the plan and imports nothing", async () => {
    const r = await runInit({ "dry-run": true });
    assert.equal(r.code, 0, String(r.error ?? r.stderr));
    assert.match(r.stdout, /^ {2}then import past sessions from Claude Code and Codex CLI \(--no-import skips\)$/m);
    assert.deepEqual(await stored(), []);
    const j = await runInit({ "dry-run": true }, true);
    assert.deepEqual((JSON.parse(j.stdout) as { import: { agents: string[] } }).import.agents, ["claude-code", "codex"]);
  });

  test("past the time budget it stops, says what is left, and ingest --background --backfill imports the rest", async () => {
    process.env.CODING_SH_INIT_IMPORT_BUDGET_MS = "0"; // one transcript, then out of time
    const r = await runInit({}, true);
    assert.equal(r.code, 0, String(r.error ?? r.stderr));
    const j = JSON.parse(r.stdout) as { import: { pendingFiles: number; background: boolean } };
    assert.ok(j.import.pendingFiles > 0, "transcripts left for the background import");
    assert.equal(j.import.background, false, "CODING_SH_NO_AUTO_INGEST=1: no detached import");
    const human = await runInit({});
    assert.match(human.stderr, /transcripts? left\. Import them: coding\.sh ingest --backfill/);
    const before = (await stored()).length;
    // What init would have started detached.
    const cap: Run = { stdout: "", stderr: "" };
    const code = await ingest(ctxFor({ background: true, backfill: true, agent: ["claude-code", "codex"] }, true, cap));
    assert.equal(code, 0, cap.stderr);
    assert.equal((JSON.parse(cap.stdout) as { backfill: { pendingFiles: number } }).backfill.pendingFiles, 0);
    const after = await stored();
    assert.ok(after.length > before, `background import added sessions (${before} → ${after.length})`);
    assert.ok(after.some((x) => x.agent === "claude-code") && after.some((x) => x.agent === "codex"));
  });

  test("an import already running: init leaves the history to it", async () => {
    mkdirSync(paths(process.env).root, { recursive: true });
    const lock = await acquireLock(paths(process.env).importLock, { waitMs: 0 });
    try {
      const r = await runInit({});
      assert.equal(r.code, 0, String(r.error ?? r.stderr));
      assert.match(r.stderr, /an import is already running in the background/);
      assert.deepEqual(await stored(), []);
      // And the background import itself skips while another holds the lock.
      const cap: Run = { stdout: "", stderr: "" };
      await ingest(ctxFor({ background: true, backfill: true }, true, cap));
      assert.equal((JSON.parse(cap.stdout) as { backfill: unknown }).backfill, null);
    } finally {
      lock.release();
    }
  });
});
