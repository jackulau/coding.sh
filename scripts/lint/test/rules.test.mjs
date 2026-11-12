import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lineOf, lineStarts } from "../lib/source.mjs";
import { RULES, RULE_IDS } from "../lib/rules.mjs";
import { lintFiles, parseAllowlist } from "../lib/lint.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const MARK = "slop:expect";

/** Lines (1-based) marked `slop:expect` in a fixture. */
const expected = (src) => src.split("\n").flatMap((l, i) => (l.includes(MARK) ? [i + 1] : []));

/** Where each rule's fixtures live, so `applies` sees a path the rule owns. */
const FIXTURE_DIR = {
  "site-placeholder": "apps/site/src/fixture",
  "site-voice": "apps/site/src/fixture",
  "universal-transition": "apps/site/src/fixture",
  "reduced-motion": "apps/site/src/fixture",
  "global-install": "scripts/fixture",
};

/** Lines a rule reports for a fixture, as the path the rule would see. */
function reported(rule, name, src) {
  const path = `${FIXTURE_DIR[rule.id] ?? "packages/demo/src"}/${name}`;
  assert.ok(rule.applies(path, new Set()), `${rule.id} should read ${path}`);
  const starts = lineStarts(src);
  return [...new Set(rule.check(path, src).map((f) => lineOf(starts, f.offset)))].sort((a, b) => a - b);
}

for (const rule of RULES) {
  const dir = join(FIXTURES, rule.id);
  const files = readdirSync(dir).sort();
  test(`${rule.id}: has a failing and a passing fixture`, () => {
    assert.ok(files.some((f) => f.startsWith("bad")), "needs a bad* fixture");
    assert.ok(files.some((f) => f.startsWith("good")), "needs a good* fixture");
  });
  for (const name of files) {
    test(`${rule.id}: ${name}`, () => {
      const src = readFileSync(join(dir, name), "utf8");
      const want = expected(src);
      if (name.startsWith("bad")) assert.ok(want.length > 0, `${name} marks no line with ${MARK}`);
      else assert.deepEqual(want, [], `${name} is a good fixture and must not mark lines`);
      assert.deepEqual(reported(rule, name, src), want);
    });
  }
}

test("rules skip files they do not own", () => {
  const byId = Object.fromEntries(RULES.map((r) => [r.id, r]));
  assert.equal(byId["chained-as"].applies("src/x.mjs", new Set()), false);
  assert.equal(byId["chained-as"].applies("src/types.d.ts", new Set()), false);
  assert.equal(byId["conditional-empty-spread"].applies("src/x.mjs", new Set()), true);
  assert.equal(byId["site-placeholder"].applies("docs/concepts.md", new Set()), false);
  assert.equal(byId["site-placeholder"].applies("docs/concepts.md", new Set(["docs/concepts.md"])), true);
  assert.equal(byId["site-placeholder"].applies("apps/site/src/styles/doc.css", new Set()), false);
  assert.equal(byId["site-placeholder"].applies("apps/site/src/pages/index.astro", new Set()), true);
});

test("chained-as reads the frontmatter and scripts of .astro files, not the template", () => {
  const rule = RULES.find((r) => r.id === "chained-as");
  const src = "---\nconst a = b as unknown as C;\n---\n<p>x as unknown as y</p>\n<script>const d = e as unknown as F;</script>\n";
  const starts = lineStarts(src);
  assert.deepEqual(rule.check("apps/site/src/x.astro", src).map((f) => lineOf(starts, f.offset)), [2, 5]);
});

test("unknown-param names the parameter in its message", () => {
  const rule = RULES.find((r) => r.id === "unknown-param");
  const [f] = rule.check("src/x.ts", "export const f = (payload: unknown) => (payload as { a: 1 }).a;\n");
  assert.match(f.message, /`payload: unknown`/);
});

// ---------------------------------------------------------------- vendor-literal, built at runtime

const byId = (id) => RULES.find((r) => r.id === id);
const messages = (id, path, src) => byId(id).check(path, src).map((f) => f.message);

