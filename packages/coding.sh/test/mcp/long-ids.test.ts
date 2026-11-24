// Long session ids (core/session-ref.ts): T3 Code stores a thread as `t3code-<thread id>`, and a
// thread id can run past 200 characters with percent-encoding, so the shortest prefix that names one
// is long and needs quoting in cmd. Such an id prints as an alias (x_ and 8 or more characters of
// its SHA-256), and the CLI and the MCP tools take the alias back. The ids are made up.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import * as show from "../../src/cli/commands/show.ts";
import * as work from "../../src/cli/commands/work.ts";
import { CliError } from "../../src/cli/output.ts";
import type { Session } from "../../src/core/types.ts";
import { workItemId } from "../../src/core/work.ts";
import { ERROR_META } from "../../src/mcp/protocol.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import { CLI } from "../_cli.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";

const MIN = 60e3;
const now = Date.now();
const SHARED = `t3code-thread%3Aproj%253Ademo%253A${"abcdefghij".repeat(17)}`;
const LONG_A = `${SHARED}-first`;
const LONG_B = `${SHARED}-second`;
const ALIAS_A = "x_d52r41f3";
const ALIAS_B = "x_8n2twz83";
/** A thread LONG_A started, stored as a child session with an id of its own. */
const HELPER = "t3code-thread%3Aproj%253Ademo%253Ahelper-0001";
const HELPER_ALIAS = "x_5ddh5mks";
const PARENT = "36d2966a-1c53-47f1-891d-aae1827d0e95";
// Found by search: the first 40 bits of their SHA-256 are the same, so both aliases start x_xnbfypjk.
const COLLIDE_A = "t3code-thread%3Acollide-442967";
const COLLIDE_B = "t3code-thread%3Acollide-1705744";
/** What every printed reference is made of: no character any of bash, PowerShell or cmd needs quoted. */
const TYPABLE = /^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/;
/** The CLI a next step names. The sandbox sets no MSYSTEM or SHELL: on Windows that is PowerShell or cmd, which run codingsh. */
const BIN = process.platform === "win32" ? "codingsh" : "coding.sh";
const BIN_RE = BIN.replace(".", "\\.");

type Extra = NonNullable<Parameters<typeof mkSession>[2]>;
const t3 = (id: string, startAgo: number, extra: Extra = {}): Session => mkSession(id, now - startAgo, { agent: "t3code", cwd: "/work/demo", endedAt: now - startAgo + 5 * MIN, ...extra });

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

/** The CLI, launched as a person or an agent runs it (test/_cli.ts: from source unless CODING_SH_TEST_CLI names a build). */
function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: sb.root, env: sb.env, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(async () => {
  sb = sandbox();
  // In-process MCP reads resolve agent homes through process.env: point them at the sandbox.
  Object.assign(process.env, { HOME: sb.env.HOME, USERPROFILE: sb.env.HOME });
  await sb.seed([
    t3(LONG_A, 30 * MIN, { title: "Fix the parser in the first thread", stats: { testsFailed: 2 } }),
    t3(HELPER, 29 * MIN, { title: "helper thread", parent: { sessionId: LONG_A, type: "subagent" } }),
    t3(LONG_B, 20 * MIN, { title: "second thread", stats: { testsFailed: 1 } }),
    mkSession(PARENT, now - 50 * MIN, { cwd: "/work/demo", title: "a Claude Code run", endedAt: now - 45 * MIN, stats: { testsFailed: 3 } }),
    t3(COLLIDE_A, 60 * MIN, { title: "collide a" }),
    t3(COLLIDE_B, 70 * MIN, { title: "collide b" }),
  ]);
  mcp = createCodingShMcp({ env: sb.env as Record<string, string>, cwd: sb.root, log: () => {}, now: () => now });
});

after(async () => {
  await mcp?.close();
  Object.assign(process.env, saved);
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  sb.cleanup();
});

describe("the CLI takes an alias", () => {
  test("`show <alias>` and `tree <alias>` open the session; the ids in the JSON stay full", () => {
    const s = cli(["show", ALIAS_A, "--json"]);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(JSON.parse(s.stdout).session.id, LONG_A);
    const t = cli(["tree", ALIAS_A, "--json"]);
    assert.equal(t.status, 0, t.stderr);
    const tree = JSON.parse(t.stdout);
    assert.equal(tree.tree[0].id, LONG_A);
    assert.deepEqual(
      tree.tree[0].children.map((c: { id: string }) => c.id),
      [HELPER],
    );
  });

  test("an alias two sessions share is ambiguous, and each candidate is named by a longer alias", async () => {
    const r = await runCmd(show, sb, { positionals: ["x_xnbfypjk"], json: true });
    assert.ok(r.error instanceof CliError, String(r.error));
    assert.equal(r.error.reason, "ambiguous");
    assert.match(r.error.message, /^ {2}x_xnbfypjkj {2}t3code/m);
    assert.deepEqual(
      (r.error.data as { candidates: { id: string; shortId: string }[] }).candidates.map((c) => [c.id, c.shortId]),
      [
        [COLLIDE_A, "x_xnbfypjkj"],
        [COLLIDE_B, "x_xnbfypjk8"],
      ],
    );
    assert.equal(cli(["show", "x_xnbfypjk8", "--json"]).status, 0);
  });
});

