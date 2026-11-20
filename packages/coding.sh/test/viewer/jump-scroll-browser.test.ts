// Viewer fixes from hands-on QA (round 4), seen in headless Chrome: a row moved to with j/k scrolls
// in below the sticky app bar and table head, and Jump to (Ctrl K) ranks title matches above
// sessions that match only in their events, opening those on the event that matched.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, event, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("viewer jump-to and list scroll in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;
  const HIT = "content-hit";

  before(async () => {
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      const id = "s-" + String(i).padStart(3, "0");
      const t = now - (i + 10) * 3_600_000;
      await index.upsertSession(session(id, { startedAt: t, endedAt: t + 60_000, title: i === 30 || i === 40 ? "Fix the zebrafinch login " + i : "Session " + i }));
      await index.putEvents([event(id, 1, { ts: t })]);
    }
    // The newest session matches only in one tool output, in its second step.
    const t = now - 3_600_000;
    await index.upsertSession(session(HIT, { startedAt: t, endedAt: t + 30_000, title: "fix:core-1", stats: { events: 6, turns: 1, toolCalls: 2, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents([
      event(HIT, 1, { ts: t, payload: { text: "fix the core" } }),
      event(HIT, 2, { ts: t + 1000, kind: "tool.start", payload: { tool: "Bash", toolUseId: "b1", input: { command: "npm test" } } }),
      event(HIT, 3, { ts: t + 2000, kind: "tool.end", payload: { tool: "Bash", toolUseId: "b1", ok: true, output: "the zebrafinch suite passed" } }),
      event(HIT, 4, { ts: t + 3000, kind: "tool.start", payload: { tool: "Edit", toolUseId: "b2", input: { file_path: "CHANGELOG.md", old_string: "a", new_string: "b" } } }),
      event(HIT, 5, { ts: t + 4000, kind: "tool.end", payload: { tool: "Edit", toolUseId: "b2", ok: true, output: "ok" } }),
      event(HIT, 6, { ts: t + 5000, kind: "assistant.message", payload: { text: "Done." } }),
    ]);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
  });

  async function open(hash: string, width = 1440, height = 900): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(width, height);
    await page.goto(v.url + hash);
    return page;
  }

  test("the row j and k move to stays below the sticky headers", async () => {
    const p = await open("#/");
    await p.waitFor("document.querySelectorAll('.session-table [role=option]').length >= 50", "rows");
    await p.eval("document.querySelector('.list[role=listbox]').focus()");
    for (let i = 0; i < 25; i++) await p.press("j");
    for (let i = 0; i < 20; i++) {
      await p.press("k");
      await pause(20);
      const r = await p.eval(`(() => {
        const el = document.querySelector('.session-table [role=option][aria-selected=true]').getBoundingClientRect();
        const head = document.querySelector('.session-table .thead').getBoundingClientRect();
        return { top: el.top, headBottom: head.bottom };
      })()`);
      assert.ok(r.top >= r.headBottom - 1, `after k ${i + 1}, the selected row (top ${r.top}) is under the table head (bottom ${r.headBottom})`);
    }
  });

  test("jump to lists title matches first and opens a content hit on its matching event", async () => {
    const p = await open("#/experiments");
    await p.waitFor("document.querySelector('#cmdk')", "menu button");
    await p.eval("document.querySelector('#cmdk').click()");
    await p.waitFor("document.querySelector('.palette input')", "palette");
    await p.eval("(() => { const i = document.querySelector('.palette input'); i.value = 'zebrafinch'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await p.waitFor("[...document.querySelectorAll('.palette-item')].some((o) => o.textContent.includes('fix:core-1'))", "the content hit");
    const labels: string[] = await p.eval("[...document.querySelectorAll('.palette-item .truncate')].map((o) => o.textContent)");
    const hitAt = labels.findIndex((l) => l.includes("fix:core-1"));
    const titled = labels.map((l, i) => [l, i] as const).filter(([l]) => /zebrafinch/.test(l)).map(([, i]) => i);
    assert.equal(titled.length, 2, "both title matches are listed: " + labels.join(" | "));
    assert.ok(titled.every((i) => i < hitAt), "title matches rank above the content-only hit: " + labels.join(" | "));
    await p.eval(`document.querySelectorAll('.palette-item')[${hitAt}].click()`);
    await p.waitFor(`location.hash.startsWith('#/s/${HIT}/')`, "the session opens on an event", 5000);
    const hash: string = await p.eval("location.hash");
    // The output that matched (e3), or the step it belongs to (its tool call, e2); not the default step.
    assert.match(decodeURIComponent(hash), new RegExp(`^#/s/${HIT}/${HIT}-e[23](\\?|$)`), "opens on the tool output that matched: " + hash);
    await p.waitFor("/npm test/.test(document.querySelector('#steps .st[aria-selected=true]')?.textContent ?? '')", "the matching Bash step is selected", 5000);
  });
});
