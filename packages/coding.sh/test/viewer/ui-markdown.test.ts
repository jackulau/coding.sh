// The viewer's markdown parser and escape-code stripper, run straight from the page's script (plain
// functions with no DOM). The parser returns data that the page builds with h(), so the checks here
// are about what is recognised and that nothing in the source becomes markup.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const html = readFileSync(new URL("../../src/viewer/ui/index.html", import.meta.url), "utf8");
function slice(from: string, to: string): string {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `markers ${from} .. ${to}`);
  return html.slice(a, b);
}
const src = [slice("const MD_FENCE =", "function mdSpans("), slice("const ANSI_RE =", "function looksLikeDiff(")].join("\n");
const f: any = runInNewContext(`${src}\n({ mdParse, mdInline, stripAnsi })`, { String, Map });
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const parse = (s: string) => plain(f.mdParse(s));
const inline = (s: string) => plain(f.mdInline(s));

test("headings, paragraphs, lists and a fenced block with its language", () => {
  const md = "# Plan\n\nFirst line\nsecond line\n\n- one\n- two\n  - nested\n\n3. three\n4. four\n\n```ts\nconst a = 1;\n\n```\n## Done ##";
  assert.deepEqual(parse(md), [
    { t: "h", level: 1, text: "Plan" },
    { t: "p", text: "First line\nsecond line" },
    { t: "list", items: [{ ind: 0, ordered: false, n: 0, text: "one" }, { ind: 0, ordered: false, n: 0, text: "two" }, { ind: 2, ordered: false, n: 0, text: "nested" }] },
    { t: "list", items: [{ ind: 0, ordered: true, n: 3, text: "three" }, { ind: 0, ordered: true, n: 4, text: "four" }] },
    { t: "code", lang: "ts", text: "const a = 1;\n" },
    { t: "h", level: 2, text: "Done" },
  ]);
  assert.deepEqual(parse("a\n\n---\nb"), [{ t: "p", text: "a" }, { t: "hr" }, { t: "p", text: "b" }]);
  assert.deepEqual(parse("#hashtag is text"), [{ t: "p", text: "#hashtag is text" }]);
  assert.deepEqual(parse("- a\n  more of a\nafter"), [{ t: "list", items: [{ ind: 0, ordered: false, n: 0, text: "a\nmore of a" }] }, { t: "p", text: "after" }]);
});

test("inline code, bold, italic and links; links stay text and url", () => {
  assert.deepEqual(inline("run `npm test` now"), [["t", "run "], ["c", "npm test"], ["t", " now"]]);
  assert.deepEqual(inline("a **bold** and *it* and __b__ and _i_"), [["t", "a "], ["b", [["t", "bold"]]], ["t", " and "], ["i", [["t", "it"]]], ["t", " and "], ["b", [["t", "b"]]], ["t", " and "], ["i", [["t", "i"]]]]);
  assert.deepEqual(inline("**bold `code`**"), [["b", [["t", "bold "], ["c", "code"]]]]);
  assert.deepEqual(inline("see [the docs](docs/a.md#b) here"), [["t", "see "], ["a", "the docs", "docs/a.md#b"], ["t", " here"]]);
  // Not emphasis: snake_case names, a lone star, a multiplication, an escaped star.
  assert.deepEqual(inline("snake_case_name and 2 * 3 * 4"), [["t", "snake_case_name and 2 * 3 * 4"]]);
  assert.deepEqual(inline("\\*not\\*"), [["t", "*not"], ["t", "*"]]);
  assert.deepEqual(inline("[x] (y) and [z](has space)"), [["t", "[x] (y) and [z](has space)"]]);
});

test("hostile input: tags stay text, an unclosed fence keeps its text, unclosed spans stay literal", () => {
  const md = "<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n```html\n<script>alert(2)</script>\nno closing fence";
  const blocks = parse(md);
  assert.deepEqual(blocks, [
    { t: "p", text: "<script>alert(1)</script>\n<img src=x onerror=alert(1)>" },
    { t: "code", lang: "html", text: "<script>alert(2)</script>\nno closing fence" },
  ]);
  assert.deepEqual(inline(blocks[0]!.text), [["t", blocks[0]!.text]]);
  assert.deepEqual(inline("**open `tick [link](javascript:x"), [["t", "**open `tick [link](javascript:x"]]);
  assert.deepEqual(inline("[a](javascript:alert(1))"), [["a", "a", "javascript:alert(1"], ["t", ")"]]);
});

test("a 200 KB reply of worst-case openers parses in linear time", () => {
  const time = (s: string) => { const t = performance.now(); for (const b of f.mdParse(s)) if (b.text) f.mdInline(b.text); return performance.now() - t; };
  for (const unit of ["*a ", "**", "_a ", "`", "[a](", "[", "``` ", "- ", "# ", "  "]) {
    const small = unit.repeat(Math.ceil(20_000 / unit.length)), big = unit.repeat(Math.ceil(200_000 / unit.length));
    time(small);
    const a = time(small), b = time(big);
    // Ten times the input: linear is about 10x, quadratic about 100x. Allow for noise.
    assert.ok(b < Math.max(40 * a, 150), `${JSON.stringify(unit)}: 20 KB ${a.toFixed(1)} ms, 200 KB ${b.toFixed(1)} ms`);
  }
});

test("escape codes are stripped from tool output; other text is untouched", () => {
  assert.equal(f.stripAnsi("\x1b[31mred\x1b[0m \x1b[1;32mbold green\x1b[m"), "red bold green");
  assert.equal(f.stripAnsi("progress\x1b[2K\x1b[1G50%\x1b[?25l\x1b[?25h"), "progress50%");
  assert.equal(f.stripAnsi("\x1b]0;window title\x07done"), "done");
  assert.equal(f.stripAnsi("\x1b]8;;file:///a\x1b\\link\x1b]8;;\x1b\\"), "link");
  assert.equal(f.stripAnsi("\x1b(Bplain\x1b=\x1b>end\x1b"), "plainend");
  assert.equal(f.stripAnsi("\x9b33mC1 csi\x9b0m"), "C1 csi");
  assert.equal(f.stripAnsi("no codes [31m here, tabs\tand\nnewlines"), "no codes [31m here, tabs\tand\nnewlines");
  const big = "\x1b[".repeat(100_000);
  const t = performance.now();
  f.stripAnsi(big);
  assert.ok(performance.now() - t < 500);
});
