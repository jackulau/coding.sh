// X-26 from the CLI: --failing and the compare guard, --sample/--seed, --retry-errors,
// a killed run that exp list marks partial and --resume finishes. Temp HOME only.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { pathOf } from "../_bin.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));

describe("exp run case selection and resume from the CLI", () => {
  let root = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  const cli = (args: string[]) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 120_000 });
  // Echoes its input; answers -1 on multiples of FAIL_EVERY; exits 1 on case 5 while ./broken exists; hangs on case 7 while ./hang exists.
  const task = (every: number) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(home, "agent.cjs")], env: { FAIL_EVERY: String(every) } });
  const run = (every: number, ...more: string[]) => cli(["exp", "run", "-d", "ten", "--task", task(every), "-g", '{"kind":"exact"}', ...more]);

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "csh-x26-cli-")));
    home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "tmp"));
    env = {
      HOME: home,
      CODING_SH_HOME: join(home, ".coding.sh"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      PATH: pathOf(dirname(process.execPath), "/usr/bin", "/bin"),
      TMPDIR: join(root, "tmp"),
      NO_COLOR: "1",
      CODING_SH_NO_UPDATE_CHECK: "1",
    };
    const cases: string[] = [];
    for (let i = 1; i <= 10; i++) cases.push("--case", JSON.stringify({ id: `c${i}`, input: i, expected: i }));
    assert.equal(cli(["dataset", "add", "ten", ...cases]).status, 0);
    writeFileSync(
      join(home, "agent.cjs"),
      `const fs=require("node:fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const q=JSON.parse(s);` +
        `if(q===5&&fs.existsSync(${JSON.stringify(join(home, "broken"))})){process.exit(1)}` +
        `if(q===7&&fs.existsSync(${JSON.stringify(join(home, "hang"))})){setInterval(()=>{},1000);return}` +
        `const k=Number(process.env.FAIL_EVERY||0);process.stdout.write(JSON.stringify(k&&q%k===0?-1:q))});\n`,
    );
    writeFileSync(join(home, "package.json"), '{"type":"commonjs"}');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("--failing runs A's failures; compare then holds the gate on regression to the mean", () => {
    assert.equal(run(3, "--name", "a").status, 0);
    const b = run(0, "--name", "b", "--failing", "a", "--json");
    assert.equal(b.status, 0, b.stderr);
    const e = JSON.parse(b.stdout).experiment;
    assert.deepEqual(e.runs.map((r: { caseId: string }) => r.caseId).sort(), ["c3", "c6", "c9"]);
    assert.equal(e.metadata.selection.from.kind, "failing");
    const cmp = cli(["exp", "compare", "a", "b", "--gate"]);
    assert.equal(cmp.status, 1, cmp.stderr);
    assert.match(cmp.stdout, /B ran only on the cases A failed \(--failing exp_\w+\)/);
    assert.match(cmp.stdout, /^verdict inconclusive \(one side ran only on the other's failures\)$/m);
    assert.match(cmp.stdout, /^gate {4}Hold/m);
    // The fair re-run: A's config on A's failures.
    assert.equal(run(3, "--name", "a2", "--failing", "a").status, 0);
    const fair = cli(["exp", "compare", "a2", "b", "--json"]);
    const fairCmp = JSON.parse(fair.stdout).comparison;
    assert.equal(fairCmp.selectionWarning, undefined);
    // All three cases improved, but an exact sign-flip test over 3 cases cannot go below p=0.25: no verdict.
    assert.equal(fairCmp.diff.mean, 1);
    assert.equal(fairCmp.verdict, "inconclusive");
  });

  it("--sample with a seed picks the same cases every time; flags are validated before any run", () => {
    const ids = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout).experiment.runs.map((x: { caseId: string }) => x.caseId).sort().join();
    const one = run(0, "--sample", "4", "--seed", "3", "--json");
    const two = run(0, "--sample", "4", "--seed", "3", "--json");
    assert.equal(one.status, 0, one.stderr);
    assert.equal(ids(one), ids(two));
    assert.equal(ids(one).split(",").length, 4);
    assert.equal(run(0, "--first-n", "2", "--case", "c1*", "--json").status, 0);
    for (const bad of [["--retry-errors"], ["--sample", "1.5"], ["--seed", "3"], ["--failing", "a", "--errors-from", "a"], ["--case", "zz*"]]) {
      const r = run(0, ...bad);
      assert.equal(r.status, 2, `${bad.join(" ")}: ${r.stderr}`);
    }
  });

  it("--resume <experiment> --retry-errors runs only the errored case again", () => {
    writeFileSync(join(home, "broken"), "");
    const first = run(0, "--name", "flaky", "--json");
    assert.equal(first.status, 0, first.stderr);
    const id = JSON.parse(first.stdout).experiment.id;
    assert.equal(JSON.parse(first.stdout).experiment.summary.errors, 1);
    rmSync(join(home, "broken"));
    const again = run(0, "--name", "flaky", "--resume", id, "--retry-errors", "--json");
    assert.equal(again.status, 0, again.stderr);
    const e = JSON.parse(again.stdout).experiment;
    assert.equal(e.id, id);
    assert.equal(e.summary.errors, 0);
    assert.equal(e.summary.passed, 10);
    // Grader drift refuses and names the graders.
    const drift = cli(["exp", "run", "-d", "ten", "--task", task(0), "-g", '{"kind":"contains","value":"1"}', "--resume", id, "--retry-errors"]);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /graders changed/);
  });

  it("a killed run is listed as partial and --resume runs only what is left", async () => {
    writeFileSync(join(home, "hang"), "");
    const child = spawn(process.execPath, ["--no-warnings", CLI, "exp", "run", "-d", "ten", "--task", task(0), "-g", '{"kind":"exact"}', "--name", "killed", "-c", "1"], { env, cwd: home, stdio: "ignore" });
    // Wait for the checkpoint with the 6 cases before the hanging one.
    const dir = join(home, ".coding.sh");
    let listed = "";
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const l = cli(["exp", "list", "--json"]);
      const e = l.status === 0 ? JSON.parse(l.stdout).experiments.find((x: { name: string }) => x.name === "killed") : undefined;
      if (e?.partial && e.runs >= 6) {
        listed = e.id;
        break;
      }
    }
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    assert.ok(listed, `no partial checkpoint under ${dir}: ${existsSync(dir) ? readdirSync(dir).join(",") : "none"}`);
    rmSync(join(home, "hang"));
    assert.match(cli(["exp", "list"]).stdout, /killed \(partial\)/);
    const resumed = cli(["exp", "run", "-d", "ten", "--task", task(0), "-g", '{"kind":"exact"}', "--name", "killed", "--resume", listed, "--json"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    const e = JSON.parse(resumed.stdout).experiment;
    assert.equal(e.id, listed);
    assert.equal(e.status, "completed");
    assert.equal(e.runs.length, 10);
    assert.doesNotMatch(cli(["exp", "list"]).stdout, /killed \(partial\)/);
  });
});
