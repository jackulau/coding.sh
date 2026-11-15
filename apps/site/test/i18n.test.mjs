// The front page's translations (src/i18n). English is the source; each table maps an English
// string, as the source writes it, to the same string in another language.
//   - every table translates the same strings, and keeps each one's {{PLACEHOLDERS}} and tags
//   - a table has no string the English page no longer has (a reworded English line must be
//     translated again, not left behind)
//   - a built translated page shows no English string the English page shows, apart from names
//   - each built page says its language and lists the others
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";
import { LOCALES, DEFAULT_LOCALE } from "../src/i18n/locales.mjs";
import { TABLES } from "../src/i18n/home.ts";

const SITE = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(SITE, "dist");
const read = (p) => readFileSync(join(SITE, p), "utf8");
const TRANSLATED = LOCALES.filter((l) => l !== DEFAULT_LOCALE);
// Where the English strings live.
const SOURCES = ["src/pages/index.astro", "src/landing/body.html", "src/landing/flow.html", "src/landing/trace.html", "src/components/Nav.astro", "src/layouts/Layout.astro"];

/** What must survive translation: {{PLACEHOLDERS}} and tags, in order. */
const frame = (s) => [...s.matchAll(/\{\{[A-Z_]+\}\}|<\/?[a-z][^>]*>/g)].map((m) => m[0]);

/** Visible strings of a built page: text nodes, plus alt, aria-label and title values, and the head's title and description. */
function strings(html) {
  const out = new Set();
  const body = html.replace(/<(script|style|svg|template|pre|code)\b[\s\S]*?<\/\1>/gi, " ").replace(/<head\b[\s\S]*?<\/head>/i, " ");
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    const t = m[1].replace(/\s+/g, " ").trim();
    if (t) out.add(t);
  }
  for (const m of body.matchAll(/\s(?:alt|aria-label|title)="([^"]+)"/g)) out.add(m[1]);
  for (const re of [/<title>([^<]*)<\/title>/, /<meta name="description" content="([^"]*)"/]) {
    const m = html.match(re);
    if (m) out.add(m[1]);
  }
  return out;
}

test("every language has a table, and every table translates the same strings", () => {
  const codes = TRANSLATED.map((l) => l.code).sort();
  assert.deepEqual(Object.keys(TABLES).sort(), codes, "src/i18n/locales.mjs and src/i18n/home.ts list different languages");
  const [first, ...rest] = codes;
  for (const code of rest) {
    const a = Object.keys(TABLES[first]);
    const b = Object.keys(TABLES[code]);
    assert.deepEqual(
      b.filter((k) => !a.includes(k)).concat(a.filter((k) => !b.includes(k))),
      [],
      `${code}.ts and ${first}.ts translate different strings`,
    );
  }
});

test("a translation keeps its string's placeholders and tags", () => {
  for (const [code, table] of Object.entries(TABLES))
    for (const [en, local] of Object.entries(table)) assert.deepEqual(frame(local), frame(en), `${code}.ts: ${JSON.stringify(en)}`);
});

test("no translation is empty or has a spaced em dash", () => {
  for (const [code, table] of Object.entries(TABLES))
    for (const [en, local] of Object.entries(table)) {
      assert.ok(local.trim(), `${code}.ts: ${JSON.stringify(en)} is empty`);
      assert.doesNotMatch(local, /\S — \S|——/, `${code}.ts: ${JSON.stringify(en)}`);
    }
});

test("every string a table translates is still on the English page", distOpts(join(DIST, "index.html")), () => {
  needDist(join(DIST, "index.html"));
  const source = SOURCES.map(read).join("\n");
  const built = strings(readFileSync(join(DIST, "index.html"), "utf8"));
  const quoted = (s) => [`>${s}<`, `="${s}"`, `"${s}"`, `'${s}'`, `\`${s}\``].some((q) => source.includes(q));
  for (const [code, table] of Object.entries(TABLES)) {
    const stale = Object.keys(table).filter((en) => !built.has(en) && !quoted(en));
    assert.deepEqual(stale, [], `src/i18n/home/${code}.ts has strings the English page no longer has; translate the new wording`);
  }
});

for (const locale of TRANSLATED) {
  const file = join(DIST, locale.code, "index.html");

  test(`/${locale.code} shows no English string from the English page, apart from names`, distOpts(file), () => {
    needDist(file);
    const table = TABLES[locale.code];
    const names = new Set([
      ...LOCALES.map((l) => l.name),
      // The agents in the "Works with" strip.
      ...[...read("src/pages/index.astro").matchAll(/\{ id: "[^"]+", name: "([^"]+)" \}/g)].map((m) => m[1]),
      // Strings a table keeps as they are (GitHub, SDK).
      ...Object.entries(table).filter(([en, local]) => en === local).map(([en]) => en),
    ]);
    const english = strings(readFileSync(join(DIST, "index.html"), "utf8"));
    const left = [...strings(readFileSync(file, "utf8"))].filter((s) => english.has(s) && /[a-z]{2}/i.test(s) && !names.has(s));
    assert.deepEqual(left, [], `English left on /${locale.code}: add these to src/i18n/home/${locale.code}.ts`);
    assert.doesNotMatch(readFileSync(file, "utf8"), /\{\{[A-Z_]+\}\}/, "a placeholder was not filled");
  });
}

for (const locale of LOCALES) {
  const file = join(DIST, locale.code === DEFAULT_LOCALE.code ? "index.html" : join(locale.code, "index.html"));

  test(`${locale.path} says its language and lists every language's page`, distOpts(file), () => {
    needDist(file);
    const html = readFileSync(file, "utf8");
    assert.match(html, new RegExp(`<html lang="${locale.tag}"`));
    assert.match(html, new RegExp(`<meta property="og:locale" content="${locale.og}">`));
    const links = Object.fromEntries([...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]));
    const expected = Object.fromEntries([...LOCALES.map((l) => [l.tag, new URL(l.path, "https://coding.sh").toString()]), ["x-default", "https://coding.sh/"]]);
    assert.deepEqual(links, expected);
    // The switcher in the footer links every language, and marks this one.
    for (const l of LOCALES) assert.ok(html.includes(`href="${l.path}" hreflang="${l.tag}" lang="${l.tag}"`), `no switcher link to ${l.path}`);
    assert.match(html, new RegExp(`href="${locale.path}" hreflang="${locale.tag}" lang="${locale.tag}" aria-current="page"`));
    // Its names (ç, ê, ñ) are drawn in the system font, so no page fetches Geist's -rest file for
    // them; scripts/perf-budget.mjs skips text marked data-system-font on that promise.
    assert.match(html, /<nav aria-label="[^"]+" class="f-foot__langs"[^>]*\sdata-system-font/);
    const rule = html.match(/nav(?:\[[^\]]*\])*\[data-system-font\][^{]*\{([^}]*)\}/)?.[1] ?? "";
    assert.match(rule, /font-family:/, "no font-family rule for the switcher");
    assert.doesNotMatch(rule, /Geist/);
  });
}

test("the docs stay English and list no alternates", distOpts(join(DIST, "docs", "index.html")), () => {
  needDist(join(DIST, "docs", "index.html"));
  const html = readFileSync(join(DIST, "docs", "index.html"), "utf8");
  assert.match(html, /<html lang="en"/);
  assert.doesNotMatch(html, /hreflang=/);
  assert.ok(existsSync(join(DIST, "zh.md")), "the translated home page has no Markdown twin");
});
