// Which CI jobs a pull request needs. Reads the changed paths, one per line, on stdin and prints
// `code=true` or `code=false` for $GITHUB_OUTPUT. code=false means every path is docs or site
// content that the skipped jobs never read: the stores, the Python SDK, the Node floor, the
// release smoke test and the action. The gate, the build job (site build, site check, budgets)
// and the Linux tests still run, and they check the generated docs. Anything else, or no paths
// at all, is code=true. The full suite (ci.yml) does not ask: it runs every job.
//
// It also prints `site_perf=true` or `site_perf=false`: whether the paths touch what the Site
// perf workflow measures, so the pull request gets the Lighthouse A/B before it has the `ready`
// label. No paths at all is site_perf=true.
//
//   git diff --name-only --no-renames HEAD^1 HEAD | node scripts/ci-changes.mjs
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DOCS_ONLY = [
  /^docs\//,
  /^apps\/site\//,
  /^[^/]+\.md$/, // README, CHANGELOG, AGENTS, CONTRIBUTING and the rest at the root
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/[^/]+\.md$/,
  /^LICENSE$/,
];

// The `paths` of .github/workflows/site-perf.yml's push trigger, in the same order
// (scripts/lint/test/ci-changes.test.mjs checks the two match). As in a workflow, the last
// pattern that matches a path decides, and one starting with "!" excludes it.
export const SITE_PERF_PATHS = [
  "apps/site/**",
  "!apps/site/test/**",
  "!apps/site/scripts/shots/**",
  "!apps/site/scripts/perf-budget.mjs",
  "!apps/site/scripts/seo-check.mjs",
  "!apps/site/scripts/indexnow.mjs",
  "!apps/site/src/content/**",
  "!apps/site/src/pages/**",
  "apps/site/src/pages/index.astro",
  "apps/site/src/pages/changelog.astro",
  "apps/site/src/pages/docs/quickstart.astro",
  "apps/site/src/pages/docs/evals.astro",
  "apps/site/src/pages/docs/cli.astro",
  "scripts/perf/**",
  ".github/workflows/site-perf.yml",
];

// The two shapes the list uses: a whole path, or a directory and everything under it.
function matches(pattern, path) {
  return pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -2)) : path === pattern;
}

/** True when the path is one the Site perf workflow runs for. */
export function sitePerfPath(path) {
  let hit = false;
  for (const entry of SITE_PERF_PATHS) {
    const exclude = entry.startsWith("!");
    if (matches(exclude ? entry.slice(1) : entry, path)) hit = !exclude;
  }
  return hit;
}

/** True when a pull request with these changed paths gets the Site perf A/B. */
export function needsSitePerf(paths) {
  const files = paths.map((p) => p.trim()).filter(Boolean);
  return files.length === 0 || files.some(sitePerfPath);
}

export function docsOnly(path) {
  return DOCS_ONLY.some((re) => re.test(path));
}

/** True when the full CI matrix must run for these changed paths. */
export function needsCode(paths) {
  const files = paths.map((p) => p.trim()).filter(Boolean);
  return files.length === 0 || files.some((f) => !docsOnly(f));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = readFileSync(0, "utf8").split("\n");
  const code = needsCode(paths);
  console.log(`code=${code}`);
  console.log(`site_perf=${needsSitePerf(paths)}`);
  if (!code) console.error(`Only docs and site files changed (${paths.filter((p) => p.trim()).length}): the code-only jobs are skipped.`);
}
