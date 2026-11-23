// The MCP work tool's id: one item, found as `work show` finds it (cli/commands/work.ts matchItem)
// and shaped as an item of a page. An unknown id and a prefix two items share are tool errors.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as work from "../../src/cli/commands/work.ts";
import { CliError } from "../../src/cli/output.ts";
import { workItemId } from "../../src/core/work.ts";
import type { Session } from "../../src/core/types.ts";
import { ERROR_META } from "../../src/mcp/protocol.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";

const MIN = 60e3;
const now = Date.now();
type Extra = NonNullable<Parameters<typeof mkSession>[2]>;
const sess = (id: string, startAgo: number, extra: Extra = {}): Session => mkSession(id, now - startAgo, { cwd: "/work/demo", ...extra });
// As in test/cli/work.test.ts: the items of s12 and s58 have ids that share their first 4 characters.
const [A, B] = ["s12", "s58"];

let sb: Sandbox;
let mcp: CodingShMcp;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

interface Called {
  isError?: boolean;
  text: string;
  data: any;
  error?: any;
}
async function call(args: Record<string, unknown>): Promise<Called> {
  const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "work", arguments: args } });
  const res = r!.result as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown; _meta?: Record<string, unknown> };
  return { isError: res.isError, text: res.content[0]!.text, data: res.structuredContent, error: res._meta?.[ERROR_META] };
}
async function ok(args: Record<string, unknown>): Promise<any> {
  const r = await call(args);
  assert.notEqual(r.isError, true, `work ${JSON.stringify(args)}: ${r.text}`);
  return r.data;
}

before(async () => {
  sb = sandbox();
  // In-process MCP reads resolve agent homes through process.env: point them at the sandbox.
  Object.assign(process.env, { HOME: sb.env.HOME, USERPROFILE: sb.env.HOME });
  await sb.seed([
    sess("review", 30 * MIN, { title: "fix the flaky test", stats: { filesChanged: 1 } }),
    sess("run", 50 * MIN, { title: "run the migration", endedAt: now - 40 * MIN, stats: { testsFailed: 2 } }),
    sess("run:sub:a1", 49 * MIN, { title: "check the schema", parent: { sessionId: "run", subagentId: "a1", type: "Explore" } }),
    sess(A, 20 * MIN, { title: "first of a pair" }),
    sess(B, 10 * MIN, { title: "second of a pair" }),
  ]);
  mcp = createCodingShMcp({ env: sb.env as Record<string, string>, cwd: sb.root, log: () => {}, now: () => now });
});

after(async () => {
  await mcp?.close();
  Object.assign(process.env, saved);
  sb?.cleanup();
});

describe("the work tool's id", () => {
  test("a work id answers with that one item, as a page of all items shows it", async () => {
    const page = await ok({ all: true, limit: 100 });
    for (const s of ["review", "run", A]) {
      const id = workItemId(s);
      const want = page.items.find((i: { id: string }) => i.id === id);
      assert.ok(want, `the page has ${s}'s item`);
      const one = await ok({ id });
      assert.deepEqual(one.items, [want], s);
      assert.equal(one.since, page.since);
      assert.equal(one.nextCursor, undefined);
    }
  });

  test("a prefix of the work id, a session id, a session id prefix or a subagent's session id names the item", async () => {
    const review = workItemId("review");
    for (const id of [review.slice(0, 4), review.slice(0, 6), "review", "revi"]) assert.deepEqual((await ok({ id })).items.map((i: { id: string }) => i.id), [review], id);
    assert.deepEqual((await ok({ id: "run:sub:a1" })).items.map((i: { id: string }) => i.id), [workItemId("run")]);
    // limit does not cut the one item.
    assert.equal((await ok({ id: review, limit: 1 })).items.length, 1);
  });

  test("a hidden item is found without all, as work show finds it", async () => {
    const listed = await ok({ limit: 100 });
    assert.ok(!listed.items.some((i: { id: string }) => i.id === workItemId(A)), "the done item is hidden without all");
    const [item] = (await ok({ id: workItemId(A) })).items;
    assert.equal(item.id, workItemId(A));
    assert.ok(item.hidden, JSON.stringify(item));
    const show = await runCmd(work, sb, { action: "show", positionals: [workItemId(A)], json: true });
    assert.equal(show.error, undefined, show.error?.stack);
    for (const k of ["id", "bucket", "hidden", "title", "reason", "next", "stage", "stageWhy"]) assert.deepEqual(item[k], show.json[k], k);
  });

  test("an unknown id, or a prefix under 4 characters, is a tool error that says so", async () => {
    assert.ok(![A, B, "review", "run"].some((s) => workItemId(s).startsWith("w000")), "no id starts with w000");
    const miss = await call({ id: "w000000" });
    assert.equal(miss.isError, true);
    assert.equal(miss.text, `No work item "w000000" since 7d. List the items with all: true, or pass an earlier since.`);
    assert.equal(miss.error.reason, "not_found");
    const since = await call({ id: "nope", since: "2d" });
    assert.equal(since.isError, true);
    assert.equal(since.text, `No work item "nope" since 2d. List the items with all: true, or pass an earlier since.`);
    const short = await call({ id: workItemId("review").slice(0, 3) });
    assert.equal(short.isError, true);
    assert.equal(short.text, `No work item "${workItemId("review").slice(0, 3)}" since 7d. A prefix needs at least 4 characters. List the items with all: true, or pass an earlier since.`);
    assert.equal(short.error.reason, "not_found");
  });

  test("a prefix two items' ids share is a tool error that lists both, newest first, as work show does", async () => {
    const prefix = workItemId(A).slice(0, 4);
    assert.equal(workItemId(B).slice(0, 4), prefix, "the pair's ids share a prefix");
    const r = await call({ id: prefix });
    assert.equal(r.isError, true);
    const at = (ago: number) => new Date(now - ago).toISOString();
    assert.equal(
      r.text,
      `Work item id prefix "${prefix}" matches more than one item: ${workItemId(B)} (claude-code, ${at(10 * MIN)}, "second of a pair"); ${workItemId(A)} (claude-code, ${at(20 * MIN)}, "first of a pair"). Pass one of these ids, or more of the id.`,
    );
    assert.equal(r.error.reason, "ambiguous");
    assert.deepEqual(r.error.candidates, [
      { id: workItemId(B), agent: "claude-code", startedAt: at(10 * MIN), title: "second of a pair" },
      { id: workItemId(A), agent: "claude-code", startedAt: at(20 * MIN), title: "first of a pair" },
    ]);
    assert.equal(r.error.more, undefined);
    const show = await runCmd(work, sb, { action: "show", positionals: [prefix] });
    assert.ok(show.error instanceof CliError, String(show.error));
    assert.deepEqual(
      (show.error.data as { candidates: { id: string }[] }).candidates.map((c) => c.id),
      r.error.candidates.map((c: { id: string }) => c.id),
    );
  });
});
