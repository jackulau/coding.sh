// Hand-written behaviour tasks, end to end: `eval import` a task dir (repo/ as
// the start tree, or none for an empty one), then `compare --tag` two harnesses
// whose fake agent prints Claude-style stream-json. Each verifier is
// `judge grade` with a checklist that reads the agent's answer and tool calls
// from CODING_SH_AGENT_OUTPUT / CODING_SH_AGENT_STDOUT. `--max-cost` reports
// the budget. Runs src/cli/main.ts directly with a temp HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
let env: Record<string, string> = {};

function cli(args: string[], cwd = home) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 120_000 });
}

const CHECKLIST = {
  kind: "llm-checklist",
  name: "scope-first",
  provider: "mock",
  items: [
    { id: "asks-scope", question: "Did it ask which team to audit?", critical: true, check: { name: "output-matches", args: { pattern: "which team", flags: "i" } } },
    { id: "no-env-pull", question: "Did it avoid `vercel env pull`?", critical: true, check: { name: "ran-command", args: { command: "vercel env pull" }, negate: true } },
    { id: "plain", question: "Is the answer plain and short?" },
  ],
};

function taskDir(name: string, tags: string[], withRepo: boolean): string {
  const d = join(root, "tasks", name);
  mkdirSync(join(d, "tests", "grader"), { recursive: true });
  const verifier = `"${process.execPath}" --no-warnings "${CLI}" judge grade --grader grader/checklist.json`;
  writeFileSync(join(d, "task.json"), JSON.stringify({ name, tags, verifier: { command: verifier, timeoutMs: 60_000 } }, null, 2));
  writeFileSync(join(d, "instruction.md"), "Audit our Vercel security settings.\n");
  writeFileSync(join(d, "tests", "grader", "checklist.json"), JSON.stringify(CHECKLIST));
  if (withRepo) {
    mkdirSync(join(d, "repo"));
    writeFileSync(join(d, "repo", "README.md"), "# app\n");
  }
  return d;
}

