// `coding.sh refine test --suite … --canary-model` and `refine recheck` (Z-14),
// end to end through src/cli/main.ts with a temp HOME. The agent is the
// "wrapper" agent with a {model} slot: under the loop's model (none) it only
// needs the ESSENTIAL line; under the canary model "small" it also needs the
// RE-READ line, so a cut that drops RE-READ passes the loop and fails the canary.
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
const ESSENTIAL = "ESSENTIAL: write done.txt when you finish.";
const REREAD = "RE-READ: read the task twice.";
const BLOAT = Array.from({ length: 20 }, (_, i) => `- Style note ${i}: prefer clear names and small modules.`).join("\n");
const BASE_MD = `# Project\n${ESSENTIAL}\n${REREAD}\n\n## Style\n${BLOAT}\n`;
const CUT_MD = `# Project\n${ESSENTIAL}\n`;
const TASKS = 5;

let root = "";
let home = "";
let repo = "";
let env: Record<string, string> = {};

function cli(args: string[], cwd = repo) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 300_000 });
}

function draft(name: string, text: string): string {
  const d = join(root, "drafts", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "CLAUDE.md"), text);
  return `../drafts/${name}/CLAUDE.md`;
}

function snapshot(name: string, flags: string[]): void {
  const h = join(root, `harness-${name}`);
  mkdirSync(join(h, ".claude"), { recursive: true });
  writeFileSync(join(h, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(h, "harness.toml"), `name = "${name}"\nagent = "wrapper"\nflags = ${JSON.stringify(flags)}\ninclude = [".claude/**"]\n`);
  const snap = cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
  assert.equal(snap.status, 0, snap.stdout + snap.stderr);
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-canary-")));
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
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const model = (process.argv.find((a) => a.startsWith("--model=")) ?? "").slice(8);
const md = existsSync("CLAUDE.md") ? readFileSync("CLAUDE.md", "utf8") : "";
if (md.includes("ESSENTIAL:") && (model !== "small" || md.includes("RE-READ:"))) writeFileSync("done.txt", "ok\\n");
console.log(JSON.stringify({ type: "result", result: "Done." }));
`,
  );
  snapshot("fake", [process.execPath, join(root, "agent.mjs"), "--model={model}"]);
  snapshot("nomodel", [process.execPath, join(root, "agent.mjs")]);

  const git = (...a: string[]) => assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  writeFileSync(join(repo, "CLAUDE.md"), BASE_MD);
  const suite = join(repo, "evals", "chores");
  mkdirSync(suite, { recursive: true });
  writeFileSync(join(suite, "suite.json"), JSON.stringify({ name: "chores", purpose: "regression", trials: 1, tasks: "tasks", harness: "fake" }));
  const verifier = `"${process.execPath}" check.mjs`;
  for (let i = 0; i < TASKS; i++) {
    const t = join(suite, "tasks", `chore-${i}`);
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, "task.json"), JSON.stringify({ name: `chore-${i}`, verifier: { command: verifier, timeoutMs: 60_000 } }));
    writeFileSync(join(t, "instruction.md"), `Do chore ${i}.\n`);
    mkdirSync(join(t, "tests"));
    writeFileSync(join(t, "tests", "check.mjs"), `import { existsSync } from "node:fs";\nprocess.exit(existsSync("done.txt") ? 0 : 1);\n`);
  }
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface Round {
  id: string;
  verdict: string;
  stage: string;
  reasons: string[];
  suite: { base: string; cand: string; experiment: string };
  canary?: { model: string; verdict: string; experiment: string; base: string; cand: string; hardRegressions?: string[] };
}

const ledgerDir = () => join(home, ".coding.sh");

describe("refine --suite --canary-model", () => {
  it("dry-run prints the canary plan and starts no agent", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["refine", "test", draft("cut", CUT_MD), "--suite", "chores", "--objective", "size", "--canary-model", "small", "--dry-run", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const plan = JSON.parse(r.stdout) as { sessions: number; canary: { policy: string; model: string; sessions: number }; candidates: { removed: number }[] };
    assert.deepEqual(plan.canary, { policy: "subtractive", model: "small", sessions: TASKS * 2 });
    assert.equal(plan.candidates[0]!.removed, 22, "RE-READ, the Style heading and 20 notes");
    const text = cli(["refine", "test", draft("cut", CUT_MD), "--suite", "chores", "--objective", "size", "--canary-model", "small", "--dry-run"]);
    assert.match(text.stdout, /Canary: a kept candidate that removes lines runs again under small, up to 10 agent sessions/);
    const log = JSON.parse(cli(["refine", "log", "--json"]).stdout) as { entries: unknown[] };
    assert.equal(log.entries.length, 0, "nothing ran or was ledgered");
  });

  it("refuses a canary model the agent can't take, before any run", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["refine", "test", draft("cut", CUT_MD), "--suite", "chores", "--harness", "nomodel", "--objective", "size", "--canary-model", "small", "--yes", "--json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no \{model\} slot/);
  });

  it("rejects a cut that passes the loop but fails a 1/1 baseline task under the canary, then recheck records it", (t) => {
    if (!gitBin) return t.skip("needs git");
    const r = cli(["refine", "test", draft("cut", CUT_MD), "--suite", "chores", "--objective", "size", "--canary-model", "small", "--yes", "--json"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const round = (JSON.parse(r.stdout) as { rounds: Round[] }).rounds[0]!;
    assert.equal(round.verdict, "reject", round.reasons.join("\n"));
    assert.equal(round.stage, "canary");
    assert.match(round.reasons.at(-1)!, /^canary-regression: small: hard regression on chore-0, chore-1, chore-2, chore-3, chore-4/);
    assert.equal(round.canary?.verdict, "regression");
    assert.notEqual(round.canary!.experiment, round.suite.experiment);
    assert.notEqual(round.canary!.base, round.suite.base);
    assert.notEqual(round.canary!.cand, round.suite.cand);
    assert.equal(readFileSync(join(repo, "CLAUDE.md"), "utf8"), BASE_MD, "nothing applied");

    const k = cli(["refine", "recheck", round.id, "--model", "small", "--yes", "--json"]);
    assert.equal(k.status, 1, k.stdout + k.stderr);
    const doc = JSON.parse(k.stdout) as { recheck: { op: string; candidate: string; applied: boolean; canary: { verdict: string; reason: string } } };
    assert.equal(doc.recheck.op, "recheck");
    assert.equal(doc.recheck.candidate, round.id);
    assert.equal(doc.recheck.canary.verdict, "regression");
    assert.equal(doc.recheck.applied, false);
    const log = JSON.parse(cli(["refine", "log", "--json"]).stdout) as { entries: { op: string }[] };
    assert.deepEqual(log.entries.map((e) => e.op), ["test", "recheck"]);
    assert.match(cli(["refine", "log"]).stdout, new RegExp(`Recheck ${round.id} under small .*canary-regression: small`));
    assert.ok(existsSync(ledgerDir()));
  });
});
