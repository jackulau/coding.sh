// Viewer fixes from hands-on QA, seen in headless Chrome: a failed command inside a Codex code-mode
// cell is one failure stop (the cell is not a second one, and its calls sit nested under it), going
// back to the list keeps its scroll and focus, j past the last loaded row loads the next page, a
// pressed outcome button clears the label, and the shortcut bar keeps "? all shortcuts" in view at 1024px.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, event, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("viewer QA fixes in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;
  const CELL = "codex-cell-session";
  const LISTED = 120;

  before(async () => {
    const now = Date.now();
    // Enough sessions for three pages of 50; the newest is the code-mode one.
    for (let i = 0; i < LISTED; i++) {
      const id = "s-" + String(i).padStart(3, "0");
      await index.upsertSession(session(id, { startedAt: now - (i + 2) * 3_600_000, endedAt: now - (i + 2) * 3_600_000 + 60_000, title: "Session " + i }));
      await index.putEvents([event(id, 1, { ts: now - (i + 2) * 3_600_000 })]);
    }
    const t = now - 3_000_000;
    const at = (n: number) => t + n * 1000;
    await index.upsertSession(session(CELL, { agent: "codex", startedAt: t, endedAt: at(20), title: "Code-mode cells", stats: { events: 12, turns: 1, toolCalls: 3, toolErrors: 2, filesChanged: 0 } }));
    const ev = (n: number, over: Parameters<typeof event>[2]) => event(CELL, n, { agent: "codex", ts: at(n), ...over });
    await index.putEvents([
      ev(1, { payload: { text: "look up the course" } }),
      // A cell whose one command fails: the cell fails because its command did.
      ev(2, { kind: "tool.start", payload: { tool: "exec", toolUseId: "call_a", input: "text(await tools.exec_command({cmd:'lookup INTST'}))", wrapper: true } }),
      ev(3, { kind: "tool.start", parentId: `${CELL}-e2`, payload: { tool: "Bash", toolUseId: "exec-1", input: { command: "lookup INTST --full" } } }),
      ev(4, { kind: "tool.end", parentId: `${CELL}-e2`, payload: { tool: "Bash", toolUseId: "exec-1", ok: false, exitCode: 1, output: "401 Unauthorized" } }),
      ev(5, { kind: "tool.end", payload: { tool: "exec", toolUseId: "call_a", ok: false, output: "Script completed", wrapper: true } }),
      // A cell that fails on its own (a script error, no failed command): still a failure.
      ev(6, { kind: "tool.start", payload: { tool: "exec", toolUseId: "call_b", input: "apply_patch(...)", wrapper: true } }),
      ev(7, { kind: "tool.end", payload: { tool: "exec", toolUseId: "call_b", ok: false, output: "Script failed\nScript error: apply_patch verification failed", wrapper: true } }),
      // A cell whose command succeeds.
      ev(8, { kind: "tool.start", payload: { tool: "exec", toolUseId: "call_c", input: "text(await tools.exec_command({cmd:'ls'}))", wrapper: true } }),
      ev(9, { kind: "tool.start", parentId: `${CELL}-e8`, payload: { tool: "Bash", toolUseId: "exec-2", input: { command: "ls" } } }),
      ev(10, { kind: "tool.end", parentId: `${CELL}-e8`, payload: { tool: "Bash", toolUseId: "exec-2", ok: true, exitCode: 0, output: "a b" } }),
      ev(11, { kind: "tool.end", payload: { tool: "exec", toolUseId: "call_c", ok: true, output: "Script completed", wrapper: true } }),
      ev(12, { kind: "assistant.message", payload: { text: "The lookup is unauthorized." } }),
    ]);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
  });

  async function open(hash: string, width = 1280, height = 800): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(width, height);
    await page.goto(v.url + hash);
    return page;
  }
  const selected = (p: Page): Promise<string> => p.eval("document.querySelector('#steps .st[aria-selected=true]')?.textContent ?? ''");

  test("a failed command in a code-mode cell is one failure stop, nested under its cell", async () => {
    const p = await open("#/s/" + CELL);
    await p.waitFor("document.querySelectorAll('#steps .st').length >= 6", "steps");
    // The Bash command and the cell that failed on its own; not the cell around the failed Bash.
    await p.waitFor("/2 failed steps/.test(document.querySelector('.fail-nav .lbl')?.textContent ?? '')", "two failed steps", 5000);
    assert.match(await selected(p), /lookup INTST --full/, "opens on the failed command, not its cell");
    await p.eval("document.querySelector('#steps').focus()");
    await p.press("]");
    await pause(100);
    assert.match(await selected(p), /apply_patch/, "next stop is the cell that failed on its own");
    await p.press("]");
    await pause(100);
    assert.match(await selected(p), /lookup INTST --full/, "wraps around past the cell of the failed command");
    const rows: { text: string; cls: string }[] = await p.eval("[...document.querySelectorAll('#steps .st')].map((e) => ({ text: e.textContent, cls: e.className }))");
    const bash = rows.find((r) => /lookup INTST --full/.test(r.text))!;
    const cell = rows.find((r) => /exec/.test(r.text) && /lookup INTST/.test(r.text) && !/--full/.test(r.text))!;
    assert.ok(bash && cell, JSON.stringify(rows));
    assert.match(bash.cls, /\bnested\b/);
    assert.match(bash.cls, /\bis-fail\b/);
    assert.doesNotMatch(cell.cls, /\bis-fail\b/);
    assert.match(cell.cls, /\bchild-fail\b/);
    assert.deepEqual(p.errors, []);
  });

  test("j past the last loaded session loads the next page and selects its first row", async () => {
    const p = await open("#/");
    await p.waitFor("document.querySelectorAll('.list .row').length === 50", "first page");
    await p.eval("document.querySelector('.list[role=listbox]').focus()");
    for (let i = 0; i < 50; i++) await p.press("j");
    await p.waitFor("document.querySelectorAll('.list .row').length === 100", "second page", 10_000);
    await p.waitFor("document.querySelector('.list').getAttribute('aria-activedescendant') === 'opt-50'", "row 51 selected");
    assert.equal(await p.eval("document.activeElement === document.querySelector('.list[role=listbox]')"), true);
    await p.press("j");
    assert.equal(await p.eval("document.querySelector('.list').getAttribute('aria-activedescendant')"), "opt-51");
    assert.deepEqual(p.errors, []);
  });

  test("back from a session keeps the list's scroll and puts focus on the selected row", async () => {
    const p = await open("#/");
    await p.waitFor("document.querySelectorAll('.list .row').length === 50", "first page");
    await p.eval("document.querySelector('.list[role=listbox]').focus()");
    for (let i = 0; i < 40; i++) await p.press("j");
    await pause(100);
    const y: number = await p.eval("window.scrollY");
    assert.ok(y > 500, "the page scrolled down to row 41: " + y);
    const sid: string = await p.eval("document.querySelector('.list [aria-selected=true]').dataset.sid");
    await p.press("Enter");
    await p.waitFor("document.querySelector('#steps')", "session");
    await p.press("Escape");
    await p.waitFor("document.querySelector('.list [aria-selected=true]')", "the list again");
    await pause(100);
    assert.equal(await p.eval("document.querySelector('.list [aria-selected=true]').dataset.sid"), sid);
    const back: number = await p.eval("window.scrollY");
    assert.ok(Math.abs(back - y) < 60, `scroll ${back}, was ${y}`);
    const top: number = await p.eval("document.querySelector('.list [aria-selected=true]').getBoundingClientRect().top");
    assert.ok(top >= 0 && top < 800, "selected row in view: " + top);
    assert.equal(await p.eval("document.activeElement === document.querySelector('.list[role=listbox]')"), true, "focus on the list");
    await p.press("j");
    assert.equal(await p.eval("document.querySelector('.list').getAttribute('aria-activedescendant')"), "opt-41");
    // The browser's Back does the same.
    await p.press("Enter");
    await p.waitFor("document.querySelector('#steps')", "session again");
    await p.eval("history.back()");
    await p.waitFor("document.querySelector('.list [aria-selected=true]')", "the list after Back");
    await pause(100);
    assert.ok(Math.abs((await p.eval("window.scrollY")) - y) < 80);
    assert.equal(await p.eval("document.activeElement === document.querySelector('.list[role=listbox]')"), true);
    assert.deepEqual(p.errors, []);
  });

  test("pressing the pressed outcome button clears the label", async () => {
    const p = await open("#/s/" + CELL);
    await p.waitFor("document.querySelector('.btn-label.is-pass')", "outcome buttons");
    const pressed = (): Promise<string> => p.eval("document.querySelector('.btn-label.is-pass').getAttribute('aria-pressed')");
    const latest = (): Promise<string | null> => p.eval(`fetch('/api/labels?sessionId=${CELL}').then((r) => r.json()).then((j) => j.items.length ? j.items.sort((a, b) => b.ts - a.ts)[0].value : null)`);
    await p.eval("document.querySelector('.btn-label.is-pass').click()");
    await p.waitFor("document.querySelector('.btn-label.is-pass').getAttribute('aria-pressed') === 'true' && !document.querySelector('.btn-label.is-pass').disabled", "pass pressed");
    assert.equal(await latest(), "pass");
    await p.eval("document.querySelector('.btn-label.is-pass').click()");
    await p.waitFor("document.querySelector('.btn-label.is-pass').getAttribute('aria-pressed') === 'false' && !document.querySelector('.btn-label.is-pass').disabled", "pass unpressed");
    assert.equal(await pressed(), "false");
    assert.equal(await p.eval("document.querySelector('.btn-label.is-fail').getAttribute('aria-pressed')"), "false");
    assert.equal(await latest(), "skip", "the verdict is taken back");
    // A reload shows neither pressed.
    await p.eval("location.reload()");
    await pause(300);
    await p.waitFor("document.querySelector('.btn-label.is-pass')", "outcome buttons after reload");
    assert.equal(await pressed(), "false");
    assert.equal(await p.eval("document.querySelector('.label-by').textContent"), "");
    assert.deepEqual(p.errors, []);
  });

  for (const [w, hgt] of [[1024, 768], [988, 597]] as const) {
    test(`the shortcut bar keeps "? all shortcuts" in view at ${w}x${hgt}`, async () => {
      const p = await open("#/s/" + CELL, w, hgt);
      await p.waitFor("/all shortcuts$/.test(document.querySelector('.hintbar > :last-child')?.textContent ?? '')", "shortcut bar");
      const r: { top: number; bottom: number; barTop: number; barBottom: number } = await p.eval("(() => { const a = document.querySelector('.hintbar > :last-child').getBoundingClientRect(); const b = document.querySelector('.hintbar').getBoundingClientRect(); return { top: a.top, bottom: a.bottom, barTop: b.top, barBottom: b.bottom }; })()");
      assert.ok(r.top >= r.barTop && r.bottom <= r.barBottom, JSON.stringify(r));
      assert.ok(r.bottom <= hgt, JSON.stringify(r));
      // Every hint shown sits on the bar's one line; the ones that do not fit drop whole.
      const tops: number[] = await p.eval("[...document.querySelectorAll('.hintbar span')].filter((s) => s.querySelector('kbd') && !/all shortcuts$/.test(s.textContent)).map((s) => s.getBoundingClientRect().top)");
      const shown = tops.filter((t) => t < r.barBottom);
      assert.ok(shown.length >= 4, "the first hints show: " + tops);
      assert.ok(shown.every((t) => t >= r.barTop), "shown hints are on the one line: " + tops);
      assert.deepEqual(p.errors, []);
    });
  }
});
