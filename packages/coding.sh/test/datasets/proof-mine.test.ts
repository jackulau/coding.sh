// Unit and end-to-end CLI tests for formal-verification proof-step dataset mining
// (`mineProofSteps` and `coding.sh dataset mine --proof-steps`).
// Uses throwaway temp HOME / USERPROFILE / CODING_SH_HOME only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { findCommand } from "../../src/cli/registry.ts";
import { PROOF_LANGS } from "../../src/core/proof.ts";
import { DatasetError } from "../../src/datasets/dataset.ts";
import {
  extractSessionProofSteps,
  MAX_WINNING_DIFF_CHARS,
  mineProofSteps,
  type ProofStepExpectedSolved,
  type ProofStepExpectedStuck,
  type ProofStepInput,
} from "../../src/datasets/proof-mine.ts";
import { FileEvalStore } from "../../src/datasets/store.ts";
import type { Dataset } from "../../src/datasets/types.ts";
import type { AgentEvent, Session } from "../../src/schema/index.ts";
import { SqliteIndexStore } from "../../src/store/sqlite.ts";
import { CLI as MAIN } from "../_cli.ts";

// Build synthetic secret tokens via join() so no vendor-shaped literal appears in source.
const FAKE_ANTHROPIC_KEY = ["sk-ant-", "api03-1234567890abcdef1234567890abcdef"].join("");
const FAKE_GH_TOKEN = ["ghp_", "1234567890abcdef1234567890abcdef1234"].join("");

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    agent: "claude-code",
    cwd: "/work/demo",
    repo: { root: "/work/demo", head: "abc123" },
    startedAt: 1_700_000_000_000,
    stats: { events: 6, turns: 2, toolCalls: 4, toolErrors: 1, filesChanged: 1 },
    flags: [],
    ...overrides,
  };
}

function ev(sessionId: string, id: string, ts: number, kind: AgentEvent["kind"], payload: Record<string, unknown>, cwd = "/work/demo"): AgentEvent {
  return { id, v: 0, sessionId, ts, agent: "claude-code", kind, cwd, payload };
}

function leanSolvedEvents(sessionId: string, opts: { withSecrets?: boolean; longDiff?: boolean; repoRoot?: string } = {}): AgentEvent[] {
  const repoRoot = opts.repoRoot ?? "/work/demo";
  const filePath = `${repoRoot.replace(/\\/g, "/")}/Proofs/Add.lean`;
  const secretErr = opts.withSecrets ? `\n-- token: ${FAKE_ANTHROPIC_KEY}` : "";
  const secretDiff = opts.withSecrets ? `\n+  -- key ${FAKE_GH_TOKEN}` : "";
  const padding = opts.longDiff ? `\n+${" ".repeat(2)}-- ${"x".repeat(2500)}` : "";
  return [
    ev(sessionId, `${sessionId}-s1`, 1000, "tool.start", {
      toolUseId: "t1",
      tool: "Bash",
      input: { command: `lake env lean ${filePath}` },
    }, repoRoot),
    ev(sessionId, `${sessionId}-e1`, 1100, "tool.end", {
      toolUseId: "t1",
      tool: "Bash",
      ok: false,
      exitCode: 1,
      output: `Exit code 1\nProofs/Add.lean:12:4: error: unsolved goals\na b : Nat\n⊢ a + b = b + a${secretErr}`,
    }, repoRoot),
    ev(sessionId, `${sessionId}-c1`, 1200, "file.change", {
      toolUseId: "t2",
      path: filePath,
      op: "modify",
      diff: `@@ -10,4 +10,5 @@\n theorem add_comm' (a b : Nat) : a + b = b + a := by\n-  simp\n+  exact Nat.add_comm a b${secretDiff}${padding}`,
    }, repoRoot),
    ev(sessionId, `${sessionId}-s2`, 1300, "tool.start", {
      toolUseId: "t3",
      tool: "Bash",
      input: { command: `lake env lean ${filePath}` },
    }, repoRoot),
    ev(sessionId, `${sessionId}-e2`, 1400, "tool.end", {
      toolUseId: "t3",
      tool: "Bash",
      ok: true,
      exitCode: 0,
      output: "",
    }, repoRoot),
  ];
}

