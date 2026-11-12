// Viewer UI regressions, driven in headless Chrome against a real viewer
// server backed by an in-memory store. Skipped when no Chrome is installed.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runBench } from "../../src/bench/run.ts";
import { runsDir } from "../../src/bench/store.ts";
import type { AgentEvent, SessionFilter } from "../../src/core/types.ts";
import { startViewer, type Viewer } from "../../src/viewer/server.ts";
import { cleanup as benchCleanup, day, project } from "../bench/helpers.ts";
import { findChrome, launchBrowser, type Browser, type Page } from "./browser.ts";
import { FakeBlobs, FakeIndex, costFixtures, event, experimentResult, failedRequestFixtures, session } from "./fakes.ts";

const chrome = findChrome();
// Every CI leg (Linux, macOS, Windows) has a Chrome: there, a skipped viewer suite is a bug.
if (!chrome && process.env.GITHUB_ACTIONS) throw new Error("no Chrome found on CI; set CODING_SH_TEST_CHROME");
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
    const exp = experimentResult("exp-prod-smoke");
    v = await startViewer({
      index,
      blobs: new FakeBlobs(),
      port: 0,
      updateStatus: async () => ({ disabled: "test" }) as any,
      experiments: { listExperiments: async () => [exp], getExperiment: async (id) => (id === exp.id ? exp : undefined) },
    });
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
      await page.waitFor("document.querySelector('#steps .st, .detail-head .facts ~ * .panel.empty')", "session steps");
    }
  }
  const sessionHash = (id: string) => "#/s/" + encodeURIComponent(id);
  // Steps are a virtual list: only rows near the viewport are in the DOM.
  const STEPS = "document.querySelectorAll('#steps .st')";
  const stepIndex = (re: string) =>
    `[...${STEPS}].findIndex((t) => new RegExp(${JSON.stringify(re)}).test(t.querySelector('.lbl').textContent))`;
  const selected = "document.querySelector('#steps .st[aria-selected=true]')";

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
      await page.waitFor("document.querySelector('#steps .st')", "steps");
      const i = await page.eval(stepIndex("^Subagent starts"));
      assert.ok(i >= 0, "subagent.start step exists");
      await page.eval(`${STEPS}[${i}].click()`);
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

      // The Run tree panel shows the whole run: the top-level agent and this subagent,
      // with rolled-up totals, and the open session is marked current.
      await page.eval("document.querySelector('.detail-head details.run-tree > summary').click()");
      const tree = await page.waitFor(
        "(() => { const b = document.querySelector('.run-tree-body'); if (!b || /Loading/.test(b.textContent)) return null; return { totals: b.querySelector('.rt-totals')?.textContent, roles: [...b.querySelectorAll('.rt-node .rt-role')].map((e) => e.textContent), current: b.querySelector('.rt-node.current .rt-role')?.textContent }; })()",
        "run tree body",
      );
      assert.deepEqual(tree.roles, ["root", "general-purpose"], JSON.stringify(tree));
      assert.match(tree.totals, /2 agents/);
      assert.equal(tree.current, "general-purpose", "the open subagent is marked current");
    } finally {
      await page.close();
    }
  });

  // Regression: dataset experiments (`coding.sh exp run`) never reached the Experiments page.
  test("the Experiments page lists dataset experiments; a detail page shows their cases", async () => {
    await open("#/");
    try {
      await page.eval(`location.hash = "#/experiments"`);
      const meta = await page.waitFor("(() => { const m = document.querySelector('#exp-h + .meta'); return m && !/Loading/.test(m.textContent) && [...m.children].map((e) => e.textContent).join(' · '); })()", "experiments meta");
      assert.match(meta, /^1 experiment · 2 runs · 0 tasks$/);
      const card = await page.eval("document.querySelector('[data-experiment=\"exp-prod-smoke\"]')?.textContent");
      assert.match(card ?? "", /prod-smoke/);
      assert.match(card, /QA@v1abcdef/);
      assert.match(card, /1\/2 · 50%/);
      assert.match(card, /95% CI 9%–91%/);
      assert.equal(await page.eval("!!document.querySelector('.panel.empty')"), false, "no empty state");
      await page.eval("document.querySelector('[data-experiment=\"exp-prod-smoke\"]').click()");
      // Failed cases first: the page opens on them.
      const failed = await page.waitFor("(() => { const r = [...document.querySelectorAll('.case-row')]; return r.length && r.map((e) => e.textContent); })()", "case rows");
      assert.equal(failed.length, 1);
      assert.match(failed[0], /^c2.*exact: expected 5.*fail$/, "the failure, with the grader's reason");
      await page.eval("document.querySelector('[data-case-filter=all]').click()");
      const cases = await page.waitFor("(() => { const r = [...document.querySelectorAll('.case-row')]; return r.length === 2 && r.map((e) => e.textContent); })()", "all case rows");
      assert.match(cases[0], /^c2/, "failures sort first");
      assert.match(cases[1], /^c1.*pass$/);
      // A case opens in place with its grades and output.
      await page.eval("document.querySelector('.case-row').click()");
      const detail = await page.waitFor("(() => { const d = document.querySelector('.case-row .case-detail:not([hidden])'); return d && d.textContent; })()", "case detail");
      assert.match(detail, /exact/);
      assert.match(detail, /five/);
    } finally {
      await page.close();
    }
  });

  test("at 390px the Experiments page does not scroll sideways", async () => {
    await open("#/", true);
    try {
      await page.eval(`location.hash = "#/experiments"`);
      await page.waitFor("document.querySelector('[data-experiment]')", "experiment row");
      // Mobile emulation grows the layout viewport to fit wide content, so compare with 390, not innerWidth.
      const [sw, vw, card] = await page.eval("[document.documentElement.scrollWidth, innerWidth, document.querySelector('[data-experiment]').getBoundingClientRect().right]");
      assert.ok(sw <= 390 && vw <= 390, `page is ${sw}px wide (layout viewport ${vw}px) on a 390px screen`);
      assert.ok(card <= 390, `experiment row ends at ${card}px`);
      const names: number[] = await page.eval("[...document.querySelectorAll('[data-experiment] .exp-name b')].map((b) => b.getBoundingClientRect().width)");
      assert.ok(names.length && names.every((w) => w > 40), `every row shows its name (widths ${names.join(", ")})`);
      await page.eval("document.querySelector('[data-experiment]').click()");
      await page.waitFor("document.querySelector('.case-row')", "case rows");
      await page.eval("document.querySelector('.case-row').click()");
      const [sw2, right] = await page.eval("[document.documentElement.scrollWidth, Math.max(...[...document.querySelectorAll('main *')].map((e) => e.getBoundingClientRect().right))]");
      assert.ok(sw2 <= 390 && right <= 391, `detail page is ${sw2}px wide, content ends at ${right}px`);
    } finally {
      await page.close();
    }
  });

  test("model calls show their duration and model; the header shows session latency", async () => {
    await open(sessionHash(PARENT));
    try {
      const i = await page.eval(stepIndex("LLM call"));
      assert.ok(i >= 0, "llm.call step exists");
      const step = await page.eval(`${STEPS}[${i}].textContent`);
      assert.match(step, /claude-opus-5-5/);
      assert.match(step, /3\.5s$/, "duration replaces the clock offset");
      await page.eval(`${STEPS}[${i}].click()`);
      const pane = await page.waitFor("document.querySelector('#event-pane .pane-title')?.textContent.startsWith('LLM call') && document.querySelector('#event-pane').innerText");
      assert.match(pane, /duration\s+3\.5s/);
      assert.match(pane, /ttft\s+3\.2s/);
      const head: string = await page.eval("document.querySelector('.detail-head .facts').innerText");
      assert.match(head, /latency/);
      assert.match(head, /293 llm calls · p50 6\.5s · p95 34s/);
      assert.match(head, /ttft p50 4\.0s/);
    } finally {
      await page.close();
    }
  });

  // The first page (5,000 events) goes on screen, and the rest streams in behind it.
  test("sessions with more than one page of events load the rest in the background", async () => {
    await open(sessionHash(BIG));
    try {
      await page.waitFor(`document.querySelector('#steps .st').getAttribute('aria-setsize') === "${BIG_EVENTS}"`, "all steps", 10_000);
      // Virtualized: a few dozen rows in the DOM, 5,010 in the list.
      assert.ok((await page.eval(`${STEPS}.length`)) < 400, "only rows near the viewport render");
      assert.equal(await page.eval("document.querySelector('#load-events')"), null);
      assert.equal(await page.eval("document.querySelector('.timeline-head').textContent"), "5,010 steps");
      assert.equal(await page.eval("document.querySelector('.timeline-more').getBoundingClientRect().height"), 0, "the empty load bar is hidden");
      await page.eval("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))");
      assert.match(await page.waitFor(`${selected}?.textContent`, "last step"), /prompt 5009/);
    } finally {
      await page.close();
    }
  });

  test("a deep link to an event past the first page loads it", async () => {
    await open("#/");
    try {
      await page.eval(`location.hash = ${JSON.stringify(sessionHash(BIG) + "/" + encodeURIComponent(`${BIG}-e5005`))}`);
      const sel = await page.waitFor(`${selected}?.textContent`, "selected step", 10_000);
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
      // Video 39 closes a run of quiet searches, so it stays visible when the middle folds.
      const i = await page.eval(stepIndex("WebSearch\\s*Theo Browne video 39"));
      assert.ok(i >= 0, "step is in the list");
      await page.eval(`${STEPS}[${i}].click()`);
      await page.waitFor(
        // Its top reaches the upper half of the screen, or the page ends with the whole pane in view.
        "(() => { const r = document.querySelector('#event-pane').getBoundingClientRect(); return r.top >= 0 && (r.top < innerHeight / 2 || r.bottom <= innerHeight) && /Theo Browne video 39/.test(document.querySelector('#event-pane').textContent); })()",
        "event pane scrolled into view",
      )
      assert.ok((await page.eval("scrollY")) > 0, "the page scrolled to the detail");
      // The pane offers a way back to the step list on narrow screens.
      assert.equal(await page.eval("getComputedStyle(document.querySelector('#event-pane .to-steps')).display === 'none'"), false);
    } finally {
      await page.close();
    }
  });

  test("at 390px steps and controls are 44px tap targets, titles show on tap, and Filters open as a sheet", async () => {
    await open(sessionHash(PARENT), true);
    try {
      const m = await page.eval(`(() => {
        // A control's hit area is its box grown by an absolutely placed ::before.
        const hit = (el) => { const r = el.getBoundingClientRect(), b = getComputedStyle(el, "::before"), px = (v) => parseFloat(v) || 0;
          return b.content !== "none" && b.position === "absolute" ? [r.width - px(b.left) - px(b.right), r.height - px(b.top) - px(b.bottom)] : [r.width, r.height]; };
        return { step: document.querySelector('#steps .st').getBoundingClientRect().height,
          small: [...document.querySelectorAll('.topbar a, .topbar button:not([hidden]), .detail-head a, .detail-head button')].filter((e) => e.getClientRects().length)
            .map((e) => [e.className || e.textContent.trim(), ...hit(e).map(Math.round)]).filter(([, w, h]) => w < 44 || h < 44) };
      })()`);
      assert.equal(m.step, 44, "step rows are 44px on a phone");
      assert.deepEqual(m.small, [], "every header control has a 44px hit area");
      // Touch screens never show title tooltips: a tap on text with a title shows it instead.
      const tip = await page.eval(`(() => {
        const dd = [...document.querySelectorAll('.facts dd[title]')][0];
        dd.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
        dd.click();
        const t = document.querySelector('.tip');
        return [dd.getAttribute('title'), t && !t.hidden ? t.textContent : null];
      })()`);
      assert.equal(tip[1], tip[0], "the tip repeats the title");
      // The phone header keeps the key facts; More details shows the rest.
      const facts = () => page.eval("[...document.querySelectorAll('.facts [data-fact]')].filter((e) => e.getClientRects().length).map((e) => e.dataset.fact)");
      const short: string[] = await facts();
      assert.ok(!short.includes("tokens") && short.includes("duration"), "tokens wait behind More details: " + short.join(", "));
      await page.eval("document.querySelector('.facts-more').click()");
      const all: string[] = await facts();
      assert.ok(all.length > short.length, "More details shows the rest: " + all.join(", "));
      assert.equal(await page.eval("document.querySelector('.facts-more').getAttribute('aria-expanded')"), "true");
      await page.eval("document.querySelector('.facts-more').click()");

      await page.eval("location.hash = '#/'");
      await page.waitFor("document.querySelector('.facets-toggle')", "filters button");
      const row = await page.eval("(() => { const a = document.querySelector('#q').getBoundingClientRect(), b = document.querySelector('.facets-toggle').getBoundingClientRect(); return [Math.round(a.bottom), Math.round(b.bottom), a.right <= b.left]; })()");
      assert.deepEqual(row, [row[0], row[0], true], "search and Filters share one line");
      await page.eval("document.querySelector('.facets-toggle').click()");
      const sheet = await page.eval(`(() => { const g = document.querySelector('.facet-groups');
        g.getAnimations().forEach((a) => a.finish());
        const r = g.getBoundingClientRect();
        return { pos: getComputedStyle(g).position, bottom: Math.round(r.bottom), focus: document.activeElement.textContent }; })()`);
      assert.deepEqual(sheet, { pos: "fixed", bottom: 844, focus: "Done" }, "Filters open as a bottom sheet with Done focused");
      assert.match(await page.eval("document.querySelector('.sheet-foot .btn-primary').textContent"), /^Show \d+ sessions?$/, "the footer says how many sessions the filters leave");
      await page.eval("document.querySelector('.sheet-head .btn').click()");
      // The sheet slides out before it is hidden.
      await page.waitFor("document.querySelector('.facets').dataset.open === 'false'", "Done closes the sheet");
    } finally {
      await page.close();
    }
  });

  // Types a query and presses a key in the same task, i.e. well inside the 300ms debounce.
  const typeAndPress = (q: string, key: string) =>
    page.eval(`(() => { const q = document.querySelector('#q'); q.focus(); q.value = ${JSON.stringify(q)}; q.dispatchEvent(new Event('input', { bubbles: true })); q.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); })()`);
  const focusedList = "document.activeElement && document.activeElement.matches('.list[role=listbox]') && /^Sessions/.test(document.activeElement.getAttribute('aria-label'))";

  test("Enter pressed before the query debounce fires runs the query and opens a session", async () => {
    await open("#/");
    try {
      await page.waitFor("/sessions loaded$/.test(document.querySelector('#status').textContent)", "initial list announcement");
      await typeAndPress("research", "Enter");
      await page.waitFor(`${focusedList} && document.querySelector('#status').textContent === '1 session loaded'`, "focus on the matching sessions", 2000);
      assert.equal(await page.eval("document.querySelectorAll('.list[role=listbox] [role=option]').length"), 1);
      assert.equal(await page.eval("location.hash"), "#/?where=research", "the query is in the URL");
      await page.eval("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
      await page.waitFor(`location.hash.startsWith(${JSON.stringify(sessionHash(PARENT))})`, "the session opens", 2000);
    } finally {
      await page.close();
    }
  });

  test("ArrowDown before the debounce fires lands on the matches; clearing the bar re-announces the list", async () => {
    await open("#/");
    try {
      const initial: string = await page.waitFor("/sessions loaded$/.test(document.querySelector('#status').textContent) && document.querySelector('#status').textContent", "initial list announcement");
      await typeAndPress("prompt 1", "ArrowDown");
      await page.waitFor(`${focusedList} && document.querySelector('#status').textContent === '1 session loaded'`, "focus on the matching sessions", 2000);
      await page.eval("(() => { const q = document.querySelector('#q'); q.focus(); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()");
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

// List state machine regressions (VWR-1..5, VWR-7). Each scenario gets its own
// viewer over a FakeIndex whose listSessions can be slowed per call.
describe("viewer UI: sessions list state", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  class SlowIndex extends FakeIndex {
    delay: (f: SessionFilter) => number = () => 0;
    override async listSessions(f: SessionFilter = {}) {
      const ms = this.delay(f);
      if (ms) await new Promise((r) => setTimeout(r, ms));
      return super.listSessions(f);
    }
  }
  let browser: Browser;
  before(async () => {
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await browser?.close();
  });
  const titles = "[...document.querySelectorAll('[role=listbox] .row-title')].map((e) => e.textContent.replace(/^↳ /, ''))";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const typeQ = (q: string) => `(() => { const i = document.getElementById('q'); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`;
  const clickChip = (row: string, re: string) =>
    `[...document.querySelectorAll('[data-filter=${row}] .chip')].find((b) => new RegExp(${JSON.stringify(re)}).test(b.textContent)).click()`;

  async function scenario(seedFn: (ix: SlowIndex) => Promise<void>, run: (page: Page, ix: SlowIndex) => Promise<void>) {
    const ix = new SlowIndex();
    await seedFn(ix);
    const v = await startViewer({ index: ix, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    const page = await browser.newPage();
    try {
      await page.viewport(1280, 900);
      await page.goto(v.url);
      await page.waitFor("document.querySelector('[role=listbox], .panel.empty:not([aria-busy])')", "sessions list");
      await run(page, ix);
    } finally {
      await page.close();
      await v.close();
    }
  }
  const many = async (ix: SlowIndex) => {
    for (let i = 0; i < 55; i++) await ix.upsertSession(session(`CC-${i}`, { title: `CC-${i}`, startedAt: T0 + 100_000 + i * 1000 }));
    for (let i = 0; i < 5; i++) await ix.upsertSession(session(`CX-${i}`, { agent: "codex", title: `CX-${i}`, startedAt: T0 + i * 1000 }));
  };
  const loadMore = "[...document.querySelectorAll('.more button')].find((b) => /Load more/.test(b.textContent)).click()";

  test("VWR-1: Load more after a new session lands repeats no row", async () => {
    await scenario(many, async (page, ix) => {
      assert.equal((await page.eval(titles)).length, 50);
      await ix.upsertSession(session("NEW", { title: "NEW", startedAt: T0 + 900_000 }));
      await page.eval(loadMore);
      await page.waitFor(`${titles}.length >= 60`, "second page");
      const rows: string[] = await page.eval(titles);
      assert.equal(rows.length, new Set(rows).size, `duplicate rows: ${rows.filter((t, i) => rows.indexOf(t) !== i)}`);
      assert.equal(rows.length, 60);
    });
  });

  test("VWR-2: a Load more that resolves after a filter change is dropped", async () => {
    await scenario(many, async (page, ix) => {
      ix.delay = (f) => (!f.agent && (f.until !== undefined || (f.offset ?? 0) > 0) && f.parentSessionId === null ? 700 : 0);
      await page.eval(loadMore);
      await sleep(80);
      await page.eval(clickChip("agent", "^codex"));
      await sleep(1100);
      const rows: string[] = await page.eval(titles);
      assert.ok(rows.length > 0 && rows.every((t) => t.startsWith("CX-")), `rows under the codex filter: ${rows}`);
      assert.equal(rows.length, new Set(rows).size);
    });
  });

  test("VWR-3: a bad query keeps the rows, says why on Enter, and does not stick; the bar caps input at 2000", async () => {
    await scenario(
      async (ix) => {
        await ix.upsertSession(session("S1", { title: "S1", startedAt: T0 }));
        await ix.upsertSession(session("S2", { title: "S2", startedAt: T0 + 1000 }));
        await ix.putEvents([ev("S1", 1, { payload: { text: "hello world" } })]);
      },
      async (page) => {
        assert.equal(await page.eval("document.getElementById('q').maxLength"), 2000);
        await page.eval(typeQ("tol:Bash"));
        // Still typing: no error yet, and the last good rows stay.
        await sleep(600);
        assert.equal(await page.eval("!!document.querySelector('.qbar-err')"), false, "no error while typing");
        assert.deepEqual(await page.eval(titles), ["S2", "S1"]);
        await page.eval("document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))");
        const msg = await page.waitFor("document.querySelector('.qbar-err[role=alert]')?.textContent", "query error on Enter");
        assert.match(msg, /unknown key "tol".*tool:/);
        assert.equal(await page.eval("document.querySelector('.qbar').dataset.invalid"), "true");
        assert.equal(await page.eval("[document.getElementById('q').selectionStart, document.getElementById('q').selectionEnd].join()"), "0,1", "the caret marks where the parser stopped");
        assert.deepEqual(await page.eval(titles), ["S2", "S1"], "the last good rows stay");
        await page.eval(typeQ("hello"));
        await page.waitFor(`JSON.stringify(${titles}) === '["S1"]'`, "rows after a good query", 3000);
        assert.equal(await page.eval("!!document.querySelector('.qbar-err')"), false);
        assert.equal(await page.eval("document.querySelector('.qbar').dataset.invalid"), "false");
      },
    );
  });

  test("VWR-4: expanded subagents do not duplicate in the Include subagents scope", async () => {
    await scenario(
      async (ix) => {
        await ix.upsertSession(session("P", { title: "PARENT", startedAt: T0 }));
        await ix.upsertSession(session("C", { title: "CHILD", startedAt: T0 + 5000, parent: { sessionId: "P", subagentId: "a1" } }));
      },
      async (page) => {
        await page.eval("document.querySelector('.sub-toggle').click()");
        await page.waitFor(`${titles}.includes('CHILD')`, "child row");
        await page.eval(clickChip("scope", "^Include"));
        await page.waitFor("document.querySelector('[data-filter=scope] [aria-pressed=true]')?.textContent.startsWith('Include') && document.querySelector('[role=listbox]')", "scope all");
        const rows: string[] = await page.eval(titles);
        assert.equal(rows.filter((t) => t === "CHILD").length, 1, JSON.stringify(rows));
      },
    );
  });

  test("VWR-5: a facet click and typed text narrow one query", async () => {
    await scenario(
      async (ix) => {
        await ix.upsertSession(session("F", { title: "FLAGGED", startedAt: T0, flags: ["no-verification"] }));
        await ix.upsertSession(session("N", { title: "PLAIN", startedAt: T0 + 1000 }));
        await ix.upsertSession(session("Q", { title: "QUIET", startedAt: T0 + 2000, flags: ["no-verification"] }));
        await ix.putEvents([ev("F", 1, { payload: { text: "hello flagged" } }), ev("N", 1, { payload: { text: "hello plain" } })]);
      },
      async (page) => {
        await page.eval(clickChip("flag", "^no-verification"));
        await page.waitFor("document.querySelector('[data-filter=flag] [aria-pressed=true]')?.textContent.startsWith('no-verification') && document.querySelector('[role=listbox]')", "flag pressed");
        assert.equal(await page.eval("document.getElementById('q').value"), "flag:no-verification", "the click writes the clause into the bar");
        assert.deepEqual(await page.eval(titles), ["QUIET", "FLAGGED"]);
        await page.eval(typeQ("flag:no-verification hello"));
        await page.waitFor(`JSON.stringify(${titles}) === '["FLAGGED"]'`, "text narrows the flagged sessions");
        assert.equal(await page.eval("location.hash"), "#/?where=flag%3Ano-verification+hello");
        // Alt-click excludes; the clause chip removes it again.
        await page.eval("[...document.querySelectorAll('[data-filter=flag] .chip')].find((b) => /^no-verification/.test(b.textContent)).dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }))");
        await page.waitFor("document.getElementById('q').value === 'hello -flag:no-verification'", "excluded");
        await page.waitFor(`JSON.stringify(${titles}) === '["PLAIN"]'`, "excluded rows");
        assert.ok(await page.eval("document.querySelector('[data-filter=flag] .chip.excluded')"), "the excluded value is struck through");
        await page.eval("document.querySelector('.clauses .clause.neg button').click()");
        await page.waitFor(`JSON.stringify(${titles}) === '["PLAIN","FLAGGED"]'`, "clause removed");
        assert.equal(await page.eval("document.getElementById('q').value"), "hello");
      },
    );
  });

  test("the Events tab lists matching events; Enter opens one in its session, where n steps through the query's matches", async () => {
    await scenario(
      async (ix) => {
        await ix.upsertSession(session("S1", { title: "BUILD", startedAt: T0 }));
        await ix.upsertSession(session("S2", { title: "OTHER", startedAt: T0 + 1000 }));
        const call = (sid: string, n: number, id: string, ok: boolean, error?: string): AgentEvent[] => [
          ev(sid, n, { kind: "tool.start", payload: { tool: "Bash", toolUseId: id, input: { command: "npm test" } } }),
          ev(sid, n + 1, { kind: "tool.end", payload: { tool: "Bash", toolUseId: id, ok, ...(error ? { error } : {}) } }),
        ];
        await ix.putEvents([
          ev("S1", 1, { payload: { text: "hello build" } }),
          ...call("S1", 2, "t1", false, "first failure"), ...call("S1", 4, "t2", false, "second failure"), ...call("S2", 6, "t3", true),
        ]);
      },
      async (page) => {
        const rows = "[...document.querySelectorAll('.event-table .row')]";
        const key = (k: string) => page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
        const q = encodeURIComponent("tool:Bash ok:false");
        await page.eval(`location.hash = '#/events?where=${q}'`);
        await page.waitFor(`${rows}.length === 2`, "two failed Bash results");
        assert.deepEqual(await page.eval(`${rows}.map((r) => r.querySelector('.ev-detail').textContent)`), ["Tool result · second failure", "Tool result · first failure"], "newest first, the error as the detail");
        assert.match(await page.eval("document.querySelector('.view-tabs [aria-current=page]').textContent"), /^Events\s*2$/);
        assert.equal(await page.eval(`${rows}[0].querySelector('.sess-cell').textContent.startsWith('BUILD')`), true);
        // Enter on the second row opens its step, carrying the query.
        await page.eval("document.querySelector('.event-table .list').focus()");
        await key("j");
        await page.eval("document.querySelector('.event-table .list').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
        // The event is the first call's result (S1-e3); its step is that call, which the session
        // view names by its start (S1-e2) once it has loaded, so wait for that, not the link's hash.
        await page.waitFor(`location.hash === '#/s/S1/S1-e2?where=${q.replace(/%20/g, "+")}' && document.querySelector('#event-pane')?.textContent.includes('first failure')`, "the event's step in its session");
        const nav = "document.querySelector('.query-nav:not([hidden])')?.textContent";
        await page.waitFor(`/^1 \\/ 2 matches/.test(${nav})`, "the query's matches in this session");
        assert.equal(await page.eval("document.querySelector('.back').textContent"), "←Events");
        await key("n");
        await page.waitFor(`/^2 \\/ 2 matches/.test(${nav})`, "n moves to the next match");
        await key("Escape");
        await page.waitFor(`${rows}.length === 2 && location.hash === '#/events?where=${q.replace(/%20/g, "+")}'`, "back to the Events tab");
        await key("s");
        await page.waitFor(`location.hash === '#/?where=${q.replace(/%20/g, "+")}' && ${titles}.join() === 'BUILD'`, "s shows the matching sessions");
        // Text: the prompt that matches has its words marked.
        await page.eval(`location.hash = '#/events?where=hello'`);
        await page.waitFor(`${rows}.length === 1`, "one matching prompt");
        assert.equal(await page.eval(`${rows}[0].querySelector('.row-title mark').textContent`), "hello");
      },
    );
  });

  test("the query bar completes keys and values, and Tab accepts", async () => {
    await scenario(
      async (ix) => {
        await ix.upsertSession(session("A", { title: "A", startedAt: T0, agent: "codex" }));
        await ix.upsertSession(session("B", { title: "B", startedAt: T0 + 1000 }));
      },
      async (page) => {
        const opts = "[...document.querySelectorAll('.qbar-opt .v')].map((e) => e.textContent)";
        const key = (k: string) => page.eval(`document.getElementById('q').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
        await page.eval(typeQ("ag"));
        await page.waitFor(`${opts}[0] === 'agent:'`, "key suggestion");
        assert.equal(await page.eval("document.getElementById('q').getAttribute('aria-expanded')"), "true");
        await key("Tab");
        assert.equal(await page.eval("document.getElementById('q').value"), "agent:");
        const values: string[] = await page.waitFor(`${opts}.length === 2 && ${opts}`, "agent values from the store");
        assert.deepEqual(values.sort(), ["claude-code", "codex"]);
        await key("ArrowDown");
        assert.equal(await page.eval("document.getElementById('q').getAttribute('aria-activedescendant')"), "qopt-0");
        await key("Enter");
        const picked = await page.eval("document.getElementById('q').value");
        assert.match(picked, /^agent:(codex|claude-code) $/, "Enter takes the highlighted value");
        await page.waitFor(`${titles}.length === 1`, "the picked value runs");
        await key("Escape");
        assert.equal(await page.eval("!!document.querySelector('.qbar-pop')"), false, "Escape closes the suggestions");
      },
    );
  });
});

// Timeline, inspector, header and compare behaviour from the viewer polish pass.
describe("viewer UI: timeline, inspector and compare", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new FakeIndex();
  let v: Viewer;
  let browser: Browser;
  let page: Page;
  const WORK = "w-1";
  const API = "api-1";
  const CHEAP = "cheap-1";
  const STEPS = "document.querySelectorAll('#steps .st')";
  const selected = "document.querySelector('#steps .st[aria-selected=true]')";
  const stepWhere = (re: string) => `[...${STEPS}].find((t) => new RegExp(${JSON.stringify(re)}).test(t.querySelector('.lbl').textContent))`;
  const key = (k: string) => page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);

  before(async () => {
    await index.upsertSession(session(WORK, {
      startedAt: T0, endedAt: T0 + 300_000, title: "Fix the cursor in the sessions list", repo: { root: "/work/api", head: "a41c9e2b00" },
      stats: {
        events: 30, turns: 1, toolCalls: 11, toolErrors: 1, filesChanged: 1,
        usage: { inputTokens: 12_000, cacheReadTokens: 324_900, cacheWriteTokens: 5_500, outputTokens: 2_500 },
      },
    }));
    await index.upsertSession(session(API, {
      agent: "vercel-ai-sdk", startedAt: T0 + 1000, endedAt: T0 + 20_000, title: "POST /api/triage", repo: undefined,
      stats: { events: 3, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, latency: { llmCalls: 3 }, usage: { inputTokens: 900, outputTokens: 200, costUsd: 0.012 } },
    }));
    await index.upsertSession(session(CHEAP, {
      agent: "vercel-ai-sdk", startedAt: T0 - 3 * 86_400_000, endedAt: T0 - 3 * 86_400_000 + 1000, title: "POST /api/ping", repo: undefined,
      stats: { events: 1, turns: 0, toolCalls: 0, toolErrors: 0, filesChanged: 0, latency: { llmCalls: 1 }, usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.00004 } },
    }));
    const evs: AgentEvent[] = [ev(WORK, 1, { kind: "user.message", payload: { text: "fix the cursor" } })];
    let n = 2;
    // A quiet run: eight successful reads fold to first two, a fold row and the last.
    for (let i = 0; i < 8; i++, n += 2) {
      evs.push(ev(WORK, n, { kind: "tool.start", payload: { tool: "Read", toolUseId: `r${i}`, input: { file_path: `/work/api/src/file${i}.ts` } } }));
      evs.push(ev(WORK, n + 1, { kind: "tool.end", payload: { tool: "Read", toolUseId: `r${i}`, ok: true, output: "     1→export {};\n" } }));
    }
    evs.push(ev(WORK, n++, { kind: "tool.start", payload: { tool: "Bash", toolUseId: "b1", input: { command: "npm test" } } }));
    evs.push(ev(WORK, n++, { kind: "tool.end", payload: { tool: "Bash", toolUseId: "b1", ok: false, output: "not ok 1 - cursor\nexit 1" } }));
    evs.push(ev(WORK, n++, { kind: "tool.start", payload: { tool: "Edit", toolUseId: "e1", input: { file_path: "/work/api/src/server.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;" } } }));
    evs.push(ev(WORK, n++, { kind: "tool.end", payload: { tool: "Edit", toolUseId: "e1", ok: true } }));
    evs.push(ev(WORK, n++, { kind: "llm.call", durationMs: 800, payload: { ok: false, statusCode: 429, error: "rate limited" } }));
    await index.putEvents(evs);
    await index.putEvents([
      ev(API, 1, { kind: "llm.call", durationMs: 1200, payload: { ok: true, responseModel: "gpt-6.1-sol" } }),
      ev(API, 2, { kind: "llm.call", durationMs: 900, payload: { ok: false, statusCode: 503, error: "upstream unavailable" } }),
      ev(API, 3, { kind: "llm.call", durationMs: 700, payload: { ok: true } }),
    ]);
    const base = experimentResult("exp-base", { name: "baseline", createdAt: T0 - 2000 });
    const cand = experimentResult("exp-cand", {
      name: "candidate", createdAt: T0 - 1000,
      runs: [
        { caseId: "c1", trial: 1, output: "3", latencyMs: 100, grades: [{ graderId: "exact", result: { score: 0, pass: false, reason: "expected 4" } }], pass: false, startedAt: T0 },
        { caseId: "c2", trial: 1, output: "5", latencyMs: 100, grades: [{ graderId: "exact", result: { score: 1, pass: true } }], pass: true, startedAt: T0 },
      ],
    });
    const exps = [cand, base];
    v = await startViewer({
      index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any,
      experiments: { listExperiments: async () => exps, getExperiment: async (id) => exps.find((e) => e.id === id) },
    });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await browser?.close();
    await v?.close();
  });
  async function open(hash: string, width = 1280) {
    page = await browser.newPage();
    await page.viewport(width, 900);
    await page.goto(v.url);
    await page.waitFor("document.querySelector('[role=listbox], .panel.empty:not([aria-busy])')", "sessions list");
    if (hash !== "#/") await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  }

  test("list rows: API sessions show requests, missing cost is a dash, tiny costs stay readable", async () => {
    await open("#/");
    try {
      const rows: Record<string, string> = await page.eval("Object.fromEntries([...document.querySelectorAll('[role=listbox] [role=option]')].map((r) => [r.querySelector('.row-title').textContent, r.textContent]))");
      assert.match(rows["POST /api/triage"]!, /3 requests/);
      assert.doesNotMatch(rows["POST /api/triage"]!, /tool call/);
      assert.match(rows["POST /api/ping"]!, /<\$0\.0001/);
      assert.match(rows["Fix the cursor in the sessions list"]!, /345k tok/, "row tokens count everything sent and received");
      assert.match(rows["Fix the cursor in the sessions list"]!, /—/, "no price yet shows a dash");
      const heights: number[] = await page.eval("[...document.querySelectorAll('[role=listbox] [role=option]')].map((r) => Math.round(r.getBoundingClientRect().height))");
      assert.equal(new Set(heights).size, 1, `rows with and without a repo are the same height: ${heights.join(", ")}`);
      assert.ok(await page.eval("!!document.querySelector('.hist-plot')"), "the time histogram renders");
      const ticks: string[] = await page.eval("[...document.querySelectorAll('.hist-axis span')].map((s) => s.textContent).filter(Boolean)");
      assert.equal(new Set(ticks).size, ticks.length, `axis ticks are distinct: ${ticks.join(" | ")}`);
      // Under two days the ticks are times of day, dated where the day changes.
      const t = new Date(2026, 10, 6, 13, 0).getTime();
      const short: string[] = await page.eval(`axisLabels([${t}, ${t + 6 * 3600e3}, ${t + 12 * 3600e3}])`);
      assert.equal(new Set(short).size, 3, short.join(" | "));
      assert.match(short[0]!, /Nov 6, 1:00/);
      assert.match(short[2]!, /^Nov 7, 1:00/, "a tick on the next day carries its date");
      assert.doesNotMatch(short[1]!, /Nov/, "a tick on the same day shows only the time");
      assert.ok(await page.eval("!!document.querySelector('[data-filter=agent] .chip')"), "agent facets render");
    } finally {
      await page.close();
    }
  });

  test("a model call the proxy and the hooks both logged is one step (real capture)", async () => {
    // scripts/e2e/proxy-capture.mjs: Claude Code through `init --proxy`, two calls, each logged by both paths.
    const events = readFileSync(new URL("../fixtures/proxy/claude-code-proxied.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l) as AgentEvent);
    const proxied = events.filter((e) => e.kind === "llm.call" && e.source === "proxy");
    const hooked = events.filter((e) => e.kind === "llm.call" && e.source !== "proxy");
    await open("#/");
    try {
      const steps: { id: string; source: string; turnId?: string; copyId?: string }[] = await page.eval(`buildTimeline(${JSON.stringify(events)}).filter((it) => it.type === "llm.call").map((it) => ({ id: it.id, source: it.ev.source, turnId: it.ev.turnId, copyId: it.copyId }))`);
      assert.deepEqual(steps.map((s) => s.id), proxied.map((e) => e.id), "one step per call, the proxy's call id");
      assert.deepEqual(steps.map((s) => s.copyId), hooked.map((e) => e.id), "the hook copy's id still finds the step");
      assert.ok(steps.every((s) => s.source === "proxy" && s.turnId === hooked[0]!.turnId), "the turn from the hook copy");
    } finally {
      await page.close();
    }
  });

  test("a file change reads as the result of an edit, with its line counts in the duration column", async () => {
    await open("#/");
    try {
      const v = await page.eval(`eventView({ kind: "file.change", payload: { path: "/work/api/src/a.ts", op: "edit", additions: 3, deletions: 1 } })`);
      assert.equal(v.name, "Changed");
      assert.equal(v.meta, "+3 −1");
      assert.doesNotMatch(v.arg, /\+3/, "the counts are not repeated after the path");
    } finally {
      await page.close();
    }
  });

  test("a weight edit reads as a row of its own, not a blank Notification", async () => {
    await open("#/");
    try {
      const payload = { kind: "weights.edit", tensor: "layers.3.mlp.down_proj.weight", shape: [4096, 11008], changed: 1204, l2: 0.0183, maxAbs: 0.004, baseSha256: "a".repeat(64), editedSha256: "b".repeat(64) };
      const v = await page.eval(`eventView({ kind: "notification", payload: ${JSON.stringify(payload)} })`);
      assert.equal(v.name, "Edited weights");
      assert.equal(v.arg, "layers.3.mlp.down_proj.weight [4096×11008] · 1,204 of 45,088,768 weights · L2 0.0183 · max 0.004 · aaaaaaaa → bbbbbbbb");
      assert.equal(v.kindText, "weights.edit");
      const other = await page.eval(`eventView({ kind: "notification", payload: { kind: "hook.context", text: "x" } })`);
      assert.equal(other.name, "Notification");
    } finally {
      await page.close();
    }
  });

  test("session header: tokens line, cost dash and two columns from 1200px", async () => {
    await open("#/s/" + WORK, 1280);
    try {
      await page.waitFor(selected, "steps");
      const facts: string = await page.eval("document.querySelector('.detail-head .facts').innerText");
      assert.match(facts, /342k in · 2\.5k out · 95% cached/);
      assert.match(facts, /cost\s+—/);
      const cols: string = await page.eval("getComputedStyle(document.querySelector('.session-grid')).gridTemplateColumns");
      assert.equal(cols.split(" ").length, 2, cols);
    } finally {
      await page.close();
    }
  });

  test("timeline: quiet steps fold, ] jumps to failures, paths read relative to the repo", async () => {
    await open("#/s/" + WORK);
    try {
      await page.waitFor(selected, "steps");
      const fold = await page.eval("document.querySelector('#steps .st.fold')?.textContent");
      assert.match(fold ?? "", /5 quiet steps/);
      assert.ok(await page.eval(`!!${stepWhere("src/file0.ts")}`), "relative path in the row");
      assert.equal(await page.eval(`!!${stepWhere("/work/api")}`), false, "no absolute repo path in rows");
      // Failures: the failed command, then the rate-limited model call.
      await key("]");
      const first = await page.waitFor(`${selected}?.classList.contains('is-fail') && ${selected}.textContent`, "first failure");
      assert.match(first, /Bash/);
      assert.match(await page.eval("document.querySelector('.fail-nav').textContent"), /1 \/ 2 failures/);
      // A step pressed within 80 ms of the last paint shows its pane on the trailing timer.
      const pane: string = await page.waitFor("/npm test/.test(document.querySelector('#event-pane').innerText) && document.querySelector('#event-pane').innerText", "pane of the failed command");
      assert.match(pane, /npm test/);
      assert.match(pane, /not ok 1 - cursor/);
      await key("]");
      const second = await page.waitFor(`/LLM call/.test(${selected}?.textContent) && ${selected}.classList.contains('is-fail') && /HTTP 429/.test(document.querySelector('#event-pane').innerText) && document.querySelector('#event-pane').innerText`, "failed model call");
      assert.match(second, /HTTP 429/);
      // z expands every fold.
      await key("z");
      await page.waitFor("!document.querySelector('#steps .st.fold')", "folds expanded");
      assert.ok(await page.eval(`!!${stepWhere("src/file4.ts")}`), "a folded step is back");
    } finally {
      await page.close();
    }
  });

  test("inspector: Edit calls render as a diff; ? opens the shortcut sheet", async () => {
    await open("#/s/" + WORK);
    try {
      await page.waitFor(selected, "steps");
      await page.eval(`${stepWhere("^Edit")}.click()`);
      await page.waitFor("document.querySelector('#event-pane .diff')", "edit diff");
      const del: string = await page.eval("[...document.querySelectorAll('#event-pane .diff .tx.del')].map((e) => e.textContent).join('|')");
      const add: string = await page.eval("[...document.querySelectorAll('#event-pane .diff .tx.add')].map((e) => e.textContent).join('|')");
      assert.equal(del, "const b = 2;");
      assert.equal(add, "const b = 3;");
      assert.equal(await page.eval("document.querySelector('#event-pane .diff .tx.add mark')?.textContent"), "3", "the changed word is marked");
      await key("?");
      const sheet = await page.waitFor("document.querySelector('[role=dialog]')?.textContent", "shortcut sheet");
      assert.match(sheet, /Next failure/);
      assert.match(sheet, /Find in steps/);
    } finally {
      await page.close();
    }
  });

  test("API sessions: requests instead of tool calls, failed requests as error rows", async () => {
    await open("#/s/" + API);
    try {
      await page.waitFor(selected, "steps");
      const badges: string = await page.eval("document.querySelector('.detail-head .badges').textContent");
      assert.match(badges, /3 requests/);
      assert.match(badges, /1 failed request/);
      assert.doesNotMatch(badges, /tool call/);
      const failed: string[] = await page.eval("[...document.querySelectorAll('#steps .st.is-fail')].map((e) => e.textContent)");
      assert.equal(failed.length, 1);
      assert.match(failed[0]!, /HTTP 503/);
    } finally {
      await page.close();
    }
  });

  test("compare: select two, the older is the baseline, regressions list first", async () => {
    await open("#/experiments");
    try {
      await page.waitFor("document.querySelectorAll('[data-experiment]').length === 2", "experiment rows");
      await page.eval("document.querySelectorAll('.exp-row .check')[0].click()");
      await page.eval("document.querySelectorAll('.exp-row .check')[1].click()");
      const href = await page.waitFor("document.querySelector('.compare-bar a')?.getAttribute('href')", "compare button");
      assert.equal(href, "#/experiments/exp-base/vs/exp-cand");
      await page.eval("document.querySelector('.compare-bar a').click()");
      const verdict = await page.waitFor("document.querySelector('.verdict')?.textContent", "verdict");
      assert.match(verdict, /baseline/);
      assert.match(verdict, /1 regression/);
      assert.match(verdict, /1 improvement/);
      const rows: string[] = await page.eval("[...document.querySelectorAll('.cmp-row')].map((e) => e.textContent)");
      assert.equal(rows.length, 1, "opens on regressions");
      assert.match(rows[0]!, /^c1.*pass.*fail.*expected 4.*regressed$/);
      await page.eval("document.querySelector('.cmp-row').click()");
      const sides = await page.waitFor("document.querySelector('.cmp-row .side-by-side')?.textContent", "side-by-side outputs");
      assert.match(sides, /baseline/);
      assert.match(sides, /candidate/);
    } finally {
      await page.close();
    }
  });
});

describe("viewer UI: benchmarks", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new FakeIndex();
  let v: Viewer;
  let empty: Viewer;
  let emptyHome: string;
  let browser: Browser;
  let page: Page;
  const key = (k: string) => page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);

  before(async () => {
    // Two contenders over three days; "bad" is the reference. Two of the latest
    // run's failures point at sessions: one the index has, one it doesn't.
    const p = project();
    for (const d of ["2026-11-04", "2026-11-05", "2026-11-06"]) await runBench({ def: p.def('reference = "bad"'), env: p.env, now: day(d) });
    const dir = runsDir("arith", p.env);
    const latest = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const bad = latest.cells.filter((c: any) => c.contender === "bad" && !c.pass);
    bad[0].sessionId = "s-known";
    bad[1].sessionId = "s-missing";
    writeFileSync(join(dir, `${latest.id}.json`), JSON.stringify(latest));
    await index.upsertSession(session("s-known", { title: "Fix the arithmetic case" }));
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, env: p.env, updateStatus: async () => ({ disabled: "test" }) as any });
    emptyHome = mkdtempSync(join(tmpdir(), "csh-bench-empty-"));
    empty = await startViewer({ index: new FakeIndex(), blobs: new FakeBlobs(), port: 0, env: { ...p.env, CODING_SH_HOME: emptyHome }, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await browser?.close();
    await v?.close();
    await empty?.close();
    rmSync(emptyHome, { recursive: true, force: true });
    benchCleanup();
  });
  async function open(url: string, hash: string, width = 1280, mobile = false) {
    page = await browser.newPage();
    await page.viewport(width, 900, mobile);
    await page.goto(url);
    await page.waitFor("document.querySelector('main').children.length", "first view");
    await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  }

  test("list: a card per benchmark with its leaderboard; g b, j and Enter open it", async () => {
    await open(v.url, "#/");
    try {
      await key("g");
      await key("b");
      await page.waitFor("document.querySelector('[data-benchmark=arith]')", "benchmark card");
      assert.equal(await page.eval("document.querySelector('[data-nav=benchmarks]').getAttribute('aria-current')"), "page");
      const card: string = await page.eval("document.querySelector('[data-benchmark=arith]').innerText");
      assert.match(card, /good/);
      assert.match(card, /bad/);
      assert.match(card, /ref/, "the reference is marked");
      assert.ok(await page.eval("document.querySelectorAll('[data-benchmark=arith] .spark path').length >= 2"), "one trend line per contender");
      await key("Enter");
      await page.waitFor("location.hash === '#/benchmarks/arith' && document.querySelector('.bench-row')", "detail");
    } finally {
      await page.close();
    }
  });

  test("detail: leaderboard, trend chart, gap to the reference and failed cases with session links", async () => {
    await open(v.url, "#/benchmarks/arith");
    try {
      await page.waitFor("document.querySelector('.bench-row')", "leaderboard");
      const rows: Record<string, string> = await page.eval("Object.fromEntries([...document.querySelectorAll('.bench-row')].map((r) => [r.dataset.contender, r.innerText]))");
      assert.deepEqual(Object.keys(rows).sort(), ["bad", "good"]);
      assert.match(rows.bad!, /reference/);
      assert.match(rows.good!, /pts/, "gap to the reference in points");
      // Places follow the pooled gap: ahead of the reference is a clear first, behind it never shares first.
      const places: [string, string][] = await page.eval("[...document.querySelectorAll('.bench-row')].map((r) => [r.querySelector('.place').textContent, r.children[4].innerText])");
      for (const [place, pooled] of places) {
        if (/ahead/.test(pooled)) assert.equal(place, "1", "ahead on every pooled day is a clear first");
        if (/behind/.test(pooled)) assert.doesNotMatch(place, /^1=?$/, "behind on the pooled days is not first");
      }
      assert.deepEqual(places.map(([p]) => parseInt(p)), places.map(([p]) => parseInt(p)).sort((a, b) => a - b), "rows run in place order");
      assert.ok(await page.eval("document.querySelectorAll('.chart .ln').length >= 2"), "trend lines");
      assert.ok(await page.eval("!!document.querySelector('.gap-card .band')"), "gap chart has a CI band");
      // Hover the trend: a tooltip with the day's values, no layout change.
      const box = await page.eval("(() => { const r = document.querySelector('.chart .ch-plot').getBoundingClientRect(); return [r.left + r.width - 2, r.top + r.height / 2]; })()");
      await page.eval(`document.querySelector('.chart .ch-plot').dispatchEvent(new PointerEvent('pointermove', { clientX: ${box[0]}, clientY: ${box[1]}, bubbles: true }))`);
      assert.match(await page.eval("document.querySelector('.ch-tip:not([hidden])')?.innerText || ''"), /good[\s\S]*%/);
      const links: string[] = await page.eval("[...document.querySelectorAll('.fail-row a.open-sess')].map((a) => a.getAttribute('href'))");
      assert.deepEqual(links, ["#/s/s-known"], "only a session the index has gets a link");
      assert.ok(await page.eval("[...document.querySelectorAll('.fail-row .no-sess')].length >= 1"), "a missing session says so");
      await page.eval("document.querySelector('.fail-row a.open-sess').click()");
      await page.waitFor("location.hash === '#/s/s-known'", "session opened");
    } finally {
      await page.close();
    }
  });

  test("detail on a phone: no horizontal scroll", async () => {
    await open(v.url, "#/benchmarks/arith", 390, true);
    try {
      await page.waitFor("document.querySelector('.bench-row')", "leaderboard");
      assert.equal(await page.eval("document.documentElement.scrollWidth <= innerWidth"), true);
      // The number columns fold into a labelled grid under each contender.
      const grid: string[] = await page.eval("[...document.querySelectorAll('.bench-row[data-contender=good] .mob-grid dt')].filter((e) => e.getClientRects().length).map((e) => e.textContent)");
      assert.ok(grid.includes("vs bad"), "the gap is labelled: " + grid.join(", "));
    } finally {
      await page.close();
    }
  });

  test("empty and unknown: how to start, and a clear not-found", async () => {
    await open(empty.url, "#/benchmarks");
    try {
      const text: string = await page.waitFor("document.querySelector('.panel.empty')?.innerText", "empty state");
      assert.match(text, /No benchmarks yet/);
      assert.match(text, /coding\.sh bench new/);
      await page.eval("location.hash = '#/benchmarks/nope'");
      assert.match(await page.waitFor("document.querySelector('.panel.empty h2')?.textContent", "not found"), /Benchmark not found/);
    } finally {
      await page.close();
    }
  });
});

describe("viewer UI: cost marks", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new FakeIndex();
  let v: Viewer;
  let browser: Browser;
  let page: Page;
  const STEPS = "document.querySelectorAll('#steps .st')";
  const stepWhere = (re: string) => `[...${STEPS}].find((t) => new RegExp(${JSON.stringify(re)}).test(t.querySelector('.lbl').textContent))`;
  // [text, title] of an element, or null.
  const tt = (expr: string) => `(() => { const e = ${expr}; return e ? [e.textContent, e.getAttribute('title')] : null; })()`;

  before(async () => {
    const { sessions, events } = costFixtures(T0);
    for (const s of sessions) await index.upsertSession(s);
    await index.putEvents(events);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await browser?.close();
    await v?.close();
  });
  async function open(hash: string, width = 1280, height = 900, mobile = false) {
    page = await browser.newPage();
    await page.viewport(width, height, mobile);
    await page.goto(v.url);
    await page.waitFor("document.querySelector('[role=listbox]') && document.querySelector('.sum-cost')", "sessions list with its cost");
    if (hash !== "#/") {
      await page.eval(`location.hash = ${JSON.stringify(hash)}`);
      await page.waitFor("document.querySelector('#steps .st')", "steps");
    }
  }
  const rowCost = (title: string) => tt(`[...document.querySelectorAll('[role=option]')].find((r) => r.querySelector('.row-title').textContent === ${JSON.stringify(title)})?.querySelector('.cost-cell')`);

  test("list: estimates carry ~ and say so, reported costs do not, unpriced is a dash that says why", async () => {
    await open("#/");
    try {
      assert.deepEqual(await page.eval(rowCost("Price the session list from list prices")), ["~$0.42", "Estimated from list prices"]);
      assert.deepEqual(await page.eval(rowCost("POST /api/summarize")), ["$1.10", "Reported cost"]);
      assert.deepEqual(await page.eval(rowCost("Mixed reported and estimated cost")), ["~$0.30", "$0.10 of it estimated from list prices, the rest reported"]);
      assert.deepEqual(await page.eval(rowCost("Unpriced model")), ["—", 'No list price for kimi-k3. Add [prices."kimi-k3"] to config.toml']);
      // The total over the index: 3 of 4 sessions priced, part of it estimated.
      const [sum, title] = await page.eval(tt("document.querySelector('.sum-cost')"));
      assert.equal(sum, "~$1.82 priced");
      assert.equal(title, "Cost of the 3 sessions with a price. $0.52 of it estimated from list prices");
    } finally {
      await page.close();
    }
  });

  test("session and calls: the header marks the estimate; calls show ~ and the model they were priced as", async () => {
    await open("#/s/cost-est");
    try {
      assert.deepEqual(await page.eval(tt("document.querySelector('.facts [data-fact=cost] dd')")), ["~$0.42", "Estimated from list prices"]);
      assert.match(await page.eval("document.querySelector('.facts [data-fact=tokens] dd').getAttribute('title')"), /^Not counted twice: 1 model call \(12k tokens, \$0\.05\)/);
      assert.deepEqual(await page.eval(tt(`${stepWhere("sonnet-4-7")}?.querySelector('.cost')`)), ["~$0.03", "Estimated from list prices, priced as claude-sonnet-4-5"]);
      assert.deepEqual(await page.eval(tt(`${stepWhere("gpt-6\\.1-sol")}?.querySelector('.cost')`)), ["$0.02", "Reported cost"]);
      assert.equal(await page.eval(`!!${stepWhere("kimi-k3")}?.querySelector('.cost')`), false, "an unpriced call adds nothing to its row");

      const kpi = "[...document.querySelectorAll('#event-pane .kpi')].find((k) => k.querySelector('span').textContent === 'cost')?.querySelector('b')";
      await page.eval(`${stepWhere("sonnet-4-7")}.click()`);
      await page.waitFor(`/sonnet-4-7/.test(document.querySelector('#event-pane .pane-title')?.textContent)`, "estimated call pane");
      assert.equal(await page.eval(`${kpi}.textContent`), "~$0.03");
      assert.match(await page.eval("document.querySelector('#event-pane .call-meta').textContent"), /cost estimated from list prices, priced as claude-sonnet-4-5/);
      await page.eval(`${stepWhere("gpt-6\\.1-sol")}.click()`);
      await page.waitFor(`/gpt-6\\.1-sol/.test(document.querySelector('#event-pane .pane-title')?.textContent)`, "reported call pane");
      assert.equal(await page.eval(`${kpi}.textContent`), "$0.02");
      assert.equal(await page.eval("!!document.querySelector('#event-pane .call-meta')"), false, "a reported cost needs no note");
      await page.eval(`${stepWhere("kimi-k3")}.click()`);
      await page.waitFor(`/kimi-k3/.test(document.querySelector('#event-pane .pane-title')?.textContent)`, "unpriced call pane");
      assert.deepEqual(await page.eval(tt(`${kpi}.closest('.kpi')`)), ["cost—", 'No list price for kimi-k3. Add [prices."kimi-k3"] to config.toml']);
    } finally {
      await page.close();
    }
  });

  for (const [w, hgt] of [[390, 844], [360, 780]] as const) {
    test(`at ${w}px cost stays on screen: rows, header and calls, with no sideways scroll`, async () => {
      await open("#/", w, hgt, true);
      try {
        const list = await page.eval(`(() => { const c = [...document.querySelectorAll('.cost-cell')].filter((e) => e.getClientRects().length);
          return { sw: document.documentElement.scrollWidth, texts: c.map((e) => e.textContent), right: Math.max(...c.map((e) => e.getBoundingClientRect().right)) }; })()`);
        assert.ok(list.sw <= w, `list is ${list.sw}px wide on a ${w}px screen`);
        // The top bar's last control (theme) keeps its gutter, so its 44px hit area stays on screen too.
        const theme: number = await page.eval("document.querySelector('#theme').getBoundingClientRect().right");
        assert.ok(theme <= w - 7, `the theme button ends at ${theme}px`);
        assert.ok(list.right <= w, `a cost cell ends at ${list.right}px`);
        assert.ok(list.texts.includes("~$0.42") && list.texts.includes("$1.10"), "priced rows show their cost: " + list.texts.join(", "));
        assert.ok(!list.texts.includes("—"), "an unpriced row drops the dash on a phone");

        await page.eval("location.hash = '#/s/cost-est'");
        await page.waitFor("document.querySelector('#steps .st')", "steps");
        const m = await page.eval(`(() => { const cost = document.querySelector('.facts [data-fact=cost]'), step = ${stepWhere("sonnet-4-7")};
          return { sw: document.documentElement.scrollWidth, cost: cost.getClientRects().length ? cost.textContent : null, costRight: cost.getBoundingClientRect().right,
            step: step.getBoundingClientRect().height, callCost: step.querySelector('.cost').getBoundingClientRect().right,
            right: Math.max(...[...document.querySelectorAll('main *')].map((e) => e.getBoundingClientRect().right)) }; })()`);
        assert.ok(m.sw <= w && m.right <= w + 1, `session page is ${m.sw}px wide, content ends at ${m.right}px`);
        assert.equal(m.cost, "cost~$0.42", "the phone header keeps the cost without More details");
        assert.ok(m.costRight <= w && m.callCost <= w, `cost ends on screen (header ${m.costRight}px, call ${m.callCost}px)`);
        assert.equal(m.step, 44, "step rows stay 44px");
      } finally {
        await page.close();
      }
    });
  }
});

describe("viewer UI: failed requests and the top bar", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const index = new FakeIndex();
  let v: Viewer;
  let browser: Browser;

  before(async () => {
    const { sessions, events } = failedRequestFixtures(T0);
    for (const s of sessions) await index.upsertSession(s);
    await index.putEvents(events);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await browser?.close();
    await v?.close();
  });
  async function open(width: number, mobile = false): Promise<Page> {
    const page = await browser.newPage();
    await page.viewport(width, 800, mobile);
    await page.goto(v.url);
    await page.waitFor("document.querySelector('[role=listbox]')", "sessions list");
    return page;
  }

  // Regression: API sessions with a failed request lost their red mark in the list.
  for (const [w, mobile] of [[1280, false], [390, true]] as const) {
    test(`at ${w}px an API row with a failed request is red and says why`, async () => {
      const page = await open(w, mobile);
      try {
        const row = (title: string) => `(() => {
          const r = [...document.querySelectorAll('[role=option]')].find((r) => r.querySelector('.row-title').textContent === ${JSON.stringify(title)});
          const ink = document.createElement('span');
          ink.style.color = 'var(--fail-ink)';
          document.body.append(ink);
          const fail = getComputedStyle(ink).color;
          ink.remove();
          const b = r.querySelector('.badge.fail');
          return { dot: r.querySelector('.dot').className,
            badge: b && [b.textContent, b.title, getComputedStyle(b).color === fail, b.getBoundingClientRect().right <= innerWidth] };
        })()`;
        const failed = await page.eval(row("POST /api/triage (rate limited)"));
        assert.equal(failed.dot, "dot tone-fail ring");
        assert.deepEqual(failed.badge, ["1 failed request (429)", "First failure: 429 Rate limit reached for gpt-5-mini on tokens per min", true, true]);
        assert.deepEqual(await page.eval(row("POST /api/triage")), { dot: "dot tone-muted", badge: null });
      } finally {
        await page.close();
      }
    });
  }

  // Regression: at 1024px the filter sidebar took its share and the session column fell to 20px.
  for (const w of [900, 1024, 1180, 1280, 1440]) {
    test(`at ${w}px the session column keeps 12rem and the header lines up with the cells`, async () => {
      const page = await open(w);
      try {
        const m = await page.eval(`(() => {
          const shown = (els) => [...els].filter((e) => getComputedStyle(e).display !== 'none');
          const head = document.querySelector('[role=listbox]').parentElement.querySelector(':scope > .thead');
          return [...document.querySelectorAll('[role=option]')].map((r) => ({
            title: r.querySelector('.row-main').getBoundingClientRect().width,
            head: shown(head.children).map((e) => Math.round(e.getBoundingClientRect().left)).join(),
            cells: [r.children[0], r.children[1], ...shown(r.querySelector('.row-cells').children)].map((e) => Math.round(e.getBoundingClientRect().left)).join(),
            sw: document.documentElement.scrollWidth,
          }));
        })()`);
        assert.ok(m.length > 0);
        for (const r of m) {
          assert.ok(r.title >= 191.5, `session column is ${r.title}px`);
          assert.equal(r.cells, r.head, "cells sit under their headers");
          assert.ok(r.sw <= w, `page is ${r.sw}px wide`);
        }
      } finally {
        await page.close();
      }
    });
  }

  // Regression: between 641 and 700px the bar ran out of room and squeezed the theme button to 16px.
  for (const w of [320, 360, 390, 641, 700, 768, 1024]) {
    test(`at ${w}px the top bar fits with 44px targets, pills shown or not`, async () => {
      const page = await open(w, w <= 640);
      try {
        const measure = `(() => {
          const hit = (el) => { const r = el.getBoundingClientRect(), b = getComputedStyle(el, "::before"), px = (v) => parseFloat(v) || 0;
            return b.content !== "none" && b.position === "absolute" ? [r.width - px(b.left) - px(b.right), r.height - px(b.top) - px(b.bottom)] : [r.width, r.height]; };
          const ctl = [...document.querySelectorAll('.topbar a, .topbar button:not([hidden])')].filter((e) => e.getClientRects().length);
          const theme = document.querySelector('#theme');
          const r = theme.getBoundingClientRect();
          return { sw: document.documentElement.scrollWidth, vw: innerWidth, theme: r.width, themeHitRight: r.right + (hit(theme)[0] - r.width) / 2,
            small: ctl.map((e) => [e.id || e.textContent.trim(), ...hit(e).map(Math.round)]).filter(([, a, b]) => a < 44 || b < 44) };
        })()`;
        // Last, the tabs in a much wider font than any we tuned for (Linux has no Geist, and
        // its fallback is wider than macOS's): the labels give, the page does not.
        for (const state of ["plain", "pills", "wide font"] as const) {
          if (state === "pills") {
            await page.eval(`(() => {
              const u = document.querySelector('#update'); u.querySelector('.ver').textContent = 'v0.1.3'; u.hidden = false;
              const i = document.querySelector('#indexing'); i.innerHTML = '<span class="dot">●</span><span>Indexing 1,234 files…</span>'; i.hidden = false;
            })()`);
          }
          if (state === "wide font") await page.eval(`document.querySelectorAll('.nav a').forEach((a) => a.style.letterSpacing = '0.15em')`);
          const m = await page.eval(measure);
          const what = state === "plain" ? "" : state === "pills" ? " (update and indexing pills shown)" : " (pills, tabs in a wide font)";
          assert.ok(m.sw <= w && m.vw === w, `page is ${m.sw}px wide (layout ${m.vw}px) on a ${w}px screen${what}`);
          assert.equal(m.theme, 30, `the theme button keeps its 30px box${what}`);
          assert.ok(m.themeHitRight <= w, `the theme button's hit area ends at ${m.themeHitRight}px${what}`);
          assert.deepEqual(m.small, [], `every top bar control has a 44px hit area${what}`);
        }
      } finally {
        await page.close();
      }
    });
  }
});

describe("session replay in a browser", { skip: chrome ? false : "no Chrome/Chromium found (set CODING_SH_TEST_CHROME)" }, () => {
  const RP = "7f3c1e2a-5b6d-4e8f-9a0b-1c2d3e4f5a6b";
  const index = new FakeIndex();
  let v: Viewer;
  let browser: Browser;
  let page: Page;
  const at = (n: number, over: Partial<AgentEvent>) => ev(RP, n, { cwd: "/work/demo", ...over });

  before(async () => {
    await index.upsertSession(session(RP, { startedAt: T0, endedAt: T0 + 60_000, title: "Replay me", repo: { root: "/work/demo", head: "a41c9e2b00" }, stats: { events: 8, turns: 1, toolCalls: 3, toolErrors: 1, filesChanged: 1 } }));
    await index.putEvents([
      at(1, { kind: "user.message", payload: { text: "write a.txt then test" } }),
      at(2, { kind: "tool.start", payload: { tool: "Write", toolUseId: "w1", input: { file_path: "/work/demo/a.txt", content: "one\ntwo\n" } } }),
      at(3, { kind: "tool.end", payload: { tool: "Write", toolUseId: "w1", ok: true } }),
      at(4, { kind: "tool.start", payload: { tool: "Edit", toolUseId: "e1", input: { file_path: "/work/demo/a.txt", old_string: "two", new_string: "TWO" } } }),
      at(5, { kind: "tool.end", payload: { tool: "Edit", toolUseId: "e1", ok: true } }),
      at(6, { kind: "tool.start", payload: { tool: "Bash", toolUseId: "b1", input: { command: "npm test" } } }),
      at(7, { kind: "tool.end", durationMs: 1200, payload: { tool: "Bash", toolUseId: "b1", ok: false, exitCode: 1, output: "1 failing" } }),
      at(8, { kind: "assistant.message", payload: { text: "The test fails." } }),
    ]);
    v = await startViewer({ index, blobs: new FakeBlobs(), port: 0, updateStatus: async () => ({ disabled: "test" }) as any });
    browser = await launchBrowser(chrome!);
  });
  after(async () => {
    await browser?.close();
    await v?.close();
  });
  const key = (k: string) => page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);
  const paneText = "document.querySelector('#event-pane').innerText";
  const tab = (re: string) => page.eval(`[...document.querySelectorAll('.rp-tabs button')].find((b) => /${re}/.test(b.textContent)).click()`);

  async function openAt(hash: string, mobile = false) {
    page = await browser.newPage();
    if (mobile) await page.viewport(390, 844, true);
    else await page.viewport(1280, 900);
    await page.goto(v.url + hash);
  }

  test("a ?step link opens the replay there; keys step, the URL follows, and the File and range tabs rebuild a.txt", async () => {
    await openAt("#/s/" + RP + "?step=2");
    try {
      await page.waitFor(`/Step 2 of 5/.test(${paneText})`, "step 2 pane", 10_000);
      assert.match(await page.eval(paneText), /a\.txt/);
      assert.equal(await page.eval("document.querySelector('.rp-bar').hidden"), false);
      assert.match(await page.eval("document.querySelector('.rp-pos').textContent"), /^2 \/ 5/);
      await key("j");
      await page.waitFor(`/Step 3 of 5/.test(${paneText})`, "step 3 after j");
      assert.match(await page.eval("location.hash"), /\?step=3$/);
      assert.match(await page.eval(paneText), /two[\s\S]*TWO/);
      // The file as of step 3, then as of step 2.
      await tab("^File");
      await page.waitFor(`/one\\nTWO/.test(${paneText})`, "a.txt at step 3");
      await key("ArrowLeft");
      await page.waitFor(`/Step 2 of 5/.test(${paneText}) && /one\\ntwo/.test(${paneText})`, "a.txt at step 2");
      // Shell step: command, exit code and output.
      await key("End");
      await key("k");
      await page.waitFor(`/Step 4 of 5/.test(${paneText})`, "step 4");
      const shell: string = await page.eval(paneText);
      assert.match(shell, /\$ npm test/);
      assert.match(shell, /exit 1/);
      assert.match(shell, /1 failing/);
      // Range: steps 1 through 4 added a.txt with its final content.
      await tab("Since");
      await page.waitFor(`/one[\\s\\S]*TWO/.test(${paneText}) && /steps 2, 3/.test(${paneText})`, "range diff");
      // Escape leaves the replay and the URL drops ?step.
      await key("Escape");
      await page.waitFor("document.querySelector('.rp-bar').hidden", "replay closed");
      assert.doesNotMatch(await page.eval("location.hash"), /step=/);
    } finally {
      await page.close();
    }
  });

  test("play advances on its own; at 390px the replay does not scroll sideways", async () => {
    await openAt("#/s/" + RP + "?step=1", true);
    try {
      await page.waitFor(`/Step 1 of 5/.test(${paneText})`, "step 1", 10_000);
      await page.eval("[...document.querySelectorAll('.rp-bar .seg button')].find((b) => b.textContent === '16×').click()");
      await key(" ");
      await page.waitFor(`/Step 3 of 5/.test(${paneText})`, "playback reached step 3", 5000);
      const m = await page.eval(`({ sw: document.documentElement.scrollWidth, vw: innerWidth, bar: document.querySelector('.rp-bar').getBoundingClientRect().right })`);
      assert.ok(m.sw <= 390 && m.bar <= 390, `page ${m.sw}px, bar ends at ${m.bar}px on a 390px screen`);
      await key(" ");
      assert.equal(await page.eval("document.querySelector('.rp-play').textContent"), "Play");
    } finally {
      await page.close();
    }
  });

  test("Fork from here: the step's CLAUDE.md is editable, and the fork shows recorded vs forked next action", async () => {
    const runs: unknown[] = [];
    const fv = await startViewer({
      index,
      blobs: new FakeBlobs(),
      port: 0,
      updateStatus: async () => ({ disabled: "test" }) as any,
      fork: {
        preview: async () => ({ step: { n: 4 }, call: { id: "0123456789abcdef", model: "claude-sonnet-4-5", by: "tool-use" }, files: [{ path: "CLAUDE.md", text: "Run the tests with npm test." }], recorded: { label: "Bash: npm test" }, canCall: true, keyEnv: "ANTHROPIC_API_KEY" }),
        run: async (_s, _r, step, files, trials) => {
          runs.push({ step, files, trials });
          return { differ: 1, edits: [{ path: "CLAUDE.md", how: "replaced" }], trials: [{ label: "Bash: node --test", differs: true }] };
        },
      },
    });
    page = await browser.newPage();
    try {
      await page.viewport(1280, 900);
      await page.goto(fv.url + "#/s/" + RP + "?step=4");
      await page.waitFor(`/Step 4 of 5/.test(${paneText})`, "step 4", 10_000);
      await tab("Fork from here");
      await page.waitFor("document.querySelector('.rp-fork-file textarea')?.value === 'Run the tests with npm test.'", "the recorded CLAUDE.md");
      await page.eval("(() => { const t = document.querySelector('.rp-fork-file textarea'); t.value = 'Run the tests with node --test.'; t.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await page.eval("[...document.querySelectorAll('.rp-fork-go button')].find((b) => b.textContent === 'Run fork').click()");
      await page.waitFor(`/Bash: node --test/.test(${paneText})`, "the forked action");
      const text: string = await page.eval(paneText);
      assert.match(text, /recorded\s+Bash: npm test/);
      assert.match(text, /different/);
      assert.match(text, /coding\.sh replay 7f3c1e2a --step 4 --fork --with CLAUDE\.md --save-case forks/);
      assert.deepEqual(runs, [{ step: 4, files: { "CLAUDE.md": "Run the tests with node --test." }, trials: 1 }]);
    } finally {
      await page.close();
      await fv.close();
    }
  });
});
