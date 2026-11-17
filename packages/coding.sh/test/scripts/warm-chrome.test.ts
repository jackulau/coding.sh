import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIRST_START_LIMIT_MS,
  chromeProcesses,
  firstStart,
  firstStartArgs,
  firstStartReport,
  pressureTotals,
  readPressure,
  stoppedState,
  viewerPages,
  type FirstStart,
} from "../../scripts/warm-chrome.ts";
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
    const printed: string[] = [];
    const print = (text: string) => printed.push(text);
    const t0 = performance.now();
    await assert.rejects(firstStart(slow, 300, print), /Chrome's first start took longer than 300 ms and was stopped\. It had printed nothing\. Its stderr ended: \(empty\)/);
    assert.ok(performance.now() - t0 < 10_000);
    // A stopped start prints its report before it fails.
    assert.equal(printed.length, 1);
    assert.match(printed[0]!, /^warm-chrome: the first start was stopped at its limit of 300 ms\. What it did:\n/);
    assert.match(printed[0]!, /First byte on stderr: never\. First byte on stdout: never\.\n/);
    assert.match(printed[0]!, /Chrome's stderr, 0 bytes:\n  \| \(empty\)$/);
    // A Chrome that did its work and never exited reads differently from one that never came up.
    writeFileSync(slow, "#!/bin/sh\necho '<title>warm</title>'\necho 'the last thing Chrome said' >&2\nexec sleep 30\n");
    await assert.rejects(firstStart(slow, 3000, print), /was stopped\. It had printed the page and had not exited\. Its stderr ended: the last thing Chrome said/);
    assert.equal(printed.length, 2);
    assert.match(printed[1]!, /First byte on stderr: after \d+ ms\. First byte on stdout: after \d+ ms\.\n/);
    assert.match(printed[1]!, /Chrome's stderr, 27 bytes:\n  \| the last thing Chrome said$/);
    // Each pipe's first byte has a time of its own: this Chrome writes to stderr and never to stdout.
    writeFileSync(slow, "#!/bin/sh\necho 'only on stderr' >&2\nexec sleep 30\n");
    await assert.rejects(firstStart(slow, 3000, print), /was stopped\. It had printed nothing\. Its stderr ended: only on stderr/);
    assert.match(printed[2]!, /First byte on stderr: after \d+ ms\. First byte on stdout: never\.\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a first start that ends in time prints its report too", { skip: process.platform === "win32" && "the stand-in for Chrome is a shell script" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "csh-warm-test-"));
  try {
    // Chrome's lines come before its page, and its last line can come as it exits.
    const chrome = join(dir, "chrome");
    writeFileSync(chrome, "#!/bin/sh\necho 'an early line' >&2\nsleep 0.4\necho '<title>warm</title>'\necho 'a last line' >&2\n");
    chmodSync(chrome, 0o755);
    const printed: string[] = [];
    const fast = await firstStart(chrome, 10_000, (text) => printed.push(text));
    assert.equal(fast.stopped, false);
    assert.equal(fast.stderr, "an early line\na last line\n");
    assert.equal(fast.stderrBytes, 26);
    // The page comes after the sleep, however busy the machine: a bound that load cannot break.
    assert.ok(fast.firstStdoutMs! >= 300 && fast.firstStdoutMs! <= fast.ms, `${fast.firstStdoutMs} ${fast.ms}`);
    assert.ok(fast.firstStderrMs! <= fast.ms, `${fast.firstStderrMs} ${fast.ms}`);
    assert.ok(Math.abs(Date.now() - fast.ms - fast.spawnedAt.getTime()) < 5_000);
    // Where the system has pressure files, the start carries them from both of its ends.
    assert.equal(fast.pressure !== undefined, readPressure() !== undefined);
    const io = fast.pressure && { before: fast.pressure.before.io, after: fast.pressure.after.io };
    if (io?.before && io.after) assert.ok(io.after.some >= io.before.some);
    assert.equal(printed.length, 1);
    assert.equal(printed[0]!, firstStartReport(fast));
    assert.match(printed[0]!, /^warm-chrome: the first start took \d+ ms\. What it did:\n/);
    assert.match(printed[0]!, /Chrome's stderr, 26 bytes:\n  \| an early line\n  \| a last line$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the report of a start has the whole stderr, the first bytes' times and the stalled time", () => {
  const us = (ms: number) => ms * 1000;
  const start: FirstStart = {
    ms: 9_123.4,
    stderrBytes: 2_015,
    limitMs: 60_000,
    stopped: false,
    spawnedAt: new Date(2026, 10, 17, 12, 3, 2, 81),
    firstStderrMs: 8_012.6,
    firstStdoutMs: 9_001.2,
    stderr: `first line \r\n${"x".repeat(2000)}\n\n`,
    pressure: {
      before: { io: { some: us(100), full: us(40) }, cpu: { some: us(7), full: 0 }, memory: { some: 0, full: 0 } },
      after: { io: { some: us(7_600), full: us(7_040) }, cpu: { some: us(310), full: 0 }, memory: { some: 0, full: 0 } },
    },
  };
  assert.equal(
    firstStartReport(start),
    [
      "warm-chrome: the first start took 9123 ms. What it did:",
      "  Chrome was started at 12:03:02.081 by this machine's clock, the clock in Chrome's own lines.",
      "  First byte on stderr: after 8013 ms. First byte on stdout: after 9001 ms.",
      "  Milliseconds stalled across the start, some/full, from /proc/pressure: io 7500/7000, cpu 303/0, memory 0/0.",
      "  Chrome's stderr, 2015 bytes:",
      "  | first line",
      `  | ${"x".repeat(2000)}`,
    ].join("\n"),
  );
  // A fast start reads the same way.
  assert.match(firstStartReport({ ...start, ms: 856.2 }), /^warm-chrome: the first start took 856 ms\. What it did:\n/);
  // A stopped start says so, and says when it has no pressure files or no bytes.
  const stopped = firstStartReport({ ...start, ms: 301, limitMs: 300, stopped: true, firstStderrMs: undefined, firstStdoutMs: undefined, stderr: "", pressure: undefined });
  assert.equal(
    stopped,
    [
      "warm-chrome: the first start was stopped at its limit of 300 ms. What it did:",
      "  Chrome was started at 12:03:02.081 by this machine's clock, the clock in Chrome's own lines.",
      "  First byte on stderr: never. First byte on stdout: never.",
      "  /proc/pressure was not read: this system has none.",
      "  Chrome's stderr, 0 bytes:",
      "  | (empty)",
    ].join("\n"),
  );
  // A pressure file read on one side only is left out.
  assert.match(firstStartReport({ ...start, pressure: { before: { io: { some: 0, full: 0 } }, after: { io: { some: us(5), full: us(2) }, cpu: { some: us(9), full: 0 } } } }), /from \/proc\/pressure: io 5\/2\.\n/);
});

test("the pressure files are read where the system has them", () => {
  const io = "some avg10=0.00 avg60=0.12 avg300=0.05 total=7600123\nfull avg10=0.00 avg60=0.10 avg300=0.04 total=7040456\n";
  assert.deepEqual(pressureTotals(io), { some: 7_600_123, full: 7_040_456 });
  // An older kernel's cpu file has no `full` line.
  assert.deepEqual(pressureTotals("some avg10=1.50 avg60=0.40 avg300=0.10 total=310000\n"), { some: 310_000, full: 0 });
  assert.equal(pressureTotals(""), undefined);
  assert.equal(pressureTotals("full avg10=0.00 avg60=0.00 avg300=0.00 total=5\n"), undefined);
  const dir = mkdtempSync(join(tmpdir(), "csh-warm-test-"));
  try {
    assert.equal(readPressure(join(dir, "none")), undefined);
    const some = join(dir, "pressure");
    mkdirSync(some);
    writeFileSync(join(some, "io"), io);
    writeFileSync(join(some, "memory"), "not a pressure file\n");
    assert.deepEqual(readPressure(some), { io: { some: 7_600_123, full: 7_040_456 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // This machine's own, as the script reads it.
  const own = readPressure();
  if (process.platform !== "linux") assert.equal(own, undefined);
  else if (own) for (const totals of Object.values(own)) assert.ok(totals.some >= 0 && totals.full >= 0);
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
  // The first start's report goes to stderr, so stdout stays the one line above.
  assert.match(r.stderr, /^warm-chrome: the first start took \d+ ms\. What it did:\n  Chrome was started at \d\d:\d\d:\d\d\.\d{3} by this machine's clock/);
  assert.match(r.stderr, /\n  Chrome's stderr, \d+ bytes:\n  \| /);
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
