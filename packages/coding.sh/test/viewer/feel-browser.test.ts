// How the viewer feels: no motion on keyboard actions, nothing that moves under the pointer,
// and no per-key work. Driven in headless Chrome against a real viewer server. Skipped when no Chrome is installed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, FakeIndex, longSession, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");
const T0 = Date.now() - 3_600_000;

describe("viewer feel in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new FakeIndex();
  let v: Viewer;
  let browser: Browser;
  let page: Page;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const key = (k: string) => page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);

  before(async () => {
    for (let i = 0; i < 60; i++) {
      await index.upsertSession(session(`S-${i}`, { title: `Session number ${i}`, startedAt: T0 - i * 60_000, endedAt: T0 - i * 60_000 + 30_000 }));
    }
    await index.upsertSession(session("long-1", { title: "Long session", startedAt: T0 - 9_000_000, stats: { events: 600, turns: 10, toolCalls: 200, toolErrors: 1, filesChanged: 0 } }));
    await index.putEvents(longSession(600, 10));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await browser?.close();
    await v?.close();
  });
  async function open(hash = "#/", w = 1280, h = 800) {
    page = await browser.newPage();
    await page.viewport(w, h);
    await page.goto(v.url);
    await page.waitFor("document.querySelector('[role=listbox]')", "sessions list");
    if (hash !== "#/") {
      await page.eval(`location.hash = ${JSON.stringify(hash)}`);
      await page.waitFor("document.querySelector('#steps .st')", "steps");
    }
  }

  test("keyboard selection has no transition on rows", async () => {
    await open();
    try {
      const t = await page.eval("[...document.querySelectorAll('.row')].map((r) => getComputedStyle(r).transitionDuration)");
      assert.ok(t.length > 10);
      assert.ok(t.every((d: string) => d === "0s"), `row transitions: ${[...new Set(t)]}`);
      await key("j");
      await key("j");
      assert.equal(await page.eval("document.querySelectorAll('.row[aria-selected=true]').length"), 1);
    } finally {
      await page.close();
    }
  });

  test("the query suggestions appear at once and do not replay an entrance per keystroke", async () => {
    await open();
    try {
      const type = (q: string) => page.eval(`(() => { const i = document.getElementById('q'); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
      await type("agent:");
      await page.waitFor("document.querySelector('.qbar-pop')", "suggestions");
      await page.eval("window.__runs = 0; document.addEventListener('transitionrun', (e) => { if (e.target.classList?.contains('qbar-pop')) window.__runs++; }, true)");
      await type("agent:c");
      await sleep(400);
      await type("agent:cl");
      await sleep(400);
      assert.equal(await page.eval("window.__runs"), 0);
      assert.equal(await page.eval("getComputedStyle(document.querySelector('.qbar-pop')).transitionDuration"), "0s");
    } finally {
      await page.close();
    }
  });

  test("pressing the new-events pill shrinks it in place", async () => {
    await open("#/s/long-1");
    try {
      await page.eval("(() => { const p = document.querySelector('.tl-tail'); p.hidden = false; p.querySelector('.txt').textContent = '3 new events'; })()");
      const center = () => page.eval("(() => { const r = document.querySelector('.tl-tail').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.left]; })()");
      const [cx, cy, left0] = await center();
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: left0 + 4, y: cy });
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: left0 + 4, y: cy, button: "left", clickCount: 1 });
      await sleep(300);
      const [px, py] = await center();
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: left0 + 4, y: cy, button: "left", clickCount: 1 });
      assert.ok(Math.abs(px - cx) < 1 && Math.abs(py - cy) < 1, `pill moved from ${cx},${cy} to ${px},${py}`);
    } finally {
      await page.close();
    }
  });

  test("the new-sessions pill does not move a row, and a re-render does not replay its entrance", async () => {
    await open();
    try {
      const rowTop = () => page.eval("document.querySelectorAll('.row')[3].getBoundingClientRect().top");
      const before = await rowTop();
      await index.upsertSession(session("NEW-1", { title: "brand new", startedAt: Date.now(), endedAt: Date.now() }));
      await page.waitFor("!document.querySelector('.live-pill').hidden", "the new-sessions pill", 9000);
      await sleep(300);
      assert.equal(await rowTop(), before);
      await page.eval("window.__runs = 0; document.addEventListener('transitionrun', (e) => { if (e.target.classList?.contains('live-pill')) window.__runs++; }, true)");
      await page.eval("document.querySelector('[data-filter] .chip').click()");
      await sleep(600);
      assert.equal(await page.eval("window.__runs"), 0);
    } finally {
      await page.close();
      index.sessions.delete("NEW-1");
    }
  });
});
