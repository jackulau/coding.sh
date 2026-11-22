// The Work page names an item's pull requests (WorkItem.prs), each as a link to its page on the
// host. The store holds a session that opened a PR and its subagent that merged it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { PR12, prSessions } from "../core/_prs.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

describe("Work page pull requests in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let dir: string;
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "work-prs-browser-"));
    const { opener, merger } = prSessions(Date.now() - 3600e3, true);
    for (const s of [opener, merger]) await index.upsertSession(s);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(dir, "work.json"), home: dir, cwd: dir } });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("an item's PR is a link to its URL with its last state", async () => {
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.goto(v.url + "#/work?all=1");
    await page.waitFor("document.querySelector('.work-pr')", "the item's PR");
    const pr = await page.eval("(() => { const a = document.querySelector('.work-pr'); return { tag: a.tagName, href: a.getAttribute('href'), text: a.textContent, rel: a.getAttribute('rel'), n: document.querySelectorAll('.work-pr').length }; })()");
    assert.deepEqual(pr, { tag: "A", href: PR12, text: "#12 merged", rel: "noopener noreferrer", n: 1 });
    assert.match(await page.eval("document.querySelector('.work-prs').textContent"), /^PR #12 merged$/);
    assert.deepEqual(page.errors, []);
  });
});
