// A reference table's first column holds names a reader copies whole: an env
// var (CODING_SH_INGEST_KEY), a flag, a field. doc.css keeps the code there on
// one line, and the table scrolls sideways inside its box, so a name never
// splits as "CODING_SH_ING / EST_KEY". A stacked card on a phone does not
// scroll, so there it may wrap again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/styles/doc.css", import.meta.url), "utf8");
const rule = (selector) => {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return CSS.match(new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

test("code in a table's first column stays on one line", () => {
  const body = rule(".doc-table td:first-child code");
  assert.match(body, /white-space:\s*nowrap/);
  assert.match(body, /overflow-wrap:\s*normal/, "overrides the prose rule overflow-wrap: anywhere");
  assert.match(rule(".doc-table"), /overflow-x:\s*auto/, "the table scrolls instead of the page");
});

test("a stacked table card lets its name wrap", () => {
  assert.match(rule(".doc-table--stack td:first-child code"), /white-space:\s*normal/);
});
