// Short session ids (core/session-ref.ts): the MCP tools and `work show` take the ids the CLI takes,
// and the ids coding.sh prints for a session to be passed back are the shortest that resolve. A
// failed run with 300 subagents and two sessions that share their first 8 characters.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import * as show from "../../src/cli/commands/show.ts";
import * as work from "../../src/cli/commands/work.ts";
import { CliError } from "../../src/cli/output.ts";
import { SHORT_ID_MIN } from "../../src/core/session-ref.ts";
import { workItemId } from "../../src/core/work.ts";
import type { Session } from "../../src/core/types.ts";
import { ERROR_META } from "../../src/mcp/protocol.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";

const MIN = 60e3;
const now = Date.now();
const PARENT = "36d2966a-1c53-47f1-891d-aae1827d0e95";
const CHILDREN = 300;
const child = (n: number): string => `${PARENT}:sub:a${createHash("sha256").update(`agent-${n}`).digest("hex").slice(0, 16)}`;
const TWIN_A = "7c3e9d10-aaaa-4000-8000-000000000001";
const TWIN_B = "7c3e9d10-bbbb-4000-8000-000000000002";
/** The CLI a next step names, as a pattern. The sandbox sets no MSYSTEM or SHELL: on Windows that is PowerShell or cmd, which run codingsh. */
const BIN_RE = process.platform === "win32" ? "codingsh" : "coding\\.sh";

type Extra = NonNullable<Parameters<typeof mkSession>[2]>;
const sess = (id: string, startAgo: number, extra: Extra = {}): Session => mkSession(id, now - startAgo, { cwd: "/work/demo", ...extra });

let sb: Sandbox;
let mcp: CodingShMcp;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

interface Called {
  isError?: boolean;
  text: string;
  data: any;
  error?: any;
}
async function call(name: string, args: Record<string, unknown>): Promise<Called> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const res = r!.result as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown; _meta?: Record<string, unknown> };
  return { isError: res.isError, text: res.content[0]!.text, data: res.structuredContent, error: res._meta?.[ERROR_META] };
}
async function ok(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await call(name, args);
  assert.notEqual(r.isError, true, `${name} ${JSON.stringify(args)}: ${r.text}`);
  return r.data;
}

/** Every session id in a page of session_tree nodes or subagents nodes. */
const ids = (nodes: { sessionId?: string; children: any[] }[], out: string[] = []): string[] => {
  for (const n of nodes) {
    if (n.sessionId) out.push(n.sessionId);
    ids(n.children, out);
  }
  return out;
};

/** The CLI's `show --json` id for a reference. */
async function showId(ref: string): Promise<string> {
  const r = await runCmd(show, sb, { positionals: [ref], json: true });
  assert.equal(r.error, undefined, `show ${ref}: ${r.error?.message}`);
  return r.json.session.id;
}

before(async () => {
  sb = sandbox();
  // In-process MCP reads resolve agent homes through process.env: point them at the sandbox.
  Object.assign(process.env, { HOME: sb.env.HOME, USERPROFILE: sb.env.HOME });
  const parent = sess(PARENT, 40 * MIN, { title: "Fix the parser and run the tests", endedAt: now - 10 * MIN, stats: { testsFailed: 2 } });
  const kids = Array.from({ length: CHILDREN }, (_, i) => {
    const id = child(i);
    return sess(id, 39 * MIN - i * 1000, { title: `Review module ${i} of the parser and report what breaks`, parent: { sessionId: PARENT, subagentId: id.split(":sub:")[1]!, type: "Explore" } });
  });
  await sb.seed([parent, ...kids, sess(TWIN_A, 90 * MIN, { title: "first twin" }), sess(TWIN_B, 80 * MIN, { title: "second twin" })]);
  mcp = createCodingShMcp({ env: sb.env as Record<string, string>, cwd: sb.root, log: () => {}, now: () => now });
});

after(async () => {
  await mcp?.close();
  Object.assign(process.env, saved);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  sb.cleanup();
});

describe("MCP tools take a prefix", () => {
  const prefix = PARENT.slice(0, SHORT_ID_MIN);

  test("session_get, session_tree and session_replay take an 8-character prefix; the session's own id stays full", async () => {
    const got = await ok("session_get", { sessionId: prefix, limit: 5 });
    assert.equal(got.session.id, PARENT);
    const tree = await ok("session_tree", { sessionId: prefix, limit: 5 });
    assert.equal(tree.totals.sessions, CHILDREN + 1);
    assert.equal(tree.tree[0].sessionId, prefix, "the root's row is its short id");
    const replay = await call("session_replay", { sessionId: prefix });
    assert.doesNotMatch(replay.text, /No session with id/, replay.text);
    const subs = await ok("subagents", { sessionId: prefix, limit: 5 });
    assert.equal(subs.sessionId, PARENT);
  });

  test("an ambiguous prefix fails with each candidate's short id, and the error stops saying ids are exact", async () => {
    const r = await call("session_get", { sessionId: TWIN_A.slice(0, SHORT_ID_MIN) });
    assert.equal(r.isError, true);
    assert.match(r.text, /matches more than one session: 7c3e9d10-b \(claude-code, .*"second twin"\); 7c3e9d10-a /);
    assert.equal(r.error.reason, "ambiguous");
    assert.deepEqual(
      r.error.candidates.map((c: { sessionId: string; shortId: string }) => [c.sessionId, c.shortId]),
      [
        [TWIN_B, "7c3e9d10-b"],
        [TWIN_A, "7c3e9d10-a"],
      ],
    );
    const missing = await call("session_get", { sessionId: "zzzzzzzz" });
    assert.equal(missing.isError, true);
    assert.doesNotMatch(missing.text, /exact/);
    assert.match(missing.text, /a unique prefix of an id works too/);
  });
});

