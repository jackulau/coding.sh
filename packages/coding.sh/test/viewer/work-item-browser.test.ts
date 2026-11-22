// The Work page's totals and a work item's own page (#/w/<id>) in headless Chrome: a heading
// counts the whole bucket when the page lists only part of it, "Show all" lists the rest in
// place, each card links to its item's page, which shows the reason and the member sessions,
// back returns to the list where it was, and an unknown id says so with a way back.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { workItemId } from "../../src/core/work.ts";
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

describe("Work totals and item pages in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
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

  async function open(hash: string, mobile = false): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    if (mobile) await page.viewport(390, 844, true);
    else await page.viewport(1280, 900);
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

  test("a card links to its item's page, which shows the reason, the next step and the member sessions", async () => {
    const p = await open("#/work");
    const id = workItemId("blocked");
    const link = "document.querySelector('.work-item[data-bucket=blocked] .work-id')";
    assert.equal(await p.eval(`${link}.getAttribute('href')`), `#/w/${id}`);
    assert.equal(await p.eval(`${link}.textContent`), id);
    await p.eval(`${link}.click()`);
    await p.waitFor("document.querySelector('.work-page .work-members')", "the item's page");
    assert.equal(await p.eval("location.hash"), `#/w/${id}`);
    assert.equal(await p.eval("document.querySelector('[data-nav=work]').getAttribute('aria-current')"), "page");
    assert.equal(await p.eval("document.querySelector('.work-page h1').textContent"), "publish the package");
    assert.match(await p.eval("document.querySelector('.work-page .meta').textContent"), new RegExp(`^${id} · Blocked on you · since 7d`));
    assert.match(await p.eval("document.querySelector('.work-page .work-reason').textContent"), /permission/i);
    assert.match(await p.eval("document.querySelector('.work-page .work-next').textContent"), /^Next \S/);
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.work-members a')].map((a) => a.getAttribute('href'))"), ["#/s/blocked", "#/s/blocked%3Asub%3Aa1"]);
    const facts: string = await p.eval("document.querySelector('.work-kv').textContent");
    assert.match(facts, /\$1\.25/);
    assert.match(facts, /Waitingpermission since/);
    // Ack and snooze, as the list offers them, and the item's session.
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.work-page .work-actions [data-act]')].map((b) => b.dataset.act)"), ["ack", "snooze"]);
    assert.equal(await p.eval("[...document.querySelectorAll('.work-page .work-actions a')].find((a) => a.textContent === 'Open session').getAttribute('href')"), "#/s/blocked");
    // o opens the item's session, as the palette's entry does.
    await p.press("o");
    await p.waitFor("location.hash === '#/s/blocked'", "the item's session");
    assert.deepEqual(p.errors, []);
  });

  test("back returns to the list where it was, with the item in focus", async () => {
    const p = await open("#/work?limit=5");
    for (let n = 0; n < 5; n++) await p.press("j");
    const id: string = await p.eval(focusedItem);
    assert.equal(await p.eval(`document.querySelector('.work-item[data-item="${id}"]').dataset.bucket`), "review");
    // i opens the item in focus; its back link names the list it came from.
    await p.press("i");
    await p.waitFor(`location.hash === '#/w/${id}' && document.querySelector('.work-page .work-reason')`, "the item's page");
    assert.equal(await p.eval("document.querySelector('.work-page .back').getAttribute('href')"), "#/work?limit=5");
    await p.eval("history.back()");
    await p.waitFor(`location.hash === '#/work?limit=5' && ${focusedItem} === '${id}'`, "the list, with the item in focus");
    assert.equal(await p.eval(heading("review")), "1 of 4");
    // Esc on the item's page goes back too.
    await p.press("i");
    await p.waitFor(`location.hash === '#/w/${id}' && document.querySelector('.work-page .work-reason')`, "the item's page again");
    await p.press("Escape");
    await p.waitFor(`location.hash === '#/work?limit=5' && ${focusedItem} === '${id}'`, "the list after Esc");
    assert.deepEqual(p.errors, []);
  });

  test("on a phone, back returns to where the list was scrolled", async () => {
    const p = await open("#/work", true);
    await p.eval("window.scrollTo(0, document.documentElement.scrollHeight)");
    const y: number = await p.eval("window.scrollY");
    assert.ok(y > 200, `the list scrolls (${y}px)`);
    const last: string = await p.eval("[...document.querySelectorAll('.work-item')].pop().querySelector('.work-id').getAttribute('href')");
    await p.eval("[...document.querySelectorAll('.work-item')].pop().querySelector('.work-id').click()");
    await p.waitFor(`location.hash === ${JSON.stringify(last)} && document.querySelector('.work-page .work-reason')`, "the item's page");
    assert.equal(await p.eval("document.documentElement.scrollWidth <= innerWidth"), true, "the item's page has no sideways scroll");
    await p.eval("history.back()");
    await p.waitFor("location.hash === '#/work' && document.querySelector('.work-item')", "the list");
    await p.waitFor(`Math.abs(window.scrollY - ${y}) <= 2`, "the list where it was scrolled");
    assert.deepEqual(p.errors, []);
  });

  test("an unknown id says so, with a link back to Work; a malformed one says it does not parse", async () => {
    const p = await open("#/w/w000000");
    assert.equal(await p.eval("document.querySelector('.work-missing h2').textContent"), "No such work item");
    assert.match(await p.eval("document.querySelector('.work-missing p').textContent"), /no work item w000000 since 7d/);
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.work-missing a.btn')].map((a) => [a.textContent, a.getAttribute('href')])"), [["Back to Work", "#/work"], ["Look back 30 days", "#/w/w000000?since=30d"]]);
    assert.equal(await p.eval("document.documentElement.scrollWidth <= innerWidth"), true);
    await p.eval("document.querySelector('.work-missing a.btn').click()");
    await p.waitFor("location.hash === '#/work' && document.querySelector('.work-item')", "back on Work");
    assert.deepEqual(p.errors, []);
    const q = await open("#/w/not-an-id", true);
    assert.equal(await q.eval("document.querySelector('.work-missing h2').textContent"), "That link does not parse");
    assert.equal(await q.eval("document.querySelectorAll('.work-missing a.btn').length"), 1);
    assert.equal(await q.eval("document.documentElement.scrollWidth <= innerWidth"), true);
    assert.deepEqual(q.errors, []);
  });

  test("Ack on the item's page acknowledges it, and the list loads again on the way back", async () => {
    const p = await open("#/work");
    const id = workItemId("turn");
    await p.eval(`document.querySelector('.work-item[data-item="${id}"] .work-id').click()`);
    await p.waitFor("document.querySelector('.work-page [data-act=ack]')", "the item's page");
    await p.eval("document.querySelector('.work-page [data-act=ack]').click()");
    await p.waitFor("/hidden \\(acknowledged\\)/.test(document.querySelector('.work-page .meta').textContent)", "the item acknowledged");
    assert.equal(await p.eval("!!document.querySelector('.work-page [data-act=ack]')"), false, "an acknowledged item has nothing left to ack");
    await p.eval("history.back()");
    await p.waitFor(`location.hash === '#/work' && document.querySelector('.work-item') && !document.querySelector('.work-item[data-item="${id}"]')`, "the list without the item");
    assert.match(await p.eval("document.querySelector('.work-notes').textContent"), /1 acknowledged/);
    assert.deepEqual(p.errors, []);
  });
});
