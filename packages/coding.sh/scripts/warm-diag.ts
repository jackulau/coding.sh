// THROWAWAY: warm-up arms that are not the fix. Never for merge.
import { MemoryIndexStore } from "../src/store/memory.ts";
import { startViewer } from "../src/viewer/server.ts";
import { type Browser, launchBrowser } from "../test/viewer/browser.ts";
import { FakeBlobs, metricFixtures } from "../test/viewer/fakes.ts";

async function fixtureViewer() {
  const index = new MemoryIndexStore();
  const DAY = 86_400_000;
  for (const s of metricFixtures(Math.floor(Date.now() / DAY) * DAY - 11 * DAY)) await index.upsertSession(s);
  return startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
}

const LIST = "document.querySelector('[role=listbox], .panel.empty:not([aria-busy])')";
const EXPLORE = "document.querySelector('.mx-body > *')";

/** Run 2's warm-up: two Chromes, each loads the list and Explore at 1280x900. */
export async function run2Pages(chrome: string): Promise<void> {
  const v = await fixtureViewer();
  const times: string[] = [];
  try {
    for (let b = 1; b <= 2; b++) {
      const t0 = performance.now();
      const browser = await launchBrowser(chrome);
      const startMs = Math.round(performance.now() - t0);
      try {
        for (const hash of ["", "#/explore"]) {
          const page = await browser.newPage();
          await page.viewport(1280, 900);
          const t1 = performance.now();
          await page.goto(v.url + hash, 60_000);
          const loadMs = Math.round(performance.now() - t1);
          await page.waitFor(hash ? EXPLORE : LIST, "viewer body", 40_000);
          times.push(`chrome ${b} ${hash || "/"} load ${loadMs} ms body ${Math.round(performance.now() - t1)} ms`);
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
  console.log(`warm-diag run2: ${times.join(", ")}`);
}

/** One Chrome: the list at the default size, with an override of that same size, at 1280x900 twice, then Explore. */
export async function pairedPages(browser: Browser): Promise<void> {
  const v = await fixtureViewer();
  const out: string[] = [];
  try {
    let size = { w: 0, h: 0, dpr: 0 };
    const steps: { name: string; hash: string; view?: () => [number, number] }[] = [
      { name: "list default", hash: "" },
      { name: "list override-at-default", hash: "", view: () => [size.w, size.h] },
      { name: "list 1280x900", hash: "", view: () => [1280, 900] },
      { name: "list 1280x900 again", hash: "", view: () => [1280, 900] },
      { name: "explore 1280x900", hash: "#/explore", view: () => [1280, 900] },
      { name: "list 390x844 mobile", hash: "", view: () => [390, 844] },
    ];
    for (const s of steps) {
      const page = await browser.newPage();
      if (s.view) {
        const [w, h] = s.view();
        await page.viewport(w, h, s.name.includes("mobile"));
      }
      const t1 = performance.now();
      await page.goto(v.url + s.hash, 60_000);
      const loadMs = Math.round(performance.now() - t1);
      await page.waitFor(s.hash ? EXPLORE : LIST, "viewer body", 40_000);
      const bodyMs = Math.round(performance.now() - t1);
      const seen = await page.eval("({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, fonts: [...new Set([...document.querySelectorAll('body, body *')].slice(0, 4000).map((e) => getComputedStyle(e).fontFamily.split(',')[0].trim()))].slice(0, 12), nav: (() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { resp: Math.round(n.responseEnd), interactive: Math.round(n.domInteractive), dcl: Math.round(n.domContentLoadedEventEnd), complete: Math.round(n.domComplete) } : null; })() })");
      if (!s.view) size = { w: seen.w, h: seen.h, dpr: seen.dpr };
      out.push(`${s.name}: load ${loadMs} ms body ${bodyMs} ms ${JSON.stringify(seen)}`);
      await page.close();
    }
  } finally {
    await v.close();
  }
  console.log(`warm-diag paired: ${out.join(" | ")}`);
}
