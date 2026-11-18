// `coding.sh refine test|run|log --suite`: a harness edit judged on an eval
// suite of repo tasks, end to end through the CLI with a temp HOME.
//
// The agent is the "wrapper" agent from a harness bundle: a node script that
// reads the CLAUDE.md it was given, starts one bare node process per 200 bytes
// of it (a bloated file is slow), and writes done.txt only when the file still
// has the ESSENTIAL line. Process starts rather than a sleep: the rest of each
// run is made of them too (the agent, the verifier, git), so a busy machine
// stretches the gap between the arms along with the noise around it. Each
// task's verifier passes when done.txt exists. The wrapper reports no usage,
// so these tests climb on wall time and harness size; cost and tokens from a
// real agent are covered by scripts/e2e/refine-suite-capture.mjs.
//
// A run's wall time is the machine's clock, and one stalled run on a busy
// machine is enough to take a "faster" verdict away. So the runs through the
// CLI prove that every run's time reaches the judge, and "faster" is judged on
// runs with fixed clocks ("wall time from the runs' own clocks" below).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { which } from "../../src/adapters/_shared/detect.ts";
import { taskPairs } from "../../src/cli/commands/refine-suite.ts";
import type { EvalTask, RunResult } from "../../src/core/types.ts";
import { armPoint, climbFront, DEFAULT_MARGIN, DEFAULT_MIN_GAIN, judgeObjectives } from "../../src/refine/objectives.ts";
import { posixShell } from "../../src/core/spawn.ts";
import { pathOf } from "../_bin.ts";
import { CLI } from "../_cli.ts";

const gitBin = which("git") ?? "";
const ESSENTIAL = "ESSENTIAL: write done.txt when you finish.";
const SAFETY = "Never run `git push --force`.";
const BLOAT = Array.from({ length: 40 }, (_, i) => `- Style note ${i}: prefer clear names, short functions and small modules over clever code.`).join("\n");
const BLOATED = `# Project\n${ESSENTIAL}\n${SAFETY}\n\n## Style\n${BLOAT}\n`;
const TRIMMED = `# Project\n${ESSENTIAL}\n${SAFETY}\n`;
const BROKEN = `# Project\n${SAFETY}\n`;
const TASKS = 6;

let root = "";
let home = "";
let repo = "";
let env: Record<string, string> = {};

function cli(args: string[], cwd = repo) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 300_000 });
}

