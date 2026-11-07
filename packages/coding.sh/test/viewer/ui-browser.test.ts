// Viewer UI regressions, driven in headless Chrome against a real viewer
// server backed by an in-memory store. Skipped when no Chrome is installed.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { AgentEvent } from "../../src/core/types.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, FakeIndex, event, session } from "./fakes.ts";

const chrome = findChrome();
const T0 = 1_762_400_000_000;
// Real-looking ids: long enough that the eval command overflows a phone screen.
const PARENT = "4b9889a2-c0d2-4046-9d28-6b07d00c01a8";
const CHILD = `${PARENT}:sub:af5b468e7213397e9`;
const BIG = "d6639e3e-6257-4741-aae9-e9979064bf0b";
const BIG_EVENTS = 5010;

function ev(sessionId: string, n: number, over: Partial<AgentEvent>): AgentEvent {
  return { ...event(sessionId, n), ts: T0 + n * 1000, ...over };
}

async function seed(index: FakeIndex) {
  const subStartId = `${PARENT}-e3`;
  await index.upsertSession(
    session(PARENT, {
      startedAt: T0,
      endedAt: T0 + 600_000,
      title: "Research the ui design of the coding.sh viewer and make it feel seamless on every screen size",
      model: "claude-opus-5-5",
      stats: {
        events: 40, turns: 2, toolCalls: 15, toolErrors: 0, filesChanged: 23,
        latency: { llmCalls: 293, llmP50Ms: 6500, llmP95Ms: 34_000, ttftP50Ms: 4000, toolMs: 1_372_000, toolP95Ms: 16_000 },
      },
    }),
  );
  // Started after its parent, so a flat newest-first list would put it on top.
  await index.upsertSession(
    session(CHILD, {
      startedAt: T0 + 5000,
      endedAt: T0 + 65_000,
      title: "Read-only reconnaissance of the rodev harness",
      parent: { sessionId: PARENT, eventId: subStartId, subagentId: "af5b468e7213397e9", type: "general-purpose" },
    }),
  );
  await index.upsertSession(session(BIG, { startedAt: T0 - 86_400_000, title: "Long session", stats: { events: BIG_EVENTS, turns: 1, toolCalls: 0, toolErrors: 0, filesChanged: 0 } }));

  const parentEvents: AgentEvent[] = [
    ev(PARENT, 1, { kind: "user.message", payload: { text: "research the ui design" } }),
    ev(PARENT, 2, {
      kind: "llm.call", model: "claude-opus-5-5", durationMs: 3523,
      payload: { provider: "anthropic", responseModel: "claude-opus-5-5", ttftMs: 3243, tokensPerSec: 63.3, stopReason: "tool_use", ok: true },
    }),
    ev(PARENT, 3, { kind: "subagent.start", payload: { subagentId: "af5b468e7213397e9", type: "general-purpose", description: "Recon", childSessionId: CHILD } }),
    ev(PARENT, 4, { kind: "subagent.end", durationMs: 60_000, payload: { subagentId: "af5b468e7213397e9", ok: true } }),
  ];
  for (let n = 5; n < 40; n += 2) {
    parentEvents.push(ev(PARENT, n, { kind: "tool.start", payload: { tool: "WebSearch", toolUseId: `t${n}`, input: { query: `Theo Browne video ${n}` } } }));
    parentEvents.push(ev(PARENT, n + 1, { kind: "tool.end", payload: { tool: "WebSearch", toolUseId: `t${n}`, ok: true, durationMs: 900 } }));
  }
  await index.putEvents(parentEvents);
  await index.putEvents([ev(CHILD, 1, { kind: "user.message", payload: { text: "recon the harness" } })]);
  const big: AgentEvent[] = [];
  for (let n = 0; n < BIG_EVENTS; n++) big.push(ev(BIG, n, { ts: T0 - 86_400_000 + n * 1000, payload: { text: `prompt ${n}` } }));
  await index.putEvents(big);
}

