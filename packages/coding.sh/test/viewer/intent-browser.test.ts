// Intent preload in headless Chrome: resting the mouse on a session row loads
// the session, so opening it makes no request; a row that scrolls under a
// still mouse loads nothing.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, metricFixtures } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");
const DAY = 86_400_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("intent preload in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    const t0 = Math.floor(Date.now() / DAY) * DAY - 11 * DAY;
    for (const s of metricFixtures(t0)) await index.upsertSession(s);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
  });

  async function open(height: number): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, height);
    await page.goto(v.url + "#/");
    await page.waitFor("document.querySelectorAll('.session-table [data-sid]').length >= 10", "session rows");
    return page;
  }
  /** API requests the page has made, by path. */
  const apiCalls = async (p: Page): Promise<string[]> =>
    p.eval("performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname + new URL(e.name).search).filter((u) => u.startsWith('/api/'))");
  const center = async (p: Page, sel: string): Promise<{ x: number; y: number }> =>
    p.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);

  test("rest on a row, then open it: no request at the click", async () => {
    const p = await open(900);
    const sid: string = await p.eval("document.querySelectorAll('.session-table [data-sid]')[2].dataset.sid");
    const at = await center(p, `.session-table [data-sid="${sid}"]`);
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x - 40, y: at.y });
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await p.waitFor(`performance.getEntriesByType('resource').some((e) => e.name.includes('/api/sessions/${encodeURIComponent(sid)}/outline'))`, "preloaded");
    await pause(100);
    const before = (await apiCalls(p)).length;
    await p.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await p.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await p.waitFor(`location.hash === '#/s/${encodeURIComponent(sid)}' && !document.querySelector('.session-view [aria-busy=true]')`, "session open");
    await pause(300);
    const after = (await apiCalls(p)).slice(before);
    assert.deepEqual(after, [], "opening a preloaded session makes no request");
    assert.deepEqual(p.errors, []);
  });

  test("rows scrolling under a still mouse preload nothing", async () => {
    const p = await open(420);
    const at = await center(p, ".session-table [data-sid]");
    // Park the mouse over the first row and let it fire (a real rest), then scroll under it.
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y - 2 });
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await pause(250);
    const before = await apiCalls(p);
    await p.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: 200 });
    await pause(150);
    // What Chrome sends once a scroll settles: a move at the same spot, now over another row.
    await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    await pause(400);
    const under: string = await p.eval(`document.elementFromPoint(${at.x}, ${at.y})?.closest('[data-sid]')?.dataset.sid ?? ''`);
    assert.equal(await p.eval("window.scrollY > 0"), true, "the page scrolled");
    const added = (await apiCalls(p)).slice(before.length);
    assert.deepEqual(added, [], `no preload for the row now under the mouse (${under})`);
    assert.deepEqual(p.errors, []);
  });
});
