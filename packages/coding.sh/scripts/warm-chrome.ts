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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromeArgs, findChrome, launchBrowser } from "../test/viewer/browser.ts";

/** A page with markup and a script, so the first start also brings up a renderer and V8. */
const PAGE = "data:text/html,<title>cold</title><p>warm</p><script>document.title='warm'</script>";

/**
 * The tests' flags, with the two that keep Chrome open swapped for a page to print: Chrome starts,
 * loads the page, writes its DOM and exits by itself. --enable-logging=stderr makes Chrome write
 * its errors to stderr, which is what a stopped start has to show for itself.
 */
export function firstStartArgs(dir: string): string[] {
  const args = chromeArgs(dir);
  const kept = args.filter((a) => a !== "--remote-debugging-port=0" && a !== "about:blank");
  if (kept.length !== args.length - 2) throw new Error("chromeArgs no longer has --remote-debugging-port=0 and about:blank");
  return [...kept, "--enable-logging=stderr", "--dump-dom", PAGE];
}

/**
 * The longest a first start may take before the step fails. Twice the slowest cold read of
 * Chrome's files measured on a fresh runner (29.7 s); the slowest first start measured is 20.9 s.
 */
export const FIRST_START_LIMIT_MS = 60_000;

/**
 * What a Chrome stopped at the limit had done, for the error. "Printed nothing" is a Chrome that
 * never came up; "printed the page" is one that did its work and did not exit.
 */
export function stoppedState(out: string, err: string, processes?: number): string {
  const printed = out.includes("<title>warm</title>") ? "It had printed the page and had not exited" : out ? `It had printed ${out.length} bytes that are not the page` : "It had printed nothing";
  const running = processes === undefined ? "" : ` ${processes} chrome.exe processes were running.`;
  return `${printed}.${running} Its stderr ended: ${err.trim().slice(-800) || "(empty)"}`;
}

/** How many chrome.exe processes Windows lists, or undefined elsewhere and when the list fails. */
export function chromeProcesses(): number | undefined {
  if (process.platform !== "win32") return undefined;
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.split("\n").filter((l) => l.startsWith('"chrome.exe"')).length : undefined;
}

/**
 * Runs Chrome to its own exit and returns the time it took and how much it wrote to stderr. Past the
 * limit it is killed and the start fails, with what it had done until then.
 */
export function firstStart(chrome: string, limitMs = FIRST_START_LIMIT_MS): Promise<{ ms: number; stderrBytes: number }> {
  const dir = mkdtempSync(join(tmpdir(), "csh-chrome-warm-"));
  const t0 = performance.now();
  const child = spawn(chrome, firstStartArgs(dir), { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  return new Promise<{ ms: number; stderrBytes: number }>((resolve, reject) => {
    let late = false;
    let processes: number | undefined;
    const limit = setTimeout(() => {
      late = true;
      processes = chromeProcesses();
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
      if (late) reject(new Error(`Chrome's first start took longer than ${limitMs} ms and was stopped. ${stoppedState(out, err, processes)}`));
      else if (code !== 0) reject(new Error(`Chrome exited (${code}) on its first start: ${err.slice(-500)}`));
      else if (!out.includes("<title>warm</title>")) reject(new Error(`Chrome's first start did not load the page: ${(out || err).slice(-500)}`));
      else resolve({ ms, stderrBytes: err.length });
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
  console.log(`warm-chrome: first start ${Math.round(first.ms)} ms with ${first.stderrBytes} bytes on stderr, then a start in ${Math.round(startMs)} ms and a page in ${Math.round(pageMs)} ms (${chrome})`);
  // DIAGNOSTICS ONLY (throwaway branch): the other arm of the A/B also loads the real viewer page here.
  if (process.env.CSH_WARM === "viewer") await viewerPages(chrome, process.env.CSH_WARM_TRACE === "1");
}

async function viewerPages(chrome: string, chromeTrace: boolean): Promise<void> {
  const { MemoryIndexStore } = await import("../src/store/memory.ts");
  const { startViewer } = await import("../src/viewer/server.ts");
  const { FakeBlobs, metricFixtures } = await import("../test/viewer/fakes.ts");
  const { writeFileSync } = await import("node:fs");
  const tr = (ev: string, data: Record<string, unknown>) => (globalThis as any).__cshTrace?.(ev, data);
  const index = new MemoryIndexStore();
  const DAY = 86_400_000;
  for (const s of metricFixtures(Math.floor(Date.now() / DAY) * DAY - 11 * DAY)) await index.upsertSession(s);
  const v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
  const times: string[] = [];
  try {
    for (let b = 1; b <= 2; b++) {
      const t0 = performance.now();
      const browser = await launchBrowser(chrome);
      const startMs = Math.round(performance.now() - t0);
      try {
        for (const [i, hash] of ["", "#/explore"].entries()) {
          const page = await browser.newPage();
          await page.viewport(1280, 900);
          const traced = chromeTrace && b === 1 && i === 0;
          const chunks: any[] = [];
          let done: () => void = () => {};
          const ended = new Promise<void>((r) => (done = r));
          let off = () => {};
          if (traced) {
            off = (page as any).on((m: string, q: any) => {
              if (m === "Tracing.dataCollected") chunks.push(...q.value);
              else if (m === "Tracing.tracingComplete") done();
            });
            await page.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["toplevel", "devtools.timeline", "disabled-by-default-devtools.timeline", "v8", "v8.execute", "blink", "blink.user_timing", "loading", "navigation", "net", "netlog", "fonts", "ipc", "mojom", "startup", "browser", "renderer_host", "disabled-by-default-v8.compile"], excludedCategories: ["*"] } });
          }
          const t1 = performance.now();
          await page.goto(v.url + hash);
          const loadMs = Math.round(performance.now() - t1);
          await page.waitFor(hash ? "document.querySelector('.mx-body > *')" : "document.querySelector('[role=listbox], .panel.empty:not([aria-busy])')", "viewer body", 40_000);
          const bodyMs = Math.round(performance.now() - t1);
          if (traced) {
            await page.send("Tracing.end");
            await Promise.race([ended, new Promise((r) => setTimeout(r, 30_000))]);
            off();
            const dir = process.env.CSH_TRACE_DIR;
            if (dir) writeFileSync(join(dir, "warm-trace.json"), JSON.stringify(chunks));
            times.push(`(trace ${chunks.length} events)`);
          }
          tr("warm-page", { b, i, hash, startMs, loadMs, bodyMs, traced });
          times.push(`chrome ${b} ${hash || "/"} load ${loadMs} ms body ${bodyMs} ms`);
          await page.close();
        }
      } finally {
        await browser.close();
      }
      times.push(`chrome ${b} start ${startMs} ms`);
    }
  } finally {
    await v.close();
  }
  console.log(`warm-chrome viewer: ${times.join(", ")}`);
}
