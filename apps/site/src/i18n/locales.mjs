// The languages the front page is published in. English is the source: every other language is
// a translation of the English front page, served at /<code>. Only the front page is translated;
// the docs, blog and changelog are English only. Plain .mjs so the build scripts
// (gen-agent-text.mjs, seo-check.mjs) read the same list as the pages.
//
// Adding a language: one entry here and one file in src/i18n/home/ (a copy of es.ts with every
// string translated). The build stops when a string is missing or no longer on the page.

/**
 * @typedef {object} Locale
 * @property {string} code The path segment and the name of its translation file ("en" has no segment).
 * @property {string} path The page's root: "/" or "/<code>".
 * @property {string} tag <html lang> and the hreflang value (BCP 47).
 * @property {string} og og:locale.
 * @property {string} name The language's name in that language, for the switcher.
 * @property {boolean} [preloadRest] The page's first screen uses accented letters that only the
 *   -rest font files have (src/styles/global.css), so the page preloads them with the core files.
 */

/** @type {Locale} */
export const DEFAULT_LOCALE = { code: "en", path: "/", tag: "en", og: "en_US", name: "English" };

/** @type {Locale[]} */
export const LOCALES = [
  DEFAULT_LOCALE,
  { code: "de", path: "/de", tag: "de", og: "de_DE", name: "Deutsch", preloadRest: true },
  { code: "es", path: "/es", tag: "es", og: "es_LA", name: "Español", preloadRest: true },
  { code: "fr", path: "/fr", tag: "fr", og: "fr_FR", name: "Français", preloadRest: true },
  { code: "ja", path: "/ja", tag: "ja", og: "ja_JP", name: "日本語" },
  { code: "ko", path: "/ko", tag: "ko", og: "ko_KR", name: "한국어" },
  { code: "pt-br", path: "/pt-br", tag: "pt-BR", og: "pt_BR", name: "Português", preloadRest: true },
  { code: "zh", path: "/zh", tag: "zh-Hans", og: "zh_CN", name: "简体中文" },
];

/** The translated front pages' paths: /zh, /ja, ... */
export const TRANSLATED_PATHS = LOCALES.filter((l) => l !== DEFAULT_LOCALE).map((l) => l.path);

/** @param {string | undefined} code */
export const localeOf = (code) => LOCALES.find((l) => l.code === code) ?? DEFAULT_LOCALE;
