// `coding.sh sessions`: what counts as empty, the hidden-count footer, how
// many sessions matched against how many are shown, the host app a row names,
// the alias sessions, tree and show print for a session whose id is `latest`, and
// what sessions, tree, search and status print for an id too long to print whole.
import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";
import * as search from "../../src/cli/commands/search.ts";
import * as sessions from "../../src/cli/commands/sessions.ts";
import * as show from "../../src/cli/commands/show.ts";
import * as status from "../../src/cli/commands/status.ts";
import * as tree from "../../src/cli/commands/tree.ts";
import { buildSession, isEmptySession } from "../../src/core/sessions.ts";
import { fixtureEvent } from "../../src/store/conformance.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
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

describe("sessions, tree and show: a session whose id is latest prints its x_ alias, since latest opens the newest session", () => {
  let sb: Sandbox;
  const now = Date.now();
  const NEWER = "0f3c9d10-aaaa-4000-8000-000000000001";
  const SUB = "latest:sub:a0123456789abcdef";
  const under = (id: string, at: number, title: string) => mkSession(id, at, { title, parent: { sessionId: "latest", type: "Explore" } } as never);
  before(async () => {
    sb = sandbox();
    await sb.seed([
      mkSession("latest", now - 3000, { title: "fix the build", flags: ["premature-completion"] }),
      under(SUB, now - 2950, "look around"),
      // 51 subagents in all: show --json lists 50 and names the command for the rest.
      ...Array.from({ length: 50 }, (_, i) => under(`latest:sub:k${String(i).padStart(2, "0")}`, now - 2900 + i, `step ${i}`)),
      mkSession(NEWER, now - 1000, { title: "newer work" }),
    ]);
  });
  after(() => sb.cleanup());

  test("the ID cell is the alias, which opens it", async () => {
    const r = await runCmd(sessions, sb);
    assert.deepEqual(r.stdout.trim().split("\n").slice(1).map((l) => l.split("\t")[0]), [NEWER, "x_brf2qjp3"]);
    assert.match((await runCmd(show, sb, { positionals: ["x_brf2qjp3"] })).stdout, /^ {2}Session +latest$/m);
  });

  test("tree prints the alias for its node, the line to fix first and the command that opens it", async () => {
    const r = await runCmd(tree, sb, { positionals: ["x_brf2qjp3"] });
    assert.equal(r.code, 0, String(r.error));
    assert.match(r.stdout, /^x_brf2qjp3 {2}claude-code/m, r.stdout);
    assert.match(r.stdout, /the top-level agent x_brf2qjp3: premature-completion/);
    // The next step goes to stderr, and names `codingsh` in PowerShell and cmd (next-steps.ts nextStepBin).
    assert.match(r.stderr, /coding\.?sh show x_brf2qjp3\b/);
  });

  test("a subagent's tree names it by the alias on the in: line", async () => {
    const r = await runCmd(tree, sb, { positionals: [SUB] });
    assert.match(r.stdout, /^in: x_brf2qjp3 claude-code$/m, r.stdout);
  });

  test("show --json names the command for the rest of its subagents by the alias", async () => {
    const doc = (await runCmd(show, sb, { positionals: ["x_brf2qjp3"], json: true })).json;
    assert.deepEqual({ truncated: doc.subagentsTruncated, rest: doc.subagentsRest }, { truncated: true, rest: "coding.sh tree x_brf2qjp3 --json" });
  });
});

/** The id of the session `show` opens for `ref`. */
const opens = async (sb: Sandbox, ref: string): Promise<string | undefined> => (await runCmd(show, sb, { positionals: [ref], json: true, flags: { fields: "session" } })).json?.session?.id;
/** Off a TTY a table is a header row, then one tab-separated row per line: the first cell of each. */
const firstCells = (stdout: string) => stdout.trim().split("\n").slice(1).map((l) => l.split("\t")[0]!);
/** What `run` returns, and how often it read every stored id (loadIdSet, through the store's prefix lookup). */
async function idReads<T>(run: () => Promise<T>): Promise<{ reads: number; result: T }> {
  const spy = mock.method(SqliteIndexStore.prototype, "sessionIdsByPrefix");
  try {
    const result = await run();
    return { reads: spy.mock.calls.filter((c) => c.arguments[0] === "").length, result };
  } finally {
    spy.mock.restore();
  }
}

