// The MCP improve loop over real stdio: the improve and harness_changes tools
// and the improve / did-it-help prompts, against a temp repo whose CLAUDE.md
// gained a line.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { schemaViolations } from "../../src/toolevals/jsonschema.ts";
import { improveWorld, type World } from "../helpers-improve.ts";
import { RawClient } from "./helpers.ts";

let root = "";
let w: World;
let c: RawClient;
let tools: { name: string; outputSchema: Record<string, unknown> }[] = [];

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-mcp-improve-")));
  w = await improveWorld(root, "mcp", { afterFlagged: 0 });
  c = new RawClient(w.env as Record<string, string>, w.repo);
  const init = await c.initialize();
  assert.deepEqual((init.result!.capabilities as Record<string, unknown>).prompts, { listChanged: false });
  assert.match(String(init.result!.instructions), /start with improve/);
  tools = (await c.request("tools/list")).result!.tools as typeof tools;
});
after(async () => {
  await c?.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await c.call(name, args);
  assert.notEqual(r.isError, true, `${name} failed: ${r.content?.[0]?.text}`);
  const sc = r.structuredContent!;
  assert.deepEqual(schemaViolations(sc, tools.find((t) => t.name === name)!.outputSchema), [], `${name} output matches its outputSchema`);
  return sc;
}

describe("improve tool", () => {
  it("ranks the issue, marks it quiet since the change that helped, and gives the change's verdict, in the server's repo", async () => {
    const r = (await call("improve")) as { scope: { repo: string; sessions: number }; issues: Record<string, unknown>[]; changes: { commit: string; verdict: string; reason: string }[] };
    assert.equal(r.scope.repo, w.repo);
    assert.equal(r.scope.sessions, 12);
    assert.deepEqual(r.issues[0], {
      rank: 1,
      id: "flag:no-verification",
      title: "Says it is done without running anything to check",
      sessions: 4,
      severity: "low",
      example: { sessionId: "before-3", title: "Task before-3" },
      quietSince: { commit: w.commits.rule!.slice(0, 7), sessions: 6 },
      fix: "Name the check in CLAUDE.md or AGENTS.md.",
      next: ["coding.sh show before-3", "coding.sh improve check"],
    });
    assert.deepEqual(
      r.changes.map((x) => [x.commit, x.verdict]),
      [
        [w.commits.rule!.slice(0, 7), "helped"],
        [w.commits.init!.slice(0, 7), "no-baseline"],
      ],
    );
    assert.ok(JSON.stringify(r).length < 3000, `compact: ${JSON.stringify(r).length} bytes`);
  });

  it("an issue still happening carries the line, the file it goes in and the full loop", async () => {
    const live = await improveWorld(root, "live", { afterFlagged: 2 });
    const other = new RawClient(live.env as Record<string, string>, live.repo);
    try {
      await other.initialize();
      const r = await other.call("improve", { limit: 1 });
      const i = (r.structuredContent as { issues: Record<string, unknown>[] }).issues[0]!;
      assert.equal(i.line, "Run `npm test` before you say you are done, and say what it printed.");
      assert.equal(i.file, "CLAUDE.md");
      assert.equal(i.quietSince, undefined);
      assert.deepEqual(i.next, ["coding.sh show after-1", "coding.sh improve fix 1", "coding.sh exp ab --behavior unverified-claim --dry-run", "coding.sh improve check"]);
    } finally {
      await other.close();
    }
  });

  it("prices lost prompt cache with a fix per cause, and leaves headless runs out unless asked", async () => {
    const world = await improveWorld(root, "cost", { afterFlagged: 0, cacheBreaks: true, headless: 2 });
    const other = new RawClient(world.env as Record<string, string>, world.repo);
    try {
      await other.initialize();
      const r = (await other.call("improve", { limit: 1 })).structuredContent as { scope: { sessions: number; headlessLeftOut?: number }; issues: Record<string, unknown>[] };
      assert.deepEqual([r.scope.sessions, r.scope.headlessLeftOut], [12, 2]);
      const i = r.issues[0]!;
      assert.equal(i.id, "cost:cache-breaks");
      assert.ok((i.usd as number) > 1);
      assert.deepEqual((i.causes as { cause: string; breaks: number }[]).map((k) => [k.cause, k.breaks]), [["idle", 12]]);
      const all = (await other.call("improve", { limit: 1, headless: true })).structuredContent as { scope: { sessions: number; headlessLeftOut?: number } };
      assert.deepEqual([all.scope.sessions, all.scope.headlessLeftOut], [14, undefined]);
    } finally {
      await other.close();
    }
  });

  it("takes a repo by folder name and fails clearly on an unknown one", async () => {
    const r = (await call("improve", { repo: "repo", limit: 1 })) as { scope: { repo: string } };
    assert.equal(r.scope.repo, w.repo);
    const bad = await c.call("improve", { repo: "nope" });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text, /No captured session in a repo named "nope"/);
  });
});

