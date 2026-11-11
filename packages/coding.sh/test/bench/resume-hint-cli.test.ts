// Ctrl-C on `coding.sh bench run`: the CLI prints how to continue the saved
// run, not only "Finishing the trials in flight". Runs src/cli/main.ts with
// the temp project from helpers.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, project } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
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
