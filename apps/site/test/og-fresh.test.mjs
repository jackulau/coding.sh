// Every Open Graph card is drawn from the title the site has now. gen-og.mjs
// writes public/og/manifest.json (title and template per card); this test
// builds the expected manifest from the docs pages, the blog posts and the site
// card and compares. A card that says "Gemini CLI" after a rename, or the
// vendor instructions file name, is caught here even though a PNG cannot be grepped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cards, manifest, manifestEntry } from "../scripts/og-cards.mjs";

// nav.ts lists /docs/mcp only when src/pages/docs/mcp.astro exists relative to the
// working directory (it is built from apps/site), so import it from there.
const here = process.cwd();
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const { DOC_PAGES } = await import("../src/components/docs/nav.ts");
process.chdir(here);

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const AGENTS_MD = new RegExp(["claude", "md"].join("\\."), "i");
const PLAIN_STATUS = new RegExp(["fixture", "tested"].join("[- ]"), "i");

/** Cards whose recorded entry differs from the expected one, as "name: why". */
export function staleCards(expected, recorded) {
  const out = [];
  for (const [name, e] of Object.entries(expected)) {
    const r = recorded[name];
    if (!r) out.push(`${name}: not in the manifest`);
    else if (r.title !== e.title) out.push(`${name}: card says "${r.title}", the page says "${e.title}"`);
    else if (r.template !== e.template) out.push(`${name}: drawn with another template`);
  }
  for (const name of Object.keys(recorded)) if (!(name in expected)) out.push(`${name}: in the manifest, but no page has it`);
  return out;
}

const recorded = () => JSON.parse(readFileSync(join(PUBLIC, "og/manifest.json"), "utf8"));

test("staleCards reports a changed title", () => {
  const expected = manifest([{ name: "og/docs-agents", kicker: "docs", title: "Antigravity CLI and agents", sub: "coding.sh docs" }]);
  const old = structuredClone(expected);
  old["og/docs-agents"].title = "Gemini CLI and agents";
  assert.deepEqual(staleCards(expected, old), ['og/docs-agents: card says "Gemini CLI and agents", the page says "Antigravity CLI and agents"']);
  assert.deepEqual(staleCards(expected, expected), []);
});

test("the OG manifest matches the titles of the docs pages, blog posts and site card", () => {
  const expected = manifest(cards(DOC_PAGES));
  const problems = staleCards(expected, recorded());
  assert.deepEqual(problems, [], `Run npm run og in apps/site to draw these cards again:\n${problems.join("\n")}`);
});

test("every card has a PNG", () => {
  const missing = Object.keys(recorded()).filter((name) => !existsSync(join(PUBLIC, `${name}.png`)));
  assert.deepEqual(missing, []);
});

test("no card says the vendor instructions file name or the test-jargon status label", () => {
  const bad = Object.entries(recorded()).filter(([, e]) => AGENTS_MD.test(e.title) || PLAIN_STATUS.test(e.title)).map(([n]) => n);
  assert.deepEqual(bad, []);
  assert.ok(AGENTS_MD.test("CLAUDE.md") && PLAIN_STATUS.test("fixture-tested"), "the patterns match their seeded strings");
});

test("manifestEntry changes when the title or the line under it changes", () => {
  const a = manifestEntry({ title: "A", sub: "coding.sh docs", kicker: "docs" });
  assert.notDeepEqual(a, manifestEntry({ title: "B", sub: "coding.sh docs", kicker: "docs" }));
  assert.notDeepEqual(a, manifestEntry({ title: "A", sub: "coding.sh blog", kicker: "docs" }));
});