function rocqStuckEvents(sessionId: string): AgentEvent[] {
  return [
    ev(sessionId, `${sessionId}-c0`, 1000, "file.change", {
      toolUseId: "r0",
      path: "/work/demo/Arithmetic.v",
      op: "modify",
      diff: "@@ -1,3 +1,4 @@\n Lemma add_zero : forall n : nat, n + 0 = n.\n Proof.\n+  intros n. simpl.\n",
    }),
    ev(sessionId, `${sessionId}-s1`, 1100, "tool.start", {
      toolUseId: "r1",
      tool: "Bash",
      input: { command: "coqc Arithmetic.v" },
    }),
    ev(sessionId, `${sessionId}-e1`, 1200, "tool.end", {
      toolUseId: "r1",
      tool: "Bash",
      ok: false,
      exitCode: 1,
      output: 'File "./Arithmetic.v", line 4, characters 2-12:\nError: Unable to unify "n + 0" with "n".',
    }),
    ev(sessionId, `${sessionId}-c1`, 1300, "file.change", {
      toolUseId: "r2",
      path: "/work/demo/Arithmetic.v",
      op: "modify",
      diff: "@@ -2,2 +2,2 @@\n-  intros n. simpl.\n+  intros n. reflexivity.",
    }),
    ev(sessionId, `${sessionId}-s2`, 1400, "tool.start", {
      toolUseId: "r3",
      tool: "Bash",
      input: { command: "coqc Arithmetic.v" },
    }),
    ev(sessionId, `${sessionId}-e2`, 1500, "tool.end", {
      toolUseId: "r3",
      tool: "Bash",
      ok: false,
      exitCode: 1,
      output: 'File "./Arithmetic.v", line 4, characters 2-14:\nError: Unable to unify "n + 0" with "n".',
    }),
  ];
}

function dafnyStuckEvents(sessionId: string): AgentEvent[] {
  return [
    ev(sessionId, `${sessionId}-s1`, 2000, "tool.start", {
      toolUseId: "d1",
      tool: "Bash",
      input: { command: "dafny verify Verify.dfy" },
    }),
    ev(sessionId, `${sessionId}-e1`, 2100, "tool.end", {
      toolUseId: "d1",
      tool: "Bash",
      ok: false,
      exitCode: 4,
      output:
        "Verify.dfy(15,12): Error: a postcondition could not be proved on this return path\nVerify.dfy(10,10): Related location: this is the postcondition that could not be proved",
    }),
    ev(sessionId, `${sessionId}-s2`, 2200, "tool.start", {
      toolUseId: "d2",
      tool: "Bash",
      input: { command: "dafny verify --no-verify Verify.dfy" },
    }),
    ev(sessionId, `${sessionId}-e2`, 2300, "tool.end", {
      toolUseId: "d2",
      tool: "Bash",
      ok: true,
      exitCode: 0,
      output: "Dafny program verifier finished with 0 verified, 0 errors",
    }),
  ];
}

