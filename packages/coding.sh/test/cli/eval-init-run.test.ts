// `eval init` then `eval run`, end to end through src/cli/main.ts with a temp
// HOME: a cases suite answered by a command, a skill suite still holding its
// TODO prompts, and a hand-written repo-task suite run by a fake agent (the
// "wrapper" agent from a harness bundle) with a `judge grade` verifier.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { which } from "../../src/adapters/_shared/detect.ts";
import { posixShell } from "../../src/core/spawn.ts";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const gitBin = which("git") ?? "";
let root = "";
let home = "";
let proj = "";
let env: Record<string, string> = {};

function cli(args: string[], cwd = proj) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 120_000 });
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-evalinit-")));
  home = join(root, "home");
  proj = join(root, "proj");
  for (const d of [home, proj, join(root, "tmp")]) mkdirSync(d);
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: pathOf(dirname(process.execPath), gitBin ? dirname(gitBin) : undefined, process.platform === "win32" ? dirname(posixShell() ?? "") : undefined, "/usr/bin", "/bin"),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    CODING_SH_HOOK_SOURCE: join(root, "hook-source.mjs"),
  };
  writeFileSync(join(root, "hook-source.mjs"), "// test hook\n");
  // The app under test: labels a ticket. "wrong color" is a bug it misses.
  writeFileSync(
    join(proj, "triage.mjs"),
    `let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const t = String(JSON.parse(s)).toLowerCase(); process.stdout.write(/refund|charge/.test(t) ? "billing" : /crash|error/.test(t) ? "bug" : "other"); });\n`,
  );
  writeFileSync(
    join(proj, "cases.jsonl"),
    ['{"input":"I was charged twice","expected":"billing"}', '{"input":"The app crashes on start","expected":"bug"}', '{"input":"Where is your office?","expected":"other"}', '{"input":"Button is the wrong color","expected":"bug"}'].join("\n") + "\n",
  );
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("eval init + eval run: cases", () => {
  it("scaffolds a regression suite with a code grader and the CI snippet, then fails the run on the case it misses", () => {
    const init = cli(["eval", "init", "triage", "--cases", "cases.jsonl", "--command", "node triage.mjs", "--trials", "2"]);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.match(init.stderr, /Wrote regression suite triage \(cases\) to evals\/triage/);
    assert.match(init.stderr, /coding\.sh eval run triage/);
    assert.match(init.stdout, /run: coding\.sh eval run triage --yes/, "the CI workflow is the answer on stdout");
    const spec = JSON.parse(readFileSync(join(proj, "evals", "triage", "suite.json"), "utf8")) as { graders: { kind: string }[]; trials: number };
    assert.deepEqual([spec.graders[0]!.kind, spec.trials], ["exact", 2]);

    const run = cli(["eval", "run", "triage"]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /pass@1  75\.0%/);
    assert.match(run.stdout, /pass@2  75\.0%/);
    assert.match(run.stdout, /pass\^2  75\.0%/);
    assert.match(run.stdout, /Button is the wrong color\s+0\/2\s+never\s+exact: expected "bug", got "other"/);
    assert.match(run.stdout, /regression suite: Button is the wrong color fails most trials/);

    const json = cli(["eval", "run", "triage", "--json"]);
    assert.equal(json.status, 1);
    const doc = JSON.parse(json.stdout) as { suite: string; kind: string; experimentId: string; report: { ok: boolean; passAtK: number; failing: string[]; k: number } };
    assert.deepEqual([doc.suite, doc.kind, doc.report.ok, doc.report.k, doc.report.failing], ["triage", "cases", false, 2, ["Button is the wrong color"]]);
    assert.match(doc.experimentId, /^exp_/);
    assert.equal(cli(["exp", "show", doc.experimentId]).status, 0, "the run is a stored experiment");
  });

  it("does not fail a capability suite on its score", () => {
    const init = cli(["eval", "init", "triage-hill", "--cases", "cases.jsonl", "--command", "node triage.mjs", "--purpose", "capability", "-k", "1"]);
    assert.equal(init.status, 0, init.stderr);
    const run = cli(["eval", "run", "triage-hill"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /one trial per case/);
  });
});

describe("eval init + eval run: skill", () => {
  it("writes TODO prompts that eval run refuses until they are replaced", () => {
    mkdirSync(join(proj, ".claude", "skills", "pdf"), { recursive: true });
    writeFileSync(join(proj, ".claude", "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Read, fill and merge PDF files\n---\nUse pdftk.\n");
    const init = cli(["eval", "init", "--skill", ".claude/skills/pdf", "--json"]);
    assert.equal(init.status, 0, init.stderr);
    const r = JSON.parse(init.stdout) as { name: string; kind: string; todo: boolean; files: string[] };
    assert.deepEqual([r.name, r.kind, r.todo, r.files], ["pdf", "triggers", true, ["evals/pdf/suite.json", "evals/pdf/triggers.toml"]]);
    const run = cli(["eval", "run", "pdf", "--yes"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /6 prompts in evals\/pdf\/triggers\.toml still say TODO:/);
    assert.match(run.stderr, /coding\.sh eval init pdf --skill \.claude\/skills\/pdf --draft --force/);
    assert.equal(cli(["eval", "init", "--skill", ".claude/skills/pdf"]).status, 1, "an existing suite needs --force");
  });
});

describe("eval init: no source", () => {
  it("lists the sources when not on a terminal", () => {
    const r = cli(["eval", "init"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /eval init --sessions/);
    assert.match(r.stderr, /eval init --skill/);
    assert.match(r.stderr, /--describe/);
  });
  it("says there is nothing to draft from when no session failed", () => {
    const r = cli(["eval", "init", "--sessions"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no failed or flagged sessions/);
  });
  it("eval run points at eval init when there are no suites", () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const r = cli(["eval", "run"], empty);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No suites in/);
    assert.match(r.stderr, /coding\.sh eval init/);
  });
});

describe("eval run: repo tasks", () => {
  it("runs a tasks suite with one harness and reports per-task trials", (t) => {
    if (!gitBin) return t.skip("needs git");
    // Answers "Which team?" only when the harness ships the skill.
    writeFileSync(
      join(root, "agent.mjs"),
      `import {existsSync} from "node:fs";
const say = (o) => console.log(JSON.stringify(o));
say({ type: "result", result: existsSync(".claude/skills/demo/SKILL.md") ? "Which team should I audit?" : "Done." });
`,
    );
    for (const [name, skill] of [["plain", false], ["skilled", true]] as const) {
      const h = join(root, name);
      mkdirSync(join(h, ".claude"), { recursive: true });
      if (skill) {
        mkdirSync(join(h, ".claude/skills/demo"), { recursive: true });
        writeFileSync(join(h, ".claude/skills/demo/SKILL.md"), "Ask for the team first.\n");
      }
      writeFileSync(join(h, "harness.toml"), `name = "${name}"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs")])}\ninclude = [".claude/**"]\n`);
      const snap = cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
      assert.equal(snap.status, 0, snap.stdout + snap.stderr);
    }
    const suite = join(proj, "evals", "scope");
    const task = join(suite, "tasks", "asks-for-scope");
    mkdirSync(join(task, "tests", "grader"), { recursive: true });
    writeFileSync(join(suite, "suite.json"), JSON.stringify({ name: "scope", purpose: "regression", trials: 2, tasks: "tasks" }));
    const verifier = `"${process.execPath}" --no-warnings "${CLI}" judge grade --grader grader/checklist.json`;
    writeFileSync(join(task, "task.json"), JSON.stringify({ name: "asks-for-scope", verifier: { command: verifier, timeoutMs: 60_000 } }));
    writeFileSync(join(task, "instruction.md"), "Audit our Vercel security settings.\n");
    writeFileSync(
      join(task, "tests", "grader", "checklist.json"),
      JSON.stringify({ kind: "llm-checklist", name: "scope", provider: "mock", items: [{ id: "asks", question: "Did it ask which team?", critical: true, check: { name: "output-matches", args: { pattern: "which team", flags: "i" } } }] }),
    );

    assert.match(cli(["eval", "run", "scope"]).stderr, /needs confirmation\. Pass --yes/);
    const good = cli(["eval", "run", "scope", "--harness", "skilled", "--yes", "--json"]);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    const doc = JSON.parse(good.stdout) as { kind: string; harness: { name: string }; unverified: string[]; report: { ok: boolean; passed: number; trials: number; passHatK: number } };
    assert.deepEqual([doc.kind, doc.harness.name, doc.report.ok, doc.report.passed, doc.report.trials, doc.report.passHatK], ["tasks", "skilled", true, 2, 2, 1]);
    assert.deepEqual(doc.unverified, ["asks-for-scope"], "a hand-written task with no reference.patch is unverified");

    const bad = cli(["eval", "run", "scope", "--harness", "plain", "--yes"]);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /asks-for-scope\s+0\/2\s+never\s+verifier exit 1/, "the wrapper agent is not captured, so the reason stands in for a transcript");
    assert.match(bad.stdout, /harness plain/);
    assert.match(bad.stdout, /without a reference solution \(asks-for-scope\)/);
    const tagged = JSON.parse(cli(["eval", "list", "--tag", "suite:scope", "--json"]).stdout) as { tasks: unknown[] };
    assert.equal(tagged.tasks.length, 1, "suite tasks carry suite:<name>, for compare --tag");
  });
});
