// coding.sh score add|list|config|configs, and the score_list / score_add MCP tools.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { openContext } from "../../src/core/context.ts";
import type { Score } from "../../src/core/types.ts";
import { readValue } from "../../src/scores/cli.ts";
import { scoreTools } from "../../src/scores/mcp.ts";
import { ToolError } from "../../src/mcp/protocol.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { join } from "node:path";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, session, T0 } from "../query/_seed.ts";

let env: TmpEnv;

before(async () => {
  env = tmpEnv();
  await seed(env.dataHome, {
    sessions: [session("sess-aaaa1111"), session("sess-bbbb2222", { startedAt: T0 + 3600_000 })],
    events: [{ id: "evt-1", v: 0, sessionId: "sess-aaaa1111", ts: T0 + 1000, agent: "claude-code", kind: "notification", payload: {} }],
    labels: [{ id: "l1", sessionId: "sess-aaaa1111", criterion: "outcome", value: "fail", note: "looped", by: "me", ts: T0 }],
  });
  // A run target must be a stored run.
  const store = await SqliteIndexStore.open(join(env.dataHome, "index.db"));
  try {
    await store.putRun({ id: "r-1", taskId: "t1", bundleId: "b1", attempt: 1, pass: true, verifierExit: 0, agent: { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" }, startedAt: T0, endedAt: T0 + 1 });
  } finally {
    await store.close();
  }
  // A case target must be a case in a dataset.
  ok(["dataset", "add", "ds", "--case", JSON.stringify({ id: "c-1", input: "x" })]);
});
after(() => env.restore());

const json = (args: string[]) => JSON.parse(ok([...args, "--json"]).stdout);

describe("readValue", () => {
  test("reads the value as its type, or as what it looks like", () => {
    assert.equal(readValue("4", undefined), 4);
    assert.equal(readValue("-0.5", undefined), -0.5);
    assert.equal(readValue("TRUE", undefined), true);
    assert.equal(readValue("neutral", undefined), "neutral");
    assert.equal(readValue("pass", "boolean"), true);
    assert.equal(readValue("no", "boolean"), false);
    assert.equal(readValue("4", "categorical"), "4");
    assert.equal(readValue("high", "numeric"), "high", "left as typed so validation names the problem");
  });
});

describe("coding.sh score", () => {
  test("configs: empty state names the next step, then config prints the bare id", () => {
    const empty = ok(["score", "configs"]);
    assert.equal(empty.stdout, "");
    assert.match(empty.stderr, /coding\.sh score config helpfulness/);
    assert.equal(ok(["score", "config", "helpfulness", "--type", "numeric", "--min", "0", "--max", "5"]).stdout, "helpfulness\n");
    assert.equal(ok(["score", "config", "tone", "--type", "categorical", "--categories", "positive,neutral", "--categories", "negative"]).stdout, "tone\n");
    assert.deepEqual(json(["score", "configs"]).items.map((c: { name: string; categories?: string[] }) => [c.name, c.categories]), [["helpfulness", undefined], ["tone", ["positive", "neutral", "negative"]]]);
    const bad = cli(["score", "config", "x", "--type", "numeric", "--min", "3", "--max", "1"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /min must not be above max/);
    assert.equal(cli(["score", "config", "x"]).status, 2, "--type is required");
  });

  test("add: a session prefix, the bare id on stdout, a value out of range exits 2, and the same score again is unchanged", () => {
    const out = ok(["score", "add", "sess-aaaa", "helpfulness", "4", "--comment", "fixed it"]);
    const id = out.stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.match(out.stderr, /Scored helpfulness = 4 \(numeric\) on session sess-aaaa1111/);
    const again = json(["score", "add", "sess-aaaa1111", "helpfulness", "4", "--comment", "fixed it"]);
    assert.equal(again.created, false);
    assert.equal(again.changed, false);
    assert.equal(again.score.id, id);
    const out7 = cli(["score", "add", "sess-aaaa1111", "helpfulness", "7"]);
    assert.equal(out7.status, 2);
    assert.match(out7.stderr, /above helpfulness's maximum 5/);
    const angry = cli(["score", "add", "sess-aaaa1111", "tone", "angry"]);
    assert.equal(angry.status, 2);
    assert.match(angry.stderr, /not one of tone's categories/);
    const missing = cli(["score", "add", "nope-nope", "ok", "1"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Can't find session/);
    assert.equal(cli(["score", "add", "sess-aaaa1111", "ok"]).status, 2);
  });

  test("add: events, cases and runs; types from the value or --type", () => {
    const ev = json(["score", "add", "event:evt-1", "correct", "false", "--source", "code"]).score as Score;
    assert.deepEqual([ev.target, ev.sessionId, ev.dataType, ev.value, ev.source], ["event", "sess-aaaa1111", "boolean", false, "code"]);
    // --session never stands in for the event: an unknown event is not scored, and another session is refused.
    const ghost = cli(["score", "add", "event:evt_nope", "correct", "false", "--source", "code", "--session", "sess-aaaa"]);
    assert.equal(ghost.status, 1);
    assert.match(ghost.stderr, /event not found: evt_nope/);
    const other = cli(["score", "add", "event:evt-1", "correct", "false", "--source", "code", "--session", "sess-bbbb"]);
    assert.equal(other.status, 2);
    assert.match(other.stderr, /event evt-1 belongs to session sess-aaaa1111, not sess-bbbb2222/);
    assert.equal(json(["score", "add", "event:evt-1", "correct", "false", "--source", "code", "--session", "sess-aaaa"]).changed, false, "its own session is fine");
    assert.deepEqual((json(["score", "list", "--name", "correct"]).items as Score[]).map((s) => [s.targetId, s.sessionId]), [["evt-1", "sess-aaaa1111"]]);
    const cs = json(["score", "add", "case:c-1", "tone", "neutral", "--session", "sess-bbbb"]).score as Score;
    assert.deepEqual([cs.target, cs.targetId, cs.sessionId, cs.configId], ["case", "c-1", "sess-bbbb2222", "tone"]);
    const run = json(["score", "add", "run:r-1", "summary", "clean diff", "--type", "text", "--id", "my-id", "--judge-version", "j@2"]).score as Score;
    assert.deepEqual([run.id, run.dataType, run.value, run.judgeVersion, run.sessionId], ["my-id", "text", "clean diff", "j@2", undefined]);
    const unknown = cli(["score", "add", "trace:x", "ok", "1"]);
    assert.equal(unknown.status, 2, "an unknown kind that is not a session id either is a usage error");
    assert.match(unknown.stderr, /unknown score target trace/);
    assert.equal(cli(["score", "add", "event:", "ok", "1"]).status, 2);
  });

  test("add: a typo does not retype a stored score; --type does", () => {
    assert.match(ok(["score", "add", "sess-bbbb2222", "n1", "-5"]).stderr, /Scored n1 = -5 \(numeric\) on session sess-bbbb2222/);
    const typo = cli(["score", "add", "sess-bbbb2222", "n1", "1,5"]);
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /n1 is a numeric score on session sess-bbbb2222, and "1,5" reads as categorical/);
    assert.match(typo.stderr, /--type categorical/);
    assert.match(typo.stderr, /coding\.sh score config n1 --type numeric/);
    assert.deepEqual((json(["score", "list", "--name", "n1"]).items as Score[]).map((s) => [s.dataType, s.value]), [["numeric", -5]]);
    // A number over a person's pass/fail label would drop the label from export labels.
    ok(["score", "add", "sess-aaaa1111", "resolved", "true"]);
    assert.equal(cli(["score", "add", "sess-aaaa1111", "resolved", "0.5"]).status, 2);
    assert.match(ok(["export", "labels"]).stdout, /"sessionId":"sess-aaaa1111","criterion":"resolved","value":"pass"/);
    assert.match(ok(["score", "add", "sess-bbbb2222", "n1", "1,5", "--type", "categorical"]).stderr, /Updated n1 = 1,5 \(categorical\)/);
  });

  test("list: newest first, filters, and labels show up as human boolean scores", () => {
    const all = json(["score", "list"]).items as Score[];
    assert.ok(all.length >= 5);
    assert.deepEqual(all.map((s) => s.ts), [...all.map((s) => s.ts)].sort((a, b) => b - a));
    const label = all.find((s) => s.id === "l1")!;
    assert.deepEqual([label.dataType, label.value, label.source, label.comment], ["boolean", false, "human", "looped"]);
    assert.deepEqual((json(["score", "list", "--name", "helpfulness"]).items as Score[]).map((s) => s.value), [4]);
    assert.deepEqual((json(["score", "list", "--session", "sess-aaaa1111", "--source", "code"]).items as Score[]).map((s) => s.name), ["correct"]);
    assert.deepEqual((json(["score", "list", "--target", "case:c-1"]).items as Score[]).map((s) => s.name), ["tone"]);
    assert.equal(json(["score", "list", "-n", "1"]).items.length, 1);
    const table = ok(["score", "list", "--name", "helpfulness"]).stdout;
    assert.match(table, /^WHEN\tTARGET\tNAME\tVALUE\tSOURCE\tBY\n/);
    assert.match(table, /session:sess-aaaa1111\thelpfulness\t4\thuman\t/);
    // judge calibrate's label source: the label and a human boolean score read back as labels.
    ok(["score", "add", "sess-bbbb2222", "outcome", "true"]);
    assert.match(ok(["export", "labels"]).stdout, /"sessionId":"sess-bbbb2222","criterion":"outcome","value":"pass"/);
  });
});

describe("MCP score tools", () => {
  const [list, add] = scoreTools();
  const ctx = { env: process.env, cwd: process.cwd(), now: () => Date.now(), store: () => openContext({ env: process.env, cwd: process.cwd() }) };
  // Each call opens the store; close it after.
  const run = async (tool: typeof list, args: Record<string, unknown>) => {
    const c = await ctx.store();
    try {
      return await tool!.run(args, { ...ctx, store: async () => c });
    } finally {
      await c.close();
    }
  };

  test("score_add stores a checked score (latest works), idempotent on a repeat; score_list reads it back", async () => {
    const r = (await run(add!, { targetId: "latest", name: "helpfulness", value: 3, comment: "ok" })) as { score: Score; created: boolean };
    assert.equal(r.created, true);
    assert.deepEqual([r.score.targetId, r.score.source, r.score.configId], ["sess-bbbb2222", "api", "helpfulness"]);
    const again = (await run(add!, { targetId: "latest", name: "helpfulness", value: 3, comment: "ok" })) as { changed: boolean };
    assert.equal(again.changed, false);
    await assert.rejects(run(add!, { targetId: "latest", name: "helpfulness", value: 9 }), (e) => e instanceof ToolError && /maximum 5/.test(e.message));
    await assert.rejects(run(add!, { target: "session", targetId: "missing", name: "x", value: 1 }), (e) => e instanceof ToolError && /session not found/.test(e.message));
    const items = ((await run(list!, { sessionId: "latest", name: "helpfulness", source: "api" })) as { items: Score[] }).items;
    assert.deepEqual(items.map((s) => s.value), [3]);
    assert.equal(((await run(list!, { limit: 1 })) as { items: Score[] }).items.length, 1);
    await assert.rejects(run(list!, { since: "yesterday-ish" }), ToolError);
  });
});
