// CHANGELOG.md keeps one shape, so /changelog stays short and navigable:
//   ## [x.y.z] - YYYY-MM-DD   (or "- Unreleased"), versions newest first
//   ### Added | Changed | Fixed | Removed | Deprecated | Security | Performance
//   - **Area.** What changed in at most 60 words, with a link to the docs.
// Older releases were written before this rule. BASELINE holds, per version,
// how many bullets still break it; the counts may only go down. When a count
// drops, lower it here (the test says so); do not raise it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DIST = join(ROOT, "apps/site/dist");
const MAX_WORDS = 60;
const SECTIONS = ["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security", "Performance"];

// Bullets over 60 words and bullets with no link, as counted on 2026-11-11.
// 0.1.7 is the unreleased version: its one long bullet is waiting to be shortened.
export const BASELINE = {
  "0.1.7": { over60: 0, nolink: 0 },
  "0.1.6": { over60: 63, nolink: 3 },
  "0.1.5": { over60: 15, nolink: 0 },
  "0.1.4": { over60: 0, nolink: 0 },
  "0.1.3": { over60: 23, nolink: 0 },
  "0.1.2": { over60: 76, nolink: 19 },
  "0.1.1": { over60: 0, nolink: 34 },
  "0.1.0": { over60: 0, nolink: 48 },
};

/** Parse a changelog into releases with their bullets and every shape problem that is not a count. */
export function parseChangelog(md) {
  const lines = md.split("\n");
  const releases = [];
  const problems = [];
  let rel = null;
  let section = null;
  lines.forEach((line, i) => {
    const at = `CHANGELOG.md:${i + 1}`;
    if (line.startsWith("## ")) {
      const m = /^## \[(\d+\.\d+\.\d+)\] - (Unreleased|\d{4}-\d{2}-\d{2})$/.exec(line);
      if (!m) problems.push(`${at}: heading is not "## [x.y.z] - YYYY-MM-DD" or "- Unreleased": ${line}`);
      rel = { version: m?.[1] ?? line, date: m?.[2], bullets: [] };
      releases.push(rel);
      section = null;
    } else if (line.startsWith("### ")) {
      section = line.slice(4).trim();
      if (!SECTIONS.includes(section)) problems.push(`${at}: section "${section}" is not one of ${SECTIONS.join(", ")}`);
    } else if (line.startsWith("- ") && rel) {
      let text = line;
      for (let j = i + 1; j < lines.length && lines[j].startsWith("  "); j++) text += " " + lines[j].trim();
      if (!section) problems.push(`${at}: a bullet outside a ### section`);
      rel.bullets.push({ at, text, words: text.split(/\s+/).length - 1 });
      if (!/^- \*\*[^*]+\.\*\* \S/.test(text)) problems.push(`${at}: a bullet starts with a bold area ("- **Sessions.** ..."): ${text.slice(0, 60)}`);
    }
  });
  const dated = releases.filter((r) => r.date && r.date !== "Unreleased").map((r) => r.date);
  if (dated.some((d, i) => i > 0 && d > dated[i - 1])) problems.push("releases are not newest first");
  return { releases, problems };
}

/** Bullets over the word budget and bullets with no link, by version. */
export function counts(releases) {
  return Object.fromEntries(
    releases.map((r) => [
      r.version,
      { over60: r.bullets.filter((b) => b.words > MAX_WORDS).length, nolink: r.bullets.filter((b) => !/\]\((?:https?:\/\/|\.{0,2}\/|#)[^)]+\)|https?:\/\/\S+/.test(b.text)).length },
    ]),
  );
}

const md = () => readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

test("a long bullet with no link or bold area is reported (seeded)", () => {
  const long = Array.from({ length: 70 }, () => "word").join(" ");
  const { releases, problems } = parseChangelog(`## [9.9.9] - Unreleased\n\n### Added\n\n- ${long}\n- **Cost.** short and linked [docs](https://coding.sh/docs/cost).\n`);
  assert.equal(problems.length, 1);
  assert.deepEqual(counts(releases)["9.9.9"], { over60: 1, nolink: 1 });
  assert.equal(parseChangelog("## 1.0 - today\n").problems.length, 1);
  assert.equal(parseChangelog("## [1.0.0] - 2026-01-01\n\n### Misc\n").problems.length, 1);
});

test("CHANGELOG.md headings, sections and bullets have the shape", () => {
  const { problems } = parseChangelog(md());
  assert.deepEqual(problems, []);
});

test("a version not in BASELINE has no long bullet and no bullet without a link", () => {
  const found = [];
  for (const [v, c] of Object.entries(counts(parseChangelog(md()).releases))) {
    if (v in BASELINE) continue;
    if (c.over60) found.push(`${v}: ${c.over60} bullet(s) over ${MAX_WORDS} words`);
    if (c.nolink) found.push(`${v}: ${c.nolink} bullet(s) with no link`);
  }
  assert.deepEqual(found, [], "Write new bullets in the shape: a bold area, at most 60 words, a link to the docs");
});

test("BASELINE counts only go down", () => {
  const actual = counts(parseChangelog(md()).releases);
  const up = [];
  const down = [];
  for (const [v, b] of Object.entries(BASELINE)) {
    const c = actual[v] ?? { over60: 0, nolink: 0 };
    for (const k of ["over60", "nolink"]) {
      if (c[k] > b[k]) up.push(`${v} ${k}: ${c[k]} now, baseline ${b[k]}`);
      if (c[k] < b[k]) down.push(`${v} ${k}: ${c[k]} now, baseline ${b[k]}; lower it in BASELINE`);
    }
  }
  assert.deepEqual(up, [], "A released version got worse");
  assert.deepEqual(down, [], "A count went down; record it so it cannot come back up");
});

test("the built changelog links each version's page and anchor", distOpts(join(DIST, "changelog")), () => {
  needDist(join(DIST, "changelog"));
  const html = readFileSync(join(DIST, "changelog/index.html"), "utf8");
  const missing = [];
  for (const r of parseChangelog(md()).releases) {
    const slug = `v${r.version.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    if (!html.includes(`href="/changelog/${slug}"`)) missing.push(`${r.version}: no link to /changelog/${slug}`);
    if (!html.includes(`id="${slug}"`)) missing.push(`${r.version}: no #${slug} anchor`);
  }
  assert.deepEqual(missing, []);
  assert.ok(existsSync(join(DIST, "changelog")));
});
