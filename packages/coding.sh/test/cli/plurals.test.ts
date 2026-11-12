// One of anything reads as one: "1 tool call", "1 file changed", "1 of these 5 sessions is flagged".
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as show from "../../src/cli/commands/show.ts";
import * as tree from "../../src/cli/commands/tree.ts";
import * as run from "../../src/cli/commands/run.ts";
import { flaggedText } from "../../src/cli/commands/sessions.ts";
import { extraText } from "../../src/cli/commands/cache.ts";
import { mkSession, runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const ID = "7a1b2c3d-aaaa-4bbb-8ccc-123456789012";
let sb: Sandbox;
before(async () => {
  sb = sandbox();
  await sb.seed([mkSession(ID, Date.now() - 60_000, { stats: { toolCalls: 1, filesChanged: 1, turns: 1 } })]);
});
after(() => sb.cleanup());

test("flagged footer agrees in number", () => {
  assert.equal(flaggedText(1, 5), "1 of these 5 sessions is flagged");
  assert.equal(flaggedText(2, 5), "2 of these 5 sessions are flagged");
  assert.equal(flaggedText(1, 1), "This session is flagged");
});

test("show prints 1 tool call and 1 file changed", async () => {
  const r = await runCmd(show, sb, { positionals: [ID] });
  assert.match(r.stdout, /1 tool call(?!s)/);
  assert.match(r.stdout, /1 file changed/);
});

test("tree prints 1 tool call and 1 file changed", async () => {
  const r = await runCmd(tree, sb, { positionals: [ID] });
  assert.doesNotMatch(r.stdout, /1 tool calls|1 files|\b1 tools\b/);
  assert.match(r.stdout, /1 tool call\b/);
});

test("a tree node with one tool call reads 1 tool", async () => {
  const parent = "8b2c3d4e-aaaa-4bbb-8ccc-123456789012";
  const child = `${parent}:sub:a1`;
  await sb.seed([
    mkSession(parent, Date.now() - 50_000, { stats: { toolCalls: 2, turns: 1 } }),
    mkSession(child, Date.now() - 40_000, { parent: { sessionId: parent, type: "Explore" }, stats: { toolCalls: 1, turns: 1 } } as never),
  ]);
  const r = await runCmd(tree, sb, { positionals: [parent] });
  assert.match(r.stdout, /\b1 tool\b(?! call)/, r.stdout);
  assert.doesNotMatch(r.stdout, /\b1 tools\b/);
  assert.match(r.stdout, /\b2 tools\b/);
});

test("the run line says the time is the command's", async () => {
  const r = await runCmd(run, sb, { rest: [process.execPath, "-e", "0"], cwd: sb.root });
  assert.match(r.stderr + r.stdout, /Captured session \S+ \(the command ran /);
});

test("cache doctor counts one break as a break", () => {
  assert.match(extraText({ unpricedBreaks: 1 } as never), /1 break on/);
});
