// What to fix first: command grouping, failure records from events, and the
// ranking (recurring before one-off, then severity), on synthetic sessions.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { Session } from "../../src/core/types.ts";
import { CACHE_BREAK_FIX } from "../../src/core/cache-breaks.ts";
import { cacheFactor, commandHead, errorKey, failureRecords, rankIssues, type FailureRecord } from "../../src/improve/issues.ts";
import { modelProvider, NEEDS_MODEL, stepsFor } from "../../src/improve/report.ts";
import { nodeBin, pathOf } from "../_bin.ts";
import { claimSession, failingSession, retrySession, sessionEvents } from "../helpers-decision.ts";

const CWD = "/work/demo";
const T0 = 1_790_000_000_000;

function session(id: string, flags: string[], k = 0): Session {
  return { ...buildSession(claimSession(id, { cwd: CWD, startedAt: T0 + k * 3600_000 })), flags };
}

describe("commandHead", () => {
  it("keeps what names the command and drops its arguments", () => {
    assert.equal(commandHead("npm test"), "npm test");
    assert.equal(commandHead("npm run lint -- --fix"), "npm run lint");
    assert.equal(commandHead("cd packages/x && FOO=1 pytest -q tests/a.py"), "pytest");
    assert.equal(commandHead("node --test test/"), "node --test");
    assert.equal(commandHead("./node_modules/.bin/tsc --noEmit -p ."), "tsc");
    assert.equal(commandHead("git status 2>&1 | head"), "git status");
    assert.equal(commandHead("pnpm exec vitest run"), "pnpm exec vitest");
  });

  it("blurs numbers, ids and paths in an error key", () => {
    assert.equal(errorKey("Error: ENOENT: no such file /work/demo/a.js line 12"), errorKey("Error: ENOENT: no such file /tmp/b.js line 99"));
  });
});

