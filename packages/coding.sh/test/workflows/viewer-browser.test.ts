// The workflow pages in headless Chrome (docs/design/workflows.md §8): the run list, one run as a
// timeline (a bar per agent under its phase, the critical path outlined, barrier idle shaded,
// bars linking to the agent's session, the concurrency strip with the cap line), the per-phase
// and metrics tables, and the phone layout as a table with no horizontal scroll.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "../viewer/browser.ts";
import { FakeBlobs, FakeIndex } from "../viewer/fakes.ts";
import { ganttRunFixture } from "./_fixtures.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

describe("workflow pages in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let root = "";
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "csh-wf-browser-"));
    const store = new WorkflowStore(join(root, "workflows"));
    const fx = ganttRunFixture();
    await store.putRun(fx.run, fx.nodes);
    v = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: 0, workflows: store, env: { HOME: root, CODING_SH_HOME: join(root, ".coding.sh") }, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function open(hash: string, ready: string, mobile = false): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    if (mobile) await page.viewport(390, 844, true);
    else await page.viewport(1280, 900);
    await page.goto(v.url + hash);
    await page.waitFor(ready, hash);
    return page;
  }

  test("the list links each run to its timeline", async () => {
    const p = await open("#/workflows", "document.querySelector('.wfg-list tbody tr')");
    assert.equal(await p.eval("document.querySelectorAll('.wfg-list tbody tr').length"), 1);
    assert.equal(await p.eval("document.querySelector('.wfg-list tbody a').getAttribute('href')"), "#/workflows/wf_view01");
    assert.deepEqual(p.errors, []);
  });

  test("a run: bars by phase, critical path, barrier idle, session links, strip and tables", async () => {
    const p = await open("#/workflows/wf_view01", "document.querySelector('.wfg-bar')");
    assert.equal(await p.eval("document.querySelector('#wfg-h').textContent"), "review");
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.wfg-phase > span:first-child')].map((e) => e.textContent)"), ["Find", "Verify"]);
    assert.equal(await p.eval("document.querySelectorAll('.wfg-lanes .wf-track .wfg-bar').length"), 4);
    assert.equal(await p.eval("document.querySelectorAll('.wfg-lanes .wfg-bar.s-failed').length"), 1);
    // find-b is the slow member of the barrier: on the critical path; find-a waited 20 s after it ended.
    assert.match(await p.eval("document.querySelector('.wfg-bar.critical').getAttribute('aria-label')"), /^find-b · ok · 30s · \$[0-9.]+ · on the critical path/);
    assert.equal(await p.eval("document.querySelectorAll('.wfg-lanes .wfg-idle').length"), 1);
    const idleLeft: number = await p.eval("parseFloat(document.querySelector('.wfg-lanes .wfg-idle').style.left)");
    assert.ok(Math.abs(idleLeft - (10 / 60) * 100) < 0.01, `idle starts when find-a ends: ${idleLeft}`);
    assert.equal(await p.eval("document.querySelector('a.wfg-bar').getAttribute('href')"), "#/s/child-a1");
    // The concurrency strip draws the cap line.
    assert.equal(await p.eval("document.querySelectorAll('.wfg-conc line.cap').length"), 1);
    assert.match(await p.eval("document.querySelector('.wfg-conc svg').getAttribute('aria-label')"), /Peak 2 agents at once against a cap of 4/);
    // Side panel: per-phase table and the §4 metrics.
    assert.equal(await p.eval("document.querySelectorAll('.wfg-side .mx-table tbody tr').length"), 2);
    // The phase table fits the side panel without scrolling.
    assert.equal(await p.eval("(() => { const w = document.querySelector('.wfg-side .mx-table-wrap'); return w.scrollWidth <= w.clientWidth + 1; })()"), true);
    const metrics: string[] = await p.eval("[...document.querySelectorAll('.wfg-kv th')].map((t) => t.textContent)");
    for (const m of ["Wall", "Critical path", "Barrier idle", "Peak concurrency", "Cost"]) assert.ok(metrics.includes(m), m);
    // The Table toggle shows the same rows as text.
    await p.eval("document.querySelector('.seg button[data-mode=table]').click()");
    assert.equal(await p.eval("document.querySelectorAll('.wfg-main .mx-table tbody tr').length"), 4);
    assert.deepEqual(p.errors, []);
  });

  test("on a phone the run opens as a table and the page does not scroll sideways", async () => {
    const p = await open("#/workflows/wf_view01", "document.querySelector('.wfg-main .mx-table')", true);
    assert.equal(await p.eval("document.querySelector('.seg button[data-mode=table]').getAttribute('aria-pressed')"), "true");
    assert.equal(await p.eval("document.documentElement.scrollWidth <= window.innerWidth + 1"), true);
    // The facts wrap inside the panel instead of running past its edge.
    assert.equal(await p.eval("(() => { const f = document.querySelector('.wfg-facts'), m = document.querySelector('.wfg-main'); return f.getBoundingClientRect().right <= m.getBoundingClientRect().right + 1; })()"), true);
    assert.deepEqual(p.errors, []);
  });

  test("an unknown run says so and names the command that lists runs", async () => {
    const p = await open("#/workflows/nope", "document.querySelector('.panel.empty')");
    assert.match(await p.eval("document.querySelector('.panel.empty').textContent"), /No such workflow run.*coding\.sh workflows list/s);
  });
});
