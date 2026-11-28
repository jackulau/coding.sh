import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSession } from "../../src/core/sessions.ts";
import { buildSteerAdvice } from "../../src/core/steer.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { sessionEvents } from "../helpers-decision.ts";

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const CWD = "/work/demo";
const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

function adviceOf(id: string, steps: [AgentEvent["kind"], Record<string, unknown>][]) {
  const events = sessionEvents(id, { cwd: CWD, startedAt: T0 }, steps);
  const session = buildSession(events);
  return buildSteerAdvice(session, events);
}

describe("core/steer buildSteerAdvice", () => {
  it("returns continue with no directives and no suggestedSteer on a clean healthy session", () => {
    const advice = adviceOf("steer-clean", [
      ["session.start", {}],
      ["user.message", { text: "Add helper and run unit tests." }],
      ["file.change", { path: "src/math.ts", op: "modify", diff: diff("src/math.ts", "+export const double = (n: number) => n * 2;") }],
      ["tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "t1", ok: true, output: "1 passed" }],
      ["assistant.message", { text: "Added double and verified tests pass." }],
      ["turn.end", {}],
    ]);

    assert.equal(advice.sessionId, "steer-clean");
    assert.equal(advice.status, "continue");
    assert.equal(advice.risk, "low");
    assert.deepEqual(advice.directives, []);
    assert.equal(advice.suggestedSteer, undefined);
    assert.equal("suggestedSteer" in advice, false);
    assert.equal(advice.telemetry.checks, 1);
    assert.equal(advice.telemetry.unverifiedTailEdits, 0);
    assert.equal(advice.telemetry.maxUnverifiedEdits, 1);
    assert.equal(advice.telemetry.compactions, 0);
    assert.equal(advice.telemetry.deadEndStreak, 0);
    assert.equal(advice.telemetry.proofLangs, undefined);
  });

  it("intervenes on a Lean session with bare lake build, oscillating goals, and sorry", () => {
    const advice = adviceOf("steer-lean-stuck", [
      ["session.start", {}],
      ["user.message", { text: "Prove add_comm_zero in Proof/Lemma.lean." }],
      [
        "file.change",
        {
          path: "Proof/Lemma.lean",
          op: "modify",
          diff: diff("Proof/Lemma.lean", " theorem add_comm_zero (n : Nat) : n + 0 = n := by", "+  sorry"),
        },
      ],
      ["tool.start", { tool: "Bash", toolUseId: "l1", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "l1", ok: false, output: "Proof/Lemma.lean:10:2: error: unsolved goals\n|- n + 0 = n" }],
      [
        "file.change",
        {
          path: "Proof/Lemma.lean",
          op: "modify",
          diff: diff("Proof/Lemma.lean", "+-- tweak tactic"),
        },
      ],
      ["tool.start", { tool: "Bash", toolUseId: "l2", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "l2", ok: false, output: "Proof/Lemma.lean:11:2: error: unsolved goals\n|- n + 0 = n" }],
      [
        "file.change",
        {
          path: "Proof/Lemma.lean",
          op: "modify",
          diff: diff("Proof/Lemma.lean", "+-- tweak tactic again"),
        },
      ],
      ["tool.start", { tool: "Bash", toolUseId: "l3", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "l3", ok: false, output: "Proof/Lemma.lean:12:2: error: unsolved goals\n|- n + 0 = n" }],
    ]);

    assert.equal(advice.status, "intervene");
    assert.equal(advice.risk, "high");
    const kinds = advice.directives.map((d) => d.kind);
    assert.ok(kinds.includes("break-oscillation"), `expected break-oscillation in ${kinds.join(", ")}`);
    assert.ok(kinds.includes("target-single-file"), `expected target-single-file in ${kinds.join(", ")}`);
    assert.ok(kinds.includes("resolve-escapes"), `expected resolve-escapes in ${kinds.join(", ")}`);

    assert.ok(advice.suggestedSteer, "expected actionable suggestedSteer");
    assert.match(advice.suggestedSteer, /Proof\/Lemma\.lean/);
    const singleFile = advice.directives.find((d) => d.kind === "target-single-file")!;
    assert.match(singleFile.steerText, /lake env lean Proof\/Lemma\.lean/);
    assert.deepEqual(advice.telemetry.proofLangs, ["lean"]);
    assert.equal(advice.telemetry.oscillatingChecks, 2);
    assert.equal(advice.telemetry.escapeRemaining, 1);
  });

  it("intervenes on long-horizon coding session with unverified tail edits, post-compaction repeats, and dead-end streak", () => {
    const advice = adviceOf("steer-long-horizon", [
      ["session.start", {}],
      ["user.message", { text: "Migrate database layer and pass tests." }],
      ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "npm test -- db" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c1", ok: false, output: "Error: connection refused" }],
      ["context.compact", { trigger: "auto", tokensBefore: 160_000 }],
      ["tool.start", { tool: "Bash", toolUseId: "c2", input: { command: "npm test -- db" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c2", ok: false, output: "Error: connection refused" }],
      ["tool.start", { tool: "Bash", toolUseId: "c3", input: { command: "npm test -- db" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c3", ok: false, output: "Error: connection refused" }],
      ["tool.start", { tool: "Bash", toolUseId: "c4", input: { command: "npm test -- db" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c4", ok: false, output: "Error: connection refused" }],
      ["file.change", { path: "src/db.ts", op: "modify", diff: diff("src/db.ts", "+const a = 1;") }],
      ["file.change", { path: "src/pool.ts", op: "modify", diff: diff("src/pool.ts", "+const b = 2;") }],
      ["file.change", { path: "src/migrate.ts", op: "modify", diff: diff("src/migrate.ts", "+const c = 3;") }],
    ]);

    assert.equal(advice.status, "intervene");
    assert.equal(advice.risk, "high");
    const kinds = advice.directives.map((d) => d.kind);
    assert.ok(kinds.includes("reset-context"), `expected reset-context in ${kinds.join(", ")}`);
    assert.ok(kinds.includes("verify-now"), `expected verify-now in ${kinds.join(", ")}`);
    assert.ok(kinds.includes("break-dead-end"), `expected break-dead-end in ${kinds.join(", ")}`);

    const reset = advice.directives.find((d) => d.kind === "reset-context")!;
    assert.match(reset.steerText, /coding\.sh handoff steer-long-horizon/);
    const verify = advice.directives.find((d) => d.kind === "verify-now")!;
    assert.match(verify.steerText, /src\/db\.ts/);
    const deadEnd = advice.directives.find((d) => d.kind === "break-dead-end")!;
    assert.match(deadEnd.steerText, /npm test -- db/);

    assert.equal(advice.telemetry.compactions, 1);
    assert.equal(advice.telemetry.deadEndStreak, 4);
    assert.equal(advice.telemetry.unverifiedTailEdits, 3);
  });

  it("nudges on a single medium-priority issue such as 3 unverified tail edits", () => {
    const advice = adviceOf("steer-nudge", [
      ["session.start", {}],
      ["user.message", { text: "Refactor parser helpers." }],
      ["file.change", { path: "src/a.ts", op: "modify", diff: diff("src/a.ts", "+export const a = 1;") }],
      ["file.change", { path: "src/b.ts", op: "modify", diff: diff("src/b.ts", "+export const b = 2;") }],
      ["file.change", { path: "src/c.ts", op: "modify", diff: diff("src/c.ts", "+export const c = 3;") }],
    ]);

    assert.equal(advice.status, "nudge");
    assert.equal(advice.risk, "medium");
    assert.deepEqual(
      advice.directives.map((d) => d.kind),
      ["verify-now"],
    );
    assert.ok(advice.suggestedSteer && advice.suggestedSteer.includes("src/a.ts"));
  });

  it("emits audit-tamper on tampered proofs and answer-wait on blocking waits", () => {
    const tampered = adviceOf("steer-tamper", [
      ["session.start", {}],
      ["user.message", { text: "Prove Sort." }],
      ["tool.start", { tool: "Bash", toolUseId: "d1", input: { command: "dafny verify src/Sort.dfy" } }],
      ["tool.end", { tool: "Bash", toolUseId: "d1", ok: false, output: "src/Sort.dfy(2,0): Error: a postcondition could not be proved" }],
      [
        "file.change",
        {
          path: "src/Sort.dfy",
          op: "modify",
          diff: diff("src/Sort.dfy", " method Sort(a: array<int>)", "-  ensures Sorted(a)", "  ensures a.Length >= 0", " {"),
        },
      ],
      ["tool.start", { tool: "Bash", toolUseId: "d2", input: { command: "dafny verify src/Sort.dfy" } }],
      ["tool.end", { tool: "Bash", toolUseId: "d2", ok: true, output: "Dafny program verifier finished with 1 verified, 0 errors" }],
    ]);

    assert.equal(tampered.status, "intervene");
    assert.equal(tampered.directives[0]?.kind, "audit-tamper");
    assert.match(tampered.directives[0]!.steerText, /src\/Sort\.dfy/);

    const waitingEvents = sessionEvents("steer-wait", { cwd: CWD, startedAt: T0 }, [
      ["session.start", {}],
      ["user.message", { text: "Deploy preview." }],
      ["tool.start", { tool: "AskUserQuestion", toolUseId: "q1", input: { question: "Approve staging deploy?" } }],
    ]);
    const waitingSession = buildSession(waitingEvents);
    const waitingAdvice = buildSteerAdvice(waitingSession, waitingEvents);
    assert.equal(waitingAdvice.status, "intervene");
    assert.equal(waitingAdvice.directives[0]?.kind, "answer-wait");
    assert.match(waitingAdvice.directives[0]!.steerText, /Approve staging deploy\?/);
  });

  it("redacts secrets in steerText, evidence, and suggestedSteer", () => {
    const fakeToken = ["ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
    const cmd = `curl -H "Authorization: Bearer ${fakeToken}" https://api.example.test/fail`;
    const advice = adviceOf("steer-redact", [
      ["session.start", {}],
      ["user.message", { text: "Call staging endpoint." }],
      ["tool.start", { tool: "Bash", toolUseId: "s1", input: { command: cmd } }],
      ["tool.end", { tool: "Bash", toolUseId: "s1", ok: false, output: `401 invalid token ${fakeToken}` }],
      ["tool.start", { tool: "Bash", toolUseId: "s2", input: { command: cmd } }],
      ["tool.end", { tool: "Bash", toolUseId: "s2", ok: false, output: `401 invalid token ${fakeToken}` }],
      ["tool.start", { tool: "Bash", toolUseId: "s3", input: { command: cmd } }],
      ["tool.end", { tool: "Bash", toolUseId: "s3", ok: false, output: `401 invalid token ${fakeToken}` }],
    ]);

    assert.ok(advice.directives.length > 0);
    const serialized = JSON.stringify(advice);
    assert.equal(serialized.includes(fakeToken), false, "secret token must not appear in SteerAdvice");
    assert.match(serialized, /\[redacted:/, "redaction marker should replace secret");
  });
});
