// Case truth beyond seeded bugs (docs/design/workflows.md §5, §7): verifier tests with
// regressions, judge cases with their calibration, the hidden-truth rule for [start], seeded-bug
// validation on a case's snapshot, and the command driver's checkpoint and replay flags.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { JudgeVersion } from "../../src/datasets/types.ts";
import { mockProvider } from "../../src/graders/mock.ts";
import { parseCase } from "../../src/workflows/cases.ts";
import { commandArgs, commandDriver } from "../../src/workflows/drivers/command.ts";
import { parseJudgeRef, scoreWorkflowCase } from "../../src/workflows/score/case.ts";
import { validateCase } from "../../src/workflows/seed/bugs.ts";
import type { WorkflowCase } from "../../src/workflows/types.ts";
import { MemBlobs } from "../otel/_memstore.ts";
import { BUG_PATCH } from "./_fixtures.ts";

let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-wf-case-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("case truth", () => {
  it("reads named verifier tests with their state before the run", async () => {
    const c = await parseCase(
      `[truth]\nkind = "verifier"\n[[truth.tests]]\nid = "orders"\ncommand = "true"\nbefore = "pass"\n[[truth.tests]]\ncommand = "false"\nbefore = "fail"\n`,
      "/x/fix.toml",
      "fix",
      new MemBlobs(),
    );
    assert.deepEqual(c.truth, { kind: "verifier", tests: [{ id: "orders", command: "true", before: "pass" }, { id: "test-2", command: "false", before: "fail" }] });
  });

  it("rejects verifier cases with both forms, repeated ids or a bad before", async () => {
    const blobs = new MemBlobs();
    await assert.rejects(parseCase(`[truth]\nkind = "verifier"\ncommand = "x"\n[[truth.tests]]\ncommand = "y"\n`, "/x/a.toml", "w", blobs), /a\.toml: use truth\.command or \[\[truth\.tests\]\], not both/);
    await assert.rejects(parseCase(`[truth]\nkind = "verifier"\n[[truth.tests]]\nid = "t"\ncommand = "y"\n[[truth.tests]]\nid = "t"\ncommand = "z"\n`, "/x/b.toml", "w", blobs), /test id "t" is used twice/);
    await assert.rejects(parseCase(`[truth]\nkind = "verifier"\n[[truth.tests]]\ncommand = "y"\nbefore = "maybe"\n`, "/x/c.toml", "w", blobs), /before must be "pass" or "fail"/);
    await assert.rejects(parseCase(`[truth]\nkind = "verifier"\n[[truth.tests]]\nid = "t"\n`, "/x/d.toml", "w", blobs), /test 1 needs a command/);
  });

  it("reads judge cases: a rubric is required, the judge defaults to anthropic", async () => {
    const blobs = new MemBlobs();
    await assert.rejects(parseCase(`[truth]\nkind = "judge"\n`, "/x/j.toml", "w", blobs), /j\.toml: truth\.rubric is required for kind = "judge"/);
    const a = await parseCase(`[truth]\nkind = "judge"\nrubric = "Covers the three sources."\n`, "/x/j.toml", "w", blobs);
    assert.deepEqual(a.truth, { kind: "judge", rubric: "Covers the three sources.", judge: "anthropic" });
    const b = await parseCase(`[truth]\nkind = "judge"\nrubric = "r"\n[truth.judge]\nprovider = "mock"\nmockAnswer = "no"\n`, "/x/j.toml", "w", blobs);
    assert.deepEqual(parseJudgeRef((b.truth as { judge: string }).judge), { provider: "mock", mockAnswer: "no" });
  });

  it("resolves [start] against the case file and refuses a truth file inside the workflow's tree", async () => {
    const dir = join(root, "evals", "wf", "cases");
    mkdirSync(join(dir, "..", "hidden"), { recursive: true });
    mkdirSync(join(root, "tree", "secret"), { recursive: true });
    const bugs = JSON.stringify({ bugs: [{ id: "h1", file: "src/a.ts", lines: [1, 1], category: "logic", severity: "P1" }] });
    writeFileSync(join(dir, "..", "hidden", "s.json"), bugs);
    writeFileSync(join(root, "tree", "secret", "s.json"), bugs);
    const ok = await parseCase(`[start]\nrepoRoot = "../../../tree"\nsnapshot = "../../../tree"\n[truth]\nfile = "../hidden/s.json"\n`, join(dir, "ok.toml"), "wf", new MemBlobs());
    assert.equal(ok.start!.repoRoot, join(root, "tree"));
    assert.equal(ok.start!.snapshot, join(root, "tree"));
    await assert.rejects(
      parseCase(`[start]\nrepoRoot = "../../../tree"\n[truth]\nfile = "../../../tree/secret/s.json"\n`, join(dir, "leak.toml"), "wf", new MemBlobs()),
      /leak\.toml: truth\.file .* is inside the workflow's tree .*; keep it outside/,
    );
    // A sibling directory whose name starts with the tree's is not inside it.
    mkdirSync(join(root, "tree-other"), { recursive: true });
    writeFileSync(join(root, "tree-other", "s.json"), bugs);
    await parseCase(`[start]\nrepoRoot = "../../../tree"\n[truth]\nfile = "../../../tree-other/s.json"\n`, join(dir, "near.toml"), "wf", new MemBlobs());
  });
});

