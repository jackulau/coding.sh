// Viewer fixes from hands-on QA (round 9) on big sessions and small screens, in headless Chrome: a
// link to another step of the session on screen moves there on the events the page loaded, with no
// new download of them; the header's tool errors and tests badges and the step bar's failed steps
// each say what they count, on a session where the counts differ.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const SID = "qa9t-steps";
const OTHER = "qa9t-other";
const t0 = Date.UTC(2026, 10, 21, 9);
/** The session opens on its first failure (the npm test call); the link goes to the failed Read. */
const FIRST_FAIL = `${SID}-1`;
const LINKED = `${SID}-6`;

function maker(sessionId: string) {
  const base = { v: 0, sessionId, agent: "claude-code", cwd: "/work/demo" } as const;
  let n = 0;
  return (kind: AgentEvent["kind"], payload: Record<string, unknown>, dt: number): AgentEvent => ({ ...base, id: `${sessionId}-${n++}`, ts: t0 + dt, kind, payload });
}

/** Two real tool failures, a benign one (no match), an interrupted call and a failing test run, then quiet reads. */
function events(): AgentEvent[] {
  const ev = maker(SID);
  const out = [
    ev("user.message", { text: "Run the tests and fix what fails" }, 0),
    ev("tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }, 1000),
    ev("tool.end", { tool: "Bash", toolUseId: "t1", ok: false, error: "exit code 1" }, 4000),
    ev("test.result", { runner: "node", passed: 3, failed: 1 }, 4100),
    ev("tool.start", { tool: "Grep", toolUseId: "t2", input: { pattern: "parseConfig", path: "src" } }, 5000),
    ev("tool.end", { tool: "Grep", toolUseId: "t2", ok: false, error: "No matches found" }, 5100),
    ev("tool.start", { tool: "Read", toolUseId: "t3", input: { file_path: "/work/demo/src/config.ts" } }, 6000),
    ev("tool.end", { tool: "Read", toolUseId: "t3", ok: false, error: "ENOENT: no such file or directory" }, 6100),
    ev("tool.start", { tool: "Bash", toolUseId: "t4", input: { command: "npm run dev" } }, 7000),
    ev("tool.end", { tool: "Bash", toolUseId: "t4", ok: false, error: "[Request interrupted by user]" }, 9000),
  ];
  for (let i = 0; i < 10; i++) {
    out.push(ev("tool.start", { tool: "Read", toolUseId: `r${i}`, input: { file_path: `/work/demo/src/part${i}.ts` } }, 10_000 + i * 1000));
    out.push(ev("tool.end", { tool: "Read", toolUseId: `r${i}`, ok: true, output: `export const part${i} = ${i};` }, 10_100 + i * 1000));
  }
  out.push(ev("assistant.message", { text: "The failing test reads a config file that is not there." }, 21_000));
  return out;
}

function otherEvents(): AgentEvent[] {
  const ev = maker(OTHER);
  return [
    ev("user.message", { text: "List the files" }, 0),
    ev("tool.start", { tool: "Bash", toolUseId: "o1", input: { command: "ls" } }, 1000),
    ev("tool.end", { tool: "Bash", toolUseId: "o1", ok: true, output: "src" }, 1100),
    ev("assistant.message", { text: "One folder: src." }, 2000),
  ];
}

/** The page's finished requests for a session's events since the last clear (Resource Timing lists each one as it ends). */
const eventRequests = (p: Page, id: string): Promise<number> =>
  p.eval(`performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname === '/api/sessions/${id}/events').length`);
/** Long enough for a request a hash change started to finish and be listed. */
const settle = () => new Promise((r) => setTimeout(r, 400));
const paneItem = (id: string) => `document.querySelector('#event-pane')?.dataset.item === '${id}'`;

describe("round 9 viewer QA fixes on big sessions and small screens, in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  let v: Viewer;
  let browser: Browser;
  let page: Page | undefined;

  before(async () => {
    const index = new MemoryIndexStore();
    const all = events();
    await index.upsertSession(session(SID, {
      startedAt: t0,
      endedAt: t0 + 21_000,
      title: "Run the tests and fix what fails",
      repo: { root: "/work/demo", head: "a41c9e2b00" },
      stats: { events: all.length, turns: 1, toolCalls: 14, toolErrors: 2, benignToolErrors: 1, interruptedToolCalls: 1, filesChanged: 0, testsPassed: 3, testsFailed: 1 },
    }));
    await index.putEvents(all);
    await index.upsertSession(session(OTHER, { startedAt: t0 - 3600e3, endedAt: t0 - 3600e3 + 2000, title: "List the files", repo: { root: "/work/demo", head: "a41c9e2b00" }, stats: { events: 4, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents(otherEvents());
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

  test("a link to another step of the open session moves there on the events it loaded; another session's link loads that one", async () => {
    const p = await open("#/s/" + SID, paneItem(FIRST_FAIL));
    await p.eval("performance.setResourceTimingBufferSize(1000), performance.clearResourceTimings()");
    // A pasted step link (or the run tree's link here, or back and forward): a hash change within the session on screen.
    await p.eval(`location.hash = '#/s/${SID}/${LINKED}'`);
    await p.waitFor(`${paneItem(LINKED)} && document.querySelector('.st[aria-selected="true"]')?.textContent.includes('config.ts')`, "the linked step, selected");
    await settle();
    assert.equal(await eventRequests(p, SID), 0, "the session's events are not downloaded again");
    // A link with no step lands where opening the session does: its first failure.
    await p.eval(`location.hash = '#/s/${SID}'`);
    await p.waitFor(paneItem(FIRST_FAIL), "the first failure");
    // ?step opens the replay in place, and a step link leaves it.
    await p.eval(`location.hash = '#/s/${SID}?step=2'`);
    await p.waitFor("document.querySelector('.rp-bar') && !document.querySelector('.rp-bar').hidden", "the replay at step 2");
    await p.eval(`location.hash = '#/s/${SID}/${LINKED}'`);
    await p.waitFor(`document.querySelector('.rp-bar').hidden && ${paneItem(LINKED)}`, "out of the replay, on the linked step");
    await settle();
    assert.equal(await eventRequests(p, SID), 0, "nor after the replay and back");
    // Another session's link opens that session, with its own events.
    await p.eval(`location.hash = '#/s/${OTHER}'`);
    await p.waitFor("document.querySelector('h1')?.textContent === 'List the files' && document.querySelectorAll('.st').length >= 3", "the other session");
    assert.ok((await eventRequests(p, OTHER)) >= 1, "the other session's events are loaded");
    assert.deepEqual(p.errors, []);
  });

  test("the header's tool errors and tests badges and the step bar's failed steps each say what they count", async () => {
    const p = await open("#/s/" + SID, "document.querySelector('.head-foot .badges') && document.querySelector('.fail-nav .lbl')?.textContent");
    const badges: { text: string; title: string }[] = await p.eval("[...document.querySelectorAll('.head-foot .badges .badge')].map((b) => ({ text: b.textContent, title: b.title }))");
    const badge = (re: RegExp) => badges.find((b) => re.test(b.text));
    // Real failures only (core/failures.ts), naming the benign and interrupted calls it leaves out.
    assert.deepEqual(badge(/tool error/), { text: "2 tool errors", title: "Tool calls that failed. Not counted: 1 benign failure (no match, a probe, files that differ) and 1 interrupted call" });
    // The last test run, counted in tests: "1 failed" beside "2 tool errors" read as a failed tool call.
    assert.deepEqual(badge(/test/), { text: "✕ 1 test failed", title: "Last test run: 3 passed, 1 failed" });
    // Every step that failed: the two tool errors, the benign and the interrupted calls, and the test run.
    const nav = await p.eval("(() => { const n = document.querySelector('.fail-nav'); return { text: n.querySelector('.lbl').textContent, label: n.getAttribute('aria-label'), title: n.title }; })()");
    assert.equal(nav.text, "1 / 5 failed steps");
    assert.equal(nav.label, "Failed steps");
    assert.match(nav.title, /^Steps that failed: tool calls \(the benign and interrupted ones too\), model calls, test runs/);
    assert.deepEqual(p.errors, []);
  });
});
