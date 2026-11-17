// CI test runner: every test file (one shard of them with SHARD=i/n), then each file that
// failed run again alone. The desk runners and GitHub's hosted runners share their machine with
// other jobs, and timing tests assume an idle machine (AGENTS.md: "If one fails under load, rerun
// it alone first"). A file that passes alone is reported as a warning; one that fails again fails
// the job. More than MAX_RERUN failed files is a real break and is not rerun.
//
// Only a test file of this run is rerun. A test defined outside its test file (a suite shared by
// test files, such as src/store/conformance.ts) fails under the file that defines it; that file
// alone runs no tests and would pass. Such a failure fails the job as it is.
//
// A run whose report lost results fails too, even when every result that arrived passed
// (scripts/report-complete.mjs).
//
// SHARD=i/n picks the files of shard i by their recorded run time (scripts/test-shards.ts), so
// the shards end close together. TEST_DURATIONS_OUT=<file> also writes each file's run time there.
//
// TEST_SELECT=<base commit>, which the workflow sets only on a pull request without the `ready`
// label, splits the test files the diff can reach instead of all of them (scripts/test-select.ts).
// Without it the selection is not loaded. With it, whatever the selection cannot place or cannot
// do runs every test file. A narrowed run writes no run times: they would not cover the suite.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileKey, reportProblems } from "./report-complete.mjs";
import { readDurations, shardFiles, testFiles } from "./test-shards.ts";

const MAX_RERUN = 5;
const shard = process.env.SHARD;
// --test-force-exit: a file whose tests are done exits even if a handle (a browser's pipe) is
// still open, so a leak can't hold the job until its time limit cancels it.
// --import test-blocking-stdout.mjs: with that flag a file can exit before the end of its report
// has left its process, so each file writes its report with blocking writes.
const blocking = new URL("./test-blocking-stdout.mjs", import.meta.url).href;
const node = (args) => spawnSync(process.execPath, ["--no-warnings", "--import", blocking, "--test", "--test-force-exit", ...args], { stdio: "inherit" }).status ?? 1;

/** The test files to split into shards, of `all`: `{ files, narrowed, log }`. */
async function pick(all) {
  if (!process.env.TEST_SELECT) return { files: all, narrowed: false, log: ["Running every test file: TEST_SELECT is not set"] };
  try {
    return (await import("./test-select.ts")).selectForRun(all, process.env, process.cwd());
  } catch (err) {
    return { files: all, narrowed: false, log: [`Running every test file: the selection could not be loaded (${err?.message ?? err})`] };
  }
}

const dir = mkdtempSync(join(tmpdir(), "coding-sh-test-ci-"));
const failedPath = join(dir, "failed.txt");
const reportPath = join(dir, "report.json");
const durationsOut = process.env.TEST_DURATIONS_OUT;
let files = process.argv.length > 2 ? process.argv.slice(2) : ["test/**/*.test.ts"];
// The test files this run can hold. An argument that is not a file (a flag, a pattern) names none.
let listed = process.argv.length > 2 ? files.filter((f) => existsSync(f)) : testFiles(process.cwd());
const args = [];
let narrowed = false;
if (shard && process.argv.length > 2) args.push(`--test-shard=${shard}`);
else if (shard) {
  const [i, n] = shard.split("/").map(Number);
  if (!(n >= 1 && i >= 1 && i <= n)) throw new Error(`SHARD must be i/n with 1 <= i <= n, got ${shard}`);
  const picked = await pick(testFiles(process.cwd()));
  console.log(picked.log.join("\n"));
  narrowed = picked.narrowed;
  files = listed = shardFiles(picked.files, readDurations(), i, n);
  console.log(`Shard ${shard}: ${files.length} test files${narrowed ? `\n${files.map((f) => `  ${f}`).join("\n")}` : ""}`);
  // Only a narrowed run can leave a shard with nothing to do.
  if (files.length === 0 && !narrowed) throw new Error(`shard ${shard} of every test file is empty`);
  if (files.length === 0) process.exit(0);
}
// The files whose reports must arrive whole. With --test-shard Node picks among the listed files,
// so only the totals are checked then.
const whole = shard && process.argv.length > 2 ? [] : listed;
args.push(
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  `--test-reporter=${new URL("./failed-files.mjs", import.meta.url).href}`, `--test-reporter-destination=${failedPath}`,
  `--test-reporter=${new URL("./report-complete.mjs", import.meta.url).href}`, `--test-reporter-destination=${reportPath}`,
);
// A narrowed run writes no run times, and no test of it may: a test that starts a runner of its
// own (test/scripts/test-ci.test.ts) would hand it the variable.
if (narrowed) delete process.env.TEST_DURATIONS_OUT;
if (durationsOut && narrowed) rmSync(durationsOut, { force: true });
else if (durationsOut) args.push(`--test-reporter=${new URL("./test-durations.mjs", import.meta.url).href}`, `--test-reporter-destination=${durationsOut}`);
const first = node([...args, ...files]);
let failed = [];
try {
  failed = readFileSync(failedPath, "utf8").split("\n").filter(Boolean);
} catch {}
let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch {}
rmSync(dir, { recursive: true, force: true });

const problems = reportProblems(whole, failed, report);
if (problems.length) console.log(`\nThe report of this run is incomplete, so the run fails:\n${problems.map((p) => `  ${p}`).join("\n")}`);
const lost = problems.length ? 1 : 0;

if (first === 0) process.exit(lost);
const name = (file) => relative(process.cwd(), file) || file;
const ours = new Set(listed.map(fileKey));
const elsewhere = failed.filter((f) => !ours.has(fileKey(f)));
if (elsewhere.length) {
  console.log(`\nA test failed in ${elsewhere.map(name).join(", ")}, which is not a test file of this run (a suite shared by test files?): not rerun.`);
  process.exit(first);
}
if (failed.length === 0 || failed.length > MAX_RERUN) {
  console.log(`\n${failed.length ? `${failed.length} files failed (more than ${MAX_RERUN}): not rerun.` : "The run failed outside any test: not rerun."}`);
  process.exit(first);
}

let code = 0;
for (const file of failed) {
  console.log(`\nRerunning ${name(file)} alone`);
  if (node(["--test-concurrency=1", file]) === 0) console.log(`::warning title=Passed when run alone::${name(file)} failed in the full run and passed alone (a timing test under load?)`);
  else code = 1;
}
process.exit(code || lost);
