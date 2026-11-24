// Viewer fixes from hands-on QA (round 8) in headless Chrome: the session list's query bar stays
// where it is when a filter matches nothing; the Run tree's "Fix first" link names the subagent by
// its title; and the Workflows page's empty state says why runs the Work page shows are not listed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { WorkflowStore } from "../../src/workflows/store.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, session } from "./fakes.ts";

const chrome = findChrome();
// The browser is this machine's Chrome, and the page names the CLI for its platform (forShell in
// index.html): codingsh on Windows, coding.sh elsewhere.
const CLI = process.platform === "win32" ? "codingsh" : "coding\\.sh";
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const ROOT = "qa8v-root";
const SUB = `${ROOT}:sub:a7`;
const SUB_TITLE = "Dogfood lane A: SDKs (TypeScript and Python)";

describe("round 8 viewer QA fixes in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "qa8v-"));
    const index = new MemoryIndexStore();
    const t0 = Date.UTC(2026, 10, 7, 9);
    const usage = { inputTokens: 1_200_000, outputTokens: 90_000, costUsd: 12.3456 };
    await index.upsertSession(session(ROOT, { startedAt: t0, endedAt: t0 + 3_600_000, title: "Run the dogfood lanes", model: "claude-opus-4-1", stats: { events: 40, turns: 3, toolCalls: 30, toolErrors: 0, filesChanged: 2, usage } }));
    for (let i = 1; i <= 4; i++) {
      await index.upsertSession(session(`${ROOT}:sub:b${i}`, {
        startedAt: t0 + i * 1000, endedAt: t0 + i * 1000 + 60_000, title: `Lane ${i}`,
        parent: { sessionId: ROOT, type: "general-purpose" } as any, stats: { events: 5, turns: 1, toolCalls: 3, toolErrors: 0, filesChanged: 0, usage },
      }));
    }
    await index.upsertSession(session(SUB, {
      startedAt: t0 + 9000, endedAt: t0 + 99_000, title: SUB_TITLE,
      parent: { sessionId: ROOT, type: "subagent" } as any, flags: ["test-tamper"],
      stats: { events: 9, turns: 1, toolCalls: 7, toolErrors: 2, filesChanged: 1, usage },
    }));
    for (let i = 0; i < 12; i++) {
      await index.upsertSession(session(`qa8v-s${i}`, { startedAt: t0 - i * 60_000, endedAt: t0 - i * 60_000 + 30_000, title: `Add a parser test ${i}`, stats: { events: 4, turns: 1, toolCalls: 2, toolErrors: 0, filesChanged: 1, usage } }));
    }
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, workflows: new WorkflowStore(join(dir, "workflows")), updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string, wait: string, w = 1280, h = 900): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    await page.viewport(w, h);
    await page.goto(v.url + hash);
    await page.waitFor(wait, "the page");
    return page;
  }
  const where = (p: Page) => p.eval("(() => { const r = document.querySelector('.qbar input').getBoundingClientRect(); const t = document.querySelector('#sessions-h').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), below: r.top >= t.bottom }; })()");

  test("the query bar stays in place when the filter matches nothing", async () => {
    for (const w of [1280, 1600, 900]) {
      const p = await open("#/?where=" + encodeURIComponent("agent:claude-code"), "document.querySelector('.list .row')", w);
      const hit = await where(p);
      await p.goto(v.url + "#/?where=zzqqxxnotfound");
      await p.waitFor("document.querySelector('.panel.empty h2') && document.querySelector('.panel.empty h2').textContent === 'No sessions match'", "the empty state");
      const miss = await where(p);
      assert.ok(hit.below, `at ${w}px the bar sits under the heading with matches: ${JSON.stringify(hit)}`);
      assert.deepEqual(miss, hit, `at ${w}px the bar moved when nothing matched`);
      assert.deepEqual(p.errors, []);
    }
  });

  test("the Run tree's Fix first link names the subagent by its title and role", async () => {
    const p = await open("#/s/" + encodeURIComponent(ROOT), "document.querySelector('.detail-head details.run-tree > summary')");
    await p.eval("document.querySelector('.detail-head details.run-tree > summary').click()");
    await p.waitFor("document.querySelector('.rt-worst a')", "the Fix first link");
    const m = await p.eval("({ text: document.querySelector('.rt-worst').textContent, href: document.querySelector('.rt-worst a').getAttribute('href') })");
    assert.equal(m.text, `Fix first: ${SUB_TITLE} (subagent) — test-tamper`);
    assert.equal(m.href, "#/s/" + encodeURIComponent(SUB));
    assert.deepEqual(p.errors, []);
  });

  test("the Workflows empty state says the Work page's runs need workflows import", async () => {
    const p = await open("#/workflows", "document.querySelector('.panel.empty h2')");
    const m = await p.eval("({ text: document.querySelector('.panel.empty').textContent, work: !!document.querySelector('.panel.empty a[href=\"#/work\"]') })");
    assert.match(m.text, /No workflow runs yet/);
    assert.match(m.text, new RegExp(`The Work page groups a run's agents from their sessions alone\\. This page lists only the runs ${CLI} workflows import has added\\.`));
    assert.ok(m.work, "the empty state links to the Work page");
    assert.deepEqual(p.errors, []);
  });
});
