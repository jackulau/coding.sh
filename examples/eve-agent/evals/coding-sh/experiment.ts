// Run the weather dataset against the local eve agent as a coding.sh experiment.
//
//   npm run serve                  # terminal 1: eve dev --no-ui on :2000
//   npm run eval:coding-sh         # terminal 2
//   npm run eval:coding-sh -- --command   # same, through scripts/ask.mjs (command task)
//
// Env: EVE_URL (default http://127.0.0.1:2000), TRIALS (default 1).
// coding.sh is not published yet, so this imports its source from the monorepo.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDatasetFile } from "../../../../packages/coding.sh/src/datasets/dataset.ts";
import { createGrader, type GraderSpec } from "../../../../packages/coding.sh/src/graders/index.ts";
import { runExperiment } from "../../../../packages/coding.sh/src/experiments/run.ts";
import type { TaskSpec } from "../../../../packages/coding.sh/src/experiments/task.ts";
import { eveTask } from "../../../../packages/coding.sh/src/integrations/eve/index.ts";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.EVE_URL ?? "http://127.0.0.1:2000";

const health = await fetch(`${url}/eve/v1/health`).catch(() => undefined);
if (!health?.ok) {
  console.error(`No eve agent at ${url}. Start it first: npm run serve`);
  process.exit(2);
}

const dataset = await loadDatasetFile(join(here, "weather.jsonl"));
const specs = JSON.parse(readFileSync(join(here, "graders.json"), "utf8")) as GraderSpec[];
const graders = await Promise.all(specs.map((s) => createGrader(s, { baseDir: here })));

// In-process HTTP task (gives graders the trace), or the command task a CLI config would use.
const task: TaskSpec = process.argv.includes("--command")
  ? { kind: "command", command: process.execPath, args: [join(here, "../../scripts/ask.mjs")], env: { EVE_URL: url }, output: "json", timeoutMs: 120_000 }
  : eveTask({ url });

const result = await runExperiment({ name: "eve-weather", dataset, task, graders, trials: Number(process.env.TRIALS ?? 1), concurrency: 2 });

for (const run of result.runs) {
  const grades = run.grades.map((g) => `${g.graderId}=${g.error ? "ERR" : g.result!.pass ? "pass" : "FAIL"}`).join(" ");
  console.log(`${run.pass ? "PASS" : "FAIL"} ${run.caseId.padEnd(18)} ${run.latencyMs.toFixed(0).padStart(5)}ms ${run.error ?? grades}`);
  for (const g of run.grades) if (g.result && !g.result.pass && g.result.reason) console.log(`     ${g.graderId}: ${g.result.reason}`);
}
const s = result.summary;
console.log(`\n${s.passed}/${s.n} passed (${(s.passRate.p * 100).toFixed(0)}%, 95% CI ${(s.passRate.lo * 100).toFixed(0)}-${(s.passRate.hi * 100).toFixed(0)}%)`);
for (const g of s.graders) console.log(`  ${g.id.padEnd(14)} mean ${g.meanScore.toFixed(2)}  pass ${g.passed}/${g.n}`);
process.exitCode = s.passed === s.n ? 0 : 1;
