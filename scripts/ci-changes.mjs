// Which CI jobs a pull request needs. Reads the changed paths, one per line, on stdin and prints
// `code=true` or `code=false` for $GITHUB_OUTPUT. code=false means every path is docs or site
// content that the skipped jobs never read: macOS, Windows, real capture, the CLI suite, the
// image, the stores, the Python SDK, the Node floor, the release smoke test and the action. The
// gate, the build job (site build, site check, budgets) and the Linux tests still run, and they
// check the generated docs. Anything else, or no paths at all, is code=true.
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
  if (!code) console.error(`Only docs and site files changed (${paths.filter((p) => p.trim()).length}): the code-only jobs are skipped.`);
}
