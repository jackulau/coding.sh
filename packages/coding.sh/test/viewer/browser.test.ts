import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { findChrome, launchBrowser } from "./browser.ts";

const root = mkdtempSync(join(tmpdir(), "find-chrome-"));
after(() => rmSync(root, { recursive: true, force: true }));
const dir = (base: string) => join(root, base);
const exe = (base: string) => {
  const p = join(dir(base), "Google", "Chrome", "Application", "chrome.exe");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "");
  return p;
};

test("on Windows, Chrome is found under Program Files, then Program Files (x86), then the per-user install", () => {
  const env = { PROGRAMFILES: dir("Program Files"), "PROGRAMFILES(X86)": dir("Program Files (x86)"), LOCALAPPDATA: dir("Local") };
  assert.equal(findChrome(env, "win32"), undefined);
  const user = exe("Local");
  assert.equal(findChrome(env, "win32"), user);
  const x86 = exe("Program Files (x86)");
  assert.equal(findChrome(env, "win32"), x86);
  const machine = exe("Program Files");
  assert.equal(findChrome(env, "win32"), machine);
  assert.equal(findChrome({}, "win32"), undefined);
});

test("CODING_SH_TEST_CHROME wins, and a wrong one fails instead of skipping", () => {
  const pick = exe("custom");
  assert.equal(findChrome({ CODING_SH_TEST_CHROME: pick, PROGRAMFILES: dir("Program Files") }, "win32"), pick);
  assert.throws(() => findChrome({ CODING_SH_TEST_CHROME: join(root, "missing.exe") }, "win32"), /does not exist/);
});

const chrome = findChrome();
test("a DevTools call after Chrome has gone fails at once instead of waiting forever", { skip: !chrome && "no Chrome", timeout: 20_000 }, async () => {
  const browser = await launchBrowser(chrome!);
  const page = await browser.newPage();
  assert.equal(await page.eval("1 + 1"), 2);
  const t0 = Date.now();
  await browser.close();
  await assert.rejects(page.send("Runtime.evaluate", { expression: "1" }), /CDP/);
  assert.ok(Date.now() - t0 < 10_000, `close and the failed call took ${Date.now() - t0} ms`);
});
