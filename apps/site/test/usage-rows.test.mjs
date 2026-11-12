// The landing's usage table is the real command's output, not typed by hand:
// scripts/shots/seed.mjs writes src/data/usage-rows.json and index.astro reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { usageRows } from "../scripts/shots/usage-rows.mjs";

const SITE = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFileSync(`${SITE}${p}`, "utf8");

test("usageRows reads the four columns from the command's tab-separated output", () => {
  const out = "AGENT\tSESSIONS\tTURNS\tTOKENS\tOUTPUT\tTOK/TURN\tCACHE READ\tCOST\ncodex\t14\t38\t4.0M\t52.4k\t26.1k\t76%\t~$2.08\n";
  assert.deepEqual(usageRows(out).rows, [["codex", "14", "4.0M", "~$2.08"]]);
  assert.throws(() => usageRows("AGENT\tSESSIONS\nx\t1"), /no TOKENS, COST column/);
});

test("the landing reads its usage rows from the generated file", () => {
  const page = read("src/pages/index.astro");
  assert.match(page, /import usage from "\.\.\/data\/usage-rows\.json"/);
  assert.doesNotMatch(page, /USAGE_ROWS\s*(?::[^=]*)?=\s*\[\s*\[/, "USAGE_ROWS is typed by hand; read data/usage-rows.json");
  assert.doesNotMatch(page, /\["claude-code", "\d+"/, "a usage row is typed by hand in index.astro");
});

test("seed.mjs writes the file the landing reads", () => {
  const seed = read("scripts/shots/seed.mjs");
  assert.match(seed, /usage-rows\.json/);
  assert.match(seed, /usageRows\(usage\)/);
});

test("data/usage-rows.json has a row per agent with sessions, tokens and a cost", () => {
  const data = JSON.parse(read("src/data/usage-rows.json"));
  assert.deepEqual(data.head, ["AGENT", "SESSIONS", "TOKENS", "COST"]);
  assert.ok(data.rows.length >= 2);
  for (const r of data.rows) {
    assert.equal(r.length, 4);
    assert.match(r[1], /^\d+$/);
    assert.match(r[2], /^[\d.]+[kMG]?$/);
    assert.match(r[3], /^~?\$\d/);
  }
});
