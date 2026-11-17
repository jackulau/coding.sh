// Viewer fixes seen in headless Chrome: a running session's header follows its tail, an unknown id is
// one request and a 404 state, a query that cannot parse is not sent, the Explore range names its
// year, the totals count subagents apart ("+ N subagents"), the repo column falls back to the working directory, and
// the page's DOM helper never writes "null".
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, event, metricFixtures, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");
const DAY = 86_400_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("viewer fixes in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;
  const LIVE = "live-session-1";

  before(async () => {
    const t0 = Math.floor(Date.now() / DAY) * DAY - 11 * DAY;
    for (const s of metricFixtures(t0)) await index.upsertSession(s);
    const now = Date.now();
    await index.upsertSession(session(LIVE, { startedAt: now - 60_000, endedAt: undefined, title: "Still running", model: "claude-opus-5-5", stats: { events: 2, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.1 } } }));
    await index.putEvents([event(LIVE, 1, { ts: now - 50_000 }), event(LIVE, 2, { ts: now - 40_000 })]);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
  });

  async function open(hash: string): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.goto(v.url + hash);
    return page;
  }
  const apiCalls = (p: Page): Promise<string[]> =>
    p.eval("performance.getEntriesByType('resource').map((e) => decodeURIComponent(new URL(e.name).pathname + new URL(e.name).search)).filter((u) => u.startsWith('/api/'))");

  test("a running session's header stats follow its tail", async () => {
    const p = await open("#/s/" + LIVE);
    await p.waitFor("document.querySelector('.detail-head [data-fact=tokens] dd')", "header");
    const before: string = await p.eval("document.querySelector('.detail-head').textContent");
    assert.match(before, /1 tool call(?!s)/);
    const now = Date.now();
    await index.upsertSession(session(LIVE, { startedAt: now - 60_000, endedAt: undefined, title: "Still running", model: "claude-opus-5-5", stats: { events: 3, turns: 1, toolCalls: 7, toolErrors: 0, filesChanged: 0, usage: { inputTokens: 90_000, outputTokens: 5_000, costUsd: 1.5 } } }));
    await index.putEvents([event(LIVE, 3, { ts: now - 1000 })]);
    await p.waitFor("/7 tool calls/.test(document.querySelector('.detail-head').textContent)", "the header's tool calls", 15_000);
    assert.match(await p.eval("document.querySelector('.detail-head [data-fact=cost] dd').textContent"), /\$1\.50/);
    assert.match(await p.eval("document.querySelector('.detail-head [data-fact=tokens] dd').textContent"), /90k in/);
    assert.deepEqual(p.errors, []);
  });

  test("an unknown session id is one request and a not-found state", async () => {
    const p = await open("#/s/no-such-session");
    await p.waitFor("document.querySelector('.panel.empty h2')?.textContent === 'Session not found'", "not found");
    await pause(300);
    assert.deepEqual((await apiCalls(p)).filter((u) => u.includes("no-such-session")), ["/api/sessions/no-such-session"]);
    assert.deepEqual(p.errors, []);
  });

  test("a query that cannot parse is not sent; Enter says why; a good one is sent", async () => {
    const p = await open("#/");
    await p.waitFor("document.querySelector('#q') && document.querySelector('.row')", "the list");
    const sent = async () => (await apiCalls(p)).filter((u) => u.includes("where=")).length;
    const base = await sent();
    const type = (text: string) => p.eval(`(() => { const i = document.querySelector('#q'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await type('tool:"Bash');
    await pause(900);
    assert.equal(await sent(), base, "typed, not sent");
    await p.eval("document.querySelector('#q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
    await p.waitFor("document.querySelector('.qbar-err')", "inline error");
    assert.match(await p.eval("document.querySelector('.qbar-err').textContent"), /unterminated quote/);
    assert.equal(await sent(), base, "Enter does not send it either");
    await type("agent:codex");
    await p.waitFor("document.querySelectorAll('.row').length === 3 && !document.querySelector('.qbar-err')", "the good query's rows");
    assert.ok((await sent()) > base);
    assert.deepEqual(p.errors, []);
  });

  test("Explore says why a query cannot parse without leaving the page or asking", async () => {
    const p = await open("#/explore");
    await p.waitFor("document.querySelector('.mx-body > *')", "explore body");
    const before = (await apiCalls(p)).length;
    await p.eval("(() => { const i = document.querySelector('.explore input[type=search]'); i.value = '(agent:codex'; i.form.requestSubmit(); })()");
    await p.waitFor("document.querySelector('.explore .qbar-err')", "inline error");
    assert.match(await p.eval("document.querySelector('.explore .qbar-err').textContent"), /missing '\)'/);
    assert.equal(await p.eval("location.hash"), "#/explore");
    assert.equal((await apiCalls(p)).length, before);
  });

  test("a year-long Explore range names its year", async () => {
    const p = await open("#/explore?since=365d");
    await p.waitFor("document.querySelector('.explore .page-head .meta')?.textContent.includes('session')", "range label");
    assert.match(await p.eval("document.querySelector('.explore .page-head .meta').textContent"), /^[A-Z][a-z]{2} \d+, \d{4} – [A-Z][a-z]{2} \d+, \d{4} · /);
  });

  test("the totals count subagents apart from the sessions; the repo column falls back to the working directory", async () => {
    const p = await open("#/");
    await p.waitFor("document.querySelectorAll('.row').length > 3", "rows");
    assert.match(await p.eval("document.querySelector('.fact-line').textContent"), /\+ \d+ subagents?/);
    assert.equal(await p.eval("document.querySelector('.row[data-sid=m05] .repo-cell').textContent"), "notes");
  });

  test("the DOM helper skips null, undefined and false instead of writing them as text", async () => {
    const p = await open("#/");
    await p.waitFor("document.querySelector('.row')", "the page");
    assert.equal(await p.eval("(() => { const d = document.createElement('div'); swap(d, null, 'a', undefined, false, [null, 'b']); return d.textContent; })()"), "ab");
  });

  test("the theme follows the system until a choice is stored, and the first paint needs no script", async () => {
    const scheme = (p: Page, value: string) => p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    const bg = "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()";
    const label = "document.querySelector('#theme').getAttribute('aria-label')";
    const LIGHT = "#f7f7f8", DARK = "#08080a";
    // No flash: with scripts off, the CSS alone paints the system's theme.
    for (const [value, want] of [["light", LIGHT], ["dark", DARK]] as const) {
      await page?.close();
      page = await browser.newPage();
      await page.send("Emulation.setScriptExecutionDisabled", { value: true });
      await scheme(page, value);
      await page.goto(v.url + "#/");
      assert.equal(await page.eval(bg), want, `${value} system, no script`);
    }
    // No stored choice: the page follows the system and reacts when the setting changes.
    await page?.close();
    page = await browser.newPage();
    const p = page;
    await p.viewport(1280, 900);
    await scheme(p, "dark");
    await p.goto(v.url + "#/");
    await p.waitFor("document.querySelector('.row')", "the page");
    assert.equal(await p.eval(bg), DARK);
    assert.equal(await p.eval("document.documentElement.hasAttribute('data-theme')"), false);
    assert.equal(await p.eval(label), "Switch to light theme");
    await scheme(p, "light");
    await p.waitFor(`${label} === 'Switch to dark theme'`, "the button's label follows the system");
    assert.equal(await p.eval(bg), LIGHT);
    // The system's light theme and a picked light theme set the same tokens.
    const tokens = `(() => { const r = [...document.styleSheets[0].cssRules].find((x) => x.selectorText === ':root[data-theme="light"]');
      const cs = getComputedStyle(document.documentElement); return [...r.style].map((n) => n + ": " + cs.getPropertyValue(n).trim()); })()`;
    const system: string[] = await p.eval(tokens);
    // The toggle stores the choice, and a stored choice wins over the system.
    await p.eval("document.querySelector('#theme').click()");
    assert.equal(await p.eval("localStorage.getItem('csh-theme')"), "dark");
    assert.equal(await p.eval("document.documentElement.getAttribute('data-theme')"), "dark");
    assert.equal(await p.eval(bg), DARK, "a picked dark theme on a light system");
    await p.eval("document.querySelector('#theme').click()");
    assert.equal(await p.eval("localStorage.getItem('csh-theme')"), "light");
    await scheme(p, "dark");
    assert.equal(await p.eval(bg), LIGHT, "a stored light choice wins over a dark system");
    assert.deepEqual(await p.eval(tokens), system, "a picked light theme matches the system's");
    await p.eval("document.querySelector('#theme').click()");
    await scheme(p, "light");
    await p.eval("window.beforeReload = true");
    await p.send("Page.reload");
    await p.waitFor("!window.beforeReload && document.readyState === 'complete' && document.querySelector('.row')", "the reload");
    assert.equal(await p.eval(bg), DARK, "a stored dark choice wins over a light system after a reload");
    assert.equal(await p.eval(label), "Switch to light theme");
    assert.deepEqual(p.errors, []);
  });
});
