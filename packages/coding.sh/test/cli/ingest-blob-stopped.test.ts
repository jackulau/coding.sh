// A blob store that refuses writes stops ingest without losing a line (core/ingest.ts), and
// that stop must show: `ingest --json` says "stopped" with exit 1, and after two in a row
// (foreground or --background) `status --json` carries ingestStopped. The next ingest that
// gets through stores the line and removes the marker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(pkg, "src", "cli", "main.ts");
const HOOK = join(pkg, "src", "spool", "hook.ts");

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "csh-blob-stopped-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "user"),
    USERPROFILE: join(root, "user"),
    CODING_SH_HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "user", ".claude"),
    CODEX_HOME: join(root, "user", ".codex"),
    CODING_SH_NO_AUTO_INGEST: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    CI: "1",
  };
  for (const k of ["CODING_SH_STORE_URL", "CODING_SH_BLOB_URL", "CODING_SH_DEV_REAL_STORE", "CODING_SH_DISABLE"]) delete env[k];
  mkdirSync(env.HOME!, { recursive: true });
  // A blob store under a regular file: every write fails (ENOTDIR), as a dead S3 endpoint's would.
  const blocker = join(root, "not-a-dir");
  writeFileSync(blocker, "");
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(cli("config", "set", "store.blobs", pathToFileURL(join(blocker, "blobs")).href).status, 0);
  // A tool result big enough to go to a side file, so ingest stores a blob for it.
  const input = JSON.stringify({ session_id: "blob-1", cwd: "/work/demo", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "cat big" }, tool_response: { stdout: "z ".repeat(9000) } });
  const hook = spawnSync(process.execPath, ["--no-warnings", HOOK, "claude-code", "PostToolUse"], { env, input, encoding: "utf8", timeout: 60_000 });
  assert.equal(hook.status, 0, hook.stderr);
  return { env, cli, blocker };
}

describe("ingest with a blob store that refuses writes", () => {
  it("says stopped with exit 1, marks ingest stopped after two in a row, and clears it once writes go through", () => {
    const t = setup();
    const first = t.cli("ingest", "--json");
    assert.equal(first.status, 1, first.stderr);
    const doc = JSON.parse(first.stdout) as { outcome: string; spool: { storeWriteFailed?: string; pendingFiles: number } };
    assert.equal(doc.outcome, "stopped");
    assert.match(doc.spool.storeWriteFailed ?? "", /^blob store write failed: /);
    assert.equal(doc.spool.pendingFiles, 1);
    // One failure is not yet a stop: a blip passes.
    const once = JSON.parse(t.cli("status", "--json").stdout) as { ingestStopped?: unknown };
    assert.equal(once.ingestStopped, undefined);

    const bg = t.cli("ingest", "--background", "--json");
    assert.equal(bg.status, 1, bg.stderr);
    assert.equal((JSON.parse(bg.stdout) as { outcome: string }).outcome, "stopped");
    const st = JSON.parse(t.cli("status", "--json").stdout) as { ingestStopped?: { reason: string; message: string; next?: string } };
    assert.equal(st.ingestStopped?.reason, "blob_write_failed");
    assert.match(st.ingestStopped?.message ?? "", /^blob store write failed: /);
    assert.equal(st.ingestStopped?.next, "coding.sh config path");
    const human = t.cli("status");
    assert.match(human.stdout + human.stderr, /Ingest +stopped .*blob store write failed: .*; run coding\.sh config path/);

    rmSync(t.blocker);
    const ok = t.cli("ingest", "--json");
    assert.equal(ok.status, 0, ok.stderr);
    const okDoc = JSON.parse(ok.stdout) as { outcome: string; spool: { events: number } };
    assert.equal(okDoc.outcome, "ingested");
    assert.ok(okDoc.spool.events >= 1, "the line the outage held back is stored");
    assert.equal((JSON.parse(t.cli("status", "--json").stdout) as { ingestStopped?: unknown }).ingestStopped, undefined);
  });
});
