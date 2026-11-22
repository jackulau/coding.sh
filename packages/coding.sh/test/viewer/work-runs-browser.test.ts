// The Work page's workflow runs and the index's age in headless Chrome, against a stubbed
// /api/work and /api/ingest: a run item's phase strip and its agents grouped by phase with
// each phase's cost, a superseded failure that links the item that superseded it, the
// "index updated ... ago" line (a warning while the index is old) on #/work and in the
// session list's header, and nothing new from an older server that sends none of these
// fields. The session list also names a worktree session's repo by its main checkout.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { mkSession } from "../cli/_cmd.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

interface Stub {
  work?: unknown;
  ingest?: unknown;
}

/** Answers /api/work and /api/ingest when the stub has them; the rest goes to the server. */
function stub(o: Stub): string {
  return `(() => {
    const o = ${JSON.stringify(o)};
    const real = window.fetch.bind(window);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith("/api/work?") && o.work) return json(o.work);
      if (url === "/api/ingest" && o.ingest) { window.__ingest = (window.__ingest || 0) + 1; return json(o.ingest); }
      return real(input, init);
    };
  })()`;
}

const NOW = Date.UTC(2026, 9, 7, 12);
const now = new Date(NOW).toISOString();
const run = {
  id: "w0a0a0a", title: "run the round", sessionId: "lead:sub:b1", agent: "claude-code", sessions: 3, lastActivity: NOW - 600e3, bucket: "failed",
  reason: "1 of 3 agents failed", next: "open the failed agent", costUsd: 0.75,
  workflow: { id: "run-a", name: "round", phases: [{ name: "build", agents: 2, running: 0, failed: 1, done: 1, costUsd: 0.75 }, { name: "review", agents: 1, running: 1, failed: 0, done: 0 }] },
};
const failed = {
  id: "w1b1b1b", title: "deploy the site", sessionId: "failed", agent: "codex", sessions: 1, lastActivity: NOW - 1200e3, bucket: "failed",
  reason: "API errors; superseded by w2c2c2c, which started later on the same branch and ended with no failure", next: "nothing: a later run passed", supersededBy: "w2c2c2c",
};
const AGENTS = [
  { sessionId: "lead:sub:b1", phase: "build", label: "build:b1", agent: "claude-code", state: "done", costUsd: 0.5, sessions: 1 },
  { sessionId: "lead:sub:b2", phase: "build", label: "build:b2", agent: "claude-code", state: "failed", costUsd: 0.25, sessions: 1 },
  { sessionId: "lead:sub:v1", phase: "review", label: "review:v1", agent: "claude-code", state: "running", sessions: 1 },
];
const OLD = { updatedAt: new Date(NOW - 40 * 60e3).toISOString(), stale: true, text: "index updated 40m ago: waits and stalls are as of then; run coding.sh ingest" };
const FRESH = { updatedAt: new Date(NOW - 4 * 60e3).toISOString(), text: "index updated 4m ago" };

/** /api/work's answer: with `fresh` a newer server's fields (agents, sessionOf, index), else an older server's. */
function doc(o: { fresh: boolean; index?: unknown }): Record<string, unknown> {
  const strip = ({ workflow: _w, supersededBy: _s, ...rest }: Record<string, unknown>) => rest;
  const items = o.fresh ? [run, failed] : [strip(run), strip(failed)];
  const d: Record<string, unknown> = {
    now, counts: { blocked: 0, failed: 2, stalled: 0, turn: 0, review: 0 }, hidden: 1, hiddenBy: { done: 1 }, items,
    members: { [run.id]: ["lead:sub:b1", "lead:sub:b2", "lead:sub:v1"], [failed.id]: ["failed"] },
  };
  if (o.fresh) Object.assign(d, { workflowAgents: { [run.id]: AGENTS }, sessionOf: { w2c2c2c: "passed" } });
  if (o.index) d.index = o.index;
  return d;
}

