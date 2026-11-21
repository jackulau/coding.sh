// Loaded into every test file's process by test-ci.mjs and `npm test` (--import). Gives the file a
// temp folder of its own (os.tmpdir() and TMPDIR, TMP, TEMP point at it) and removes it when the
// file's process exits. What a file leaves behind cannot reach the next file or pile up on the
// machine, and under test-ci.mjs it is written down for the run to print.
//
// It resets temp files, not processes: a process a test leaves running is not stopped here. A
// process started with an environment that names no temp folder writes outside the folder.
//
// CODING_SH_TEST_TEMP (set by test-ci.mjs) is where the folders are made and where the list of
// what was left goes (left.jsonl, one line per file; roots.txt names each folder's file). Without
// it the folder is made in the machine's temp folder and nothing is listed.
// CODING_SH_TEST_TEMP_ROOT marks a process that already has a folder: a process a test launches
// with this file's --import (src/cli/commands/proxy.ts passes execArgv on) keeps its parent's
// folder and removes nothing.
import { appendFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { removeSync } from "../src/core/remove.ts";

if (isMainThread && process.env.NODE_TEST_CONTEXT && !process.env.CODING_SH_TEST_TEMP_ROOT) {
  const base = process.env.CODING_SH_TEST_TEMP;
  const root = mkdtempSync(join(base || tmpdir(), "t-"));
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = root;
  process.env.CODING_SH_TEST_TEMP_ROOT = root;
  // Which file a folder belongs to, so the run can name the owner of one that is still there.
  if (base) appendFileSync(join(base, "roots.txt"), `${basename(root)}\t${process.argv[1]}\n`);

  let done = false;
  const reset = () => {
    if (done) return;
    done = true;
    let left = [];
    let error;
    try {
      // npm and tsc (TypeScript 5.7 and later) turn on Node's compile cache, which Node keeps in
      // os.tmpdir()/node-compile-cache. A test does not make it, and outside these folders every
      // Node program shares it, so it is not listed. It is removed with the rest of the folder.
      left = readdirSync(root).filter((name) => name !== "node-compile-cache");
    } catch (err) {
      error = String(err?.message ?? err);
    }
    try {
      // A browser that is still exiting can hold a file for a moment on Windows. removeSync waits
      // between tries; on Node 24 on Windows, rmSync's own retries did not.
      removeSync(root, { maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      error = String(err?.message ?? err);
    }
    if (!base || (left.length === 0 && !error)) return;
    try {
      appendFileSync(join(base, "left.jsonl"), `${JSON.stringify({ file: process.argv[1], left, error })}\n`);
    } catch {
      // The run's folder is gone: nothing to write to.
    }
  };
  // After every 'exit' listener, not among them: a listener added later (src/core/children.ts
  // removes its own scratch folders on exit) must run first, or its folders would count as left.
  const emit = process.emit;
  process.emit = function (name, ...rest) {
    const result = emit.call(this, name, ...rest);
    if (name === "exit") reset();
    return result;
  };
}