describe("printed ids are the shortest that resolve", () => {
  test("session_tree and subagents rows hold short ids that session_get and `coding.sh show` take back", async () => {
    const tree = await ok("session_tree", { sessionId: PARENT, limit: 200 });
    const rows = ids(tree.tree);
    assert.ok(rows.length > 50, `${rows.length} rows`);
    const subs = await ok("subagents", { sessionId: PARENT, limit: 100 });
    const subRows = ids(subs.subagents);
    assert.ok(subRows.length > 20, `${subRows.length} rows`);
    const every = [...new Set([...rows, ...subRows, tree.worst?.sessionId].filter(Boolean))];
    for (const ref of every) assert.ok(ref.length <= 9, `${ref} is short`);
    // A sample across the page: each names the one session it stands for, by MCP and by the CLI.
    for (const ref of [every[0], every[1], every[every.length - 1], subRows[subRows.length - 1]]) {
      const full = ref === PARENT.slice(0, SHORT_ID_MIN) ? PARENT : child([...Array(CHILDREN).keys()].find((i) => child(i).split(":sub:")[1]!.startsWith(ref))!);
      const got = await ok("session_get", { sessionId: ref, limit: 1 });
      assert.equal(got.session.id, full, `session_get ${ref}`);
      assert.equal(await showId(ref), full, `show ${ref}`);
    }
  });

  test("status and work: the next step names the failed session by its short id; the id fields stay full", async () => {
    const st = await ok("status", {});
    const item = st.work.items.find((i: { id: string }) => i.id === workItemId(PARENT));
    assert.ok(item, JSON.stringify(st.work.items));
    assert.equal(item.bucket, "failed");
    const prefix = PARENT.slice(0, SHORT_ID_MIN);
    assert.match(item.next, new RegExp(`^\`${BIN_RE} show ${prefix}\`, then \`claude --resume ${PARENT}\`$`), "the agent's own resume command keeps the full id");
    assert.equal(item.causeSessionId, PARENT);
    assert.equal(item.causeShortId, prefix);
    assert.equal(item.sessionId, PARENT);
    const w = await ok("work", {});
    assert.equal(w.items.find((i: { id: string }) => i.id === workItemId(PARENT)).next, item.next);
    assert.equal(await showId(item.causeShortId), PARENT);
    assert.equal((await ok("session_get", { sessionId: item.causeShortId, limit: 1 })).session.id, PARENT);
  });
});

describe("work show", () => {
  test("takes a prefix of a session id, and prints short ids", async () => {
    const prefix = PARENT.slice(0, SHORT_ID_MIN);
    const j = await runCmd(work, sb, { action: "show", positionals: [prefix], json: true });
    assert.equal(j.error, undefined, j.error?.message);
    assert.equal(j.json.id, workItemId(PARENT));
    assert.equal(j.json.sessionId, PARENT);
    assert.equal(j.json.causeSessionId, PARENT);
    assert.equal(j.json.causeShortId, prefix);
    const sub = await runCmd(work, sb, { action: "show", positionals: [child(7).split(":sub:")[1]!.slice(0, SHORT_ID_MIN)], json: true });
    assert.equal(sub.json?.id, workItemId(PARENT), "a subagent's id finds the run it is in");
    const t = await runCmd(work, sb, { action: "show", positionals: [prefix] });
    assert.equal(t.error, undefined, t.error?.message);
    assert.match(t.stdout, new RegExp(`\`${BIN_RE} show ${prefix}\``));
    assert.match(t.stdout, new RegExp(`${BIN_RE} tree ${prefix}\\b`));
    assert.doesNotMatch(t.stdout.replace(`claude --resume ${PARENT}`, ""), new RegExp(PARENT), "no full id but the agent's resume command");
  });

  test("an ambiguous prefix lists the candidates", async () => {
    const r = await runCmd(work, sb, { action: "show", positionals: [TWIN_A.slice(0, SHORT_ID_MIN)], json: true });
    assert.ok(r.error instanceof CliError, String(r.error));
    assert.equal(r.error.reason, "ambiguous");
    assert.match(r.error.message, /7c3e9d10-a/);
    assert.match(r.error.message, /7c3e9d10-b/);
    // `show` names each candidate by the short id that picks it, and --json keeps the full one beside it.
    const s = await runCmd(show, sb, { positionals: [TWIN_A.slice(0, SHORT_ID_MIN)], json: true });
    assert.ok(s.error instanceof CliError, String(s.error));
    assert.match(s.error.message, /^ {2}7c3e9d10-b {2}claude-code/m);
    assert.deepEqual(
      (s.error.data as { candidates: { id: string; shortId: string }[] }).candidates.map((c: { id: string; shortId: string }) => [c.id, c.shortId]),
      [
        [TWIN_B, "7c3e9d10-b"],
        [TWIN_A, "7c3e9d10-a"],
      ],
    );
  });
});
