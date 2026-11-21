// Comments and saved views in headless Chrome. A comment box on the session and on each step posts a
// text score named comment (each with its own id), shows it as text under its step or the session,
// and posts on Ctrl+Enter. The sessions list's views menu lists, applies and deletes saved views and
// saves the current filter under a name; a server without views (404) shows neither control.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, event, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const S1 = "cmt-one";
const S2 = "cmt-html";
const HTML = `<img src=x onerror="window.__xss=1"><b>bold</b> & more`;

/**
 * Records every request that is not a GET in window.__calls. With `views`, /api/views answers from
 * the stub: a list of saved views, or 404 as a server without views does.
 */
function stub(views?: unknown[] | 404): string {
  return `(() => {
    window.__calls = [];
    const real = window.fetch.bind(window);
    const views = ${JSON.stringify(views ?? null)};
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init && init.method) || "GET";
      if (method !== "GET") window.__calls.push({ url, method, body: init && init.body ? JSON.parse(init.body) : null });
      if (views !== null && url.startsWith("/api/views")) {
        if (views === 404) return json({ error: "not found" }, 404);
        if (method === "POST") { const b = JSON.parse(init.body); return json({ ...b, createdAt: 1, updatedAt: 1 }, 201); }
        if (method === "DELETE") return json({ ok: true });
        return json({ items: views });
      }
      return real(input, init);
    };
  })()`;
}

