import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWorkHandoff,
  buildWorkTimeline,
  formatWorkHandoffMarkdown,
} from "../../src/core/handoff.ts";
import { buildSession } from "../../src/core/sessions.ts";
import { buildWorkQueue, workItemId } from "../../src/core/work.ts";
import type { AgentEvent, RepoState, Session } from "../../src/schema/index.ts";

const DAY = 86_400_000;
const DAY1 = Date.UTC(2026, 9, 20, 10, 0, 0);
const DAY2 = DAY1 + DAY + 4 * 3600_000;
const DAY3 = DAY1 + 2 * DAY - 3600_000;
const CWD = "/work/demo";
const REPO: RepoState = { root: CWD, branch: "feat/key-rotation", head: "3b5f1f08" };

type Step = [AgentEvent["kind"], Record<string, unknown>, { durationMs?: number; tsOffsetMs?: number }?];

const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

function makeSession(
  id: string,
  startTs: number,
  steps: Step[],
  opts: { agent?: string; parentSessionId?: string; parentType?: string } = {},
): { session: Session; events: AgentEvent[] } {
  let ts = startTs;
  const agent = opts.agent ?? "claude-code";
  const events: AgentEvent[] = steps.map(([kind, payload, extra], i) => {
    ts += extra?.tsOffsetMs ?? 1000;
    const ev: AgentEvent = {
      id: `${id}-${i}`,
      v: 0,
      sessionId: id,
      ts,
      agent,
      cwd: CWD,
      repo: REPO,
      kind,
      payload,
    };
    if (extra?.durationMs !== undefined) ev.durationMs = extra.durationMs;
    return ev;
  });
  const session = buildSession(events);
  if (opts.parentSessionId) {
    session.parent = { sessionId: opts.parentSessionId };
    if (opts.parentType) session.parent.type = opts.parentType;
  }
  return { session, events };
}

