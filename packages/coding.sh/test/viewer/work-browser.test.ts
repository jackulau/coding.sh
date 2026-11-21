// The Work page (#/work) in headless Chrome: the buckets in the CLI's order with links to
// the sessions, the hidden toggle and filters in the hash, j/k between items, an ack that
// takes the item off the page, the empty state, the phone layout, and no console errors.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs } from "./fakes.ts";
import { workSessions } from "./_work.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const groups = "[...document.querySelectorAll('.work-group h2')].map((e) => e.firstChild.textContent)";

describe("Work page in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let dir: string;
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "work-browser-"));
    for (const s of workSessions(Date.now())) await index.upsertSession(s);
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

  test("lists the buckets in the CLI's order, each item linking to its sessions", async () => {
    const p = await open("#/work");
    assert.equal(await p.eval("document.querySelector('[data-nav=work]').getAttribute('aria-current')"), "page");
    assert.deepEqual(await p.eval(groups), ["Blocked on you", "Failed", "Stalled", "Your turn", "Ready for review"]);
    const blocked = "document.querySelector('.work-item[data-bucket=blocked]')";
    assert.equal(await p.eval(`${blocked}.querySelector('.work-title').getAttribute('href')`), "#/s/blocked");
    assert.match(await p.eval(`${blocked}.querySelector('.work-reason').textContent`), /\S/);
    const facts: string = await p.eval(`${blocked}.querySelector('.work-facts').textContent`);
    assert.match(facts, /\$1\.25/);
    assert.match(facts, /2 sessions/);
    assert.match(await p.eval(`${blocked}.querySelector('.work-next').textContent`), /^Next \S/);
    assert.deepEqual(await p.eval(`[...${blocked}.querySelectorAll('.work-sessions a')].map((a) => a.getAttribute('href'))`), ["#/s/blocked%3Asub%3Aa1"]);
    // The done session is hidden, and the page says so and why.
    assert.match(await p.eval("document.querySelector('.work-notes').textContent"), /1 hidden item: 1 done/);
    assert.equal(await p.eval("[...document.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.startsWith('Show hidden')).textContent"), "Show hidden (1)");
    assert.deepEqual(p.errors, []);
  });

  test("the hidden toggle and the filters live in the hash", async () => {
    const p = await open("#/work");
    await p.eval("[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Show hidden')).click()");
    await p.waitFor(`location.hash === '#/work?all=1' && ${groups}.includes('Hidden')`, "hidden shown");
    assert.equal(await p.eval("document.querySelector('.work-item[data-bucket=hidden] .badge').textContent"), "done");
    await p.eval("(() => { const f = document.querySelector('.work-filters'); f.agent.value = 'codex'; f.requestSubmit(); })()");
    await p.waitFor(`location.hash === '#/work?agent=codex&all=1' && ${groups}.join() === 'Failed'`, "filtered to codex");
    await p.eval("[...document.querySelectorAll('.seg button')].find((b) => b.textContent === '30d').click()");
    await p.waitFor("location.hash === '#/work?agent=codex&since=30d&all=1'", "since in the hash");
    // A reload of that hash keeps the filters.
    const q = await open("#/work?repo=api");
    assert.deepEqual(await q.eval(groups), ["Failed", "Stalled"]);
    assert.equal(await q.eval("document.querySelector('.work-filters').repo.value"), "api");
    assert.deepEqual(q.errors, []);
  });

  test("an empty queue names the next step", async () => {
    const p = await open("#/work?agent=nobody");
    assert.equal(await p.eval("document.querySelector('.work-body h2').textContent"), "No work items match these filters");
    await p.eval("[...document.querySelectorAll('.work-body button')].find((b) => b.textContent === 'Clear the filters').click()");
    await p.waitFor("location.hash === '#/work' && document.querySelector('.work-item')", "filters cleared");
    assert.deepEqual(p.errors, []);
  });

  test("fits a phone with no sideways scroll, and the six tabs keep their whole names", async () => {
    const p = await open("#/work", true);
    assert.equal(await p.eval("document.documentElement.scrollWidth <= innerWidth"), true);
    // A sixth tab (Work) cut every name to an ellipsis ("W…") at 390px until the phone tabs tightened.
    const cut = await p.eval("[...document.querySelectorAll('.nav a > span')].filter((s) => s.scrollWidth > s.clientWidth).map((s) => s.textContent)");
    assert.deepEqual(cut, [], "no tab name ends in an ellipsis");
    assert.deepEqual(p.errors, []);
  });

  test("j and k move between items, and Ack takes an item off the page", async () => {
    const p = await open("#/work");
    await p.press("j");
    assert.equal(await p.eval("document.activeElement.closest('.work-item').dataset.bucket"), "blocked");
    await p.press("j");
    assert.equal(await p.eval("document.activeElement.closest('.work-item').dataset.bucket"), "failed");
    await p.press("k");
    assert.equal(await p.eval("document.activeElement.closest('.work-item').dataset.bucket"), "blocked");
    await p.eval("document.querySelector('.work-item[data-bucket=blocked] [data-act=ack]').click()");
    await p.waitFor("!document.querySelector('.work-item[data-bucket=blocked]')", "blocked item acknowledged");
    assert.match(await p.eval("document.querySelector('.work-notes').textContent"), /1 acknowledged/);
    assert.deepEqual(p.errors, []);
  });
});
