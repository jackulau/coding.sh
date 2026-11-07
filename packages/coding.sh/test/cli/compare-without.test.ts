// `coding.sh compare <bundle> --without <path>` (Z-9): one-command ablation.
// A fake `wrapper` agent fixes the bug only when the pdf skill is in its work
// dir and counts its runs, so both arms run on every task and the skill's
// effect is +100 pp. Runs src/cli/main.ts directly with a temp HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { which } from "../../src/adapters/_shared/detect.ts";
import { pathOf } from "../_bin.ts";
import { posixShell } from "../../src/core/spawn.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const gitBin = which("git") ?? "";
let root = "";
let home = "";
let repo = "";
let env: Record<string, string> = {};

function cli(args: string[], cwd = home) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 60_000 });
}

before(() => {
  if (!gitBin) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-without-")));
  home = join(root, "home");
  repo = join(root, "repo");
  for (const d of [home, repo, join(root, "tmp")]) mkdirSync(d);
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    // The verifier runs in sh; on Windows that is Git's bash, which may not sit next to the git on PATH.
    PATH: pathOf(dirname(process.execPath), dirname(gitBin), process.platform === "win32" ? dirname(posixShell() ?? "") : undefined, "/usr/bin", "/bin"),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  writeFileSync(join(repo, "sum.js"), "module.exports = (a, b) => a - b;\n");
  writeFileSync(join(repo, "test.js"), 'if (require("./sum.js")(2, 3) !== 5) process.exit(1);\n');
  const git = (...a: string[]) => assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  // Source session → task (start = the buggy repo), then put the repo back.
  const fix = 'require("fs").writeFileSync("sum.js","module.exports=(a,b)=>a+b;\\n")';
  assert.equal(cli(["run", "--", process.execPath, "-e", fix], repo).status, 0);
  const t = cli(["eval", "new", "latest", "--name", "sum", "--verifier", "node test.js", "--instruction", "make sum add", "--tag", "suite:sum", "--json"], repo);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  git("checkout", "-q", "sum.js");

  // The fake agent: fixes sum.js only when the skill was applied, logs every run.
  writeFileSync(
    join(root, "agent.mjs"),
    `import {appendFileSync, existsSync, writeFileSync} from "node:fs";
const skill = existsSync(".claude/skills/pdf/SKILL.md");
appendFileSync(${JSON.stringify(join(root, "runs.log"))}, (skill ? "with" : "without") + (existsSync("AGENTS.md") ? "+agents" : "") + "\\n");
if (skill) writeFileSync("sum.js", "module.exports = (a, b) => a + b;\\n");
`,
  );
  const h = join(root, "harness");
  mkdirSync(join(h, ".claude/skills/pdf"), { recursive: true });
  writeFileSync(join(h, ".claude/skills/pdf/SKILL.md"), "fix the sum\n");
  writeFileSync(join(h, ".claude/skills/pdf/forms.md"), "forms\n");
  writeFileSync(join(h, "AGENTS.md"), "be brief\n");
  writeFileSync(join(h, "harness.toml"), `name = "base"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs")])}\ninclude = [".claude/**", "AGENTS.md"]\n`);
  const snap = cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
  assert.equal(snap.status, 0, snap.stdout + snap.stderr);
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("compare --without", () => {
  it("runs A and A-without-the-skill on every task and reports the skill's effect", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["compare", "base", "--without", ".claude/skills/pdf", "-t", "sum", "--k", "2", "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const { report } = JSON.parse(r.stdout) as { report: { baseline: { passes: number; runs: number }; candidate: { passes: number; runs: number; name: string }; ablation: { paths: string[]; dropped: string[]; unmatched: string[]; effect: { mean: number } }; anatomy?: unknown } };
    assert.deepEqual(report.ablation.paths, [".claude/skills/pdf"]);
    assert.deepEqual(report.ablation.dropped, [".claude/skills/pdf/SKILL.md", ".claude/skills/pdf/forms.md"]);
    assert.deepEqual(report.ablation.unmatched, []);
    assert.equal(report.ablation.effect.mean, 1);
    assert.deepEqual([report.baseline.passes, report.baseline.runs, report.candidate.passes, report.candidate.runs], [2, 2, 0, 2]);
    assert.equal(report.candidate.name, "base-without-claude-skills-pdf");
    assert.ok(report.anatomy, "k=2 carries the failure anatomy");
    const log = readFileSync(join(root, "runs.log"), "utf8").trim().split("\n").sort();
    assert.deepEqual(log, ["with+agents", "with+agents", "without+agents", "without+agents"], "both arms ran on every attempt; AGENTS.md kept");

    // A second run finds the stored ablation instead of adding another bundle.
    const text = cli(["compare", "base", "--without", ".claude/skills/pdf/", "-t", "sum", "--yes"]);
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /^A = base · B = base without \.claude\/skills\/pdf \(2 files dropped\)$/m);
    assert.match(text.stdout, /^effect of \.claude\/skills\/pdf = A − B: \+100\.0 pp/m);
    const list = JSON.parse(cli(["harness", "list", "--json"]).stdout) as { bundles: { name: string }[] };
    assert.deepEqual(list.bundles.map((b) => b.name).sort(), ["base", "base-without-claude-skills-pdf"]);
  });

  it("--gate: keep the skill (exit 1), the --experiment path gives the same gate, a lenient gate accepts (exit 0)", (t) => {
    if (!gitBin) return t.skip("needs git");
    const live = cli(["compare", "base", "--without", ".claude/skills/pdf", "-t", "sum", "--yes", "--gate", "--json"]);
    assert.equal(live.status, 1, live.stdout + live.stderr);
    const { experimentId, report } = JSON.parse(live.stdout) as { experimentId: string; report: { gate: { decision: string; verdict: string; lost: string[]; losses: number; solved: number } } };
    assert.deepEqual([report.gate.decision, report.gate.verdict, report.gate.losses, report.gate.solved], ["abstain", "dont-ship", 1, 1]);
    assert.equal(report.gate.lost.length, 1);

    const again = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--gate", "--json"]);
    assert.equal(again.status, 1, again.stdout + again.stderr);
    assert.deepEqual((JSON.parse(again.stdout) as { report: { gate: unknown } }).report.gate, report.gate);

    const text = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--gate"]);
    assert.equal(text.status, 1);
    assert.match(text.stdout, /^drop-it gate: Keep it: dropping \.claude\/skills\/pdf breaks 1 task A solved$/m);

    // Arms swapped (B = base, which keeps the skill) with a lenient gate: one win is enough.
    const swapped = cli(["compare", "base-without-claude-skills-pdf", "base", "--experiment", experimentId, "--gate", "--lambda", "1", "--gate-alpha", "1", "--tau", "1"]);
    assert.equal(swapped.status, 0, swapped.stdout + swapped.stderr);
    assert.match(swapped.stdout, /^gate: Ship it: B wins 1 task, loses 0$/m);

    // No --gate: no gate key, exit 0.
    const plain = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--json"]);
    assert.equal(plain.status, 0);
    assert.equal("gate" in (JSON.parse(plain.stdout) as { report: object }).report, false);
  });

  it("--gate --by <tag-prefix>: per-suite gate on --experiment re-analysis; bad --by is a usage error before any run (AB-2)", (t) => {
    if (!gitBin) return t.skip("needs git");
    const live = cli(["compare", "base", "--without", ".claude/skills/pdf", "-t", "sum", "--yes", "--gate", "--json"]);
    assert.equal(live.status, 1, live.stdout + live.stderr);
    const { experimentId } = JSON.parse(live.stdout) as { experimentId: string };

    const by = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--gate", "--by", "suite:", "--json"]);
    assert.equal(by.status, 1, by.stdout + by.stderr);
    const gate = (JSON.parse(by.stdout) as { report: { gate: { verdict: string; reasons: string[]; blockedBy: string[]; strata: { group: string; tasks: number; lost: string[]; gate: { verdict: string } }[] } } }).report.gate;
    assert.deepEqual(gate.blockedBy, ["suite:sum"]);
    assert.ok(gate.reasons.includes("stratum-regression"));
    assert.deepEqual(
      gate.strata.map((s) => [s.group, s.tasks, s.lost.length, s.gate.verdict]),
      [["suite:sum", 1, 1, "dont-ship"]],
    );
    const text = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--gate", "--by", "suite:"]);
    assert.match(text.stdout, /^drop-it gate: Keep it: dropping \.claude\/skills\/pdf breaks 1 of 1 suite:sum task A solved$/m);
    assert.match(text.stdout, /^ {14}suite:sum {2}Don't ship: B breaks 1 task A solved$/m);

    // Swapped arms with a lenient gate: the suite ships too, exit 0.
    const swapped = cli(["compare", "base-without-claude-skills-pdf", "base", "--experiment", experimentId, "--gate", "--lambda", "1", "--gate-alpha", "1", "--tau", "1", "--by", "suite:"]);
    assert.equal(swapped.status, 0, swapped.stdout + swapped.stderr);
    assert.match(swapped.stdout, /^ {6}suite:sum {2}Ship it: B wins 1 task, loses 0$/m);

    const runs = () => readFileSync(join(root, "runs.log"), "utf8").split("\n").length;
    const before = runs();
    const noGate = cli(["compare", "base", "--without", ".claude/skills/pdf", "-t", "sum", "--yes", "--by", "suite:"]);
    assert.equal(noGate.status, 2, noGate.stdout + noGate.stderr);
    assert.match(noGate.stderr, /--by needs --gate/);
    const unknown = cli(["compare", "base", "--without", ".claude/skills/pdf", "-t", "sum", "--yes", "--gate", "--by", "lang:"]);
    assert.equal(unknown.status, 2, unknown.stdout + unknown.stderr);
    assert.match(unknown.stderr, /--by lang:: no task has a tag starting with it; prefixes seen: agent:, from-session, suite:/);
    const reanalysis = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--gate", "--by", "lang:"]);
    assert.equal(reanalysis.status, 2);
    assert.equal(runs(), before, "no agent ran");
  });

  it("--promote without cost or tokens: exit 1, a warning, no report.pareto, the reason in notes (AA-18)", (t) => {
    if (!gitBin) return t.skip("needs git");
    const live = cli(["compare", "base", "--without", ".claude/skills/pdf", "-t", "sum", "--yes", "--promote", "--eps-c", "inf", "--json"]);
    assert.equal(live.status, 1, live.stdout + live.stderr);
    const { experimentId, report } = JSON.parse(live.stdout) as { experimentId: string; report: { pareto?: unknown; notes: string[] } };
    assert.equal(report.pareto, undefined);
    assert.ok(report.notes.includes("pareto gate needs cost or tokens on >=80% of runs per arm"));
    const text = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--promote"]);
    assert.equal(text.status, 1);
    assert.match(text.stderr, /--promote: pareto gate needs cost or tokens on >=80% of runs per arm, so nothing is promoted/);
    // Without --promote the same runs exit 0 and carry no note.
    const plain = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--json"]);
    assert.equal(plain.status, 0);
    assert.ok(!(JSON.parse(plain.stdout) as { report: { notes: string[] } }).report.notes.some((n) => n.startsWith("pareto")));
  });

  it("one-item gate: shown for a dropped skill, RERUN without traces, --item-gate exits 1, --no-item-gate hides it (AA-2)", (t) => {
    if (!gitBin) return t.skip("needs git");
    const live = cli(["compare", "base", "--without", ".claude/skills/pdf", "-t", "sum", "--yes", "--json"]);
    assert.equal(live.status, 0, live.stdout + live.stderr);
    const { experimentId, report } = JSON.parse(live.stdout) as {
      experimentId: string;
      report: { itemGate: { verdict: string; mode: string; item: { path: string; kind: string }; reasons: string[]; f: { rollouts: number } } };
    };
    const g = report.itemGate;
    assert.deepEqual([g.verdict, g.mode, g.item.path, g.item.kind], ["RERUN", "remove", ".claude/skills/pdf/SKILL.md", "skill"]);
    assert.ok(g.reasons.some((r) => r.startsWith("exposure unknown on 1 of 1 baseline rollouts")), g.reasons.join("; "));

    const text = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId]);
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /^item gate k=1 τ=\.34 m=2: RERUN · G=0 net 0 runs D=0 fired 0\/1 · S=0 tasks$/m);
    assert.match(text.stdout, /^ {10}B removes skill \.claude\/skills\/pdf\/SKILL\.md$/m);

    const forced = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--item-gate"]);
    assert.equal(forced.status, 1, forced.stdout + forced.stderr);

    const hidden = cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--no-item-gate", "--json"]);
    assert.equal(hidden.status, 0);
    assert.equal("itemGate" in (JSON.parse(hidden.stdout) as { report: object }).report, false);
    assert.doesNotMatch(cli(["compare", "base", "--without", ".claude/skills/pdf", "--experiment", experimentId, "--no-item-gate"]).stdout, /item gate/);

    // Not an instruction item: no gate, and --item-gate is a usage error before any run.
    const notItem = cli(["compare", "base", "--without", "test.js", "-t", "sum", "--yes", "--item-gate"]);
    assert.equal(notItem.status, 2, notItem.stdout + notItem.stderr);
    assert.match(notItem.stderr, /--item-gate needs B to add or remove exactly one rule, skill or context file/);
  });

  it("--gamma, --eps-q, --eps-c and --draws need --promote; bad values are usage errors before any run", (t) => {
    if (!gitBin) return t.skip("needs git");
    for (const args of [["--gamma", "0.8"], ["--eps-q", "0"], ["--eps-c", "inf"], ["--draws", "500"], ["--promote", "--gamma", "0"], ["--promote", "--eps-c", "x"], ["--promote", "--draws", "5"]]) {
      const r = cli(["compare", "base", "--without", ".claude/skills/pdf", "-t", "sum", "--yes", ...args]);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    }
  });

  it("--lambda, --gate-alpha and --tau need --gate; bad values are usage errors before any run", (t) => {
    if (!gitBin) return t.skip("needs git");
    for (const args of [["--lambda", "1"], ["--gate-alpha", "0.1"], ["--tau", "0"], ["--gate", "--lambda", "0.5"], ["--gate", "--gate-alpha", "0"], ["--gate", "--tau", "2"]]) {
      const r = cli(["compare", "base", "--without", ".claude/skills/pdf", "-t", "sum", "--yes", ...args]);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    }
  });

  it("warns on a path only in the task repo; refuses one that is nowhere, and a second bundle", (t) => {
    if (!gitBin) return t.skip("needs git");
    const repoOnly = cli(["compare", "base", "--without", "test.js", "-t", "sum", "--yes"]);
    assert.equal(repoOnly.status, 0, repoOnly.stdout + repoOnly.stderr);
    assert.match(repoOnly.stderr, /--without test\.js: not in bundle base; it is only removed from each task's repo/);

    const nowhere = cli(["compare", "base", "--without", "nope.md", "-t", "sum", "--yes", "--json"]);
    assert.equal(nowhere.status, 2, nowhere.stdout + nowhere.stderr);
    assert.match(nowhere.stderr, /nothing to ablate/);

    const two = cli(["compare", "base", "base", "--without", "AGENTS.md", "--json"]);
    assert.equal(two.status, 2, two.stdout + two.stderr);
    const one = cli(["compare", "base", "--json"]);
    assert.equal(one.status, 2, one.stdout + one.stderr);
  });
});
