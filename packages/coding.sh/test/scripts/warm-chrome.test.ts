import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_START_LIMIT_MS, chromeProcesses, firstStart, firstStartArgs, stoppedState, viewerPages } from "../../scripts/warm-chrome.ts";
import { chromeArgs, findChrome, launchBrowser } from "../viewer/browser.ts";

const SCRIPT = fileURLToPath(new URL("../../scripts/warm-chrome.ts", import.meta.url));
const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--no-warnings", SCRIPT], { encoding: "utf8", env, timeout: 120_000 });

test("the first start uses the tests' flags, and prints a page instead of staying open", () => {
  const args = firstStartArgs("/tmp/profile");
  const tests = chromeArgs("/tmp/profile");
  for (const flag of tests) {
    if (flag === "--remote-debugging-port=0" || flag === "about:blank") assert.ok(!args.includes(flag), flag);
    else assert.ok(args.includes(flag), flag);
  }
  assert.equal(args.length, tests.length + 1);
  assert.equal(args.at(-3), "--enable-logging=stderr");
  assert.equal(args.at(-2), "--dump-dom");
  assert.match(args.at(-1)!, /^data:text\/html,/);
});

test("a Chrome that is named and missing fails the step", () => {
  const r = run({ ...process.env, CODING_SH_TEST_CHROME: fileURLToPath(new URL("./no-such-chrome", import.meta.url)) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /CODING_SH_TEST_CHROME=.*no-such-chrome does not exist/);
});

test("a first start past its limit is stopped and fails", { skip: process.platform === "win32" && "the stand-in for Chrome is a shell script" }, async () => {
  assert.equal(FIRST_START_LIMIT_MS, 60_000);
  const dir = mkdtempSync(join(tmpdir(), "csh-warm-test-"));
  try {
    const slow = join(dir, "chrome");
    writeFileSync(slow, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(slow, 0o755);
    const t0 = performance.now();
    await assert.rejects(firstStart(slow, 300), /Chrome's first start took longer than 300 ms and was stopped\. It had printed nothing\. Its stderr ended: \(empty\)/);
    assert.ok(performance.now() - t0 < 10_000);
    // A Chrome that did its work and never exited reads differently from one that never came up.
    writeFileSync(slow, "#!/bin/sh\necho '<title>warm</title>'\necho 'the last thing Chrome said' >&2\nexec sleep 30\n");
    await assert.rejects(firstStart(slow, 3000), /was stopped\. It had printed the page and had not exited\. Its stderr ended: the last thing Chrome said/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stopped start says what Chrome had printed, and how many Chrome processes ran where that is known", () => {
  assert.equal(stoppedState("", ""), "It had printed nothing. Its stderr ended: (empty)");
  assert.equal(stoppedState("<html>", " oops \n", 3), "It had printed 6 bytes that are not the page. 3 chrome.exe processes were running. Its stderr ended: oops");
  assert.match(stoppedState("<title>warm</title>", "x".repeat(2000), 0), /^It had printed the page and had not exited\. 0 chrome\.exe processes were running\. Its stderr ended: x{800}$/);
});

test("Windows counts its Chrome processes, and no other system is asked", () => {
  if (process.platform === "win32") assert.equal(typeof chromeProcesses(), "number");
  else assert.equal(chromeProcesses(), undefined);
});

const chrome = findChrome();
test("starts Chrome twice, loads the viewer's list and Explore, and prints the five times", { skip: !chrome && "no Chrome installed" }, () => {
  const r = run(process.env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^warm-chrome: first start \d+ ms with \d+ bytes on stderr, then a start in \d+ ms and a page in \d+ ms, then the viewer's list in \d+ ms and Explore in \d+ ms \(.+\)\n$/);
});

test("the viewer pages load as a test's do: with sessions, at the tests' page size", { skip: !chrome && "no Chrome installed", timeout: 120_000 }, async () => {
  const browser = await launchBrowser(chrome!);
  // Every viewer page the warm-up loads, as it was when the warm-up closed it.
  const seen: { url: string; width: number; height: number; rows: number }[] = [];
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async () => {
    const page = await newPage();
    const close = page.close.bind(page);
    page.close = async () => {
      seen.push(await page.eval("({ url: location.pathname + location.hash, width: innerWidth, height: innerHeight, rows: document.querySelectorAll('[role=listbox] [role=option], .mx-panel').length })"));
      await close();
    };
    return page;
  };
  try {
    const times = await viewerPages(browser);
    assert.equal(times.length, 2);
    assert.deepEqual(seen.map((s) => s.url), ["/", "/#/explore"]);
    for (const s of seen) {
      // The size open() in the viewer tests gives a page before it loads it. Pages warmed at
      // another size left the tests' first page slow.
      assert.deepEqual([s.width, s.height], [1280, 900], `${s.url} was not at the tests' size`);
      assert.ok(s.rows > 0, `${s.url} showed no sessions`);
    }
  } finally {
    await browser.close();
  }
});

test("a viewer page past the limit fails with where the time went", { skip: !chrome && "no Chrome installed", timeout: 120_000 }, async () => {
  const browser = await launchBrowser(chrome!);
  // Every answer of the viewer comes 1.5 s late, so no page is ready inside the limit.
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async () => {
    const page = await newPage();
    await page.send("Network.enable");
    await page.send("Network.emulateNetworkConditions", { offline: false, latency: 1500, downloadThroughput: -1, uploadThroughput: -1 });
    return page;
  };
  try {
    const t0 = Date.now();
    await assert.rejects(viewerPages(browser, 500), /^Error: timed out waiting for (page load after .+ readyState|the viewer's list)/);
    // The limit is for the pages together: the second is not given a new one.
    assert.ok(Date.now() - t0 < 30_000, `stopped after ${Date.now() - t0} ms`);
  } finally {
    await browser.close();
  }
});

test("a viewer page that is ready only after the limit fails too", { skip: !chrome && "no Chrome installed", timeout: 120_000 }, async () => {
  const browser = await launchBrowser(chrome!);
  const limitMs = 500;
  // A busy machine: the list page loads and shows its list, and the look that sees it comes after
  // the limit. The page is given all the time it needs first, so the machine's speed decides nothing.
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async () => {
    // The limit began before this call, so it ends at most limitMs from here.
    const asked = performance.now();
    const page = await newPage();
    const goto = page.goto.bind(page);
    page.goto = async (url, timeoutMs) => {
      if (new URL(url).hash) return goto(url, timeoutMs);
      await goto(url, 60_000);
      await page.waitFor("document.querySelector('[role=listbox]')", "the list", 60_000);
      const early = asked + limitMs + 100 - performance.now();
      if (early > 0) await new Promise((r) => setTimeout(r, early));
    };
    return page;
  };
  try {
    await assert.rejects(viewerPages(browser, limitMs), /^Error: timed out waiting for the viewer's list: it was ready \d+ ms past the limit of 500 ms$/);
  } finally {
    await browser.close();
  }
});
