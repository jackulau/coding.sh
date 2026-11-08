// `refine test|run --suite --reuse`: the climb copies the unchanged base arm's
// finished runs from an earlier round instead of running the agent again, so a
// multi-round climb spends fewer agent sessions. This is the deterministic
// measurement of the reuse win: a counting agent (one line per real
// invocation) lets the test count agent sessions with and without --reuse and
// assert the saving, while the verdicts stay identical and the round warns that
// the arms did not run interleaved (the drift caveat `compare --reuse` carries).
//
// The agent is the same bare "wrapper" node script refine-suite.test.ts uses,
// plus an appendFileSync to a counter file whose path is baked into the script.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { which } from "../../src/adapters/_shared/detect.ts";
import { posixShell } from "../../src/core/spawn.ts";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const gitBin = which("git") ?? "";
const ESSENTIAL = "ESSENTIAL: write done.txt when you finish.";
const BLOAT = Array.from({ length: 40 }, (_, i) => `- Style note ${i}: prefer clear names and short functions.`).join("\n");
const BLOATED = `# Project\n${ESSENTIAL}\n\n## Style\n${BLOAT}\n`;
const TASKS = 3;
const K = 2;
const PER_ARM = TASKS * K; // agent sessions one arm of one round runs when nothing is reused

let root = "";
let home = "";
let repo = "";
let counter = "";
let env: Record<string, string> = {};

function cli(args: string[], cwd = repo) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 300_000 });
}

/** Agent sessions run since the counter was last reset (one byte per real invocation). */
function agentRuns(): number {
  try {
    return statSync(counter).size;
  } catch {
    return 0;
  }
}
function resetCounter() {
  writeFileSync(counter, "");
}

