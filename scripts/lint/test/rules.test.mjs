import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lineOf, lineStarts } from "../lib/source.mjs";
import { RULES } from "../lib/rules.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const MARK = "slop:expect";

/** Lines (1-based) marked `slop:expect` in a fixture. */
const expected = (src) => src.split("\n").flatMap((l, i) => (l.includes(MARK) ? [i + 1] : []));

/** Lines a rule reports for a fixture, as the site path the rule would see. */
function reported(rule, name, src) {
  const path = rule.id === "site-placeholder" ? `apps/site/src/fixture/${name}` : `packages/demo/src/${name}`;
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