describe("extractSessionProofSteps & mineProofSteps", () => {
  it("keeps registry --proof-lang choices in sync with PROOF_LANGS", () => {
    const mine = findCommand("dataset")?.actions?.find((a) => a.name === "mine");
    const langFlag = mine?.flags?.find((f) => f.name === "proof-lang");
    assert.deepEqual(langFlag?.choices, PROOF_LANGS);
  });

  it("extracts Lean solved transition with winningDiff, goalSnippet, normalized file, and secret redaction", async () => {
    const s = makeSession("s-lean-solved");
    const events = leanSolvedEvents(s.id, { withSecrets: true });
    const report = await mineProofSteps({
      sessions: [s],
      getEvents: async () => events,
      tags: ["formal"],
    });

    assert.equal(report.sessions, 1);
    assert.equal(report.matched, 1);
    assert.equal(report.kept, 1);
    assert.equal(report.dropped, 0);

    const c = report.cases[0]!;
    const input = c.input as ProofStepInput;
    const expected = c.expected as ProofStepExpectedSolved;

    assert.equal(input.kind, "proof-step");
    assert.equal(input.lang, "lean");
    assert.equal(input.file, "Proofs/Add.lean");
    assert.equal(input.command, "lake env lean /work/demo/Proofs/Add.lean");
    assert.match(input.error, /unsolved goals/);
    assert.match(input.goalSnippet ?? "", /⊢ a \+ b = b \+ a/);
    assert.equal(input.error.includes(FAKE_ANTHROPIC_KEY), false, "secret in error must be redacted");
    assert.match(input.error, /\[redacted:anthropic-key\]/);

    assert.equal(expected.resolved, true);
    assert.equal(expected.attempts, 1);
    assert.equal(expected.winningCheck, "lake env lean /work/demo/Proofs/Add.lean");
    assert.ok(expected.winningDiff);
    assert.match(expected.winningDiff, /Nat\.add_comm/);
    assert.equal(expected.winningDiff.includes(FAKE_GH_TOKEN), false, "secret in winningDiff must be redacted");
    assert.match(expected.winningDiff, /\[redacted:github-token\]/);

    assert.equal(c.sourceSessionId, s.id);
    assert.equal(c.metadata?.sourceSessionId, s.id);
    assert.equal(c.metadata?.lang, "lean");
    assert.equal(c.metadata?.file, "Proofs/Add.lean");
    assert.equal(c.metadata?.outcome, "solved");
    assert.equal(c.metadata?.attempts, 1);
    assert.equal(c.metadata?.startedAt, s.startedAt);
    assert.equal(c.metadata?.repo, "/work/demo");
    assert.ok(c.tags?.includes("proof-step"));
    assert.ok(c.tags?.includes("proof:lean"));
    assert.ok(c.tags?.includes("outcome:solved"));
    assert.ok(c.tags?.includes("formal"));
  });

  it("caps winningDiff safely to MAX_WINNING_DIFF_CHARS", async () => {
    const s = makeSession("s-lean-long");
    const report = await mineProofSteps({
      sessions: [s],
      getEvents: async () => leanSolvedEvents(s.id, { longDiff: true }),
    });
    assert.equal(report.kept, 1);
    const expected = report.cases[0]!.expected as ProofStepExpectedSolved;
    assert.ok(expected.winningDiff);
    assert.ok(expected.winningDiff.length <= MAX_WINNING_DIFF_CHARS);
    assert.ok(expected.winningDiff.endsWith("…"));
  });

  it("drops solved transitions that introduce an unremoved escape hatch and keeps ones that remove temporary escapes", async () => {
    const sEscape = makeSession("s-lean-sorry");
    const escapeEvents: AgentEvent[] = [
      ev(sEscape.id, "e1", 1000, "tool.start", { toolUseId: "t1", tool: "Bash", input: { command: "lake env lean Proofs/Bad.lean" } }),
      ev(sEscape.id, "e2", 1100, "tool.end", { toolUseId: "t1", tool: "Bash", ok: false, exitCode: 1, output: "Proofs/Bad.lean:5:2: error: unsolved goals\n⊢ True" }),
      ev(sEscape.id, "e3", 1200, "file.change", { toolUseId: "t2", path: "Proofs/Bad.lean", op: "modify", diff: "@@ -4,2 +4,2 @@\n-  omega\n+  sorry" }),
      ev(sEscape.id, "e4", 1300, "tool.start", { toolUseId: "t3", tool: "Bash", input: { command: "lake env lean Proofs/Bad.lean" } }),
      ev(sEscape.id, "e5", 1400, "tool.end", { toolUseId: "t3", tool: "Bash", ok: true, exitCode: 0, output: "warning: declaration uses 'sorry'" }),
    ];

    const sTempEscape = makeSession("s-lean-temp-sorry");
    const tempEscapeEvents: AgentEvent[] = [
      ev(sTempEscape.id, "e1", 1000, "tool.start", { toolUseId: "t1", tool: "Bash", input: { command: "lake env lean Proofs/Good.lean" } }),
      ev(sTempEscape.id, "e2", 1100, "tool.end", { toolUseId: "t1", tool: "Bash", ok: false, exitCode: 1, output: "Proofs/Good.lean:5:2: error: unsolved goals\n⊢ 1 = 1" }),
      ev(sTempEscape.id, "e3", 1200, "file.change", { toolUseId: "t2", path: "Proofs/Good.lean", op: "modify", diff: "@@ -4,2 +4,2 @@\n-  omega\n+  sorry" }),
      ev(sTempEscape.id, "e4", 1250, "file.change", { toolUseId: "t3", path: "Proofs/Good.lean", op: "modify", diff: "@@ -4,2 +4,2 @@\n-  sorry\n+  rfl" }),
      ev(sTempEscape.id, "e5", 1300, "tool.start", { toolUseId: "t4", tool: "Bash", input: { command: "lake env lean Proofs/Good.lean" } }),
      ev(sTempEscape.id, "e6", 1400, "tool.end", { toolUseId: "t4", tool: "Bash", ok: true, exitCode: 0, output: "" }),
    ];

    const byId = new Map<string, AgentEvent[]>([
      [sEscape.id, escapeEvents],
      [sTempEscape.id, tempEscapeEvents],
    ]);
    const report = await mineProofSteps({
      sessions: [sEscape, sTempEscape],
      getEvents: async (id) => byId.get(id) ?? [],
    });

    assert.equal(report.matched, 2);
    assert.equal(report.kept, 1);
    assert.equal(report.droppedBy["proof-escape"], 1);
    assert.equal(report.cases[0]?.sourceSessionId, sTempEscape.id);
  });

  it("extracts Rocq and Dafny stuck goals and ignores bypassed green checks", async () => {
    const sRocq = makeSession("s-rocq-stuck");
    const sDafny = makeSession("s-dafny-stuck");
    const byId = new Map<string, AgentEvent[]>([
      [sRocq.id, rocqStuckEvents(sRocq.id)],
      [sDafny.id, dafnyStuckEvents(sDafny.id)],
    ]);

    const report = await mineProofSteps({
      sessions: [sRocq, sDafny],
      getEvents: async (id) => byId.get(id) ?? [],
    });

    assert.equal(report.matched, 2);
    assert.equal(report.kept, 2);

    const rocq = report.cases.find((c) => c.sourceSessionId === sRocq.id)!;
    const rocqIn = rocq.input as ProofStepInput;
    const rocqExp = rocq.expected as ProofStepExpectedStuck;
    assert.equal(rocqIn.lang, "rocq");
    assert.equal(rocqIn.file, "Arithmetic.v");
    assert.match(rocqIn.error, /Unable to unify/);
    assert.match(rocqIn.goalSnippet ?? "", /Lemma add_zero/);
    assert.equal(rocqExp.resolved, false);
    assert.equal(rocqExp.attempts, 2);
    assert.equal(rocq.metadata?.outcome, "stuck");

    const dafny = report.cases.find((c) => c.sourceSessionId === sDafny.id)!;
    const dafnyIn = dafny.input as ProofStepInput;
    const dafnyExp = dafny.expected as ProofStepExpectedStuck;
    assert.equal(dafnyIn.lang, "dafny");
    assert.equal(dafnyIn.file, "Verify.dfy");
    assert.match(dafnyIn.error, /postcondition could not be proved/);
    assert.match(dafnyIn.goalSnippet ?? "", /Related location/);
    assert.equal(dafnyExp.resolved, false);
    assert.equal(dafnyExp.attempts, 1);
  });

  it("filters by proofLangs and outcome, and deduplicates on incremental re-mining", async () => {
    const sLean = makeSession("s-lean");
    const sRocq = makeSession("s-rocq");
    const sDafny = makeSession("s-dafny");
    const byId = new Map<string, AgentEvent[]>([
      [sLean.id, leanSolvedEvents(sLean.id)],
      [sRocq.id, rocqStuckEvents(sRocq.id)],
      [sDafny.id, dafnyStuckEvents(sDafny.id)],
    ]);
    const sessions = [sLean, sRocq, sDafny];
    const getEvents = async (id: string) => byId.get(id) ?? [];

    const onlySolved = await mineProofSteps({ sessions, getEvents, outcome: "solved" });
    assert.equal(onlySolved.kept, 1);
    assert.equal(onlySolved.droppedBy["proof-outcome"], 2);
    assert.equal(onlySolved.cases[0]?.metadata?.lang, "lean");

    const onlyStuck = await mineProofSteps({ sessions, getEvents, outcome: "stuck" });
    assert.equal(onlyStuck.kept, 2);
    assert.equal(onlyStuck.droppedBy["proof-outcome"], 1);

    const onlyRocq = await mineProofSteps({ sessions, getEvents, proofLangs: ["rocq"] });
    assert.equal(onlyRocq.kept, 1);
    assert.equal(onlyRocq.droppedBy["proof-lang"], 2);
    assert.equal(onlyRocq.cases[0]?.metadata?.lang, "rocq");

    const first = await mineProofSteps({ sessions, getEvents });
    assert.equal(first.kept, 3);

    const second = await mineProofSteps({ sessions, getEvents, existing: first.cases });
    assert.equal(second.kept, 0);
    assert.equal(second.droppedBy["exact-duplicate"], 3);
  });

  it("rejects invalid proofLangs and invalid outcome in JS API", async () => {
    await assert.rejects(
      () =>
        mineProofSteps({
          sessions: [],
          getEvents: async () => [],
          proofLangs: ["agda" as never],
        }),
      DatasetError,
    );
    await assert.rejects(
      () =>
        mineProofSteps({
          sessions: [],
          getEvents: async () => [],
          outcome: "broken" as never,
        }),
      DatasetError,
    );
  });

  it("does not emit a solved case when a green check runs with no proof-file edit after failure", () => {
    const s = makeSession("s-no-edit");
    const events: AgentEvent[] = [
      ev(s.id, "e1", 1000, "tool.start", { toolUseId: "t1", tool: "Bash", input: { command: "lake env lean A.lean" } }),
      ev(s.id, "e2", 1100, "tool.end", { toolUseId: "t1", tool: "Bash", ok: false, exitCode: 1, output: "A.lean:1:1: error: unknown identifier" }),
      ev(s.id, "e3", 1200, "tool.start", { toolUseId: "t2", tool: "Bash", input: { command: "lake env lean A.lean" } }),
      ev(s.id, "e4", 1300, "tool.end", { toolUseId: "t2", tool: "Bash", ok: true, exitCode: 0, output: "" }),
    ];
    assert.equal(extractSessionProofSteps(s, events).length, 0);
  });
});

