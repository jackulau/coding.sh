// THROWAWAY (not for merge): times the page script's first Intl use on a cold runner.
//   CSH_EXP=data     today's warm-up (first start, then a start and a data: page), then the viewer page
//   CSH_EXP=intl     the same, and the data: page calls new Intl.NumberFormat() before the viewer page
//   CSH_EXP=icuread  the same as data, and Node reads Chrome's icudtl.dat before the viewer page
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { findChrome, launchBrowser } from "../test/viewer/browser.ts";
import { firstStart } from "./warm-chrome.ts";
import { MemoryIndexStore } from "../src/store/memory.ts";
import { startViewer } from "../src/viewer/server.ts";
import { FakeBlobs, metricFixtures } from "../test/viewer/fakes.ts";

const arm = process.env.CSH_EXP ?? "data";
const chrome = findChrome()!;
const out: Record<string, unknown> = { arm };
const PAGE = "data:text/html,<title>cold</title><p>warm</p><script>document.title='warm'</script>";
const TIME = (expr: string) => `(() => { const t = performance.now(); ${expr}; return Math.round((performance.now() - t) * 10) / 10; })()`;
// Wraps the constructor so the page's own first new Intl.NumberFormat() is timed where it runs.
const WRAP = `(() => { const O = Intl.NumberFormat; let first = true; const W = function (...a) { const t = performance.now(); const r = new O(...a); if (first) { first = false; window.__nfMs = Math.round((performance.now() - t) * 10) / 10; window.__nfAt = Math.round(t); } return r; }; W.prototype = O.prototype; W.supportedLocalesOf = O.supportedLocalesOf; Intl.NumberFormat = W; })()`;

const first = await firstStart(chrome);
out.firstStartMs = Math.round(first.ms);

if (arm === "icuread") {
  const found: string[] = [];
  const walk = (d: string, depth: number) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === "icudtl.dat") found.push(p); else if (depth < 2) try { if (statSync(p).isDirectory()) walk(p, depth + 1); } catch {} } };
  walk(dirname(chrome), 0);
  const t = performance.now();
  let bytes = 0;
  for (const f of found) bytes += readFileSync(f).length;
  out.icuFiles = found.length;
  out.icuBytes = bytes;
  out.icuReadMs = Math.round(performance.now() - t);
}

{
  const t0 = performance.now();
  const browser = await launchBrowser(chrome);
  try {
    out.aStartMs = Math.round(performance.now() - t0);
    const page = await browser.newPage();
    const t1 = performance.now();
    await page.goto(PAGE);
    out.aPageMs = Math.round(performance.now() - t1);
    if (arm === "intl") {
      out.aIntl1 = await page.eval(TIME("new Intl.NumberFormat()"));
      out.aIntl2 = await page.eval(TIME("new Intl.NumberFormat()"));
      out.aDate = await page.eval(TIME("new Date().toLocaleString(undefined, { month: 'short', day: 'numeric' })"));
    }
    await page.close();
  } finally {
    await browser.close();
  }
}

const index = new MemoryIndexStore();
const DAY = 86_400_000;
for (const s of metricFixtures(Math.floor(Date.now() / DAY) * DAY - 11 * DAY)) await index.upsertSession(s);
const v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
try {
  for (const b of ["b", "c"]) {
    const t0 = performance.now();
    const browser = await launchBrowser(chrome);
    try {
      out[b + "StartMs"] = Math.round(performance.now() - t0);
      for (const i of [1, 2]) {
        const page = await browser.newPage();
        await page.viewport(1280, 900);
        await page.send("Page.addScriptToEvaluateOnNewDocument", { source: WRAP });
        const t1 = performance.now();
        await page.send("Page.navigate", { url: v.url });
        await page.waitFor("document.readyState === 'complete' && location.href !== 'about:blank'", "page load", 60_000);
        out[`${b}${i}LoadMs`] = Math.round(performance.now() - t1);
        out[`${b}${i}NfMs`] = await page.eval("window.__nfMs ?? null");
        out[`${b}${i}NfAt`] = await page.eval("window.__nfAt ?? null");
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await v.close();
}
console.log("exp-intl " + JSON.stringify(out));
