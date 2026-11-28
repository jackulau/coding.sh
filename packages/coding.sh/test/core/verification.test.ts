import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { deserialize, serialize } from "node:v8";
import * as show from "../../src/cli/commands/show.ts";
import { buildProofReport } from "../../src/core/proof-report.ts";
import { buildSession, foldSession, isFoldState, sessionOf, sessionState } from "../../src/core/sessions.ts";
import type { AgentEvent, EventKind } from "../../src/schema/index.ts";
import { runCmd, sandbox, type Sandbox } from "../cli/_cmd.ts";

let seq = 0;
const T0 = 1_750_000_000_000;
const ev = (kind: EventKind, payload: Record<string, unknown> = {}, o: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `ve${++seq}`,
  v: 0,
  sessionId: "ver-sess",
  ts: T0 + seq * 100,
  agent: "claude-code",
  cwd: "/work/demo",
  kind,
  payload,
  ...o,
});

const bash = (
  command: string,
  ok: boolean,
  opts: { output?: string; durationMs?: number; id?: string; startTs?: number; endTs?: number } = {},
): AgentEvent[] => {
  const id = opts.id ?? `tu${seq + 1}`;
  const start = ev("tool.start", { tool: "Bash", toolUseId: id, input: { command } }, opts.startTs !== undefined ? { ts: opts.startTs } : {});
  const endPayload: Record<string, unknown> = { tool: "Bash", toolUseId: id, ok };
  if (opts.output !== undefined) endPayload.output = opts.output;
  const endExtra: Partial<AgentEvent> = {};
  if (opts.endTs !== undefined) endExtra.ts = opts.endTs;
  if (opts.durationMs !== undefined) endExtra.durationMs = opts.durationMs;
  const end = ev("tool.end", endPayload, endExtra);
  return [start, end];
};

const editFile = (path: string, diff?: string, id?: string): AgentEvent[] => {
  const tid = id ?? `ed${seq + 1}`;
  const fcPayload: Record<string, unknown> = { path, op: "modify", tool: "Edit", toolUseId: tid };
  if (diff !== undefined) fcPayload.diff = diff;
  return [
    ev("tool.start", { tool: "Edit", toolUseId: tid, input: { file_path: path } }),
    ev("file.change", fcPayload),
    ev("tool.end", { tool: "Edit", toolUseId: tid, ok: true }),
  ];
};

