// The in-process command harness (_cmd.ts) must keep a command away from the real agent homes,
// even on paths that read process.env or os.homedir() instead of the command's env.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as sessions from "../../src/cli/commands/sessions.ts";
import { mkSession, runCmd, sandbox } from "./_cmd.ts";

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
