import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { chromeArgs, describeClose, findChrome, launchBrowser, loadTimeoutMessage, startFailureMessage } from "./browser.ts";

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

test("test Chrome stays out of the macOS keychain, which a test HOME does not have", () => {
  // Without these, every launch under a temp HOME pops "A keychain cannot be found" on the desktop.
  const args = chromeArgs("/tmp/profile");
  assert.ok(args.includes("--use-mock-keychain"));
  assert.ok(args.includes("--password-store=basic"));
  assert.ok(args.includes("--user-data-dir=/tmp/profile"));
});

test("test Chrome does not look up the system's proxy: the viewer is on this machine", () => {
  // On Windows the lookup holds the first page load of every new Chrome for 0.6-1.7 s.
  assert.ok(chromeArgs("/tmp/profile").includes("--no-proxy-server"));
});

test("CODING_SH_TEST_CHROME wins, and a wrong one fails instead of skipping", () => {
  const pick = exe("custom");
  assert.equal(findChrome({ CODING_SH_TEST_CHROME: pick, PROGRAMFILES: dir("Program Files") }, "win32"), pick);
  assert.throws(() => findChrome({ CODING_SH_TEST_CHROME: join(root, "missing.exe") }, "win32"), /does not exist/);
});

/** Runs `run` with the temp folder at a new empty one, where launchBrowser makes its profile. */
async function inTemp(run: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(root, "tmp-"));
  const saved = ["TMPDIR", "TMP", "TEMP"].map((k) => [k, process.env[k]] as const);
  for (const [k] of saved) process.env[k] = tmp;
  try {
    assert.equal(tmpdir(), tmp);
    await run(tmp);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a Chrome that exits at start fails the start and leaves no profile behind", async () => {
  // Node stands in for a Chrome that will not run with these flags: it exits at once on --headless=new.
  await inTemp(async (tmp) => {
    await assert.rejects(launchBrowser(process.execPath), /^Error: Chrome exited \(\d+\): /);
    assert.deepEqual(readdirSync(tmp), []);
  });
});

test("a Chrome that cannot be run fails the start instead of the test file, and leaves no profile behind", async () => {
  await inTemp(async (tmp) => {
    await assert.rejects(launchBrowser(join(root, "no-such-chrome")), { code: "ENOENT" });
    assert.deepEqual(readdirSync(tmp), []);
  });
});

test("a Chrome that refuses remote debugging fails at once, is stopped, and leaves no profile behind", { skip: process.platform === "win32" && "the stand-in for Chrome is a shell script" }, async () => {
  // Chrome's line when it will not open DevTools; it then runs on and never says where they listen.
  const pidFile = join(root, "refusing-chrome.pid");
  const standIn = join(root, "refusing-chrome");
  writeFileSync(standIn, `#!/bin/sh\necho $$ > '${pidFile}'\necho 'DevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir.' >&2\nexec sleep 60\n`);
  chmodSync(standIn, 0o755);
  await inTemp(async (tmp) => {
    const t0 = performance.now();
    await assert.rejects(launchBrowser(standIn), /^Error: Chrome refused remote debugging: DevTools remote debugging requires a non-default data directory\./);
    // Not the 20 s a start may take: the refusal is final.
    assert.ok(performance.now() - t0 < 10_000, `failed after ${Math.round(performance.now() - t0)} ms`);
    assert.deepEqual(readdirSync(tmp), []);
  });
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the stand-in for Chrome still runs");
});

test("a refusal on Windows says which folder a test home is missing", () => {
  const stderr = "DevTools remote debugging requires a non-default data directory. Specify this using --user-data-dir.\n";
  assert.equal(
    startFailureMessage("Chrome refused remote debugging", stderr, "win32"),
    `Chrome refused remote debugging: ${stderr}\nChrome says this when USERPROFILE names a folder with no AppData\\Local in it, as a test home can. Make that folder (scripts/gate.mjs does).`,
  );
  assert.equal(startFailureMessage("Chrome refused remote debugging", stderr, "linux"), `Chrome refused remote debugging: ${stderr}`);
  assert.equal(startFailureMessage("Chrome exited (1)", "x".repeat(600) + "the end", "win32"), `Chrome exited (1): ${"x".repeat(493)}the end`);
});

