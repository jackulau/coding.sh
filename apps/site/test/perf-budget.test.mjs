// scripts/perf-budget.mjs keys its budgets by site path (/docs/cli/) and groups
// pages by it (/docs/ pages share the docs budgets), so it names each page with /
// on every platform: on Windows path.relative gives docs\cli\index.html.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/perf-budget.mjs", import.meta.url));

test("a docs page gets the docs budgets and is named with / on every platform", () => {
  const dist = mkdtempSync(join(tmpdir(), "site-perf-budget-"));
  try {
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>home</title>");
    mkdirSync(join(dist, "docs", "x"), { recursive: true });
    // About 3KB of inline JS after brotli: under the docs budget (4.4KB), over the one for other pages (1.4KB).
    const js = `var x="${randomBytes(3000).toString("hex")}";`;
    writeFileSync(join(dist, "docs", "x", "index.html"), `<!doctype html><title>x</title><script>${js}</script>`);
    const r = spawnSync(process.execPath, [SCRIPT, "--dist", dist], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ +js +\/docs\/x\/ inline /m, "the page is named /docs/x/");
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});