describe("Work page runs and the index's age in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let dir: string;
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "work-runs-browser-"));
    const index = new MemoryIndexStore();
    const t = Date.now() - 3600e3;
    await index.upsertSession(mkSession("wt", t, { title: "fix in a worktree", cwd: "/work/demo/.claude/worktrees/agent-a1", repo: { root: "/work/demo/.claude/worktrees/agent-a1", main: "/work/demo", head: "" } as never }));
    await index.upsertSession(mkSession("plain", t - 60e3, { title: "fix in the checkout", cwd: "/work/api", repo: { root: "/work/api", head: "" } as never }));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any, work: { overlay: join(dir, "work.json"), home: dir, cwd: dir } });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await page?.close();
    await browser?.close();
    await v?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function open(hash: string, o: Stub, wait: string, width = 1280): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    if (width < 500) await page.viewport(width, 844, true);
    else await page.viewport(width, 900);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: stub(o) });
    await page.goto(v.url + hash);
    await page.waitFor(wait, "the page");
    return page;
  }

  test("a run shows its phases, its agents by phase with each phase's cost, and an old index is a warning", async () => {
    const p = await open("#/work", { work: doc({ fresh: true, index: OLD }) }, "document.querySelector('.work-item')");
    const strip = `document.querySelector('[data-item="${run.id}"] .work-phases')`;
    assert.deepEqual(await p.eval(`[...${strip}.querySelectorAll('.work-phase')].map((e) => [e.textContent, e.querySelector('.dot').className])`), [
      ["build: 1 failed, 1 done", "dot tone-fail"],
      ["review: 1 running", "dot tone-warn"],
    ]);
    assert.equal(await p.eval(`document.querySelectorAll('.work-phases').length`), 1, "only the run item has a strip");
    const details = `document.querySelector('[data-item="${run.id}"] .work-sessions')`;
    assert.equal(await p.eval(`${details}.querySelector('summary').textContent`), "3 agents by phase");
    assert.deepEqual(await p.eval(`[...${details}.querySelectorAll('.work-phase-group')].map((g) => [g.querySelector('.meta').textContent, [...g.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])])`), [
      ["build · $0.75", [["build:b1", "#/s/lead%3Asub%3Ab1"], ["build:b2", "#/s/lead%3Asub%3Ab2"]]],
      ["review", [["review:v1", "#/s/lead%3Asub%3Av1"]]],
    ]);
    const sup = `document.querySelector('[data-item="${failed.id}"] .work-superseded')`;
    assert.equal(await p.eval(`${sup}.textContent`), "Superseded by w2c2c2c");
    assert.equal(await p.eval(`${sup}.querySelector('a').getAttribute('href')`), "#/s/passed");
    // The old index's line, as `coding.sh work` prints it, in the warn style above the items; the counts line has no age.
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.index-age')].map((e) => [e.textContent, e.classList.contains('warn'), !!e.closest('.work-notes')])"), [[OLD.text, true, true]]);
    assert.equal(await p.eval("document.querySelector('#work-h + .meta').textContent"), "2 failed · since 7d");
    assert.deepEqual(p.errors, []);
  });

  test("a fresh index's age sits in the counts line; a superseding item it cannot link is named", async () => {
    const d = doc({ fresh: true, index: FRESH });
    delete d.sessionOf;
    const p = await open("#/work", { work: d }, "document.querySelector('.work-item')");
    assert.equal(await p.eval("document.querySelector('#work-h + .meta').textContent"), "2 failed · since 7d · index updated 4m ago");
    assert.equal(await p.eval("document.querySelector('.index-age').classList.contains('warn')"), false);
    assert.equal(await p.eval("document.querySelector('.work-superseded a')"), null);
    assert.equal(await p.eval("document.querySelector('.work-superseded').textContent"), "Superseded by w2c2c2c");
    assert.deepEqual(p.errors, []);
  });

  test("an older server's answer shows no strip, no superseded line and no age", async () => {
    const p = await open("#/work", { work: doc({ fresh: false }) }, "document.querySelector('.work-item')");
    assert.equal(await p.eval("document.querySelectorAll('.work-phases, .work-phase-group, .work-superseded, .index-age').length"), 0);
    assert.equal(await p.eval(`document.querySelector('[data-item="${run.id}"] .work-sessions summary').textContent`), "2 more sessions in this item");
    assert.equal(await p.eval("document.querySelector('.work-notes').textContent"), "1 hidden item: 1 done.");
    assert.deepEqual(p.errors, []);
  });

  test("on a phone the strip wraps inside the page", async () => {
    const p = await open("#/work", { work: doc({ fresh: true, index: OLD }) }, "document.querySelector('.work-item')", 390);
    assert.equal(await p.eval("window.innerWidth"), 390);
    assert.ok(await p.eval("document.documentElement.scrollWidth <= window.innerWidth"), "no sideways scroll");
    assert.ok(await p.eval("[...document.querySelectorAll('.work-phase, .index-age')].every((e) => e.getBoundingClientRect().right <= window.innerWidth)"));
    assert.deepEqual(p.errors, []);
  });

  test("the session list's header gives the index's age, and a worktree session's repo is its main checkout", async () => {
    const p = await open("#/", { ingest: { ingesting: false, filesPending: 0, lastIngestAt: null, index: { ...OLD, text: "index updated 40m ago; run coding.sh ingest" } } },
      "document.querySelector('.index-age.live:not([hidden])')");
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.index-age')].map((e) => [e.textContent, e.classList.contains('warn'), !!e.closest('.fact-line')])"), [["index updated 40m ago; run coding.sh ingest", true, true]]);
    await p.waitFor("document.querySelectorAll('.row .repo-cell').length === 2", "the rows");
    assert.deepEqual(await p.eval("[...document.querySelectorAll('.row .repo-cell')].map((c) => [c.textContent, c.title])"), [["demo", "/work/demo"], ["api", "/work/api"]]);
    assert.deepEqual(p.errors, []);
  });

  test("an older server's /api/ingest leaves the header as it was", async () => {
    const p = await open("#/", { ingest: { ingesting: false, filesPending: 0, lastIngestAt: null } }, "document.querySelectorAll('.row .repo-cell').length === 2");
    await p.waitFor("window.__ingest >= 1", "the ingest poll");
    await p.eval("new Promise((r) => setTimeout(r, 50))");
    assert.equal(await p.eval("[...document.querySelectorAll('.index-age')].every((e) => e.hidden && e.textContent === '')"), true);
    assert.deepEqual(p.errors, []);
  });
});