const chrome = findChrome();
test("a DevTools call after Chrome has gone fails at once instead of waiting forever", { skip: !chrome && "no Chrome", timeout: 20_000 }, async () => {
  const browser = await launchBrowser(chrome!);
  const page = await browser.newPage();
  assert.equal(await page.eval("1 + 1"), 2);
  const closed = await browser.close();
  // The call has to fail because the connection is gone. Failing on the 30 s wait for an
  // answer is the bug: this test's own time limit ends first.
  const t0 = performance.now();
  await assert.rejects(page.send("Runtime.evaluate", { expression: "1" }), /the connection is closed|connection closed before Chrome answered/);
  const callMs = performance.now() - t0;
  assert.ok(closed.ms + callMs < 10_000, `the failed call took ${Math.round(callMs)} ms after a close of ${describeClose(closed)}`);
});

test("a slow close names its steps", () => {
  assert.equal(
    describeClose({ ms: 16291.4, askMs: 12.2, exitMs: 3001.7, killed: true, profileMs: 13277.5, profileLeft: true }),
    "16291 ms: Browser.close 12 ms, exit 3002 ms (killed after the wait), profile removal 13278 ms (left behind)",
  );
  assert.equal(
    describeClose({ ms: 240, askMs: 30, exitMs: 200, killed: false, profileMs: 10, profileLeft: false }),
    "240 ms: Browser.close 30 ms, exit 200 ms, profile removal 10 ms",
  );
});

test("a slow close is printed on stderr, so a script's stdout stays its result", () => {
  const steps = (ms: number) => JSON.stringify({ ms, askMs: 5, exitMs: ms - 20, killed: false, profileMs: 15, profileLeft: false });
  const run = (ms: number) =>
    spawnSync(process.execPath, ["--no-warnings", "-e", `import(${JSON.stringify(new URL("./browser.ts", import.meta.url).href)}).then((m) => m.noteClose(${steps(ms)}))`], { encoding: "utf8" });
  const slow = run(2362);
  assert.equal(slow.status, 0, slow.stderr);
  assert.equal(slow.stdout, "");
  assert.equal(slow.stderr, "# slow Chrome close, 2362 ms: Browser.close 5 ms, exit 2342 ms, profile removal 15 ms\n");
  const quick = run(240);
  assert.equal(quick.stdout + quick.stderr, "");
});

test("a page load that runs out of time says where the time went", () => {
  // A renderer that held one check for the whole wait: the stall seen on Windows runners.
  assert.equal(
    loadTimeoutMessage({ waitedMs: 8931, navigateMs: 31.4, checks: 1, slowestCheckMs: 8890, readyState: "loading", href: "http://127.0.0.1:5173/" }),
    'timed out waiting for page load after 8.9 s: Page.navigate took 31 ms, then 1 check of the page, the slowest took 8.9 s; the last saw readyState "loading" at http://127.0.0.1:5173/',
  );
  // A slow Page.navigate, and a page that never left about:blank.
  assert.equal(
    loadTimeoutMessage({ waitedMs: 9400, navigateMs: 4200, checks: 97, slowestCheckMs: 12, readyState: "complete", href: "about:blank" }),
    'timed out waiting for page load after 9.4 s: Page.navigate took 4.2 s, then 97 checks of the page, the slowest took 12 ms; the last saw readyState "complete" at about:blank',
  );
  assert.match(loadTimeoutMessage({ waitedMs: 5100, navigateMs: 20, checks: 3, slowestCheckMs: 30, error: "Cannot find context with specified id (-32000)" }), /; the last failed: Cannot find context with specified id \(-32000\)$/);
});

test("goto stops at its limit on a page that does not finish loading, and names the page's state", { skip: !chrome && "no Chrome", timeout: 60_000 }, async () => {
  // The page's script never arrives, so the document stays in "loading".
  const held: import("node:http").ServerResponse[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/never.js") held.push(res);
    else res.writeHead(200, { "content-type": "text/html" }).end("<title>stuck</title><script src=/never.js></script>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const browser = await launchBrowser(chrome!);
  try {
    const page = await browser.newPage();
    const t0 = Date.now();
    await assert.rejects(
      page.goto(url, 600),
      (e: Error) => {
        assert.match(e.message, /^timed out waiting for page load after \d+(\.\d s| ms): Page\.navigate took \d+(\.\d s| ms), then \d+ checks? of the page, the slowest took \d+(\.\d s| ms); the last saw readyState "loading" at http:\/\/127\.0\.0\.1:\d+\/$/);
        return true;
      },
    );
    assert.ok(Date.now() - t0 < 20_000, `the wait took ${Date.now() - t0} ms`);
    // A page that loads within the limit it is given still does.
    await page.goto("data:text/html,<title>ok</title>", 30_000);
    assert.equal(await page.eval("document.title"), "ok");
    await page.close();
  } finally {
    await browser.close();
    for (const res of held) res.destroy();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
