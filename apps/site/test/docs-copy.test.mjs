// Copy and colour on docs code blocks and terminals. Every Terminal (the CLI
// help on the generated command pages, and the output blocks) has the same
// Copy button as a code block, inside a .code frame with its own live region,
// so the one delegated handler in Nav.astro copies and announces it. A block
// whose lines start with "$ " copies only its commands: the build writes them
// into the button's data-copy, which the handler reads before the block's
// text. A sh or bash block is coloured at build time with four classes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";
import { htmlText, promptCommands, shellHtml } from "../src/lib/shell.ts";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(SITE, "dist");
const read = (route) => readFileSync(join(DIST, route, "index.html"), "utf8");
const attr = (s) => s.replace(/&#10;/g, "\n").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("promptCommands keeps the $ lines and their continuations, without the prompt or the output", () => {
  assert.equal(promptCommands("coding.sh serve\nListening"), undefined, "no prompt: the block copies its own text");
  assert.equal(promptCommands("$ coding.sh show latest\nsession s_1  ok\n  2 turns"), "coding.sh show latest");
  assert.equal(promptCommands("$ echo hi >> AGENTS.md\n$ coding.sh exp ab\nA: git:HEAD"), "echo hi >> AGENTS.md\ncoding.sh exp ab");
  assert.equal(promptCommands("$ coding.sh eval run \\\n    --yes\ndone\n$ ls"), "coding.sh eval run \\\n    --yes\nls");
  assert.equal(promptCommands("$5 spent\n$ x"), "x", "a dollar amount is not a prompt");
  assert.equal(htmlText('<span class="t-muted">$</span> <b>a &amp;&amp; b &lt;c&gt;</b>'), "$ a && b <c>");
});

test("the copy handler prefers the button's data-copy over the block's text", () => {
  const nav = readFileSync(join(SITE, "src/components/Nav.astro"), "utf8");
  assert.match(nav, /copyText\(btn\.dataset\.copy \?\? pre\?\.textContent \?\? ""\)/);
});

/** Each Terminal figure on a page, with its button and body. */
function terminals(html) {
  return [...html.matchAll(/<figure class="term code[^"]*"[^>]*>([\s\S]*?)<\/figure>/g)].map((m) => {
    const inner = m[1];
    const btn = /<button\b[^>]*\bdata-code-copy\b[^>]*>/.exec(inner)?.[0];
    return {
      btn,
      status: /role="status"[^>]*data-code-status/.test(inner),
      body: /<div class="term__body[^"]*"[^>]*\bdata-code-text\b/.test(inner),
      copy: btn && /data-copy="([^"]*)"/.exec(btn)?.[1],
      label: btn && /aria-label="([^"]*)"/.exec(btn)?.[1],
    };
  });
}

test("a CLI help terminal has a Copy button that copies its text", distOpts(DIST), () => {
  needDist(DIST);
  for (const route of ["docs/cli/init", "docs/cli/eval", "docs/cli"]) {
    const terms = terminals(read(route));
    assert.ok(terms.length >= 1, `${route}: a terminal`);
    for (const t of terms) {
      assert.ok(t.btn, `${route}: a Copy button in the terminal`);
      assert.ok(t.status, `${route}: the terminal's own live region`);
      assert.ok(t.body, `${route}: the body is the text to copy`);
      assert.equal(t.copy, undefined, `${route}: help has no prompt, so no data-copy`);
    }
  }
  assert.equal(terminals(read("docs/cli/init"))[0].label, "Copy help for coding.sh init");
});

test("a $ transcript copies only its commands", distOpts(DIST), () => {
  needDist(DIST);
  // A Terminal transcript on Quickstart.
  const quick = terminals(read("docs/quickstart")).map((t) => t.copy && attr(t.copy));
  assert.ok(quick.includes("coding.sh show latest"), `quickstart: ${JSON.stringify(quick)}`);
  // A fenced block in docs/reference/query.md (/docs/query): one command, then an error.
  const copies = [...read("docs/query").matchAll(/<button\b[^>]*\bdata-code-copy\b[^>]*\bdata-copy="([^"]*)"/g)].map((m) => attr(m[1]));
  assert.ok(copies.includes("coding.sh sessions --where 'agent:codex modle:x'"), `query: ${JSON.stringify(copies)}`);
  // A block without a prompt keeps copying its own text.
  const plain = read("docs/quickstart").match(/<button\b[^>]*\bdata-code-copy\b[^>]*>/g).filter((b) => !b.includes("data-copy="));
  assert.ok(plain.length > 0, "quickstart: a code block without data-copy");
});

