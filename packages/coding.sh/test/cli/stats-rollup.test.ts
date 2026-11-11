// coding.sh stats counts top-level sessions and adds each subagent's spend to the
// session it ran under (--all lists every session on its own). Its errors name CLI
// flags, not API parameters, and an empty result says what to do next.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { cli, ok, seed, session } from "../query/_seed.ts";

const DAY = 86_400_000;
const at = Date.now() - DAY;
const usage = (costUsd: number) => ({ events: 2, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 100, outputTokens: 20, costUsd } });

describe("stats with subagents", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, {
      sessions: [
        session("parent", { startedAt: at, endedAt: at + 60_000, stats: usage(0.1) }),
        session("sub", { startedAt: at + 1000, endedAt: at + 30_000, parent: { sessionId: "parent", type: "Explore" }, stats: usage(0.02) }),
      ],
    });
  });
  after(() => env.restore());

  test("a $0.10 parent with a $0.02 subagent: $0.12 over 1 session; --all: $0.12 over 2", () => {
    const top = JSON.parse(ok(["stats", "--since", "7d", "--json"]).stdout);
    assert.equal(top.totals.costUsd, 0.12);
    assert.equal(top.totals.sessions, 1);
    assert.equal(top.totals.toolCalls, 2);
    const all = JSON.parse(ok(["stats", "--since", "7d", "--all", "--json"]).stdout);
    assert.equal(all.totals.costUsd, 0.12);
    assert.equal(all.totals.sessions, 2);
  });

  test("a range with too many buckets names the CLI flags", () => {
    const day = cli(["stats", "--since", "500d", "--per", "day"]);
    assert.equal(day.status, 2, day.stderr);
    assert.match(day.stderr, /--per week/);
    assert.doesNotMatch(day.stderr, /bucket=week/);
    const week = cli(["stats", "--since", "3000d", "--per", "week", "--json"]);
    assert.equal(week.status, 2, week.stderr);
    const j = JSON.parse(week.stderr);
    assert.match(j.message, /--since/);
    assert.doesNotMatch(j.message, /since\/until/);
  });

  test("an empty window names the next step", () => {
    const r = ok(["stats", "--since", "90d", "--until", "60d"]);
    assert.match(r.stderr, /No sessions from/);
    assert.match(r.stderr, /coding\.sh stats --since/);
    const q = ok(["stats", "--since", "7d", "--where", "agent:nobody"]);
    assert.match(q.stderr, /matching the query/);
    assert.match(q.stderr, /--where/);
  });
});

describe("stats on an empty store", () => {
  let env: TmpEnv;
  before(() => {
    env = tmpEnv();
  });
  after(() => env.restore());

  test("names how to capture the first session", () => {
    const r = ok(["stats"]);
    assert.match(r.stderr, /No sessions/);
    assert.match(r.stderr, /coding\.sh init/);
  });
});
