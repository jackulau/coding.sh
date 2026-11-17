// Regression tests for the third hands-on QA round on the CLI: a misspelled --agent, and typo
// suggestions for prefixes and shell habits.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { suggest } from "../../src/cli/args.ts";
import * as sessions from "../../src/cli/commands/sessions.ts";
import * as usage from "../../src/cli/commands/usage.ts";
import { CLI } from "../_cli.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

describe("a misspelled --agent", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    await sb.seed([mkSession("s1", Date.now() - 60_000), mkSession("sdk1", Date.now() - 60_000, { agent: "my-sdk-bot" as never })]);
  });
  after(() => sb.cleanup());

  test("sessions rejects it and names the agent it meant", async () => {
    const r = await runCmd(sessions, sb, { flags: { agent: "claud-code" } });
    assert.equal(r.error?.name, "UsageError");
    assert.match(r.error.message, /Unknown agent "claud-code"/);
    assert.equal(r.error.suggestion, "--agent claude-code");
  });

  test("usage rejects it too, in --json as well", async () => {
    const r = await runCmd(usage, sb, { flags: { agent: "claud-code" }, json: true });
    assert.equal(r.error?.suggestion, "--agent claude-code");
  });

  test("an agent id far from every adapter (an SDK agent) still filters to an empty list", async () => {
    const r = await runCmd(sessions, sb, { flags: { agent: "nothing-like-this" } });
    assert.equal(r.error, undefined);
    assert.match(r.stdout + r.stderr, /No sessions/);
  });

  test("usage for an agent with no session points at every agent, not a wider window", async () => {
    const r = await runCmd(usage, sb, { flags: { agent: "nothing-like-this" } });
    assert.equal(r.error, undefined);
    const text = r.stdout + r.stderr;
    assert.match(text, /No sessions from nothing-like-this/);
    assert.doesNotMatch(text, /--since 90d/);
  });
});

describe("typo suggestions", () => {
  test("an unambiguous prefix suggests the whole name", () => {
    assert.equal(suggest("dry", ["dry-run", "json", "older-than"]), "dry-run");
    assert.equal(suggest("dr", ["dry-run", "json"]), undefined, "too short to be a prefix guess");
    assert.equal(suggest("re", ["repo", "reprice"]), undefined);
    assert.equal(suggest("rep", ["repo", "reprice"]), "repo", "edit distance comes first");
  });
  test("shell habits map to the command", () => {
    assert.equal(suggest("ls", ["list", "show", "new"]), "list");
    assert.equal(suggest("rm", ["list", "delete"]), "delete");
    assert.equal(suggest("ls", ["show", "new"]), undefined);
  });
  test("end to end: gc --dry and exp ls", () => {
    const sb = sandbox();
    try {
      const gc = spawnSync(process.execPath, ["--no-warnings", CLI, "gc", "--dry"], { env: sb.env, encoding: "utf8" });
      assert.equal(gc.status, 2);
      assert.match(gc.stderr, /--dry-run/);
      const exp = spawnSync(process.execPath, ["--no-warnings", CLI, "exp", "ls"], { env: sb.env, encoding: "utf8" });
      assert.equal(exp.status, 2);
      assert.match(exp.stderr, /exp list/);
    } finally {
      sb.cleanup();
    }
  });
});
