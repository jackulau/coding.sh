// Case truth beyond seeded bugs (docs/design/workflows.md §5, §7): verifier tests with
// regressions, judge cases with their calibration, the hidden-truth rule for [start], seeded-bug
// validation on a case's snapshot, and the command driver's checkpoint and replay flags.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
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
      /leak\.toml: truth\.file .* is inside the workflow's tree .*, where its agents could read it; move it/,
    );
    // A sibling directory whose name starts with the tree's is not inside it.
    mkdirSync(join(root, "tree-other"), { recursive: true });
    writeFileSync(join(root, "tree-other", "s.json"), bugs);
    await parseCase(`[start]\nrepoRoot = "../../../tree"\n[truth]\nfile = "../../../tree-other/s.json"\n`, join(dir, "near.toml"), "wf", new MemBlobs());
  });

  it("names a folder outside the workflow's trees for a truth file inside them, and the case loads from there", async () => {
    const slash = (p: string) => p.replaceAll("\\", "/");
    const load = (text: string, file: string) => parseCase(text, file, "wf", new MemBlobs()).then(() => "loaded", (e: Error) => e.message);
    const folder = (message: string) => /, to a folder outside repoRoot and snapshot, such as (.+), then set truth\.file to its new path$/.exec(message)?.[1];
    const bugs = JSON.stringify({ bugs: [{ id: "h1", file: "src/a.ts", lines: [1, 1], patch: "h1.patch" }] });
    const writeTruth = (d: string) => {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "s.json"), bugs);
      writeFileSync(join(d, "h1.patch"), BUG_PATCH);
    };
    // The guide's layout: cases in the repo, repoRoot the repo root, and the truth in hidden/ next to cases/.
    const repo = join(root, "repo");
    const dir = join(repo, "evals", "wf", "cases");
    writeTruth(join(repo, "evals", "wf", "hidden"));
    const kase = (truth: string) => `[start]\nrepoRoot = "../../.."\nsnapshot = "${slash(join(root, "snap"))}"\n[truth]\nfile = "${slash(truth)}"\n`;
    const leak = await load(kase("../hidden/s.json"), join(dir, "s.toml"));
    assert.equal(folder(leak), join(root, "repo-truth"), leak);
    writeTruth(join(root, "repo-truth"));
    assert.equal(await load(kase(join(root, "repo-truth", "s.json")), join(dir, "s.toml")), "loaded");
    // Beside the tree that holds the truth is inside the other tree here, so the folder goes beside that one.
    const outer = join(root, "outer");
    writeTruth(join(outer, "repo"));
    const nested = `[start]\nrepoRoot = "${slash(join(outer, "repo"))}"\nsnapshot = "${slash(outer)}"\n[truth]\nfile = "${slash(join(outer, "repo", "s.json"))}"\n`;
    assert.equal(folder(await load(nested, join(root, "nested.toml"))), join(root, "outer-truth"));
    // Nothing sits beside a filesystem root, so the hint names no folder.
    const top = await load(`[start]\nrepoRoot = "${slash(parse(root).root)}"\n[truth]\nfile = "${slash(join(outer, "repo", "s.json"))}"\n`, join(root, "top.toml"));
    assert.match(top, /, to a folder outside repoRoot and snapshot, then set truth\.file to its new path$/);
  });

  it("refuses a case file inside the workflow's tree that lists [[truth.bugs]], as it refuses a truth file there", async () => {
    const slash = (p: string) => p.replaceAll("\\", "/");
    const load = (text: string, file: string) => parseCase(text, file, "wf", new MemBlobs()).then(() => "loaded", (e: Error) => e.message);
    const bug = `[[truth.bugs]]\nid = "b1"\nfile = "src/a.ts"\nlines = [2, 2]\n`;
    // The guide's layout with the bugs in the case file: repoRoot, the repo root, holds the case file.
    const repo = join(root, "inline-repo");
    const dir = join(repo, "evals", "wf", "cases");
    mkdirSync(dir, { recursive: true });
    const snap = slash(join(root, "inline-snap"));
    const inRepo = await load(`[start]\nrepoRoot = "../../.."\nsnapshot = "${snap}"\n${bug}`, join(dir, "s.toml"));
    const hint = /s\.toml: this case file lists \[\[truth\.bugs\]\] and is inside the workflow's tree .*, where its agents could read them; move them, with the patches they name, to a truth file in a folder outside repoRoot and snapshot, such as (.+), then set truth\.file to its path$/;
    assert.equal(hint.exec(inRepo)?.[1], join(root, "inline-repo-truth"), inRepo);
    // snapshot is checked too.
    assert.match(await load(`[start]\nrepoRoot = "${snap}"\nsnapshot = "../../.."\n${bug}`, join(dir, "s.toml")), /this case file lists \[\[truth\.bugs\]\] and is inside the workflow's tree/);
    // Bugs left in the case file beside truth.file are not used, but its agents could still read them.
    const truth = join(root, "inline-repo-truth");
    mkdirSync(truth, { recursive: true });
    writeFileSync(join(truth, "s.json"), JSON.stringify({ bugs: [{ id: "b1", file: "src/a.ts", lines: [2, 2] }] }));
    const both = `[start]\nrepoRoot = "../../.."\nsnapshot = "${snap}"\n[truth]\nfile = "${slash(join(truth, "s.json"))}"\n${bug}`;
    assert.match(await load(both, join(dir, "s.toml")), /s\.toml: this case file lists \[\[truth\.bugs\]\] and is inside the workflow's tree .*; truth\.file is set, so they are not used: delete them$/);
    // Outside both trees, or with no [start] to name them, the same bugs load.
    mkdirSync(join(root, "inline-cases"), { recursive: true });
    assert.equal(await load(`[start]\nrepoRoot = "${slash(repo)}"\nsnapshot = "${snap}"\n${bug}`, join(root, "inline-cases", "s.toml")), "loaded");
    assert.equal(await load(bug, join(dir, "s.toml")), "loaded");
  });

  it("refuses a bug's patch inside the workflow's tree, with the folder to move it to; one outside, or already stored, loads", async () => {
    const slash = (p: string) => p.replaceAll("\\", "/");
    const load = (text: string, file: string) => parseCase(text, file, "wf", new MemBlobs()).then(() => "loaded", (e: Error) => e.message);
    // The truth file sits outside both trees, but its patch points into the snapshot.
    const truth = join(root, "patch-truth");
    const snap = join(root, "patch-snap");
    const repo = join(root, "patch-repo");
    for (const d of [truth, snap, repo]) mkdirSync(d, { recursive: true });
    writeFileSync(join(snap, "b1.patch"), BUG_PATCH);
    writeFileSync(join(truth, "b1.patch"), BUG_PATCH);
    const withPatch = (patch: string) => {
      writeFileSync(join(truth, "s.json"), JSON.stringify({ bugs: [{ id: "b1", file: "src/a.ts", lines: [2, 2], patch }] }));
      return `[start]\nrepoRoot = "${slash(repo)}"\nsnapshot = "${slash(snap)}"\n[truth]\nfile = "${slash(join(truth, "s.json"))}"\n`;
    };
    const leak = await load(withPatch(slash(join(snap, "b1.patch"))), join(root, "patch.toml"));
    assert.match(leak, /patch\.toml: the patch ".*b1\.patch" of bug b1 is inside the workflow's tree .*, where its agents could read it; move it to a folder outside repoRoot and snapshot, such as (.+), then set its patch to the new path$/);
    assert.equal(/such as (.+), then/.exec(leak)?.[1], join(root, "patch-snap-truth"));
    // A relative patch resolves against the truth file, and one there loads.
    assert.equal(await load(withPatch("b1.patch"), join(root, "patch.toml")), "loaded");
    // A patch already stored as a blob ref names no file, so it stays valid.
    assert.equal(await load(withPatch("a".repeat(64)), join(root, "patch.toml")), "loaded");
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
