// How the viewer feels: no motion on keyboard actions, nothing that moves under the pointer,
// and no per-key work. Driven in headless Chrome against a real viewer server. Skipped when no Chrome is installed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { runBench } from "../../src/bench/run.ts";
import { cleanup as benchCleanup, day, project } from "../bench/helpers.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, FakeIndex, event, longSession, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");
const T0 = Date.now() - 3_600_000;

describe("viewer feel in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new FakeIndex();
  let v: Viewer;
  let browser: Browser;
  let page: Page;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const key = (k: string) => page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);

  before(async () => {
    for (let i = 0; i < 60; i++) {
      await index.upsertSession(session(`S-${i}`, { title: `Session number ${i}`, startedAt: T0 - i * 60_000, endedAt: T0 - i * 60_000 + 30_000 }));
    }
    await index.upsertSession(session("odd-1", { title: "مرحبا بالعالم!", model: "claude-opus-5-5-20261001-thinking-high-extended-preview-a", startedAt: T0 + 60_000 }));
    await index.upsertSession(session("odd-2", { title: "Same model prefix", model: "claude-opus-5-5-20261001-thinking-high-extended-preview-b", startedAt: T0 + 61_000 }));
    await index.upsertSession(session("paths-1", { title: "Long file names", startedAt: T0 - 8_000_000 }));
    await index.putEvents([
      { ...event("paths-1", 1), kind: "tool.start", ts: T0 - 8_000_000, payload: { tool: "Read", toolUseId: "p1", input: { file_path: "/work/api/src/" + "a".repeat(120) + ".ts" } } },
      { ...event("paths-1", 2), kind: "tool.end", ts: T0 - 7_999_000, payload: { tool: "Read", toolUseId: "p1", ok: true, output: "x" } },
    ]);
    await index.upsertSession(session("long-1", { title: "Long session", startedAt: T0 - 9_000_000, stats: { events: 600, turns: 10, toolCalls: 200, toolErrors: 1, filesChanged: 0 } }));
    await index.putEvents(longSession(600, 10));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await browser?.close();
    await v?.close();
  });
  async function open(hash = "#/", w = 1280, h = 800) {
    page = await browser.newPage();
    // A runner whose system setting is "reduce motion" (Windows Server, hosted macOS) would turn every motion rule off.
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await page.viewport(w, h);
    await page.goto(v.url);
    await page.waitFor("document.querySelector('[role=listbox]')", "sessions list");
    if (hash !== "#/") {
      await page.eval(`location.hash = ${JSON.stringify(hash)}`);
      await page.waitFor("document.querySelector('#steps .st')", "steps");
    }
  }

  test("keyboard selection has no transition on rows", async () => {
    await open();
    try {
      const t = await page.eval("[...document.querySelectorAll('.row')].map((r) => getComputedStyle(r).transitionDuration)");
      assert.ok(t.length > 10);
      assert.ok(t.every((d: string) => d === "0s"), `row transitions: ${[...new Set(t)]}`);
      await key("j");
      await key("j");
      assert.equal(await page.eval("document.querySelectorAll('.row[aria-selected=true]').length"), 1);
    } finally {
      await page.close();
    }
  });

  test("the query suggestions appear at once and do not replay an entrance per keystroke", async () => {
    await open();
    try {
      const type = (q: string) => page.eval(`(() => { const i = document.getElementById('q'); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`);
      await type("agent:");
      await page.waitFor("document.querySelector('.qbar-pop')", "suggestions");
      await page.eval("window.__runs = 0; document.addEventListener('transitionrun', (e) => { if (e.target.classList?.contains('qbar-pop')) window.__runs++; }, true)");
      await type("agent:c");
      await sleep(400);
      await type("agent:cl");
      await sleep(400);
      assert.equal(await page.eval("window.__runs"), 0);
      assert.equal(await page.eval("getComputedStyle(document.querySelector('.qbar-pop')).transitionDuration"), "0s");
    } finally {
      await page.close();
    }
  });

  test("pressing the new-events pill shrinks it in place", async () => {
    await open("#/s/long-1");
    try {
      await page.eval("(() => { const p = document.querySelector('.tl-tail'); p.hidden = false; p.querySelector('.txt').textContent = '3 new events'; })()");
      const center = () => page.eval("(() => { const r = document.querySelector('.tl-tail').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.left]; })()");
      const [cx, cy, left0] = await center();
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: left0 + 4, y: cy });
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: left0 + 4, y: cy, button: "left", clickCount: 1 });
      await sleep(300);
      const [px, py] = await center();
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: left0 + 4, y: cy, button: "left", clickCount: 1 });
      assert.ok(Math.abs(px - cx) < 1 && Math.abs(py - cy) < 1, `pill moved from ${cx},${cy} to ${px},${py}`);
    } finally {
      await page.close();
    }
  });

  test("the new-sessions pill does not move a row, and a re-render does not replay its entrance", async () => {
    await open();
    try {
      const rowTop = () => page.eval("document.querySelectorAll('.row')[3].getBoundingClientRect().top");
      const before = await rowTop();
      await index.upsertSession(session("NEW-1", { title: "brand new", startedAt: Date.now(), endedAt: Date.now() }));
      await page.waitFor("!document.querySelector('.live-pill').hidden", "the new-sessions pill", 9000);
      await sleep(300);
      assert.equal(await rowTop(), before);
      await page.eval("window.__runs = 0; document.addEventListener('transitionrun', (e) => { if (e.target.classList?.contains('live-pill')) window.__runs++; }, true)");
      await page.eval("document.querySelector('[data-filter] .chip').click()");
      await sleep(600);
      assert.equal(await page.eval("window.__runs"), 0);
    } finally {
      await page.close();
      index.sessions.delete("NEW-1");
    }
  });

  test("a j or k key flips two rows, not every row", async () => {
    await open();
    try {
      await key("j");
      await page.eval("window.__w = 0; new MutationObserver((r) => { window.__w += r.filter((x) => x.attributeName === 'aria-selected').length; }).observe(document.querySelector('[role=listbox]'), { attributes: true, subtree: true })");
      await key("j");
      await sleep(50);
      assert.equal(await page.eval("window.__w"), 2);
      assert.equal(await page.eval("document.querySelectorAll('.row[aria-selected=true]').length"), 1);
      await key("k");
      await sleep(50);
      assert.equal(await page.eval("window.__w"), 4);
      assert.match(await page.eval("document.querySelector('[role=listbox]').getAttribute('aria-activedescendant')"), /^opt-/);
    } finally {
      await page.close();
    }
  });

  test("holding j in a session paints the pane and calls replaceState at most once per 80 ms", async () => {
    await open("#/s/long-1");
    try {
      await page.eval("document.getElementById('steps').focus(); window.__rs = 0; const o = history.replaceState.bind(history); history.replaceState = (...a) => { window.__rs++; return o(...a); };");
      const t0 = Date.now();
      for (let i = 0; i < 40; i++) {
        await key("j");
        await sleep(8);
      }
      const ms = Date.now() - t0;
      await sleep(250);
      const calls = await page.eval("window.__rs");
      assert.ok(calls >= 2 && calls <= Math.ceil(ms / 80) + 2, `${calls} replaceState calls in ${ms} ms`);
      // The trailing paint lands on the last row.
      const sel = await page.eval("document.querySelector('#steps .st[aria-selected=true]').id.replace('st-', '')");
      assert.ok(Number(sel) >= 30, `selected row ${sel}`);
      assert.match(await page.eval("location.hash"), /#\/s\/long-1\/e\d+/);
    } finally {
      await page.close();
    }
  });

  test("the ‹ › step buttons are not rebuilt on each step", async () => {
    await open("#/s/long-1");
    try {
      await page.eval("document.getElementById('steps').focus(); window.__nb = [...document.querySelectorAll('.fail-nav button')];");
      assert.ok((await page.eval("window.__nb.length")) >= 4);
      await key("j");
      await key("j");
      await sleep(150);
      assert.equal(await page.eval("window.__nb.every((b) => b.isConnected)"), true);
    } finally {
      await page.close();
    }
  });

  test("the Raw toggle keeps the pane's scroll position; a new step starts at the top", async () => {
    await open("#/s/long-1", 1280, 360);
    try {
      await page.eval("document.getElementById('steps').focus()");
      await key("j");
      await sleep(120);
      await page.eval("document.querySelector('.pane').scrollTop = 40");
      await key("r");
      await page.waitFor("document.querySelector('.pane .json')", "raw JSON");
      const top = await page.eval("document.querySelector('.pane').scrollTop");
      const max = await page.eval("document.querySelector('.pane').scrollHeight - document.querySelector('.pane').clientHeight");
      assert.equal(top, Math.min(40, max), `scrollTop ${top} of ${max}`);
      await key("j");
      await sleep(150);
      assert.equal(await page.eval("document.querySelector('.pane').scrollTop"), 0);
    } finally {
      await page.close();
    }
  });

  test("nothing moves while idle, and the focus ring on / and the caret rotations have no dead transitions", async () => {
    await open();
    try {
      // Idle is after the first paint's colour transitions (150 ms at most) have ended; a loop would still be running.
      await sleep(500);
      assert.deepEqual(await page.eval("document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.animationName || a.transitionProperty)"), []);
      assert.equal(await page.eval("getComputedStyle(document.getElementById('q')).transitionDuration"), "0s");
      assert.equal(await page.eval("getComputedStyle(document.querySelector('.facet-head .caret')).transitionDuration"), "0s");
      // The loading bar sweeps only while it is showing.
      await page.eval("document.querySelector('.loading-bar').classList.add('on')");
      assert.ok((await page.eval("document.getAnimations().filter((a) => a.animationName === 'sweep' && a.playState === 'running').length")) >= 1);
    } finally {
      await page.close();
    }
  });

  test("a press scales within 0.95 to 0.98; with reduced motion it dims instead", async () => {
    await open();
    try {
      const press = async (sel: string) => {
        const [x, y] = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await sleep(300);
        const css = await page.eval(`(() => { const c = getComputedStyle(document.querySelector(${JSON.stringify(sel)})); return [c.transform, c.opacity]; })()`);
        await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 600 });
        await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        return css as [string, string];
      };
      const [m] = await press("#help");
      const scale = Number(/matrix\(([\d.]+)/.exec(m)?.[1]);
      assert.ok(scale >= 0.95 && scale <= 0.98, `icon button pressed scale ${scale}`);
      await page.close();
      await open();
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      const [m2, o2] = await press("#help");
      assert.equal(m2, "none");
      assert.equal(Number(o2), 0.8);
    } finally {
      await page.close();
    }
  });

  test("relative times carry a timestamp and are rewritten by refreshTimes", async () => {
    await open();
    try {
      assert.ok((await page.eval("document.querySelectorAll('.row [data-ts]').length")) >= 10);
      await page.eval("document.querySelector('.row [data-ts]').textContent = 'stale'");
      await page.eval("refreshTimes()");
      assert.match(await page.eval("document.querySelector('.row [data-ts]').textContent"), /ago|just now/);
    } finally {
      await page.close();
    }
  });

  test("long values: a title takes its own direction, model ids keep their last characters, a long file name ends in an ellipsis", async () => {
    await open();
    try {
      const dirs = await page.eval("Object.fromEntries([...document.querySelectorAll('.row-title')].map((e) => [e.textContent, getComputedStyle(e).direction]))");
      assert.equal(dirs["مرحبا بالعالم!"], "rtl");
      assert.equal(dirs["Same model prefix"], "ltr");
      const models: string[] = await page.eval("[...document.querySelectorAll('.agent-cell .sub')].map((e) => e.textContent.trim()).filter((t) => t.includes('…'))");
      assert.equal(models.length, 2);
      assert.notEqual(models[0], models[1]);
      await page.eval("location.hash = '#/s/paths-1'");
      await page.waitFor("document.querySelector('#steps .st .pbase')", "path step");
      const r = await page.eval("(() => { const b = document.querySelector('#steps .st .pbase'); const p = b.parentElement.getBoundingClientRect(); const r = b.getBoundingClientRect(); return { overflow: getComputedStyle(b).textOverflow, inside: r.right <= p.right + 0.5, clipped: b.scrollWidth > b.clientWidth }; })()");
      assert.deepEqual(r, { overflow: "ellipsis", inside: true, clipped: true });
    } finally {
      await page.close();
    }
  });

  test("at 390px the filter sheet opens and closes with the same slide, and has no grab handle", async () => {
    await open("#/", 390, 844);
    try {
      await page.viewport(390, 844, true);
      const groups = "document.querySelector('.facet-groups')";
      const visible = `(() => { const g = ${groups}; const r = g.getBoundingClientRect(); return getComputedStyle(g).position === 'fixed' && r.height > 0 && r.top < innerHeight; })()`;
      await page.eval("document.querySelector('.facets-toggle').click()");
      await page.waitFor(`document.querySelector('.facets').dataset.open === 'true'`, "sheet open");
      await sleep(400);
      assert.equal(await page.eval(visible), true);
      assert.equal(await page.eval("getComputedStyle(document.querySelector('.sheet-head'), '::before').content"), "none", "no grab handle");
      await page.eval("document.querySelector('.sheet-head .btn').click()");
      assert.equal(await page.eval("document.querySelector('.facets-toggle').getAttribute('aria-expanded')"), "false");
      // Mid-slide the sheet is still on screen and moving down; it is hidden once the slide ends.
      await sleep(60);
      assert.equal(await page.eval(`document.querySelector('.facets').dataset.open`), "true");
      assert.ok((await page.eval(`document.getAnimations().filter((a) => a.animationName === 'sheet-out').length`)) >= 1);
      await page.waitFor(`document.querySelector('.facets').dataset.open === 'false' && !document.querySelector('.facets').classList.contains('closing')`, "sheet closed", 1500);
      assert.equal(await page.eval("document.querySelector('.facets-toggle').getAttribute('aria-expanded')"), "false");
    } finally {
      await page.close();
    }
  });
});


