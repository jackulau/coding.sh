// A work item's pull requests (WorkItem.prs) on every surface: `work` names them on the item's
// line, `work show` lists each with its URL, and `work --json` and the MCP work tool carry them.
// The store holds a session that opened a PR and its subagent that merged it.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import * as work from "../../src/cli/commands/work.ts";
import { prsText } from "../../src/cli/commands/work.ts";
import { workItemId } from "../../src/core/work.ts";
import { createCodingShMcp, type CodingShMcp } from "../../src/mcp/server.ts";
import { PR12, prSessions } from "../core/_prs.ts";
import { runCmd, sandbox, type Sandbox } from "./_cmd.ts";

const now = Date.now();
const item = workItemId("opener");
let sb: Sandbox;
let mcp: CodingShMcp;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

before(async () => {
  sb = sandbox();
  Object.assign(process.env, { HOME: sb.env.HOME, USERPROFILE: sb.env.HOME });
  const { opener, merger, events } = prSessions(now - 3600e3, true);
  await sb.seed([opener, merger], events);
  mcp = createCodingShMcp({ env: sb.env as Record<string, string>, cwd: sb.root, log: () => {}, now: () => now });
});
after(async () => {
  await mcp?.close();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  sb?.cleanup();
});

describe("work names an item's pull requests", () => {
  test("prsText: one PR, several in one state, several states", () => {
    const pr = (number: number, state: "opened" | "merged" | "closed" | "linked") => ({ number, state, at: 0 });
    assert.equal(prsText([pr(12, "merged")]), "PR #12 merged");
    assert.equal(prsText([pr(12, "opened"), pr(14, "opened")]), "PRs #12, #14 open");
    assert.equal(prsText([pr(12, "merged"), pr(14, "opened")]), "PRs #12 merged; #14 open");
  });

  test("the item's line says PR #12 merged", async () => {
    const r = await runCmd(work, sb, { flags: { all: true } });
    assert.equal(r.error, undefined, r.error?.stack);
    const line = r.stdout.split("\n").find((l) => l.includes(item));
    assert.ok(line, r.stdout);
    assert.match(line!, /PR #12 merged/);
  });

  test("work show lists the PR with its URL", async () => {
    const r = await runCmd(work, sb, { action: "show", positionals: [item] });
    assert.equal(r.error, undefined, r.error?.stack);
    assert.match(r.stdout, /PR\s+#12 merged/);
    assert.match(r.stdout, new RegExp(`#12  merged  ${PR12.replace(/[./]/g, "\\$&")}`));
  });

  test("work --json and work show --json carry one PR, merged", async () => {
    const r = await runCmd(work, sb, { json: true, flags: { all: true } });
    const it = r.json.items.find((i: { id: string }) => i.id === item);
    assert.deepEqual(it.prs.map((p: Record<string, unknown>) => [p.url, p.repo, p.number, p.state]), [[PR12, "acme/widgets", 12, "merged"]]);
    assert.match(it.prs[0].at, /^\d{4}-\d\d-\d\dT/);
    const shown = await runCmd(work, sb, { action: "show", positionals: [item], json: true });
    assert.deepEqual(shown.json.prs, it.prs);
  });

  test("the MCP work tool carries them", async () => {
    const r = await mcp.server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "work", arguments: { all: true } } });
    const res = r!.result as { isError?: boolean; structuredContent: { items: { id: string; prs?: { url: string; state: string }[] }[] } };
    assert.notEqual(res.isError, true);
    const it = res.structuredContent.items.find((i) => i.id === item);
    assert.deepEqual(it?.prs?.map((p) => [p.url, p.state]), [[PR12, "merged"]]);
  });
});
