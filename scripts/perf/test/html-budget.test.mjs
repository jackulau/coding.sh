// Run: node --no-warnings --test scripts/perf/test/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zc } from "node:zlib";
import { after, test } from "node:test";
import { metricMatches } from "../../../packages/coding.sh/src/experiments/metrics.ts";
import { checkHtmlBudgets } from "../html-budget.mjs";
import { PAGES, PROFILES } from "../lighthouse.mjs";

const SCRIPT = fileURLToPath(new URL("../html-budget.mjs", import.meta.url));
const BUDGETS = JSON.parse(readFileSync(new URL("../budgets.json", import.meta.url), "utf8"));
const tmp = mkdtempSync(join(tmpdir(), "html-budget-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A built site with every measured page: /docs/evals as docs/evals.html, the rest as <path>/index.html. */
function site(name, { skip } = {}) {
  const dist = join(tmp, name);
  for (const [page, path] of Object.entries(PAGES)) {
    if (page === skip) continue;
    const file = path === "/" ? "index.html" : page === "evals" ? `${path.slice(1)}.html` : `${path.slice(1)}/index.html`;
    const rows = Array.from({ length: 400 }, (_, i) => `<tr><td>${page}-${i}</td><td>${(i * 7919) % 104729}</td></tr>`).join("\n");
    mkdirSync(dirname(join(dist, file)), { recursive: true });
    writeFileSync(join(dist, file), `<!doctype html><title>${page}</title><table>\n${rows}\n</table>\n`);
  }
  return dist;
}

/** Brotli at quality 4 with the size hint, written out here rather than taken from serve.mjs. */
const sent = (file) => {
  const body = readFileSync(file);
  return brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 4, [zc.BROTLI_PARAM_SIZE_HINT]: body.length } }).length;
};

test("counts each page's HTML as serve.mjs sends it, and fails a page over its budget", () => {
  const dist = site("over");
  const cli = sent(join(dist, "docs/cli/index.html"));
  const evals = sent(join(dist, "docs/evals.html"));
  const r = checkHtmlBudgets(dist, { $comment: "x", "*.cli.html_bytes": cli - 1, "mobile.evals.html_bytes": evals, "*.home.js_bytes": 1 });
  assert.equal(r.pages.find((p) => p.page === "cli").bytes, cli);
  assert.equal(r.pages.find((p) => p.page === "evals").bytes, evals, "docs/evals.html answers /docs/evals");
  assert.equal(r.pages.find((p) => p.page === "home").budget, undefined, "a js_bytes budget is not an HTML budget");
  // Both profiles load the same HTML, so a * budget fails under each; an exact fit passes.
  assert.deepEqual(r.failures, [`desktop.cli.html_bytes is ${cli}, budget ${cli - 1} (*.cli.html_bytes)`, `mobile.cli.html_bytes is ${cli}, budget ${cli - 1} (*.cli.html_bytes)`]);
});

test("the command exits 1 over a budget, 0 within, and 2 when a page is not built", () => {
  const dist = site("cmd");
  const cli = sent(join(dist, "docs/cli/index.html"));
  const run = (budgets, d = dist) => {
    const file = join(tmp, `budgets-${budgets["*.cli.html_bytes"]}.json`);
    writeFileSync(file, JSON.stringify(budgets));
    return spawnSync(process.execPath, ["--no-warnings", SCRIPT, "--dist", d, "--budgets", file], { encoding: "utf8" });
  };
  const over = run({ "*.cli.html_bytes": cli - 10 });
  assert.equal(over.status, 1, over.stderr);
  assert.match(over.stdout, new RegExp(`^cli +/docs/cli +${cli} B  budget ${cli - 10}  10 B over$`, "m"));
  assert.match(over.stderr, /^perf: mobile\.cli\.html_bytes is \d+, budget \d+ \(\*\.cli\.html_bytes\)$/m);
  assert.match(over.stderr, /raise the budget in scripts\/perf\/budgets\.json and say why/);
  const within = run({ "*.cli.html_bytes": cli });
  assert.equal(within.status, 0, within.stderr);
  assert.match(within.stdout, /^cli .* 0 B under$/m);
  const missing = run({ "*.cli.html_bytes": cli }, site("missing", { skip: "changelog" }));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /has no page for \/changelog; build the site first/);
});

test("every page Site perf measures has an html_bytes budget under both profiles", () => {
  for (const page of Object.keys(PAGES)) {
    for (const profile of PROFILES) {
      const name = `${profile}.${page}.html_bytes`;
      assert.ok(Object.keys(BUDGETS).some((p) => !p.startsWith("$") && metricMatches(name, [p])), `${name} has a budget`);
    }
  }
});
