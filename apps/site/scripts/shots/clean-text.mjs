// Text a screenshot must not show. The landing page's pictures are PNG/WebP, so
// no text check can read them afterward; capture.mjs reads the page's visible
// text before each screenshot instead and refuses to shoot when it finds one.
// test/shots-guard.test.mjs checks this module and that capture.mjs calls it.

// Built with join so this file does not itself contain the banned strings.
const AGENTS_FILE = new RegExp(["claude", "md"].join("\\."), "i");
const JARGON_LABEL = new RegExp(["fixture", "tested"].join("[- ]"), "i");

/** [name, pattern] for each kind of text a picture must not carry. */
export const BANNED_TEXT = [
  ["the vendor instructions file name (say AGENTS.md)", AGENTS_FILE],
  ["the test-jargon status label (say Not run live)", JARGON_LABEL],
  ["a dev host and port", /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b/],
  ["placeholder data", /\b(?:sample|demo|dummy|placeholder|lorem ipsum)\s+(?:data|sessions?|runs?|text)\b|\bacme\b/i],
];

/** What the text shows that a picture must not, as "name: matched text". */
export function dirtyText(text) {
  return BANNED_TEXT.flatMap(([name, re]) => {
    const m = re.exec(text);
    return m ? [`${name}: "${m[0]}"`] : [];
  });
}

/** Throws when text (a page's visible text) shows something a picture must not; `where` names the shot. */
export function assertCleanText(text, where) {
  const found = dirtyText(text);
  if (found.length) throw new Error(`${where}: the page shows text a screenshot must not carry:\n  ${found.join("\n  ")}`);
}
