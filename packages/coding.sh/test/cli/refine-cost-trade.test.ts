// `refine test --suite --objective pass,cost`: a pass-rate gain beyond noise
// outranks a cost rise up to --max-cost-rise (default +50%), and the verdict
// prints the trade (DF-3: a skill climb threw away +27 to +67 pt gains
// because each run cost 2-7 cents more).
//
// The agent is a fake `claude` on PATH, driven through the claude-code adapter
// so its result line's total_cost_usd is the run's cost. It reads the CLAUDE.md
// it was given: "PASSES: n" passes n of every 3 trials of a task (each run
// claims the next slot of its task and file with an atomic mkdir, so the split
// holds at any concurrency), and "COST: x" is the cost per run, scaled per task.
// It exits as soon as it has printed its result.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { which } from "../../src/adapters/_shared/detect.ts";
import { posixShell } from "../../src/core/spawn.ts";
import { nodeBin, pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const gitBin = which("git") ?? "";
const TASKS = 6;
const K = 3;

let root = "";
let home = "";
let repo = "";
let env: Record<string, string> = {};

const md = (passes: number, cost: number) => `# Project\nPASSES: ${passes}\nCOST: ${cost}\n`;

function cli(args: string[]) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: repo, encoding: "utf8", timeout: 300_000 });
}

/** An edited CLAUDE.md outside the repo. */
function draft(name: string, text: string): string {
  const d = join(root, "drafts", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "CLAUDE.md"), text);
  return `../drafts/${name}/CLAUDE.md`;
}

const FAKE_CLAUDE = (slots: string) => `const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
if (process.argv.includes("--version")) {
  console.log("2.1.0 (Claude Code)");
  process.exit(0);
}
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const md = fs.existsSync("CLAUDE.md") ? fs.readFileSync("CLAUDE.md", "utf8") : "";
  const passes = Number((/PASSES: (\\d+)/.exec(md) || [])[1] || 0);
  const cost = Number((/COST: ([\\d.]+)/.exec(md) || [])[1] || 0);
  const task = Number((/chore (\\d+)/.exec(input) || [])[1] || 0);
  const key = crypto.createHash("sha256").update(md + "\\0" + input).digest("hex").slice(0, 16);
  let slot = 0;
  for (;;) {
    try {
      fs.mkdirSync(path.join(${JSON.stringify(slots)}, key + "-" + slot), { recursive: false });
      break;
    } catch {
      slot++;
    }
  }
  if (slot % ${K} < passes) fs.writeFileSync("done.txt", "ok\\n");
  const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  say({ type: "system", subtype: "init", model: "claude-sonnet-5-5" });
  say({ type: "result", subtype: "success", is_error: false, result: "Done.", usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: cost * (1 + task / 10) });
});
`;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-trade-")));
  home = join(root, "home");
  repo = join(root, "repo");
  const bin = join(root, "bin");
  const slots = join(root, "slots");
  for (const d of [home, repo, slots, join(root, "tmp")]) mkdirSync(d);
  nodeBin(bin, "claude", FAKE_CLAUDE(slots));
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: pathOf(bin, dirname(process.execPath), gitBin ? dirname(gitBin) : undefined, process.platform === "win32" ? dirname(posixShell() ?? "") : undefined, "/usr/bin", "/bin"),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    CODING_SH_HOOK_SOURCE: join(root, "hook-source.mjs"),
  };
  writeFileSync(join(root, "hook-source.mjs"), "// test hook\n");
  if (!gitBin) return;
  const h = join(root, "harness");
  mkdirSync(join(h, ".claude"), { recursive: true });
  writeFileSync(join(h, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(h, "harness.toml"), `name = "fake-claude"\nagent = "claude-code"\ninclude = [".claude/**"]\n`);
  const snap = cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
  assert.equal(snap.status, 0, snap.stdout + snap.stderr);

  const git = (...a: string[]) => assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  writeFileSync(join(repo, "CLAUDE.md"), md(2, 0.01));
  const suite = join(repo, "evals", "chores");
  mkdirSync(suite, { recursive: true });
  writeFileSync(join(suite, "suite.json"), JSON.stringify({ name: "chores", purpose: "regression", trials: K, tasks: "tasks", harness: "fake-claude" }));
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
  reasons: string[];
  objectives: {
    branch?: string;
    maxCostRise: number | null;
    trade?: { limit: number | null; rose: string[]; within: boolean };
    quality: { mean: number; better: boolean };
    metrics: { objective: string; relative: number; worse: boolean }[];
  };
}

const cost = (r: Round) => r.objectives.metrics.find((m) => m.objective === "cost")!;

