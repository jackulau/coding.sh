// Grades an app-recon report against this fixture's answer key. Reusable in the
// continuous loop (references/dogfood.md step 3): a coding.sh eval verifier can
// shell out to this, or run it standalone.
//
//   node scripts/e2e/recon-fixture/verify.mjs <report.md>
//
// Exits 0 when the report names every endpoint, describes the login->feed auth
// chain, surfaces the planted artifacts, and states the authorization case;
// exits 1 and prints what is missing otherwise.
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: verify.mjs <report.md>\n");
  process.exit(2);
}
const text = readFileSync(path, "utf8").toLowerCase();
const has = (s) => text.includes(s.toLowerCase());

// Each check: a label and a predicate over the report text.
const checks = [
  ["names POST /api/login", () => has("/api/login")],
  ["names GET /api/feed", () => has("/api/feed")],
  ["names GET /api/config", () => has("/api/config")],
  ["describes the login -> feed auth chain", () => has("bearer") && has("token") && (has("401") || has("unauthor"))],
  ["surfaces makeHarderRanking", () => has("makeharderranking")],
  ["surfaces FEED_RANKING_SALT", () => has("feed_ranking_salt") || has("fixture-salt-7")],
  ["notes ANALYTICS_WRITE_KEY is public, not a secret", () => has("analytics_write_key") && (has("public") || has("not a secret") || has("publishable"))],
  ["states the authorization case", () => has("authorization") && (has("own") || has("case one"))],
];

const failed = checks.filter(([, fn]) => !fn());
for (const [label, fn] of checks) process.stdout.write(`${fn() ? "PASS" : "FAIL"}  ${label}\n`);
if (failed.length) {
  process.stdout.write(`\n${failed.length}/${checks.length} checks failed\n`);
  process.exit(1);
}
process.stdout.write(`\nall ${checks.length} checks passed\n`);