describe("comments and saved views in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  const blobs = new FakeBlobs();
  let dir: string;
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "comments-views-browser-"));
    const t = Date.now() - 3600e3;
    await index.upsertSession(session(S1, { startedAt: t, endedAt: t + 10_000, title: "Fix the loader", stats: { events: 3, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents([
      event(S1, 1, { ts: t + 1000, payload: { text: "fix the loader" } }),
      event(S1, 2, { ts: t + 2000, kind: "tool.start", payload: { tool: "Read", toolUseId: "u1", input: { file_path: "src/load.ts" } } }),
      event(S1, 3, { ts: t + 3000, kind: "tool.end", payload: { tool: "Read", toolUseId: "u1", ok: true, output: "export {}" } }),
    ]);
    await index.upsertSession(session(S2, { startedAt: t - 5000, endedAt: t, title: "Markup in a comment", stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents([event(S2, 1, { ts: t - 4000, payload: { text: "hello" } })]);
    await index.putScore!({ id: "comment-html", target: "session", targetId: S2, sessionId: S2, name: "comment", dataType: "text", value: HTML, source: "human", by: "ana", ts: t });
    v = await startViewer({ index, blobs, port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(dir, "work.json"), home: dir, cwd: dir } });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string, views?: unknown[] | 404): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: stub(views) });
    await page.goto(v.url + hash);
    return page;
  }
  const ctrlEnter = (sel: string) => `document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }))`;

  test("a session comment posts a text score on the session, and shows under it", async () => {
    const p = await open(`#/s/${S1}`);
    const toggle = ".tl-tools .cmt-toggle";
    await p.waitFor(`document.querySelector('${toggle}') && document.querySelector('#steps .st')`, "the session");
    await p.eval(`document.querySelector('${toggle}').click()`);
    assert.equal(await p.eval("document.activeElement.classList.contains('cmt-input')"), true, "the box takes focus");
    // Empty text is refused, next to the box.
    await p.eval(ctrlEnter(".cmt-session .cmt-input"));
    assert.equal(await p.eval("document.querySelector('.cmt-session .cmt-err').textContent"), "Write something to post.");
    assert.equal(await p.eval("window.__calls.length"), 0);
    await p.eval("document.querySelector('.cmt-session .cmt-input').value = '  looks right  '");
    await p.eval(ctrlEnter(".cmt-session .cmt-input"));
    await p.waitFor("window.__calls.length === 1", "the post");
    const call = await p.eval("window.__calls[0]");
    assert.equal(call.url, "/api/scores");
    assert.match(call.body.id, /^comment-[0-9a-z]+-[0-9a-f]{18}$/);
    const { id: _id, ...body } = call.body;
    assert.deepEqual(body, { target: "session", targetId: S1, name: "comment", dataType: "text", value: "looks right", source: "human" });
    await p.waitFor("document.querySelector('.cmt-session .cmt-text')?.textContent === 'looks right'", "the comment");
    assert.equal(await p.eval("document.querySelector('.cmt-session .cmt-box').hidden"), true, "posting closes the box");
    assert.equal(await p.eval(`document.activeElement === document.querySelector('${toggle}')`), true, "focus goes back to the control");
    assert.equal(await p.eval(`document.querySelector('${toggle} .count').textContent`), "1");
    // A second comment by the same person adds one; it does not replace the first.
    await p.eval(`document.querySelector('${toggle}').click()`);
    await p.eval("document.querySelector('.cmt-session .cmt-input').value = 'and a second note'");
    await p.eval(ctrlEnter(".cmt-session .cmt-input"));
    await p.waitFor("document.querySelectorAll('.cmt-session .cmt-text').length === 2", "two comments");
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.cmt-session .cmt-text')].map((e) => e.textContent)"), ["looks right", "and a second note"]);
    assert.equal((await index.listScores!({ sessionId: S1, name: "comment" })).length, 2);
  });

  test("a step comment posts a text score on its event, shows in its pane and marks its row; Escape closes the box", async () => {
    const p = await open(`#/s/${S1}/${S1}-e2`);
    const toggle = "#event-pane .cmt-toggle";
    await p.waitFor(`document.querySelector('${toggle}')`, "the step's comment control");
    await p.eval(`document.querySelector('${toggle}').click()`);
    const input = "#event-pane .cmt-input";
    // Escape closes the box and stays on the session.
    await p.eval(`document.querySelector('${input}').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    assert.equal(await p.eval("document.querySelector('#event-pane .cmt-box').hidden"), true);
    assert.match(await p.eval("location.hash"), new RegExp(`^#/s/${S1}`));
    await p.eval(`document.querySelector('${toggle}').click()`);
    await p.eval(`document.querySelector('${input}').value = 'wrong file'`);
    await p.eval("[...document.querySelectorAll('#event-pane .cmt-box button')].find((b) => b.textContent === 'Post').click()");
    await p.waitFor("window.__calls.length === 1", "the post");
    const { id: _id, ...body } = (await p.eval("window.__calls[0]")).body;
    assert.deepEqual(body, { target: "event", targetId: `${S1}-e3`, name: "comment", dataType: "text", value: "wrong file", source: "human" });
    await p.waitFor("document.querySelector('#event-pane .cmt-text')?.textContent === 'wrong file'", "the comment in the pane");
    await p.waitFor("document.querySelector('#steps .st[aria-selected=true] .cmt-flag')?.textContent === '1'", "the row's count");
    assert.equal(await p.eval("document.querySelectorAll('.cmt-session .cmt-text').length"), 2, "the session's own comments stay apart");
  });

  test("a comment with markup in it shows as text", async () => {
    const p = await open(`#/s/${S2}`);
    await p.waitFor("document.querySelector('.cmt-session .cmt-text')", "the comment");
    assert.equal(await p.eval("document.querySelector('.cmt-session .cmt-text').textContent"), HTML);
    assert.equal(await p.eval("document.querySelectorAll('.cmt-session img, .cmt-session .cmt-text b').length"), 0);
    assert.equal(await p.eval("window.__xss === undefined"), true);
    assert.match(await p.eval("document.querySelector('.cmt-session .cmt-list .meta').textContent"), /^ana · /);
  });

  test("the views menu lists saved views, applies one to the list and the URL, deletes one, and saves the filter", async () => {
    const p = await open("#/", [{ name: "fails", where: "ok:false", createdAt: 1, updatedAt: 1 }, { name: "bash", where: "tool:Bash", createdAt: 1, updatedAt: 1 }]);
    await p.waitFor("document.querySelector('.views') && !document.querySelector('.views').hidden", "the views control");
    assert.equal(await p.eval("[...document.querySelectorAll('.views button')].find((b) => b.textContent === 'Save view').disabled"), true, "no filter, nothing to save");
    await p.eval("[...document.querySelectorAll('.views button')].find((b) => b.textContent === 'Views').click()");
    await p.waitFor("document.querySelectorAll('.views-opt').length === 2", "two views");
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.views-opt > span:first-child')].map((e) => e.textContent)"), ["bash", "fails"]);
    await p.eval("[...document.querySelectorAll('.views-opt')].find((b) => b.textContent.startsWith('fails')).click()");
    await p.waitFor("document.querySelector('#q').value === 'ok:false' && decodeURIComponent(location.hash).includes('where=ok:false')", "the view applied");
    assert.equal(await p.eval("document.querySelector('.views-pop').hidden"), true);
    // Delete one.
    await p.eval("[...document.querySelectorAll('.views button')].find((b) => b.textContent === 'Views').click()");
    await p.waitFor("document.querySelector('[aria-label=\"Delete view bash\"]')", "the delete control");
    await p.eval("document.querySelector('[aria-label=\"Delete view bash\"]').click()");
    await p.waitFor("document.querySelectorAll('.views-opt').length === 1", "one view left");
    assert.deepEqual(await p.eval("window.__calls.map((c) => c.method + ' ' + c.url)"), ["DELETE /api/views/bash"]);
    // Escape closes the menu and gives focus back to its button.
    await p.eval("document.querySelector('.views-opt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    assert.equal(await p.eval("document.querySelector('.views-pop').hidden"), true);
    assert.equal(await p.eval("document.activeElement.textContent"), "Views");
    // Save the current filter under a name.
    await p.eval("[...document.querySelectorAll('.views button')].find((b) => b.textContent === 'Save view').click()");
    await p.waitFor("document.querySelector('.views-form input')", "the name box");
    await p.eval("document.querySelector('.views-form input').value = 'bad name!'");
    await p.eval("document.querySelector('.views-form').requestSubmit()");
    assert.match(await p.eval("document.querySelector('.views-form .cmt-err').textContent"), /letters, digits/);
    await p.eval("document.querySelector('.views-form input').value = 'mine'");
    await p.eval("document.querySelector('.views-form').requestSubmit()");
    await p.waitFor("window.__calls.length === 2", "the save");
    assert.deepEqual(await p.eval("window.__calls[1]"), { url: "/api/views", method: "POST", body: { name: "mine", where: "ok:false" } });
    await p.waitFor("document.querySelector('.views-pop').hidden", "the form closes");
    assert.deepEqual(p.errors, []);
  });

  test("a server without views (404) shows neither the button nor the menu", async () => {
    const p = await open("#/", 404);
    await p.waitFor("typeof views !== 'undefined' && views.state === 'off'", "the views answer");
    await p.waitFor("document.querySelector('#sessions-h')", "the list");
    assert.equal(await p.eval("document.querySelector('.views').hidden"), true);
    assert.equal(await p.eval("[...document.querySelectorAll('button')].some((b) => b.offsetParent && /^(Views|Save view)$/.test(b.textContent))"), false);
  });
});
