// CI test runner: every test file (one shard of them with SHARD=i/n), then each file that
// failed run again alone. The desk runners and GitHub's hosted runners share their machine with
// other jobs, and timing tests assume an idle machine (AGENTS.md: "If one fails under load, rerun
// it alone first"). A file that passes alone is reported as a warning; one that fails again fails
// the job. More than MAX_RERUN failed files is a real break and is not rerun.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const MAX_RERUN = 5;
const shard = process.env.SHARD;
const node = (args) => spawnSync(process.execPath, ["--no-warnings", "--test", ...args], { stdio: "inherit" }).status ?? 1;

const dir = mkdtempSync(join(tmpdir(), "coding-sh-test-ci-"));
const failedPath = join(dir, "failed.txt");
const first = node([
  ...(shard ? [`--test-shard=${shard}`] : []),
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  `--test-reporter=${new URL("./failed-files.mjs", import.meta.url).href}`, `--test-reporter-destination=${failedPath}`,
  ...(process.argv.length > 2 ? process.argv.slice(2) : ["test/**/*.test.ts"]),
]);
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
