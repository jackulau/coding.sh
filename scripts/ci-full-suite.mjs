// The "full suite" check of ci.yml: passes only when every job it needs ended in success.
// Reads NEEDS, the workflow's `toJSON(needs)`: {"<job>": {"result": "success" | "failure" |
// "cancelled" | "skipped", ...}}. A skipped job fails it: GitHub counts a skipped job as passed
// for a required check, and the full suite skips nothing. MAY_SKIP names the jobs, separated by
// spaces or commas, that may also end skipped: ci.yml sets it to the Site perf job off a pull
// request (a push to main, which site-perf.yml measures itself when the push touches the site,
// and a manual run). Any other result still fails those jobs.
//
//   NEEDS='{"test":{"result":"success"}}' node scripts/ci-full-suite.mjs
import { pathToFileURL } from "node:url";

/**
 * The jobs that did not end in success, as "<job>: <result>". A job named in `maySkip` also
 * passes when it was skipped. Throws when there are no jobs, or when `maySkip` names a job that
 * is not one of them.
 */
export function notPassed(needs, maySkip = []) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) throw new Error("NEEDS is not an object of jobs");
  const jobs = Object.entries(needs);
  if (jobs.length === 0) throw new Error("NEEDS names no jobs");
  const unknown = maySkip.filter((name) => !Object.hasOwn(needs, name));
  if (unknown.length) throw new Error(`MAY_SKIP names ${unknown.join(", ")}, not a job in NEEDS`);
  const passed = (name, result) => result === "success" || (result === "skipped" && maySkip.includes(name));
  return jobs.filter(([name, job]) => !passed(name, job?.result)).map(([name, job]) => `${name}: ${job?.result ?? "no result"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let bad;
  try {
    bad = notPassed(JSON.parse(process.env.NEEDS ?? ""), (process.env.MAY_SKIP ?? "").split(/[\s,]+/).filter(Boolean));
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