// These values are built with join so this file passes its own rule.
const STRIPE = ["sk_te", "st_", "4eC39HqLyjWDarjtT1zdp7dc"].join("");
const AWS = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const GITHUB = ["ghp_", "a".repeat(36)].join("");
const MARIA = ["", "Users", "maria"].join("/");
const SLACK = ["xox", "b-", "123456789012-abcdefghijkl"].join("");

test("vendor-literal flags a whole vendor-shaped value, whatever the file type", () => {
  for (const [path, src] of [
    ["packages/x/test/a.test.ts", `const k = "${STRIPE}";\n`],
    ["packages/x/test/a.test.js", `const k = '${AWS}';\n`],
    ["docs/guide.md", `Use ${GITHUB} here.\n`],
    ["scripts/x.yml", `token: ${SLACK}\n`],
  ]) {
    assert.equal(byId("vendor-literal").applies(path, new Set()), true, path);
    assert.equal(byId("vendor-literal").check(path, src).length, 1, path);
  }
  assert.match(messages("vendor-literal", "a.ts", `x = "${AWS}"`)[0], /vendor-shaped literal/);
});

test("vendor-literal flags the AWS docs example shape and a + split, with the join advice", () => {
  assert.equal(byId("vendor-literal").check("a.md", `${["AKIA", "EXAMPLEEXAMPLEEXAMPLE"].join("")} and ${AWS}`).length >= 1, true);
  const split = messages("vendor-literal", "a.ts", `const a = "sk_te" + "st_" + x;\nconst b = "${["sk_te", "st_"].join("")}" + x;\n`);
  assert.deepEqual(split, ['build vendor-shaped literals with [..].join(""); esbuild folds +']);
});

test("vendor-literal leaves the join form, regex sources and a bare prefix alone", () => {
  const ok = [`const a = ["${["sk_te", "st_"].join("")}", id].join("");`, "const re = /ghp_[0-9A-Za-z]{36}/;", `const p = "${["ghp", "_"].join("")}";`, `const t = \`${["npm", "_"].join("")}\${x}\`;`];
  for (const src of ok) assert.deepEqual(byId("vendor-literal").check("a.ts", src), [], src);
});

test("vendor-literal does not read lockfiles, and skips an invented Anthropic key and a PEM header", () => {
  assert.equal(byId("vendor-literal").applies("package-lock.json", new Set()), false);
  assert.deepEqual(byId("vendor-literal").check("a.ts", `const a = "${["sk-ant-", "api03-", "A".repeat(30)].join("")}"; // BEGIN PRIVATE KEY`), []);
});

test("the shared SECRET_PATTERNS drive vendor-literal: a stripe live key and a slack token both match", () => {
  assert.equal(byId("vendor-literal").check("a.ts", `"${["sk_li", "ve_", "51H8abcdefghijklmnop"].join("")}"`).length, 1);
  assert.equal(byId("vendor-literal").check("a.md", SLACK).length, 1);
});

// ---------------------------------------------------------------- the new rules own the right files

test("site-voice, universal-transition, reduced-motion, global-install and personal-data pick their files", () => {
  const site = new Set(["docs/guides/evals.md"]);
  assert.equal(byId("site-voice").applies("README.md", site), true);
  assert.equal(byId("site-voice").applies("packages/sdk/README.md", site), true);
  assert.equal(byId("site-voice").applies("docs/guides/evals.md", site), true);
  assert.equal(byId("site-voice").applies("docs/design/x.md", site), false);
  assert.equal(byId("universal-transition").applies("apps/site/src/styles/global.css", site), true);
  assert.equal(byId("universal-transition").applies("packages/coding.sh/src/viewer/ui/index.html", site), true);
  assert.equal(byId("universal-transition").applies("packages/coding.sh/src/x.css", site), false);
  assert.equal(byId("reduced-motion").applies("apps/site/src/components/CubeField.astro", site), true);
  assert.equal(byId("global-install").applies("scripts/e2e/real-capture.mjs", site), true);
  assert.equal(byId("global-install").applies(".github/workflows/ci.yml", site), true);
  assert.equal(byId("global-install").applies("install.sh", site), false);
  assert.equal(byId("global-install").applies("packages/coding.sh/test/update/command.test.ts", site), false);
  assert.equal(byId("personal-data").applies("packages/coding.sh/test/fixtures/adapters/x/a.jsonl", site), true);
  assert.equal(byId("personal-data").fixtures, true);
});