/** An edited CLAUDE.md outside the repo. */
function draft(name: string, text: string): string {
  const d = join(root, "drafts", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "CLAUDE.md"), text);
  return `../drafts/${name}/CLAUDE.md`;
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-suite-")));
  home = join(root, "home");
  repo = join(root, "repo");
  for (const d of [home, repo, join(root, "tmp")]) mkdirSync(d);
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
  if (!gitBin) return;
  writeFileSync(
    join(root, "agent.mjs"),
    `import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const md = existsSync("CLAUDE.md") ? readFileSync("CLAUDE.md", "utf8") : "";
const slow = !process.argv.includes("--size-only");
for (let i = 0; slow && i < Math.floor(Buffer.byteLength(md) / 200); i++) spawnSync(process.execPath, ["-e", ""]);
if (md.includes("ESSENTIAL:")) writeFileSync("done.txt", "ok\\n");
console.log(JSON.stringify({ type: "result", result: "Done." }));
`,
  );
  const h = join(root, "harness");
  mkdirSync(join(h, ".claude"), { recursive: true });
  writeFileSync(join(h, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(h, "harness.toml"), `name = "fake"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs")])}\ninclude = [".claude/**"]\n`);
  const snap = cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
  assert.equal(snap.status, 0, snap.stdout + snap.stderr);
  // The same agent without the process starts, for a climb on size alone, where wall time is not judged.
  const q = join(root, "size-harness");
  mkdirSync(join(q, ".claude"), { recursive: true });
  writeFileSync(join(q, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(q, "harness.toml"), `name = "fake-size"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs"), "--size-only"])}\ninclude = [".claude/**"]\n`);
  const qsnap = cli(["harness", "snapshot", "--file", join(q, "harness.toml"), "--json"]);
  assert.equal(qsnap.status, 0, qsnap.stdout + qsnap.stderr);

  const git = (...a: string[]) => assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  writeFileSync(join(repo, "CLAUDE.md"), BLOATED);
  const suite = join(repo, "evals", "chores");
  mkdirSync(suite, { recursive: true });
  writeFileSync(join(suite, "suite.json"), JSON.stringify({ name: "chores", purpose: "regression", trials: 2, tasks: "tasks", harness: "fake" }));
  // The check ships in the task's tests/ (hidden from the agent), so done.txt is the output it reads, not a file the verifier owns.
  const verifier = `"${process.execPath}" check.mjs`;
  for (let i = 0; i < TASKS; i++) {
    const t = join(suite, "tasks", `chore-${i}`);
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, "task.json"), JSON.stringify({ name: `chore-${i}`, verifier: { command: verifier, timeoutMs: 60_000 } }));
    writeFileSync(join(t, "instruction.md"), `Do chore ${i}.\n`);
    mkdirSync(join(t, "tests"));
    writeFileSync(join(t, "tests", "check.mjs"), `import { existsSync } from "node:fs";\nprocess.exit(existsSync("done.txt") ? 0 : 1);\n`);
  }
  mkdirSync(join(repo, ".claude", "skills", "pdf"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Read PDF files\n---\nUse pdftotext.\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface ClimbDoc {
  rounds: { id: string; verdict: string; reasons: string[]; objectives: { branch?: string; metrics: { objective: string; n: number; coverage: { base: number; cand: number } }[]; arms: { base: { pass: number; size: number; wall: number }; cand: { pass: number; size: number; wall: number } }; quality: { regressions: string[] } } }[];
  applied: string[];
  stopped: string;
  climb: { front: { objective: string; points: { id: string }[] }; plateau: { status: string } };
}

describe("refine --suite: flags", () => {
  it("refuses climb flags without a suite, and a suite that is not repo tasks", () => {
    const r = cli(["refine", "run", "--objective", "cost"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--objective needs --suite <name>/);
    const trig = join(repo, "..", "trig");
    mkdirSync(join(trig, "evals", "pdf"), { recursive: true });
    writeFileSync(join(trig, "evals", "pdf", "suite.json"), JSON.stringify({ name: "pdf", purpose: "regression", kind: "triggers", triggers: "triggers.toml", skill: ".claude/skills/pdf" }));
    writeFileSync(join(trig, "evals", "pdf", "triggers.toml"), '[[case]]\nprompt = "read this pdf"\nexpect = "load"\n');
    const t = cli(["refine", "run", "--suite", "pdf", "--yes"], trig);
    assert.notEqual(t.status, 0);
    assert.match(t.stderr, /is a triggers suite: a trigger suite checks whether the skill loads/);
  });

  it("dry-run shows the plan and makes no runs", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["refine", "run", "--suite", "chores", "--objective", "wall,size", "--margin", "2pp", "--until-plateau", "--dry-run", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const plan = JSON.parse(r.stdout) as { suite: string; tasks: number; k: number; sessionsPerRound: number; rounds: null; mode: string; target: string; margin: number; drivers: string[]; plateau: string };
    assert.deepEqual([plan.suite, plan.tasks, plan.k, plan.sessionsPerRound, plan.rounds, plan.mode, plan.target, plan.margin, plan.plateau], ["chores", TASKS, 2, TASKS * 4, null, "cut", "CLAUDE.md", 0.02, "insufficient"]);
    assert.match(plan.drivers.join("\n"), /CLAUDE\.md is \d+ bytes .* Largest sections: ## Style/);
    const text = cli(["refine", "run", "--suite", "chores", "--objective", "wall", "--dry-run"]);
    assert.match(text.stdout, /Until|Up to 3 rounds: cut CLAUDE\.md/);
    assert.equal(cli(["refine", "run", "--suite", "chores", "--objective", "wall"]).stderr.includes("needs confirmation from the user"), true, "a climb runs agents, so it asks first");
  });
});

describe("refine run --suite", () => {
  it("asks the proposer for a cut, shows it the file's largest sections and its protected lines, and keeps the cut", (t) => {
    if (!gitBin) return t.skip("needs git");
    // The proposer: saves the prompt it was given and cuts the first half of the style notes.
    const half = BLOAT.split("\n").slice(0, 20).join("\n") + "\n";
    writeFileSync(
      join(root, "proposer.mjs"),
      `import { writeFileSync } from "node:fs";
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  writeFileSync(${JSON.stringify(join(root, "prompt.txt"))}, s);
  console.log(JSON.stringify({ edits: [{ find: ${JSON.stringify(half)}, replace: "" }], rationale: "the style notes repeat each other" }));
});
`,
    );
    const cmd = `"${process.execPath}" "${join(root, "proposer.mjs")}"`;
    const r = cli(["refine", "run", "--suite", "chores", "--harness", "fake-size", "--objective", "size", "--rounds", "1", "--proposer-command", cmd, "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const doc = JSON.parse(r.stdout) as ClimbDoc;
    assert.equal(doc.rounds[0]!.verdict, "keep", doc.rounds[0]!.reasons.join("\n"));
    assert.equal(doc.stopped, "rounds");
    const prompt = readFileSync(join(root, "prompt.txt"), "utf8");
    assert.match(prompt, /Goal: lower harness size/);
    assert.match(prompt, /Largest sections: ## Style/);
    assert.match(prompt, /READ-ONLY[\s\S]*git push --force/);
    const now = readFileSync(join(repo, "CLAUDE.md"), "utf8");
    assert.ok(!now.includes("Style note 0:") && now.includes("Style note 20:") && now.includes(ESSENTIAL), "the cut is applied");
  });

  it("keeps a trimmed CLAUDE.md that is faster and smaller at equal pass rate, then rejects a cut that drops a line the tasks need", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["refine", "run", "--suite", "chores", "--objective", "wall,size", "--candidate", draft("trim", TRIMMED), "--candidate", draft("broken", BROKEN), "--until-plateau", "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const doc = JSON.parse(r.stdout) as ClimbDoc;
    assert.equal(doc.rounds.length, 2);
    const [kept, rejected] = doc.rounds as [ClimbDoc["rounds"][0], ClimbDoc["rounds"][0]];
    assert.equal(kept.verdict, "keep", kept.reasons.join("\n"));
    assert.equal(kept.objectives.branch, "efficiency");
    const wall = kept.objectives.metrics.find((m) => m.objective === "wall")!;
    assert.match(kept.reasons[0]!, /harness size −?-?\d+% with quality held: pass rate 100% → 100%/);
    assert.deepEqual([kept.objectives.arms.base.pass, kept.objectives.arms.cand.pass], [1, 1]);
    assert.ok(kept.objectives.arms.cand.size < kept.objectives.arms.base.size / 3);
    // Every run of both arms was timed and paired by task: the judge had a wall time for all of them.
    assert.ok(kept.objectives.arms.base.wall > 0 && kept.objectives.arms.cand.wall > 0);
    assert.deepEqual([wall.n, wall.coverage], [TASKS, { base: 1, cand: 1 }]);
    assert.deepEqual(doc.applied, [kept.id]);

    assert.equal(rejected.verdict, "reject", rejected.reasons.join("\n"));
    assert.equal(rejected.objectives.arms.cand.pass, 0);
    assert.equal(rejected.objectives.quality.regressions.length, TASKS);
    assert.match(rejected.reasons[0]!, /hard regression/);
    assert.equal(doc.stopped, "candidates");
    assert.equal(readFileSync(join(repo, "CLAUDE.md"), "utf8"), TRIMMED, "only the kept edit is applied");
    assert.equal(doc.climb.front.objective, "wall");
    assert.ok(doc.climb.front.points.length > 0 && doc.climb.front.points.every((p) => ["base", kept.id, rejected.id].includes(p.id)), "the front is made of the versions that ran");
    assert.equal(existsSync(join(home, ".claude")), false, "no real agent config is touched");

    const log = cli(["refine", "log"]);
    assert.equal(log.status, 0, log.stderr);
    assert.match(log.stdout, /chores/);
    assert.match(log.stdout, /ROUND\s+CANDIDATE\s+VERDICT\s+PASS\s+COST\/RUN\s+WALL\/RUN\s+SIZE/);
    assert.match(log.stdout, new RegExp(`${kept.id}\\s+keep \\(efficiency\\), applied`));
    assert.match(log.stdout, new RegExp(`${rejected.id}\\s+reject`));
    assert.match(log.stdout, /Pareto front/);
    const logJson = JSON.parse(cli(["refine", "log", "--json"]).stdout) as { climbs: { suite: string; primary: string; rounds: unknown[] }[] };
    assert.deepEqual(logJson.climbs.map((x) => [x.suite, x.primary, x.rounds.length]), [["chores", "size", 1], ["chores", "wall", 2]], "one climb per suite, primary objective and target");
  });

  it("refine test rejects a candidate that deletes a safety rule before any run", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["refine", "test", draft("unsafe", `# Project\n${ESSENTIAL}\n`), "--suite", "chores", "--objective", "wall", "--yes", "--json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const doc = JSON.parse(r.stdout) as { rounds: { verdict: string; stage: string; reasons: string[]; objectives?: unknown }[] };
    assert.equal(doc.rounds[0]!.verdict, "reject");
    assert.equal(doc.rounds[0]!.objectives, undefined, "no agent ran");
    assert.match(doc.rounds[0]!.reasons.join("\n"), /git push --force/);
  });

  it("--resume without an unfinished round says so", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["refine", "run", "--suite", "chores", "--objective", "wall", "--resume", "--yes"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /No unfinished refine round to resume/);
  });
});

// The same six tasks and two trials per arm as above, with each run's start and end written here.
describe("refine --suite: wall time from the runs' own clocks", () => {
  const tasks = Array.from({ length: TASKS }, (_, i) => ({ id: `task_${i}`, name: `chore-${i}` }) as EvalTask);
  const sizes = { base: Buffer.byteLength(BLOATED), cand: Buffer.byteLength(TRIMMED) };
  /** One passing run that took `ms`. */
  const run = (task: number, bundleId: string, trial: number, ms: number): RunResult => ({
    id: `run_${bundleId}_${task}_${trial}`,
    taskId: `task_${task}`,
    bundleId,
    attempt: 1,
    pass: true,
    verifierExit: 0,
    agent: { exitCode: 0, timedOut: false, durationMs: ms, stdoutTail: "", stderrTail: "" },
    startedAt: 1_700_000_000_000 + task * 10_000,
    endedAt: 1_700_000_000_000 + task * 10_000 + ms,
  });
  /** The verdict on runs that took `base(task, trial)` and `cand(task, trial)` ms. */
  function judge(base: (task: number, trial: number) => number, cand: (task: number, trial: number) => number) {
    const runs = tasks.flatMap((_, i) => [0, 1].flatMap((k) => [run(i, "A", k, base(i, k)), run(i, "B", k, cand(i, k))]));
    const pairs = taskPairs(tasks, "A", "B", runs, new Map());
    const d = judgeObjectives(pairs, { objectives: ["wall", "size"], margin: DEFAULT_MARGIN, minGain: DEFAULT_MIN_GAIN, alpha: 0.05, size: sizes });
    return { d, base: armPoint(pairs, "base", sizes.base), cand: armPoint(pairs, "cand", sizes.cand) };
  }
  // The bloated file's process starts add about a second to a run of about one second.
  const slow = (task: number, trial: number) => 2000 + task * 40 + trial * 90;
  const fast = (task: number, trial: number) => 1000 + task * 30 + trial * 60;

  it("a candidate that is faster on every task is kept for its wall time first, then its size", () => {
    const { d, base, cand } = judge(slow, fast);
    assert.equal(d.verdict, "keep", d.reasons.join("\n"));
    assert.equal(d.branch, "efficiency");
    assert.match(d.reasons[0]!, /^wall time \/ run −?-?\d+%.*; harness size −?-?\d+% with quality held/);
    assert.deepEqual([base.wall, cand.wall], [2145, 1105], "the mean of the runs' end minus start");
    // Same pass rate in less time: the candidate is on the front and the base it replaced is not.
    assert.deepEqual(climbFront([{ id: "trim", round: 1, base, cand, kept: true, gains: d.gains }], "wall").front.map((p) => p.id), ["trim"]);
  });

  it("one stalled candidate run takes the wall-time reason away, and the smaller file is still kept", () => {
    // What a busy runner did to this suite on CI: one run of the faster arm waited 9 s on the machine.
    const { d } = judge(slow, (task, trial) => fast(task, trial) + (task === 3 && trial === 1 ? 9000 : 0));
    assert.equal(d.verdict, "keep", d.reasons.join("\n"));
    assert.equal(d.branch, "efficiency");
    assert.match(d.reasons[0]!, /^harness size −?-?\d+% with quality held/);
  });
});

// DF-1: an expired login fails every trial the same way. The round is no verdict, the climb stops and says why.
describe("refine --suite: a logged-out agent", () => {
  it("stops the round after 5 trials in a row fail on the login, writes no verdict, and says so", (t) => {
    if (!gitBin) return t.skip("needs git");
    const pids = join(root, "dead.pids");
    writeFileSync(join(root, "dead.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");\nprocess.stderr.write("Invalid API key · Please run /login\\n");\nprocess.exit(1);\n`);
    const h = join(root, "dead-harness");
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(join(h, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(h, "harness.toml"), `name = "dead"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "dead.mjs")])}\ninclude = [".claude/**"]\n`);
    const snap = cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
    assert.equal(snap.status, 0, snap.stdout + snap.stderr);
    const rounds = () => ((JSON.parse(cli(["refine", "log", "--json"]).stdout) as { climbs?: { rounds: unknown[] }[] }).climbs ?? []).reduce((n, x) => n + x.rounds.length, 0);
    const before = rounds();
    const r = cli(["refine", "test", draft("dead-trim", `${TRIMMED}- Keep commits small.\n`), "--suite", "chores", "--harness", "dead", "--objective", "wall", "--concurrency", "1", "--yes", "--json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const doc = JSON.parse(r.stdout) as { rounds: unknown[]; stopped?: string; infraStop?: unknown; resume?: string };
    assert.equal(doc.stopped, "infra");
    assert.deepEqual(doc.infraStop, { after: 5, kinds: { auth: 5 } });
    assert.deepEqual(doc.rounds, [], "no keep or reject: the round has no outcome");
    assert.match(doc.resume ?? "", /--resume/);
    assert.equal(readFileSync(pids, "utf8").trim().split("\n").length, 5, `5 sessions of ${TASKS * 2 * 2}, none retried`);
    assert.equal(rounds(), before, "nothing written to the ledger");
  });
});
