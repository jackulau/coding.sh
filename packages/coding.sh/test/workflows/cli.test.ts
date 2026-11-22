// `coding.sh workflows` through the command module's run(), with a fake
// Output and a temp HOME / CODING_SH_HOME / CLAUDE_CONFIG_DIR.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { FlagValue } from "../../src/cli/args.ts";
import { confirmAboveUsd, parseVariant, renderTree, run, verifyEntries } from "../../src/cli/commands/workflows.ts";
import { Output } from "../../src/cli/output.ts";
import { WORKFLOWS_COMMAND } from "../../src/workflows/cli-spec.ts";
import type { WorkflowNode } from "../../src/workflows/types.ts";
import { nodeBin } from "../_bin.ts";
import { BUG_PATCH, RESUMED, RUN, RUN_OUTPUT, SCRIPT, SID, writeClaudeWorkflowFixture, writeReviewCases } from "./_fixtures.ts";

let root = "";
let env: NodeJS.ProcessEnv = {};
let casesDir = "";
let resumedDir = "";

before(() => {
  root = mkdtempSync(join(tmpdir(), "csh-wf-cli-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  env = { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(root, "claude"), PATH: process.env.PATH, CI: "1" };
  resumedDir = writeClaudeWorkflowFixture(join(root, "claude", "projects")).resumed;
  casesDir = join(root, "repo", "evals", "workflows", "review", "cases");
  writeReviewCases(casesDir);
  writeFileSync(
    join(root, "fake-wf.mjs"),
    `const good = process.argv[2] === "good";
console.log(JSON.stringify({ findings: good ? [{ file: "src/a.ts", line: 11, summary: "x" }, { file: "src/b.ts", line: 40, summary: "y" }] : [] }));
`,
  );
});
after(() => rmSync(root, { recursive: true, force: true }));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(action: string, positionals: string[], flags: Record<string, FlagValue> = {}, o: { json?: boolean; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const e = { ...env, ...o.env };
  const out = new Output({ json: o.json ?? false, env: e, stdout: { write: (s: string) => (stdout += s), isTTY: false }, stderr: { write: (s: string) => (stderr += s), isTTY: false }, stdin: { isTTY: false } });
  const code = await run({ action, flags, positionals, rest: [], out, env: e, cwd: join(root, "repo"), debug: false, signal: o.signal ?? new AbortController().signal });
  return { code, stdout, stderr };
}

const json = async (action: string, positionals: string[], flags: Record<string, FlagValue> = {}, e?: NodeJS.ProcessEnv) => {
  const r = await cli(action, positionals, flags, { json: true, ...(e ? { env: e } : {}) });
  assert.equal(r.code, 0);
  return JSON.parse(r.stdout) as Record<string, any>;
};

describe("workflows command spec", () => {
  it("declares every documented action and loads this module", async () => {
    assert.equal(WORKFLOWS_COMMAND.name, "workflows");
    assert.deepEqual(WORKFLOWS_COMMAND.actions!.map((a) => a.name), ["list", "import", "show", "stats", "score", "run", "compare", "replay"]);
    const mod = await WORKFLOWS_COMMAND.load();
    assert.equal(mod.run, run);
  });
});

describe("coding.sh workflows", () => {
  it("list imports Claude Code workflow runs first, then lists them newest first", async () => {
    const doc = await json("list", []);
    assert.deepEqual(doc.runs.map((r: { id: string }) => r.id), [RESUMED, RUN]);
    const base = doc.runs[1];
    assert.equal(base.name, "review");
    assert.equal(base.framework, "claude-code-workflow");
    assert.equal(base.agents, 9);
    assert.equal(base.wallMs, 57_000);
    assert.equal(base.hostSessionId, SID);
    const human = await cli("list", [], { import: false });
    const lines = human.stdout.trim().split("\n");
    assert.equal(lines[0], "ID\tNAME\tFRAMEWORK\tSTATUS\tSTARTED\tWALL\tAGENTS\tCOST");
    assert.match(lines[2]!, new RegExp(`^${RUN}\\treview\\tclaude-code-workflow\\tok\\t.*\\t57s\\t9 \\(0 failed, 1 null\\)\\t\\$1\\.00$`));
    assert.equal((await json("list", [], { framework: "langgraph", import: false })).runs.length, 0);
    await assert.rejects(cli("list", [], { framework: "nope" }), /--framework must be one of/);
  });

  it("list on an empty home says so", async () => {
    const r = await cli("list", [], { import: false }, { env: { CODING_SH_HOME: join(root, "empty") } });
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /No workflow runs/);
  });

  it("list with nothing in the --since window says so, when the newest run started, and how to list older runs", async () => {
    // A store of its own, holding only the two imported runs: both started on 2026-11-01, before the last 7 days.
    const e = { CODING_SH_HOME: join(root, "since-home") };
    const r = await cli("list", [], { since: "7d" }, { env: e });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /No workflow runs since \w{3} \d+/);
    assert.match(r.stderr, /2 older runs; the newest started \w{3} \d+/);
    assert.match(r.stderr, /See older runs:\n {4}(?:coding\.sh|codingsh) workflows list\n/);
    assert.doesNotMatch(r.stderr, /workflows import/);
    // The other filters stay in the command.
    const named = await cli("list", [], { since: "7d", name: "review", framework: "claude-code-workflow", import: false }, { env: e });
    assert.match(named.stderr, /No workflow runs named "review" from claude-code-workflow since \w{3} \d+/);
    assert.match(named.stderr, /(?:coding\.sh|codingsh) workflows list --name review --framework claude-code-workflow\n/);
    // A filter that matches no run at all points at every run, not at an import.
    const none = await cli("list", [], { name: "nope", import: false }, { env: e });
    assert.match(none.stderr, /No workflow runs named "nope"\n/);
    assert.match(none.stderr, /List every workflow run:\n {4}(?:coding\.sh|codingsh) workflows list\n/);
    assert.doesNotMatch(none.stderr, /workflows import/);
    // JSON stays an empty list.
    assert.deepEqual((await json("list", [], { since: "7d", import: false }, e)).runs, []);
  });

  it("import reports skipped and forced re-imports", async () => {
    const again = await json("import", [join(root, "claude", "projects")]);
    assert.equal(again.found, 2);
    assert.equal(again.skipped, 2);
    const forced = await json("import", [join(root, "claude", "projects")], { force: true });
    assert.equal(forced.imported.length, 2);
    await assert.rejects(cli("import", [join(root, "missing")]), /Can't find/);
  });

  it("import stopped by Ctrl-C says it stopped, prints no success line and exits 130", async () => {
    const projects = join(root, "stop", "projects");
    writeClaudeWorkflowFixture(projects);
    const e = { CODING_SH_HOME: join(root, "stop", "home") };
    const r = await cli("import", [projects], {}, { env: e, signal: AbortSignal.abort() });
    assert.equal(r.code, 130);
    assert.doesNotMatch(r.stderr + r.stdout, /Imported/);
    assert.match(r.stderr, /Stopped: 0 workflow runs imported/);
    assert.match(r.stderr, /coding\.sh workflows import/);
    const j = await cli("import", [projects], {}, { json: true, env: e, signal: AbortSignal.abort() });
    assert.equal(j.code, 130);
    assert.equal(JSON.parse(j.stdout).outcome, "interrupted");
    // Nothing was stored, so the next import reads both runs.
    assert.equal((await json("import", [projects], {}, e)).imported.length, 2);
  });

  it("show prints the run tree, the gantt TSV, or the JSON document", async () => {
    const r = await cli("show", [RUN]);
    const lines = r.stdout.trim().split("\n");
    assert.match(lines[0]!, /^workflow review {2}ok {2}57s/);
    assert.ok(lines.some((l) => /^ {2}phase Find {2}ok/.test(l)));
    assert.ok(lines.some((l) => /^ {6}agent find-a {2}ok {2}10s {2}\$0\.1000/.test(l)));
    assert.ok(!lines.some((l) => /StructuredOutput/.test(l)));
    assert.match(r.stderr, /Wall\s+57s, critical path 55s \(approx\)/);
    const full = await cli("show", [RUN], { tree: true });
    assert.ok(full.stdout.split("\n").some((l) => /^ {6}tool StructuredOutput {2}failed/.test(l)));
    const g = await cli("show", [RUN], { gantt: true });
    const rows = g.stdout.trim().split("\n");
    assert.equal(rows[0], "phase\tlabel\tstatus\tstart_ms\tend_ms\tduration_ms\tcritical\tidle_after_ms\tcost_usd\tsession");
    assert.equal(rows.length, 10);
    assert.match(rows[1]!, /^Find\tfind-a\tok\t1000\t11000\t10000\t\t20000\t0\.1000\t/);
    const doc = await json("show", [RUN], { gantt: true });
    assert.equal(doc.run.id, RUN);
    assert.ok(doc.nodes.every((n: WorkflowNode) => n.kind !== "llm" && n.kind !== "tool"));
    assert.equal(doc.gantt.phases.length, 3);
    await assert.rejects(cli("show", ["nope"]), (e: Error & { reason?: string }) => e.reason === "not_found");
    await assert.rejects(cli("show", []), /Missing <run>/);
  });

  it("show, stats, score and replay take a unique prefix of a run id, and a prefix several runs share lists them", async () => {
    // The two imported runs share only "wf_".
    assert.equal((await json("show", ["wf_b"])).run.id, RUN);
    assert.equal((await json("show", ["wf_res"])).run.id, RESUMED);
    assert.match((await cli("show", ["wf_base"])).stderr, new RegExp(`Run +${RUN} \\(claude-code-workflow\\)`));
    assert.equal((await json("stats", ["wf_base"])).runId, RUN);
    assert.equal((await json("score", ["wf_base"], { case: "verify-1" })).runId, RUN);
    // replay finds the run before it reads the script.
    await assert.rejects(cli("replay", ["wf_base"], { script: join(root, "missing.js") }), /Can't read --script/);
    const short = (e: Error & { reason?: string }) => e.reason === "not_found" && e.message === `Can't find workflow run "wf_" (an id prefix needs at least 4 characters)`;
    await assert.rejects(cli("show", ["wf_"]), short);
    await assert.rejects(cli("show", ["wf_nope"]), (e: Error) => e.message === `Can't find workflow run "wf_nope"`);
    // Command-driver runs share "wfr_": two of them, newest first.
    const e = { CODING_SH_HOME: join(root, "prefix-home") };
    const ran = await json("run", ["review"], { driver: "command", variant: [JSON.stringify({ name: "solo", command: [process.execPath, join(root, "fake-wf.mjs"), "good"] })], split: "dev", k: 1, yes: true }, e);
    const ids = (await json("list", [], { import: false }, e)).runs.map((r: { id: string }) => r.id);
    assert.equal(ids.length, 2);
    assert.deepEqual([...ids].sort(), ran.runs.map((r: { id: string }) => r.id).sort());
    const ambiguous = await cli("show", ["wfr_"], {}, { env: e }).then(
      () => assert.fail("a shared prefix opened a run"),
      (x: Error & { reason?: string; next?: string[]; data?: { candidates: { id: string; name: string; status: string }[]; more: boolean } }) => x,
    );
    assert.equal(ambiguous.reason, "ambiguous");
    assert.equal(ambiguous.message.split("\n")[0], `Workflow run id prefix "wfr_" is ambiguous. It matches:`);
    assert.deepEqual(ambiguous.message.split("\n").slice(1).map((l) => l.split("  ")[1]), ids);
    assert.match(ambiguous.message, /\n {2}wfr_\w+ {2}review {2}ok {2}\S/);
    assert.deepEqual(ambiguous.next, ["Pass one of these ids, more of the id, or list workflow runs:", "coding.sh workflows list"]);
    assert.deepEqual(ambiguous.data?.candidates.map((x) => [x.id, x.name, x.status]), ids.map((id: string) => [id, "review", "ok"]));
    assert.equal(ambiguous.data?.more, false);
    // One more character than they share names one of them.
    let common = 0;
    while (ids[0][common] === ids[1][common]) common++;
    assert.equal((await json("show", [ids[1].slice(0, common + 1)], {}, e)).run.id, ids[1]);
  });

  it("stats prints the metrics", async () => {
    const doc = await json("stats", [RUN]);
    assert.equal(doc.stats.barrierIdleMs, 30_000);
    assert.equal(doc.stats.cacheHits, 0);
    const r = await cli("stats", [RUN]);
    assert.match(r.stdout, /barrier idle\t30s/);
    assert.match(r.stdout, /schema failures\t1 \(0 still invalid\)/);
    assert.match(r.stdout, /PHASE\tWALL/);
    assert.match(r.stdout, /verify-schema\tVerify\tok/);
    const resumed = await json("stats", [RESUMED]);
    assert.equal(resumed.stats.cacheHits, 7);
    assert.ok(Math.abs(resumed.stats.resumeSavedUsd - 0.8) < 1e-9);
    // 1 of the 2 agents that ran returned null; the 7 cached agents are on the cache hits row, not in the shares.
    const rows = (await cli("stats", [RESUMED])).stdout;
    assert.match(rows, /\nagents\t2 \(0 failed 0%, 1 null 50%\)\n/);
    assert.match(rows, /\ncache hits\t7 \(78%\)\n/);
  });

  it("score grades the run output against a seeded-bugs case, with the verify confusion", async () => {
    const doc = await json("score", [RUN], { case: "seeded-1" });
    assert.equal(doc.kind, "seeded-bugs");
    assert.ok(Math.abs(doc.score - 2 / 3) < 1e-9);
    assert.deepEqual(doc.findings.matches, [
      [0, "b1"],
      [1, "b2"],
    ]);
    assert.equal(doc.findings.count, RUN_OUTPUT.findings.length);
    assert.equal(doc.verify.n, 4);
    assert.equal(doc.verify.refuteAccuracy, 0.5);
    const human = await cli("score", [RUN], { case: "seeded-1", cases: casesDir });
    assert.match(human.stdout, /precision\t0\.667/);
    assert.match(human.stdout, /missed bugs\tb3/);
    assert.match(human.stdout, /false kill rate\t50%/);
    const v = await json("score", [RUN], { case: "verify-1" });
    assert.deepEqual([v.kind, v.score, v.verifier.exitCode], ["verifier", 1, 0]);
    await assert.rejects(cli("score", [RUN], { case: "nope" }), /Can't find case "nope"/);
    await assert.rejects(cli("score", [RUN]), /Pass --case/);
    await assert.rejects(cli("score", [RUN], { case: "x", cases: join(root, "none") }), /Can't read cases/);
  });

  it("score runs named verifier tests and grades judge cases, flagging an uncalibrated judge", async () => {
    const dir = join(root, "cases-more");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fix-1.toml"), `[truth]\nkind = "verifier"\n[[truth.tests]]\nid = "ok"\ncommand = "true"\nbefore = "fail"\n[[truth.tests]]\nid = "broke"\ncommand = "exit 2"\nbefore = "pass"\n`);
    writeFileSync(join(dir, "synth-1.toml"), `[truth]\nkind = "judge"\nrubric = "Names every seeded bug."\njudge = "mock"\n`);
    const v = await json("score", [RUN], { case: "fix-1", cases: dir });
    assert.deepEqual([v.kind, v.score, v.verifier.regressions], ["verifier", 0.5, ["broke"]]);
    const human = await cli("score", [RUN], { case: "fix-1", cases: dir });
    assert.match(human.stdout, /TEST\tRESULT\tBEFORE\tEXIT\nok\tpass\tfail\t0\nbroke\tregression\tpass\t2/);
    assert.match(human.stderr, /✗ Pass rate +1 of 2 \(50%\), 1 regression: broke/);
    const j = await json("score", [RUN], { case: "synth-1", cases: dir });
    assert.deepEqual([j.kind, j.score, j.judge.pass, j.judge.uncalibrated], ["judge", 1, true, true]);
    const jh = await cli("score", [RUN], { case: "synth-1", cases: dir });
    assert.match(jh.stderr, /Judge +workflow-review@\S+: pass/);
    assert.match(jh.stderr, /Uncalibrated judge \(uncalibrated: never calibrated[^)]*\); calibrate it with coding\.sh judge calibrate/);
  });

  it("run checks seeded bugs on each case's snapshot first, unless --no-validate", async () => {
    const dir = join(root, "cases-seeded");
    const snap = join(root, "snapshot");
    mkdirSync(join(dir, "bugs"), { recursive: true });
    mkdirSync(join(snap, "src"), { recursive: true });
    writeFileSync(join(snap, "src", "a.ts"), "export function last(xs: number[]) {\n  return xs[xs.length];\n}\n");
    writeFileSync(join(dir, "bugs", "b1.patch"), BUG_PATCH);
    const kase = (test: string) => `[start]\nrepoRoot = "${snap.replaceAll("\\", "/")}"\nsnapshot = "${snap.replaceAll("\\", "/")}"\n[[truth.bugs]]\nid = "b1"\nfile = "src/a.ts"\nlines = [2, 2]\ncategory = "logic"\nseverity = "P0"\npatch = "bugs/b1.patch"\ntest = "${test}"\n`;
    writeFileSync(join(dir, "s1.toml"), kase("true"));
    const flags = { driver: "command", variant: [`good=node ${join(root, "fake-wf.mjs")} good`], cases: dir, yes: true };
    await assert.rejects(cli("run", ["review"], flags), (e: Error & { reason?: string }) => e.reason === "invalid_cases" && /1 seeded bug failed validation/.test(e.message));
    assert.equal((await cli("run", ["review"], { ...flags, validate: false })).code, 0);
    writeFileSync(join(dir, "s1.toml"), kase("grep -q 'xs.length - 1' src/a.ts"));
    const ok = await cli("run", ["review"], flags);
    assert.equal(ok.code, 0);
    assert.match(ok.stderr, /Validated 1 seeded bug/);
  });

  let experimentId = "";

  it("run asks before spending above the threshold, then runs the experiment", async () => {
    const flags = {
      driver: "command",
      variant: [JSON.stringify({ name: "bad", command: [process.execPath, join(root, "fake-wf.mjs"), "bad"] }), `good=node ${join(root, "fake-wf.mjs")} good`],
      split: "dev",
      k: 1,
    };
    // Past runs of "review" cost a median $0.60; 2 dev cases × 2 variants ≈ $2.40 > $1.
    await assert.rejects(cli("run", ["review"], flags), (e: Error & { reason?: string }) => e.reason === "confirmation_required");
    const doc = await json("run", ["review"], { ...flags, yes: true });
    experimentId = doc.experimentId;
    assert.match(experimentId, /^wfx_/);
    assert.equal(doc.runs.length, 4);
    const goodSeeded = doc.runs.find((r: { variant: string; caseId: string }) => r.variant === "good" && r.caseId === "seeded-1");
    assert.ok(Math.abs(goodSeeded.score - 0.8) < 1e-9);
    // Verifier cases are scored during the run too, as `workflows score` grades them.
    assert.equal(doc.runs.find((r: { caseId: string }) => r.caseId === "verify-1").score, 1);
    // Under the threshold no confirmation is needed.
    const cheap = await cli("run", ["review"], flags, { env: { CODING_SH_CONFIRM_ABOVE_USD: "100" } });
    assert.equal(cheap.code, 0);
    assert.match(cheap.stdout, /^wfx_/);
    assert.match(cheap.stderr, /Estimated cost \$2\.40/);
    await assert.rejects(cli("run", ["review"], { driver: "command" }), /at least one --variant/);
    await assert.rejects(cli("run", ["review"], { ...flags, variant: ["a=x", "a=y"] }), /used twice/);
    await assert.rejects(cli("run", ["review"], { ...flags, cases: join(root, "repo") }), /No cases/);
  });

  it("compare reports the paired comparison", async () => {
    const doc = await json("compare", [experimentId], { baseline: "bad", candidate: "good" });
    assert.equal(doc.experimentId, experimentId);
    assert.equal(doc.pairedCases, 2);
    assert.ok(Math.abs(doc.quality.candidate - 0.9) < 1e-9);
    const human = await cli("compare", [experimentId], { baseline: "bad", candidate: "good" });
    assert.match(human.stdout.split("\n")[0]!, /^(inconclusive|no significant difference|candidate)/);
    assert.match(human.stdout, /METRIC\tBAD\tGOOD\tDIFF \[CI\]\tPAIRS/);
    assert.match(human.stdout, /quality\t0\.500\t0\.900/);
    await assert.rejects(cli("compare", [experimentId], { baseline: "bad", candidate: "zzz" }), /no variant "zzz"/);
    await assert.rejects(cli("compare", ["wfx_none"], { baseline: "a", candidate: "b" }), /Can't find workflow experiment/);
    await assert.rejects(cli("compare", [experimentId], {}), /--baseline/);
  });

  it("compare places variants on the front with P(front) and picks one to deploy with --select", async () => {
    const flags = { baseline: "bad", candidate: "good", seed: 1 };
    const doc = await json("compare", [experimentId], { ...flags, select: "pareto" });
    const good = doc.pareto.find((p: { variant: string }) => p.variant === "good");
    // good scores 0.8 and 1 against bad's 0 and 1: no draw puts bad above it.
    assert.equal(good.pFront, 1);
    assert.equal(doc.deployment.rule.kind, "pareto");
    assert.ok(doc.deployment.picked.includes("good"), JSON.stringify(doc.deployment));
    assert.ok(Array.isArray(doc.frontierAxes), JSON.stringify(doc.frontierAxes));
    const human = await cli("compare", [experimentId], { ...flags, select: "weighted", lambda: 0 });
    assert.match(human.stdout, /\tfront 1\.00\n/);
    assert.match(human.stdout, /^deploy: good \(weighted λ=0: highest quality − 0 × (cost|wall time): 0\.900\)$/m);
    // No run records a cost: the cost column says so instead of printing $NaN.
    assert.match(human.stdout, /^good\t2\t0\.900 \[[^\]]+\]\t-\t/m);
    const minCost = await json("compare", [experimentId], { ...flags, select: "min-cost", "q-min": 2 });
    assert.deepEqual(minCost.deployment.picked, []);
    assert.deepEqual(minCost.deployment.rule, { kind: "min-cost", qMin: 2 });
    assert.deepEqual((await json("compare", [experimentId], { ...flags, select: "min-cost" })).deployment.rule, { kind: "min-cost", qDropFrom: { variant: "bad", pp: 10 } });
    await assert.rejects(cli("compare", [experimentId], { ...flags, select: "weighted" }), /--select weighted needs --lambda/);
    await assert.rejects(cli("compare", [experimentId], { ...flags, "q-min": 0.5 }), /--q-min needs --select/);
    await assert.rejects(cli("compare", [experimentId], { ...flags, select: "min-cost", "q-min": 0.5, "q-drop": 10 }), /--q-min or --q-drop, not both/);
    await assert.rejects(cli("compare", [experimentId], { ...flags, select: "pareto", lambda: 1 }), /--select pareto takes no --lambda/);
    await assert.rejects(cli("compare", [experimentId], { ...flags, select: "cheapest" }), /--select must be one of min-cost, weighted, pareto/);
  });

  it("compare counts a pass at each case's threshold, and --threshold sets one for every case", async () => {
    const e = { CODING_SH_HOME: join(root, "threshold-home") };
    const dir = join(root, "cases-threshold");
    writeReviewCases(dir);
    // seeded-1 asks for 0.9, so the good variant's F1 of 0.8 fails there, as the bad variant's 0 does.
    const file = join(dir, "seeded-1.toml");
    writeFileSync(file, readFileSync(file, "utf8").replace("threshold = 0.5", "threshold = 0.9"));
    const variant = [`bad=node ${join(root, "fake-wf.mjs")} bad`, `good=node ${join(root, "fake-wf.mjs")} good`];
    const id = (await json("run", ["review"], { driver: "command", variant, cases: dir, split: "dev", k: 1, yes: true }, e)).experimentId;
    const passes = async (flags: Record<string, FlagValue>) => {
      const { mcnemar } = await json("compare", [id], { baseline: "bad", candidate: "good", ...flags }, e);
      return [mcnemar.b, mcnemar.c];
    };
    assert.deepEqual(await passes({}), [0, 0]);
    assert.deepEqual(await passes({ threshold: 0.5 }), [0, 1]);
  });

  it("replay predicts cache hits (dry run), asks above the threshold, and resumes through claude", async () => {
    const edited = join(root, "review-v2.js");
    writeFileSync(edited, SCRIPT.replace(`prompt: "Summarize"`, `prompt: "Summarize briefly"`));
    const dry = await json("replay", [RUN], { script: edited, "dry-run": true });
    assert.equal(dry.prediction.hits, 8);
    assert.equal(dry.prediction.firstMiss.label, "verify-schema");
    assert.equal(dry.run, null);
    const human = await cli("replay", [RUN], { script: edited, "dry-run": true });
    assert.match(human.stderr, /Cached \(est\.\)\s+8 of 9 agent calls \(heuristic\)/);

    await assert.rejects(cli("replay", [RUN], { script: edited }, { env: { CODING_SH_CONFIRM_ABOVE_USD: "0.01" } }), (e: Error & { reason?: string }) => e.reason === "confirmation_required");

    const bin = nodeBin(
      root,
      "fake-claude",
      `import { utimesSync } from "node:fs";
const t = new Date(Date.now() + 120_000);
utimesSync(${JSON.stringify(join(resumedDir, "journal.jsonl"))}, t, t);
console.log(JSON.stringify({ session_id: ${JSON.stringify(SID)}, result: JSON.stringify({ findings: [] }), is_error: false }));
`,
    );
    const live = await json("replay", [RUN], { script: edited, bin });
    assert.equal(live.run.id, RESUMED);
    assert.ok(live.run.tags.includes("replay"));
    assert.equal(live.run.stats.cacheHits, 7);
    await assert.rejects(cli("replay", [RUN], {}), /Pass --script/);
    await assert.rejects(cli("replay", [RUN], { script: join(root, "missing.js") }), /Can't read --script/);
  });
});

describe("workflows command helpers", () => {
  it("accepts fromCheckpoint and replayFrom only for the command driver", async () => {
    const v = await parseVariant(JSON.stringify({ name: "fork", command: ["node", "app.mjs"], fromCheckpoint: "ckpt-1", replayFrom: "plan" }), "command");
    assert.deepEqual([v.fromCheckpoint, v.replayFrom], ["ckpt-1", "plan"]);
    await assert.rejects(parseVariant(JSON.stringify({ name: "fork", script: "a.js", fromCheckpoint: "ckpt-1" }), "claude"), /fromCheckpoint and replayFrom need --driver command/);
  });

  it("parses variants in every accepted form", async () => {
    assert.deepEqual(await parseVariant("base=wf/a.js", "claude"), { name: "base", script: "wf/a.js" });
    assert.deepEqual(await parseVariant("wf/improve-v2.js", "claude"), { name: "improve-v2", script: "wf/improve-v2.js" });
    assert.deepEqual(await parseVariant("g=python app.py --fast", "command"), { name: "g", command: ["python", "app.py", "--fast"] });
    assert.deepEqual(await parseVariant('{"name":"j","script":"s.js","args":{"x":1}}', "claude"), { name: "j", script: "s.js", args: { x: 1 } });
    const file = join(root, "variant.json");
    writeFileSync(file, JSON.stringify({ name: "f", command: "node x.js" }));
    assert.deepEqual(await parseVariant(file, "command"), { name: "f", command: ["node", "x.js"] });
    await assert.rejects(parseVariant('{"script":"s.js"}', "claude"), /needs a "name"/);
  });

  it("warns about each field a JSON variant has that it does not know", async () => {
    const warnings: string[] = [];
    const file = join(root, "variant-typo.json");
    writeFileSync(file, JSON.stringify({ name: "fork", command: ["node", "app.mjs"], fromCheckPoint: "ckpt-1", note: "x" }));
    assert.deepEqual(await parseVariant(file, "command", (m) => warnings.push(m)), { name: "fork", command: ["node", "app.mjs"] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^Variant "fork": ignored unknown fields "fromCheckPoint" \(did you mean fromCheckpoint\?\), "note"\. Known fields: name, script, command, args, resumeFromRunId, fromCheckpoint, replayFrom$/);
    warnings.length = 0;
    await parseVariant('{"name":"j","script":"s.js","arg":{"x":1}}', "claude", (m) => warnings.push(m));
    assert.deepEqual(warnings, ['Variant "j": ignored unknown field "arg" (did you mean args?). Known fields: name, script, command, args, resumeFromRunId, fromCheckpoint, replayFrom']);
    warnings.length = 0;
    await parseVariant(JSON.stringify({ name: "ok", script: "s.js", args: {}, resumeFromRunId: "r" }), "claude", (m) => warnings.push(m));
    assert.deepEqual(warnings, []);
  });

  it("run prints the unknown-field warning before it runs the variant", async () => {
    const r = await cli(
      "run",
      ["review"],
      { driver: "command", variant: [JSON.stringify({ name: "solo", command: [process.execPath, join(root, "fake-wf.mjs"), "good"], replayfrom: "plan" })], split: "dev", k: 1, yes: true },
      { env: { CODING_SH_HOME: join(root, "variant-warn") } },
    );
    assert.equal(r.code, 0);
    assert.match(r.stderr, /! Variant "solo": ignored unknown field "replayfrom" \(did you mean replayFrom\?\)/);
  });

  it("run says why each run failed, redacted with the capture profile, and show prints it", async () => {
    const home = join(root, "failed-runs");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), '[capture]\nredactPatterns = ["hunter2"]\n');
    writeFileSync(join(root, "deny.mjs"), 'console.error("login failed for hunter2");\nprocess.exit(1);\n');
    const e = { CODING_SH_HOME: home };
    const flags = {
      driver: "command",
      variant: [JSON.stringify({ name: "missing", command: ["no-such-cmd-xyz"] }), JSON.stringify({ name: "denied", command: [process.execPath, join(root, "deny.mjs")] })],
      split: "dev",
      k: 1,
      yes: true,
    };
    const doc = await json("run", ["review"], flags, e);
    assert.equal(doc.failed, 4);
    const missing = doc.runs.find((r: { variant: string; caseId: string }) => r.variant === "missing" && r.caseId === "seeded-1");
    assert.match(missing.error, /spawn no-such-cmd-xyz ENOENT/);
    const denied = doc.runs.find((r: { variant: string; caseId: string }) => r.variant === "denied" && r.caseId === "seeded-1");
    assert.match(denied.error, /^login failed for \[redacted/);
    assert.doesNotMatch(JSON.stringify(doc), /hunter2/);
    const human = await cli("run", ["review"], flags, { env: e });
    assert.equal(human.code, 0);
    assert.match(human.stderr, /Ran 4 workflow runs, 4 failed/);
    assert.match(human.stderr, /! missing on seeded-1 failed: spawn no-such-cmd-xyz ENOENT \(wfr_\w+\)/);
    assert.match(human.stderr, /! denied on verify-1 failed: login failed for \[redacted[^\n]*\(wfr_\w+\)/);
    assert.doesNotMatch(human.stderr, /hunter2/);
    const shown = await cli("show", [missing.id], {}, { env: e });
    assert.match(shown.stderr, /✗ Status +failed\n {2}Error +spawn no-such-cmd-xyz ENOENT\n/);
    const shownJson = await json("show", [denied.id], {}, e);
    assert.match(shownJson.run.error, /^login failed for \[redacted/);
    // A run that did not fail has no error.
    assert.equal((await json("list", [], { import: false })).runs.every((r: { status: string; error: unknown }) => r.status !== "ok" || r.error === null), true);
  });

  it("reads the confirm threshold from the environment", () => {
    assert.equal(confirmAboveUsd({}), 1);
    assert.equal(confirmAboveUsd({ CODING_SH_CONFIRM_ABOVE_USD: "2.5" }), 2.5);
    assert.equal(confirmAboveUsd({ CODING_SH_CONFIRM_ABOVE_USD: "x" }), 1);
  });

  it("reads verify entries only from candidates carrying survived", () => {
    assert.equal(verifyEntries({ candidates: [{ file: "a", line: 1 }] }), undefined);
    const v = verifyEntries({ candidates: [{ file: "a", line: 1, survived: false, votes: [false] }, { nofile: true, survived: true }] })!;
    assert.deepEqual(v.entered, [{ findingIdx: 0, survived: false, votes: [false] }]);
  });

  it("renders the tree in start order, hiding detail nodes unless asked", () => {
    const n = (id: string, kind: WorkflowNode["kind"], parentId?: string, startedAt?: number): WorkflowNode => ({ id, runId: "r", kind, name: id, status: "ok", ...(parentId ? { parentId } : {}), ...(startedAt !== undefined ? { startedAt } : {}) });
    const nodes = [n("r", "workflow"), n("b", "agent", "r", 20), n("a", "agent", "r", 10), n("t", "tool", "a", 11)];
    assert.deepEqual(renderTree(nodes, false), ["workflow r  ok  -", "  agent a  ok  -", "  agent b  ok  -"]);
    assert.equal(renderTree(nodes, true).length, 4);
  });
});
