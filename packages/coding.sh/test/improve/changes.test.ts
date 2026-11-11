// Did a harness change help? A temp git repo whose CLAUDE.md gains a line,
// synthetic sessions recorded at each HEAD, and the verdict per change.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, Session } from "../../src/core/types.ts";
import { ALPHA, changeEffects, decide, harnessChanges, permutationP, sessionVersions, withoutMcp, workEffect, type GroupStats, type RuleEffect } from "../../src/improve/changes.ts";
import { claimSession, sessionEvents } from "../helpers-decision.ts";

const T0 = 1_790_000_000_000;
let root = "";
const commits: Record<string, string> = {};

function git(args: string[], date?: string): string {
  const env = { ...process.env, GIT_AUTHOR_DATE: date ?? "", GIT_COMMITTER_DATE: date ?? "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(name: string, file: string, text: string, day: number): void {
  writeFileSync(join(root, file), text);
  git(["add", "-A"]);
  git(["commit", "-qm", name], `2026-10-${String(day).padStart(2, "0")}T09:00:00Z`);
  commits[name] = git(["rev-parse", "HEAD"]);
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-improve-changes-")));
  git(["init", "-q"]);
  commit("init", "CLAUDE.md", "Keep answers short.\n", 1);
  commit("add the test rule", "CLAUDE.md", "Keep answers short.\nRun `npm test` before you say you are done.\n", 5);
  commit("unrelated code", "index.js", "export {};\n", 6);
  commit("ask for a summary", "CLAUDE.md", "Keep answers short.\nRun `npm test` before you say you are done.\nEnd with a two-line summary.\n", 10);
});
after(() => rmSync(root, { recursive: true, force: true }));

const events = new Map<string, AgentEvent[]>();

/** A session at `head`; `tested` runs npm test, else it claims done without a check. */
function at(id: string, head: string, o: { flagged: boolean; tested: boolean; k: number }): Session {
  const opts = { cwd: root, startedAt: T0 + o.k * 3600_000 };
  const ev = o.tested
    ? sessionEvents(id, opts, [
        ["user.message", { text: "Fix it." }],
        ["tool.start", { tool: "Bash", toolUseId: `${id}-t`, input: { command: "npm test" } }],
        ["tool.end", { tool: "Bash", toolUseId: `${id}-t`, ok: true, output: "ok" }],
        ["assistant.message", { text: "Done; npm test passes." }],
      ])
    : claimSession(id, opts);
  events.set(id, ev);
  return { ...buildSession(ev), repo: { root, head }, flags: o.flagged ? ["no-verification"] : [] };
}

/** A session that only called MCP tools (asking coding.sh about other sessions). */
function mcpOnly(id: string, head: string, k: number): Session {
  const ev = sessionEvents(id, { cwd: root, startedAt: T0 + k * 3600_000 }, [
    ["user.message", { text: "Did my CLAUDE.md change help?" }],
    ["tool.start", { tool: "mcp__coding_sh__harness_changes", toolUseId: `${id}-m`, input: {}, server: "coding_sh" }],
    ["tool.end", { tool: "mcp__coding_sh__harness_changes", toolUseId: `${id}-m`, ok: true, output: "{}" }],
  ]);
  events.set(id, ev);
  return { ...buildSession(ev), repo: { root, head } };
}

describe("harnessChanges", () => {
  it("lists the commits that touched a harness file, newest first, with their added lines and previous version", async () => {
    const cs = await harnessChanges(root, { limit: 5 });
    assert.deepEqual(
      cs.map((c) => c.subject),
      ["ask for a summary", "add the test rule", "init"],
      "the code-only commit is not a harness change",
    );
    assert.deepEqual(cs[0]!.added, ["End with a two-line summary."]);
    assert.equal(cs[0]!.previous, commits["add the test rule"]);
    assert.equal(cs[1]!.previous, commits.init);
    assert.equal(cs[2]!.previous, undefined);
    assert.deepEqual(cs[1]!.files, [{ path: "CLAUDE.md", added: 1, removed: 0 }]);
  });

  it("a session's version is the newest harness commit its HEAD reaches", async () => {
    const s = [at("v1", commits["unrelated code"]!, { flagged: false, tested: true, k: 0 }), at("v2", "0000000000000000000000000000000000000000", { flagged: false, tested: true, k: 1 })];
    const v = await sessionVersions(root, s);
    assert.equal(v.get("v1"), commits["add the test rule"]);
    assert.equal(v.has("v2"), false, "a HEAD git does not have is left out");
  });
});

