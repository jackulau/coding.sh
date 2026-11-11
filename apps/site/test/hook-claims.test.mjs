// Pages say which hook script agents run: hook.sh outside Windows, hook.mjs on
// Windows (docs/ADAPTERS.md "The hook"). A page that names hook.mjs as the
// hook must say hook.sh or Windows next to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Lines naming `~/.coding.sh/bin/hook.mjs` with no hook.sh or Windows within two lines. */
export function bareMjs(text) {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    if (!/~\/\.coding\.sh\/bin\/hook\.mjs/.test(line)) return [];
    const near = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
    return /hook\.sh|Windows/.test(near) ? [] : [{ line: i + 1, text: line.trim() }];
  });
}

test("bareMjs flags the seeded sentence and passes the fixed one", () => {
  assert.equal(bareMjs("`init` points each detected agent's hooks at `~/.coding.sh/bin/hook.mjs` and registers").length, 1);
  assert.equal(bareMjs("`init` points hooks at `~/.coding.sh/bin/hook.sh` (`hook.mjs` on Windows)").length, 0);
});

test("install and docs home name hook.sh as the hook outside Windows", () => {
  const problems = [];
  for (const file of ["docs/guides/install.md", "apps/site/src/pages/docs/index.astro", "apps/site/src/pages/docs/quickstart.astro"]) {
    let text = "";
    try { text = readFileSync(`${ROOT}${file}`, "utf8"); } catch { continue; }
    for (const m of bareMjs(text)) problems.push(`${file}:${m.line}: ${m.text.slice(0, 120)}`);
  }
  assert.deepEqual(problems, []);
  assert.match(readFileSync(`${ROOT}docs/guides/install.md`, "utf8"), /hook\.sh/);
});
