// Translations of the front page. The English page (src/pages/index.astro, the HTML in
// src/landing, the nav and the layout) stays the source; a translation is a table from each
// English string, written exactly as the source has it, to the same string in another language.
//
// In the page's HTML a string is replaced only where it is a whole text (">…<") or a whole
// attribute value ("="…""), so "cost" never matches inside a sentence. Strings in the page's own
// data (the FAQ, the footer, the title) go through t(), which stops the build when the table has
// no entry. test/i18n.test.mjs fails when a table keeps a string the English page no longer has,
// and when an English string shows on a translated page.
import { DEFAULT_LOCALE } from "./locales.mjs";
import de from "./home/de.ts";
import es from "./home/es.ts";
import fr from "./home/fr.ts";
import ja from "./home/ja.ts";
import ko from "./home/ko.ts";
import ptBr from "./home/pt-br.ts";
import zh from "./home/zh.ts";

export const TABLES: Record<string, Record<string, string>> = { de, es, fr, ja, ko, "pt-br": ptBr, zh };

export interface Translator {
  /** One string from the page's data; the English string itself for English. */
  t: (en: string) => string;
  /** Every whole text and attribute value in a piece of the page's HTML that the table has. */
  html: (source: string) => string;
}

export function translator(code: string = DEFAULT_LOCALE.code): Translator {
  if (code === DEFAULT_LOCALE.code) return { t: (en) => en, html: (source) => source };
  const table = TABLES[code];
  if (!table) throw new Error(`i18n: no translation table for "${code}" (src/i18n/home/${code}.ts)`);
  return {
    t(en) {
      const out = table[en];
      if (out === undefined) throw new Error(`i18n: src/i18n/home/${code}.ts has no translation for ${JSON.stringify(en)}`);
      return out;
    },
    html(source) {
      let out = source;
      for (const [en, local] of Object.entries(table))
        // split/join, not replace: a "$" in the text stays a "$".
        for (const [l, r] of [[">", "<"], ['="', '"']]) out = out.split(l + en + r).join(l + local + r);
      return out;
    },
  };
}