describe("changeEffects", () => {
  it("helped: fewer flagged sessions and the new line followed; MCP-only sessions are not scored on the line", async () => {
    const sessions: Session[] = [];
    for (let k = 0; k < 6; k++) sessions.push(at(`b${k}`, commits.init!, { flagged: k < 4, tested: false, k }));
    for (let k = 0; k < 6; k++) sessions.push(at(`a${k}`, k % 2 ? commits["unrelated code"]! : commits["add the test rule"]!, { flagged: false, tested: true, k: 10 + k }));
    sessions.push(mcpOnly("m0", commits["add the test rule"]!, 20));
    const effects = await changeEffects(root, sessions, { since: 0, limit: 5, events: async (id) => events.get(id) ?? [] });
    const e = effects.find((x) => x.change.subject === "add the test rule")!;
    assert.deepEqual([e.before.sessions, e.before.flagged, e.after.sessions, e.after.flagged], [6, 4, 6, 0], "the MCP-only session is not a work session");
    assert.equal(e.verdict, "helped", e.reason);
    assert.equal(e.rules.length, 1);
    assert.equal(e.rules[0]!.polarity, "require");
    assert.deepEqual([e.rules[0]!.before, e.rules[0]!.after], [{ acted: 0, n: 6 }, { acted: 6, n: 6 }], "the MCP-only session is left out of n");
    const first = effects.find((x) => x.change.subject === "init")!;
    assert.equal(first.verdict, "no-baseline");
    const last = effects.find((x) => x.change.subject === "ask for a summary")!;
    assert.equal(last.verdict, "no-sessions-after");
  });

  it("regressed: more sessions flagged after a change", async () => {
    const sessions: Session[] = [];
    for (let k = 0; k < 6; k++) sessions.push(at(`p${k}`, commits["add the test rule"]!, { flagged: false, tested: true, k }));
    for (let k = 0; k < 6; k++) sessions.push(at(`q${k}`, commits["ask for a summary"]!, { flagged: k < 5, tested: true, k: 10 + k }));
    const [e] = await changeEffects(root, sessions, { since: 0, limit: 1, events: async (id) => events.get(id) ?? [] });
    assert.equal(e!.change.subject, "ask for a summary");
    assert.equal(e!.verdict, "regressed", e!.reason);
    assert.match(e!.reason, /flagged sessions 0 of 6 before, 5 of 6 after/);
  });

  it("lists every flagged session on each side, newest first, with its diagnosed flags", async () => {
    const sessions: Session[] = [];
    for (let k = 0; k < 6; k++) sessions.push(at(`r${k}`, commits["add the test rule"]!, { flagged: k === 2, tested: true, k }));
    for (let k = 0; k < 6; k++) sessions.push(at(`s${k}`, commits["ask for a summary"]!, { flagged: k % 2 === 0, tested: true, k: 10 + k }));
    // A tag (has a colon) and an undiagnosed flag are not failures: s5 stays unflagged.
    sessions[11] = { ...sessions[11]!, flags: ["skill:pdf", "not-a-flag"] };
    const [e] = await changeEffects(root, sessions, { since: 0, limit: 1, events: async (id) => events.get(id) ?? [] });
    assert.deepEqual(
      e!.after.flaggedSessions.map((s) => [s.id, s.flags, s.startedAt]),
      [
        ["s4", ["no-verification"], T0 + 14 * 3600_000],
        ["s2", ["no-verification"], T0 + 12 * 3600_000],
        ["s0", ["no-verification"], T0 + 10 * 3600_000],
      ],
    );
    assert.equal(e!.after.flagged, e!.after.flaggedSessions.length);
    assert.deepEqual(e!.before.flaggedSessions.map((s) => s.id), ["r2"]);
  });
});

