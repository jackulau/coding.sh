// Viewer fixes from hands-on QA (round 6), in headless Chrome: the command menu lists a session whose
// title holds the typed word even when newer sessions on a branch named for it (site/vercel) fill the
// metadata search, and a compaction step's phase chip gives way on a narrow row instead of pushing its
// title into the duration beside it.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, event, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const HOUR = 3600e3;
const TITLED = "T-hosting";
const COMPACT = "C-compact";

describe("viewer QA round 6 fixes in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    const now = Date.now();
    // The session titled with the word, older than ten sessions whose branch holds it.
    await index.upsertSession(session(TITLED, { startedAt: now - 48 * HOUR, endedAt: now - 47 * HOUR, title: "Move hosting to Vercel" }));
    await index.putEvents([event(TITLED, 1, { ts: now - 48 * HOUR + 1000, payload: { text: "move the site" } })]);
    for (let i = 0; i < 10; i++) {
      const id = `B-${i}`;
      await index.upsertSession(session(id, { startedAt: now - (i + 1) * HOUR, endedAt: now - (i + 1) * HOUR + 60_000, title: `build:step-${i}`, repo: { root: "/work/demo", branch: "site/vercel", head: "a41c9e2b00" } }));
      await index.putEvents([event(id, 1, { ts: now - (i + 1) * HOUR + 1000, payload: { text: "run the step" } })]);
    }
    // A compaction that starts a phase, with a duration, so its row has a chip and a time.
    const t = now - 60 * HOUR;
    await index.upsertSession(session(COMPACT, { startedAt: t, endedAt: t + 600_000, title: "Long session", stats: { events: 4, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents([
      event(COMPACT, 1, { ts: t + 1000, payload: { text: "keep going" } }),
      event(COMPACT, 2, { ts: t + 2000, kind: "assistant.message", payload: { text: "Working on it." } }),
      event(COMPACT, 3, { ts: t + 300_000, kind: "context.compact", durationMs: 108_000, payload: { trigger: "auto" } }),
      event(COMPACT, 4, { ts: t + 420_000, kind: "assistant.message", payload: { text: "Done." } }),
    ]);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
  });

  async function open(hash: string, width = 1280): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(width, 900);
    await page.goto(v.url + hash);
    return page;
  }

  test("the command menu lists a title match first, ahead of newer sessions that match on their branch", async () => {
    // Not the Sessions list, so the menu has only what the server finds.
    const p = await open("#/experiments");
    await p.waitFor("document.querySelector('#cmdk')", "the app");
    await p.eval("document.querySelector('#cmdk').click()");
    await p.waitFor("document.querySelector('.palette input')", "palette");
    await p.eval("(() => { const i = document.querySelector('.palette input'); i.value = 'Vercel'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    const sessions = "[...document.querySelectorAll('.palette-item')].map((o) => o.querySelector('.truncate').textContent).filter((t) => /^(build:|Move )/.test(t))";
    await p.waitFor(`${sessions}.length >= 8`, "sessions in the menu");
    const shown: string[] = await p.eval(sessions);
    assert.equal(shown[0], "Move hosting to Vercel", shown.join(" | "));
    assert.equal(shown.length, 8);
  });

  test("a compaction row's phase chip gives way, so its title keeps its gap from the duration", async () => {
    const p = await open(`#/s/${COMPACT}/${COMPACT}-e3`, 960);
    const row = "document.querySelector('#steps .st[aria-selected=true]')";
    await p.waitFor(`${row}?.querySelector('.phase-chip') && ${row}.textContent.includes('Context compacted')`, "the compaction row with its chip", 8000);
    const m = await p.eval(`(() => { const r = ${row}; const lbl = r.querySelector('.lbl').getBoundingClientRect(); const d = r.querySelector('.d');
      const right = Math.max(...[...r.querySelector('.lbl').children].map((x) => x.getBoundingClientRect().right));
      const gap = parseFloat(getComputedStyle(r).columnGap);
      return { right, lblRight: lbl.right, dLeft: d.getBoundingClientRect().left, dText: d.textContent, gap, overflow: getComputedStyle(r.querySelector('.lbl')).overflow }; })()`);
    assert.equal(m.dText, "1m 48s");
    assert.ok(m.right <= m.lblRight + 0.5, `the label's parts stay inside it: ${JSON.stringify(m)}`);
    assert.ok(m.dLeft - m.right >= m.gap - 0.5, `the full gap before the duration: ${JSON.stringify(m)}`);
    assert.equal(m.overflow, "hidden");
  });
});
