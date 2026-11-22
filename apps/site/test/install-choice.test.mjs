// The front page's install box, in the hero and again under "Try it on your next session",
// offers three ways in: the setup prompt for an agent (picked first), the npx command and the
// install script. A radio group picks one, its copy button copies exactly that text, and a note
// under it says where it runs; the npx note gives the command that runs on Windows. The commands
// are the ones /docs/install shows, and every language carries the same box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";
import { LOCALES } from "../src/i18n/locales.mjs";
import { QUICKSTART_PATHS, SETUP_PROMPT } from "../src/data/prompts.ts";

const SITE = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(SITE, "dist");
const OPTIONS = ["prompt", "npx", "script"];

// site.ts reads files through import.meta.glob, which only Astro provides, so the two commands
// are read from its source.
const siteTs = readFileSync(join(SITE, "src/data/site.ts"), "utf8");
const constant = (name) => {
  const m = siteTs.match(new RegExp(`^export const ${name} = ("[^"\\n]*");`, "m"));
  assert.ok(m, `src/data/site.ts has no ${name}`);
  return JSON.parse(m[1]);
};
const NPX = constant("INSTALL_CMD");
const NPX_WIN = constant("INSTALL_CMD_WIN");
const SCRIPT = constant("INSTALL_SH");

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unescape = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (NAMED[e.toLowerCase()] ?? m),
  );
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescape(m[1]) : undefined;
};
const text = (html) => unescape(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const read = (page) => readFileSync(join(DIST, page), "utf8");

/** The page's install boxes: each <div class="f-actions"> through its Get started link. */
const boxes = (html) => [...html.matchAll(/<div class="f-actions">([\s\S]*?<a class="f-btn"[^>]*>[\s\S]*?<\/a>)/g)].map((m) => m[1]);

/** One box, read into its radios, buttons and notes. */
function parse(box) {
  const group = box.match(/<div class="f-pick" role="radiogroup"[^>]*>([\s\S]*?)<\/div>/);
  const radios = [...(group?.[1] ?? "").matchAll(/<label>(<input\b[^>]*>)<span>([^<]*)<\/span><\/label>/g)].map((m) => ({
    value: attr(m[1], "value"),
    name: attr(m[1], "name"),
    type: attr(m[1], "type"),
    checked: /\schecked(?=[\s/>])/.test(m[1]),
    label: m[2].trim(),
  }));
  const opts = box.match(/<div class="f-opts">([\s\S]*?)<\/div>/)?.[1] ?? "";
  const buttons = [...opts.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    copy: attr(m[1], "data-copy"),
    label: attr(m[1], "aria-label"),
    describedby: attr(m[1], "aria-describedby"),
    code: text(m[2].match(/<code>([\s\S]*?)<\/code>/)?.[1] ?? ""),
  }));
  const note = box.match(/<p class="f-note">([\s\S]*?)<\/p>/)?.[1] ?? "";
  const notes = [...note.matchAll(/<span id="([^"]+)">([\s\S]*?)<\/span>/g)].map((m) => ({ id: m[1], text: text(m[2]) }));
  return { group: group?.[0], radios, buttons, notes, start: box.match(/<a class="f-btn"[^>]*>/)?.[0] };
}

