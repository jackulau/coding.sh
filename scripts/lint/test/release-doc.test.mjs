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
  // A failed request is tried again, and a request that never succeeds stops the release with
  // its own error before the case below could read the empty status as "not on main".
  assert.match(verify, /\n +for try in 1 2 3 4 5; do\n +status=\$\(gh api "repos\/\$GITHUB_REPOSITORY\/compare\/main\.\.\.\$GITHUB_SHA" --jq \.status\) \|\| status=\n +\[ -z "\$status" \] \|\| break\n/, "a failed request is tried again");
  const noAnswer = verify.indexOf('if [ -z "$status" ]; then\n');
  assert.ok(noAnswer > -1 && noAnswer < verify.indexOf('case "$status" in'), "no answer fails before the case");
  // A tag with no history in common with main gets a 404 from the compare API, so the error says so.
  assert.match(verify, /::error::the compare API failed 5 times[^\n]*An HTTP 404 that says 'No common ancestor' means/);
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

test("RELEASE.md says update and the install script install the latest GitHub release, npm's latest without GitHub", () => {
  // update asks GitHub's releases/latest first and npm's registry only when GitHub fails.
  const refresh = readFileSync(join(ROOT, "packages/coding.sh/src/update/refresh.ts"), "utf8");
  const github = refresh.indexOf("/releases/latest`");
  const npm = refresh.indexOf("encodeURIComponent(a.npmName)}/latest`");
  assert.ok(github >= 0 && npm > github, "update asks GitHub first");
  // The install script asks GitHub before npm unless a version or source is given.
  const install = readFileSync(join(ROOT, "install.sh"), "utf8");
  const asks = install.indexOf("VERSION=$(github_latest)");
  assert.ok(asks >= 0 && asks < install.indexOf('NPM_VERSION=$(npm_has "${SPEC:-latest}")'), "install.sh asks GitHub first");
  const six = doc.replace(/\s+/g, " ");
  assert.match(six, /install \| sh` installs the latest GitHub release/);
  assert.match(six, /`coding\.sh update` installs the latest GitHub release from its tarball/);
  assert.match(six, /When GitHub does not answer, both install npm's latest/);
  assert.ok(!six.includes("newest of the two"));
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