describe("viewer feel: the benchmark table", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let v: Viewer;
  let browser: Browser;
  before(async () => {
    const p = project();
    for (const d of ["2026-11-04", "2026-11-05"]) await runBench({ def: p.def('reference = "bad"'), env: p.env, now: day(d) });
    v = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: 0, env: p.env, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await browser?.close();
    await v?.close();
    benchCleanup();
  });

  test("a long cost source ends in an ellipsis and the cost stays inside its column", async () => {
    const page = await browser.newPage();
    try {
      await page.viewport(1120, 900);
      await page.goto(v.url);
      await page.waitFor("document.querySelector('main').children.length", "first view");
      await page.eval("location.hash = '#/benchmarks/arith'");
      await page.waitFor("document.querySelector('.bench-row')", "rows");
      const out = await page.eval(`(() => {
        const bad = [];
        for (const cell of document.querySelectorAll('.bench-row .stack-num')) {
          const box = cell.getBoundingClientRect();
          for (const el of cell.children) {
            const r = el.getBoundingClientRect();
            if (r.left < box.left - 0.5 || r.right > box.right + 0.5) bad.push(el.textContent);
          }
        }
        return { cells: document.querySelectorAll('.bench-row .stack-num').length, bad };
      })()`);
      assert.ok(out.cells >= 4, "stacked cells: " + out.cells);
      assert.deepEqual(out.bad, []);
    } finally {
      await page.close();
    }
  });

  for (const w of [1101, 1120, 1140]) {
    test(`at ${w}px every column of the table with an anchor column fits its row`, async () => {
      const page = await browser.newPage();
      try {
        await page.viewport(w, 900);
        await page.goto(v.url);
        await page.waitFor("document.querySelector('main').children.length", "first view");
        await page.eval("location.hash = '#/benchmarks/arith'");
        await page.waitFor("document.querySelector('.bench-row')", "rows");
        // The fixture has no anchor set; the anchor template is the one with nine columns.
        await page.eval("document.querySelector('.bench-board').classList.remove('no-anchor')");
        const fit = await page.eval(`(() => {
          const row = document.querySelector('.bench-row');
          const cs = getComputedStyle(row);
          const tracks = cs.gridTemplateColumns.split(' ').map(parseFloat);
          const gaps = (tracks.length - 1) * parseFloat(cs.columnGap);
          const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
          return { tracks: tracks.length, total: tracks.reduce((a, b) => a + b, 0) + gaps + pad, width: row.clientWidth };
        })()`);
        assert.equal(fit.tracks, 9);
        assert.ok(fit.total <= fit.width + 0.5, `columns need ${Math.round(fit.total)}px of ${fit.width}px`);
      } finally {
        await page.close();
      }
    });
  }
});