describe("scoreWorkflowCase", () => {
  const kase = (truth: WorkflowCase["truth"]): WorkflowCase => ({ id: "c1", workflow: "fix", split: "dev", args: { issue: 7 }, truth });

  it("scores verifier tests as a pass rate and counts tests that passed before and fail now as regressions", async () => {
    const r = await scoreWorkflowCase(
      null,
      kase({
        kind: "verifier",
        tests: [
          { id: "fixed", command: "true", before: "fail" },
          { id: "broke", command: "exit 3", before: "pass" },
          { id: "still", command: "true", before: "pass" },
          { id: "runid", command: 'test "$CODING_SH_WORKFLOW_RUN_ID" = wfr_1' },
        ],
      }),
      { cwd: root, runId: "wfr_1" },
    );
    assert.equal(r.kind, "verifier");
    assert.equal(r.score, 0.75);
    assert.deepEqual(r.verifier!.regressions, ["broke"]);
    assert.deepEqual(r.verifier!.tests!.map((t) => [t.id, t.passed, t.exitCode, t.regression]), [
      ["fixed", true, 0, false],
      ["broke", false, 3, true],
      ["still", true, 0, false],
      ["runid", true, 0, false],
    ]);
    const one = await scoreWorkflowCase(null, kase({ kind: "verifier", command: "exit 1" }), { cwd: root });
    assert.deepEqual([one.score, one.verifier!.exitCode, one.verifier!.total], [0, 1, 1]);
  });

  it("grades judge cases and flags a judge with no stored calibration", async () => {
    const r = await scoreWorkflowCase({ summary: "…" }, kase({ kind: "judge", rubric: "Names the root cause.", judge: "mock" }), { cwd: root });
    assert.equal(r.score, 1);
    assert.equal(r.judge!.pass, true);
    assert.equal(r.judge!.uncalibrated, true);
    assert.equal(r.judge!.calibration.state, "uncalibrated");
    assert.match(r.judge!.judgeVersion, /^workflow-fix@/);
    const no = await scoreWorkflowCase({}, kase({ kind: "judge", rubric: "r", judge: "mock" }), { cwd: root, provider: mockProvider({ answer: "no" }) });
    assert.deepEqual([no.score, no.judge!.pass], [0, false]);
  });

  it("reads the judge's calibration from the stored judge version", async () => {
    const seen: string[] = [];
    const getJudge = async (id: string): Promise<JudgeVersion | undefined> => {
      seen.push(id);
      return { id, calibration: { state: "calibrated", kappa: 0.82, n: 60 } } as JudgeVersion;
    };
    const r = await scoreWorkflowCase({}, kase({ kind: "judge", rubric: "r", judge: "mock" }), { cwd: root, getJudge });
    assert.deepEqual(seen, [r.judge!.judgeVersion]);
    assert.equal(r.judge!.uncalibrated, false);
    assert.equal(r.judge!.calibration.kappa, 0.82);
  });

  it("parses judge specs", () => {
    assert.deepEqual(parseJudgeRef(""), { provider: "anthropic" });
    assert.deepEqual(parseJudgeRef("openai"), { provider: "openai" });
    assert.deepEqual(parseJudgeRef("anthropic:claude-opus-5-5"), { provider: "anthropic", model: "claude-opus-5-5" });
    assert.deepEqual(parseJudgeRef("gateway:openai/gpt-6:latest"), { provider: "gateway", model: "openai/gpt-6:latest" });
    assert.deepEqual(parseJudgeRef('{"provider":"mock"}'), { provider: "mock" });
    assert.throws(() => parseJudgeRef("{nope"), /not valid JSON/);
  });
});

