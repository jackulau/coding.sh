// The Review page in headless Chrome, against stubbed /api/review, /api/score-configs and
// /api/sessions answers: the queue list and its empty state, one control per score config type,
// the request bodies Done and Skip post, the keys (and none while a box has focus), the finished
// state on a 204, an API error that keeps what the person typed, and a nav entry that a server
// without review queues hides. Then the Work page's stage and kind chips and its stage filter,
// with and without the new fields.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

interface Stub {
  /** GET /api/review: the queues, or an error status. */
  queues?: unknown[] | number;
  /** The one queue the stub serves under /api/review/q1. */
  queue?: { config: string; items: Record<string, unknown>[]; postError?: { status: number; error: string } };
  configs?: unknown[];
  work?: unknown;
}

/** Answers the review, score config, session and work routes; records every request in window.__calls. */
function stub(o: Stub): string {
  return `(() => {
    const o = ${JSON.stringify(o)};
    window.__calls = [];
    const real = window.fetch.bind(window);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    let at = 0, skipped = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init && init.method) || "GET";
      window.__calls.push({ url, method, body: init && init.body ? JSON.parse(init.body) : null });
      if (url === "/api/review" && o.queues !== undefined) return typeof o.queues === "number" ? json({ error: "not found" }, o.queues) : json({ items: o.queues });
      if (url.startsWith("/api/review/q1") && o.queue) {
        const q = o.queue, total = q.items.length;
        if (method === "POST") {
          if (q.postError) return json({ error: q.postError.error }, q.postError.status);
          const body = JSON.parse(init.body);
          if (body.skip) skipped++;
          at++;
          return json({ item: { id: at }, next: q.items[at] || null });
        }
        if (url === "/api/review/q1/next") return at < total ? json({ queue: "q1", config: q.config, flags: [], values: "", command: "coding.sh review done q1 " + (at + 1) + " <value>", pending: total - at, ...q.items[at] }) : new Response(null, { status: 204 });
        if (url === "/api/review/q1") return json({ queue: "q1", config: q.config, done: at - skipped, skipped, total });
      }
      if (url === "/api/score-configs" && o.configs) return json({ items: o.configs });
      if (url.startsWith("/api/sessions/sess-")) {
        const id = decodeURIComponent(url.slice("/api/sessions/".length));
        return json({ id, title: "Title from the session", agent: "codex", model: "gpt-5", startedAt: Date.UTC(2026, 9, 7, 9, 30), repo: { root: "/work/demo" }, cwd: "/work/demo", flags: ["slow"], stats: { usage: { costUsd: 0.42 } } });
      }
      if (url.startsWith("/api/work?") && o.work) return json(o.work);
      return real(input, init);
    };
  })()`;
}

const ITEMS = [
  { item: 1, target: "session", targetId: "sess-1", sessionId: "sess-1", title: "Fix the loader", agent: "claude-code", flags: ["loop"] },
  { item: 2, target: "session", targetId: "sess-2", sessionId: "sess-2", title: "Add a test" },
];
const CONFIGS = [
  { id: "c1", name: "correct", dataType: "boolean", ts: 1 },
  { id: "c2", name: "tone", dataType: "categorical", categories: ["good", "ok", "bad"], ts: 1 },
  { id: "c3", name: "quality", dataType: "numeric", min: 0, max: 5, ts: 1 },
  { id: "c4", name: "notes", dataType: "text", ts: 1 },
];
const posts = "window.__calls.filter((c) => c.method === 'POST')";
const item = "document.querySelector('.review-item')?.dataset.item";

