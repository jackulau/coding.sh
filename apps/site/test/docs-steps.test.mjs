// Steps: a numbered procedure is an <ol class="steps"> whose numbers are a CSS
// counter (doc.css), from Steps.astro or :::steps in a docs/*.md page. The
// headings carry no number of their own on the page, keep their anchors and
// their rail entries, and the .md twins and llms-full.txt still number them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";
import { renderMarkdown } from "../src/components/docs/markdown.ts";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const read = (file) => readFileSync(join(DIST, file), "utf8");

test(":::steps gives one item per ### heading, without the source's numbers", () => {
  const md = ["## Set up", "", ":::steps", "### 1. Start the server", "", "Run it.", "", "```sh", "coding.sh serve", "```", "", "### 2. Open the viewer", "", "Click a row.", ":::", "", "After."].join("\n");
  const blocks = renderMarkdown(md, "guides/steps-test.md", "/x");
  const steps = blocks.find((b) => b.kind === "steps");
  assert.ok(steps, "a steps block");
  assert.equal(steps.items.length, 2);
  assert.match(steps.items[0][0].html, /^<h3 id="start-the-server">Start the server<\/h3><p>Run it\.<\/p>$/);
  assert.equal(steps.items[0][1].kind, "code");
  assert.match(steps.items[1][0].html, /^<h3 id="open-the-viewer">Open the viewer<\/h3>/);
  assert.match(blocks.at(-1).html, /<p>After\.<\/p>/, "text after ::: is outside the steps");
});

test(":::steps needs a ### step first and at least one", () => {
  assert.throws(() => renderMarkdown(":::steps\nText first.\n### 1. Then\n:::\n", "guides/x.md", "/x"), /needs a ### step before its text/);
  assert.throws(() => renderMarkdown(":::steps\n:::\n", "guides/x.md", "/x"), /has no ### step/);
});

test("doc.css draws the step numbers with a counter and a rail", () => {
  const css = readFileSync(new URL("../src/styles/doc.css", import.meta.url), "utf8");
  assert.match(css, /\.steps\s*\{[^}]*counter-reset:\s*step/);
  assert.match(css, /\.steps > li::before\s*\{[^}]*content:\s*counter\(step\)/);
  assert.match(css, /\.steps > li:not\(:last-child\)::after\s*\{[^}]*width:\s*1px/);
});

const PAGES = {
  "docs/quickstart": [
    ["sdk-install", "Install coding.sh", "sdk-serve", "Start the local server", "sdk-add", "Add the SDK", "sdk-run", "Run it", "sdk-see", "See your run"],
    ["agent-install", "Install", "agent-use", "Use your agent as usual", "agent-see", "See your sessions"],
  ],
  "docs/tool-evals": [["init", "Add the target", "task", "Write a task", "validate", "Check the task", "run", "Run it"]],
};
const pairs = (flat) => flat.flatMap((x, i) => (i % 2 ? [] : [[x, flat[i + 1]]]));

for (const [path, lists] of Object.entries(PAGES)) {
  test(`/${path}: each procedure is one <ol class="steps">, a step per h3, anchors and rail kept`, distOpts(DIST), () => {
    needDist(DIST);
    const html = read(join(path, "index.html"));
    const main = html.match(/<main[\s\S]*?<\/main>/)[0];
    // The HTML after each list's opening tag, up to the next list.
    const parts = main.split('<ol class="steps">').slice(1);
    assert.equal(parts.length, lists.length, "one list per procedure");
    const rail = html.match(/<aside class="onpage"[\s\S]*?<\/aside>/)?.[0] ?? "";
    for (const [i, list] of lists.entries()) {
      const steps = [...parts[i].matchAll(/<li><h3 id="([^"]+)"><a class="h-anchor" href="#\1">([^<]*)<\/a><\/h3>/g)].map((m) => [m[1], m[2]]);
      assert.deepEqual(steps, pairs(list), `list ${i + 1}: a step per h3, in order, each with its anchor and no number`);
      for (const [id, title] of pairs(list)) assert.match(rail, new RegExp(`href="#${id}"[^>]*>\\s*${title}\\s*<`), `#${id} is in the rail`);
    }
  });

  test(`/${path}.md and llms-full.txt number the steps`, distOpts(DIST), () => {
    needDist(DIST);
    const twin = read(`${path}.md`);
    const full = read("llms-full.txt");
    for (const list of lists) {
      const want = pairs(list).map(([, title], i) => `### ${i + 1}. ${title}`);
      let from = 0;
      for (const line of want) {
        const at = twin.indexOf(`\n${line}\n`, from);
        assert.ok(at >= 0, `${path}.md has "${line}" after the step before it`);
        from = at + 1;
        assert.ok(full.includes(`\n${line}\n`), `llms-full.txt has "${line}"`);
      }
    }
  });
}