describe("failureRecords", () => {
  it("groups a failing command by its head and marks failures before any edit", () => {
    const recs = failureRecords(retrySession("r", { cwd: CWD, startedAt: T0 }));
    assert.deepEqual(
      recs.map((r) => [r.key, r.beforeEdits]),
      [
        ["cmd:npm run biuld", true],
        ["cmd:npm run biuld", true],
      ],
    );
    assert.match(recs[0]!.sample!, /Missing script/);
  });

  it("a failing test run after an edit is not before edits", () => {
    const ev = sessionEvents("e", { cwd: CWD, startedAt: T0 }, [
      ["tool.start", { tool: "Edit", toolUseId: "e1", input: { file_path: `${CWD}/a.js` } }],
      ["tool.end", { tool: "Edit", toolUseId: "e1", ok: true }],
      ["tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "t1", ok: false, output: "1 failing" }],
      ["test.result", { passed: 3, failed: 1 }],
    ]);
    const recs = failureRecords(ev);
    assert.equal(recs.length, 1, "the tool error and its test result are one failure");
    assert.equal(recs[0]!.key, "cmd:npm test");
    assert.equal(recs[0]!.tests, true);
    assert.equal(recs[0]!.beforeEdits, false);
  });
});

describe("rankIssues", () => {
  it("puts an issue seen in two or more sessions before a one-off, and words the fix line with the repo's test command", () => {
    const sessions = [session("a", ["no-verification"], 0), session("b", ["no-verification"], 1), session("c", ["premature-completion"], 2), session("d", [], 3)];
    const issues = rankIssues(sessions, new Map(), { testCommand: "npm test" });
    assert.deepEqual(
      issues.map((i) => [i.id, i.sessions]),
      [
        ["flag:no-verification", 2],
        ["flag:premature-completion", 1],
      ],
    );
    assert.ok(issues[1]!.severity.score > issues[0]!.severity.score, "the one-off is more severe, and still second");
    assert.equal(issues[0]!.rule, "Run `npm test` before you say you are done, and say what it printed.");
    assert.equal(issues[0]!.behavior, "unverified-claim");
    assert.equal(issues[0]!.analyzed, 4);
    assert.deepEqual(
      issues[0]!.examples.map((x) => x.sessionId),
      ["b", "a"],
      "newest first",
    );
  });

  it("ignores tags (a colon) and turns a command failing in two sessions into a failure issue", () => {
    const sessions = [session("a", ["skill:pdf"], 0), session("b", [], 1), session("c", [], 2)];
    const fail = (before: boolean): FailureRecord[] => [{ key: "cmd:npm test", label: "npm test", sample: "Cannot find module", tests: true, beforeEdits: before }];
    const issues = rankIssues(sessions, new Map([["a", fail(true)], ["b", fail(true)], ["c", []]]));
    assert.equal(issues.length, 1);
    const i = issues[0]!;
    assert.equal(i.id, "fails:cmd:npm test");
    assert.equal(i.title, "`npm test` already fails before the agent changes anything");
    assert.equal(i.beforeEdits, 2);
    assert.equal(i.severity.level, "high", "a broken test command is a defect of the setup");
    assert.equal(i.rule, undefined, "a broken command needs fixing, not a line");
  });

  it("a failure in one session only is not an issue", () => {
    const sessions = [session("a", [], 0), session("b", [], 1)];
    const issues = rankIssues(sessions, new Map([["a", failureRecords(failingSession("a", { cwd: CWD, startedAt: T0 }))]]));
    assert.deepEqual(issues, []);
  });
});

describe("stepsFor", () => {
  it("names the provider exp ab can call, and falls back to --dry-run with no key", () => {
    const [issue] = rankIssues([session("a", ["no-verification"], 0), session("b", ["no-verification"], 1)], new Map());
    assert.ok(issue?.behavior);
    const ab = (env: NodeJS.ProcessEnv) => stepsFor(issue, 1, { provider: modelProvider(env) }).find((s) => s.command.startsWith("coding.sh exp ab"))?.command;
    assert.equal(ab({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }), `coding.sh exp ab --behavior ${issue.behavior}`);
    assert.equal(ab({ OPENAI_API_KEY: "k" }), `coding.sh exp ab --behavior ${issue.behavior} --provider openai`);
    assert.equal(ab({ ANTHROPIC_API_KEY: " " }), `coding.sh exp ab --behavior ${issue.behavior} --dry-run`);
  });

  it("with no API key, a logged-in Claude Code or Codex tests the edit on its subscription", () => {
    const [issue] = rankIssues([session("a", ["no-verification"], 0), session("b", ["no-verification"], 1)], new Map());
    assert.ok(issue?.behavior);
    const home = mkdtempSync(join(tmpdir(), "csh-steps-"));
    try {
      const bin = join(home, "bin");
      nodeBin(bin, "claude", "");
      nodeBin(bin, "codex", "");
      const base = { HOME: home, USERPROFILE: home, PATH: pathOf(bin) };
      const step = (env: NodeJS.ProcessEnv) => stepsFor(issue, 1, { provider: modelProvider(env) }).find((s) => s.command.startsWith("coding.sh exp ab"))!;

      const none = step(base);
      assert.equal(none.command, `coding.sh exp ab --behavior ${issue.behavior} --dry-run`);
      assert.ok(none.label.includes(NEEDS_MODEL), none.label);

      const claude = step({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-fake" });
      assert.equal(claude.command, `coding.sh exp ab --behavior ${issue.behavior}`, "exp ab picks Claude Code by itself");
      assert.match(claude.label, /on your Claude subscription/);

      mkdirSync(join(home, ".codex"));
      writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: "x" } }));
      const codex = step(base);
      assert.equal(codex.command, `coding.sh exp ab --behavior ${issue.behavior} --provider codex`);
      assert.match(codex.label, /on your ChatGPT subscription/);
      assert.equal(step({ ...base, OPENAI_API_KEY: "k" }).command, `coding.sh exp ab --behavior ${issue.behavior} --provider openai`, "a key comes first");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("cache breaks as a cost issue", () => {
  /** A session whose stored stats say what its cache breaks cost (as ingest folds them), and what it cost in all. */
  function spent(id: string, k: number, costUsd: number, byCause: Record<string, { count: number; lostTokens: number; extraUsd?: number }> | undefined, flags: string[] = []): Session {
    const s = session(id, flags, k);
    const breaks = byCause && Object.values(byCause);
    return {
      ...s,
      stats: {
        ...s.stats,
        usage: { ...s.stats.usage, costUsd },
        ...(breaks
          ? { cacheBreaks: { count: breaks.reduce((n, v) => n + v.count, 0), lostTokens: breaks.reduce((n, v) => n + v.lostTokens, 0), extraUsd: breaks.reduce((n, v) => n + (v.extraUsd ?? 0), 0), byCause } }
          : {}),
      },
    };
  }

  it("lists what lost cache cost, ranked by its dollars, with a fix per cause, costliest first", () => {
    const sessions = [
      spent("a", 0, 12, { compaction: { count: 2, lostTokens: 400_000, extraUsd: 4 }, idle: { count: 3, lostTokens: 90_000, extraUsd: 1 } }, ["no-verification"]),
      spent("b", 1, 10, { idle: { count: 4, lostTokens: 120_000, extraUsd: 1.5 }, "model-switch": { count: 1, lostTokens: 300_000, extraUsd: 2.5 } }, ["no-verification"]),
      spent("c", 2, 8, undefined),
    ];
    const issues = rankIssues(sessions, new Map());
    const cost = issues.find((i) => i.kind === "cost");
    assert.ok(cost, JSON.stringify(issues));
    assert.equal(cost.id, "cost:cache-breaks");
    assert.equal(cost.title, "Pays $9.00 again for prompt cache it lost (10 cache breaks, 30% of the spend)");
    assert.equal(cost.usd, 9);
    assert.deepEqual(cost.examples.map((x) => x.sessionId), ["a", "b"], "costliest session first");
    // Ordered by dollars, not by how many breaks (idle has the most); a tie goes to more breaks.
    assert.deepEqual(
      cost.causes!.map((k) => [k.cause, k.usd, k.breaks]),
      [["compaction", 4, 2], ["idle", 2.5, 7], ["model-switch", 2.5, 1]],
    );
    for (const k of cost.causes!) assert.equal(k.fix, CACHE_BREAK_FIX[k.cause]);
    assert.equal(cost.fix, `Keep the cache warm, costliest cause first. compaction: ${CACHE_BREAK_FIX.compaction}.`);
    // 30% of the spend is major waste (65), plus 2 of 3 sessions: high, and ahead of the flag.
    assert.deepEqual(cost.severity, { score: 68, level: "high" });
    const flag = issues.findIndex((i) => i.id === "flag:no-verification");
    assert.ok(issues.indexOf(cost) < flag, issues.map((i) => `${i.id} ${i.severity.score}`).join(", "));
  });

  it("a small share of the spend ranks after the habits that cost more", () => {
    const sessions = [
      spent("a", 0, 200, { other: { count: 1, lostTokens: 50_000, extraUsd: 1 } }, ["no-verification"]),
      spent("b", 1, 200, { other: { count: 1, lostTokens: 50_000, extraUsd: 1 } }, ["no-verification"]),
    ];
    const issues = rankIssues(sessions, new Map());
    const cost = issues.find((i) => i.kind === "cost")!;
    assert.equal(cost.severity.score, 10 + 3, "0.5% of the spend is small waste");
    assert.match(cost.title, /under 1% of the spend/);
    assert.ok(issues.indexOf(cost) > issues.findIndex((i) => i.id === "flag:no-verification"));
  });

  it("leaves it out under a dollar, in one session, or with no price", () => {
    const one = (usd: number | undefined) => ({ other: { count: 2, lostTokens: 90_000, ...(usd !== undefined ? { extraUsd: usd } : {}) } });
    const none = (sessions: Session[]) => rankIssues(sessions, new Map()).filter((i) => i.kind === "cost");
    assert.deepEqual(none([spent("a", 0, 5, one(0.4)), spent("b", 1, 5, one(0.4))]), []);
    assert.deepEqual(none([spent("a", 0, 50, one(20)), spent("b", 1, 5, undefined)]), []);
    assert.deepEqual(none([spent("a", 0, 5, one(undefined)), spent("b", 1, 5, one(undefined))]), []);
  });

  it("with no spend recorded, says no share and scores it as material waste", () => {
    const cost = rankIssues([spent("a", 0, 0, { idle: { count: 1, lostTokens: 90_000, extraUsd: 2 } }), spent("b", 1, 0, { idle: { count: 1, lostTokens: 90_000, extraUsd: 2 } })], new Map()).find((i) => i.kind === "cost")!;
    assert.equal(cost.title, "Pays $4.00 again for prompt cache it lost (2 cache breaks)");
    assert.equal(cost.severity.score, 25 + 3);
  });

  it("scores the dollar share on the shared waste scale", () => {
    assert.deepEqual([0, 0.019, 0.02, 0.1, 0.25, 0.5, 1].map(cacheFactor), [10, 10, 25, 40, 65, 85, 85]);
  });

  it("its next steps show where the cache breaks and the costliest sessions", () => {
    const sessions = [spent("a", 0, 10, { idle: { count: 2, lostTokens: 90_000, extraUsd: 3 } }), spent("b", 1, 10, { idle: { count: 1, lostTokens: 40_000, extraUsd: 2 } })];
    const cost = rankIssues(sessions, new Map()).find((i) => i.kind === "cost")!;
    assert.deepEqual(
      stepsFor(cost, 1, { provider: undefined }).map((x) => x.command),
      ["coding.sh show a", "coding.sh usage --cache --by repo", "coding.sh sessions --where 'cache.breaks>0 sort:-cache.cost'"],
    );
  });
});
