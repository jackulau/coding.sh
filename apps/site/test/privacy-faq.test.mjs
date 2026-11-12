// The privacy FAQ answers must name the daily update check, because the code
// makes that request by default (packages/coding.sh/src/update).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, "utf8");

/** The answer text that follows the "leave my machine" question, up to the next question. */
export function leaveAnswer(src) {
  const i = src.search(/q:\s*["`]Does anything leave my machine\?/);
  if (i < 0) return "";
  const rest = src.slice(i);
  const next = rest.slice(10).search(/\bq:\s*["`]/);
  return next < 0 ? rest : rest.slice(0, next + 10);
}

/** True when the answer names the update check and how to turn it off. */
export const namesUpdateCheck = (answer) => /update check/i.test(answer) && /CODING_SH_NO_UPDATE_CHECK/.test(answer);

test("the seeded old answer fails the check", () => {
  const old = 'q: "Does anything leave my machine?", a: "No. Sessions are saved in ~/.coding.sh. Nothing is sent anywhere unless you set up an export yourself." },\n { q: "Next?"';
  assert.equal(namesUpdateCheck(leaveAnswer(old)), false);
});

test("the code checks for updates by default", () => {
  const src = read("packages/coding.sh/src/update/index.ts");
  assert.match(src, /CODING_SH_NO_UPDATE_CHECK/);
  assert.match(src, /registry\.npmjs\.org/);
});

test("the landing and FAQ privacy answers name the daily update check", () => {
  for (const file of ["apps/site/src/pages/index.astro", "apps/site/src/pages/docs/faq.astro"]) {
    const answer = leaveAnswer(read(file));
    assert.ok(answer.length > 0, `${file}: no "Does anything leave my machine?" question`);
    assert.ok(namesUpdateCheck(answer), `${file}: the answer must name the daily update check and CODING_SH_NO_UPDATE_CHECK`);
  }
});