describe("viewer UI in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new FakeIndex();
  let v: Viewer;
  let browser: Browser;
  let page: Page;

  before(async () => {
    await seed(index);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await browser?.close();
    await v?.close();
  });

  async function open(hash: string, mobile = false) {
    page = await browser.newPage();
    if (mobile) await page.viewport(390, 844, true);
    else await page.viewport(1280, 900);
    await page.goto(v.url);
    await page.waitFor("document.querySelector('[role=listbox], .panel.empty:not([aria-busy])')", "sessions list");
    if (hash !== "#/") {
      await page.eval(`location.hash = ${JSON.stringify(hash)}`);
      await page.waitFor("document.querySelector('.detail-head')", "session header");
    }
  }
  const sessionHash = (id: string) => "#/s/" + encodeURIComponent(id);
  const stepIndex = (re: string) =>
    `[...document.querySelectorAll('[role=tab]')].findIndex((t) => new RegExp(${JSON.stringify(re)}).test(t.textContent))`;

  test("subagents nest under their parent, and parent and child link to each other", async () => {
    await open("#/");
    try {
      // Top-level only by default: the subagent is not its own top-level row.
      const titles: string[] = await page.eval("[...document.querySelectorAll('[role=option] .row-title')].map((e) => e.textContent)");
      assert.equal(titles.length, 2, `top-level rows only, got ${JSON.stringify(titles)}`);
      assert.match(titles[0]!, /^Research the ui design/);
      const toggle = await page.eval("document.querySelector('.sub-toggle')?.textContent");
      assert.match(toggle ?? "", /1 subagent/);
      await page.eval("document.querySelector('.sub-toggle').click()");
      const child = await page.waitFor("document.querySelector('.row.child .row-title')?.textContent", "nested subagent row");
      assert.match(child, /Read-only reconnaissance/);
      assert.equal(await page.eval("document.querySelector('.sub-toggle').getAttribute('aria-expanded')"), "true");

      // Parent timeline: the subagent step links to the child session.
      await page.eval(`location.hash = ${JSON.stringify(sessionHash(PARENT))}`);
      await page.waitFor("document.querySelector('[role=tab]')", "steps");
      const i = await page.eval(stepIndex("^Subagent starts"));
      assert.ok(i >= 0, "subagent.start step exists");
      await page.eval(`document.querySelectorAll('[role=tab]')[${i}].click()`);
      const href = await page.waitFor("document.querySelector('#event-pane a.child-link')?.getAttribute('href')", "child session link");
      assert.equal(href, sessionHash(CHILD));

      // Child header links back to its parent, by title.
      await page.eval("document.querySelector('#event-pane a.child-link').click()");
      const parent = await page.waitFor(
        "(() => { const a = document.querySelector('.detail-head a.parent-link'); return a && { href: a.getAttribute('href'), text: a.textContent }; })()",
        "parent link",
      );
      assert.ok(parent.href.startsWith(sessionHash(PARENT)), parent.href);
      assert.match(parent.text, /parent:\s*Research the ui design/);
    } finally {
      await page.close();
    }
  });

  test("model calls show their duration and model; the header shows session latency", async () => {
    await open(sessionHash(PARENT));
    try {
      const i = await page.eval(stepIndex("LLM call"));
      assert.ok(i >= 0, "llm.call step exists");
      const step = await page.eval(`document.querySelectorAll('[role=tab]')[${i}].textContent`);
      assert.match(step, /claude-opus-5-5/);
      assert.match(step, /3\.5s$/, "duration replaces the clock offset");
      await page.eval(`document.querySelectorAll('[role=tab]')[${i}].click()`);
      const pane = await page.waitFor("document.querySelector('#event-pane .pane-title')?.textContent.startsWith('LLM call') && document.querySelector('#event-pane').innerText");
      assert.match(pane, /duration 3\.5s/);
      assert.match(pane, /ttft 3\.2s/);
      const head: string = await page.eval("document.querySelector('.detail-head .facts').innerText");
      assert.match(head, /latency/);
      assert.match(head, /293 llm calls, p50 6\.5s, p95 34s/);
      assert.match(head, /ttft p50 4\.0s/);
    } finally {
      await page.close();
    }
  });

  test("sessions with more than one page of events can load the rest", async () => {
    await open(sessionHash(BIG));
    try {
      assert.equal(await page.eval("document.querySelectorAll('[role=tab]').length"), 5000);
      const label = await page.waitFor("document.querySelector('#load-events')?.textContent", "load-more button");
      assert.equal(label, "Load the remaining 10 events");
      assert.equal(await page.eval("document.querySelector('.timeline-head').textContent"), "5,000 steps5,000 of 5,010 events");
      await page.eval("document.querySelector('#load-events').click()");
      await page.waitFor(`document.querySelectorAll('[role=tab]').length === ${BIG_EVENTS}`, "all steps", 10_000);
      assert.equal(await page.eval("document.querySelector('#load-events')"), null);
      assert.equal(await page.eval("document.querySelector('.timeline-head').textContent"), "5,010 steps");
      assert.equal(await page.eval("document.querySelector('.timeline-more').getBoundingClientRect().height"), 0, "the empty load bar is hidden");
      const last = await page.eval("[...document.querySelectorAll('[role=tab]')].at(-1).textContent");
      assert.match(last, /prompt 5009/);
      // Focus moves to the first newly loaded step.
      assert.match(await page.eval("document.activeElement.textContent"), /prompt 5000/);
    } finally {
      await page.close();
    }
  });

  test("a deep link to an event past the first page loads it", async () => {
    await open("#/");
    try {
      await page.eval(`location.hash = ${JSON.stringify(sessionHash(BIG) + "/" + encodeURIComponent(`${BIG}-e5005`))}`);
      const sel = await page.waitFor("document.querySelector('[role=tab][aria-selected=true]')?.textContent", "selected step", 10_000);
      assert.match(sel, /prompt 5005/);
    } finally {
      await page.close();
    }
  });

  test("at 390px the session page does not scroll sideways; the command scrolls in its box", async () => {
    await open(sessionHash(PARENT), true);
    try {
      const m = await page.eval(`(() => {
        const code = document.querySelector('.make-eval .cmd code');
        return { scrollWidth: document.documentElement.scrollWidth, vw: window.innerWidth,
          head: document.querySelector('.detail-head').getBoundingClientRect().right,
          codeScrolls: code.scrollWidth > code.clientWidth };
      })()`);
      assert.ok(m.scrollWidth <= 390 && m.vw <= 390, `page is ${m.scrollWidth}px wide (layout viewport ${m.vw}px) on a 390px screen`);
      assert.ok(m.head <= 390, `header card ends at ${m.head}px`);
      assert.ok(m.codeScrolls, "the long eval command scrolls inside its own box");
    } finally {
      await page.close();
    }
  });

  test("at 390px tapping a step brings its detail into view", async () => {
    await open(sessionHash(PARENT), true);
    try {
      const before = await page.eval("document.querySelector('#event-pane').getBoundingClientRect().top");
      assert.ok(before > 844 - 120, `fixture starts the pane at the bottom edge or below (top ${before})`);
      const i = await page.eval(stepIndex("WebSearch Theo Browne video 21"));
      await page.eval(`document.querySelectorAll('[role=tab]')[${i}].click()`);
      await page.waitFor(
        // Its top reaches the upper half of the screen, or the page ends with the whole pane in view.
        "(() => { const r = document.querySelector('#event-pane').getBoundingClientRect(); return r.top >= 0 && (r.top < innerHeight / 2 || r.bottom <= innerHeight) && /Theo Browne video 21/.test(document.querySelector('#event-pane').textContent); })()",
        "event pane scrolled into view",
      );
      assert.ok((await page.eval("scrollY")) > 0, "the page scrolled to the detail");
      // The pane offers a way back to the step list on narrow screens.
      assert.equal(await page.eval("getComputedStyle(document.querySelector('#event-pane .to-steps')).display === 'none'"), false);
    } finally {
      await page.close();
    }
  });

  // Types a query and presses a key in the same task, i.e. well inside the 200ms debounce.
  const typeAndPress = (q: string, key: string) =>
    page.eval(`(() => { const q = document.querySelector('#q'); q.focus(); q.value = ${JSON.stringify(q)}; q.dispatchEvent(new Event('input', { bubbles: true })); q.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); })()`);
  const focusedHits = "document.activeElement && document.activeElement.getAttribute('role') === 'listbox' && /^Search results/.test(document.activeElement.getAttribute('aria-label'))";

  test("Enter pressed before the search debounce fires runs the search and opens a hit", async () => {
    await open("#/");
    try {
      await page.waitFor("/sessions loaded$/.test(document.querySelector('#status').textContent)", "initial list announcement");
      await typeAndPress("recon", "Enter");
      await page.waitFor(focusedHits, "focus on the search hits", 2000);
      assert.equal(await page.eval("document.querySelectorAll('[role=listbox] [role=option]').length"), 1);
      await page.waitFor("document.querySelector('#status').textContent === '1 match'", "hit count announcement", 2000);
      await page.eval("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
      await page.waitFor(`location.hash.startsWith(${JSON.stringify(sessionHash(CHILD) + "/")})`, "the hit's session opens", 2000);
    } finally {
      await page.close();
    }
  });

  test("ArrowDown before the debounce fires lands on the hits; clearing the box re-announces the list", async () => {
    await open("#/");
    try {
      const initial: string = await page.waitFor("/sessions loaded$/.test(document.querySelector('#status').textContent) && document.querySelector('#status').textContent", "initial list announcement");
      await typeAndPress("prompt 1", "ArrowDown");
      await page.waitFor(focusedHits, "focus on the search hits", 2000);
      await page.waitFor("/^\\d+ matches$/.test(document.querySelector('#status').textContent)", "hit count announcement", 2000);
      await page.eval("(() => { const q = document.querySelector('#q'); q.focus(); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await page.waitFor("!/^Search results/.test(document.querySelector('[role=listbox]').getAttribute('aria-label'))", "full list again", 2000);
      await page.waitFor(`document.querySelector('#status').textContent === ${JSON.stringify(initial)}`, "list announcement after clearing", 2000);
    } finally {
      await page.close();
    }
  });

  test("the live region announces the sessions list after leaving a session", async () => {
    await open("#/");
    try {
      const initial: string = await page.waitFor("/sessions loaded$/.test(document.querySelector('#status').textContent) && document.querySelector('#status').textContent", "initial list announcement");
      await page.eval(`location.hash = ${JSON.stringify(sessionHash(PARENT))}`);
      await page.waitFor("/^Session loaded/.test(document.querySelector('#status').textContent)", "session announcement");
      await page.eval("location.hash = '#/'");
      await page.waitFor("document.querySelector('[role=listbox]')", "list again");
      await page.waitFor(`document.querySelector('#status').textContent === ${JSON.stringify(initial)}`, "list announcement after leaving a session", 2000);
    } finally {
      await page.close();
    }
  });
});
