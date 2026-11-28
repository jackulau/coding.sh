// `coding.sh proof <session>` through the CLI in a throwaway HOME and repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ProofReport } from "../../src/core/proof-report.ts";
import { CLI } from "../_cli.ts";
import { putSession, sessionEvents } from "../helpers-decision.ts";

const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);
const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

let root = "";
let home = "";
let repo = "";
let env: NodeJS.ProcessEnv = {};

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: repo, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-cli-proof-")));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(join(repo, "Proof"), { recursive: true });
  env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
  };

  writeFileSync(
    join(repo, "Proof", "Clean.lean"),
    [
      "-- sorry inside comment only",
      'def note := "sorry inside string"',
      "theorem add_zero (n : Nat) : n + 0 = n := by omega",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "Proof", "WithHole.lean"),
    [
      "-- comment sorry",
      "theorem still_open : True := by",
      "  sorry",
    ].join("\n"),
  );

  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    await putSession(
      ctx.index,
      sessionEvents("proof-verified-1111", { cwd: repo, startedAt: T0 }, [
        ["session.start", {}],
        ["user.message", { text: "Finish the add_zero proof." }],
        ["file.change", { path: "Proof/Clean.lean", op: "modify", diff: diff("Proof/Clean.lean", " theorem add_zero (n : Nat) : n + 0 = n := by", "-  sorry", "+  omega") }],
        ["tool.start", { tool: "Bash", toolUseId: "c1", input: { command: "lake env lean Proof/Clean.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "c1", ok: true, output: "" }],
      ]),
    );

    await putSession(
      ctx.index,
      sessionEvents("proof-diskhole-2222", { cwd: repo, startedAt: T0 + 60_000 }, [
        ["session.start", {}],
        ["user.message", { text: "Clean up WithHole.lean." }],
        ["file.change", { path: "Proof/WithHole.lean", op: "modify", diff: diff("Proof/WithHole.lean", "+-- comment edit") }],
        ["tool.start", { tool: "Bash", toolUseId: "c2", input: { command: "lake env lean Proof/WithHole.lean" } }],
        ["tool.end", { tool: "Bash", toolUseId: "c2", ok: true, output: "" }],
      ]),
    );

    await putSession(
      ctx.index,
      sessionEvents("proof-tampered-3333", { cwd: repo, startedAt: T0 + 120_000 }, [
        ["session.start", {}],
        ["user.message", { text: "Prove Sort." }],
        ["tool.start", { tool: "Bash", toolUseId: "c3", input: { command: "dafny verify src/Sort.dfy" } }],
        ["tool.end", { tool: "Bash", toolUseId: "c3", ok: false, output: "src/Sort.dfy(2,0): Error: a postcondition could not be proved" }],
        ["file.change", { path: "src/Sort.dfy", op: "modify", diff: diff("src/Sort.dfy", " method Sort(a: array<int>)", "-  ensures Sorted(a)", "  ensures a.Length >= 0", " {") }],
        ["tool.start", { tool: "Bash", toolUseId: "c4", input: { command: "dafny verify src/Sort.dfy" } }],
        ["tool.end", { tool: "Bash", toolUseId: "c4", ok: true, output: "Dafny program verifier finished with 1 verified, 0 errors" }],
      ]),
    );

    await putSession(
      ctx.index,
      sessionEvents("proof-noproof-4444", { cwd: repo, startedAt: T0 + 180_000 }, [
        ["session.start", {}],
        ["user.message", { text: "Update README." }],
        ["file.change", { path: "src/app.ts", op: "modify", diff: diff("src/app.ts", "-export const a = 1;", "+export const a = 2;") }],
      ]),
    );
  } finally {
    await ctx.close();
  }
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("coding.sh proof", () => {
  it("prints a review card and JSON report for verified sessions and exits 0 with --strict", () => {
    const text = cli("proof", "proof-verified", "--check-disk", "--strict");
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /Verdict\s+verified/);
    assert.match(text.stdout, /Languages\s+lean/);
    assert.match(text.stdout, /Spec files\s+untouched/);
    assert.match(text.stdout, /Disk check\s+1 scanned, 0 missing, 0 remaining escapes/);
    assert.match(text.stdout, /#print axioms/);

    const json = cli("proof", "proof-verified-1111", "--check-disk", "--strict", "--json");
    assert.equal(json.status, 0, json.stdout + json.stderr);
    const doc = JSON.parse(json.stdout) as ProofReport;
    assert.equal(doc.verdict, "verified");
    assert.deepEqual(doc.diskCheck, { scanned: 1, missing: 0, remainingEscapes: [] });
  });

  it("catches real escape hatches on disk with --check-disk and gates with --strict", () => {
    const withoutDisk = cli("proof", "proof-diskhole-2222", "--strict", "--json");
    assert.equal(withoutDisk.status, 0, withoutDisk.stdout + withoutDisk.stderr);
    assert.equal((JSON.parse(withoutDisk.stdout) as ProofReport).verdict, "verified");

    const withDisk = cli("proof", "proof-diskhole-2222", "--check-disk", "--strict", "--json");
    assert.equal(withDisk.status, 1, "strict exits 1 when disk scan finds sorry");
    const doc = JSON.parse(withDisk.stdout) as ProofReport;
    assert.equal(doc.verdict, "incomplete");
    assert.deepEqual(doc.diskCheck, {
      scanned: 1,
      missing: 0,
      remainingEscapes: [{ file: "Proof/WithHole.lean", line: 3, token: "sorry" }],
    });
  });

  it("exits 0 without --strict and 1 with --strict on tampered sessions, and 0 on no-proof latest", () => {
    const nonStrict = cli("proof", "proof-tampered-3333");
    assert.equal(nonStrict.status, 0, nonStrict.stdout + nonStrict.stderr);
    assert.match(nonStrict.stdout, /Verdict\s+tampered/);
    assert.match(nonStrict.stdout, /Tamper findings/);

    const strict = cli("proof", "proof-tampered-3333", "--strict");
    assert.equal(strict.status, 1, "strict exits 1 on tampered");

    const latest = cli("proof", "latest", "--strict", "--json");
    assert.equal(latest.status, 0, latest.stdout + latest.stderr);
    assert.equal((JSON.parse(latest.stdout) as ProofReport).verdict, "no-proof");
  });
});
