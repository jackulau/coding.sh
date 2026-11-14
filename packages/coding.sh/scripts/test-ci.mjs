// CI test runner: every test file (one shard of them with SHARD=i/n), then each file that
// failed run again alone. The desk runners and GitHub's hosted runners share their machine with
// other jobs, and timing tests assume an idle machine (AGENTS.md: "If one fails under load, rerun
// it alone first"). A file that passes alone is reported as a warning; one that fails again fails
// the job. More than MAX_RERUN failed files is a real break and is not rerun.
//
// SHARD=i/n picks the files of shard i by their recorded run time (scripts/test-shards.ts), so
// the shards end close together. TEST_DURATIONS_OUT=<file> also writes each file's run time there.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readDurations, shardFiles, testFiles } from "./test-shards.ts";

const MAX_RERUN = 5;
const shard = process.env.SHARD;
// --test-force-exit: a file whose tests are done exits even if a handle (a browser's pipe) is
// still open, so a leak can't hold the job until its time limit cancels it.
const node = (args) => spawnSync(process.execPath, ["--no-warnings", "--test", "--test-force-exit", ...args], { stdio: "inherit" }).status ?? 1;

const dir = mkdtempSync(join(tmpdir(), "coding-sh-test-ci-"));
const failedPath = join(dir, "failed.txt");
const durationsOut = process.env.TEST_DURATIONS_OUT;
let files = process.argv.length > 2 ? process.argv.slice(2) : ["test/**/*.test.ts"];
const args = [];
if (shard && process.argv.length > 2) args.push(`--test-shard=${shard}`);
else if (shard) {
  const [i, n] = shard.split("/").map(Number);
  if (!(n >= 1 && i >= 1 && i <= n)) throw new Error(`SHARD must be i/n with 1 <= i <= n, got ${shard}`);
  files = shardFiles(testFiles(process.cwd()), readDurations(), i, n);
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
if (failed.length === 0 || failed.length > MAX_RERUN) {
  console.log(`\n${failed.length ? `${failed.length} files failed (more than ${MAX_RERUN}): not rerun.` : "The run failed outside any test: not rerun."}`);
  process.exit(first);
}

let code = 0;
for (const file of failed) {
  const name = relative(process.cwd(), file) || file;
  console.log(`\nRerunning ${name} alone`);
  if (node(["--test-concurrency=1", file]) === 0) console.log(`::warning title=Passed when run alone::${name} failed in the full run and passed alone (a timing test under load?)`);
  else code = 1;
}
process.exit(code);
