// `coding.sh workflows` through the command module's run(), with a fake
// Output and a temp HOME / CODING_SH_HOME / CLAUDE_CONFIG_DIR.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { FlagValue } from "../../src/cli/args.ts";
import { confirmAboveUsd, parseVariant, renderTree, run, verifyEntries } from "../../src/cli/commands/workflows.ts";
import { Output } from "../../src/cli/output.ts";
import { WORKFLOWS_COMMAND } from "../../src/workflows/cli-spec.ts";
import type { WorkflowNode } from "../../src/workflows/types.ts";
import { RESUMED, RUN, RUN_OUTPUT, SCRIPT, SID, writeClaudeWorkflowFixture, writeReviewCases } from "./_fixtures.ts";

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

async function cli(action: string, positionals: string[], flags: Record<string, FlagValue> = {}, o: { json?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const e = { ...env, ...o.env };
  const out = new Output({ json: o.json ?? false, env: e, stdout: { write: (s: string) => (stdout += s), isTTY: false }, stderr: { write: (s: string) => (stderr += s), isTTY: false }, stdin: { isTTY: false } });
  const code = await run({ action, flags, positionals, rest: [], out, env: e, cwd: join(root, "repo"), debug: false, signal: new AbortController().signal });
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

  it("import reports skipped and forced re-imports", async () => {
    const again = await json("import", [join(root, "claude", "projects")]);
    assert.equal(again.found, 2);
    assert.equal(again.skipped, 2);
    const forced = await json("import", [join(root, "claude", "projects")], { force: true });
    assert.equal(forced.imported.length, 2);
    await assert.rejects(cli("import", [join(root, "missing")]), /Can't find/);
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

  let experimentId = "";

  it("run asks before spending above the threshold, then runs the experiment", async () => {
    const flags = {
      driver: "command",
      variant: [JSON.stringify({ name: "bad", command: [process.execPath, join(root, "fake-wf.mjs"), "bad"] }), `good=${process.execPath} ${join(root, "fake-wf.mjs")} good`],
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
    assert.equal(doc.runs.find((r: { caseId: string }) => r.caseId === "verify-1").score, null);
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
    assert.equal(doc.pairedCases, 1);
    assert.equal(doc.quality.candidate, 0.8);
    const human = await cli("compare", [experimentId], { baseline: "bad", candidate: "good" });
    assert.match(human.stdout.split("\n")[0]!, /^(inconclusive|no significant difference|candidate)/);
    assert.match(human.stdout, /METRIC\tBAD\tGOOD\tDIFF \[CI\]\tPAIRS/);
    assert.match(human.stdout, /quality\t0\.000\t0\.800/);
    await assert.rejects(cli("compare", [experimentId], { baseline: "bad", candidate: "zzz" }), /no variant "zzz"/);
    await assert.rejects(cli("compare", ["wfx_none"], { baseline: "a", candidate: "b" }), /Can't find workflow experiment/);
    await assert.rejects(cli("compare", [experimentId], {}), /--baseline/);
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

    const bin = join(root, "fake-claude.mjs");
    writeFileSync(
      bin,
      `#!${process.execPath}
import { utimesSync } from "node:fs";
const t = new Date(Date.now() + 120_000);
utimesSync(${JSON.stringify(join(resumedDir, "journal.jsonl"))}, t, t);
console.log(JSON.stringify({ session_id: ${JSON.stringify(SID)}, result: JSON.stringify({ findings: [] }), is_error: false }));
`,
    );
    chmodSync(bin, 0o755);
    const live = await json("replay", [RUN], { script: edited, bin });
    assert.equal(live.run.id, RESUMED);
    assert.ok(live.run.tags.includes("replay"));
    assert.equal(live.run.stats.cacheHits, 7);
    await assert.rejects(cli("replay", [RUN], {}), /Pass --script/);
    await assert.rejects(cli("replay", [RUN], { script: join(root, "missing.js") }), /Can't read --script/);
  });
});

describe("workflows command helpers", () => {
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
