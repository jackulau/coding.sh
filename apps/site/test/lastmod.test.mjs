// Page dates for the sitemap: each page is dated by the sources it is built from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// astro build writes the sitemap and gen-agent-text writes the Markdown twins, each in its own
// process. A date read from the clock differed between them, so a build that crossed midnight
// UTC with uncommitted edits failed seo-check's [twin-date].
test("an uncommitted edit is dated by when the file was last written, the same in every build step", { skip: !hasGit() }, () => {
  const root = mkdtempSync(join(tmpdir(), "site-lastmod-"));
  try {
    // A copy of the module dates the pages of the throwaway repo around it.
    const lib = join(root, "apps/site/src/lib");
    const page = join(root, "apps/site/src/pages/docs/page.astro");
    const changelog = join(root, "CHANGELOG.md");
    for (const dir of [lib, join(root, "apps/site/src/i18n"), join(root, "apps/site/src/pages/docs")]) mkdirSync(dir, { recursive: true });
    copyFileSync(fileURLToPath(new URL("../src/lib/lastmod.mjs", import.meta.url)), join(lib, "lastmod.mjs"));
    copyFileSync(fileURLToPath(new URL("../src/i18n/locales.mjs", import.meta.url)), join(root, "apps/site/src/i18n/locales.mjs"));
    writeFileSync(page, "---\n---\n<p>page</p>\n");
    writeFileSync(changelog, "# Changelog\n\n## [0.2.0] - 2001-01-01\n\n- two\n\n## [0.1.0] - 2000-01-01\n\n- one\n");
    // Without the outer repo's GIT_* variables (a git hook sets some), git uses the throwaway repo.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: root, env, stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    appendFileSync(page, "<p>edited</p>\n");
    writeFileSync(changelog, readFileSync(changelog, "utf8").replace("- one", "- one, edited"));
    utimesSync(page, new Date("2001-02-03T04:05:06Z"), new Date("2001-02-03T04:05:06Z"));
    utimesSync(changelog, new Date("2002-03-04T05:06:07Z"), new Date("2002-03-04T05:06:07Z"));
    const probe = join(root, "probe.mjs");
    writeFileSync(probe, 'import { pageLastmod } from "./apps/site/src/lib/lastmod.mjs";\nconsole.log(JSON.stringify([pageLastmod("/docs/page"), pageLastmod("/changelog/v0-1-0")]));\n');
    for (const step of ["sitemap", "twins"]) {
      const dates = JSON.parse(execFileSync(process.execPath, [probe], { cwd: root, env, encoding: "utf8" }));
      assert.deepEqual(dates, ["2001-02-03T04:05:06.000Z", "2002-03-04T05:06:07.000Z"], step);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function hasGit() {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "true";
  } catch {
    return false;
  }
}
