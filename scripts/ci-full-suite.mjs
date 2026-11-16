// The "full suite" check of ci.yml: passes only when every job it needs ended in success.
// Reads NEEDS, the workflow's `toJSON(needs)`: {"<job>": {"result": "success" | "failure" |
// "cancelled" | "skipped", ...}}. A skipped job fails it: GitHub counts a skipped job as passed
// for a required check, and the full suite skips nothing.
//
//   NEEDS='{"test":{"result":"success"}}' node scripts/ci-full-suite.mjs
import { pathToFileURL } from "node:url";

/** The jobs that did not end in success, as "<job>: <result>". Throws when there are no jobs. */
export function notPassed(needs) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) throw new Error("NEEDS is not an object of jobs");
  const jobs = Object.entries(needs);
  if (jobs.length === 0) throw new Error("NEEDS names no jobs");
  return jobs.filter(([, job]) => job?.result !== "success").map(([name, job]) => `${name}: ${job?.result ?? "no result"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let bad;
  try {
    bad = notPassed(JSON.parse(process.env.NEEDS ?? ""));
  } catch (err) {
    console.error(`full suite: ${err.message}`);
    process.exit(1);
  }
  if (bad.length) {
    console.error(`full suite: ${bad.length} ${bad.length === 1 ? "job" : "jobs"} did not pass`);
    for (const line of bad) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log("full suite: every job passed");
}
