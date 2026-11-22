// The Work page's totals in headless Chrome: a heading counts the whole bucket when the page
// lists only part of it, and "Show all" lists the rest in place.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { mkSession } from "../cli/_cmd.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs } from "./fakes.ts";
import { workSessions } from "./_work.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

/** The count in the heading of the bucket an item is in: "1 of 4". */
const heading = (bucket: string) => `document.querySelector('.work-item[data-bucket=${bucket}]').closest('.work-group').querySelector('h2 .meta').textContent`;
const focusedItem = "(document.activeElement && document.activeElement.closest && document.activeElement.closest('.work-item') || {}).dataset?.item";

describe("Work page totals in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  const now = Date.now();
  let dir: string;
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "work-item-browser-"));
    // The shared queue (one item in each bucket) and three more changes to review: eight items, four of them in review.
    const more = [1, 2, 3].map((n) => mkSession(`review-${n}`, now - (30 + n) * 60e3, { cwd: "/work/demo", title: `review change ${n}`, stats: { filesChanged: 1 } }));
    for (const s of [...workSessions(now), ...more]) await index.upsertSession(s);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(dir, "work.json"), home: dir, cwd: dir } });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.goto(v.url + hash);
    await page.waitFor("document.querySelector('.work-body > *')", "work body");
    return page;
  }

  test("a heading counts the whole bucket, and Show all lists the rest in place", async () => {
    const p = await open("#/work?limit=5");
    assert.equal(await p.eval("document.querySelectorAll('.work-item').length"), 5);
    assert.equal(await p.eval(heading("review")), "1 of 4");
    assert.equal(await p.eval(heading("blocked")), "1");
    assert.match(await p.eval("document.querySelector('.work-more').textContent"), /3 more items than this page shows\..*coding\.sh work --limit 8/);
    const all = "document.querySelector('.work-more [data-act=all]')";
    assert.equal(await p.eval(`${all}.textContent`), "Show all 8");
    await p.eval(`${all}.click()`);
    await p.waitFor("location.hash === '#/work?limit=8' && document.querySelectorAll('.work-item').length === 8", "all eight listed");
    assert.equal(await p.eval(heading("review")), "4");
    assert.equal(await p.eval("!!document.querySelector('.work-more')"), false);
    // Focus goes to the first card that was not on the page: the second item in review.
    const reviews: string[] = await p.eval("[...document.querySelectorAll('.work-item[data-bucket=review]')].map((e) => e.dataset.item)");
    assert.equal(await p.eval(focusedItem), reviews[1]);
    assert.deepEqual(p.errors, []);
  });
});