describe("decide", () => {
  const g = (sessions: number, flagged: number, o: { byFlag?: Record<string, number>; toolCalls?: number[]; durationMs?: number[] } = {}): GroupStats => ({
    sessions,
    flagged,
    byFlag: o.byFlag ?? {},
    examples: [],
    flaggedSessions: [],
    ...(o.toolCalls || o.durationMs ? { work: { toolCalls: o.toolCalls ?? [], durationMs: o.durationMs ?? [] } } : {}),
  });
  const rule = (b: [number, number], a: [number, number], p: number): RuleEffect => ({ text: "Run `npm test` before you say you are done.", path: "CLAUDE.md", line: 2, polarity: "require", before: { acted: b[0], n: b[1] }, after: { acted: a[0], n: a[1] }, p });

  it("too early with few sessions after; no clear change when it could be chance", () => {
    assert.equal(decide(g(6, 3), g(2, 0), []).verdict, "too-early");
    assert.equal(decide(g(6, 3), g(6, 2), []).verdict, "no-clear-change");
    assert.equal(decide(g(0, 0), g(6, 2), []).verdict, "no-baseline");
    assert.equal(decide(g(6, 2), g(0, 0), []).verdict, "no-sessions-after");
  });

  it("a line the agent follows with the flagged share unchanged is followed-no-effect, not helped (5/10 → 5/10, acted 0/10 → 9/10)", () => {
    const d = decide(g(10, 5, { byFlag: { "no-verification": 5 } }), g(10, 5, { byFlag: { "no-verification": 5 } }), [rule([0, 10], [9, 10], 0.0001)]);
    assert.equal(d.verdict, "followed-no-effect", d.reason);
    assert.equal(
      d.reason,
      "The agent follows the new line (9 of 10 sessions after, 0 of 10 before, p 0.00), but flagged sessions did not fall (5 of 10 before, 5 of 10 after, p 1.00): following a line is not the same as fixing what it targets.",
    );
    assert.equal(d.work, undefined, "no work data, no work field");
  });

  it("the flagged share falling is helped (8/20 → 1/20)", () => {
    const d = decide(g(20, 8), g(20, 1), []);
    assert.equal(d.verdict, "helped", d.reason);
    assert.ok(d.p! <= ALPHA);
    assert.equal(d.reason, `Fewer sessions went wrong after it: flagged sessions 8 of 20 before, 1 of 20 after (p ${d.p!.toFixed(2)}).`);
  });

  it("one flag falling while another rises in its place is not helped (6/20 → 6/20, repeated failures 6 → 0, looping 0 → 6)", () => {
    const d = decide(g(20, 6, { byFlag: { "repeated-tool-failure": 6 } }), g(20, 6, { byFlag: { looping: 6 } }), []);
    assert.notEqual(d.verdict, "helped", d.reason);
    assert.equal(d.verdict, "no-clear-change");
    assert.match(d.reason, /repeated-tool-failure fell \(6 of 20 before, 0 of 20 after\) but looping rose \(0 of 20 before, 6 of 20 after\): the failures moved\./);
  });

  it("one flag falling with Holm p ≤ ALPHA, nothing rising and the flagged share not up, is helped", () => {
    // 6 had repeated failures (3 of them also looping); after, 3 have looping only.
    const d = decide(g(20, 6, { byFlag: { "repeated-tool-failure": 6, looping: 3 } }), g(20, 3, { byFlag: { looping: 3 } }), []);
    assert.ok(d.p! > ALPHA, "the flagged share alone is not significant");
    assert.equal(d.verdict, "helped", d.reason);
    assert.match(d.reason, /^Fewer sessions had repeated-tool-failure after it: 6 of 20 before, 0 of 20 after \(Holm p 0\.0\d\); flagged sessions 6 of 20 before, 3 of 20 after\.$/);
  });

  it("helped names a flag that rose without significance, with its counts (no-verification 6 → 0, repeated failures 4 → 8 of 12)", () => {
    const d = decide(g(12, 10, { byFlag: { "no-verification": 6, "repeated-tool-failure": 4 } }), g(12, 8, { byFlag: { "repeated-tool-failure": 8 } }), []);
    assert.equal(d.verdict, "helped", d.reason);
    assert.equal(
      d.reason,
      "Fewer sessions had no-verification after it: 6 of 12 before, 0 of 12 after (Holm p 0.03); flagged sessions 10 of 12 before, 8 of 12 after. repeated-tool-failure rose 4 to 8 of 12, not significant.",
    );
    // Sides of different sizes give each count its own total.
    const uneven = decide(g(12, 10, { byFlag: { "no-verification": 6, "repeated-tool-failure": 4 } }), g(15, 8, { byFlag: { "repeated-tool-failure": 8 } }), []);
    assert.equal(uneven.verdict, "helped", uneven.reason);
    assert.match(uneven.reason, / repeated-tool-failure rose 4 of 12 to 8 of 15, not significant\.$/);
  });

  it("helped by the flagged share names a rising flag too, before the added work; no rising flag, no such clause", () => {
    const d = decide(g(20, 12, { byFlag: { "no-verification": 12 } }), g(20, 3, { byFlag: { looping: 2, churn: 1 } }), []);
    assert.equal(d.verdict, "helped", d.reason);
    assert.equal(d.reason, `Fewer sessions went wrong after it: flagged sessions 12 of 20 before, 3 of 20 after (p ${d.p!.toFixed(2)}). looping rose 0 to 2 of 20, not significant; churn rose 0 to 1 of 20, not significant.`);
    const toolCalls = (n: number) => Array.from({ length: 12 }, (_, k) => n + (k % 3));
    const work = decide(g(12, 10, { byFlag: { "no-verification": 6, "repeated-tool-failure": 4 }, toolCalls: toolCalls(20) }), g(12, 8, { byFlag: { "repeated-tool-failure": 8 }, toolCalls: toolCalls(45) }), []);
    assert.match(work.reason, /\. repeated-tool-failure rose 4 to 8 of 12, not significant\. It also added work: sessions after it make more tool calls /);
    // A flag whose share held (looping 3 → 3) or fell is not named.
    for (const quiet of [decide(g(20, 6, { byFlag: { "repeated-tool-failure": 6, looping: 3 } }), g(20, 3, { byFlag: { looping: 3 } }), []), decide(g(20, 8, { byFlag: { looping: 8 } }), g(20, 1, { byFlag: { looping: 1 } }), [])]) {
      assert.equal(quiet.verdict, "helped", quiet.reason);
      assert.doesNotMatch(quiet.reason, /rose|not significant/);
    }
  });

  it("one flag falling is not helped when the flagged share rose, even with no single flag rising significantly", () => {
    const d = decide(g(20, 6, { byFlag: { "repeated-tool-failure": 6 } }), g(20, 9, { byFlag: { looping: 3, churn: 3, "no-progress": 3 } }), []);
    assert.notEqual(d.verdict, "helped", d.reason);
    assert.equal(d.verdict, "no-clear-change");
  });

  it("one flag falling that does not survive Holm is not helped", () => {
    // 3 → 0 of 20 (raw p 0.23) among three flags seen before.
    const d = decide(g(20, 5, { byFlag: { "repeated-tool-failure": 3, looping: 1, churn: 1 } }), g(20, 2, { byFlag: { looping: 1, churn: 1 } }), []);
    assert.equal(d.verdict, "no-clear-change", d.reason);
  });

  it("more tool calls after it with the flags unchanged is costlier, naming both medians", () => {
    const before = g(10, 5, { byFlag: { "no-verification": 5 }, toolCalls: [18, 19, 20, 20, 20, 20, 21, 22, 20, 19] });
    const after = g(10, 5, { byFlag: { "no-verification": 5 }, toolCalls: [44, 45, 45, 46, 45, 43, 47, 45, 45, 44] });
    const d = decide(before, after, [rule([0, 10], [9, 10], 0.0001)]);
    assert.equal(d.verdict, "costlier", d.reason);
    assert.match(d.reason, /^Sessions after it make more tool calls \(median 20 → 45, p 0\.00\), and flagged sessions did not fall \(5 of 10 before, 5 of 10 after, p 1\.00\)\.$/);
    assert.deepEqual(d.work?.toolCalls && [d.work.toolCalls.before, d.work.toolCalls.after], [20, 45]);
    assert.ok(d.work!.toolCalls!.p <= ALPHA);
  });

  it("helped with added work stays helped and says so; longer sessions count as work too", () => {
    const secs = (xs: number[]) => xs.map((x) => x * 1000);
    const before = g(20, 8, { durationMs: secs([80, 85, 88, 90, 86, 84, 82, 88, 90, 87, 89, 88, 85, 86, 84, 90, 88, 87, 86, 88]) });
    const after = g(20, 1, { durationMs: secs([150, 156, 160, 158, 152, 154, 156, 157, 159, 155, 156, 153, 151, 160, 156, 158, 157, 156, 155, 154]) });
    const d = decide(before, after, []);
    assert.equal(d.verdict, "helped", d.reason);
    assert.match(d.reason, / It also added work: sessions after it take longer \(median 87 → 156 s, p 0\.00\)\.$/);
  });

  it("regressed is unchanged by the new rules", () => {
    const d = decide(g(10, 0), g(10, 6), [rule([0, 10], [9, 10], 0.0001)]);
    assert.equal(d.verdict, "regressed");
    assert.equal(d.reason, `More sessions went wrong after it: flagged sessions 0 of 10 before, 6 of 10 after (p ${d.p!.toFixed(2)}).`);
  });
});

