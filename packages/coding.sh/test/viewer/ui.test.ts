// Static checks on the client page. Captured prompts and tool output are
// untrusted, so the client must never route data through an HTML parser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const js = scripts.join("\n");
// Ignore comments so the file can explain the rule it follows.
const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");

test("page has exactly one inline script and it carries the CSP nonce", () => {
  assert.equal(scripts.length, 1);
  assert.match(html, /<script nonce="__CSP_NONCE__">/);
  assert.match(html, /<style nonce="__CSP_NONCE__">/);
});

test("client never uses raw-HTML sinks", () => {
  const banned = [
    /\.innerHTML\b/,
    /\.outerHTML\b/,
    /insertAdjacentHTML/,
    /document\.write/,
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /createContextualFragment/,
    /DOMParser/,
    /\.srcdoc\b/,
    /setTimeout\(\s*["'`]/,
    /setInterval\(\s*["'`]/,
  ];
  for (const re of banned) assert.doesNotMatch(code, re, `found ${re}`);
});

test("no inline event-handler attributes, javascript: URLs or external origins", () => {
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i);
  assert.doesNotMatch(html, /javascript:/i);
  // Only the SVG namespace may look like a URL.
  const urls = [...html.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(urls)].filter((u) => !u.startsWith("http://www.w3.org/2000/svg")), []);
});

test("element attributes are set through the guarded helper", () => {
  // setAttribute("href"/"src", data) would allow javascript: links; the helper
  // only accepts internal "#/" hrefs.
  assert.doesNotMatch(code, /setAttribute\(\s*["'](src|srcdoc|action|formaction)["']/);
  assert.match(code, /only internal hash links/);
  const hrefSets = [...code.matchAll(/setAttribute\(\s*["']href["']/g)];
  assert.equal(hrefSets.length, 1, "href is only set inside h()");
});

test("motion respects prefers-reduced-motion and hover is gated", () => {
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /@media \(hover: hover\) and \(pointer: fine\)/);
  const hoverOutside = html
    .replace(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/g, "")
    .match(/:hover/g);
  assert.equal(hoverOutside, null, ":hover rules live only inside the hover media query");
  assert.doesNotMatch(html, /transition:\s*all/);
});