describe("buildWorkHandoff and buildWorkTimeline", () => {
  it("stitches a 3-day work item with direction pivot, deduplicated dead ends, proof rollup, and secret redaction", () => {
    const apiKey = ["sk-ant-api03-", "A".repeat(40)].join("");
    const ghToken = ["ghp_", "B".repeat(36)].join("");
    const dbPass = "TopSecret42";

    // Day 1: initial goal, first edit, passing check, dead-end script failure.
    const d1 = makeSession("s-day1", DAY1, [
      ["session.start", {}],
      ["user.message", { text: `Implement JWT auth refresh middleware without logging ${apiKey}.` }],
      ["file.change", { path: `${CWD}/src/auth.ts`, op: "modify", diff: diff("src/auth.ts", "-const ttl = 10;", "+const ttl = 60;") }],
      ["tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "t1", ok: true, output: "10 passing" }],
      ["tool.start", { tool: "Bash", toolUseId: "t2", input: { command: `curl -H "Authorization: Bearer ${ghToken}" https://api.example.com/migrate` } }],
      ["tool.end", { tool: "Bash", toolUseId: "t2", ok: false, exitCode: 1, output: `Error: connection refused for postgres://admin:${dbPass}@db.example.com:5432/app` }],
      ["session.end", {}],
    ]);

    // Day 2: direction pivot, compaction, repeated dead-end, Lean proof sorry + oscillating failures -> high risk.
    const d2 = makeSession(
      "s-day2",
      DAY2,
      [
        ["session.start", {}],
        ["user.message", { text: "Pivot to Ed25519 signing keys and prove rotation invariant in Proof/KeyRotate.lean without sorry." }],
        ["file.change", { path: "src/auth.ts", op: "modify", diff: diff("src/auth.ts", "-const alg = 'HS256';", "+const alg = 'Ed25519';") }],
        ["file.change", { path: "Proof/KeyRotate.lean", op: "modify", diff: diff("Proof/KeyRotate.lean", " theorem rotate_ok (k : Nat) : k = k := by", "-  rfl", "+  sorry") }],
        ["context.compact", { trigger: "auto", tokensBefore: 160_000 }],
        ["tool.start", { tool: "Bash", toolUseId: "t2", input: { command: `curl -H "Authorization: Bearer ${ghToken}" https://api.example.com/migrate` } }],
        ["tool.end", { tool: "Bash", toolUseId: "t2", ok: false, exitCode: 1, output: `Error: connection refused for postgres://admin:${dbPass}@db.example.com:5432/app` }],
        ["tool.start", { tool: "Bash", toolUseId: "p1", input: { command: "lake env lean Proof/KeyRotate.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "p1", ok: false, output: "Proof/KeyRotate.lean:2:2: error: unsolved goals" }],
        ["tool.start", { tool: "Bash", toolUseId: "p2", input: { command: "lake env lean Proof/KeyRotate.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "p2", ok: false, output: "Proof/KeyRotate.lean:3:2: error: unsolved goals" }],
        ["tool.start", { tool: "Bash", toolUseId: "p3", input: { command: "lake env lean Proof/KeyRotate.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "p3", ok: false, output: "Proof/KeyRotate.lean:4:2: error: unsolved goals" }],
        ["tool.start", { tool: "Bash", toolUseId: "p4", input: { command: "lake env lean Proof/KeyRotate.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "p4", ok: false, output: "Proof/KeyRotate.lean:5:2: error: unsolved goals" }],
        ["tool.start", { tool: "Bash", toolUseId: "p5", input: { command: "lake env lean Proof/KeyRotate.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "p5", ok: false, output: "Proof/KeyRotate.lean:6:2: error: unsolved goals" }],
        ["session.end", {}],
      ],
      { agent: "claude-code", parentSessionId: "s-day1", parentType: "fork" },
    );

    // Day 3: partial fix on another agent, keeps tests green, trivial ack prompt so Day 2 pivot stays latest direction.
    const d3 = makeSession(
      "s-day3",
      DAY3,
      [
        ["session.start", {}],
        ["user.message", { text: "continue" }],
        ["file.change", { path: "src/keys.ts", op: "modify", diff: diff("src/keys.ts", "+export const algo = 'Ed25519';") }],
        ["tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }],
        ["tool.end", { tool: "Bash", toolUseId: "t1", ok: true, output: "12 passing" }],
        ["session.end", {}],
      ],
      { agent: "codex", parentSessionId: "s-day2", parentType: "provider-switch" },
    );

    // Pass sessions intentionally out of order to verify chronological sorting.
    const sessions = [d3.session, d1.session, d2.session];
    const queue = buildWorkQueue(sessions, { all: true, now: DAY3 + 60_000 });
    assert.equal(queue.items.length, 1);
    const item = queue.items[0]!;
    assert.equal(item.id, workItemId("s-day1"));

    const eventsBySession = new Map<string, AgentEvent[]>([
      [d1.session.id, d1.events],
      [d2.session.id, d2.events],
      [d3.session.id, d3.events],
    ]);

    const packet = buildWorkHandoff(item, sessions, eventsBySession, {
      shortId: (id) => id.slice(0, 6),
    });

    assert.equal(packet.workId, item.id);
    assert.equal(packet.repo, CWD);
    assert.equal(packet.branch, "feat/key-rotation");
    assert.deepEqual(packet.agents, ["claude-code", "codex"]);
    assert.equal(packet.spanDays, 3);
    assert.equal(packet.totalSessions, 3);
    assert.equal(packet.omittedSessions, undefined);
    assert.equal(packet.firstStartedAt?.slice(0, 10), "2026-10-20");
    assert.equal(packet.lastEndedAt?.slice(0, 10), "2026-10-22");

    // Original goal from Day 1 + latest meaningful direction pivot from Day 2.
    assert.ok(packet.goal?.startsWith("Implement JWT auth refresh middleware"));
    assert.equal(
      packet.latestDirection,
      "Pivot to Ed25519 signing keys and prove rotation invariant in Proof/KeyRotate.lean without sorry.",
    );

    // Chronological timeline across 3 days.
    assert.equal(packet.timeline.length, 3);
    assert.deepEqual(
      packet.timeline.map((e) => [e.sessionId, e.day, e.agent]),
      [
        ["s-day1", "2026-10-20", "claude-code"],
        ["s-day2", "2026-10-21", "claude-code"],
        ["s-day3", "2026-10-22", "codex"],
      ],
    );
    assert.equal(packet.timeline[0]!.shortId, "s-day1");
    assert.equal(packet.timeline[1]!.compactions, 1);
    assert.equal(packet.timeline[1]!.risk, "high");
    assert.equal(packet.timeline[1]!.proofVerdict, "incomplete");
    assert.equal(packet.timeline[0]!.risk, undefined);
    assert.equal(packet.timeline[0]!.proofVerdict, undefined);

    // Deduplicated union of files and latest passing check.
    assert.deepEqual(packet.progress.filesChanged, ["Proof/KeyRotate.lean", "src/auth.ts", "src/keys.ts"]);
    assert.equal(packet.progress.passingChecks.length, 1);
    assert.equal(packet.progress.passingChecks[0]!.command, "npm test");
    assert.equal(packet.progress.passingChecks[0]!.at.slice(0, 10), "2026-10-22");

    // Deduplicated dead-ends across Day 1 and Day 2.
    assert.equal(packet.deadEnds.length, 2);
    assert.equal(packet.deadEnds[0]!.command, "lake env lean Proof/KeyRotate.lean");
    assert.equal(packet.deadEnds[0]!.count, 5);
    assert.equal(packet.deadEnds[1]!.count, 2);
    assert.match(packet.deadEnds[1]!.error ?? "", /connection refused/);

    // Formal-proof rollup.
    assert.ok(packet.proof);
    assert.equal(packet.proof.verdict, "incomplete");
    assert.deepEqual(packet.proof.langs, ["lean"]);
    assert.equal(packet.proof.specUntouched, true);
    assert.equal(packet.proof.escapesRemaining, 1);
    assert.deepEqual(packet.proof.escapeKinds, ["sorry"]);
    assert.ok((packet.proof.oscillatingChecks ?? 0) > 0);

    // Supervision risk and context-reset rollup.
    assert.equal(packet.risk?.level, "high");
    assert.ok(packet.risk?.reasons.includes("tactic-oscillation"));
    assert.deepEqual(packet.contextResets, { compactions: 1, sessionHandoffs: 2, total: 3 });

    // Secret redaction everywhere.
    const serialized = JSON.stringify(packet);
    assert.ok(!serialized.includes(apiKey), "anthropic key redacted");
    assert.ok(!serialized.includes(ghToken), "github token redacted");
    assert.ok(!serialized.includes(dbPass), "db password redacted");

    // Markdown sections.
    assert.equal(formatWorkHandoffMarkdown(packet), packet.markdown);
    assert.match(packet.markdown, /^# Work Handoff\n/);
    assert.match(packet.markdown, /## Goal/);
    assert.match(packet.markdown, /\*\*Original goal:\*\*/);
    assert.match(packet.markdown, /\*\*Latest direction:\*\*/);
    assert.match(packet.markdown, /## Multi-Day Timeline/);
    assert.match(packet.markdown, /## Files Changed/);
    assert.match(packet.markdown, /## Passing Checks/);
    assert.match(packet.markdown, /## Formal Proofs/);
    assert.match(packet.markdown, /## Do Not Repeat/);
    assert.match(packet.markdown, /## Next Step/);
  });

  it("caps timeline sessions via maxSessions while preserving original goal and resolves cross-day proof escapes", () => {
    const d1 = makeSession("s-1", DAY1, [
      ["session.start", {}],
      ["user.message", { text: "Prove add_zero in Proof/Nat.lean." }],
      ["file.change", { path: "Proof/Nat.lean", op: "modify", diff: diff("Proof/Nat.lean", " theorem add_zero (n : Nat) : n + 0 = n := by", "-  rfl", "+  sorry") }],
      ["tool.start", { tool: "Bash", toolUseId: "p1", input: { command: "lake env lean Proof/Nat.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p1", ok: false, output: "Proof/Nat.lean:2:2: error: unsolved goals" }],
      ["session.end", {}],
    ]);

    const d2 = makeSession(
      "s-2",
      DAY2,
      [
        ["session.start", {}],
        ["user.message", { text: "Add helper lemma." }],
        ["file.change", { path: "Proof/Helper.lean", op: "modify", diff: diff("Proof/Helper.lean", "+theorem h : True := trivial") }],
        ["session.end", {}],
      ],
      { parentSessionId: "s-1", parentType: "fork" },
    );

    const d3 = makeSession(
      "s-3",
      DAY3,
      [
        ["session.start", {}],
        ["user.message", { text: "Remove sorry from Proof/Nat.lean and verify." }],
        ["file.change", { path: "Proof/Nat.lean", op: "modify", diff: diff("Proof/Nat.lean", " theorem add_zero (n : Nat) : n + 0 = n := by", "-  sorry", "+  rfl") }],
        ["tool.start", { tool: "Bash", toolUseId: "p2", input: { command: "lake env lean Proof/Nat.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "p2", ok: true, output: "" }],
        ["session.end", {}],
      ],
      { parentSessionId: "s-2", parentType: "fork" },
    );

    const sessions = [d1.session, d2.session, d3.session];
    const eventsBySession = { [d1.session.id]: d1.events, [d2.session.id]: d2.events, [d3.session.id]: d3.events };
    const item = { id: workItemId("s-1"), sessionIds: ["s-1", "s-2", "s-3"] };

    const tl = buildWorkTimeline(item, sessions, eventsBySession, { maxSessions: 2 });
    assert.equal(tl.totalSessions, 3);
    assert.equal(tl.omittedSessions, 1);
    assert.equal(tl.spanDays, 3);
    assert.deepEqual(tl.entries.map((e) => e.sessionId), ["s-2", "s-3"]);

    const packet = buildWorkHandoff(item, sessions, eventsBySession, { maxSessions: 2 });
    assert.equal(packet.goal, "Prove add_zero in Proof/Nat.lean.");
    assert.equal(packet.latestDirection, "Remove sorry from Proof/Nat.lean and verify.");
    assert.equal(packet.timeline.length, 2);
    assert.equal(packet.omittedSessions, 1);
    assert.equal(packet.proof?.verdict, "verified");
    assert.equal(packet.proof?.escapesRemaining, 0);
    assert.deepEqual(packet.deadEnds, []);
    assert.equal(packet.progress.passingChecks.length, 1);
    assert.equal(packet.progress.passingChecks[0]!.command, "lake env lean Proof/Nat.lean");
    assert.match(packet.markdown, /1 older omitted; original goal preserved/);
    assert.doesNotMatch(packet.markdown, /## Do Not Repeat/);
  });

  it("omits latestDirection, proof, risk, and Do Not Repeat for a clean work item without pivots", () => {
    const s1 = makeSession("clean-1", DAY1, [
      ["session.start", {}],
      ["user.message", { text: "Add sum helper test." }],
      ["file.change", { path: "src/sum.ts", op: "modify", diff: diff("src/sum.ts", "+export const sum = (a: number, b: number) => a + b;") }],
      ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c1", ok: true, output: "ok" }],
      ["session.end", {}],
    ]);
    const s2 = makeSession(
      "clean-2",
      DAY1 + 3600_000,
      [
        ["session.start", {}],
        ["user.message", { text: "Add sum helper test." }],
        ["session.end", {}],
      ],
      { parentSessionId: "clean-1", parentType: "fork" },
    );

    const packet = buildWorkHandoff(
      { id: workItemId("clean-1"), sessionIds: ["clean-1", "clean-2"] },
      [s1.session, s2.session],
      new Map([
        [s1.session.id, s1.events],
        [s2.session.id, s2.events],
      ]),
    );

    assert.equal(packet.spanDays, 1);
    assert.equal(packet.latestDirection, undefined);
    assert.equal(packet.proof, undefined);
    assert.equal(packet.risk, undefined);
    assert.deepEqual(packet.deadEnds, []);
    assert.doesNotMatch(packet.markdown, /\*\*Latest direction:\*\*/);
    assert.doesNotMatch(packet.markdown, /## Formal Proofs/);
    assert.doesNotMatch(packet.markdown, /## Do Not Repeat/);
  });
});
