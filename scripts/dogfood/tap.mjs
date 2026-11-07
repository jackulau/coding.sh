#!/usr/bin/env node
// CLI tap (docs/TOOL-EVALS.md §5.3): the sandbox's bin/coding.sh execs this.
// It runs the real command, passes stdin/stdout/stderr through, and appends one
// record per call to $CODINGSH_TAP_LOG. The record is agent-independent: it is
// what the metrics (invalid calls, help lookups, recovery) are computed from.
//
// Env (set by the shim): CODINGSH_TAP_LOG, CODINGSH_TAP_CMD (JSON argv prefix),
// CODINGSH_TAP_ENV (JSON env overrides for the target only).
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const log = process.env.CODINGSH_TAP_LOG;
const cmd = JSON.parse(process.env.CODINGSH_TAP_CMD || "[]");
const extraEnv = JSON.parse(process.env.CODINGSH_TAP_ENV || "{}");
const args = process.argv.slice(2);
if (!cmd.length) {
  process.stderr.write("tap: CODINGSH_TAP_CMD is not set\n");
  process.exit(127);
}

const env = { ...process.env, ...extraEnv };
for (const k of ["CODINGSH_TAP_LOG", "CODINGSH_TAP_CMD", "CODINGSH_TAP_ENV"]) delete env[k];

const t0 = Date.now();
const p0 = performance.now();
const child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ["inherit", "pipe", "pipe"], env });
let outBytes = 0;
let errBytes = 0;
let errHead = "";
child.stdout.on("data", (d) => {
  outBytes += d.length;
  process.stdout.write(d);
});
child.stderr.on("data", (d) => {
  errBytes += d.length;
  if (errHead.length < 2000) errHead += String(d);
  process.stderr.write(d);
});
const forward = (sig) => () => child.kill(sig);
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));
child.on("error", (e) => {
  errHead += String(e);
  finish(127, null);
});
child.on("close", (code, signal) => finish(code, signal));

let done = false;
function finish(code, signal) {
  if (done) return;
  done = true;
  const exit = code ?? (signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1);
  if (log) {
    try {
      appendFileSync(log, JSON.stringify({ ts: t0, argv: args, cwd: process.cwd(), exit, signal: signal ?? undefined, durationMs: Math.round(performance.now() - p0), stdoutBytes: outBytes, stderrBytes: errBytes, stderrHead: errHead.slice(0, 2000) }) + "\n");
    } catch {
      // the tap must never change the target's behavior
    }
  }
  process.exitCode = exit;
}
