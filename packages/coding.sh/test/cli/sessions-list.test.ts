// `coding.sh sessions`: what counts as empty, the hidden-count footer, and how
// many sessions matched against how many are shown.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as sessions from "../../src/cli/commands/sessions.ts";
import { isEmptySession } from "../../src/core/sessions.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

describe("isEmptySession", () => {
  const empty = { turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, events: 1, subagents: 0 };
  test("no turn, no call, no usage is empty", () => assert.equal(isEmptySession({ stats: empty } as never), true));
  test("a changed file is work", () => assert.equal(isEmptySession({ stats: { ...empty, filesChanged: 2 } } as never), false));
  test("a start snapshot is work (a command run under `coding.sh run`)", () => {
    assert.equal(isEmptySession({ stats: empty, repo: { root: "/r", head: "h", snapshot: "abc" } } as never), false);
  });
});

describe("sessions list", () => {
  let sb: Sandbox;
  const now = Date.now();
  before(async () => {
    sb = sandbox();
    await sb.seed([
      mkSession("agent-work", now - 1000, { agent: "codex" }),
      mkSession("wrapper-edit", now - 2000, { agent: "wrapper", stats: { turns: 0, toolCalls: 0, filesChanged: 1 } }),
      mkSession("hook-only-1", now - 3000, { stats: { turns: 0 } }),
      mkSession("hook-only-2", now - 4000, { stats: { turns: 0 } }),
      mkSession("older-work", now - 5000),
    ]);
  });
  after(() => sb.cleanup());
  const ids = (r: { json?: any }) => (r.json.sessions as { id: string }[]).map((s) => s.id);

  test("a session that changed a file is listed, under --agent too", async () => {
    assert.deepEqual(ids(await runCmd(sessions, sb, { json: true })), ["agent-work", "wrapper-edit", "older-work"]);
    assert.deepEqual(ids(await runCmd(sessions, sb, { json: true, flags: { agent: ["wrapper"] } })), ["wrapper-edit"]);
    assert.deepEqual(ids(await runCmd(sessions, sb, { json: true, flags: { where: "agent:wrapper" } })), ["wrapper-edit"]);
  });

  test("--where hides empty sessions as the plain list does, and --empty shows them", async () => {
    assert.deepEqual(ids(await runCmd(sessions, sb, { json: true, flags: { where: "turns>=0" } })), ["agent-work", "wrapper-edit", "older-work"]);
    assert.equal(ids(await runCmd(sessions, sb, { json: true, flags: { where: "turns>=0", empty: true } })).length, 5);
  });

  test("a footer counts what was hidden", async () => {
    const r = await runCmd(sessions, sb);
    assert.match(r.stderr, /2 empty sessions hidden; --empty shows them/);
    const one = await runCmd(sessions, sb, { flags: { empty: true } });
    assert.doesNotMatch(one.stderr, /hidden/);
  });

  test("--limit says how many matched; --json carries total", async () => {
    const r = await runCmd(sessions, sb, { flags: { limit: 2 } });
    assert.match(r.stderr, /3 matched, 2 shown/);
    const j = await runCmd(sessions, sb, { json: true, flags: { limit: 2 } });
    assert.equal(j.json.total, 3);
    assert.equal(j.json.sessions.length, 2);
    const all = await runCmd(sessions, sb, { json: true });
    assert.equal(all.json.total, 3);
    assert.doesNotMatch((await runCmd(sessions, sb)).stderr, /matched/);
  });
});