describe("refine test --suite: a pass-rate gain against a cost rise", () => {
  it("keeps +33 pts at +20% cost, rejects +0 pts at +20% and +33 pts at +80% under the default limit, and keeps +80% with --max-cost-rise 100%", (t) => {
    if (!gitBin) return t.skip("needs git");
    const gain20 = draft("gain20", md(3, 0.012));
    const flat20 = draft("flat20", md(2, 0.012));
    const gain80 = draft("gain80", md(3, 0.018));
    const r = cli(["refine", "test", gain20, flat20, gain80, "--suite", "chores", "--objective", "pass,cost", "--yes", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [a, b, c] = (JSON.parse(r.stdout) as { rounds: Round[] }).rounds as [Round, Round, Round];

    // +33 pts beyond noise at +20% cost: kept, with the trade in the verdict.
    assert.equal(a.verdict, "keep", a.reasons.join("\n"));
    assert.equal(a.objectives.branch, "quality");
    assert.ok(a.objectives.quality.better);
    assert.ok(Math.abs(a.objectives.quality.mean - 1 / 3) < 1e-9);
    assert.ok(cost(a).worse && Math.abs(cost(a).relative - 0.2) < 1e-9, "the cost rise is beyond noise too");
    assert.match(a.reasons[0]!, /^quality improved: \+33\.3 pts per task \[\+33\.3 pts, \+33\.3 pts\], p 0\.016, for cost \/ run \+20% \[\+20%, \+20%\], p 0\.016 \(limit \+50%\)$/);
    assert.deepEqual(a.objectives.trade, { limit: 0.5, rose: ["cost"], within: true });
    assert.equal(a.objectives.maxCostRise, 0.5);

    // No pass-rate gain at +20% cost: rejected.
    assert.equal(b.verdict, "reject", b.reasons.join("\n"));
    assert.equal(b.objectives.quality.mean, 0);
    assert.match(b.reasons[0]!, /^worse on cost \/ run \+20%/);
    assert.equal(b.objectives.trade, undefined);

    // +33 pts at +80% cost: past the default +50% limit.
    assert.equal(c.verdict, "reject", c.reasons.join("\n"));
    assert.ok(c.objectives.quality.better);
    assert.match(c.reasons[0]!, /^cost rose past the limit: cost \/ run \+80% \[\+80%, \+80%\], p 0\.016 \(limit \+50%\) for \+33\.3 pts per task/);
    assert.deepEqual(c.objectives.trade, { limit: 0.5, rose: ["cost"], within: false });

    // The same candidate with a wider limit is kept, and the text verdict prints the trade.
    const wide = cli(["refine", "test", gain80, "--suite", "chores", "--objective", "pass,cost", "--max-cost-rise", "100%", "--yes"]);
    assert.equal(wide.status, 0, wide.stdout + wide.stderr);
    assert.match(wide.stdout, /verdict {4}keep \(quality\): quality improved: \+33\.3 pts per task \[\+33\.3 pts, \+33\.3 pts\], p 0\.016, for cost \/ run \+80% \[\+80%, \+80%\], p 0\.016 \(limit \+100%\)/);
  });

  it("reads the limit from refine.maxCostRise, and a repo config may only lower it", (t) => {
    if (!gitBin) return t.skip("needs git");
    mkdirSync(join(home, ".coding.sh"), { recursive: true });
    writeFileSync(join(home, ".coding.sh", "config.toml"), '[refine]\nmaxCostRise = "200%"\n');
    const plan = (extra: string[] = []) => {
      const r = cli(["refine", "test", draft("plan", md(3, 0.02)), "--suite", "chores", "--objective", "pass,cost", "--dry-run", "--json", ...extra]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return (JSON.parse(r.stdout) as { maxCostRise: number | null }).maxCostRise;
    };
    assert.equal(plan(), 2);
    assert.equal(plan(["--max-cost-rise", "none"]), null, "the flag wins, and none is no limit");
    mkdirSync(join(repo, ".coding.sh"), { recursive: true });
    writeFileSync(join(repo, ".coding.sh", "config.toml"), "[refine]\nmaxCostRise = 0.3\n");
    assert.equal(plan(), 0.3, "a repo config lowers it");
    writeFileSync(join(repo, ".coding.sh", "config.toml"), '[refine]\nmaxCostRise = "500%"\n');
    assert.equal(plan(), 2, "a repo config can't raise it");
    rmSync(join(repo, ".coding.sh"), { recursive: true });
    rmSync(join(home, ".coding.sh", "config.toml"));
    const text = cli(["refine", "test", draft("plan", md(3, 0.02)), "--suite", "chores", "--objective", "pass,cost", "--dry-run"]);
    assert.match(text.stdout, /a significant pass-rate gain may cost up to \+50% on the others \(--max-cost-rise\)/);
    const bad = cli(["refine", "test", draft("plan", md(3, 0.02)), "--suite", "chores", "--max-cost-rise", "lots", "--dry-run"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--max-cost-rise must be a rise like 50%, 0\.5 or none/);
  });
});
