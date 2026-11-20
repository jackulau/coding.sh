// docs/RELEASE.md describes the release workflow as it is. Reads files; runs nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const doc = readFileSync(join(ROOT, "docs/RELEASE.md"), "utf8");
const release = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");

test("RELEASE.md counts the npm tarballs the workflow packs", () => {
  const packed = /for p in ([a-z0-9.\- ]+); do/.exec(release)[1].trim().split(/\s+/);
  assert.equal(packed.length, 5);
  assert.match(doc, /packs the five npm tarballs/);
  assert.ok(doc.includes("coding.sh-store-clickhouse"));
  assert.ok(!/packs the four npm tarballs/.test(doc));
});

test("verify refuses a tag whose commit is not on main, before any job publishes", () => {
  const verify = release.slice(release.indexOf("\n  verify:"), release.indexOf("\n  github-release:"));
  assert.match(verify, /compare\/main\.\.\.\$GITHUB_SHA/);
  assert.match(verify, /identical\|behind\) ;;/);
  assert.ok(verify.indexOf("compare/main...") < verify.indexOf("Tag matches package version"), "the check runs first");
  for (const job of ["github-release", "publish-image", "publish-npm", "publish-pypi"]) {
    const at = release.indexOf(`\n  ${job}:`);
    assert.match(release.slice(at, at + 200), /needs: (verify|\[verify, github-release\])/, `${job} needs verify`);
  }
  assert.match(doc, /points\s+at a commit that is on `main`/);
});

test("every action the release workflow runs is pinned to a commit, not a tag or branch", () => {
  const uses = [...release.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 10);
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${ref} is not pinned to a commit`);
    assert.match(rest, /^ # v\d+\.\d+\.\d+$/, `${ref} has no version comment`);
  }
  assert.match(doc, /pinned to a full commit/);
});

test("RELEASE.md names publish-image, the Vercel deploy, its secret and the Worker fallback", () => {
  assert.ok(doc.includes("publish-image"));
  assert.ok(doc.includes("### Vercel (`coding-sh`)"));
  assert.ok(doc.includes("VERCEL_TOKEN"));
  assert.ok(doc.includes("coding-sh-site"));
  assert.ok(!doc.includes("Cloudflare Pages"));
  assert.ok(!doc.includes("wrangler pages"));
});

test("RELEASE.md names the shipped schema and shell hook, and the timing-test rule", () => {
  assert.ok(doc.includes("dist/schema.json") && doc.includes("dist/hook.sh"));
  assert.match(doc, /timing test fails on a busy machine/);
});

const publish = readFileSync(join(ROOT, "scripts/release/publish-npm.sh"), "utf8");
const smoke = readFileSync(join(ROOT, "scripts/release/smoke.sh"), "utf8");
/** The npm packages publish-npm.sh publishes, in its order. */
const published = /for name in ([@a-z0-9./\- ]+); do/.exec(publish)[1].trim().split(/\s+/);

test("RELEASE.md's package table lists every npm package publish-npm.sh publishes, and the PyPI one", () => {
  const table = [...doc.matchAll(/^\| `([^`]+)`[^|]*\| (npm|PyPI) \| `([^`]+)` \|$/gm)];
  const npm = table.filter((m) => m[2] === "npm").map((m) => m[1]);
  assert.deepEqual([...npm].sort(), [...published].sort());
  assert.equal(table.filter((m) => m[2] === "PyPI").length, 1);
  // Each Source column is the package dir whose package.json carries that name.
  for (const [, name, reg, dir] of table) {
    if (reg !== "npm") continue;
    assert.equal(JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")).name, name, `${dir} is ${name}`);
  }
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
  assert.ok(doc.includes(`publishes ${words[published.length + 1]} packages, ${words[published.length]} on npm and one on PyPI`));
});

test("RELEASE.md's npm trust loop covers every package publish-npm.sh publishes", () => {
  const loop = /for p in ([@a-z0-9./\- ]+); do\n\s+npx -y npm@11 trust/.exec(doc);
  assert.ok(loop, "the trust loop is in RELEASE.md");
  assert.deepEqual(loop[1].trim().split(/\s+/), published);
});

test("the release checklist's bump list names every package dir but the CLI", () => {
  const bump = /- \[ \] Bump ([^\n]+(?:\n {6}[^\n]+)*)/.exec(doc)[1];
  const table = [...doc.matchAll(/^\| `[^`]+`[^|]*\| (?:npm|PyPI) \| `(packages\/[^`]+)` \|$/gm)].map((m) => m[1]);
  for (const dir of table) if (dir !== "packages/coding.sh") assert.ok(bump.includes(`\`${dir}\``), `the bump list names ${dir}`);
});

test("smoke.sh checks dist/hook.sh, as RELEASE.md says", () => {
  assert.match(doc, /dist\/hook\.sh[^.]*checked by `scripts\/release\/smoke\.sh`/);
  assert.match(smoke, /dist\/hook\.sh/);
  assert.match(smoke, /\/bin\/sh "\$H" claude-code/);
});
