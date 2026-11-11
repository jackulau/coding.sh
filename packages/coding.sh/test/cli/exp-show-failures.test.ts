// exp show and exp run on what failed: repeated reasons are grouped with a
// count, an HTTP 529 says "overloaded", each case id comes with its input,
// `exp show latest` is the newest experiment, and a run with no cases exits 1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExperimentResult } from "../../src/datasets/types.ts";
import { caseLabels, renderExperiment, shownReason } from "../../src/experiments/render.ts";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

describe("exp show: failures", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 120_000 });
  const task = (every: number) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { FAIL_EVERY: String(every) } });

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-exp-show-")));
    home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "tmp"));
    env = {
      HOME: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      PATH: pathOf(dirname(process.execPath), "/usr/bin", "/bin"),
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
    const cases: string[] = [];
    for (let i = 1; i <= 6; i++) cases.push("--case", JSON.stringify({ id: `c${i}`, input: `add ${i} and ${i}`, expected: 2 * i }));
    assert.equal(cli(["dataset", "add", "sums", ...cases]).status, 0);
    writeFileSync(
      join(home, "agent.mjs"),
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s);const n=Number(/\\d+/.exec(q)[0]);const k=Number(process.env.FAIL_EVERY||0);process.stdout.write(JSON.stringify(k&&n%k===0?-1:2*n))});\n`,
    );
    for (const [name, every] of [["first", 0], ["second", 2]] as const) {
      const r = cli(["exp", "run", "-d", "sums", "--task", task(every), "-g", '{"kind":"exact"}', "--name", name]);
      assert.equal(r.status, 0, r.stderr);
    }
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("exp show latest is the newest experiment, and its failures name each case's input", () => {
    const r = cli(["exp", "show", "latest"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^second /m);
    assert.match(r.stdout, /failures 3/);
    assert.match(r.stdout, /c2 +add 2 and 2 +exact: /);
  });

  it("exp run with no cases to run exits 1 and says so", () => {
    const r = cli(["exp", "run", "-d", "sums", "--split", "test", "--task", task(0), "-g", '{"kind":"exact"}']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Dataset sums has no cases in split test: nothing to run/);
  });

  it("exp run -d <name>@<version> runs the pinned version, as exp show prints it", () => {
    const first = JSON.parse(cli(["exp", "show", "first", "--json"]).stdout) as { experiment: ExperimentResult };
    const pin = first.experiment.dataset.version;
    assert.match(cli(["exp", "show", "first"]).stdout, new RegExp(`dataset sums@${pin}`));
    assert.equal(cli(["dataset", "add", "sums", "--case", JSON.stringify({ id: "c7", input: "add 7 and 7", expected: 14 })]).status, 0);
    for (const ref of [`sums@${pin}`, `sums@${pin.slice(0, 8)}`]) {
      const r = cli(["exp", "run", "-d", ref, "--task", task(0), "-g", '{"kind":"exact"}', "--json"]);
      assert.equal(r.status, 0, r.stderr);
      const e = (JSON.parse(r.stdout) as { experiment: ExperimentResult }).experiment;
      assert.equal(e.dataset.version, pin);
      assert.equal(e.summary.n, 6, "the new case is not in the pinned version");
    }
    const latest = JSON.parse(cli(["exp", "run", "-d", "sums", "--task", task(0), "-g", '{"kind":"exact"}', "--json"]).stdout) as { experiment: ExperimentResult };
    assert.equal(latest.experiment.summary.n, 7);
    const missing = cli(["exp", "run", "-d", "sums@deadbeef", "--task", task(0), "-g", '{"kind":"exact"}']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Can't find dataset "sums@deadbeef"/);
  });
});

describe("renderExperiment: grouped reasons", () => {
  const run = (caseId: string, error: string) => ({ caseId, trial: 1, error, latencyMs: 1, grades: [], pass: false, startedAt: 0 });

  it("the same reason on several runs is one row with its count and cases", () => {
    const err = 'Anthropic API error 529: {"type":"error"}';
    const r: ExperimentResult = {
      id: "exp_x",
      name: "x",
      dataset: { id: "d", name: "d", version: "v" },
      task: { kind: "command", ref: "agent" },
      trials: 1,
      graders: [],
      runs: [run("c1", err), run("c2", err), run("c3", err), run("c4", err), run("c5", "boom")],
      summary: { n: 5, cases: 5, passed: 0, errors: 5, passRate: { p: 0, lo: 0, hi: 0.4 }, ciMethod: "wilson", latencyMs: { mean: 1, median: 1, p90: 1, max: 1 }, graders: [] },
      createdAt: 0,
      finishedAt: 0,
    };
    const text = renderExperiment(r, { color: false, cases: caseLabels([{ id: "c5", input: { prompt: "fix   the\nbuild" } }]) });
    assert.match(text, /^ +4 +error: Anthropic API error 529 \(overloaded\): .* +c1, c2, c3 \+1 more$/m);
    assert.match(text, /^ +1 +error: boom +c5 fix the build$/m);
  });

  it("a reason shared by several cases names each case's input, not only its id", () => {
    const r: ExperimentResult = {
      id: "exp_y",
      name: "y",
      dataset: { id: "d", name: "d", version: "v" },
      task: { kind: "command", ref: "agent" },
      trials: 1,
      graders: [],
      runs: ["c1", "c2", "c3", "c4"].map((id) => run(id, 'exact: expected "ok", got "no"')),
      summary: { n: 4, cases: 4, passed: 0, errors: 4, passRate: { p: 0, lo: 0, hi: 0.5 }, ciMethod: "wilson", latencyMs: { mean: 1, median: 1, p90: 1, max: 1 }, graders: [] },
      createdAt: 0,
      finishedAt: 0,
    };
    const labels = caseLabels(["c1", "c2", "c3", "c4"].map((id, i) => ({ id, input: i === 0 ? "a prompt far longer than twenty characters" : `add ${i} and ${i}` })));
    const text = renderExperiment(r, { color: false, cases: labels });
    assert.match(text, /^ +4 +error: exact: expected "ok", got "no" +c1 a prompt far longer…, c2 add 1 and 1, c3 add 2 and 2 \+1 more$/m);
  });

  it("shownReason leaves other numbers and an existing overloaded alone", () => {
    assert.equal(shownReason("HTTP 529"), "HTTP 529 (overloaded)");
    assert.equal(shownReason("overloaded_error (HTTP 529)"), "overloaded_error (HTTP 529)");
    assert.equal(shownReason("expected 529, got 530"), "expected 529, got 530");
  });

  it("caseLabels prefers a name, then the input, cut to 40 characters", () => {
    const m = caseLabels([{ id: "a", input: "x", metadata: { name: "renames the flag" } }, { id: "b", input: "y".repeat(80) }]);
    assert.equal(m.get("a"), "renames the flag");
    assert.equal(m.get("b")!.length, 40);
    assert.equal(caseLabels([{ id: "c", input: { n: 2 } }]).get("c"), '{"n":2}');
  });
});