for (const { code, path } of LOCALES) {
  const page = path === "/" ? "index.html" : `${path.slice(1)}/index.html`;
  test(`${path}: both install boxes offer the prompt, npx and the script, the prompt picked first`, distOpts(DIST), () => {
    needDist(DIST);
    const html = read(page);
    const found = boxes(html);
    assert.equal(found.length, 2, `${page}: expected the hero box and the bottom box, found ${found.length}`);
    const names = [];
    for (const [i, box] of found.map(parse).entries()) {
      const where = `${page} box ${i + 1}`;
      assert.ok(box.group && attr(box.group, "aria-label"), `${where}: the radio group has no aria-label`);
      assert.deepEqual(box.radios.map((r) => r.value), OPTIONS, `${where}: radio values`);
      assert.ok(box.radios.every((r) => r.type === "radio" && r.label), `${where}: each option is a labelled radio`);
      assert.deepEqual(box.radios.map((r) => r.checked), [true, false, false], `${where}: the prompt is picked first`);
      assert.equal(new Set(box.radios.map((r) => r.name)).size, 1, `${where}: the three radios share one name`);
      names.push(box.radios[0].name);

      // Each button copies exactly its option, and its label says what it copies.
      assert.deepEqual(box.buttons.map((b) => b.copy), [SETUP_PROMPT, NPX, SCRIPT], `${where}: what each button copies`);
      assert.ok(box.buttons[0].label && !box.buttons[0].label.includes(NPX) && !box.buttons[0].label.includes(SCRIPT), `${where}: prompt button label`);
      assert.ok(box.buttons[1].label?.endsWith(NPX), `${where}: the npx button's label names ${NPX}: ${box.buttons[1].label}`);
      assert.ok(box.buttons[2].label?.endsWith(SCRIPT), `${where}: the script button's label names the script: ${box.buttons[2].label}`);
      assert.ok(SETUP_PROMPT.startsWith(box.buttons[0].code.replace(/…$/, "")), `${where}: the prompt line is the prompt's start: ${box.buttons[0].code}`);
      assert.deepEqual(box.buttons.slice(1).map((b) => b.code), [NPX, SCRIPT], `${where}: the commands are shown whole`);

      // A note per option, read out with its button.
      assert.deepEqual(box.buttons.map((b) => b.describedby), box.notes.map((n) => n.id), `${where}: each button is described by its note`);
      assert.ok(box.notes[0].text, `${where}: the prompt has a note`);
      for (const word of ["22.16", "Windows", NPX_WIN]) assert.ok(box.notes[1].text.includes(word), `${where}: the npx note names ${word}: ${box.notes[1].text}`);
      for (const word of ["Windows", "Git Bash", "PowerShell", "cmd"]) assert.ok(box.notes[2].text.includes(word), `${where}: the script note names ${word}: ${box.notes[2].text}`);
      assert.equal(attr(box.start ?? "", "href"), "/docs/quickstart", `${where}: Get started still links the quickstart`);
    }
    assert.equal(new Set(names).size, 2, `${page}: each box has its own radio group`);
    for (const id of found.flatMap((b) => parse(b).notes.map((n) => n.id))) {
      assert.equal(html.split(`id="${id}"`).length - 1, 1, `${page}: id ${id} is used once`);
    }
    if (code === "en") assert.deepEqual(parse(found[0]).radios.map((r) => r.label), ["Agent prompt", "npx", "Script"]);
  });
}

/** The home page's inline CSS, with whitespace and quotes removed. */
const inlineCss = () =>
  [...read("index.html").matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join("\n")
    .replace(/\s+/g, "")
    .replace(/["']/g, "");

test("the picked radio shows its own button and note: npx the second, the script the third", distOpts(DIST), () => {
  needDist(DIST);
  const css = inlineCss();
  assert.ok(css.includes(".f-opts>*+*,.f-note>*+*{visibility:hidden}"), "only the first option shows until another is picked");
  for (const [value, nth] of [["npx", 2], ["script", 3]]) {
    assert.ok(css.includes(`.f-actions:has([value=${value}]:checked):is(.f-opts,.f-note)>:nth-child(${nth})`), `${value} shows option ${nth}`);
  }
});

test("the Windows command in the npx note is never split across two lines", distOpts(DIST), () => {
  needDist(DIST);
  assert.ok(inlineCss().includes(".f-notecode{white-space:nowrap}"), "a command in a note keeps to one line");
});

test("the box's commands are the ones /docs/install shows", distOpts(DIST), () => {
  needDist(DIST);
  const html = read("docs/install/index.html");
  const tabs = {};
  for (const m of html.matchAll(/role="tabpanel"[^>]*data-label="([^"]+)"[\s\S]*?<pre\b[^>]*data-code-text[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/g)) {
    tabs[m[1]] ??= text(m[2]);
  }
  assert.equal(tabs.npx, NPX);
  assert.equal(tabs.Script, SCRIPT);
  // In PowerShell and cmd, `coding.sh` opens npm's sh script of that name; `codingsh` is the same CLI.
  assert.equal(tabs.Windows, "npm install -g coding.sh codingsh init");
  assert.ok(text(html).includes(NPX_WIN), `/docs/install names ${NPX_WIN}`);
});

test("each setup prompt tells an agent on Windows to run codingsh in PowerShell and cmd", () => {
  for (const p of QUICKSTART_PATHS) {
    for (const word of ["Windows", "PowerShell", "cmd", "run codingsh instead of coding.sh"]) {
      assert.ok(p.setup.includes(word), `the ${p.id} setup prompt names ${word}`);
    }
  }
});