describe("coding.sh dataset mine --proof-steps CLI", () => {
  let root = "";
  let env: Record<string, string> = {};

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], {
      env,
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  function runJson<T = Record<string, unknown>>(args: string[]): T {
    const r = runCli([...args, "--json"]);
    assert.equal(r.status, 0, `coding.sh ${args.join(" ")} failed (exit ${r.status}):\n${r.stderr}\n${r.stdout}`);
    return JSON.parse(r.stdout) as T;
  }

  async function readDataset(id: string): Promise<Dataset | undefined> {
    const index = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"));
    try {
      return await new FileEvalStore({ env, index }).getDataset(id);
    } finally {
      await index.close();
    }
  }

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-proof-mine-cli-")));
    const home = join(root, "home");
    mkdirSync(join(root, "tmp"), { recursive: true });
    mkdirSync(home);
    env = {
      HOME: home,
      USERPROFILE: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      TMPDIR: join(root, "tmp"),
      PATH: dirname(process.execPath),
      NO_COLOR: "1",
      CODING_SH_NO_AUTO_INGEST: "1",
    };
    mkdirSync(env.CODING_SH_HOME!, { recursive: true });

    const now = Date.now();
    const repo = join(root, "proof-repo");
    mkdirSync(repo, { recursive: true });

    const index = await SqliteIndexStore.open(join(env.CODING_SH_HOME!, "index.db"));
    try {
      const sLean = makeSession("cli-lean-solved", { cwd: repo, repo: { root: repo, head: "aaa111" }, startedAt: now - 60_000 });
      const sRocq = makeSession("cli-rocq-stuck", { cwd: repo, repo: { root: repo, head: "aaa111" }, startedAt: now - 120_000 });
      const sDafny = makeSession("cli-dafny-stuck", { cwd: repo, repo: { root: repo, head: "aaa111" }, startedAt: now - 180_000 });

      await index.upsertSession(sLean);
      await index.putEvents(leanSolvedEvents(sLean.id, { withSecrets: true, repoRoot: repo }));

      await index.upsertSession(sRocq);
      await index.putEvents(
        rocqStuckEvents(sRocq.id).map((e) => ({
          ...e,
          cwd: repo,
          payload:
            e.kind === "file.change"
              ? { ...e.payload, path: join(repo, "Arithmetic.v") }
              : e.payload,
        })),
      );

      await index.upsertSession(sDafny);
      await index.putEvents(dafnyStuckEvents(sDafny.id).map((e) => ({ ...e, cwd: repo })));
    } finally {
      await index.close();
    }
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("mines proof steps end to end, deduplicates on re-run, and shows up in dataset stats and list", async () => {
    const dry = runJson<{ outcome: string; sessions: number; matched: number; kept: number; dropped: number }>([
      "dataset",
      "mine",
      "proof-bench",
      "--proof-steps",
      "--dry-run",
    ]);
    assert.equal(dry.outcome, "dry-run");
    assert.equal(dry.sessions, 3);
    assert.equal(dry.matched, 3);
    assert.equal(dry.kept, 3);
    assert.equal(await readDataset("proof-bench"), undefined);

    const mined = runJson<{
      outcome: string;
      sessions: number;
      matched: number;
      kept: number;
      dataset: { id: string; version: string; cases: number };
    }>(["dataset", "mine", "proof-bench", "--proof-steps"]);
    assert.equal(mined.outcome, "created");
    assert.equal(mined.sessions, 3);
    assert.equal(mined.kept, 3);
    assert.equal(mined.dataset.id, "proof-bench");
    assert.equal(mined.dataset.cases, 3);

    const ds = await readDataset("proof-bench");
    assert.ok(ds);
    assert.equal(ds.cases.length, 3);
    const leanCase = ds.cases.find((c) => c.metadata?.lang === "lean")!;
    assert.ok(leanCase);
    const leanIn = leanCase.input as ProofStepInput;
    const leanExp = leanCase.expected as ProofStepExpectedSolved;
    assert.equal(leanIn.file, "Proofs/Add.lean");
    assert.equal(leanIn.error.includes(FAKE_ANTHROPIC_KEY), false);
    assert.equal((leanExp.winningDiff ?? "").includes(FAKE_GH_TOKEN), false);

    // Incremental re-mining adds 0 duplicates.
    const repeat = runJson<{ outcome: string; kept: number; droppedBy: Record<string, number> }>([
      "dataset",
      "mine",
      "proof-bench",
      "--proof-steps",
    ]);
    assert.equal(repeat.outcome, "unchanged");
    assert.equal(repeat.kept, 0);
    assert.equal(repeat.droppedBy["exact-duplicate"], 3);

    // Inspect via dataset stats and dataset list.
    const stats = runJson<{ id: string; total: number; tags: Record<string, number> }>(["dataset", "stats", "proof-bench"]);
    assert.equal(stats.id, "proof-bench");
    assert.equal(stats.total, 3);
    assert.equal(stats.tags["proof-step"], 3);
    assert.equal(stats.tags["proof:lean"], 1);
    assert.equal(stats.tags["outcome:solved"], 1);
    assert.equal(stats.tags["outcome:stuck"], 2);

    const listed = runJson<{ datasets: { id: string; cases: number }[] }>(["dataset", "list"]);
    assert.ok(listed.datasets.some((d) => d.id === "proof-bench" && d.cases === 3));
  });

  it("supports --proof-lang and --proof-outcome filters via CLI", () => {
    const leanOnly = runJson<{ outcome: string; kept: number; droppedBy: Record<string, number> }>([
      "dataset",
      "mine",
      "proof-lean",
      "--proof-steps",
      "--proof-lang",
      "lean",
    ]);
    assert.equal(leanOnly.outcome, "created");
    assert.equal(leanOnly.kept, 1);
    assert.equal(leanOnly.droppedBy["proof-lang"], 2);

    const stuckOnly = runJson<{ outcome: string; kept: number; droppedBy: Record<string, number> }>([
      "dataset",
      "mine",
      "proof-stuck",
      "--proof-steps",
      "--proof-outcome",
      "stuck",
      "--proof-lang",
      "rocq,dafny",
    ]);
    assert.equal(stuckOnly.outcome, "created");
    assert.equal(stuckOnly.kept, 2);
    assert.equal(stuckOnly.droppedBy["proof-lang"], 1);

    const solvedOnly = runJson<{ outcome: string; kept: number; droppedBy: Record<string, number> }>([
      "dataset",
      "mine",
      "proof-solved",
      "--proof-steps",
      "--proof-outcome",
      "solved",
    ]);
    assert.equal(solvedOnly.outcome, "created");
    assert.equal(solvedOnly.kept, 1);
    assert.equal(solvedOnly.droppedBy["proof-outcome"], 2);
  });

  it("exits 2 on invalid --proof-lang, invalid --proof-outcome, or proof flags without --proof-steps", () => {
    const badLang = runCli(["dataset", "mine", "bad", "--proof-steps", "--proof-lang", "agda"]);
    assert.equal(badLang.status, 2);
    assert.match(badLang.stderr, /--proof-lang/);

    const badOutcome = runCli(["dataset", "mine", "bad", "--proof-steps", "--proof-outcome", "invalid"]);
    assert.equal(badOutcome.status, 2);
    assert.match(badOutcome.stderr, /--proof-outcome/);

    const missingStepsLang = runCli(["dataset", "mine", "bad", "--proof-lang", "lean"]);
    assert.equal(missingStepsLang.status, 2);
    assert.match(missingStepsLang.stderr, /--proof-steps/);

    const missingStepsOutcome = runCli(["dataset", "mine", "bad", "--proof-outcome", "stuck"]);
    assert.equal(missingStepsOutcome.status, 2);
    assert.match(missingStepsOutcome.stderr, /--proof-steps/);
  });
});
