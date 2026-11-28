// The Work page (#/work) in headless Chrome: the buckets in the CLI's order with links to
// the sessions, the hidden toggle and filters in the hash, j/k between items, an ack that
// takes the item off the page, the empty state, the phone layout, and no console errors.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FLAGS } from "../../src/core/sessions.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { mkSession } from "../cli/_cmd.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs } from "./fakes.ts";
import { workSessions } from "./_work.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const groups = "[...document.querySelectorAll('.work-group h2')].map((e) => e.firstChild.textContent)";

describe("Work page in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new MemoryIndexStore();
  let dir: string;
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "work-browser-"));
    for (const s of workSessions(Date.now())) await index.upsertSession(s);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(dir, "work.json"), home: dir, cwd: dir } });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string, mobile = false): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    if (mobile) await page.viewport(390, 844, true);
    else await page.viewport(1280, 900);
    await page.goto(v.url + hash);
    await page.waitFor("document.querySelector('.work-body > *')", "work body");
    return page;
  }

  test("lists the buckets in the CLI's order, each item linking to its sessions", async () => {
    const p = await open("#/work");
    assert.equal(await p.eval("document.querySelector('[data-nav=work]').getAttribute('aria-current')"), "page");
    assert.deepEqual(await p.eval(groups), ["Blocked on you", "Failed", "Stalled", "Your turn", "Ready for review"]);
    const blocked = "document.querySelector('.work-item[data-bucket=blocked]')";
    assert.equal(await p.eval(`${blocked}.querySelector('.work-title').getAttribute('href')`), "#/s/blocked");
    assert.match(await p.eval(`${blocked}.querySelector('.work-reason').textContent`), /\S/);
    const facts: string = await p.eval(`${blocked}.querySelector('.work-facts').textContent`);
    assert.match(facts, /\$1\.25/);
    assert.match(facts, /2 sessions/);
    assert.match(await p.eval(`${blocked}.querySelector('.work-next').textContent`), /^Next \S/);
    assert.deepEqual(await p.eval(`[...${blocked}.querySelectorAll('.work-sessions a')].map((a) => a.getAttribute('href'))`), ["#/s/blocked%3Asub%3Aa1"]);
    // The done session is hidden, and the page says so and why.
    assert.match(await p.eval("document.querySelector('.work-notes').textContent"), /1 hidden item: 1 done/);
    assert.equal(await p.eval("[...document.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.startsWith('Show hidden')).textContent"), "Show hidden (1)");
    assert.deepEqual(p.errors, []);
  });

  test("the hidden toggle and the filters live in the hash", async () => {
    const p = await open("#/work");
    await p.eval("[...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Show hidden')).click()");
    await p.waitFor(`location.hash === '#/work?all=1' && ${groups}.includes('Hidden')`, "hidden shown");
    assert.equal(await p.eval("document.querySelector('.work-item[data-bucket=hidden] .badge').textContent"), "done");
    await p.eval("(() => { const f = document.querySelector('.work-filters'); f.agent.value = 'codex'; f.requestSubmit(); })()");
    await p.waitFor(`location.hash === '#/work?agent=codex&all=1' && ${groups}.join() === 'Failed'`, "filtered to codex");
    await p.eval("[...document.querySelectorAll('.seg button')].find((b) => b.textContent === '30d').click()");
    await p.waitFor("location.hash === '#/work?agent=codex&since=30d&all=1'", "since in the hash");
    // A reload of that hash keeps the filters.
    const q = await open("#/work?repo=api");
    assert.deepEqual(await q.eval(groups), ["Failed", "Stalled"]);
    assert.equal(await q.eval("document.querySelector('.work-filters').repo.value"), "api");
    assert.deepEqual(q.errors, []);
  });

  test("an empty queue names the next step", async () => {
    const p = await open("#/work?agent=nobody");
    assert.equal(await p.eval("document.querySelector('.work-body h2').textContent"), "No work items match these filters");
    await p.eval("[...document.querySelectorAll('.work-body button')].find((b) => b.textContent === 'Clear the filters').click()");
    await p.waitFor("location.hash === '#/work' && document.querySelector('.work-item')", "filters cleared");
    assert.deepEqual(p.errors, []);
  });

  test("fits a phone with no sideways scroll, and the six tabs keep their whole names", async (t) => {
    const p = await open("#/work", true);
    assert.equal(await p.eval("document.documentElement.scrollWidth <= innerWidth"), true);
    // A sixth tab (Work) cut every name to an ellipsis ("W…") at 390px until the phone tabs
    // tightened, and then still at 341-437px in Arial. The steps are tuned to Arial's widths,
    // so the tabs are set in Arial here (Liberation Sans on Linux has the same widths): the
    // default font differs from machine to machine.
    const arial = `Arial, "Liberation Sans"`;
    const sessions: number = await p.eval(`(() => { const c = document.createElement('canvas').getContext('2d'); c.font = ${JSON.stringify(`12px ${arial}`)}; return c.measureText('Sessions').width; })()`);
    if (Math.abs(sessions - 48.69) > 0.1) {
      assert.ok(!process.env.GITHUB_ACTIONS, `"Sessions" is ${sessions}px wide in 12px Arial, not 48.69px: CI needs Arial or Liberation Sans`);
      t.skip("no Arial or Liberation Sans on this machine");
      return;
    }
    await p.eval(`document.querySelectorAll('.nav a').forEach((a) => a.style.fontFamily = ${JSON.stringify(arial)})`);
    // Phone widths, and both sides of each step in the top bar's CSS.
    for (const w of [320, 340, 341, 360, 367, 368, 375, 390, 393, 398, 399, 402, 412, 414, 430, 442, 443, 480, 640]) {
      await p.viewport(w, 844, true);
      const m = await p.eval("({ sw: document.documentElement.scrollWidth, cut: [...document.querySelectorAll('.nav a > span')].filter((s) => s.scrollWidth > s.clientWidth).map((s) => s.textContent) })");
      assert.ok(m.sw <= w, `at ${w}px the page is ${m.sw}px wide`);
      assert.deepEqual(m.cut, [], `at ${w}px no tab name ends in an ellipsis`);
    }
    assert.deepEqual(p.errors, []);
  });

  test("j and k move between items, and Ack takes an item off the page", async () => {
    const p = await open("#/work");
    await p.press("j");
    assert.equal(await p.eval("document.activeElement.closest('.work-item').dataset.bucket"), "blocked");
    await p.press("j");
    assert.equal(await p.eval("document.activeElement.closest('.work-item').dataset.bucket"), "failed");
    await p.press("k");
    assert.equal(await p.eval("document.activeElement.closest('.work-item').dataset.bucket"), "blocked");
    await p.eval("document.querySelector('.work-item[data-bucket=blocked] [data-act=ack]').click()");
    await p.waitFor("!document.querySelector('.work-item[data-bucket=blocked]')", "blocked item acknowledged");
    assert.match(await p.eval("document.querySelector('.work-notes').textContent"), /1 acknowledged/);
    assert.deepEqual(p.errors, []);
  });

  test("search q, kind filter, multi-duration snooze picker and batch-ack banners work in the UI", async () => {
    const idx = new MemoryIndexStore();
    const now = Date.now();
    const MIN = 60e3;
    const HOUR = 60 * MIN;
    const seeded = [
      mkSession("api-a", now - 20 * MIN, { endedAt: now - 15 * MIN, cwd: "/work/api", title: "retry gateway a", flags: [FLAGS.apiStall], stats: { llmErrors: { count: 3, statusCode: 529 } } as never }),
      mkSession("api-b", now - 21 * MIN, { endedAt: now - 16 * MIN, cwd: "/work/api", title: "retry gateway b", flags: [FLAGS.apiStall], stats: { llmErrors: { count: 3, statusCode: 529 } } as never }),
      mkSession("old-a", now - 16 * HOUR, { endedAt: undefined, cwd: "/work/old", title: "abandoned wait a", stats: { latency: { wallMs: MIN }, waiting: { kind: "permission", at: now - 15 * HOUR, toolUseId: "oa" } } as never }),
      mkSession("old-b", now - 17 * HOUR, { endedAt: undefined, cwd: "/work/old", title: "abandoned wait b", stats: { latency: { wallMs: MIN }, waiting: { kind: "permission", at: now - 16 * HOUR, toolUseId: "ob" } } as never }),
      mkSession("chg-1", now - 30 * MIN, { endedAt: now - 25 * MIN, cwd: "/work/web", title: "ship search filter", stats: { filesChanged: 2 } }),
    ];
    for (const s of seeded) await idx.upsertSession(s);
    const bdir = mkdtempSync(join(tmpdir(), "work-batch-browser-"));
    const srv = await startViewer({ index: idx, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(bdir, "work.json"), home: bdir, cwd: bdir } });
    const bp = await browser.newPage();
    try {
      await bp.viewport(1280, 900);
      await bp.goto(srv.url + "#/work");
      await bp.waitFor("document.querySelector('.work-banners')", "batch banners");
      assert.equal(await bp.eval("document.querySelector('[data-banner=group] [data-act=ack-batch]').textContent"), "Ack all 2");
      assert.equal(await bp.eval("document.querySelector('[data-banner=probably-closed] [data-act=ack-batch]').textContent"), "Ack all 2");

      // Kind filter syncs with URL hash.
      await bp.eval("[...document.querySelectorAll('.work-kind-seg button')].find((b) => b.textContent === 'Changes').click()");
      await bp.waitFor("location.hash === '#/work?kind=change' && document.querySelectorAll('.work-item').length === 1", "filtered to changes");

      // Search input q syncs with URL hash.
      await bp.eval("(() => { const f = document.querySelector('.work-filters'); f.q.value = 'ship search'; f.requestSubmit(); })()");
      await bp.waitFor("location.hash.includes('q=ship+search') && document.querySelectorAll('.work-item').length === 1", "filtered by q");

      // Snooze duration picker offers 30m, 1h, 4h, 1d and snoozes with chosen duration.
      assert.deepEqual(await bp.eval("[...document.querySelectorAll('.work-snooze-dur option')].map((o) => o.value)"), ["30m", "1h", "4h", "1d"]);
      await bp.eval("(() => { const s = document.querySelector('.work-snooze-dur'); s.value = '4h'; s.dispatchEvent(new Event('change')); document.querySelector('[data-act=snooze]').click(); })()");
      await bp.waitFor("!document.querySelector('.work-item')", "snoozed for 4h");

      // Reset filters and click both one-click Ack all banners.
      await bp.goto(srv.url + "#/work");
      await bp.waitFor("document.querySelector('[data-banner=group] [data-act=ack-batch]')", "group banner ready");
      await bp.eval("document.querySelector('[data-banner=group] [data-act=ack-batch]').click()");
      await bp.waitFor("!document.querySelector('[data-banner=group]')", "api 529 group acked");
      await bp.eval("document.querySelector('[data-banner=probably-closed] [data-act=ack-batch]').click()");
      await bp.waitFor("!document.querySelector('.work-item')", "probably closed cluster acked");
      assert.deepEqual(bp.errors, []);
    } finally {
      await bp.close();
      await srv.close();
      rmSync(bdir, { recursive: true, force: true });
    }
  });

  test("supervision risk and proof chips render on cards and detail page, and risk filter syncs with URL hash", async () => {
    const idx = new MemoryIndexStore();
    const now = Date.now();
    const MIN = 60e3;
    const seeded = [
      mkSession("run-high", now - 5 * MIN, {
        endedAt: undefined,
        cwd: "/work/lean",
        title: "prove main theorem",
        stats: {
          filesChanged: 2,
          latency: { wallMs: 4 * MIN },
          contextHygiene: { supervisionRisk: "high", riskReasons: ["unverified-edits", "tactic-oscillation"] },
          verification: {
            checks: 3,
            passed: 2,
            failed: 1,
            maxUnverifiedEdits: 4,
            proof: { langs: ["lean"], checks: 3, passed: 2, failed: 1, escapeRemaining: 2 },
          },
        } as never,
      }),
      mkSession("rev-med", now - 20 * MIN, {
        endedAt: now - 15 * MIN,
        cwd: "/work/lean",
        title: "prove helper lemma",
        stats: {
          filesChanged: 1,
          contextHygiene: { supervisionRisk: "medium", riskReasons: ["dead-end-loop"] },
          verification: {
            checks: 2,
            passed: 2,
            failed: 0,
            maxUnverifiedEdits: 1,
            proof: { langs: ["lean"], checks: 2, passed: 2, failed: 0 },
          },
        } as never,
      }),
      mkSession("plain-rev", now - 30 * MIN, {
        endedAt: now - 25 * MIN,
        cwd: "/work/web",
        title: "update readme",
        stats: { filesChanged: 1 },
      }),
    ];
    for (const s of seeded) await idx.upsertSession(s);
    const rdir = mkdtempSync(join(tmpdir(), "work-risk-browser-"));
    const srv = await startViewer({ index: idx, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(rdir, "work.json"), home: rdir, cwd: rdir } });
    const rp = await browser.newPage();
    try {
      await rp.viewport(1280, 900);
      await rp.goto(srv.url + "#/work");
      await rp.waitFor("document.querySelectorAll('.work-item').length === 2", "initial two active items");

      // rev-med shows Risk: medium and lean · verified; plain-rev shows neither.
      assert.equal(await rp.eval("document.querySelectorAll('.work-risk').length"), 1);
      assert.equal(await rp.eval("document.querySelector('.work-risk').textContent"), "Risk: medium");
      assert.equal(await rp.eval("document.querySelector('.work-risk').title"), "dead-end-loop");
      assert.equal(await rp.eval("document.querySelector('.work-proof').textContent"), "lean · verified");

      // Click High risk filter: syncs risk=high in hash, surfaces still-running run-high under Running (not Hidden),
      // and does not report the already-displayed running item as hidden.
      await rp.eval("[...document.querySelectorAll('.work-risk-seg button')].find((b) => b.textContent === 'High').click()");
      await rp.waitFor("location.hash === '#/work?risk=high' && document.querySelectorAll('.work-item').length === 1", "high risk filter");
      assert.deepEqual(await rp.eval("[...document.querySelectorAll('.work-group h2')].map((h) => h.textContent.trim())"), ["Running 1"]);
      assert.doesNotMatch(await rp.eval("document.querySelector('.work-notes').textContent"), /hidden item/i);
      assert.equal(await rp.eval("[...document.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.startsWith('Show hidden')).textContent"), "Show hidden");
      assert.equal(await rp.eval("document.querySelector('.work-risk').textContent"), "Risk: high");
      assert.equal(await rp.eval("document.querySelector('.work-risk').title"), "tactic-oscillation, unverified-edits");
      assert.equal(await rp.eval("document.querySelector('.work-proof').textContent"), "lean · 2 sorry");

      // Open detail page (#/w/<id>): shows risk and proof chips plus Risk and Proof rows.
      await rp.eval("document.querySelector('.work-id').click()");
      await rp.waitFor("document.querySelector('.work-page .work-kv')", "detail page");
      assert.equal(await rp.eval("document.querySelector('.work-page .work-risk').textContent"), "Risk: high");
      assert.equal(await rp.eval("document.querySelector('.work-page .work-proof').textContent"), "lean · 2 sorry");
      const kv: string = await rp.eval("document.querySelector('.work-page .work-kv').textContent");
      assert.match(kv, /Riskhigh \(tactic-oscillation, unverified-edits\)/);
      assert.match(kv, /Prooflean · 3 checks \(2 passed, 1 failed\), 2 escapes remaining/);

      // Click Medium+ on list: syncs risk=medium%2Chigh and shows both run-high and rev-med.
      await rp.goto(srv.url + "#/work");
      await rp.waitFor("document.querySelector('.work-risk-seg')", "risk selector");
      await rp.eval("[...document.querySelectorAll('.work-risk-seg button')].find((b) => b.textContent === 'Medium+').click()");
      await rp.waitFor("location.hash.includes('risk=medium') && document.querySelectorAll('.work-item').length === 2", "medium+ risk filter");
      assert.deepEqual(rp.errors, []);
    } finally {
      await rp.close();
      await srv.close();
      rmSync(rdir, { recursive: true, force: true });
    }
  });
});
