// The MCP eval_candidates tool counts the sessions it turned down: rejected (as `eval candidates
// --json` names it) and rejectedBy, a count per reject reason over every considered session, not
// just the page includeRejected lists.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { evalCandidates } from "../../src/cli/commands/eval-candidates.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import { runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";

const HOUR = 3_600e3;
const now = Date.now();
/** The sessions' repository, made in before(): a folder on this machine, so only a session given another root is repo-gone. */
let CWD = "";

let sb: Sandbox;
let mcp: CodingShMcp;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

let n = 0;
function ev(sessionId: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown>, git: boolean, root: string): AgentEvent {
  const e: AgentEvent = { id: `${sessionId}-${n++}`, v: 0, sessionId, agent: "claude-code", ts, kind, payload, cwd: root };
  if (git) e.repo = { root, head: "abc1234" };
  return e;
}

/** A session that started `ago` before now in `root` (CWD unless given): in a git repo unless git is false, with a prompt unless prompt is false, and an edit when edits is true. */
function events(id: string, ago: number, o: { git?: boolean; prompt?: boolean; edits?: boolean; root?: string }): AgentEvent[] {
  const t0 = now - ago;
  const git = o.git !== false;
  const root = o.root ?? CWD;
  const out = [ev(id, t0, "session.start", {}, git, root)];
  if (o.prompt !== false) out.push(ev(id, t0 + 1000, "user.message", { text: `Fix the parser for ${id}` }, git, root));
  if (o.edits) out.push(ev(id, t0 + 2000, "file.change", { path: "src/parser.ts", op: "modify" }, git, root));
  out.push(ev(id, t0 + 60_000, "session.end", { reason: "exit" }, git, root));
  return out;
}

async function ok(args: Record<string, unknown>): Promise<any> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "eval_candidates", arguments: args } });
  const res = r!.result as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
  assert.notEqual(res.isError, true, `eval_candidates ${JSON.stringify(args)}: ${res.content[0]?.text}`);
  return res.structuredContent;
}

before(async () => {
  sb = sandbox();
  CWD = join(sb.root, "demo");
  mkdirSync(CWD);
  // In-process MCP reads resolve agent homes through process.env: point them at the sandbox.
  Object.assign(process.env, { HOME: sb.env.HOME, USERPROFILE: sb.env.HOME });
  const all = [
    events("good", 1 * HOUR, { edits: true }),
    events("nogit-a", 2 * HOUR, { git: false, edits: true }),
    events("nogit-b", 3 * HOUR, { git: false, edits: true }),
    events("nogit-c", 4 * HOUR, { git: false, edits: true }),
    events("noprompt", 5 * HOUR, { prompt: false, edits: true }),
    events("noedit-a", 6 * HOUR, {}),
    events("noedit-b", 7 * HOUR, {}),
    // Its repository was moved or deleted since: the folder is not on this machine.
    events("moved", 8 * HOUR, { edits: true, root: join(sb.root, "moved") }),
  ];
  await sb.seed(
    all.map((evs) => buildSession(evs)),
    all.flat(),
  );
  mcp = createCodingShMcp({ env: sb.env as Record<string, string>, cwd: sb.root, log: () => {}, now: () => now });
});

after(async () => {
  await mcp?.close();
  Object.assign(process.env, saved);
  sb?.cleanup();
});

describe("eval_candidates' rejected counts", () => {
  test("count every rejected session by reason, in eval candidates' order, past the page includeRejected lists", async () => {
    const r = await ok({ repo: "all", limit: 1, includeRejected: true });
    assert.equal(r.considered, 8);
    assert.equal(r.eligible, 1);
    assert.equal(r.rejected, 7);
    assert.deepEqual(Object.entries(r.rejectedBy), [
      ["no-git-start", 3],
      ["repo-gone", 1],
      ["no-user-prompt", 1],
      ["no-edits", 2],
    ]);
    const rows = r.candidates as { sessionId: string; eligible: boolean }[];
    assert.equal(rows.filter((x) => !x.eligible).length, 1, "the page lists limit rejected sessions");
    assert.deepEqual(rows.filter((x) => x.eligible).map((x) => x.sessionId), ["good"]);

    // Without includeRejected the page has no rejected rows, and the counts are the same.
    const plain = await ok({ repo: "all" });
    assert.ok((plain.candidates as { eligible: boolean }[]).every((x) => x.eligible));
    assert.equal(plain.rejected, 7);
    assert.deepEqual(plain.rejectedBy, r.rejectedBy);
  });

  test("agree with eval candidates --json, whose rows name each reason", async () => {
    const r = await ok({ repo: "all" });
    const cli = await runCmd({ run: evalCandidates }, sb, { flags: { repo: "all", all: true, limit: 500 }, json: true });
    assert.equal(cli.error, undefined, cli.error?.stack);
    assert.equal(cli.json.considered, r.considered);
    assert.equal(cli.json.rejected, r.rejected);
    const byReason: Record<string, number> = {};
    for (const c of cli.json.candidates as { reject?: string }[]) if (c.reject) byReason[c.reject] = (byReason[c.reject] ?? 0) + 1;
    assert.deepEqual(byReason, r.rejectedBy);
  });

  test("are 0 and an empty map when nothing was rejected", async () => {
    const r = await ok({ repo: "all", since: "90m" });
    assert.equal(r.considered, 1);
    assert.equal(r.rejected, 0);
    assert.deepEqual(r.rejectedBy, {});
  });
});
