// The landing page (dist/index.html, inside <main>) is for people and reads
// like a person wrote it. Six checks, each from a correction in tasks/lessons.md:
//   1 no marketing words and no "not X, but Y" cadence
//   2 no id-style labels (exp_01M6..., s_8f3a21) and no hook names as headings
//   3 no "sample" or "demo" label on the product pictures, and no acme
//   4 no spaced em dash
//   5 one idea per section: one <h2> each, no table, no CI notation
//   6 short: at most 650 words in all and 170 in a section
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const WORDS_ALL = 650;
const WORDS_SECTION = 170;

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", rarr: "→", middot: "·" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : NAMED[e.toLowerCase()] ?? m));
const strip = (html) => html.replace(/<(script|style|svg|noscript)[^>]*>[\s\S]*?<\/\1>/g, " ");
const text = (html) => unescape(strip(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const words = (s) => s.split(/\s+/).filter(Boolean).length;

const MARKETING = /\b(?:seamless(?:ly)?|unlock(?:s|ed|ing)?|powerful|supercharg\w*|effortless(?:ly)?|revolutioni[sz]\w*|game[- ]chang\w*|cutting[- ]edge|next[- ]gen(?:eration)?|blazing(?:ly)?|world[- ]class|delve|leverag(?:e|es|ing)|empower\w*)\b/i;
const CADENCE = /\bnot (?:just |only )?[^.,;]{1,40}[,;] but\b|\bit(?:'|’)s not [^.]{1,40}, it(?:'|’)s\b|\bmore than just\b/i;
const ID_LABEL = /\b(?:exp|run|task|case|s|sess|ds)_[0-9A-Za-z]{6,}\b/;
const HOOK_NAMES = /\b(?:PreToolUse|PostToolUse|SessionStart|SessionEnd|UserPromptSubmit|PreCompact|SubagentStop|Stop)\b/;
const SAMPLE_LABEL = /\b(?:sample|demo|dummy|mock) (?:data|session|viewer|output)\b|\bacme\b/i;
const EM_DASH = /\S — \S/;
const CI_NOTATION = /\b95% (?:CI|confidence)\b|bootstrap|mcnemar|\bp ?[=<] ?0?\.\d|\[-?\d+(?:\.\d+)?%?, ?-?\d+(?:\.\d+)?%?\]|\bWilson\b|\bpp\b/i;

/** The checks, in order. Each takes the landing's <main> HTML and returns what it found. */
export const CHECKS = [
  { id: 1, name: "marketing words or cadence", run: (html) => [MARKETING, CADENCE].flatMap((re) => text(html).match(re)?.[0] ?? []) },
  {
    id: 2,
    name: "id-style labels or hook names as headings",
    run: (html) => [text(html).match(ID_LABEL)?.[0], ...[...html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/g)].map((m) => text(m[1]).match(HOOK_NAMES)?.[0])].filter(Boolean),
  },
  { id: 3, name: "a sample or demo label, or acme", run: (html) => text(html).match(SAMPLE_LABEL)?.slice(0, 1) ?? [] },
  { id: 4, name: "a spaced em dash", run: (html) => text(html).match(EM_DASH)?.slice(0, 1) ?? [] },
  {
    id: 5,
    name: "more than one idea per section, a table, or CI notation",
    run: (html) => {
      const out = [];
      for (const sec of html.match(/<section[\s>][\s\S]*?<\/section>/g) ?? []) {
        const h2 = (sec.match(/<h2[\s>]/g) ?? []).length;
        if (h2 > 1) out.push(`${h2} <h2> in one section`);
      }
      if (/<table[\s>]/.test(html)) out.push("a <table>");
      const ci = text(html).match(CI_NOTATION)?.[0];
      if (ci) out.push(`CI notation: ${ci}`);
      return out;
    },
  },
  {
    id: 6,
    name: "too long",
    run: (html) => {
      const out = [];
      const total = words(text(html));
      if (total > WORDS_ALL) out.push(`${total} words (budget ${WORDS_ALL})`);
      for (const sec of html.match(/<section[\s>][\s\S]*?<\/section>/g) ?? []) {
        const n = words(text(sec));
        if (n > WORDS_SECTION) out.push(`a section of ${n} words (budget ${WORDS_SECTION}): ${text(sec).slice(0, 40)}`);
      }
      return out;
    },
  },
];

/** The <main> of a page. */
export const mainOf = (html) => /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";

/** Findings as "check N (name): what", for the <main> of a page. */
export function landingFindings(html) {
  const main = mainOf(html) || html;
  return CHECKS.flatMap((c) => c.run(main).map((what) => `check ${c.id} (${c.name}): ${what}`));
}

test("the seeded string fails checks 1, 2 and 4 and no others", () => {
  const seeded = "<main><section><h2>Insights</h2><p>Unlock powerful insights — see exp_01M6T953P384HSAZNNEY1H3PJ6.</p></section></main>";
  const ids = new Set(landingFindings(seeded).map((f) => f.match(/^check (\d)/)[1]));
  assert.deepEqual([...ids].sort(), ["1", "2", "4"]);
});

test("each other check catches its own seeded string", () => {
  assert.match(landingFindings("<main><h3>PreToolUse</h3></main>").join("\n"), /check 2/);
  assert.match(landingFindings("<main><p>Sample data</p></main>").join("\n"), /check 3/);
  assert.match(landingFindings("<main><section><h2>a</h2><h2>b</h2></section></main>").join("\n"), /check 5/);
  assert.match(landingFindings("<main><table><tr><td>x</td></tr></table></main>").join("\n"), /check 5/);
  assert.match(landingFindings(`<main><p>${"word ".repeat(700)}</p></main>`).join("\n"), /check 6/);
  assert.deepEqual(landingFindings("<main><section><h2>Plain</h2><p>coding.sh records every step your agents take.</p></section></main>"), []);
});

test("the built landing page passes the six checks", distOpts(join(DIST, "index.html")), () => {
  needDist(join(DIST, "index.html"));
  const found = landingFindings(readFileSync(join(DIST, "index.html"), "utf8"));
  assert.deepEqual(found, [], `${found.length} landing finding(s):\n${found.join("\n")}`);
});
