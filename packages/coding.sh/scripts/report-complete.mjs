// A node:test reporter, and the check on what it writes. scripts/test-ci.mjs uses both to fail a
// run whose report has lost results.
//
// Each test file runs in its own process and ends its report with a test:summary event that names
// the file and counts its tests. A file whose report was cut short (nodejs/node issue 64833: the
// file exits with the end of its report unsent) still exits 0, so the run passes with fewer tests
// than ran. test-blocking-stdout.mjs stops that from happening; this notices if it happens anyway.
import { resolve } from "node:path";

/** Writes { summaries: { file: tests }, arrived }: each file's own count, and the results the run received. */
export default async function* reportComplete(source) {
  const summaries = {};
  let arrived = 0;
  for await (const event of source) {
    const data = event.data ?? {};
    if (event.type === "test:summary") {
      if (data.file) summaries[data.file] = data.counts?.tests ?? 0;
    } else if ((event.type === "test:pass" || event.type === "test:fail") && data.details?.type !== "suite") arrived++;
  }
  yield `${JSON.stringify({ summaries, arrived })}\n`;
}

/** One spelling per file: on Windows a path can differ in case and in its slashes. */
export const fileKey = (file) => (process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file));

/**
 * What is wrong with a run's report, one line per problem; none when it is whole. `files` are the
 * test files the run was given, `failed` the files with a failing test, `report` the reporter's
 * output (undefined when it wrote none).
 *
 * A file that failed is left to the caller: it is already loud. Every other file must have sent
 * its summary. The counts are compared as totals, because a test defined outside its test file (a
 * shared suite) arrives under the file that defines it; and only when no file failed, because a
 * file that died sends results and no summary.
 */
export function reportProblems(files, failed, report) {
  if (!report) return ["The run wrote no record of its report."];
  const summaries = new Map(Object.entries(report.summaries).map(([f, n]) => [fileKey(f), n]));
  const failedKeys = new Set(failed.map(fileKey));
  const out = files.filter((f) => !failedKeys.has(fileKey(f)) && !summaries.has(fileKey(f))).map((f) => `${f} did not send the end of its report: results of its tests may be missing.`);
  const counted = [...summaries.values()].reduce((a, n) => a + n, 0);
  if (failed.length === 0 && out.length === 0 && counted !== report.arrived) out.push(`The test files counted ${counted} tests and ${report.arrived} results arrived.`);
  return out;
}
