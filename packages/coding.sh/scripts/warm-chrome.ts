// Starts Chrome once before the tests do. CI runs it as a step of its own, before
// scripts/test-ci.mjs (.github/workflows/ci.yml).
//
// The first Chrome start on a fresh runner waits on a cold disk: 5-30 s in measured runs, against
// the 20 s a viewer test gives a start (launchBrowser in test/viewer/browser.ts). Every later start
// on the same machine takes under a second. So the first start happens here, where it is timed and
// printed and has a limit of its own (FIRST_START_LIMIT_MS). Then one start and one page load run
// the way a test runs them, under the tests' limits: if that fails, Chrome is not ready and the job
// stops before the tests. No Chrome is an error here, never a skip.
//
//   node scripts/warm-chrome.ts
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromeArgs, findChrome, launchBrowser } from "../test/viewer/browser.ts";

/** A page with markup and a script, so the first start also brings up a renderer and V8. */
const PAGE = "data:text/html,<title>cold</title><p>warm</p><script>document.title='warm'</script>";

/**
 * The tests' flags, with the two that keep Chrome open swapped for a page to print: Chrome starts,
 * loads the page, writes its DOM and exits by itself.
 */
export function firstStartArgs(dir: string): string[] {
  const args = chromeArgs(dir);
  const kept = args.filter((a) => a !== "--remote-debugging-port=0" && a !== "about:blank");
  if (kept.length !== args.length - 2) throw new Error("chromeArgs no longer has --remote-debugging-port=0 and about:blank");
  return [...kept, "--dump-dom", PAGE];
}

/**
 * The longest a first start may take before the step fails. Twice the slowest cold read of
 * Chrome's files measured on a fresh runner (29.7 s); the slowest first start measured is 20.9 s.
 */
export const FIRST_START_LIMIT_MS = 60_000;

/** Runs Chrome to its own exit and returns the time it took. Past the limit it is killed and the start fails. */
export function firstStart(chrome: string, limitMs = FIRST_START_LIMIT_MS): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "csh-chrome-warm-"));
  const t0 = performance.now();
  const child = spawn(chrome, firstStartArgs(dir), { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  return new Promise<number>((resolve, reject) => {
    let late = false;
    const limit = setTimeout(() => {
      late = true;
      child.kill("SIGKILL");
    }, limitMs);
    child.once("error", (e) => {
      clearTimeout(limit);
      reject(e);
    });
    // `exit`, not `close`: on Windows, Chrome's helper processes can keep the pipes open after it.
    child.once("exit", (code) => {
      const ms = performance.now() - t0;
      clearTimeout(limit);
      child.stdout?.destroy();
      child.stderr?.destroy();
      // On Windows, Chrome's helpers can hold the profile for a moment after it exits.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {}
      if (late) reject(new Error(`Chrome's first start took longer than ${limitMs} ms and was stopped`));
      else if (code !== 0) reject(new Error(`Chrome exited (${code}) on its first start: ${err.slice(-500)}`));
      else if (!out.includes("<title>warm</title>")) reject(new Error(`Chrome's first start did not load the page: ${(out || err).slice(-500)}`));
      else resolve(ms);
    });
  });
}

/** One start and one page load through the tests' own launcher, under its limits. */
async function testStart(chrome: string): Promise<{ startMs: number; pageMs: number }> {
  const t0 = performance.now();
  const browser = await launchBrowser(chrome);
  try {
    const startMs = performance.now() - t0;
    const page = await browser.newPage();
    const t1 = performance.now();
    await page.goto(PAGE);
    const pageMs = performance.now() - t1;
    await page.close();
    return { startMs, pageMs };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chrome = findChrome();
  if (!chrome) {
    console.error("warm-chrome: no Chrome found. Install one, or set CODING_SH_TEST_CHROME to its path.");
    process.exit(1);
  }
  const first = await firstStart(chrome);
  const { startMs, pageMs } = await testStart(chrome);
  console.log(`warm-chrome: first start ${Math.round(first)} ms, then a start in ${Math.round(startMs)} ms and a page in ${Math.round(pageMs)} ms (${chrome})`);
}