describe("sessions, tree, search and status: ids over 200 characters that hold % and share their first 8 print a reference that opens each", () => {
  let sb: Sandbox;
  const now = Date.now();
  // T3 Code names a session after its thread: the ids run past 200 characters and start alike.
  const SHARED = `t3code-thread%3Aproj%253Ademo%253A${"abcdefghij".repeat(17)}`;
  const LONG_A = `${SHARED}-first`;
  const LONG_B = `${SHARED}-second`;
  // A Claude Code subagent of LONG_A: its own id is "a" and 16 hex digits.
  const SUB = `${LONG_A}:sub:a0123456789abcdef`;
  const prompt = (id: string, sessionId: string, ts: number) => fixtureEvent({ id, sessionId, ts, kind: "user.message", payload: { text: "rename the widget" } });
  before(async () => {
    sb = sandbox();
    await sb.seed(
      [
        mkSession(LONG_A, now - 3000, { title: undefined }),
        mkSession(SUB, now - 2900, { title: "look around", parent: { sessionId: LONG_A, type: "Explore" } } as never),
        mkSession(LONG_B, now - 1000, { title: "newer work" }),
      ],
      [prompt("a-1", LONG_A, now - 3000), prompt("b-1", LONG_B, now - 1000)],
    );
  });
  after(() => sb.cleanup());

  test("each prints an alias, and the subagent 8 characters of its own id, which show opens", async () => {
    for (const [ref, id] of [["x_d52r41f3", LONG_A], ["x_8n2twz83", LONG_B], ["a0123456", SUB]] as const) assert.equal(await opens(sb, ref), id, ref);
  });

  test("the sessions ID column, with --subagents too", async () => {
    assert.deepEqual(firstCells((await runCmd(sessions, sb)).stdout), ["x_8n2twz83", "x_d52r41f3"]);
    assert.deepEqual(firstCells((await runCmd(sessions, sb, { flags: { subagents: true } })).stdout).sort(), ["a0123456", "x_8n2twz83", "x_d52r41f3"]);
  });

  test("tree: the label of a session with no title, and each node", async () => {
    const r = await runCmd(tree, sb, { positionals: ["x_d52r41f3"] });
    assert.equal(r.code, 0, String(r.error));
    assert.equal(r.stdout.split("\n")[0], "x_d52r41f3");
    assert.match(r.stdout, /^x_d52r41f3 {2}claude-code/m, r.stdout);
    assert.match(r.stdout, /^ {2}└ a0123456 {2}Explore/m, r.stdout);
    assert.doesNotMatch(r.stdout, /t3code-thread/, "no line prints an id over 200 characters");
  });

  test("tree from the subagent: its node and the in: line above it", async () => {
    const r = await runCmd(tree, sb, { positionals: ["a0123456"] });
    assert.equal(r.code, 0, String(r.error));
    assert.match(r.stdout, /^in: x_d52r41f3 claude-code$/m, r.stdout);
    assert.match(r.stdout, /^a0123456 {2}Explore/m, r.stdout);
    assert.doesNotMatch(r.stdout, /t3code-thread/);
  });

  test("the search SESSION column", async () => {
    const r = await runCmd(search, sb, { positionals: ["widget"] });
    assert.equal(r.code, 0, String(r.error));
    assert.deepEqual(firstCells(r.stdout).sort(), ["x_8n2twz83", "x_d52r41f3"]);
  });

  test("the latest session status names", async () => {
    const r = await runCmd(status, sb);
    assert.match(r.stdout, /^x_8n2twz83 {2}claude-code {2}/m, r.stdout);
    assert.doesNotMatch(r.stdout, /t3code-thread/);
  });
});