describe("Review page in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let dir: string;
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "review-browser-"));
    v = await startViewer({ index: new MemoryIndexStore(), blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(dir, "work.json"), home: dir, cwd: dir } });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string, o: Stub, wait = "document.querySelector('.review-body > *')"): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: stub(o) });
    await page.goto(v.url + hash);
    await page.waitFor(wait, "the page");
    return page;
  }
  const queue = (config: string, extra: Partial<NonNullable<Stub["queue"]>> = {}): Stub => ({ queues: [], queue: { config, items: ITEMS, ...extra }, configs: CONFIGS });

  test("lists each queue with its config, counts and progress", async () => {
    const p = await open("#/review", { queues: [
      { queue: "q1", config: "correct", done: 3, skipped: 1, total: 8, where: "agent:codex", createdAt: 1 },
      { queue: "nightly", config: "tone", done: 0, skipped: 0, total: 0, where: "flag:loop", createdAt: 2 },
    ] }, "document.querySelector('.review-list')");
    assert.equal(await p.eval("document.querySelector('[data-nav=review]').getAttribute('aria-current')"), "page");
    assert.equal(await p.eval("document.querySelector('[data-nav=review]').hidden"), false);
    const rows = await p.eval("[...document.querySelectorAll('.review-row')].map((r) => [r.querySelector('h2 a').getAttribute('href'), r.querySelector('.badge').textContent, r.querySelector('.bar > i').style.width, r.querySelector('.bar').getAttribute('aria-valuenow'), r.querySelectorAll('.meta')[0].textContent])");
    assert.deepEqual(rows, [
      ["#/review/q1", "correct", "50%", "4", "3 done · 1 skipped · 8 in all"],
      ["#/review/nightly", "tone", "0%", "0", "0 done · 0 skipped · 0 in all"],
    ]);
    assert.equal(await p.eval("document.querySelector('.page-head .meta').textContent"), "2 queues");
    assert.deepEqual(p.errors, []);
  });

  test("with no queue, the empty state names the create command", async () => {
    const p = await open("#/review", { queues: [] });
    assert.equal(await p.eval("document.querySelector('.review-body .empty h2').textContent"), "No review queues yet");
    assert.equal(await p.eval("document.querySelector('.review-body .cmd code').textContent"), "coding.sh review create <name> --where <query> --config <config>");
    assert.deepEqual(p.errors, []);
  });

  for (const status of [404, 501]) {
    test(`a server whose /api/review answers ${status} hides the nav entry and the menu's`, async () => {
      const p = await open("#/", { queues: status }, "document.querySelector('[data-nav=review]').hidden");
      await p.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))");
      await p.waitFor("document.querySelector('.palette')", "the command menu");
      assert.equal(await p.eval("document.querySelector('.palette').textContent.includes('Review queues')"), false);
      assert.deepEqual(p.errors, []);
    });
  }

  test("boolean: y and n pick, Enter and Done post {value, comment?}, a 204 finishes the queue", async () => {
    const p = await open("#/review/q1", queue("correct"), "document.querySelector('.review-item')");
    // The item: title, agent, repo, start, cost and flags, linking to its session.
    assert.equal(await p.eval("document.querySelector('#rv-title a').getAttribute('href')"), "#/s/sess-1");
    assert.equal(await p.eval("document.querySelector('#rv-title').textContent"), "Fix the loader");
    const facts: string = await p.eval("document.querySelector('.review-facts').textContent");
    for (const part of ["claude-code", "demo", "started ", "$0.42"]) assert.ok(facts.includes(part), `${part} in ${facts}`);
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.review-item .badge.flag')].map((b) => b.textContent)"), ["loop"]);
    assert.equal(await p.eval("document.querySelector('.page-head .meta').textContent"), "0 done · 0 skipped · 2 in all · score config correct");
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.review-opts button')].map((b) => b.textContent)"), ["Yes", "No"]);
    await p.press("y");
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.review-opts button')].map((b) => b.getAttribute('aria-pressed'))"), ["true", "false"]);
    await p.press("Enter");
    await p.waitFor(`${item} === "2"`, "the next item");
    assert.deepEqual(await p.eval(posts), [{ url: "/api/review/q1/1", method: "POST", body: { value: true } }]);
    // No title on the item: the session's own.
    assert.equal(await p.eval("document.querySelector('#rv-title').textContent"), "Add a test");
    assert.equal(await p.eval("document.querySelector('.bar').getAttribute('aria-valuenow')"), "1");
    await p.press("n");
    await p.eval("document.querySelector('#rv-comment').value = 'misses the edge case'");
    await p.eval("document.querySelector('.review-actions .btn-primary').click()");
    await p.waitFor("document.querySelector('.review-body .empty')", "the finished state");
    assert.deepEqual((await p.eval(posts))[1], { url: "/api/review/q1/2", method: "POST", body: { value: false, comment: "misses the edge case" } });
    assert.equal(await p.eval("document.querySelector('.review-body .empty h2').textContent"), "This queue is finished");
    assert.equal(await p.eval("document.querySelector('.review-body .empty a').getAttribute('href')"), "#/review");
    assert.deepEqual(p.errors, []);
  });

  test("categorical: one button per category, keys 1 to 9 pick one", async () => {
    const p = await open("#/review/q1", queue("tone"), "document.querySelector('.review-item')");
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.review-opts .chip')].map((b) => b.textContent)"), ["1good", "2ok", "3bad"]);
    assert.equal(await p.eval("document.querySelector('.review-opts').getAttribute('aria-labelledby')"), "rv-label");
    assert.equal(await p.eval("[...document.querySelectorAll('.review-item label')].every((l) => l.control)"), true, "every label points at a field");
    await p.press("4");
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.review-opts .chip[aria-pressed=true]')].length"), 0, "no fourth category");
    await p.press("2");
    assert.equal(await p.eval("document.querySelector('.review-opts .chip[aria-pressed=true]').textContent"), "2ok");
    await p.press("Enter");
    await p.waitFor(`${item} === "2"`, "the next item");
    assert.deepEqual(await p.eval(posts), [{ url: "/api/review/q1/1", method: "POST", body: { value: "ok" } }]);
    assert.deepEqual(p.errors, []);
  });

  test("numeric: an input with the config's min and max, and no request until a number is given", async () => {
    const p = await open("#/review/q1", queue("quality"), "document.querySelector('.review-item')");
    assert.deepEqual(await p.eval("(() => { const i = document.querySelector('#rv-value'); return [i.type, i.min, i.max, document.querySelector('label[for=rv-value]').textContent]; })()"), ["number", "0", "5", "quality (0 to 5)"]);
    await p.press("Enter");
    assert.equal(await p.eval("document.querySelector('.review-err').textContent"), "Enter a number, 0 to 5");
    assert.equal(await p.eval(`${posts}.length`), 0);
    await p.eval("document.querySelector('#rv-value').value = '4'");
    await p.eval("document.querySelector('.review-actions .btn-primary').click()");
    await p.waitFor(`${item} === "2"`, "the next item");
    assert.deepEqual(await p.eval(posts), [{ url: "/api/review/q1/1", method: "POST", body: { value: 4 } }]);
    assert.deepEqual(p.errors, []);
  });

  test("text: a text box, and no key acts while a box has focus", async () => {
    const p = await open("#/review/q1", queue("notes"), "document.querySelector('.review-item')");
    assert.equal(await p.eval("document.querySelector('#rv-value').tagName"), "TEXTAREA");
    for (const box of ["#rv-value", "#rv-comment"]) {
      await p.eval(`document.querySelector('${box}').focus()`);
      for (const key of ["s", "o", "Enter"]) await p.press(key);
    }
    assert.equal(await p.eval(`${posts}.length`), 0, "s and Enter in a box post nothing");
    assert.equal(await p.eval("location.hash"), "#/review/q1", "o in a box opens nothing");
    assert.match(await p.eval("document.querySelector('#rv-value').value"), /^so/, "the keys typed into the box");
    await p.eval("document.querySelector('#rv-value').value = 'reads well'");
    await p.eval("document.querySelector('#rv-comment').value = ''");
    await p.eval("document.querySelector('.review-actions .btn-primary').click()");
    await p.waitFor(`${item} === "2"`, "the next item");
    assert.deepEqual(await p.eval(posts), [{ url: "/api/review/q1/1", method: "POST", body: { value: "reads well" } }]);
    assert.deepEqual(p.errors, []);
  });

  test("s posts {skip: true}, and o opens the item's session", async () => {
    const p = await open("#/review/q1", queue("correct"), "document.querySelector('.review-item')");
    await p.press("s");
    await p.waitFor(`${item} === "2"`, "the next item");
    assert.deepEqual(await p.eval(posts), [{ url: "/api/review/q1/1", method: "POST", body: { skip: true } }]);
    assert.equal(await p.eval("document.querySelector('.page-head .meta').textContent"), "0 done · 1 skipped · 2 in all · score config correct");
    await p.press("o");
    await p.waitFor("location.hash === '#/s/sess-2'", "the session");
    assert.deepEqual(p.errors, []);
  });

  test("an API error shows next to the control and keeps what the person typed", async () => {
    const p = await open("#/review/q1", queue("quality", { postError: { status: 400, error: "value 9 is above quality's maximum 5" } }), "document.querySelector('.review-item')");
    await p.eval("document.querySelector('#rv-value').value = '9'");
    await p.eval("document.querySelector('#rv-comment').value = 'too long'");
    await p.eval("document.querySelector('.review-actions .btn-primary').click()");
    await p.waitFor("document.querySelector('.review-err').textContent", "the error");
    assert.equal(await p.eval("document.querySelector('.review-err').textContent"), "value 9 is above quality's maximum 5");
    assert.equal(await p.eval("document.querySelector('.review-err').parentElement.contains(document.querySelector('#rv-value'))"), true, "next to the control");
    assert.deepEqual(await p.eval("[document.querySelector('#rv-value').value, document.querySelector('#rv-comment').value]"), ["9", "too long"]);
    assert.equal(await p.eval(item), "1");
    assert.equal(await p.eval("document.querySelector('.review-actions .btn-primary').disabled"), false);
    assert.deepEqual(p.errors, []);
  });

  test("the queue page at phone width fits the screen", async () => {
    const p = await open("#/review/q1", queue("tone"), "document.querySelector('.review-item')");
    await p.viewport(390, 844, true);
    assert.deepEqual(await p.eval("[innerWidth, document.documentElement.scrollWidth]"), [390, 390]);
    assert.deepEqual(p.errors, []);
  });
});

