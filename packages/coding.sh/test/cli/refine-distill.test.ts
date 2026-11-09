// `coding.sh refine distill` end to end through src/cli/main.ts with a temp
// HOME: an experiment's runs seeded into the store, and a fake `claude` on PATH
// that writes out/SKILL.md (or not) in its working directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { EvalTask, RunResult } from "../../src/core/types.ts";
import { pathOf } from "../_bin.ts";
import { putSession, sessionEvents } from "../helpers-decision.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
const posix = process.platform !== "win32";
let root = "";
let home = "";
let repo = "";
let bin = "";
let env: Record<string, string> = {};

const SKILL = "---\nname: verify-first\ndescription: Use before finishing a task.\n---\n- Run the tests before you finish: 12 of 30 failing runs never ran them.\n";

function cli(args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...env, ...extra }, cwd: repo, encoding: "utf8", timeout: 120_000 });
}

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-refine-distill-")));
  home = join(root, "home");
  repo = join(root, "repo");
  bin = join(root, "bin");
  for (const d of [home, repo, bin, join(root, "tmp")]) mkdirSync(d);
  env = {
    HOME: home,
    USERPROFILE: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: pathOf(bin, dirname(process.execPath), "/usr/bin", "/bin"),
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
    CODING_SH_HOOK_SOURCE: join(root, "hook-source.mjs"),
  };
  writeFileSync(join(root, "hook-source.mjs"), "// test hook\n");
  // The fake distiller: SKILL_MODE=write writes the skill, anything else writes nothing.
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env node
const fs = require("node:fs");
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  fs.appendFileSync(${JSON.stringify(join(root, "seen.txt"))}, process.cwd() + "\\t" + fs.existsSync("corpus/episodes.jsonl") + "\\n");
  if (process.env.SKILL_MODE === "write") fs.writeFileSync("out/SKILL.md", ${JSON.stringify(SKILL)});
  console.log(JSON.stringify({ type: "result", result: "done", total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 5 } }));
});
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  writeFileSync(join(repo, "CLAUDE.md"), "# Project\nUse pnpm.\n");
  const { openContext } = await import("../../src/core/context.ts");
  const ctx = await openContext({ env, cwd: repo });
  try {
    const task = (id: string, tags: string[]): EvalTask => ({ id, name: id, status: "validated", start: { repoRoot: repo, snapshot: "s", head: "h" }, instruction: "Fix it.", setup: [], verifier: { command: "true", hiddenFiles: {}, timeoutMs: 1000 }, tags, createdAt: 0 });
    for (let t = 0; t < 6; t++) await ctx.index.putTask(task(`t${t}`, []));
    await ctx.index.putTask(task("tdev", ["split:dev"]));
    const t0 = Date.now() - 3600_000;
    let k = 0;
    const put = async (exp: string, taskId: string, pass: boolean) => {
      const sid = `${exp}-s${k}`;
      await putSession(ctx.index, sessionEvents(sid, { cwd: repo, startedAt: t0 + k * 1000, runId: exp }, [["session.start", {}], ["user.message", { text: "Fix it." }], ["assistant.message", { text: pass ? "Fixed." : "Done." }]]), { runId: exp });
      const r: RunResult = { id: `${exp}_run${k}`, experimentId: exp, taskId, bundleId: "b".repeat(64), attempt: k, sessionId: sid, pass, verifierExit: pass ? 0 : 1, agent: { exitCode: 0, timedOut: false, durationMs: 100, stdoutTail: "", stderrTail: "" }, startedAt: t0 + k * 1000, endedAt: t0 + k * 1000 + 100 };
      await ctx.index.putRun(r);
      k++;
    };
    for (let i = 0; i < 30; i++) await put("exp_big", `t${i % 6}`, i >= 12);
    for (let i = 0; i < 3; i++) await put("exp_big", "tdev", false);
    for (let i = 0; i < 8; i++) await put("exp_small", `t${i % 6}`, i >= 4);
  } finally {
    await ctx.close();
  }
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const seen = () => (existsSync(join(root, "seen.txt")) ? readFileSync(join(root, "seen.txt"), "utf8").split("\n").filter(Boolean) : []);

describe("refine distill", () => {
  it("--dry-run prints the corpus counts and starts no agent", (t) => {
    if (!posix) return t.skip("the fake claude is a shebang script");
    const r = cli(["refine", "distill", "--experiment", "exp_big", "--dry-run", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const doc = JSON.parse(r.stdout) as { corpus: { episodes: number; failures: number; passRate: number; leftOut: { tasks: string[]; runs: number } }; n: number };
    assert.deepEqual([doc.corpus.episodes, doc.corpus.failures, doc.corpus.passRate, doc.corpus.leftOut], [30, 12, 0.6, { tasks: ["tdev"], runs: 3 }]);
    assert.deepEqual(seen(), []);
  });

  it("refuses a corpus under 20 episodes with a next step", (t) => {
    if (!posix) return t.skip("the fake claude is a shebang script");
    const r = cli(["refine", "distill", "--experiment", "exp_small", "--yes"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Not enough to distill from: the corpus has 8 episodes; distilling needs at least 20/);
    assert.match(r.stderr, /--min-episodes 8/);
    assert.deepEqual(seen(), []);
  });

  it("ledgers the skill as a proposed candidate (exit 0); a draw that writes nothing exits 1 with no entry", (t) => {
    if (!posix) return t.skip("the fake claude is a shebang script");
    const r = cli(["refine", "distill", "--experiment", "exp_big", "--yes", "--json"], { SKILL_MODE: "write" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const doc = JSON.parse(r.stdout) as { draws: { id: string; path: string; verdict: string; costUsd: number }[]; spentUsd: number };
    assert.equal(doc.draws[0]!.verdict, "proposed");
    assert.equal(doc.draws[0]!.path, ".claude/skills/verify-first/SKILL.md");
    assert.equal(doc.draws[0]!.costUsd, 0.25);
    assert.equal(seen()[0]!.split("\t")[1], "true", "the distiller saw the corpus");
    const log = JSON.parse(cli(["refine", "log", "--json"]).stdout) as { entries: { op: string; id: string; proposer: string; provenance: { corpusEpisodes: number; failures: number } }[] };
    assert.equal(log.entries.length, 1);
    assert.deepEqual([log.entries[0]!.op, log.entries[0]!.id, log.entries[0]!.proposer, log.entries[0]!.provenance.corpusEpisodes, log.entries[0]!.provenance.failures], ["propose", doc.draws[0]!.id, "distill", 30, 12]);
    assert.deepEqual(readdirSync(join(root, "tmp")).filter((n) => n.startsWith("csh-distill-")), [], "the work dir is removed");
    // refine test resolves the stored candidate (this fixture then has no decision points to test it on).
    const test = cli(["refine", "test", doc.draws[0]!.id, "--dry-run", "--json"]);
    assert.match(test.stderr, /"reason":"no_cases"/, test.stdout + test.stderr);
    assert.match(cli(["refine", "test", "r_0000000000", "--dry-run", "--json"]).stderr, /No stored candidate r_0000000000/);

    const none = cli(["refine", "distill", "--experiment", "exp_big", "--yes", "--json"]);
    assert.equal(none.status, 1, none.stdout + none.stderr);
    assert.match((JSON.parse(none.stdout) as { draws: { error: string }[] }).draws[0]!.error, /wrote no out\/SKILL\.md/);
    assert.equal((JSON.parse(cli(["refine", "log", "--json"]).stdout) as { entries: unknown[] }).entries.length, 1);
    assert.equal(existsSync(join(home, ".claude", "settings.json")), false, "the user's agent config is untouched");
  });
});