test("site-voice names the word, the dash and the label in its messages", () => {
  const found = messages("site-voice", "apps/site/src/pages/a.astro", "<p>A powerful tool — fast. See s_8f3a21.</p>");
  assert.equal(found.length, 3);
  assert.match(found[0], /"powerful" is a marketing word/);
  assert.ok(found.some((m) => /spaced em dash/.test(m)));
  assert.ok(found.some((m) => /id-style label/.test(m)));
});

test("site-voice reads strings in site data files and skips code and table rows", () => {
  assert.equal(messages("site-voice", "apps/site/src/data/x.ts", 'export const a = "Unlock your data"; // seamless\n').length, 1);
  assert.deepEqual(messages("site-voice", "README.md", "| a — b | c |\n\nUse `a — b` here.\n"), []);
});

test("universal-transition ignores `transition: none` on * and reads rules inside @media", () => {
  assert.deepEqual(messages("universal-transition", "apps/site/src/a.css", "@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }"), []);
  assert.equal(messages("universal-transition", "apps/site/src/a.css", "@media (min-width: 1px) { * { transition: all 1s; } }").length, 1);
});

test("personal-data names the user, and allows example domains, noreply addresses and user:password@host", () => {
  assert.match(messages("personal-data", "a.md", `see ${MARIA}/code`)[0], /\(maria\)/);
  assert.deepEqual(messages("personal-data", "a.md", "a@example.com b@x.example.test noreply@anthropic.com 1+u@users.noreply.github.com https://u:p@abc.clickhouse.cloud/db"), []);
  assert.equal(messages("personal-data", "a.md", `mail ${["me", "initech.io"].join("@")}`).length, 1);
  assert.equal(messages("personal-data", "a.md", `git config user.email=${["runner", "coding.sh"].join("@")}`).length, 1);
});

test("personal-data passes reserved names (RFC 2606) and flags our own domain", () => {
  const reserved = ["dev@coding.sh.invalid", "ci@coding.sh.invalid", "a@b.example", "a@example.org", "a@host.localhost", "a@x.test"].join(" ");
  assert.deepEqual(messages("personal-data", "scripts/e2e/x.mjs", reserved), []);
  assert.equal(messages("personal-data", "scripts/e2e/x.mjs", `user.email=${["dev", "coding.sh"].join("@")}`).length, 1);
});

test("with the repo's allowlist, a real address or home path in scripts/e2e or a workflow is flagged", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const allowlist = parseAllowlist(readFileSync(join(ROOT, "scripts/lint/allowlist.json"), "utf8"), RULE_IDS);
  const gmail = ["jane.doe", "gmail.com"].join("@");
  const home = ["", "Users", "janedoe", "x"].join("/");
  const files = { "scripts/e2e/x.mjs": `git("-c", "user.email=${gmail}");\nconst p = "${home}";\n`, ".github/workflows/x.yml": `run: git config user.email ${gmail}\n` };
  const { findings } = lintFiles(Object.keys(files), { read: (p) => files[p], allowlist });
  const bad = findings.filter((f) => f.rule === "personal-data" && !f.allowed).map((f) => `${f.path}:${f.line}`);
  assert.deepEqual(bad.sort(), [".github/workflows/x.yml:1", "scripts/e2e/x.mjs:1", "scripts/e2e/x.mjs:2"]);
});

test("a personal-data allowlist entry must name one file and a max", () => {
  const entry = (e) => ({ entries: [{ rule: "personal-data", reason: "synthetic identity", ...e }] });
  assert.throws(() => parseAllowlist(entry({ path: "scripts/e2e/*.mjs" }), RULE_IDS), /names one file and a "max"/);
  assert.throws(() => parseAllowlist(entry({ path: "scripts/e2e/x.mjs" }), RULE_IDS), /names one file and a "max"/);
  assert.equal(parseAllowlist(entry({ path: "scripts/e2e/x.mjs", max: 1 }), RULE_IDS).length, 1);
});
