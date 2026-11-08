// coding.sh usage --cache: prompt-cache economics per group — hit rate, read vs write
// tokens, read:write ratio, breaks and their priced cost, with data-grounded guidance.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { tmpEnv, type TmpEnv } from "../adapters/_helpers.ts";
import { ok, seed, session } from "../query/_seed.ts";
import type { Session } from "../../src/schema/index.ts";

const now = Date.now() - 3_600_000;
const base = { startedAt: now, endedAt: now + 60_000 };

// A churning session: wrote 20k of cache, read back 2k, and broke twice.
const churn = session("churn", {
  agent: "claude-code",
  model: "claude-opus-5",
  ...base,
  flags: ["cache:low"],
  stats: {
    events: 10,
    turns: 5,
    toolCalls: 3,
    toolErrors: 0,
    filesChanged: 1,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 20_000, costUsd: 0.9 },
    cacheBreaks: { count: 2, lostTokens: 15_000, extraUsd: 0.12, byCause: { compaction: { count: 1, lostTokens: 8000, extraUsd: 0.07 }, idle: { count: 1, lostTokens: 7000, extraUsd: 0.05 } } },
  },
}) as Session;

// A second session that also under-reuses its cache, but was not tagged or broken.
const other = session("other", {
  agent: "codex",
  model: "gpt-5.1-codex",
  ...base,
  stats: {
    events: 10,
    turns: 5,
    toolCalls: 3,
    toolErrors: 0,
    filesChanged: 1,
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 3000, cacheWriteTokens: 10_000, costUsd: 0.3 },
  },
}) as Session;

describe("usage --cache", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions: [churn, other] });
  });
  after(() => env.restore());

  test("--by agent prints the cache table and ratios", () => {
    const r = ok(["usage", "--cache", "--by", "agent"]);
    assert.match(r.stdout, /CACHED\s+READ\s+WRITE\s+R:W\s+BREAKS\s+WASTE/);
    const churnRow = r.stdout.split("\n").find((l) => l.startsWith("claude-code"))!;
    const otherRow = r.stdout.split("\n").find((l) => l.startsWith("codex"))!;
    assert.match(churnRow, /0\.1:1/, "churn read:write is 0.1:1");
    assert.match(churnRow, /~\$0\.12/, "churn shows the break waste");
    assert.match(otherRow, /0\.3:1/, "other read:write is 0.3:1");
    assert.match(otherRow, /\s-\s*$/, "a row with no breaks has no waste");
  });

  test("guidance names the read:write gap, the cache:low tag and the break causes", () => {
    const r = ok(["usage", "--cache"]);
    assert.match(r.stderr, /Cache read:write is 0\.17:1/);
    assert.match(r.stderr, /1 session tagged cache:low/);
    assert.match(r.stderr, /flag:cache:low/);
    assert.match(r.stderr, /2 cache breaks/);
    assert.match(r.stderr, /compaction 1, idle 1/);
    assert.match(r.stderr, /cache\.breaks>0 sort:-cache\.cost/);
    assert.match(r.stderr, /Top cause compaction: compact less often/);
  });

  test("--json carries the cache fields without human notes", () => {
    const j = JSON.parse(ok(["usage", "--cache", "--by", "agent", "--json"]).stdout);
    const c = j.groups.find((g: { key: string }) => g.key === "claude-code");
    assert.equal(c.cacheReadWriteRatio, 0.1);
    assert.equal(c.cacheLowSessions, 1);
    assert.deepEqual(c.cacheBreakCauses, { compaction: 1, idle: 1 });
    assert.equal(j.groups.find((g: { key: string }) => g.key === "codex").cacheLowSessions, undefined);
    assert.equal(j.total.cacheReadWriteRatio, 0.17);
  });
});

// Idle breaks split by where the wait was: a subagent's 10-minute foreground Bash wait,
// a subagent idle between turns, and the main session idle while the person was away.
const subagentWaits = session("sub-waits", {
  agent: "claude-code",
  model: "claude-opus-5-5",
  ...base,
  parent: { sessionId: "main-away" },
  stats: {
    events: 10,
    turns: 1,
    toolCalls: 4,
    toolErrors: 0,
    filesChanged: 0,
    usage: { inputTokens: 100, outputTokens: 500, cacheReadTokens: 50_000, cacheWriteTokens: 60_000, costUsd: 0.5 },
    cacheBreaks: {
      count: 3,
      lostTokens: 60_000,
      extraUsd: 0.3,
      byCause: { idle: { count: 3, lostTokens: 60_000, extraUsd: 0.3 } },
      byIdle: { wait: { count: 2, lostTokens: 40_000, extraUsd: 0.2 }, subagent: { count: 1, lostTokens: 20_000, extraUsd: 0.1 } },
    },
  },
}) as Session;
const mainAway = session("main-away", {
  agent: "claude-code",
  model: "claude-opus-5-5",
  ...base,
  stats: {
    events: 10,
    turns: 3,
    toolCalls: 2,
    toolErrors: 0,
    filesChanged: 0,
    usage: { inputTokens: 100, outputTokens: 500, cacheReadTokens: 80_000, cacheWriteTokens: 30_000, costUsd: 0.4 },
    cacheBreaks: { count: 1, lostTokens: 20_000, extraUsd: 0.05, byCause: { idle: { count: 1, lostTokens: 20_000, extraUsd: 0.05 } }, byIdle: { away: { count: 1, lostTokens: 20_000, extraUsd: 0.05 } } },
  },
}) as Session;

describe("usage --cache: idle breaks by where the wait was", () => {
  let env: TmpEnv;
  before(async () => {
    env = tmpEnv();
    await seed(env.dataHome, { sessions: [subagentWaits, mainAway] });
  });
  after(() => env.restore());

  test("each idle kind gets its own line and fix, costliest first", () => {
    const r = ok(["usage", "--cache"]);
    assert.match(r.stderr, /Top cause idle:/);
    const lines = r.stderr.split("\n").filter((l) => l.includes("Idle, "));
    assert.equal(lines.length, 3, r.stderr);
    assert.match(lines[0]!, /Idle, a long tool call \(wait\): 2 breaks, ~\$0\.2000: cap foreground waits under the 5-minute subagent cache lifetime; poll in chunks\./);
    assert.match(lines[1]!, /Idle, a subagent idle between turns \(subagent\): 1 break, ~\$0\.1000: a subagent sat idle/);
    assert.match(lines[2]!, /Idle, the main session idle between turns \(away\): 1 break, ~\$0\.0500: unavoidable while you're away; the 1-hour cache helps if you return often\./);
  });

  test("--json sums them per group as cacheBreakIdle, and cacheBreakCauses still reads idle", () => {
    const j = JSON.parse(ok(["usage", "--cache", "--json"]).stdout);
    assert.deepEqual(j.total.cacheBreakCauses, { idle: 4 });
    assert.deepEqual(j.total.cacheBreakIdle, { wait: { count: 2, extraUsd: 0.2 }, subagent: { count: 1, extraUsd: 0.1 }, away: { count: 1, extraUsd: 0.05 } });
    assert.ok(j.notes.some((n: string) => /Idle breaks by where the wait was: wait 2 \(~\$0\.2\): cap foreground waits/.test(n)), j.notes.join("\n"));
  });
});
