// Ctrl-C on `coding.sh bench run`: the CLI prints how to continue the saved
// run, not only "Finishing the trials in flight". Runs the CLI with
// the temp project from helpers.ts, as a process and in process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import * as bench from "../../src/cli/commands/bench.ts";
import { nextStepBin } from "../../src/cli/next-steps.ts";
import { cleanup, project } from "./helpers.ts";
import { CLI } from "../_cli.ts";
import { runCmd, sandbox } from "../cli/_cmd.ts";

after(cleanup);

// On Windows process.kill(pid, "SIGINT") terminates the CLI outright: no handler runs.
test("an interrupted bench run prints the resume command", { skip: process.platform === "win32" && "SIGINT can't be caught on Windows" }, async () => {
  const p = project();
  // A slow contender that records each call, so the test interrupts mid-run.
  p.write("slow.cjs", `require("node:fs").appendFileSync(${JSON.stringify(join(p.root, "calls"))}, "x");const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));setTimeout(() => process.stdout.write(JSON.stringify({ output: input.a + input.b })), 400);\n`);
  p.write("bench/arith.toml", readFileSync(p.file, "utf8").replace('command = "node good.cjs"', 'command = "node slow.cjs"'));
  const child = spawn(process.execPath, ["--no-warnings", CLI, "bench", "run", "arith"], { cwd: p.root, env: { ...p.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (d) => (stderr += d));
  const exit = new Promise<number | null>((r) => child.on("close", r));
  const calls = join(p.root, "calls");
  const deadline = Date.now() + 30_000;
  while ((!existsSync(calls) || readFileSync(calls, "utf8").length < 2) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  child.kill("SIGINT");
  const code = await exit;
  assert.equal(code, 130, stderr);
  assert.match(stderr, /coding\.sh bench run arith --resume \S+/);
});

// In process, so it holds on Windows too: the signal main() aborts on Ctrl-C, aborted mid-run.
test("the step that continues an interrupted run names the CLI as the user's shell runs it", async () => {
  const p = project();
  const calls = join(p.root, "calls");
  p.write("slow.cjs", `require("node:fs").appendFileSync(${JSON.stringify(calls)}, "x");const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));setTimeout(() => process.stdout.write(JSON.stringify({ output: input.a + input.b })), 400);\n`);
  p.write("bench/arith.toml", readFileSync(p.file, "utf8").replace('command = "node good.cjs"', 'command = "node slow.cjs"'));
  // Under npx (npm_command=exec) the step names the npx command, on every OS.
  const sb = sandbox({ npm_command: "exec" });
  try {
    const ac = new AbortController();
    const ran = runCmd(bench, sb, { action: "run", positionals: ["arith"], cwd: p.root, signal: ac.signal });
    const deadline = Date.now() + 30_000;
    while ((!existsSync(calls) || readFileSync(calls, "utf8").length < 2) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    ac.abort();
    const r = await ran;
    assert.equal(r.error?.reason, "interrupted", String(r.error?.message));
    const id = /saved as (\S+) /.exec(r.error.message)?.[1];
    assert.ok(id, r.error.message);
    assert.deepEqual(r.error.next, ["Continue it:", `${nextStepBin(sb.env)} bench run arith --resume ${id}`]);
  } finally {
    sb.cleanup();
  }
});

test("after a budget stop, the step that continues the run names the CLI as the user's shell runs it", async () => {
  const p = project();
  p.def("budget_usd = 0.005");
  const sb = sandbox({ npm_command: "exec" });
  try {
    const r = await runCmd(bench, sb, { action: "run", positionals: ["arith"], cwd: p.root });
    assert.equal(r.code, 1, r.stderr);
    const id = r.stdout.trim().split("\n").at(-1);
    const lines = r.stderr.split("\n").map((l) => l.trim());
    const at = lines.indexOf("Continue it:");
    assert.ok(at >= 0, r.stderr);
    assert.equal(lines[at + 1], `${nextStepBin(sb.env)} bench run arith --resume ${id}`);
  } finally {
    sb.cleanup();
  }
});