/** An edited CLAUDE.md outside the repo (a cut: keeps ESSENTIAL, drops some style notes). */
function draft(name: string, keepNotes: number): string {
  const d = join(root, "drafts", name);
  mkdirSync(d, { recursive: true });
  const notes = BLOAT.split("\n").slice(0, keepNotes).join("\n");
  writeFileSync(join(d, "CLAUDE.md"), `# Project\n${ESSENTIAL}\n\n## Style\n${notes}\n`);
  return `../drafts/${name}/CLAUDE.md`;
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-reuse-")));
  home = join(root, "home");
  repo = join(root, "repo");
  counter = join(root, "agent-runs.log");
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
  // The counter path is baked in, so every real agent invocation records one byte, wherever it runs.
  writeFileSync(
    join(root, "agent.mjs"),
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(counter)}, "x");
const md = existsSync("CLAUDE.md") ? readFileSync("CLAUDE.md", "utf8") : "";
if (md.includes("ESSENTIAL:")) writeFileSync("done.txt", "ok\\n");
console.log(JSON.stringify({ type: "result", result: "Done." }));
`,
  );
  const h = join(root, "harness");
  mkdirSync(join(h, ".claude"), { recursive: true });
  writeFileSync(join(h, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(h, "harness.toml"), `name = "fake"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, join(root, "agent.mjs")])}\ninclude = [".claude/**"]\n`);
  assert.equal(cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]).status, 0);

  const git = (...a: string[]) => assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  writeFileSync(join(repo, "CLAUDE.md"), BLOATED);
  const suite = join(repo, "evals", "chores");
  mkdirSync(join(suite, "tasks"), { recursive: true });
  writeFileSync(join(suite, "suite.json"), JSON.stringify({ name: "chores", purpose: "regression", trials: K, tasks: "tasks", harness: "fake" }));
  const verifier = `"${process.execPath}" check.mjs`;
  for (let i = 0; i < TASKS; i++) {
    const t = join(suite, "tasks", `chore-${i}`);
    mkdirSync(join(t, "tests"), { recursive: true });
    writeFileSync(join(t, "task.json"), JSON.stringify({ name: `chore-${i}`, verifier: { command: verifier, timeoutMs: 60_000 } }));
    writeFileSync(join(t, "instruction.md"), `Do chore ${i}.\n`);
    writeFileSync(join(t, "tests", "check.mjs"), `import { existsSync } from "node:fs";\nprocess.exit(existsSync("done.txt") ? 0 : 1);\n`);
  }
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface Doc {
  rounds: { id: string; verdict: string; objectives?: { warnings: string[] } }[];
}

describe("refine test --suite --reuse", () => {
  it("dry-run reports the reuse mode and makes no runs", (t) => {
    if (!gitBin) return t.skip("needs git");
    resetCounter();
    const r = cli(["refine", "test", draft("a", 20), draft("b", 0), "--suite", "chores", "--objective", "wall,size", "--reuse", "baseline", "--dry-run", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((JSON.parse(r.stdout) as { reuse: string }).reuse, "baseline");
    assert.equal(agentRuns(), 0, "a dry run calls no agent");
  });

  it("rejects an unknown --reuse value", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["refine", "test", draft("a", 20), "--suite", "chores", "--reuse", "sometimes", "--yes"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--reuse must be one of baseline, both, none/);
  });

  it("--reuse-max-age needs --reuse", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["refine", "test", draft("a", 20), "--suite", "chores", "--reuse-max-age", "3d", "--yes"]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--reuse-max-age needs --reuse/);
  });

  it("copies the base arm across rounds: fewer agent sessions, same verdicts, and a drift warning", (t) => {
    if (!gitBin) return t.skip("needs git");
    const a = draft("trim-a", 20);
    const b = draft("trim-b", 0);
    const args = [a, b, "--suite", "chores", "--objective", "wall,size", "--margin", "5pp", "--yes", "--json"];

    // Baseline: no reuse. Each of the 2 candidates runs both arms fresh.
    resetCounter();
    const plain = cli(["refine", "test", ...args]);
    assert.equal(plain.status === 0 || plain.status === 1, true, plain.stdout + plain.stderr);
    const plainRuns = agentRuns();
    const plainDoc = JSON.parse(plain.stdout) as Doc;
    assert.equal(plainRuns, 4 * PER_ARM, "without reuse every arm of every candidate calls the agent");

    // Reuse the base: round 1 stores the base runs, round 2 copies them.
    resetCounter();
    const reuse = cli(["refine", "test", ...args, "--reuse", "baseline"]);
    assert.equal(reuse.status, plain.status, reuse.stdout + reuse.stderr);
    const reuseRuns = agentRuns();
    const reuseDoc = JSON.parse(reuse.stdout) as Doc;

    // Round 1 pays for both arms (nothing stored yet); round 2 copies the base, so only the candidate runs.
    assert.equal(reuseRuns, 3 * PER_ARM, "reuse skips the base arm of the second round");
    assert.ok(reuseRuns < plainRuns, `reuse should spend fewer agent sessions (${reuseRuns} vs ${plainRuns})`);
    const saved = plainRuns - reuseRuns;
    assert.equal(saved, PER_ARM, `saved one arm's worth of sessions (${saved})`);

    // The decision is unchanged: reuse copies identical runs, it does not change what is judged.
    assert.deepEqual(
      reuseDoc.rounds.map((r) => r.verdict),
      plainDoc.rounds.map((r) => r.verdict),
      "reuse keeps the same per-candidate verdicts",
    );

    // The second round reused the base, so it must carry the not-interleaved drift caveat.
    const second = reuseDoc.rounds[1]!;
    assert.ok(
      (second.objectives?.warnings ?? []).some((w) => /did not run interleaved/.test(w)),
      `the reused round warns about drift: ${JSON.stringify(second.objectives?.warnings)}`,
    );
    // The first round reused nothing, so it carries no such warning.
    assert.ok(!(reuseDoc.rounds[0]!.objectives?.warnings ?? []).some((w) => /did not run interleaved/.test(w)), "the first round did not reuse");
  });
});