describe("work", () => {
  it("the permutation p is seeded and deterministic; identical inputs give p = 1", () => {
    const a = [3, 5, 8, 2, 9, 4];
    const b = [12, 15, 9, 20, 14, 11];
    assert.equal(permutationP(a, b), permutationP(a, b));
    assert.equal(permutationP(a, a), 1);
    assert.equal(permutationP([5, 5, 5, 5, 5], [5, 5, 5, 5, 5]), 1);
    assert.ok(permutationP(a, b) <= 0.05, String(permutationP(a, b)));
    assert.ok(permutationP(a, b, { shuffles: 500, seed: 7 }) > 0);
  });

  it("no work field with equal work or fewer than MIN_AFTER sessions a side", () => {
    const g = (toolCalls: number[]): GroupStats => ({ sessions: toolCalls.length, flagged: 0, byFlag: {}, examples: [], flaggedSessions: [], work: { toolCalls, durationMs: [] } });
    assert.equal(workEffect(g([5, 6, 7, 8, 9]), g([5, 6, 7, 8, 9])), undefined, "equal work");
    assert.equal(workEffect(g([5, 6, 7, 8]), g([50, 60, 70, 80, 90])), undefined, "4 sessions before");
    assert.ok(workEffect(g([5, 6, 7, 8, 9]), g([50, 60, 70, 80, 90]))?.toolCalls);
  });
});

describe("withoutMcp", () => {
  it("drops MCP tool calls, start and end, by tool name or server", () => {
    const ev = sessionEvents("x", { cwd: root, startedAt: T0 }, [
      ["tool.start", { tool: "mcp__coding_sh__improve", toolUseId: "1" }],
      ["tool.end", { tool: "mcp__coding_sh__improve", toolUseId: "1", ok: true }],
      ["tool.start", { tool: "search", toolUseId: "2", server: "docs" }],
      ["tool.end", { tool: "search", toolUseId: "2", ok: true }],
      ["tool.start", { tool: "Bash", toolUseId: "3", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "3", ok: true }],
    ]);
    assert.deepEqual(
      withoutMcp(ev).map((e) => e.payload.toolUseId),
      ["3", "3"],
    );
  });
});
