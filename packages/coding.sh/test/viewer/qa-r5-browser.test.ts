// Viewer fixes from hands-on QA (round 5), in headless Chrome: a diff the adapter cut short says so
// where it stops and loads the whole diff from its blob; Steps and Chat number prompts, so a session
// with more turns than prompts reads "Prompt 2" under "3 turns"; a session opened from the command
// menu goes back to the plain Sessions list, not to an earlier Events search; and a Work card's age
// matches its reason's, with its next command shown as code.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { mkSession } from "../cli/_cmd.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, event, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const HOUR = 3600e3;
const DIFF = "D-cut";
const TURNS = "T-turns";
const OTHER = "O-other";
const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `+line ${from + i}\n`).join("");
const head = "--- /dev/null\n+++ b/study.py\n@@ -0,0 +1,56 @@\n";

describe("viewer QA round 5 fixes in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  const blobs = new FakeBlobs();
  let dir: string;
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "qa-r5-browser-"));
    const now = Date.now();
    // A new 56-line file whose stored diff stops after line 32, with the whole diff in a blob.
    const full = head + lines(56);
    const sha = await blobs.put(full);
    const t = now - 2 * HOUR;
    await index.upsertSession(session(DIFF, { startedAt: t, endedAt: t + 10_000, title: "Write the study", stats: { events: 2, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 1 } }));
    await index.putEvents([
      event(DIFF, 1, { ts: t + 1000, payload: { text: "write the study" } }),
      event(DIFF, 2, { ts: t + 2000, kind: "file.change", payload: { path: "study.py", op: "add", additions: 56, deletions: 0, diff: head + lines(32), diffTruncated: true }, blobs: [sha] }),
    ]);
    // Two prompts and three turns: a background task's notice started the middle one.
    const u = now - 3 * HOUR;
    await index.upsertSession(session(TURNS, { startedAt: u, endedAt: u + 10_000, title: "Vercel deploy", stats: { events: 7, turns: 3, toolCalls: 0, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents([
      event(TURNS, 1, { ts: u + 1000, payload: { text: "deploy to vercel" } }),
      event(TURNS, 2, { ts: u + 2000, kind: "assistant.message", payload: { text: "Started the vercel deploy in the background." } }),
      event(TURNS, 3, { ts: u + 3000, kind: "turn.end", payload: {} }),
      event(TURNS, 4, { ts: u + 4000, kind: "assistant.message", payload: { text: "The vercel deploy finished." } }),
      event(TURNS, 5, { ts: u + 5000, kind: "turn.end", payload: {} }),
      event(TURNS, 6, { ts: u + 6000, payload: { text: "thanks, check vercel logs" } }),
      event(TURNS, 7, { ts: u + 7000, kind: "turn.end", payload: {} }),
    ]);
    await index.upsertSession(session(OTHER, { startedAt: now - 4 * HOUR, endedAt: now - 4 * HOUR + 5000, title: "Unrelated chores", stats: { events: 1, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents([event(OTHER, 1, { ts: now - 4 * HOUR + 1000, payload: { text: "tidy the readme" } })]);
    // A Work item that failed 30 hours ago: "1d ago" under the old rounding, "30h" in its reason.
    await index.upsertSession(mkSession("failed-30h", now - 31 * HOUR, { agent: "codex", cwd: "/work/api", title: "migrate the tests", endedAt: now - 30 * HOUR, stats: { testsFailed: 2 } as any }));
    v = await startViewer({ index, blobs, port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(dir, "work.json"), home: dir, cwd: dir } });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.goto(v.url + hash);
    return page;
  }

  test("a cut diff says how much it leaves out, shows no made-up line, and loads the whole diff", async () => {
    const p = await open(`#/s/${DIFF}/${DIFF}-e2`);
    const pane = "document.querySelector('#event-pane')";
    await p.waitFor(`${pane}?.querySelector('.diff-cut-note')`, "the cut note");
    const lastNew = `[...${pane}.querySelectorAll('.diff .ln')].filter((_, i) => i % 2 === 1).map((e) => e.textContent).filter(Boolean).pop()`;
    assert.equal(await p.eval(lastNew), "32", "the last line shown is the last line stored");
    assert.equal(await p.eval(`${pane}.querySelectorAll('.diff .tx:not(.add):not(.del)').length`), 0, "no context line after the cut");
    assert.match(await p.eval(`${pane}.querySelector('.diff-cut-note').textContent`), /Diff cut short: 24 more changed lines not shown\./);
    assert.doesNotMatch(await p.eval(`${pane}.textContent`), /diffTruncated/, "the flag is not left to the raw payload");
    await p.eval(`${pane}.querySelector('.diff-cut-note button').click()`);
    await p.waitFor(`!${pane}.querySelector('.diff-cut-note') && ${pane}.querySelectorAll('.diff .tx.add').length === 56`, "the whole diff");
    assert.equal(await p.eval(lastNew), "56");
  });

  test("Steps and Chat number prompts, so a session with more turns than prompts does not read Turn 2 of 3", async () => {
    const p = await open(`#/s/${TURNS}`);
    await p.waitFor("document.querySelectorAll('#steps .st').length >= 3", "steps");
    assert.match(await p.eval("[...document.querySelectorAll('.detail-head .badge')].map((b) => b.textContent).join('|')"), /(^|\|)3 turns(\||$)/);
    const marks: string[] = await p.eval("[...document.querySelectorAll('#steps .st .t')].map((e) => e.textContent).filter((t) => /^(Turn|Prompt) /.test(t))");
    assert.deepEqual(marks, ["Prompt 1", "Prompt 2"]);
    await p.eval("document.querySelector('.view-seg button:last-child').click()");
    await p.waitFor("document.querySelectorAll('#chat .chat-who').length >= 2", "chat");
    const who: string[] = await p.eval("[...document.querySelectorAll('#chat .chat-who span')].map((e) => e.textContent).filter((t) => t !== 'Assistant')");
    assert.deepEqual(who, ["Prompt 1", "Prompt 2"]);
  });

  test("a session opened from the command menu goes back to Sessions, not to an earlier Events search", async () => {
    const p = await open("#/events?where=vercel");
    const rows = "[...document.querySelectorAll('.event-table .row')]";
    await p.waitFor(`${rows}.length > 0`, "matching events");
    await p.eval(`${rows}[0].click()`);
    await p.waitFor(`location.hash.startsWith('#/s/${TURNS}/') && document.querySelector('.back')?.textContent === '←Events'`, "the session, back to Events");
    assert.equal(await p.eval("document.querySelector('.back').getAttribute('href')"), "#/events?where=vercel");
    await p.eval("document.querySelector('#cmdk').click()");
    await p.waitFor("document.querySelector('.palette input')", "palette");
    await p.eval(`(() => { const i = document.querySelector('.palette input'); i.value = '${OTHER}'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await p.waitFor(`[...document.querySelectorAll('.palette-item')].some((o) => o.textContent.includes('Unrelated chores'))`, "the session in the menu");
    await p.eval(`[...document.querySelectorAll('.palette-item')].find((o) => o.textContent.includes('Unrelated chores')).click()`);
    await p.waitFor(`location.hash.startsWith('#/s/${OTHER}') && document.querySelector('.crumbs .sid')?.textContent === '${OTHER}'`, "the other session");
    assert.equal(await p.eval("document.querySelector('.back').textContent"), "←Sessions");
    assert.equal(await p.eval("document.querySelector('.back').getAttribute('href')"), "#/");
    // Back in history to the session opened from Events: its link goes back to that search again.
    await p.eval("history.back()");
    await p.waitFor(`location.hash.startsWith('#/s/${TURNS}/') && document.querySelector('.back')?.textContent === '←Events'`, "back to Events again");
  });

  test("a failed Work card gives one age and shows its next command as code", async () => {
    const p = await open("#/work");
    const card = "document.querySelector('.work-item[data-bucket=failed]')";
    await p.waitFor(card, "the failed card");
    const reason: string = await p.eval(`${card}.querySelector('.work-reason').textContent`);
    const age = /ended (\S+) ago/.exec(reason)?.[1];
    assert.equal(age, "30h", reason);
    assert.equal(await p.eval(`${card}.querySelector('.work-age').textContent`), `${age} ago`);
    const next = `${card}.querySelector('.work-next')`;
    assert.doesNotMatch(await p.eval(`${next}.textContent`), /`/);
    assert.match(await p.eval(`${next}.querySelector('code').textContent`), /^coding\.sh show failed-3\S*$/);
  });
});