describe("seeded-bug validation on a case's snapshot", () => {
  it("checks each bug's test fails seeded and passes reverted, and reports bugs it can't check", async () => {
    const snap = join(root, "snap");
    mkdirSync(join(snap, "src"), { recursive: true });
    // The seeded tree: BUG_PATCH applied.
    writeFileSync(join(snap, "src", "a.ts"), "export function last(xs: number[]) {\n  return xs[xs.length];\n}\n");
    const blobs = new MemBlobs();
    const ref = await blobs.put(new TextEncoder().encode(BUG_PATCH));
    const good = { id: "b1", file: "src/a.ts", lines: [2, 2] as [number, number], category: "logic", severity: "P0" as const, patch: ref, test: "grep -q 'xs.length - 1' src/a.ts" };
    const kase: WorkflowCase = {
      id: "s1",
      workflow: "review",
      split: "dev",
      args: {},
      start: { repoRoot: snap, snapshot: snap, head: "" },
      truth: { kind: "seeded-bugs", bugs: [good, { ...good, id: "b2", test: "true" }, { ...good, id: "b3", patch: "" }, { ...good, id: "b4", test: undefined }] },
    };
    const getText = (r: string) => blobs.getText(r);
    const v = await validateCase(kase, getText);
    assert.deepEqual(v!.map((x) => [x.id, x.ok]), [
      ["b1", true],
      ["b2", false],
      ["b3", false],
    ]);
    assert.equal(v![2]!.error, "no patch to revert");
    // The snapshot is left seeded.
    assert.match(readFileSync(join(snap, "src", "a.ts"), "utf8"), /xs\[xs\.length\];/);
    // Nothing to check: no snapshot, no tests, or another truth kind.
    assert.equal(await validateCase({ ...kase, start: undefined }, getText), undefined);
    assert.equal(await validateCase({ ...kase, truth: { kind: "seeded-bugs", bugs: [{ ...good, test: undefined }] } }, getText), undefined);
    assert.equal(await validateCase({ ...kase, truth: { kind: "verifier", command: "true" } }, getText), undefined);
  });
});

describe("command driver: control forks", () => {
  const kase: WorkflowCase = { id: "c1", workflow: "graph", split: "dev", args: { q: 1 }, truth: { kind: "verifier", command: "true" } };

  it("passes --from-checkpoint and --replay-from after --args when the variant sets them", async () => {
    assert.deepEqual(commandArgs({ name: "a" }, kase), ["--args", '{"q":1}']);
    assert.deepEqual(commandArgs({ name: "b", args: { q: 2 }, fromCheckpoint: "ckpt-9", replayFrom: "plan" }, kase), ["--args", '{"q":2}', "--from-checkpoint", "ckpt-9", "--replay-from", "plan"]);
    const script = join(root, "echo-argv.mjs");
    writeFileSync(script, "console.log(JSON.stringify({ argv: process.argv.slice(2), run: process.env.CODING_SH_WORKFLOW_RUN_ID }));\n");
    chmodSync(script, 0o755);
    const r = await commandDriver({ cwd: root }).run({ name: "fork", command: [process.execPath, script], fromCheckpoint: "ckpt-9", replayFrom: "plan" }, kase, { CODING_SH_WORKFLOW_RUN_ID: "wfr_x" });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.output, { argv: ["--args", '{"q":1}', "--from-checkpoint", "ckpt-9", "--replay-from", "plan"], run: "wfr_x" });
  });
});
