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
// SHARD=i/n picks the files of shard i by their recorded run time (scripts/test-shards.ts), so
// the shards end close together. TEST_DURATIONS_OUT=<file> also writes each file's run time there.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDurations, shardFiles, testFiles } from "./test-shards.ts";

const MAX_RERUN = 5;
const shard = process.env.SHARD;
// --test-force-exit: a file whose tests are done exits even if a handle (a browser's pipe) is
// still open, so a leak can't hold the job until its time limit cancels it.
// --import test-blocking-stdout.mjs: with that flag a file can exit before the end of its report
// has left its process, so each file writes its report with blocking writes.
const blocking = new URL("./test-blocking-stdout.mjs", import.meta.url).href;
// DIAGNOSTICS ONLY: trace every test process, and run the samplers beside the tests.
const traceDir = process.env.CSH_TRACE_DIR;
const diag = traceDir ? ["--import", new URL("./diag-preload.mjs", import.meta.url).href] : [];
if (traceDir) {
  const here = (f) => new URL(f, import.meta.url);
  const kids = [spawn(process.execPath, ["--no-warnings", fileURLToPath(here("./diag-heartbeat.mjs"))], { stdio: "ignore" })];
  if (process.platform === "win32") {
    kids.push(spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(here("./diag-procs.ps1")), "-Out", `${traceDir}\\procs.txt`], { stdio: "ignore" }));
    kids.push(spawn("typeperf.exe", ["\\Processor(_Total)\\% Processor Time", "\\PhysicalDisk(_Total)\\Current Disk Queue Length", "\\PhysicalDisk(_Total)\\Disk Read Bytes/sec", "\\PhysicalDisk(_Total)\\Disk Write Bytes/sec", "\\PhysicalDisk(_Total)\\Avg. Disk sec/Read", "\\PhysicalDisk(_Total)\\Avg. Disk sec/Write", "\\Memory\\Available MBytes", "\\Memory\\Pages/sec", "\\System\\Processor Queue Length", "\\System\\Context Switches/sec", "-si", "1", "-o", `${traceDir}\\perf.csv`, "-y"], { stdio: "ignore" }));
  }
  for (const k of kids) k.on("error", (e) => console.log(`diag: ${e.message}`));
  process.on("exit", () => {
    for (const k of kids) k.kill();
  });
}
const node = (args) => spawnSync(process.execPath, ["--no-warnings", "--import", blocking, ...diag, "--test", "--test-force-exit", ...args], { stdio: "inherit" }).status ?? 1;

const dir = mkdtempSync(join(tmpdir(), "coding-sh-test-ci-"));
const failedPath = join(dir, "failed.txt");
const durationsOut = process.env.TEST_DURATIONS_OUT;
let files = process.argv.length > 2 ? process.argv.slice(2) : ["test/**/*.test.ts"];
// The test files this run can hold. An argument that is not a file (a flag, a pattern) names none.
let listed = process.argv.length > 2 ? files.filter((f) => existsSync(f)) : testFiles(process.cwd());
const args = [];
if (shard && process.argv.length > 2) args.push(`--test-shard=${shard}`);
else if (shard) {
  const [i, n] = shard.split("/").map(Number);
  if (!(n >= 1 && i >= 1 && i <= n)) throw new Error(`SHARD must be i/n with 1 <= i <= n, got ${shard}`);
  files = listed = shardFiles(testFiles(process.cwd()), readDurations(), i, n);
  console.log(`Shard ${shard}: ${files.length} test files`);
  if (files.length === 0) process.exit(0);
}
args.push(
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  `--test-reporter=${new URL("./failed-files.mjs", import.meta.url).href}`, `--test-reporter-destination=${failedPath}`,
);
if (durationsOut) args.push(`--test-reporter=${new URL("./test-durations.mjs", import.meta.url).href}`, `--test-reporter-destination=${durationsOut}`);
const first = node([...args, ...files]);
let failed = [];
try {
  failed = readFileSync(failedPath, "utf8").split("\n").filter(Boolean);
} catch {}
rmSync(dir, { recursive: true, force: true });

if (first === 0) process.exit(0);
const name = (file) => relative(process.cwd(), file) || file;
const key = (file) => (process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file));
const ours = new Set(listed.map(key));
const elsewhere = failed.filter((f) => !ours.has(key(f)));
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
process.exit(code);
