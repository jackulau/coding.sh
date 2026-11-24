// Viewer fixes from hands-on QA (round 9) on big sessions and small screens, in headless Chrome: a
// link to another step of the session on screen moves there on the events the page loaded, with no
// new download of them; a newer link wins over a replay that is loading or playing and over a page
// still loading, and a replay started during a held j or k still starts; the header's tool errors
// and tests badges and the step bar's failed steps each say what they count, on a session where the
// counts differ; on a phone the Steps button brings the selected step below the sticky top bar (and
// below the replay bar while replaying).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { REPLAY_KINDS } from "../../src/core/replay.ts";
import type { AgentEvent } from "../../src/schema/index.ts";
import { MemoryIndexStore } from "../../src/store/memory.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, session } from "./fakes.ts";

const chrome = findChrome();
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");

const SID = "qa9t-steps";
const OTHER = "qa9t-other";
/** Past the first page (5,000 events), so the page streams the rest in behind it. */
const LONG = "qa9t-long";
const LONG_EVENTS = 5100;
/** A session no other test replays, so the server has not cached its replay when the test holds it. */
const KEYS = "qa9t-keys";
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
  // Long enough that the page scrolls well past the step list on a phone.
  const output = Array.from({ length: 80 }, (_, i) => `test ${i + 1} ... ${i === 41 ? "not ok" : "ok"}`).join("\n");
  const out = [
    ev("user.message", { text: "Run the tests and fix what fails" }, 0),
    ev("tool.start", { tool: "Bash", toolUseId: "t1", input: { command: "npm test" } }, 1000),
    ev("tool.end", { tool: "Bash", toolUseId: "t1", ok: false, error: "exit code 1", output }, 4000),
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

function otherEvents(id = OTHER): AgentEvent[] {
  const ev = maker(id);
  return [
    ev("user.message", { text: "List the files" }, 0),
    ev("tool.start", { tool: "Bash", toolUseId: "o1", input: { command: "ls" } }, 1000),
    ev("tool.end", { tool: "Bash", toolUseId: "o1", ok: true, output: "src" }, 1100),
    ev("assistant.message", { text: "One folder: src." }, 2000),
  ];
}

function longEvents(): AgentEvent[] {
  const ev = maker(LONG);
  return Array.from({ length: LONG_EVENTS }, (_, i) => ev("user.message", { text: `prompt ${i}` }, i * 1000));
}

/** Holds a read the server makes of the store until the test lets it through. */
class Gate {
  #open: () => void = () => {};
  #opened: Promise<void> = Promise.resolve();
  #ask: () => void = () => {};
  /**
   * Resolves once the server makes a held read. A test that waits on it sets a timeout, so a read
   * that never comes fails the test instead of hanging the file.
   */
  asked: Promise<void> = Promise.resolve();
  close() {
    this.#opened = new Promise<void>((r) => { this.#open = () => r(); });
    this.asked = new Promise<void>((r) => { this.#ask = () => r(); });
  }
  async pass() { this.#ask(); await this.#opened; }
  open() { this.#open(); }
}

/** Sets the hash, waits until the page handled the hash change (its listener was added first, so it runs first), then runs `then`. */
const linkTo = (hash: string, then = "") =>
  `(async () => { location.hash = ${JSON.stringify(hash)}; await new Promise((r) => addEventListener('hashchange', r, { once: true })); ${then} })()`;
/**
 * A link whose hash change the page has not handled yet: the URL is the link's, and route() runs when
 * the test fires the hash change (handOn). A real link's hash change comes a task after its URL; the
 * test cannot hold that one back, because the page's listener runs before any the test adds.
 */
const linkUnhandled = (hash: string) => `history.pushState(null, '', ${JSON.stringify(hash)})`;
const handOn = "dispatchEvent(new HashChangeEvent('hashchange'))";

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
  /** The long session's event pages after the first one. */
  const pages = new Gate();
  /** The replay's read of the session's events. */
  const replays = new Gate();

  before(async () => {
    const index = new MemoryIndexStore();
    const listEvents = index.listEvents.bind(index);
    index.listEvents = async (sessionId, opts = {}) => {
      if (sessionId === LONG && opts.offset) await pages.pass();
      if (sessionId === KEYS && opts.kinds === REPLAY_KINDS) await replays.pass();
      return listEvents(sessionId, opts);
    };
    await index.upsertSession(session(LONG, { startedAt: t0, endedAt: t0 + LONG_EVENTS * 1000, title: "Long session", stats: { events: LONG_EVENTS, turns: LONG_EVENTS, toolCalls: 0, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents(longEvents());
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
    await index.upsertSession(session(KEYS, { startedAt: t0, endedAt: t0 + 2000, title: "List the files again", stats: { events: 4, turns: 1, toolCalls: 1, toolErrors: 0, filesChanged: 0 } }));
    await index.putEvents(otherEvents(KEYS));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    pages.open();
    replays.open();
    await page?.close();
    await browser?.close();
    await v?.close();
  });

  async function open(hash: string, wait: string, phone = false): Promise<Page> {
    await page?.close();
    page = await browser.newPage();
    if (phone) {
      await page.viewport(390, 844, true);
      // Instant scrolls (smoothScroll() reads this), so a position read after a click is where it ends.
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    } else {
      await page.viewport(1280, 900);
    }
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

  // A link's hash change is handled a task after the URL changes, and a load can end in between. The
  // test fires the hash change once the load has ended: the order a real click can lose by a hair.
  test("a link made while the replay loads wins, even when the load ends before the link's hash change is handled", async () => {
    const p = await open("#/s/" + SID, paneItem(FIRST_FAIL));
    // ?step opens the replay, which starts loading its steps; the link comes before they arrive (in the
    // same task, so no response can come between them).
    await p.eval(linkTo(`#/s/${SID}?step=2`, linkUnhandled(`#/s/${SID}/${LINKED}`)));
    await p.waitFor("document.querySelector('#rp-scrub').max !== '1'", "the replay's steps loaded");
    assert.deepEqual(await p.eval("({ hash: location.hash, replaying: !document.querySelector('.rp-bar').hidden })"),
      { hash: `#/s/${SID}/${LINKED}`, replaying: true }, "the late load leaves the link's URL alone");
    await p.eval(handOn);
    await p.waitFor(`document.querySelector('.rp-bar').hidden && ${paneItem(LINKED)}`, "out of the replay, on the linked step");
    assert.deepEqual(p.errors, []);
  });

  // Playback moves on when a timer comes due, and that can also come between a link's URL and its hash change.
  test("a link made while the replay plays wins, even when the next step is due before the link's hash change is handled", async () => {
    const p = await open(`#/s/${SID}?step=1`, "!!document.querySelector('.rp-pos')?.textContent");
    // At 16x the next step is due in at most 3 s / 16, under 190 ms.
    await p.eval("[...document.querySelectorAll('.rp-bar .seg button')].find((b) => b.textContent.startsWith('16')).click()");
    // Play, then the link in the same task. The test's 250 ms timer is set after the step's and fires after it.
    await p.eval(`document.querySelector('.rp-play').click(); ${linkUnhandled(`#/s/${SID}/${LINKED}`)}; new Promise((r) => setTimeout(r, 250))`);
    assert.equal(await p.eval("location.hash"), `#/s/${SID}/${LINKED}`, "the step that came due leaves the link's URL alone");
    await p.eval("localStorage.removeItem('csh-rpspeed')");
    await p.eval(handOn);
    await p.waitFor(`document.querySelector('.rp-bar').hidden && ${paneItem(LINKED)}`, "out of the replay, on the linked step");
    assert.deepEqual(p.errors, []);
  });

  test("a link to a step still streaming in lands when its page arrives, unless a newer link changed the URL first", { timeout: 60_000 }, async () => {
    const far = `${LONG}-5050`, near = `${LONG}-10`;
    // The page holding the step is held back, so the link waits for it.
    pages.close();
    let p = await open(`#/s/${LONG}/${LONG}-0`, paneItem(`${LONG}-0`));
    await pages.asked;
    await p.eval(linkTo(`#/s/${LONG}/${far}`));
    assert.equal(await p.eval(paneItem(`${LONG}-0`)), true, "the step waits for its page");
    pages.open();
    await p.waitFor(`${paneItem(far)} && location.hash === '#/s/${LONG}/${far}'`, "the linked step, once its page is in", 10_000);
    await settle();
    assert.equal(await eventRequests(p, LONG), 2, "the first page and the rest, once each");

    // A newer link while the page is held, its hash change handled after the page lands: the page
    // brings the older link's step but leaves the newer link's URL alone, and the newer link wins.
    pages.close();
    p = await open(`#/s/${LONG}/${LONG}-0`, paneItem(`${LONG}-0`));
    await pages.asked;
    await p.eval(linkTo(`#/s/${LONG}/${far}`));
    await p.eval(linkUnhandled(`#/s/${LONG}/${near}`));
    pages.open();
    await p.waitFor(`document.querySelector('#steps .st')?.getAttribute('aria-setsize') === '${LONG_EVENTS}'`, "every step loaded", 10_000);
    // A late paint (at most 80 ms behind) would have changed the URL by now.
    await settle();
    assert.equal(await p.eval("location.hash"), `#/s/${LONG}/${near}`, "the page that brought the older link's step leaves the newer link's URL alone");
    await p.eval(handOn);
    await p.waitFor(paneItem(near), "the newer link's step");
    assert.deepEqual(p.errors, []);
  });

  // A held j or k paints the pane and the URL at most once per 80 ms; a replay started before the late
  // paint loads its steps first. The late paint must not change the URL under the load.
  test("a replay started while a held j or k still has a paint to make starts on the step the keys reached", { timeout: 60_000 }, async () => {
    const p = await open(`#/s/${KEYS}/${KEYS}-0`, `${paneItem(`${KEYS}-0`)} && document.querySelector('.rp-toggle')`);
    replays.close();
    // Two quick presses leave a paint on the timer, then the replay starts.
    await p.eval("for (let i = 0; i < 2; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })); document.querySelector('.rp-toggle').click()");
    await replays.asked;
    // A late paint (at most 80 ms behind) would have changed the URL by now.
    await settle();
    replays.open();
    await p.waitFor("location.hash.includes('?step=') && document.querySelector('.rp-pos').textContent !== ''", "the replay, started");
    assert.equal(await p.eval("document.querySelector('#rp-scrub').value === document.querySelector('#rp-scrub').max"), true, "on the last step, where the keys took the selection");
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

  test("at 390x844 the Steps button brings the selected step below the sticky top bar, and below the replay bar in a replay", async () => {
    const p = await open("#/s/" + SID, `document.querySelectorAll('.st').length > 3 && ${paneItem(FIRST_FAIL)}`, true);
    const where = (under: string) =>
      p.eval(`(() => { const row = document.querySelector('.st[aria-selected="true"]').getBoundingClientRect(); const bar = document.querySelector(${JSON.stringify(under)}).getBoundingClientRect(); return { row: row.top, bar: bar.bottom, list: document.querySelector('.timeline').getBoundingClientRect().top, label: document.querySelector('.st[aria-selected="true"]').textContent }; })()`);
    const steps = () => p.eval("[...document.querySelectorAll('.to-steps')].find((b) => b.offsetParent).click()");
    // Tap the second row: the page scrolls down to its detail, as on a phone.
    await p.eval("document.querySelectorAll('.st')[1].click()");
    await p.waitFor("document.querySelector('#event-pane').getBoundingClientRect().top < 200", "the step's detail in view");
    await steps();
    const m = await where(".topbar");
    assert.ok(m.row >= m.bar, `the selected step (${m.label}) starts at ${m.row}px, under the top bar that ends at ${m.bar}px`);
    assert.ok(Math.abs(m.list - m.bar) <= 1, `the step list starts at ${m.list}px, right below the top bar (${m.bar}px)`);
    // In a replay the replay bar sticks under the top bar; the list comes up below both.
    await p.eval(`location.hash = '#/s/${SID}?step=2'`);
    await p.waitFor("document.querySelector('.rp-bar') && !document.querySelector('.rp-bar').hidden && document.querySelector('.st[aria-selected=\"true\"]')", "the replay at step 2");
    // The replay pane draws its Steps button when step 2's detail arrives, which can be after the replay bar shows.
    await p.waitFor("/^Step 2 of /.test(document.querySelector('#event-pane .pane-top .meta')?.textContent ?? '') && [...document.querySelectorAll('.to-steps')].some((b) => b.offsetParent)", "the replay pane's Steps button");
    await p.eval("scrollTo(0, document.documentElement.scrollHeight)");
    await steps();
    const r = await where(".rp-bar");
    assert.ok(r.row >= r.bar, `in the replay the selected step (${r.label}) starts at ${r.row}px, under the replay bar that ends at ${r.bar}px`);
    assert.deepEqual(p.errors, []);
  });
});
