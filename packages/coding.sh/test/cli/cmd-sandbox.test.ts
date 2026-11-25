// The in-process command harness (_cmd.ts) must keep a command away from the real agent homes,
// even on paths that read process.env or os.homedir() instead of the command's env.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as sessions from "../../src/cli/commands/sessions.ts";
import type { CommandModule } from "../../src/cli/types.ts";
import { mkSession, runCmd, sandbox } from "./_cmd.ts";

/** A command that records the HOME it sees once `open` is called. */
function gated(seen: (string | undefined)[]): { mod: CommandModule; open: () => void } {
  let open = () => {};
  const gate = new Promise<void>((r) => (open = r));
  return {
    mod: {
      async run() {
        await gate;
        seen.push(process.env.HOME);
        return 0;
      },
    },
    open,
  };
}

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "adapters", "claude-code", "real", "config");
const PLANTED = "cd0185b0-305a-4df2-92fa-6fc6caffdb55";

test("a read in the sandbox does not ingest the Claude Code transcripts of the process's own home", async () => {
  // A stand-in for the user's real home: process.env points at a Claude config holding one transcript.
  const real = realpathSync(mkdtempSync(join(tmpdir(), "csh-real-home-")));
  cpSync(FIXTURE, join(real, ".claude"), { recursive: true });
  const keys = ["HOME", "CLAUDE_CONFIG_DIR"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = real;
  process.env.CLAUDE_CONFIG_DIR = join(real, ".claude");
  const sb = sandbox();
  try {
    await sb.seed([mkSession("seeded", Date.now() - 1000)]);
    const r = await runCmd(sessions, sb, { json: true });
    const ids = (r.json.sessions as { id: string }[]).map((s) => s.id);
    assert.deepEqual(ids, ["seeded"]);
    assert.equal(process.env.HOME, real, "the harness restores the process's own env afterwards");
  } finally {
    sb.cleanup();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(real, { recursive: true, force: true });
  }
});

test("commands that overlap in one sandbox keep its homes in process.env until the last one ends", async () => {
  const sb = sandbox();
  const before = process.env.HOME;
  try {
    const seen: (string | undefined)[] = [];
    const a = gated(seen);
    const b = gated(seen);
    const first = runCmd(a.mod, sb);
    const second = runCmd(b.mod, sb);
    // The first to start ends first, and the second still runs in the sandbox's home.
    a.open();
    await first;
    b.open();
    await second;
    assert.deepEqual(seen, [sb.env.HOME, sb.env.HOME]);
    assert.equal(process.env.HOME, before, "the last to end restores the process's own env");
  } finally {
    sb.cleanup();
  }
});

test("a command in another sandbox does not start while one runs", async () => {
  const sb = sandbox();
  const other = sandbox();
  const a = gated([]);
  const running = runCmd(a.mod, sb);
  try {
    await assert.rejects(runCmd(sessions, other, { json: true }), /must run in one sandbox/);
  } finally {
    a.open();
    await running;
    sb.cleanup();
    other.cleanup();
  }
});
