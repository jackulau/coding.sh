// The Explore (metrics) page in headless Chrome: six panels with lines, a
// breakdown table that links to the sessions, empty panels for an empty range,
// a bad filter shown inline, the phone layout, and no console errors.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, metricFixtures } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");
const DAY = 86_400_000;

describe("Explore page in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    // Ten days ending yesterday, so the default 30-day range holds them all.
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

  async function open(hash: string, mobile = false): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    if (mobile) await page.viewport(390, 844, true);
    else await page.viewport(1280, 900);
    await page.goto(v.url + hash);
    await page.waitFor("document.querySelector('.mx-body > *')", "explore body");
    return page;
  }

  test("six panels, a line per agent, totals and a table that links to the sessions", async () => {
    const p = await open("#/explore");
    assert.equal(await p.eval("document.querySelector('[data-nav=explore]').getAttribute('aria-current')"), "page");
    const panels: string[] = await p.eval("[...document.querySelectorAll('.mx-panel')].map((f) => f.dataset.panel)");
    assert.deepEqual(panels, ["sessions", "failure-rate", "cost", "tokens", "tool-error-rate", "llm-p95"]);
    // Top-level only: 10 of the 12 fixtures.
    assert.equal(await p.eval("document.querySelector('[data-panel=sessions] .mx-total').textContent"), "10");
    // One line per agent in each panel: claude-code, codex, cursor.
    assert.equal(await p.eval("document.querySelectorAll('[data-panel=sessions] path.ln').length"), 3);
    const rows: string[] = await p.eval("[...document.querySelectorAll('.mx-table tbody th')].map((t) => t.textContent)");
    assert.deepEqual(rows, ["claude-code", "codex", "cursor", "total"]);
    const href: string = await p.eval("document.querySelector('.mx-table tbody a').getAttribute('href')");
    assert.match(href, /^#\/\?where=agent%3Aclaude-code&since=\d+&until=\d+$/);
    // Tooltip on hover over the plot.
    await p.eval("(() => { const a = document.querySelector('[data-panel=sessions] .ch-plot'); const r = a.getBoundingClientRect(); a.dispatchEvent(new PointerEvent('pointermove', { clientX: r.right - 2, clientY: r.top + 10, bubbles: true })); })()");
    assert.equal(await p.eval("document.querySelector('[data-panel=sessions] .ch-tip').hidden"), false);
    assert.deepEqual(p.errors, []);
  });

  test("controls write the hash: split by model, per week, a filter", async () => {
    const p = await open("#/explore");
    await p.eval("(() => { const s = document.querySelector('.mx-by select'); s.value = 'model'; s.dispatchEvent(new Event('change')); })()");
    await p.waitFor("location.hash === '#/explore?by=model' && document.querySelector('.mx-table thead th')?.textContent === 'Model'", "split by model");
    await p.eval("[...document.querySelectorAll('.seg[aria-label=Bucket] button')].find((b) => b.textContent === 'Week').click()");
    await p.waitFor("location.hash === '#/explore?per=week&by=model' && document.querySelector('.seg[aria-label=Bucket] [aria-pressed=true]')?.textContent === 'Week'", "per week");
    await p.eval("(() => { const i = document.querySelector('.explore input[type=search]'); i.value = 'agent:codex'; i.form.requestSubmit(); })()");
    await p.waitFor("document.querySelector('[data-panel=sessions] .mx-total')?.textContent === '3'", "filtered to codex");
    assert.match(await p.eval("location.hash"), /where=agent%3Acodex/);
    await p.eval("[...document.querySelectorAll('.seg[aria-label=Sessions] button')].find((b) => b.textContent === 'With subagents').click()");
    await p.eval("document.querySelector('.explore input[type=search]').value = ''");
    await p.waitFor("/scope=all/.test(location.hash) && document.querySelector('.seg[aria-label=Sessions] [aria-pressed=true]')?.textContent === 'With subagents'", "with subagents");
    await p.eval("location.hash = '#/explore?scope=all'");
    await p.waitFor("document.querySelector('[data-panel=sessions] .mx-total')?.textContent === '12'", "subagents counted");
    assert.deepEqual(p.errors, []);
  });

  test("an empty range renders empty panels and says so; a bad filter is shown, not thrown", async () => {
    const p = await open("#/explore?where=agent%3Anobody");
    assert.equal(await p.eval("document.querySelectorAll('.mx-panel').length"), 6);
    assert.equal(await p.eval("document.querySelectorAll('.mx-panel path.ln').length"), 0);
    assert.match(await p.eval("document.querySelector('.mx-empty').textContent"), /No sessions match this filter/);
    assert.equal(await p.eval("document.querySelector('[data-panel=cost] .mx-total').textContent"), "—");
    const bad = await open("#/explore?where=cost%3E%3E1");
    assert.match(await bad.eval("document.querySelector('.mx-body [role=alert]').textContent"), /does not parse/);
    assert.deepEqual(bad.errors, []);
  });

  test("phone width: panels stack and the page does not scroll sideways", async () => {
    const p = await open("#/explore?by=model", true);
    assert.equal(await p.eval("document.documentElement.scrollWidth <= window.innerWidth"), true);
    const lefts: number[] = await p.eval("[...document.querySelectorAll('.mx-panel')].map((f) => Math.round(f.getBoundingClientRect().left))");
    assert.equal(new Set(lefts).size, 1, `one column, got ${lefts}`);
    assert.deepEqual(p.errors, []);
  });

  test("light theme renders with its own tokens", async () => {
    const p = await open("#/explore");
    await p.eval("document.documentElement.setAttribute('data-theme', 'light')");
    const bg: string = await p.eval("getComputedStyle(document.querySelector('.mx-panel')).backgroundColor");
    assert.notEqual(bg, "rgba(0, 0, 0, 0)");
    assert.deepEqual(p.errors, []);
  });
});
