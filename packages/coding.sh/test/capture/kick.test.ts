// The hook's session-end background ingest: when it starts, and when it stays out of the way.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { END_EVENT, kickIngest, type KickSpawner } from "../../src/spool/kick.ts";

let root = "";
let env: NodeJS.ProcessEnv = {};
let calls: { command: string; args: string[]; detached: boolean; stdio: string }[] = [];
const spawn: KickSpawner = (command, args, o) => {
  calls.push({ command, args, detached: o.detached, stdio: o.stdio });
  return { unref() {} };
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-kick-")));
  env = { HOME: root, CODING_SH_HOME: join(root, "data") };
  calls = [];
  mkdirSync(join(root, "data", "bin"), { recursive: true });
  mkdirSync(join(root, "data", "spool"), { recursive: true });
  writeFileSync(join(root, "cli.mjs"), "");
  writeFileSync(join(root, "data", "bin", "cli-path"), join(root, "cli.mjs") + "\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("kickIngest", () => {
  it("matches end-of-turn and end-of-session events across agents", () => {
    for (const e of ["Stop", "stop", "SessionEnd", "sessionEnd", "session.idle", "AfterAgent", "session_end"]) assert.ok(END_EVENT.test(e), e);
    for (const e of ["UserPromptSubmit", "PreToolUse", "SubagentStop", "sessionStart", "postToolUse"]) assert.ok(!END_EVENT.test(e), e);
  });

  it("starts a detached `cli.mjs ingest --background` on a session end", () => {
    assert.equal(kickIngest("Stop", env, spawn), join(root, "cli.mjs"));
    assert.deepEqual(calls, [{ command: process.execPath, args: [join(root, "cli.mjs"), "ingest", "--background"], detached: true, stdio: "ignore" }]);
  });

  it("does nothing for other events, eval runs, the opt-out, a held lock, or a missing CLI", () => {
    assert.equal(kickIngest("UserPromptSubmit", env, spawn), undefined);
    assert.equal(kickIngest("Stop", { ...env, CODING_SH_RUN_ID: "run_1" }, spawn), undefined);
    assert.equal(kickIngest("Stop", { ...env, CODING_SH_NO_AUTO_INGEST: "1" }, spawn), undefined);
    writeFileSync(join(root, "data", "spool", ".ingest.lock"), "{}");
    assert.equal(kickIngest("Stop", env, spawn), undefined, "an ingest is already running");
    rmSync(join(root, "data", "spool", ".ingest.lock"));
    rmSync(join(root, "cli.mjs"));
    assert.equal(kickIngest("Stop", env, spawn), undefined, "pointer to a removed install");
    rmSync(join(root, "data", "bin", "cli-path"));
    assert.equal(kickIngest("Stop", env, spawn), undefined, "no pointer (init ran from source)");
    assert.deepEqual(calls, []);
  });
});
