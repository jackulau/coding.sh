// Viewer fixes from hands-on QA (round 7) in headless Chrome: the find box's checkbox and the
// replay range have an id, a name and a label tied to them; the shortcuts sheet lists a go-to key
// for every tab; a changed file's row and its pane carry the same name; and on a phone the sticky
// header is opaque in both themes, so the step list does not show through it.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, FakeIndex, event, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const ID = "qa7-sess";
const STEPS = "document.querySelectorAll('#steps .st')";

describe("round 7 QA fixes in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    const index = new FakeIndex();
    await index.upsertSession(session(ID, { title: "Fix the parser" }));
    await index.putEvents([
      event(ID, 1, { kind: "user.message", payload: { text: "fix the parser" } }),
      event(ID, 2, { kind: "file.change", payload: { path: "/work/api/src/parse.ts", op: "edit", additions: 3, deletions: 1 } }),
      event(ID, 3, { kind: "file.change", payload: { path: "/work/api/src/new.ts", op: "add", additions: 9 } }),
      event(ID, 4, { kind: "assistant.message", payload: { text: "Done." } }),
    ]);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
  });

  async function open(hash: string, wait: string): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(1280, 900);
    await page.goto(v.url + hash);
    await page.waitFor(wait, "the page");
    return page;
  }

  test("the matching-steps checkbox and the replay range have an id, a name and a label", async () => {
    const p = await open("#/s/" + ID, `${STEPS}.length > 0`);
    const field = (id: string) => p.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)}); const l = document.querySelector('label[for=${id}]'); return el && [el.type, el.name, !!l, el.labels.length > 0]; })()`);
    assert.deepEqual(await field("find-only"), ["checkbox", "only", true, true]);
    assert.deepEqual(await field("rp-scrub"), ["range", "step", true, true]);
    assert.equal(await p.eval("document.querySelector('label[for=rp-scrub]').textContent"), "Step");
    assert.deepEqual(p.errors, []);
  });

  test("a changed file's row and its pane heading name it the same way", async () => {
    const p = await open("#/s/" + ID, `${STEPS}.length > 0`);
    for (const [path, verb] of [["parse.ts", "Changed"], ["new.ts", "Added"]] as const) {
      const i: number = await p.eval(`[...${STEPS}].findIndex((t) => t.textContent.includes(${JSON.stringify(path)}))`);
      assert.ok(i >= 0, `a row for ${path}`);
      assert.match(await p.eval(`${STEPS}[${i}].querySelector('.lbl').textContent`), new RegExp("^" + verb + "src/"));
      await p.eval(`${STEPS}[${i}].click()`);
      await p.waitFor(`document.querySelector('#event-pane .pane-title')?.textContent.includes(${JSON.stringify(path)})`, `the ${path} pane`);
      assert.equal(await p.eval("document.querySelector('#event-pane .pane-title .tool').textContent"), verb);
    }
    assert.deepEqual(p.errors, []);
  });

  test("the shortcuts sheet has a go-to key for every tab, Workflows and Review included", async () => {
    const p = await open("#/", "document.querySelector('.topbar')");
    await p.press("?");
    await p.waitFor("document.getElementById('keys-h')", "the shortcuts sheet");
    const rows: string[] = await p.eval("[...document.querySelectorAll('.k-row')].map((r) => r.firstChild.textContent)");
    const tabs: string[] = await p.eval("[...document.querySelectorAll('.nav a[data-nav]')].map((a) => a.dataset.nav)");
    assert.equal(tabs.length, 7);
    for (const want of ["Go to sessions", "Go to work", "Go to review queues", "Go to explore", "Go to experiments", "Go to benchmarks", "Go to workflow runs"]) assert.ok(rows.includes(want), `${want} in ${rows.join(", ")}`);
    await p.press("Escape");
    await p.press("g");
    await p.press("f");
    await p.waitFor("location.hash === '#/workflows'", "g f opens the workflow runs");
    await p.press("g");
    await p.press("r");
    await p.waitFor("location.hash === '#/review'", "g r opens the review queues");
    assert.deepEqual(p.errors, []);
  });

  test("on a phone the sticky header is opaque in light and in dark", async () => {
    const p = await open("#/s/" + ID, `${STEPS}.length > 0`);
    await p.viewport(390, 844, true);
    assert.equal(await p.eval("innerWidth"), 390);
    for (const scheme of ["light", "dark"]) {
      await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      const [bg, filter, body] = await p.eval("(() => { const s = getComputedStyle(document.querySelector('.topbar')); return [s.backgroundColor, s.backdropFilter, getComputedStyle(document.body).backgroundColor]; })()");
      assert.match(bg, /^rgb\(/, `${scheme}: an opaque background, not ${bg}`);
      assert.equal(filter, "none", scheme);
      assert.equal(bg, body, `${scheme}: the page's own background`);
    }
    await p.send("Emulation.setEmulatedMedia", { features: [] });
    assert.deepEqual(p.errors, []);
  });
});