test("shellHtml colours command, flag, string and comment, and leaves output and heredocs plain", () => {
  assert.equal(
    shellHtml("curl -fsSL https://coding.sh/install | sh  # once"),
    '<span class="sh-cmd">curl</span> <span class="sh-flag">-fsSL</span> https://coding.sh/install | <span class="sh-cmd">sh</span>  <span class="sh-com"># once</span>',
  );
  assert.equal(
    shellHtml("FOO=1 coding.sh run --where='a b' \\\n  --yes \"x <y>\""),
    'FOO=1 <span class="sh-cmd">coding.sh</span> run <span class="sh-flag">--where=</span><span class="sh-str">\'a b\'</span> \\\n  <span class="sh-flag">--yes</span> <span class="sh-str">"x &lt;y&gt;"</span>',
    "an assignment is not the command; a continued line has no command",
  );
  assert.equal(shellHtml("$ coding.sh show latest\nsession --x  ok"), '$ <span class="sh-cmd">coding.sh</span> show latest\nsession --x  ok', "output lines stay plain");
  assert.equal(shellHtml("cat > a.json <<'EOF'\n{\"a\": 1}\nEOF\nls"), '<span class="sh-cmd">cat</span> &gt; a.json &lt;&lt;<span class="sh-str">\'EOF\'</span>\n{"a": 1}\nEOF\n<span class="sh-cmd">ls</span>');
  assert.equal(shellHtml("a 2>&1 && b"), '<span class="sh-cmd">a</span> 2&gt;&amp;1 &amp;&amp; <span class="sh-cmd">b</span>', "2>&1 is a redirect, not a new command");
  assert.equal(htmlText(shellHtml("echo \"a & b\" 'c' # d")), "echo \"a & b\" 'c' # d", "the text is unchanged");
});

test("built sh blocks use only the four colour classes, and other languages none", distOpts(DIST), () => {
  needDist(DIST);
  const quick = read("docs/quickstart");
  assert.match(quick, /<span class="sh-cmd">curl<\/span> <span class="sh-flag">-fsSL<\/span>/, "the install line is coloured");
  const api = read("docs/api");
  const json = [...api.matchAll(/code__title[^>]*>json<[\s\S]*?<pre class="code__body"[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => m[1]);
  assert.ok(json.length > 0, "/docs/api has a json block");
  for (const b of json) assert.doesNotMatch(b, /class="sh-/, "a json block is not coloured");
  const classes = new Set();
  for (const route of ["docs/quickstart", "docs/config", "docs/deploy", "docs/install", "docs/agents"]) for (const m of read(route).matchAll(/class="(sh-[\w-]+)"/g)) classes.add(m[1]);
  assert.deepEqual([...classes].sort(), ["sh-cmd", "sh-com", "sh-flag", "sh-str"]);
});

test("each shell colour is at least 4.5:1 on the code background", () => {
  const tokens = Object.fromEntries([...readFileSync(join(SITE, "src/styles/global.css"), "utf8").matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const css = readFileSync(join(SITE, "src/styles/doc.css"), "utf8");
  const found = [...css.matchAll(/\.(sh-[\w-]+)\s*\{\s*color:\s*var\((--[\w-]+)\)/g)];
  assert.equal(found.length, 4, "four shell colours");
  for (const [, cls, token] of found) {
    const ratio = (lum(tokens[token]) + 0.05) / (lum(tokens["--term"]) + 0.05);
    assert.ok(ratio >= 4.5, `${cls} (${token}) is ${ratio.toFixed(2)}:1`);
  }
});

// "Copy page" and "View as Markdown" sit above the title. They stay 28px tall
// on touch too, so on a phone the row does not push the title down; .hit (a
// 44px ::after on coarse pointers) keeps the touch target.
test("the Copy page row stays 28px on touch, with a 44px hit area", distOpts(DIST), () => {
  needDist(DIST);
  const tools = read("docs/quickstart").match(/<div class="doc__tools"[\s\S]*?<\/div>/)?.[0] ?? "";
  const items = [...tools.matchAll(/<(?:button|a)\b[^>]*class="([^"]*)"/g)].map((m) => m[1].split(/\s+/));
  assert.equal(items.length, 2, "Copy page and View as Markdown");
  for (const c of items) assert.ok(c.includes("doc__tool") && c.includes("hit"), `${c.join(" ")} has the .hit touch target`);
  const layout = readFileSync(join(SITE, "src/components/docs/DocsLayout.astro"), "utf8");
  assert.doesNotMatch(layout, /\(pointer: coarse\)\s*\{\s*\.doc__tool\s*\{[^}]*min-height/, "no taller row on touch");
});
