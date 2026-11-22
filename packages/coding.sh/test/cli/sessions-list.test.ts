// `coding.sh sessions`: what counts as empty, the hidden-count footer, how
// many sessions matched against how many are shown, and the host app a row names.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as sessions from "../../src/cli/commands/sessions.ts";
import * as show from "../../src/cli/commands/show.ts";
import { buildSession, isEmptySession } from "../../src/core/sessions.ts";
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

describe("sessions list: a subagent with no session.start", () => {
  let sb: Sandbox;
  before(async () => {
    sb = sandbox();
    const at = Date.now() - 10_000;
    const mk = (sessionId: string, n: number) => {
      const events = [
        { id: `${sessionId}-1`, v: 0, sessionId, ts: at + n, agent: "claude-code", kind: "prompt", payload: { text: "go" } },
        { id: `${sessionId}-2`, v: 0, sessionId, ts: at + n + 1, agent: "claude-code", kind: "tool.start", payload: { tool: "Bash", toolUseId: `${sessionId}-t`, input: { command: "ls" } } },
        { id: `${sessionId}-3`, v: 0, sessionId, ts: at + n + 2, agent: "claude-code", kind: "tool.end", payload: { tool: "Bash", toolUseId: `${sessionId}-t`, ok: true } },
      ] as never[];
      return { session: buildSession(events), events };
    };
    const parent = mk("abc", 0);
    const child = mk("abc:sub:a1", 100);
    await sb.seed([parent.session, child.session], [...parent.events, ...child.events]);
  });
  after(() => sb.cleanup());
  const ids = (r: { json?: any }) => (r.json.sessions as { id: string }[]).map((s) => s.id).sort();

  test("the default list shows only the parent; --subagents shows both", async () => {
    assert.deepEqual(ids(await runCmd(sessions, sb, { json: true })), ["abc"]);
    assert.deepEqual(ids(await runCmd(sessions, sb, { json: true, flags: { subagents: true } })), ["abc", "abc:sub:a1"]);
  });
});

describe("sessions list and show: a session a host app drove", () => {
  let sb: Sandbox;
  const now = Date.now();
  before(async () => {
    sb = sandbox();
    await sb.seed([mkSession("hosted", now - 1000, { host: "t3code", provider: "claude-code" }), mkSession("direct", now - 2000)]);
  });
  after(() => sb.cleanup());
  // Off a TTY the table is a header row, then one tab-separated row per session: id, agent, ...
  const agentCells = (stdout: string) => Object.fromEntries(stdout.trim().split("\n").slice(1).map((l) => l.split("\t").slice(0, 2)));

  test("the AGENT cell names the host, so a row --agent t3code lists says why it matched", async () => {
    assert.deepEqual(agentCells((await runCmd(sessions, sb)).stdout), { hosted: "claude-code via t3code", direct: "claude-code" });
    assert.deepEqual(agentCells((await runCmd(sessions, sb, { flags: { agent: ["t3code"] } })).stdout), { hosted: "claude-code via t3code" });
  });

  test("--json keeps agent and host apart, as before", async () => {
    const rows = (await runCmd(sessions, sb, { json: true })).json.sessions as { id: string; agent: string; host?: string }[];
    assert.deepEqual(rows.map((s) => [s.id, s.agent, s.host]), [["hosted", "claude-code", "t3code"], ["direct", "claude-code", undefined]]);
  });

  test("show's Agent row names the host; a session no host drove reads as before", async () => {
    assert.match((await runCmd(show, sb, { positionals: ["hosted"] })).stdout, /^ {2}Agent +claude-code {2}via t3code$/m);
    assert.match((await runCmd(show, sb, { positionals: ["direct"] })).stdout, /^ {2}Agent +claude-code$/m);
  });
});