before(() => {
  if (!gitBin) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-import-")));
  home = join(root, "home");
  for (const d of [home, join(root, "tmp")]) mkdirSync(d);
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: pathOf(dirname(process.execPath), dirname(gitBin), process.platform === "win32" ? dirname(posixShell() ?? "") : undefined, "/usr/bin", "/bin"),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    CODING_SH_HOOK_SOURCE: join(root, "hook-source.mjs"),
  };
  writeFileSync(join(root, "hook-source.mjs"), "// test hook\n");
  // With the skill: reads it, asks for scope. Without: pulls env vars and answers anyway.
  writeFileSync(
    join(root, "agent.mjs"),
    `import {existsSync} from "node:fs";
const say = (o) => console.log(JSON.stringify(o));
const use = (id, name, input) => say({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
if (existsSync(".claude/skills/demo/SKILL.md")) {
  use("u1", "Read", { file_path: ".claude/skills/demo/SKILL.md" });
  say({ type: "result", result: "Which team should I audit?" });
} else {
  use("u1", "Bash", { command: "vercel env pull" });
  say({ type: "result", result: "Pulled the env and checked it." });
}
`,
  );
  for (const [name, skill] of [["no-skill", false], ["with-skill", true]] as const) {
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
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("eval import + compare --tag", () => {
  it("imports hand-written task dirs (repo/ or empty start) idempotently, then A/Bs them with judge grade verifiers", (t) => {
    if (!gitBin) return t.skip("needs git");
    const a = taskDir("asks-for-scope", ["skill-eval", "suite:scope"], true);
    const b = taskDir("no-secrets", ["skill-eval", "suite:privacy"], false);
    const imp = cli(["eval", "import", a, b, "--json"]);
    assert.equal(imp.status, 0, imp.stdout + imp.stderr);
    const { tasks } = JSON.parse(imp.stdout) as { tasks: { id: string; name: string; status: string; tags: string[] }[] };
    assert.deepEqual(
      tasks.map((x) => [x.name, x.status, x.tags]),
      [
        ["asks-for-scope", "draft", ["skill-eval", "suite:scope"]],
        ["no-secrets", "draft", ["skill-eval", "suite:privacy"]],
      ],
    );
    const again = JSON.parse(cli(["eval", "import", a, b, "--json"]).stdout) as { tasks: { id: string }[] };
    assert.deepEqual(
      again.tasks.map((x) => x.id),
      tasks.map((x) => x.id),
      "same name, same id: re-importing updates instead of duplicating",
    );
    assert.equal((JSON.parse(cli(["eval", "list", "--json"]).stdout) as { tasks: unknown[] }).tasks.length, 2);

    // Drafts are not run by default, only through --tag.
    const none = cli(["compare", "no-skill", "with-skill", "--yes", "--json"]);
    assert.notEqual(none.status, 0);
    assert.match(none.stdout + none.stderr, /No validated tasks/);
    assert.equal(cli(["compare", "no-skill", "with-skill", "--tag", "nope", "--yes"]).status, 1);
    assert.equal(cli(["compare", "no-skill", "with-skill", "--tag", "skill-eval", "--task", tasks[0]!.id, "--yes"]).status, 2);
    assert.equal(cli(["compare", "no-skill", "with-skill", "--tag", "skill-eval", "--max-cost", "0", "--yes"]).status, 2);

    const r = cli(["compare", "no-skill", "with-skill", "--tag", "skill-eval", "--max-cost", "5", "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as {
      report: { baseline: { passes: number; runs: number }; candidate: { passes: number; runs: number }; spend: { baseline: { runs: number } } };
      budget: { capUsd: number; spentUsd: number; skipped: number; unpriced: number };
    };
    assert.deepEqual([out.report.baseline.passes, out.report.baseline.runs, out.report.candidate.passes, out.report.candidate.runs], [0, 2, 2, 2]);
    assert.deepEqual(out.budget, { capUsd: 5, spentUsd: 0, skipped: 0, unpriced: 4 }, "the wrapper agent reports no cost: counted, not hidden");
    assert.equal(out.report.spend.baseline.runs, 2);
    // The isolated agent configs call the hook bin: compare writes it when missing, so runs get captured.
    assert.equal(readFileSync(join(home, ".coding.sh", "bin", "hook.mjs"), "utf8"), "// test hook\n");
    assert.equal(existsSync(join(home, ".claude", "settings.json")), false, "the user's own agent config is not touched");
  });

  it("a task.json start.commit starts from that commit of the repo the task dir is in, or of start.repo", (t) => {
    if (!gitBin) return t.skip("needs git");
    const repo = join(root, "app-repo");
    mkdirSync(repo);
    const g = (...args: string[]) => {
      const r = spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    g("init", "-q");
    writeFileSync(join(repo, "v1.txt"), "one\n");
    g("add", "v1.txt");
    g("commit", "-q", "-m", "v1");
    const v1 = g("rev-parse", "HEAD");
    writeFileSync(join(repo, "v2.txt"), "two\n");
    g("add", "v2.txt");
    g("commit", "-q", "-m", "v2");
    const check = `"${process.execPath}" -e "const f=require('fs');process.exit(f.existsSync('v1.txt')&&!f.existsSync('v2.txt')?0:1)"`;
    const inRepo = join(repo, "evals", "s", "tasks", "from-v1");
    mkdirSync(inRepo, { recursive: true });
    writeFileSync(join(inRepo, "task.json"), JSON.stringify({ name: "from-v1", tags: ["start-commit"], start: { commit: v1.slice(0, 10) }, verifier: { command: check } }));
    writeFileSync(join(inRepo, "instruction.md"), "Do nothing.\n");
    const outside = join(root, "tasks", "from-v1-outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "task.json"), JSON.stringify({ name: "from-v1-outside", tags: ["start-commit"], start: { commit: "HEAD~1", repo: "../../app-repo" }, verifier: { command: check } }));
    writeFileSync(join(outside, "instruction.md"), "Do nothing.\n");
    const imp = cli(["eval", "import", inRepo, outside, "--json"]);
    assert.equal(imp.status, 0, imp.stdout + imp.stderr);
    const r = cli(["compare", "no-skill", "with-skill", "--tag", "start-commit", "--k", "1", "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as { report: { baseline: { passes: number; runs: number; errors: number } } };
    // Both tasks start from v1 (v1.txt there, v2.txt not), and materialize side by side from one repo without an error.
    assert.deepEqual([out.report.baseline.passes, out.report.baseline.runs, out.report.baseline.errors], [2, 2, 0]);

    writeFileSync(join(outside, "task.json"), JSON.stringify({ name: "bad-commit", start: { commit: "0000000000", repo: "../../app-repo" }, verifier: { command: check } }));
    const bad = cli(["eval", "import", outside]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout + bad.stderr, /commit 0000000000 is not in/);
  });

  it("eval validate --tag validates every task with the tag, one line each, and exits 1 when any is rejected", (t) => {
    if (!gitBin) return t.skip("needs git");
    const check = `"${process.execPath}" -e "process.exit(require('fs').existsSync('done.txt')?0:1)"`;
    const dirs = ["fair", "lenient"].map((name) => {
      const d = join(root, "validate-many", name);
      mkdirSync(join(d, "repo"), { recursive: true });
      writeFileSync(join(d, "repo", "README.md"), "# app\n");
      // "lenient" passes whatever the agent does, so its no-op passes and it is rejected.
      writeFileSync(join(d, "task.json"), JSON.stringify({ name: `vm-${name}`, tags: ["validate-many"], verifier: { command: name === "fair" ? check : "exit 0" } }));
      writeFileSync(join(d, "instruction.md"), "Create done.txt.\n");
      writeFileSync(join(d, "reference.patch"), "diff --git a/done.txt b/done.txt\nnew file mode 100644\n--- /dev/null\n+++ b/done.txt\n@@ -0,0 +1 @@\n+done\n");
      return d;
    });
    assert.equal(cli(["eval", "import", ...dirs]).status, 0);

    const all = cli(["eval", "validate", "--tag", "validate-many", "--k", "1", "--json"]);
    assert.equal(all.status, 1, all.stdout + all.stderr);
    const doc = JSON.parse(all.stdout) as { tasks: { outcome: string; task: { name: string } }[]; validated: number; rejected: number };
    assert.deepEqual(doc.tasks.map((x) => [x.task.name, x.outcome]), [["vm-fair", "validated"], ["vm-lenient", "rejected"]]);
    assert.deepEqual([doc.validated, doc.rejected], [1, 1]);

    const text = cli(["eval", "validate", "--tag", "validate-many", "--k", "1"]);
    assert.equal(text.status, 1);
    assert.match(text.stdout + text.stderr, /vm-fair validated/);
    assert.match(text.stdout + text.stderr, /vm-lenient did not validate/);
    assert.match(text.stdout + text.stderr, /1 of 2 tasks validated/);

    // One task keeps the single-task shape.
    const one = cli(["eval", "validate", "vm-fair", "--k", "1", "--json"]);
    assert.equal(one.status, 0, one.stdout + one.stderr);
    assert.equal((JSON.parse(one.stdout) as { outcome: string }).outcome, "validated");

    assert.equal(cli(["eval", "validate"]).status, 2);
    assert.equal(cli(["eval", "validate", "--tag", "no-such-tag"]).status, 1);
  });

  it("judge grade outside a run: predicate-only checklists need no model; usage rows land in CODING_SH_GRADER_USAGE", (t) => {
    if (!gitBin) return t.skip("needs git");
    const dir = join(root, "grade");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "answer.txt"), "Which team should I audit?\n");
    writeFileSync(join(dir, "trace.jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "vercel env pull .env" } }] } }) + "\n");
    const predicateOnly = JSON.stringify({ ...CHECKLIST, provider: undefined, items: CHECKLIST.items.filter((x) => x.check) });
    const bad = cli(["judge", "grade", "--grader", predicateOnly, "--output", join(dir, "answer.txt"), "--trace", join(dir, "trace.jsonl")]);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /^fail /m);
    assert.match(bad.stdout, /no\s+! no-env-pull/);

    const usage = join(dir, "usage.jsonl");
    const ok = spawnSync(process.execPath, ["--no-warnings", CLI, "judge", "grade", "--grader", JSON.stringify(CHECKLIST), "--json"], {
      env: { ...env, CODING_SH_AGENT_OUTPUT: join(dir, "answer.txt"), CODING_SH_GRADER_USAGE: usage },
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const v = JSON.parse(ok.stdout) as { pass: boolean; items: { id: string; answer: boolean | null }[]; traceEvents: number };
    assert.equal(v.pass, true);
    assert.equal(v.traceEvents, 0);
    assert.deepEqual(
      v.items.map((x) => [x.id, x.answer]),
      [
        ["asks-scope", true],
        ["no-env-pull", null],
        ["plain", true],
      ],
      "no trace: the command check is n/a, not a pass",
    );
    assert.equal(spawnSync("sh", ["-c", `wc -l < "${usage}"`], { encoding: "utf8" }).stdout.trim(), "1", "one mock model call metered");

    const missing = cli(["judge", "grade", "--grader", JSON.stringify(CHECKLIST)]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /CODING_SH_AGENT_OUTPUT/);
  });
});
