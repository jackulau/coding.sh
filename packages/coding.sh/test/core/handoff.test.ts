import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHandoff, formatHandoffMarkdown } from "../../src/core/handoff.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, RepoState } from "../../src/schema/index.ts";

const T0 = Date.UTC(2026, 9, 22, 14, 0, 0);
const CWD = "/work/demo";

type Step = [AgentEvent["kind"], Record<string, unknown>, { durationMs?: number; tsOffsetMs?: number }?];

const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

function makeTrace(id: string, steps: Step[], repo?: RepoState) {
  let ts = T0;
  const events: AgentEvent[] = steps.map(([kind, payload, extra], i) => {
    ts += extra?.tsOffsetMs ?? 1000;
    const ev: AgentEvent = {
      id: `${id}-${i}`,
      v: 0,
      sessionId: id,
      ts,
      agent: "claude-code",
      cwd: CWD,
      kind,
      payload,
    };
    if (repo) ev.repo = repo;
    if (extra?.durationMs !== undefined) ev.durationMs = extra.durationMs;
    return ev;
  });
  const session = buildSession(events);
  return { session, events };
}

describe("buildHandoff", () => {
  it("extracts goal, changed files, passing checks, repeated dead ends, and redacts secrets everywhere", () => {
    const apiKey = ["sk-ant-api03-", "A".repeat(40)].join("");
    const ghToken = ["ghp_", "B".repeat(36)].join("");
    const dbPass = "SuperSecret99";

    const { session, events } = makeTrace(
      "s-coding-1",
      [
        ["session.start", {}],
        ["user.message", { text: "<system-reminder>internal harness note</system-reminder>" }],
        [
          "user.message",
          {
            text: `[Workflow harness run-1]\nProject: demo\nFix auth refresh middleware without leaking ${apiKey} in logs.`,
          },
        ],
        ["file.change", { path: `${CWD}/src/auth.ts`, op: "modify", diff: diff("src/auth.ts", "-const a = 1;", "+const a = 2;") }],
        ["tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npx tsc --noEmit" } }],
        ["tool.end", { tool: "Bash", toolUseId: "t1", ok: true, output: "" }],
        // Benign rg miss should stay out of deadEnds.
        ["tool.start", { tool: "Bash", toolUseId: "t-rg", input: { command: "rg nonexistent src/" } }],
        ["tool.end", { tool: "Bash", toolUseId: "t-rg", ok: false, exitCode: 1, output: "" }],
        // Repeated failing command before and after compaction, carrying secrets in command and error output.
        ["tool.start", { tool: "Bash", toolUseId: "t2", input: { command: `curl -H "Authorization: Bearer ${ghToken}" https://api.example.com/refresh` } }],
        ["tool.end", { tool: "Bash", toolUseId: "t2", ok: false, exitCode: 1, output: `Error: connection refused for postgres://admin:${dbPass}@db.example.com:5432/app` }],
        ["context.compact", { trigger: "auto", tokensBefore: 140_000 }],
        ["tool.start", { tool: "Bash", toolUseId: "t3", input: { command: `curl -H "Authorization: Bearer ${ghToken}" https://api.example.com/refresh` } }],
        ["tool.end", { tool: "Bash", toolUseId: "t3", ok: false, exitCode: 1, output: `Exit code: 1\nError: connection refused for postgres://admin:${dbPass}@db.example.com:5432/app` }],
        // One more unverified edit at the tail.
        ["file.change", { path: "src/session.ts", op: "modify", diff: diff("src/session.ts", "-export const ok = false;", "+export const ok = true;") }],
      ],
      { root: CWD, branch: "feat/auth-refresh", head: "3b5f1f08" },
    );

    const packet = buildHandoff(session, events);

    assert.equal(packet.sessionId, "s-coding-1");
    assert.equal(packet.agent, "claude-code");
    assert.equal(packet.repo, CWD);
    assert.equal(packet.branch, "feat/auth-refresh");
    assert.ok(packet.goal?.startsWith("Fix auth refresh middleware"));
    assert.ok(!packet.goal?.includes("[Workflow harness"));
    assert.ok(!packet.goal?.includes("Project: demo"));

    assert.deepEqual(packet.progress.filesChanged, ["src/auth.ts", "src/session.ts"]);
    assert.equal(packet.progress.passingChecks.length, 1);
    assert.equal(packet.progress.passingChecks[0]!.command, "npx tsc --noEmit");
    assert.equal(packet.progress.passingChecks[0]!.outcome, "passed");
    assert.equal(packet.progress.passingChecks[0]!.kind, "verify");
    assert.equal(packet.progress.unverifiedTailEdits, 1);

    assert.equal(packet.deadEnds.length, 1);
    assert.equal(packet.deadEnds[0]!.count, 2);
    assert.equal(packet.deadEnds[0]!.postCompactionRepeat, true);
    assert.match(packet.deadEnds[0]!.error ?? "", /connection refused/);

    // No secret value may leak anywhere in JSON or Markdown.
    const serialized = JSON.stringify(packet);
    assert.ok(!serialized.includes(apiKey), "anthropic key redacted");
    assert.ok(!serialized.includes(ghToken), "github token redacted");
    assert.ok(!serialized.includes(dbPass), "url password redacted");
    assert.ok(!packet.markdown.includes(apiKey));
    assert.ok(!packet.markdown.includes(ghToken));
    assert.ok(!packet.markdown.includes(dbPass));
    assert.match(packet.markdown, /## Do Not Repeat/);
    assert.match(packet.markdown, /repeated after compaction/);
    assert.equal(packet.proof, undefined);
    assert.equal(packet.risk?.level, "medium");
    assert.ok(packet.risk?.reasons.includes("post-compaction-repeats"));
  });

  it("includes formal proof status and high supervision risk for a Lean session with oscillating failures", () => {
    const { session, events } = makeTrace("s-lean-high", [
      ["session.start", {}],
      ["user.message", { text: "Prove add_comm in Proof/Add.lean without using sorry." }],
      ["file.change", { path: "Proof/Add.lean", op: "modify", diff: diff("Proof/Add.lean", " theorem add_comm (a b : Nat) : a + b = b + a := by", "-  rfl", "+  sorry") }],
      ["tool.start", { tool: "Bash", toolUseId: "p1", input: { command: "lake env lean Proof/Add.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p1", ok: false, output: "Proof/Add.lean:2:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "p2", input: { command: "lake env lean Proof/Add.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p2", ok: false, output: "Proof/Add.lean:3:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "p3", input: { command: "lake env lean Proof/Add.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p3", ok: false, output: "Proof/Add.lean:4:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "p4", input: { command: "lake env lean Proof/Add.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p4", ok: false, output: "Proof/Add.lean:5:2: error: unsolved goals" }],
      ["tool.start", { tool: "Bash", toolUseId: "p5", input: { command: "lake env lean Proof/Add.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "p5", ok: false, output: "Proof/Add.lean:6:2: error: unsolved goals" }],
    ]);

    const packet = buildHandoff(session, events);

    assert.equal(packet.risk?.level, "high");
    assert.ok(packet.risk?.reasons.includes("tactic-oscillation"));
    assert.ok(packet.risk?.reasons.includes("dead-end-loop"));
    assert.equal(packet.risk?.deadEndStreak, 5);

    assert.ok(packet.proof, "proof summary is attached");
    assert.equal(packet.proof.verdict, "incomplete");
    assert.deepEqual(packet.proof.langs, ["lean"]);
    assert.equal(packet.proof.specUntouched, true);
    assert.equal(packet.proof.escapesRemaining, 1);
    assert.deepEqual(packet.proof.escapeKinds, ["sorry"]);
    assert.equal(packet.proof.tamperFindings.length, 0);
    assert.equal(packet.proof.verifyHints.length, 1);
    assert.match(packet.proof.verifyHints[0]!, /lake env lean Proof\/Add\.lean/);

    assert.equal(packet.deadEnds.length, 1);
    assert.equal(packet.deadEnds[0]!.command, "lake env lean Proof/Add.lean");
    assert.equal(packet.deadEnds[0]!.count, 5);

    assert.match(packet.markdown, /## Context Risk/);
    assert.match(packet.markdown, /## Formal Proof Status/);
    assert.match(packet.markdown, /Remaining escapes:\*\* 1 \(sorry\)/);
    assert.match(packet.markdown, /#print axioms/);
    assert.equal(formatHandoffMarkdown(packet), packet.markdown);
  });

  it("omits risk, proof, unverifiedTailEdits, and Do Not Repeat for a clean low-risk session", () => {
    const { session, events } = makeTrace("s-clean-low", [
      ["session.start", {}],
      ["user.message", { text: "Add unit test for sum helper." }],
      ["file.change", { path: "src/sum.ts", op: "modify", diff: diff("src/sum.ts", "+export const sum = (a: number, b: number) => a + b;") }],
      ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c1", ok: true, output: "1 passing" }],
    ]);

    const packet = buildHandoff(session, events);

    assert.equal(packet.risk, undefined);
    assert.equal(packet.proof, undefined);
    assert.equal(packet.progress.unverifiedTailEdits, undefined);
    assert.deepEqual(packet.progress.filesChanged, ["src/sum.ts"]);
    assert.equal(packet.progress.passingChecks.length, 1);
    assert.deepEqual(packet.deadEnds, []);
    assert.doesNotMatch(packet.markdown, /## Context Risk/);
    assert.doesNotMatch(packet.markdown, /## Formal Proof Status/);
    assert.doesNotMatch(packet.markdown, /## Do Not Repeat/);
  });

  it("respects maxDeadEnds and maxFiles caps and drops resolved failures", () => {
    const { session, events } = makeTrace("s-caps", [
      ["session.start", {}],
      ["user.message", { text: "Fix build scripts." }],
      ["file.change", { path: "a.ts", op: "modify" }],
      ["file.change", { path: "b.ts", op: "modify" }],
      ["file.change", { path: "c.ts", op: "modify" }],
      // Fails once then passes: resolved, should appear in passingChecks and stay out of deadEnds.
      ["tool.start", { tool: "Bash", toolUseId: "r1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "r1", ok: false, output: "FAIL a.test.ts" }],
      ["tool.start", { tool: "Bash", toolUseId: "r2", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "r2", ok: true, output: "PASS a.test.ts" }],
      // Three distinct unresolved dead ends, cmd-2 repeated twice so it ranks first.
      ["tool.start", { tool: "Bash", toolUseId: "d1", input: { command: "node scripts/step1.mjs" } }],
      ["tool.end", { tool: "Bash", toolUseId: "d1", ok: false, output: "Error: step1 broke" }],
      ["tool.start", { tool: "Bash", toolUseId: "d2a", input: { command: "node scripts/step2.mjs" } }],
      ["tool.end", { tool: "Bash", toolUseId: "d2a", ok: false, output: "Error: step2 broke" }],
      ["tool.start", { tool: "Bash", toolUseId: "d2b", input: { command: "node scripts/step2.mjs" } }],
      ["tool.end", { tool: "Bash", toolUseId: "d2b", ok: false, output: "Error: step2 still broken" }],
      ["tool.start", { tool: "Bash", toolUseId: "d3", input: { command: "node scripts/step3.mjs" } }],
      ["tool.end", { tool: "Bash", toolUseId: "d3", ok: false, output: "Error: step3 broke" }],
    ]);

    const packet = buildHandoff(session, events, { maxDeadEnds: 2, maxFiles: 2 });
    assert.deepEqual(packet.progress.filesChanged, ["a.ts", "b.ts"]);
    assert.equal(packet.progress.passingChecks.length, 1);
    assert.equal(packet.progress.passingChecks[0]!.command, "npm test");
    assert.equal(packet.deadEnds.length, 2);
    assert.equal(packet.deadEnds[0]!.command, "node scripts/step2.mjs");
    assert.equal(packet.deadEnds[0]!.count, 2);
    assert.equal(packet.deadEnds[1]!.command, "node scripts/step3.mjs");
  });
});
