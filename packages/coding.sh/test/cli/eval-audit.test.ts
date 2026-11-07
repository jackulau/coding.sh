// `coding.sh eval audit` (AA-11): two fake `wrapper` agents both pass a verifier that
// only checks positive numbers; `special` special-cases positives. A witness test for
// negatives passes the reference, then refutes `special`'s passes on replay.
// Runs src/cli/main.ts directly with a temp HOME; no model is called.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
let repo = "";
let env: Record<string, string> = {};
let experimentId = "";

function cli(args: string[], cwd = home) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd, encoding: "utf8", timeout: 120_000 });
}

before(() => {
  if (!gitBin) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-audit-")));
  home = join(root, "home");
  repo = join(root, "repo");
  for (const d of [home, repo, join(root, "tmp")]) mkdirSync(d);
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
  };
  writeFileSync(join(repo, "sum.js"), "module.exports = (a, b) => 0;\n");
  writeFileSync(join(repo, "test.js"), 'if (require("./sum.js")(2, 3) !== 5) process.exit(1);\n');
  const git = (...a: string[]) => assert.equal(spawnSync(gitBin, ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd: repo, env }).status, 0, a.join(" "));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  const fix = 'require("fs").writeFileSync("sum.js","module.exports=(a,b)=>a+b;\\n")';
  assert.equal(cli(["run", "--", process.execPath, "-e", fix], repo).status, 0);
  const t = cli(["eval", "new", "latest", "--name", "sum", "--verifier", "node test.js", "--instruction", "sum(a, b) must add any two numbers, negatives too", "--json"], repo);
  assert.equal(t.status, 0, t.stdout + t.stderr);
  git("checkout", "-q", "sum.js");

  for (const [name, body] of [
    ["honest", "module.exports = (a, b) => a + b;\\n"],
    ["special", "module.exports = (a, b) => (a >= 0 && b >= 0 ? a + b : 0);\\n"],
  ] as const) {
    const agent = join(root, `${name}.mjs`);
    writeFileSync(agent, `import {writeFileSync} from "node:fs";\nwriteFileSync("sum.js", "${body}");\n`);
    const h = join(root, name);
    mkdirSync(h);
    writeFileSync(join(h, "harness.toml"), `name = "${name}"\nagent = "wrapper"\nflags = ${JSON.stringify([process.execPath, agent])}\n`);
    const snap = cli(["harness", "snapshot", "--file", join(h, "harness.toml"), "--json"]);
    assert.equal(snap.status, 0, snap.stdout + snap.stderr);
  }
  const r = cli(["compare", "honest", "special", "-t", "sum", "--k", "2", "--yes", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  experimentId = (JSON.parse(r.stdout) as { experimentId: string }).experimentId;
  writeFileSync(join(root, "neg.js"), 'const s = require("./sum.js")(-2, -3);\nif (s !== -5) { console.error("sum(-2, -3) is " + s); process.exit(1); }\n');
  writeFileSync(join(root, "wrong.js"), 'if (require("./sum.js")(2, 2) !== 5) process.exit(1);\n');
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface AuditJson {
  outcome: string;
  witness?: { path: string; confirm: { ok: boolean; refPassed: number; noopFails: boolean; error?: string } };
  arms: { bundleId: string; runs: number; passes: number; refuted: number; auditedPasses: number }[];
  report: { runs: { status: string }[]; ambiguous: unknown[] };
  verifier?: string;
}

describe("eval audit", () => {
  it("needs an experiment, rejects a witness the reference fails, and refutes the special-cased passes", (t) => {
    if (!gitBin) return t.skip("needs git");
    assert.equal(cli(["eval", "audit", "sum"]).status, 2, "--experiment is required");
    assert.equal(cli(["eval", "audit", "sum", "--experiment", experimentId, "--witness", "x.js"]).status, 2, "--witness needs --witness-cmd");
    const none = cli(["eval", "audit", "sum", "--experiment", experimentId]);
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /sum has no witnesses yet/);

    const wrong = cli(["eval", "audit", "sum", "--experiment", experimentId, "--witness", `wrong.test.js=${join(root, "wrong.js")}`, "--witness-cmd", "node wrong.test.js", "--json"]);
    assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
    const wj = JSON.parse(wrong.stdout) as { outcome: string; confirm: { error: string } };
    assert.equal(wj.outcome, "witness_rejected");
    assert.match(wj.confirm.error, /fails on the reference \(0\/3\)/);

    const r = cli(["eval", "audit", "sum", "--experiment", experimentId, "--witness", `neg.test.js=${join(root, "neg.js")}`, "--witness-cmd", "node neg.test.js", "--requirement", "negatives too", "--json"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout) as AuditJson;
    assert.equal(j.outcome, "audited");
    assert.deepEqual([j.witness?.path, j.witness?.confirm.ok, j.witness?.confirm.refPassed, j.witness?.confirm.noopFails], ["neg.test.js", true, 3, true]);
    assert.deepEqual(
      j.arms.map((a) => [a.runs, a.passes, a.refuted, a.auditedPasses]).sort((a, b) => a[2]! - b[2]!),
      [
        [2, 2, 0, 2],
        [2, 2, 2, 0],
      ],
    );
    assert.deepEqual(j.report.ambiguous, [], "2 of 4 is not over half");

    // Again from the stored witness, plain text; then promoted into the verifier.
    const plain = cli(["eval", "audit", "sum", "--experiment", experimentId, "--promote"]);
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.match(plain.stdout, /^special \(\w{8}\): passes 2\/2, refuted 2, audited pass rate 0% \(0\/2\), replayed 2\/2$/m);
    assert.match(plain.stdout, /^refuted run_\w+ \(special \(\w{8}\)\) by neg\.test\.js: negatives too\n {2}sum\(-2, -3\) is 0$/m);
    assert.match(plain.stdout + plain.stderr, /added neg\.test\.js to the verifier; validate the task again/);
    const list = JSON.parse(cli(["eval", "list", "--json"]).stdout) as { tasks: { name: string; status: string; verifier: { command: string } }[] };
    const task = list.tasks.find((x) => x.name === "sum");
    assert.deepEqual([task?.status, task?.verifier.command], ["draft", "node test.js && node neg.test.js"]);
  });

  it("compare reads the audit: audited pass rate per arm, and --audited counts refuted passes as fails (AA-13)", (t) => {
    if (!gitBin) return t.skip("needs git");
    type Arm = { passes: number; refutedPasses?: number; auditedRuns?: number; auditedPassRate?: { p: number } };
    type Report = { baseline: Arm; candidate: Arm; verdict: { kind: string }; audited?: { rawVerdict: string; method: string }; notes: string[] };
    const raw = cli(["compare", "honest", "special", "--experiment", experimentId, "--json"]);
    assert.equal(raw.status, 0, raw.stdout + raw.stderr);
    const rj = (JSON.parse(raw.stdout) as { report: Report }).report;
    assert.equal(rj.audited, undefined);
    assert.deepEqual([rj.baseline.passes, rj.baseline.refutedPasses, rj.baseline.auditedPassRate?.p], [2, 0, 1]);
    assert.deepEqual([rj.candidate.passes, rj.candidate.refutedPasses, rj.candidate.auditedRuns, rj.candidate.auditedPassRate?.p], [2, 2, 2, 0]);

    const a = cli(["compare", "honest", "special", "--experiment", experimentId, "--audited", "--json"]);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    const aj = (JSON.parse(a.stdout) as { report: Report }).report;
    assert.deepEqual(aj.audited, { rawVerdict: rj.verdict.kind, method: "manual" });
    assert.equal(aj.candidate.passes, 0, "refuted passes count as fails");
    assert.ok(aj.notes.some((n) => /^audited/.test(n) && /2 refuted pass\(es\) count as fails/.test(n)), aj.notes.join("\n"));

    const text = cli(["compare", "honest", "special", "--experiment", experimentId, "--audited"]);
    assert.equal(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /^audited pass +A 100% → 100% \(0 refuted, coverage 100%\)$/m);
    assert.match(text.stdout, /^ +B 100% → 0% \(2 refuted, coverage 100%\)$/m);
    assert.match(text.stdout, /^verdict \(audited\): /m);
  });
});