describe("tree: the Fix first line names a flagged subagent by the reference its node prints", () => {
  let sb: Sandbox;
  const now = Date.now();
  const TOP = `t3code-thread%3Aproj%253Ademo%253A${"abcdefghij".repeat(17)}-fix`;
  // A Claude Code subagent of TOP, and the only flagged node: the one to fix first.
  const SUB = `${TOP}:sub:a89abcdef01234567`;
  before(async () => {
    sb = sandbox();
    await sb.seed([
      mkSession(TOP, now - 3000, { title: "the run" }),
      mkSession(SUB, now - 2900, { title: "look around", parent: { sessionId: TOP, type: "Explore" }, flags: ["looping"] } as never),
    ]);
  });
  after(() => sb.cleanup());

  test("the node and the Fix first line print 8 characters of the subagent's own id, which show opens", async () => {
    const r = await runCmd(tree, sb, { positionals: [TOP] });
    assert.equal(r.code, 0, String(r.error));
    assert.match(r.stdout, /^ {2}└ a89abcde {2}Explore/m, r.stdout);
    const lines = r.stdout.split("\n");
    const fix = lines.indexOf("Fix first");
    assert.ok(fix >= 0, r.stdout);
    assert.equal(lines[fix + 1], "  subagent Explore a89abcde: looping");
    assert.doesNotMatch(r.stdout, /t3code-thread/, "no line prints an id over 200 characters");
    assert.equal(await opens(sb, "a89abcde"), SUB);
  });
});

describe("sessions and tree: a store of 36-character ids prints them whole, as before, and reads the stored ids only for the in: line", () => {
  let sb: Sandbox;
  const now = Date.now();
  const TOP = "6f1c2e3d-0a1b-4c2d-8e3f-405162738495";
  // A subagent whose agent gives it an id of its own, as Codex does.
  const KID = "0b9e8d7c-1111-4222-8333-444455556666";
  const OTHER = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
  before(async () => {
    sb = sandbox();
    await sb.seed([
      mkSession(TOP, now - 3000, { title: undefined }),
      mkSession(KID, now - 2900, { title: "look around", parent: { sessionId: TOP, type: "Explore" } } as never),
      mkSession(OTHER, now - 1000, { title: "newer work" }),
    ]);
  });
  after(() => sb.cleanup());

  test("the sessions ID column prints each id whole, reading no other id", async () => {
    const { reads, result } = await idReads(async () => ({ plain: await runCmd(sessions, sb), all: await runCmd(sessions, sb, { flags: { subagents: true } }) }));
    assert.deepEqual(firstCells(result.plain.stdout), [OTHER, TOP]);
    assert.deepEqual(firstCells(result.all.stdout).sort(), [KID, TOP, OTHER].sort());
    assert.equal(reads, 0);
  });

  test("tree prints its label and nodes by whole id, reading no other id", async () => {
    const { reads, result: r } = await idReads(() => runCmd(tree, sb, { positionals: [TOP] }));
    assert.equal(r.code, 0, String(r.error));
    assert.equal(r.stdout.split("\n")[0], TOP);
    assert.match(r.stdout, new RegExp(`^${TOP} {2}claude-code`, "m"));
    assert.match(r.stdout, new RegExp(`^ {2}└ ${KID} {2}Explore`, "m"));
    assert.equal(reads, 0);
  });

  test("from the subagent, the in: line names the session above by its 8 characters, read from every id once", async () => {
    const { reads, result: r } = await idReads(() => runCmd(tree, sb, { positionals: [KID] }));
    assert.equal(r.code, 0, String(r.error));
    assert.match(r.stdout, /^in: 6f1c2e3d claude-code$/m, r.stdout);
    assert.match(r.stdout, new RegExp(`^${KID} {2}Explore`, "m"));
    assert.equal(reads, 1);
  });
});
