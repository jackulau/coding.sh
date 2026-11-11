// Page dates for the sitemap: each page is dated by the sources it is built from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pageLastmod, pageSources } from "../src/lib/lastmod.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const rel = (files) => files.map((f) => f.slice(REPO.length).replace(/\\/g, "/"));
const releases = [...readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8").matchAll(/^## \[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/gm)].map((m) => ({
  path: `/changelog/v${m[1].replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
  date: m[2],
}));

test("a CLI command page is dated by the registry its help comes from", () => {
  assert.deepEqual(rel(pageSources("/docs/cli/blame")), ["apps/site/src/pages/docs/cli/[command].astro", "packages/coding.sh/src/cli/registry.ts"]);
  assert.ok(rel(pageSources("/docs/cli")).includes("packages/coding.sh/src/cli/registry.ts"));
  assert.ok(!rel(pageSources("/docs/config")).includes("packages/coding.sh/src/cli/registry.ts"));
});

test("/changelog is dated by CHANGELOG.md and is never older than a release's notes", () => {
  assert.deepEqual(rel(pageSources("/changelog")), ["apps/site/src/pages/changelog.astro", "CHANGELOG.md"]);
  for (const r of releases) assert.ok(pageLastmod("/changelog") >= pageLastmod(r.path), r.path);
});

test("a released version's notes are dated by its own section, not by the newest change to the file", () => {
  assert.ok(releases.length >= 3);
  for (const r of releases) {
    const date = pageLastmod(r.path);
    assert.match(date, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(pageLastmod(`${r.path}/2`), date, "every page of the notes shares the date");
  }
  // Without git history (a copy, not a checkout) each falls back to its release date, which differ too.
  assert.ok(new Set(releases.map((r) => pageLastmod(r.path))).size > 1);
});

test("the git dates are the ones blame gives", { skip: !hasGit() }, () => {
  const oldest = releases.at(-1);
  assert.ok(pageLastmod(oldest.path) >= `${oldest.date}T00:00:00.000Z`);
});

function hasGit() {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}
