// Viewer fixes from hands-on QA (round 7, second pass) in headless Chrome: on a phone the Run tree
// shows every subagent's name and stays inside the screen; the top tabs never end a name in an
// ellipsis and Review stays a tab at every width; the session list's activity cell holds
// "5,050 tools · 45 failed"; an unknown session id costs no 404 in the console; a skip refused
// because the item was scored elsewhere moves on in plain words; and on a phone every Review
// control is a 44px target.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { addScoreConfig } from "../../src/scores/scores.ts";
import { createQueue } from "../../src/scores/review.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const ROOT = "qa7v-root";
const BUSY = "qa7v-busy";
const LONG = "Research the review page layout and write a short report on every control it has";

describe("round 7 viewer QA fixes in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    const index = new MemoryIndexStore();
    const t0 = Date.UTC(2026, 9, 7, 9);
    const usage = { inputTokens: 120_000, outputTokens: 9_000, costUsd: 1.2345 };
    await index.upsertSession(session(ROOT, { startedAt: t0, endedAt: t0 + 3_600_000, title: "Run the review audit", model: "claude-opus-4-1", stats: { events: 40, turns: 3, toolCalls: 30, toolErrors: 0, filesChanged: 2, usage } }));
    for (let i = 1; i <= 6; i++) {
      await index.upsertSession(session(`qa7v-sub-${i}`, {
        startedAt: t0 + i * 1000, endedAt: t0 + i * 1000 + 754_000, title: `${LONG} (${i})`, model: "claude-sonnet-4-5-20250929",
        parent: { sessionId: ROOT, type: "general-purpose" } as any,
        stats: { events: 20, turns: 1, toolCalls: 1234, toolErrors: 3, filesChanged: 0, usage }, flags: ["tool-errors"],
      }));
    }
    await index.upsertSession(session(BUSY, { startedAt: t0 - 60_000, endedAt: t0, title: "Agentic Task Tracking for the queue", agent: "t3code", stats: { events: 9000, turns: 40, toolCalls: 5050, toolErrors: 45, filesChanged: 12 } }));
    await index.upsertSession(session("qa7v-other", { startedAt: t0 - 120_000, endedAt: t0 - 60_000, title: "Add a test for the parser" }));
    await addScoreConfig(index, { name: "tone", dataType: "categorical", categories: ["good", "okay", "bad"] }, t0);
    await createQueue(index, { name: "q-cat", where: "agent:claude-code", config: "tone", now: t0 });
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
  });

  /** An API call as the CLI would make it, with the viewer token. */
  const api = (path: string, init: RequestInit = {}) => fetch(new URL(path, v.url), { ...init, headers: { Authorization: "Bearer " + v.token, "Content-Type": "application/json" } });
  async function open(hash: string, wait: string, w = 1280, h = 900, mobile = false): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(w, h, mobile);
    await page.goto(v.url + hash);
    await page.waitFor(wait, "the page");
    return page;
  }

  test("on a phone the Run tree shows every subagent name and the page does not scroll sideways", async () => {
    const p = await open("#/s/" + ROOT, "document.querySelector('.detail-head details.run-tree > summary')", 390, 844, true);
    await p.eval("document.querySelector('.detail-head details.run-tree > summary').click()");
    await p.waitFor("document.querySelectorAll('.rt-node .rt-name').length === 7", "the run tree rows");
    const m = await p.eval("({ sw: document.documentElement.scrollWidth, vw: innerWidth, names: [...document.querySelectorAll('.rt-node .rt-name')].map((a) => Math.round(a.getBoundingClientRect().width)), out: [...document.querySelectorAll('.rt-node')].filter((r) => r.getBoundingClientRect().right > innerWidth).length })");
    assert.ok(m.sw <= m.vw, `the page is ${m.sw}px wide on a ${m.vw}px screen`);
    assert.equal(m.out, 0, "every row ends inside the screen");
    for (const w of m.names) assert.ok(w >= 100, `a subagent name is ${w}px wide: ${m.names.join(", ")}`);
    assert.deepEqual(p.errors, []);
  });

  test("the top tabs end no name in an ellipsis, and Review is a tab at every width", async () => {
    const p = await open("#/review", "document.querySelector('.topbar')");
    for (const [w, mobile] of [[390, true], [700, false], [880, false], [900, false], [940, false], [988, false], [1000, false], [1010, false], [1280, false]] as const) {
      await p.viewport(w, 800, mobile);
      const m = await p.eval(`({
        sw: document.documentElement.scrollWidth,
        review: getComputedStyle(document.querySelector('[data-nav=review]')).display,
        cut: [...document.querySelectorAll('.nav a > span')].filter((s) => s.getClientRects().length && s.scrollWidth > s.clientWidth).map((s) => s.textContent),
        long: [...document.querySelectorAll('.nav .nav-long')].filter((s) => s.getClientRects().length).length,
        short: [...document.querySelectorAll('.nav .nav-short')].filter((s) => s.getClientRects().length).length,
      })`);
      assert.ok(m.sw <= w, `at ${w}px the page is ${m.sw}px wide`);
      assert.notEqual(m.review, "none", `at ${w}px the Review tab shows`);
      assert.deepEqual(m.cut, [], `at ${w}px no tab name is cut`);
      assert.equal(m.long + m.short, 3, `at ${w}px each of the three long tabs shows one name, full or short`);
    }
    // On a phone the row of tabs scrolls sideways, and the current tab is scrolled into it.
    await p.viewport(390, 844, true);
    await p.eval("location.hash = '#/workflows'");
    await p.waitFor("document.querySelector('[data-nav=workflows][aria-current=page]')", "the Workflows tab current");
    const inView = await p.waitFor("(() => { const n = document.querySelector('.nav').getBoundingClientRect(), r = document.querySelector('[data-nav=workflows]').getBoundingClientRect(); return r.left >= n.left - 1 && r.right <= n.right + 1; })()", "the Workflows tab in view");
    assert.equal(inView, true);
    assert.deepEqual(p.errors, []);
  });

  for (const [w, h] of [[1600, 900], [1280, 800]] as const) {
    test(`at ${w}px the activity cell holds "5,050 tools · 45 failed" uncut`, async () => {
      const p = await open("#/?where=agent%3At3code", `document.querySelector('.row[data-sid="${BUSY}"] .act-cell')`, w, h);
      const m = await p.eval(`(() => { const c = document.querySelector('.row[data-sid="${BUSY}"] .act-cell'); return { text: c.textContent, cut: [c, ...c.querySelectorAll('*')].filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth).length, err: c.querySelector('.err').innerText }; })()`);
      assert.equal(m.text, "5,050 tools · 45 failed");
      assert.equal(m.cut, 0, "nothing in the activity cell is cut");
      assert.equal(m.err, "45 failed");
      assert.deepEqual(p.errors, []);
    });
  }

  test("an unknown session id shows Session not found with no 404 in the console", async () => {
    const r = await api("/api/sessions/not-a-real-session?missing=null");
    assert.equal(r.status, 200);
    assert.equal(await r.json(), null);
    assert.equal((await api("/api/sessions/not-a-real-session")).status, 404, "without ?missing=null it stays a 404");
    const p = await open("#/s/not-a-real-session", "document.querySelector('.panel.empty h2')?.textContent === 'Session not found'");
    const failed = await p.eval("performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400).map((e) => e.name + ' ' + e.responseStatus)");
    assert.deepEqual(failed, []);
    assert.deepEqual(p.errors, []);
  });

  test("a skip refused because the item was scored elsewhere moves on in plain words, and Enter sends nothing again", async () => {
    const p = await open("#/review/q-cat", "document.querySelector('.review-item')?.dataset.item === '1'");
    await p.eval("window.__posts = 0; const f = window.fetch; window.fetch = (u, i) => { if (i && i.method === 'POST') window.__posts++; return f(u, i); }");
    const scored = await api("/api/review/q-cat/1", { method: "POST", body: JSON.stringify({ value: "good", comment: "cli says good" }) });
    assert.equal(scored.status, 200);
    await p.eval("document.querySelector('main').focus()");
    await p.press("s");
    await p.waitFor("document.querySelector('.review-item')?.dataset.item === '2'", "the next open item");
    const m = await p.eval("({ note: document.querySelector('.review-note')?.textContent, err: document.querySelector('.review-err').textContent, meta: document.querySelector('#review-h + .meta').textContent, focus: document.activeElement.textContent, posts: window.__posts })");
    assert.match(m.note, /^Item 1 was already reviewed somewhere else/);
    assert.doesNotMatch(m.note + m.err, /[0-9a-f]{64}|review done/);
    assert.match(m.meta, /^1 done · 0 skipped/);
    assert.notEqual(m.focus, "Skip");
    assert.equal(m.posts, 1);
    await p.press("Enter");
    await p.waitFor("document.querySelector('.review-err').textContent === 'Pick a value first'", "the hint for Done with no value");
    assert.equal(await p.eval("window.__posts"), 1, "Enter sent no second request");
    assert.deepEqual(p.errors, []);
  });

  test("on a phone every Review control is a 44px touch target", async () => {
    const p = await open("#/review/q-cat", "document.querySelector('.review-item')", 390, 844, true);
    const m = await p.eval(`(() => { const h = (e) => Math.round(e.getBoundingClientRect().height); const btn = (t) => [...document.querySelectorAll('.review-actions .btn')].find((b) => b.textContent === t);
      return { chips: [...document.querySelectorAll('.review-opts .chip')].map(h), done: h(btn('Done')), skip: h(btn('Skip')), copy: h(btn('Copy CLI')), back: h(document.querySelector('.review .page-head .back')) }; })()`);
    assert.equal(m.chips.length, 3);
    for (const c of m.chips) assert.ok(c >= 44, `a category button is ${c}px tall`);
    for (const k of ["done", "skip", "copy", "back"] as const) assert.ok(m[k] >= 44, `${k} is ${m[k]}px tall`);
    assert.deepEqual(p.errors, []);
  });
});
