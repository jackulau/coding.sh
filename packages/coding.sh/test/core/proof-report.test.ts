import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { attachDiskCheck, buildProofReport, verifyProofFilesOnDisk } from "../../src/core/proof-report.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent } from "../../src/schema/index.ts";

const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);
const CWD = "/work/demo";

type Step = [AgentEvent["kind"], Record<string, unknown>, { durationMs?: number; tsOffsetMs?: number }?];

const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

function makeTrace(id: string, steps: Step[]) {
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
    if (extra?.durationMs !== undefined) ev.durationMs = extra.durationMs;
    return ev;
  });
  const session = buildSession(events);
  return { session, events };
}

describe("buildProofReport", () => {
  it("reports no-proof on non-proof TypeScript and Verilog sessions", () => {
    const tsTrace = makeTrace("s-ts", [
      ["session.start", {}],
      ["file.change", { path: "src/app.ts", op: "modify", diff: diff("src/app.ts", "-const x = 1;", "+const x = 2;") }],
      ["tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }],
      ["tool.end", { tool: "Bash", toolUseId: "t1", ok: true, output: "all passed" }],
    ]);
    const tsRep = buildProofReport(tsTrace.session, tsTrace.events);
    assert.equal(tsRep.verdict, "no-proof");
    assert.deepEqual(tsRep.langs, []);
    assert.deepEqual(tsRep.proofFiles, []);
    assert.equal(tsRep.specUntouched, true);
    assert.equal(tsRep.checks.total, 0);
    assert.equal(tsRep.checks.lastOk, null);
    assert.deepEqual(tsRep.verifyHints, []);

    const verilogTrace = makeTrace("s-rtl", [
      ["session.start", {}],
      ["file.change", { path: "rtl/alu.v", op: "modify", diff: diff("rtl/alu.v", "+module alu(input clk);", "+  assign admit = 1'b0;", "+endmodule") }],
    ]);
    const verilogRep = buildProofReport(verilogTrace.session, verilogTrace.events);
    assert.equal(verilogRep.verdict, "no-proof");
    assert.deepEqual(verilogRep.langs, []);
  });

  it("reports verified for Lean when sorry is removed, check passes, and spec stays untouched", () => {
    const { session, events } = makeTrace("s-lean-ok", [
      ["session.start", {}],
      ["file.change", { path: "Proof/Add.lean", op: "modify", diff: diff("Proof/Add.lean", " theorem add_zero (n : Nat) : n + 0 = n := by", "-  sorry", "+  simp") }],
      ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "lake build" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c1", ok: false, output: "Proof/Add.lean:2:2: error: simp made no progress" }, { durationMs: 4200 }],
      ["file.change", { path: "Proof/Add.lean", op: "modify", diff: diff("Proof/Add.lean", " theorem add_zero (n : Nat) : n + 0 = n := by", "-  simp", "+  omega") }],
      ["tool.start", { tool: "Bash", toolUseId: "c2", input: { command: "lake env lean Proof/Add.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c2", ok: true, output: "" }, { durationMs: 800 }],
    ]);
    const r = buildProofReport(session, events);
    assert.equal(r.verdict, "verified");
    assert.deepEqual(r.langs, ["lean"]);
    assert.deepEqual(r.proofFiles, ["Proof/Add.lean"]);
    assert.deepEqual(r.specFilesTouched, []);
    assert.equal(r.specUntouched, true);
    assert.deepEqual(r.escapes, { added: 0, removed: 1, remaining: 0, kinds: [] });
    assert.deepEqual(r.checks, { total: 2, passed: 1, failed: 1, wholeProject: 1, lastOk: true, medianMs: 2500 });
    assert.deepEqual(r.tamperFindings, []);
    assert.equal(r.verifyHints.length, 1);
    assert.match(r.verifyHints[0]!, /lake env lean Proof\/Add\.lean/);
    assert.match(r.verifyHints[0]!, /#print axioms/);
  });

  it("reports incomplete when sorry remains or when last check fails or no check passes", () => {
    const withSorry = makeTrace("s-lean-sorry", [
      ["session.start", {}],
      ["file.change", { path: "Proof/Main.lean", op: "modify", diff: diff("Proof/Main.lean", " theorem t : 1 = 1 := by", "-  rfl", "+  sorry") }],
      ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "lake env lean Proof/Main.lean" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c1", ok: true, output: "warning: declaration uses 'sorry'" }, { durationMs: 600 }],
    ]);
    const r1 = buildProofReport(withSorry.session, withSorry.events);
    assert.equal(r1.verdict, "incomplete");
    assert.deepEqual(r1.escapes, { added: 1, removed: 0, remaining: 1, kinds: ["sorry"] });
    assert.equal(r1.checks.passed, 1);
    assert.equal(r1.checks.lastOk, true);
    assert.deepEqual(r1.tamperFindings, []);

    const lastFailed = makeTrace("s-rocq-fail", [
      ["session.start", {}],
      ["file.change", { path: "theories/Add.v", op: "modify", diff: diff("theories/Add.v", " Lemma add_0 : forall n, n + 0 = n.", " Proof.", "-  lia.", "+  auto.", " Qed.") }],
      ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "coqc theories/Add.v" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c1", ok: false, output: 'File "theories/Add.v", line 4, characters 0-4:\nError: Attempt to save an incomplete proof' }],
    ]);
    const r2 = buildProofReport(lastFailed.session, lastFailed.events);
    assert.equal(r2.verdict, "incomplete");
    assert.deepEqual(r2.langs, ["rocq"]);
    assert.equal(r2.checks.failed, 1);
    assert.equal(r2.checks.lastOk, false);
    assert.match(r2.verifyHints[0]!, /Print Assumptions/);

    const unchecked = makeTrace("s-lean-nocheck", [
      ["session.start", {}],
      ["file.change", { path: "Proof/Unchecked.lean", op: "modify", diff: diff("Proof/Unchecked.lean", " theorem t : True := by", "-  sorry", "+  trivial") }],
    ]);
    const r3 = buildProofReport(unchecked.session, unchecked.events);
    assert.equal(r3.verdict, "incomplete");
    assert.equal(r3.checks.total, 0);
  });

  it("reports tampered when a theorem or spec is weakened or a bypass flag is used across Verus and Dafny", () => {
    const dafnyWeak = makeTrace("s-dafny-weak", [
      ["session.start", {}],
      ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "dafny verify src/Sort.dfy" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c1", ok: false, output: "src/Sort.dfy(8,0): Error: a postcondition could not be proved" }],
      [
        "file.change",
        {
          path: "src/Sort.dfy",
          op: "modify",
          diff: diff("src/Sort.dfy", " method Sort(a: array<int>)", "-  ensures Sorted(a)", "  ensures a.Length >= 0", " {"),
        },
      ],
      ["tool.start", { tool: "Bash", toolUseId: "c2", input: { command: "dafny verify src/Sort.dfy" } }],
      ["tool.end", { tool: "Bash", toolUseId: "c2", ok: true, output: "Dafny program verifier finished with 1 verified, 0 errors" }],
    ]);
    const rDafny = buildProofReport(dafnyWeak.session, dafnyWeak.events);
    assert.equal(rDafny.verdict, "tampered");
    assert.deepEqual(rDafny.langs, ["dafny"]);
    assert.equal(rDafny.specUntouched, false);
    assert.deepEqual(rDafny.specFilesTouched, ["src/Sort.dfy"]);
    assert.ok(rDafny.tamperFindings.some((f) => f.kind === "statement" && /weakened/.test(f.detail)));
    assert.match(rDafny.verifyHints[0]!, /dafny verify src\/Sort\.dfy/);

    const verusVerified = makeTrace("s-verus-ok", [
      ["session.start", {}],
      [
        "file.change",
        {
          path: "src/lib.rs",
          op: "modify",
          diff: diff("src/lib.rs", " verus! {", " proof fn lemma_id(x: int)", "   ensures x + 0 == x", " {", "-  assume(x + 0 == x);", "+  assert(x + 0 == x);", " }", " }"),
        },
      ],
      ["tool.start", { tool: "Bash", toolUseId: "v1", input: { command: "verus src/lib.rs" } }],
      ["tool.end", { tool: "Bash", toolUseId: "v1", ok: true, output: "verification results:: 1 verified, 0 errors" }],
    ]);
    const rVerus = buildProofReport(verusVerified.session, verusVerified.events);
    assert.equal(rVerus.verdict, "verified");
    assert.deepEqual(rVerus.langs, ["verus"]);
    assert.equal(rVerus.escapes.removed, 1);
    assert.equal(rVerus.escapes.remaining, 0);
    assert.match(rVerus.verifyHints[0]!, /verus src\/lib\.rs/);

    const bypass = makeTrace("s-bypass", [
      ["session.start", {}],
      ["file.change", { path: "src/Main.dfy", op: "modify", diff: diff("src/Main.dfy", " lemma L() {}", "+// note") }],
      ["tool.start", { tool: "Bash", toolUseId: "b1", input: { command: "dafny verify --no-verify src/Main.dfy" } }],
      ["tool.end", { tool: "Bash", toolUseId: "b1", ok: true, output: "Dafny program verifier finished" }],
    ]);
    const rBypass = buildProofReport(bypass.session, bypass.events);
    assert.equal(rBypass.verdict, "tampered");
    assert.ok(rBypass.tamperFindings.some((f) => f.kind === "bypass" && f.detail.includes("--no-verify")));
  });

  it("redacts secrets in tamper findings", () => {
    const key = ["sk-ant-api03-", "Z".repeat(40)].join("");
    const { session, events } = makeTrace("s-redact", [
      ["session.start", {}],
      ["file.change", { path: `specs/${key}.lean`, op: "modify", diff: diff(`specs/${key}.lean`, "-theorem a : True := trivial", "+theorem a : True := trivial") }],
      ["file.change", { path: `specs/${key}.lean`, op: "modify", diff: diff(`specs/${key}.lean`, "-def specVal := 1", "+def specVal := 2") }],
    ]);
    const r = buildProofReport(session, events);
    assert.equal(r.verdict, "tampered");
    assert.ok(!JSON.stringify(r).includes(key), "secret is redacted everywhere in the report");
  });

  it("matches idless proof checker calls identically to stats.verification.proof", () => {
    const { session, events } = makeTrace("s-idless", [
      ["session.start", {}],
      ["file.change", { path: "Proof/Idless.lean", op: "modify", diff: diff("Proof/Idless.lean", " theorem t : 1 = 1 := by", "-  sorry", "+  rfl") }],
      ["tool.start", { tool: "Bash", input: { command: "ls" } }],
      ["tool.end", { tool: "Bash", ok: true, output: "Proof" }],
      ["tool.start", { tool: "Bash", input: { command: "lake env lean Proof/Idless.lean" } }],
      ["tool.end", { tool: "Bash", ok: true, output: "" }, { durationMs: 420 }],
    ]);
    const r = buildProofReport(session, events);
    assert.equal(r.verdict, "verified");
    assert.equal(r.checks.total, 1);
    assert.equal(r.checks.passed, 1);
    assert.equal(r.checks.lastOk, true);
    assert.equal(r.checks.total, session.stats.verification?.proof?.checks);
    assert.equal(r.checks.passed, session.stats.verification?.proof?.passed);
  });
});

describe("verifyProofFilesOnDisk and attachDiskCheck", () => {
  it("ignores escape tokens in comments and strings while catching real escapes on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "csh-proof-disk-"));
    try {
      mkdirSync(join(dir, "Proof"), { recursive: true });
      writeFileSync(
        join(dir, "Proof", "Clean.lean"),
        [
          "-- sorry in a line comment",
          "/- nested /- sorry -/ axiom in block comment -/",
          'def msg := "sorry and admit inside a string"',
          "theorem ok : 1 + 1 = 2 := by rfl",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "Proof", "Hole.lean"),
        [
          "-- comment sorry",
          "theorem real_hole : True := by",
          "  sorry",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "Proof", "Rocq.v"),
        [
          "(* Admitted. inside a comment *)",
          "Module Type SIG.",
          "  Axiom t : Type.",
          "End SIG.",
          "Lemma bad : False.",
          "Proof.",
          "  Admitted.",
        ].join("\n"),
      );

      const cleanCheck = verifyProofFilesOnDisk(dir, ["Proof/Clean.lean"]);
      assert.deepEqual(cleanCheck, { scanned: 1, missing: 0, remainingEscapes: [] });

      const mixedCheck = verifyProofFilesOnDisk(dir, ["Proof/Clean.lean", "Proof/Hole.lean", "Proof/Rocq.v", "Proof/Missing.lean", "../escape.lean"]);
      assert.equal(mixedCheck.scanned, 3);
      assert.equal(mixedCheck.missing, 2);
      assert.deepEqual(mixedCheck.remainingEscapes, [
        { file: "Proof/Hole.lean", line: 3, token: "sorry" },
        { file: "Proof/Rocq.v", line: 7, token: "Admitted" },
      ]);

      // Attaching a disk check with remaining escapes downgrades verified -> incomplete.
      const { session, events } = makeTrace("s-downgrade", [
        ["session.start", {}],
        ["file.change", { path: "Proof/Hole.lean", op: "modify", diff: diff("Proof/Hole.lean", "+-- minor comment") }],
        ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "lake env lean Proof/Hole.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "c1", ok: true, output: "" }],
      ]);
      const base = buildProofReport(session, events);
      assert.equal(base.verdict, "verified");
      const withDisk = attachDiskCheck(base, dir);
      assert.equal(withDisk.verdict, "incomplete");
      assert.equal(withDisk.diskCheck?.remainingEscapes.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalates verified to tampered when attachDiskCheck finds a kernel-bypass hatch on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "csh-proof-bypass-"));
    try {
      mkdirSync(join(dir, "Proof"), { recursive: true });
      writeFileSync(
        join(dir, "Proof", "Bypass.lean"),
        ["set_option debug.skipKernelTC true", "theorem ok : 1 = 1 := by rfl"].join("\n"),
      );
      const { session, events } = makeTrace("s-disk-bypass", [
        ["session.start", {}],
        ["file.change", { path: "Proof/Bypass.lean", op: "modify", diff: diff("Proof/Bypass.lean", "+-- minor comment") }],
        ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "lake env lean Proof/Bypass.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "c1", ok: true, output: "" }],
      ]);
      const base = buildProofReport(session, events);
      assert.equal(base.verdict, "verified");
      const withDisk = attachDiskCheck(base, dir);
      assert.equal(withDisk.verdict, "tampered");
      assert.deepEqual(withDisk.diskCheck?.remainingEscapes, [{ file: "Proof/Bypass.lean", line: 1, token: "debug.skipKernelTC" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never reads files outside repoRoot through directory junctions or file symlinks", () => {
    const base = mkdtempSync(join(tmpdir(), "csh-proof-link-"));
    const repoDir = join(base, "repo");
    const outsideDir = join(base, "outside");
    try {
      mkdirSync(join(repoDir, "Proof"), { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      const outsideFile = join(outsideDir, "Secret.lean");
      writeFileSync(outsideFile, "theorem leaked : False := by sorry\n");

      // Directory junction (works unprivileged on Windows) or dir symlink on POSIX.
      symlinkSync(outsideDir, join(repoDir, "linked"), process.platform === "win32" ? "junction" : "dir");
      const junctionRes = verifyProofFilesOnDisk(repoDir, ["linked/Secret.lean"]);
      assert.deepEqual(junctionRes, { scanned: 0, missing: 1, remainingEscapes: [] });

      // File symlink when permitted by the OS.
      let fileLinkCreated = false;
      try {
        symlinkSync(outsideFile, join(repoDir, "Proof", "Leak.lean"), "file");
        fileLinkCreated = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES") throw err;
      }
      if (fileLinkCreated) {
        const fileLinkRes = verifyProofFilesOnDisk(repoDir, ["Proof/Leak.lean"]);
        assert.deepEqual(fileLinkRes, { scanned: 0, missing: 1, remainingEscapes: [] });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