describe("the MCP session tools take an alias", () => {
  test("session_get, session_tree, subagents, session_replay and eval_from_session", async () => {
    assert.equal((await ok("session_get", { sessionId: ALIAS_A, limit: 1 })).session.id, LONG_A);
    assert.equal((await ok("session_get", { sessionId: ALIAS_B, limit: 1 })).session.id, LONG_B);
    const tree = await ok("session_tree", { sessionId: ALIAS_A });
    assert.equal(tree.totals.sessions, 2);
    assert.equal(tree.tree[0].sessionId, ALIAS_A, "the root's row is its alias");
    assert.equal(tree.tree[0].children[0].sessionId, HELPER_ALIAS);
    const subs = await ok("subagents", { sessionId: ALIAS_A });
    assert.equal(subs.sessionId, LONG_A);
    assert.deepEqual(
      subs.subagents.map((n: { sessionId: string }) => n.sessionId),
      [HELPER_ALIAS],
    );
    const replay = await call("session_replay", { sessionId: ALIAS_A });
    assert.doesNotMatch(replay.text, /No session with id/, replay.text);
    // eval_from_session looks the session up before it reads confirm, so it writes nothing here.
    const draft = await call("eval_from_session", { sessionId: ALIAS_A, confirm: false });
    assert.equal(draft.isError, true);
    assert.match(draft.text, /^Not created/, draft.text);
  });

  test("an ambiguous prefix or alias lists each candidate by an alias", async () => {
    const r = await call("session_get", { sessionId: "x_xnbfypjk" });
    assert.equal(r.isError, true);
    assert.match(r.text, /matches more than one session: x_xnbfypjkj \(t3code, .*"collide a"\); x_xnbfypjk8 /);
    assert.equal(r.error.reason, "ambiguous");
    const p = await call("session_get", { sessionId: "t3code-thread%3Aproj%253Ademo" });
    assert.equal(p.error?.reason, "ambiguous", p.text);
    assert.deepEqual(
      p.error.candidates.map((c: { sessionId: string; shortId: string }) => [c.sessionId, c.shortId]),
      [
        [LONG_B, ALIAS_B],
        [HELPER, HELPER_ALIAS],
        [LONG_A, ALIAS_A],
      ],
    );
    assert.ok(p.text.length < 400, p.text);
  });
});

describe("work names a failed thread by its alias", () => {
  test("MCP work and status: next and causeShortId hold the alias; the id fields stay full", async () => {
    const w = await ok("work", {});
    const item = w.items.find((i: { id: string }) => i.id === workItemId(LONG_A));
    assert.ok(item, JSON.stringify(w.items.map((i: { id: string; sessionId: string }) => [i.id, i.sessionId])));
    assert.equal(item.bucket, "failed");
    assert.equal(item.next, `\`${BIN} show ${ALIAS_A}\``);
    assert.equal(item.causeShortId, ALIAS_A);
    assert.equal(item.causeSessionId, LONG_A);
    assert.equal(item.sessionId, LONG_A);
    const claude = w.items.find((i: { id: string }) => i.id === workItemId(PARENT));
    assert.equal(claude.next, `\`${BIN} show 36d2966a\`, then \`claude --resume ${PARENT}\``, "an ordinary id prints its prefix");
    for (const i of w.items) {
      if (i.causeShortId !== undefined) assert.match(i.causeShortId, TYPABLE);
      assert.ok(i.next.length < 120, i.next);
    }
    const st = await ok("status", {});
    assert.equal(st.work.items.find((i: { id: string }) => i.id === workItemId(LONG_A)).next, item.next);
  });

  test("`work` and `work --json`: the next step is an alias that `show` takes", async () => {
    const j = await runCmd(work, sb, { json: true });
    assert.equal(j.error, undefined, j.error?.message);
    const item = j.json.items.find((i: { id: string }) => i.id === workItemId(LONG_B));
    assert.equal(item.next, `\`${BIN} show ${ALIAS_B}\``);
    assert.equal(item.causeShortId, ALIAS_B);
    const t = await runCmd(work, sb, {});
    assert.equal(t.error, undefined, t.error?.message);
    assert.match(t.stdout, new RegExp(`\`${BIN_RE} show ${ALIAS_A}\``));
    assert.match(t.stdout, new RegExp(`\`${BIN_RE} show ${ALIAS_B}\``));
    assert.doesNotMatch(t.stdout, /%3A/, "no long id in the text");
    const s = cli(["show", item.causeShortId, "--json"]);
    assert.equal(s.status, 0, s.stderr);
    assert.equal(JSON.parse(s.stdout).session.id, LONG_B);
  });

  test("`work show <alias>` opens the item the session is in", () => {
    const r = cli(["work", "show", ALIAS_A, "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const item = JSON.parse(r.stdout);
    assert.equal(item.id, workItemId(LONG_A));
    assert.equal(item.sessions[0].id, LONG_A);
  });
});
