#!/usr/bin/env node
// The html_bytes budgets of scripts/perf/budgets.json, checked on a site build without a browser.
// Each page of lighthouse.mjs is read from the build and compressed as scripts/perf/serve.mjs sends
// it, so the bytes are the ones Site perf measures. Site perf runs in CI's full suite; `npm run gate`
// runs this after its site build, so a page over its HTML budget fails before the pull request.
// The other byte budgets count what the browser loads and are left to Site perf.
//
//   node scripts/perf/html-budget.mjs [--dist apps/site/dist] [--budgets scripts/perf/budgets.json]
//
// Exit code: 0 when every page is within its budgets, 1 when one is over, 2 on a usage error or a
// page missing from the build.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { metricMatches } from "../../packages/coding.sh/src/experiments/metrics.ts";
import { isMain } from "../dogfood/lib/main.mjs";
import { PAGES, PROFILES } from "./lighthouse.mjs";
import { brotli, candidates, compresses } from "./serve.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * Each page's HTML bytes as Site perf measures them, checked against every html_bytes budget that
 * names the page under either profile (both load the same HTML). Throws when a page is not built.
 */
export function checkHtmlBudgets(dist, budgets) {
  const pages = [];
  const failures = [];
  for (const [page, path] of Object.entries(PAGES)) {
    const file = candidates(path).map((c) => join(dist, c)).find((f) => existsSync(f));
    if (!file) throw new Error(`${dist} has no page for ${path}; build the site first`);
    const body = readFileSync(file);
    const bytes = compresses(".html", body) ? brotli(body).length : body.length;
    const limits = [];
    for (const profile of PROFILES) {
      const name = `${profile}.${page}.html_bytes`;
      for (const [pattern, max] of Object.entries(budgets)) {
        if (pattern.startsWith("$") || !metricMatches(name, [pattern])) continue;
        limits.push(max);
        if (bytes > max) failures.push(`${name} is ${bytes}, budget ${max} (${pattern})`);
      }
    }
    pages.push({ page, path, bytes, budget: limits.length ? Math.min(...limits) : undefined });
  }
  return { pages, failures };
}

function main() {
  const { values } = parseArgs({
    options: { dist: { type: "string", default: join(ROOT, "apps/site/dist") }, budgets: { type: "string", default: join(ROOT, "scripts/perf/budgets.json") } },
  });
  let result;
  try {
    result = checkHtmlBudgets(resolve(values.dist), JSON.parse(readFileSync(values.budgets, "utf8")));
  } catch (e) {
    console.error(`html-budget: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  for (const p of result.pages) {
    const room = p.budget === undefined ? "no budget" : p.bytes > p.budget ? `${p.bytes - p.budget} B over` : `${p.budget - p.bytes} B under`;
    console.log(`${p.page.padEnd(10)} ${p.path.padEnd(16)} ${String(p.bytes).padStart(6)} B  budget ${p.budget ?? "-"}  ${room}`);
  }
  for (const f of result.failures) console.error(`perf: ${f}`);
  if (result.failures.length) {
    console.error("A page is over its HTML budget. Trim the page, or raise the budget in scripts/perf/budgets.json and say why.");
    return 1;
  }
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
