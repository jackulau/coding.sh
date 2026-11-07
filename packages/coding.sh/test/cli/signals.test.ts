// Interrupting `exp run` from outside (EXP-1, EXP-3): Ctrl-C and SIGTERM both
// abort it, kill the task's process group, store the experiment as cancelled
// with only its finished case runs, and `exp compare` refuses that partial
// result unless --force. Runs src/cli/main.ts directly (type stripping) with a
// temp HOME and a fake command agent.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
let root = "";
let home = "";
let env: NodeJS.ProcessEnv = {};

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "csh-signals-")));
  home = join(root, "home");
  mkdirSync(home);
  mkdirSync(join(root, "tmp"));
  env = {
    HOME: home,
    CODING_SH_HOME: join(home, ".coding.sh"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: join(root, "tmp"),
    NO_COLOR: "1",
    CODING_SH_NO_UPDATE_CHECK: "1",
  };
  const cases = [];
  for (let i = 1; i <= 6; i++) cases.push("--case", JSON.stringify({ input: String(i), expected: String(i) }));
  const add = cli(["dataset", "add", "ds", ...cases]);
  assert.equal(add.status, 0, add.stderr);
  // Echo agent: records its pid, then answers after DELAY ms.
  writeFileSync(
    join(home, "agent.mjs"),
    `import {appendFileSync} from "node:fs";appendFileSync(process.env.PID_FILE, process.pid+"\\n");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>setTimeout(()=>process.stdout.write(s), Number(process.env.DELAY)));\n`,
  );
});
after(() => rmSync(root, { recursive: true, force: true }));

function cli(args: string[]) {
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env, cwd: home, encoding: "utf8", timeout: 60_000 });
}
const task = (delay: number, pidFile: string) => JSON.stringify({ kind: "command", command: process.execPath, args: [join(home, "agent.mjs")], env: { DELAY: String(delay), PID_FILE: pidFile }, timeoutMs: 0 });
const runArgs = (name: string, delay: number, pidFile: string) => ["exp", "run", "-d", "ds", "--task", task(delay, pidFile), "-g", '{"kind":"exact"}', "--concurrency", "1", "--name", name, "--json"];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidsIn = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);

/** Start `exp run`, send `sig` once the agent has run `after` times, and wait for the CLI to exit. */
async function interrupt(name: string, delay: number, sig: NodeJS.Signals, afterAgents: number) {
  const pidFile = join(root, `${name}.pids`);
  const child = spawn(process.execPath, ["--no-warnings", CLI, ...runArgs(name, delay, pidFile)], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.resume();
  const exit = new Promise<number | null>((r) => child.on("close", r));
  const deadline = Date.now() + 20_000;
  while (pidsIn(pidFile).length < afterAgents && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  child.kill(sig);
  const code = await exit;
  return { code, stdout, pids: pidsIn(pidFile) };
}

describe("exp run interrupted", () => {
  it("Ctrl-C stores a cancelled experiment with only finished runs; compare refuses it unless --force", async () => {
    const full = cli(runArgs("v1", 0, join(root, "v1.pids")));
    assert.equal(full.status, 0, full.stderr);

    const r = await interrupt("v2", 400, "SIGINT", 3);
    assert.equal(r.code, 130);
    assert.equal(JSON.parse(r.stdout).outcome, "cancelled");
    for (const pid of r.pids) assert.equal(alive(pid), false, `agent ${pid} killed`);

    const list = JSON.parse(cli(["exp", "list", "--json"]).stdout) as { experiments: { id: string; name: string; status: string; runs: number; summary: { passed: number; errors: number } }[] };
    const v2 = list.experiments.find((e) => e.name === "v2")!;
    assert.equal(v2.status, "cancelled");
    assert.ok(v2.runs >= 1 && v2.runs < 6, `runs ${v2.runs}`);
    assert.equal(v2.summary.errors, 0, "the case the interrupt cut short is not stored as a failure");
    assert.equal(v2.summary.passed, v2.runs);

    const byName = cli(["exp", "compare", "v1", "v2"]);
    assert.notEqual(byName.status, 0);
    assert.match(byName.stderr, /Experiment v2 \(exp_\w+\) was cancelled after/, "a name that only matches a cancelled experiment says so");
    const shown = cli(["exp", "show", "v2"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /cancelled: only \d+ case runs? finished before the interrupt/);
    assert.match(JSON.parse(r.stdout).experiment.id, /^exp_/);
    const byId = cli(["exp", "compare", "v1", v2.id]);
    assert.notEqual(byId.status, 0);
    assert.match(byId.stderr, /was cancelled after/);
    const forced = cli(["exp", "compare", "v1", v2.id, "--force", "--json"]);
    assert.equal(forced.status, 0, forced.stderr);
    const forcedText = cli(["exp", "compare", "v1", v2.id, "--force"]);
    assert.match(forcedText.stdout, /^B v2 .*cancelled: \d+ case runs? only$/m, "a forced compare still marks the partial side");
    const cmp = JSON.parse(forced.stdout).comparison as { verdict: string; regressions: unknown[] };
    assert.equal(cmp.regressions.length, 0);
    assert.notEqual(cmp.verdict, "worse");
  });

  it("SIGTERM kills the running task and keeps the finished runs", async () => {
    const r = await interrupt("v3", 20_000, "SIGTERM", 1);
    assert.equal(r.code, 143);
    assert.equal(r.pids.length, 1);
    assert.equal(alive(r.pids[0]!), false, "task killed with the CLI");
    const list = JSON.parse(cli(["exp", "list", "--json"]).stdout) as { experiments: { name: string; status: string; runs: number }[] };
    const v3 = list.experiments.find((e) => e.name === "v3");
    assert.equal(v3?.status, "cancelled");
    assert.equal(v3?.runs, 0);
  });
});