describe("Work page stage chips and filter in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let dir: string;
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "review-work-browser-"));
    v = await startViewer({ index: new MemoryIndexStore(), blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(dir, "work.json"), home: dir, cwd: dir } });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const now = new Date(Date.UTC(2026, 9, 7, 12)).toISOString();
  const base = { id: "w1", title: "Fix the loader", sessionId: "s1", agent: "codex", sessions: 1, lastActivity: Date.parse(now) - 600e3, bucket: "review", reason: "ended 10m ago", next: "review: `git diff`" };
  const doc = (withStages: boolean) => {
    const d: Record<string, unknown> = {
      now, counts: { blocked: 0, failed: 0, stalled: 0, turn: 0, review: 1 }, hidden: 0, hiddenBy: {},
      items: [withStages ? { ...base, stage: "review", kind: "change", stageWhy: "changed 3 files, stopped 10m ago" } : base],
    };
    if (withStages) d.stages = { planning: 1, executing: 0, review: 1, approval: 0, done: 2 };
    return d;
  };
  async function open(hash: string, work: unknown): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: stub({ work }) });
    await page.goto(v.url + hash);
    await page.waitFor("document.querySelector('.work-item')", "the work items");
    return page;
  }

  test("each item shows its stage and kind, the header counts stages, and the filter sits in the hash", async () => {
    const p = await open("#/work", doc(true));
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.work-head .badge')].map((b) => [b.textContent, b.title])"), [
      ["review", "changed 3 files, stopped 10m ago"],
      ["change", "changed 3 files, stopped 10m ago"],
    ]);
    assert.equal(await p.eval("document.querySelector('.work-stages').textContent"), "Stages: 1 planning · 1 review · 2 done");
    assert.equal(await p.eval("document.querySelector('.work-stage-seg').hidden"), false);
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.work-stage-seg button')].map((b) => b.textContent)"), ["any stage", "planning", "executing", "review", "approval", "done"]);
    await p.eval("[...document.querySelectorAll('.work-stage-seg button')].find((b) => b.textContent === 'review').click()");
    await p.waitFor("new URLSearchParams(location.hash.split('?')[1] || '').get('stage') === 'review'", "the stage in the hash");
    await p.waitFor("window.__calls.some((c) => c.url.startsWith('/api/work?') && new URLSearchParams(c.url.split('?')[1]).get('stage') === 'review')", "the stage sent to /api/work");
    await p.waitFor("document.querySelector('.work-stage-seg button[aria-pressed=true]')?.textContent === 'review'", "the pressed stage");
    assert.deepEqual(p.errors, []);
  });

  test("an older server's items show no chips, no stage counts and no filter", async () => {
    const p = await open("#/work", doc(false));
    assert.equal(await p.eval("document.querySelectorAll('.work-head .badge').length"), 0);
    assert.equal(await p.eval("document.querySelector('.work-stages').hidden"), true);
    assert.equal(await p.eval("document.querySelector('.work-stage-seg').hidden"), true);
    assert.equal(await p.eval("getComputedStyle(document.querySelector('.work-stage-seg')).display"), "none");
    assert.deepEqual(p.errors, []);
  });
});
