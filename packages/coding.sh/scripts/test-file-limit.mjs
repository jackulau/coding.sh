// Loaded into every test file's process by test-ci.mjs (--import). Stops a test file that is
// still running after CODING_SH_TEST_FILE_LIMIT_MS (test-ci.mjs sets 5 minutes; 0 turns it off),
// so a file that hangs fails under its own name and test-ci.mjs runs it again alone, instead of
// holding the job until the job's time limit cancels it with no file named. --test-timeout does
// not do this: it bounds each test, and a file can hang before its first test, in a hook, or in a
// call that never returns. The clock runs on a worker thread, so it keeps time while the file's
// own thread is busy, and it ends the file's process with SIGKILL.
//
// Only test file processes have NODE_TEST_CONTEXT. CODING_SH_TEST_FILE_LIMITED marks a process
// that already has a clock: a process a test launches with this file's --import (with the test's
// environment) starts none of its own.
import { relative } from "node:path";
import { Worker, isMainThread } from "node:worker_threads";

const limit = Number(process.env.CODING_SH_TEST_FILE_LIMIT_MS);
if (isMainThread && process.env.NODE_TEST_CONTEXT && !process.env.CODING_SH_TEST_FILE_LIMITED && limit > 0) {
  process.env.CODING_SH_TEST_FILE_LIMITED = "1";
  const file = (process.argv[1] && relative(process.cwd(), process.argv[1])) || process.argv[1] || "a test file";
  const message = `\n${file} ran for more than ${limit / 1000} s and was stopped (CODING_SH_TEST_FILE_LIMIT_MS=${limit})\n`;
  // If the clock cannot start, the file runs without a limit, as it would without this file.
  const noClock = (err) => process.stderr.write(`${file} runs without a time limit: ${err?.message ?? err}\n`);
  try {
    // A timer holds at most 2^31 - 1 ms; a longer one would fire at once. execArgv: [] keeps the
    // file's --import modules from loading again in the clock's thread.
    const clock = new Worker(
      `const { workerData } = require("node:worker_threads");
setTimeout(() => {
  try { require("node:fs").writeSync(2, workerData.message); } catch {}
  process.kill(process.pid, "SIGKILL");
}, Math.min(workerData.limit, 2147483647));`,
      { eval: true, execArgv: [], workerData: { limit, message } },
    );
    // The clock does not keep a finished file's process alive.
    clock.unref();
    clock.on("error", noClock);
  } catch (err) {
    noClock(err);
  }
}