describe("harness_changes tool", () => {
  it("gives the before/after counts, the new line's uptake and the verdict; commit picks one change", async () => {
    const r = (await call("harness_changes", { commit: w.commits.rule!.slice(0, 8) })) as { changes: Record<string, unknown>[] };
    assert.equal(r.changes.length, 1);
    const ch = r.changes[0]!;
    assert.equal(ch.verdict, "helped");
    assert.deepEqual(ch.added, ["Run `npm test` before you say you are done."]);
    assert.deepEqual(ch.before, { sessions: 4, flagged: 4, byFlag: { "no-verification": 4 } });
    assert.deepEqual((ch.after as { sessions: number; flagged: number }).flagged, 0);
    assert.deepEqual(ch.rules, [{ line: "Run `npm test` before you say you are done.", followedBefore: "0/4", followedAfter: "6/6", p: 0.005 }]);
    assert.deepEqual((ch.after as { flaggedSessions: unknown[] }).flaggedSessions, [], "no session after it is flagged");
    const none = await c.call("harness_changes", { commit: "deadbeef" });
    assert.equal(none.isError, true);
    assert.match(none.content[0]!.text, /No harness change "deadbeef"/);
  });
});

describe("harness_changes flagged sessions", () => {
  it("lists the sessions still flagged after each change with their flags: 5 per change when listing, up to 20 for one commit", async () => {
    const bad = await improveWorld(root, "still-flagged", { afterFlagged: 6, beforeTested: true });
    const other = new RawClient(bad.env as Record<string, string>, bad.repo);
    try {
      await other.initialize();
      type After = { flagged: number; flaggedSessions: { sessionId: string; at: string; flags: string[]; title?: string }[]; moreFlagged?: number };
      const listed = await other.call("harness_changes");
      assert.deepEqual(schemaViolations(listed.structuredContent, tools.find((t) => t.name === "harness_changes")!.outputSchema), []);
      const ch = (listed.structuredContent as { changes: { commit: string; verdict: string; after: After }[] }).changes[0]!;
      assert.equal(ch.verdict, "regressed");
      assert.equal(ch.after.flagged, 6);
      assert.deepEqual(
        ch.after.flaggedSessions.map((s) => s.sessionId),
        ["after-5", "after-4", "after-3", "after-2", "after-1"],
        "newest first, capped",
      );
      assert.equal(ch.after.moreFlagged, 1, "the cut is marked");
      assert.deepEqual(ch.after.flaggedSessions[0], { sessionId: "after-5", at: ch.after.flaggedSessions[0]!.at, flags: ["no-verification"], title: "Task after-5" });
      const one = await other.call("harness_changes", { commit: bad.commits.rule! });
      const full = (one.structuredContent as { changes: { after: After }[] }).changes[0]!.after;
      assert.equal(full.flaggedSessions.length, 6);
      assert.equal(full.moreFlagged, undefined);
    } finally {
      await other.close();
    }
  });
});

describe("prompts", () => {
  it("lists improve, trim and did-it-help, and renders each with its arguments", async () => {
    const list = (await c.request("prompts/list")).result!.prompts as { name: string; arguments?: { name: string; required?: boolean }[] }[];
    assert.deepEqual(
      list.map((p) => p.name),
      ["improve", "trim", "did-it-help"],
    );
    const trim = (await c.request("prompts/get", { name: "trim", arguments: { since: "90d" } })).result as { messages: { content: { text: string } }[] };
    assert.match(trim.messages[0]!.content.text, /^Call the coding\.sh harness_audit tool with since "90d"\./);
    assert.ok(list.every((p) => (p.arguments ?? []).every((a) => !a.required)), "every argument is optional");
    const got = (await c.request("prompts/get", { name: "did-it-help", arguments: { commit: "abc1234" } })).result as { messages: { role: string; content: { type: string; text: string } }[] };
    assert.equal(got.messages[0]!.role, "user");
    assert.match(got.messages[0]!.content.text, /^Call the coding\.sh harness_changes tool and commit "abc1234"\./);
    const imp = (await c.request("prompts/get", { name: "improve" })).result as { messages: { content: { text: string } }[] };
    assert.match(imp.messages[0]!.content.text, /^Call the coding\.sh improve tool\./);
    const bad = await c.request("prompts/get", { name: "nope" });
    assert.equal(bad.error?.code, -32602);
  });
});
