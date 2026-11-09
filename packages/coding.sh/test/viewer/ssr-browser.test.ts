// The server-drawn first paint (src/viewer/ssr.ts): the first sessions page is
// in the HTML, readable with JavaScript off; the script uses the embedded
// responses instead of asking again, and the first row opens without a request.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { BOOT_LIST_PATHS, renderSessionsMain, scriptJson, sessionBootPaths } from "../../src/viewer/ssr.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, metricFixtures } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");
const DAY = 86_400_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("rendered rows escape what they show; embedded JSON cannot close its script", () => {
  const s = metricFixtures(Date.UTC(2026, 9, 7))[0]!;
  const html = renderSessionsMain([{ ...s, id: 'x"><img src=x>', title: "<script>alert(1)</script>" }], 1);
  assert.ok(!html.includes("<script>") && !html.includes("<img"), html);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(scriptJson({ a: "</script><b>" }), '{"a":"\\u003c/script>\\u003cb>"}');
  assert.deepEqual(sessionBootPaths("team/a b"), ["/api/sessions/team%2Fa%20b", "/api/sessions/team%2Fa%20b/events?limit=5000", "/api/labels?sessionId=team%2Fa+b", "/api/sessions?parent=team%2Fa+b&limit=500", "/api/sessions/team%2Fa%20b/outline"]);
});

describe("server-drawn first paint", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  let plain: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    const t0 = Math.floor(Date.now() / DAY) * DAY - 11 * DAY;
    for (const s of metricFixtures(t0)) await index.upsertSession(s);
    const base = { index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any };
    v = await startViewer(base);
    plain = await startViewer({ ...base, serverRender: false });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    await plain?.close();
  });
  const apiCalls = async (p: Page): Promise<string[]> =>
    p.eval("performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname + new URL(e.name).search).filter((u) => u.startsWith('/api/'))");

  test("with JavaScript off, the first row is on the page", async () => {
    page = await browser.newPage();
    await page.send("Emulation.setScriptExecutionDisabled", { value: true });
    await page.viewport(1280, 900);
    await page.goto(v.url + "#/");
    const first = (await index.listSessions({ parentSessionId: null, limit: 1 }))[0]!;
    assert.equal(await page.eval("document.querySelector('main .row .row-title')?.textContent"), first.title);
    assert.equal(await page.eval("document.querySelector('main .row').getBoundingClientRect().height > 0"), true);
    await page.close();
    page = undefined;
  });

  test("the script uses the embedded responses, and the first row opens without a request", async () => {
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.goto(v.url + "#/");
    await page.waitFor("document.querySelectorAll('.session-table [role=option]').length >= 10", "client rows");
    await pause(200);
    const boot = await apiCalls(page);
    for (const p of BOOT_LIST_PATHS) assert.ok(!boot.includes(p), `${p} was fetched again`);
    assert.equal(await page.eval("document.getElementById('boot-data')"), null, "the embed is read once and removed");
    const sid: string = await page.eval("document.querySelector('.session-table [data-sid]').dataset.sid");
    await page.eval("document.querySelector('.session-table [data-sid]').click()");
    await page.waitFor(`location.hash === '#/s/${encodeURIComponent(sid)}' && !document.querySelector('.session-view [aria-busy=true]')`, "session open");
    await pause(200);
    const opened = (await apiCalls(page)).slice(boot.length);
    for (const p of sessionBootPaths(sid)) assert.ok(!opened.includes(p), `${p} was fetched again`);
    assert.deepEqual(page.errors, []);
  });

  test("serverRender: false serves the bare page", async () => {
    const html = async (w: Viewer) => (await fetch(`http://127.0.0.1:${w.port}/`, { headers: { authorization: `Bearer ${w.token}` } })).text();
    const bare = await html(plain);
    assert.match(bare, /<main id="main" tabindex="-1"><\/main>/);
    assert.ok(!bare.includes(`id="boot-data"`));
    const drawn = await html(v);
    assert.match(drawn, /<main id="main" tabindex="-1"><section class="wrap view ssr-sessions"/);
    assert.ok(drawn.includes('<script type="application/json" id="boot-data" nonce="'));
  });
});