describe("stats.verification", () => {
  const sandboxes: Sandbox[] = [];
  after(() => {
    for (const sb of sandboxes) sb.cleanup();
  });

  it("omits stats.verification when a session has no edits, checks, or proof activity", () => {
    const s = buildSession([
      ev("user.message", { text: "explain src/app.ts" }),
      ev("tool.start", { tool: "Read", toolUseId: "r1", input: { file_path: "src/app.ts" } }),
      ev("tool.end", { tool: "Read", toolUseId: "r1", ok: true, output: "export const x = 1;" }),
      ev("assistant.message", { text: "It exports x." }),
    ]);
    assert.equal(s.stats.verification, undefined);
    assert.equal("verification" in s.stats, false);
  });

  it("tracks unverified edit streaks, tail edits, median check latency, and test.result deduplication", () => {
    const events: AgentEvent[] = [
      ...editFile("src/a.ts"),
      ...editFile("src/b.ts"),
      ...editFile("src/c.ts"),
      // One npm test run that also emits a derived test.result with the same toolUseId counts once.
      ...bash("npm test", false, { id: "chk1", durationMs: 400, output: "1 failing" }),
      ev("test.result", { runner: "node:test", passed: 2, failed: 1, toolUseId: "chk1" }),
      ...editFile("src/a.ts"),
      ...bash("npm test", true, { id: "chk2", durationMs: 1200, output: "3 passing" }),
      ev("test.result", { runner: "node:test", passed: 3, failed: 0, toolUseId: "chk2" }),
      ...bash("npx tsc --noEmit", true, { id: "chk3", durationMs: 800, output: "" }),
      ...editFile("src/d.ts"),
      ...editFile("src/e.ts"),
    ];
    const s = buildSession(events);
    assert.deepEqual(s.stats.verification, {
      checks: 3,
      passed: 2,
      failed: 1,
      maxUnverifiedEdits: 3,
      unverifiedTailEdits: 2,
      medianCheckMs: 800,
    });
  });

  it("records unverifiedTailEdits as total edits when no check ran and omits medianCheckMs when no duration exists", () => {
    const events: AgentEvent[] = [
      ev("file.change", { path: "src/x.ts", op: "modify" }),
      ev("file.change", { path: "src/y.ts", op: "modify" }),
    ];
    const s = buildSession(events);
    assert.deepEqual(s.stats.verification, {
      checks: 0,
      passed: 0,
      failed: 0,
      maxUnverifiedEdits: 2,
      unverifiedTailEdits: 2,
    });
    assert.equal("medianCheckMs" in s.stats.verification!, false);
    assert.equal("proof" in s.stats.verification!, false);
  });

  it("tracks Lean proof loop: whole-project lake build vs targeted lake env lean, sorry burn-down, and oscillating goals", () => {
    const events: AgentEvent[] = [
      ...editFile(
        "Math/Add.lean",
        "@@ -1,3 +1,5 @@\n theorem add_zero (n : Nat) : n + 0 = n := by\n-  rfl\n+  sorry\n+theorem add_comm (a b : Nat) : a + b = b + a := by\n+  sorry\n",
      ),
      ...bash("lake build", false, {
        durationMs: 5000,
        output: "Math/Add.lean:4:2: error: unsolved goals\na b : Nat\n⊢ a + b = b + a\n",
      }),
      ...editFile(
        "Math/Add.lean",
        "@@ -1,5 +1,6 @@\n theorem add_zero (n : Nat) : n + 0 = n := by\n-  sorry\n+  simp\n theorem add_comm (a b : Nat) : a + b = b + a := by\n   sorry\n",
      ),
      // Line number shifted from 4 to 5, same normalized error signature => oscillatingChecks = 1.
      ...bash("lake env lean Math/Add.lean", false, {
        durationMs: 1000,
        output: "Math/Add.lean:5:2: error: unsolved goals\na b : Nat\n⊢ a + b = b + a\n",
      }),
      // Another consecutive repeat on the same goal => oscillatingChecks = 2.
      ...bash("lake env lean Math/Add.lean", false, {
        durationMs: 900,
        output: "Math/Add.lean:6:4: error: unsolved goals\na b : Nat\n⊢ a + b = b + a\n",
      }),
      ...editFile(
        "Math/Add.lean",
        "@@ -4,3 +4,3 @@\n theorem add_comm (a b : Nat) : a + b = b + a := by\n-  sorry\n+  omega\n",
      ),
      ...bash("lake env lean Math/Add.lean", true, { durationMs: 1100, output: "" }),
    ];
    const s = buildSession(events);
    assert.deepEqual(s.stats.verification, {
      checks: 4,
      passed: 1,
      failed: 3,
      maxUnverifiedEdits: 1,
      medianCheckMs: 1050,
      proof: {
        langs: ["lean"],
        checks: 4,
        passed: 1,
        failed: 3,
        escapeAdded: 2,
        escapeRemoved: 2,
        oscillatingChecks: 2,
        wholeProjectChecks: 1,
      },
    });
    assert.equal("escapeRemaining" in s.stats.verification!.proof!, false);
    assert.equal(s.stats.contextHygiene?.supervisionRisk, "medium");
    assert.deepEqual(s.stats.contextHygiene?.riskReasons, ["tactic-oscillation"]);
  });

  it("tracks Rocq (Admitted, coqc, bare dune build) and ignores Verilog .v files", () => {
    const rocqEvents: AgentEvent[] = [
      ...editFile(
        "theories/Nat.v",
        "@@ -1,3 +1,4 @@\n Lemma add_0 : forall n, n + 0 = n.\n Proof.\n-  induction n; auto.\n+  Admitted.\n",
      ),
      ...bash("dune build", false, {
        durationMs: 3000,
        output: 'File "./theories/Nat.v", line 10, characters 2-8:\nError: Unable to unify "n + 0" with "n".\n',
      }),
      ...bash("coqc theories/Nat.v", true, { durationMs: 600, output: "" }),
    ];
    const rocq = buildSession(rocqEvents);
    assert.deepEqual(rocq.stats.verification?.proof, {
      langs: ["rocq"],
      checks: 2,
      passed: 1,
      failed: 1,
      escapeAdded: 1,
      escapeRemaining: 1,
      wholeProjectChecks: 1,
    });

    const verilog = buildSession(
      editFile(
        "rtl/alu.v",
        "@@ -1,2 +1,4 @@\n module alu(input wire clk, output reg y);\n+  always @(posedge clk) y <= 1'b0;\n endmodule\n",
      ),
    );
    assert.equal(verilog.stats.verification?.proof, undefined);
  });

  it("tracks Verus and Dafny proof loops with escape hatches and targeted checks", () => {
    const events: AgentEvent[] = [
      ...editFile(
        "src/verified.rs",
        "@@ -1,4 +1,6 @@\n verus! {\n proof fn lemma_pos(x: int)\n   ensures x >= 0,\n {\n+  assume(x >= 0);\n }\n }\n",
      ),
      ...bash("verus src/verified.rs", false, {
        durationMs: 1500,
        output: "error: postcondition not satisfied\n  --> src/verified.rs:3:11\nverification results:: 0 verified, 1 errors\n",
      }),
      ...editFile(
        "spec/Abs.dfy",
        "@@ -1,3 +1,4 @@\n lemma AbsPos(x: int)\n {\n+  assume x >= 0;\n }\n",
      ),
      ...bash("dafny verify spec/Abs.dfy", true, {
        durationMs: 2500,
        output: "Dafny program verifier finished with 1 verified, 0 errors\n",
      }),
    ];
    const s = buildSession(events);
    assert.deepEqual(s.stats.verification?.proof, {
      langs: ["dafny", "verus"],
      checks: 2,
      passed: 1,
      failed: 1,
      escapeAdded: 2,
      escapeRemaining: 2,
    });
  });

  it("maintains full foldSession + serialized incremental fold parity", () => {
    const events: AgentEvent[] = [
      ev("session.start", {}, { sessionId: "parity-ver" }),
      ...editFile("Proof.lean", "@@ -1,2 +1,3 @@\n theorem t : True := by\n+  sorry\n"),
      ...bash("lake build", false, { durationMs: 2000, output: "Proof.lean:2:2: error: unsolved goals\n" }),
      ...bash("lake env lean Proof.lean", false, { durationMs: 400, output: "Proof.lean:3:2: error: unsolved goals\n" }),
      ...editFile("Proof.lean", "@@ -1,3 +1,3 @@\n theorem t : True := by\n-  sorry\n+  trivial\n"),
      ...bash("lake env lean Proof.lean", true, { durationMs: 300, output: "" }),
      ev("session.end", {}, { sessionId: "parity-ver" }),
    ].map((e) => ({ ...e, sessionId: "parity-ver" }));

    const full = buildSession(events);
    const mid = Math.floor(events.length / 2);
    const st = sessionState();
    for (const e of events.slice(0, mid)) foldSession(st, e);
    const restored = deserialize(serialize(st));
    assert.equal(isFoldState(restored), true);
    for (const e of events.slice(mid)) foldSession(restored, e);
    const incremental = sessionOf(restored);
    assert.deepEqual(incremental.stats.verification, full.stats.verification);
    assert.deepEqual(incremental.stats.contextHygiene, full.stats.contextHygiene);
  });

  it("renders a concise Verify row in `coding.sh show` only when relevant", async () => {
    const sb = sandbox();
    sandboxes.push(sb);
    const proofEvents = [
      ev("session.start", {}, { sessionId: "show-proof" }),
      ...editFile("Foo.lean", "@@ -1,2 +1,3 @@\n theorem a : True := by\n+  sorry\n"),
      ...bash("lake build", true, { durationMs: 1200, output: "" }),
      ev("session.end", {}, { sessionId: "show-proof" }),
    ].map((e) => ({ ...e, sessionId: "show-proof" }));
    const plainEvents = [
      ev("session.start", {}, { sessionId: "show-plain" }),
      ...editFile("src/one.ts"),
      ev("session.end", {}, { sessionId: "show-plain" }),
    ].map((e) => ({ ...e, sessionId: "show-plain" }));

    await sb.seed([buildSession(proofEvents), buildSession(plainEvents)], [...proofEvents, ...plainEvents]);
    const proofOut = await runCmd(show, sb, { positionals: ["show-proof"] });
    const verifyLines = proofOut.stdout.split("\n").filter((l) => l.startsWith("  Verify"));
    assert.equal(verifyLines.length, 1);
    assert.match(verifyLines[0]!, /1 check \(1 passed, median 1\.2s\); proof: lean, 1\/1 passed, 1 escape remaining, 1 whole-project/);

    const plainOut = await runCmd(show, sb, { positionals: ["show-plain"] });
    assert.equal(plainOut.stdout.includes("  Verify"), false, "single unverified edit without checks keeps show unchanged");
  });

  it("skips escapes in tests/, examples/, scratch/ and kernel-bypass hatches to match buildProofReport", () => {
    const events: AgentEvent[] = [
      ev("session.start", {}),
      ...editFile("tests/Test.lean", "@@ -1,2 +1,3 @@\n theorem t : True := by\n+  sorry\n"),
      ...editFile("examples/Demo.lean", "@@ -1,2 +1,3 @@\n theorem d : True := by\n+  sorry\n"),
      ...editFile("scratch/Try.lean", "@@ -1,2 +1,3 @@\n theorem s : True := by\n+  sorry\n"),
      ...editFile("Proof/Main.lean", "@@ -1,2 +1,3 @@\n+set_option debug.skipKernelTC true\n theorem m : True := by trivial\n"),
      ...editFile("Proof/Real.lean", "@@ -1,2 +1,3 @@\n theorem r : True := by\n+  sorry\n"),
      ...bash("lake env lean Proof/Real.lean", true, { durationMs: 400, output: "" }),
      ev("session.end", {}),
    ];
    const s = buildSession(events);
    const report = buildProofReport(s, events);
    assert.equal(s.stats.verification?.proof?.escapeAdded, 1);
    assert.equal(s.stats.verification?.proof?.escapeRemaining, 1);
    assert.equal(s.stats.verification?.proof?.escapeAdded, report.escapes.added);
    assert.equal(s.stats.verification?.proof?.escapeRemaining, report.escapes.remaining);
  });
});
