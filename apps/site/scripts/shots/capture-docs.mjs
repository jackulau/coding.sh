// Screenshots the real viewer for the docs. Run seed.mjs, then seed-docs.mjs, then:
//
//   node scripts/shots/capture-docs.mjs <ui url with ?t=…> <sdk url> <team url with ?t=…> [outDir]
//
// <ui url> is the line seed.mjs prints; <sdk url> and <team url> are the lines
// seed-docs.mjs prints (<sdk url> holds the quickstart's own triage.mjs run). Uses its own headless Chrome (puppeteer-core + the
// system Chrome), like capture.mjs, and writes 2x WebP files plus a phone crop
// (-m) to src/assets/docs/. Staging is the same as capture.mjs: controls and
// internals (ids, the event payload, the keyboard hints) are hidden by setting
// `hidden`; nothing is added or reworded. Each state is reached by clicking.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const [uiArg, serveArg, teamArg, outArg] = process.argv.slice(2);
if (!uiArg || !serveArg || !teamArg) {
  console.error("usage: node scripts/shots/capture-docs.mjs <ui url> <sdk url> <team url> [outDir]");
  process.exit(2);
}
const OUT = resolve(outArg || join(here, "../../src/assets/docs"));
mkdirSync(OUT, { recursive: true });
const ui = new URL(uiArg);
const serve = new URL(serveArg);
const team = new URL(teamArg);
// SHOTS_ONLY=sdk-session,compare shoots only those (both sizes).
const ONLY = process.env.SHOTS_ONLY ? process.env.SHOTS_ONLY.split(",") : null;
const want = (name) => !ONLY || ONLY.includes(name);
// Desktop shots are taken this wide: shown in the 46rem docs column at about 1:1, so the viewer text
// reads near its real size. Wider captures shrink it to about 7 px.
const DESK_W = Number(process.env.SHOTS_WIDTH) || 800;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--hide-scrollbars"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(url, width, height, mobile = false) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  await page.goto(url.toString(), { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !document.body.innerText.includes("Loading"), { timeout: 15000 });
  await page.evaluate(() => { const u = document.querySelector("#update"); if (u) u.hidden = true; });
  if ((await page.evaluate(() => innerWidth)) !== width) throw new Error(`viewport is not ${width} wide`);
  return { page, ctx };
}

/** Saves a page-coordinate rect (CSS px) as a 2x WebP, after checking the frame for ids and dev text. */
async function shot(page, name, rect, quality = 82) {
  await sleep(250);
  await checkFrame(page, rect);
  const png = await page.screenshot({ type: "png", clip: { ...rect, scale: 1 }, captureBeyondViewport: true });
  const info = await sharp(png).webp({ quality, effort: 6 }).toFile(join(OUT, name + ".webp"));
  console.log(`${name}.webp ${info.width}x${info.height} ${(info.size / 1024).toFixed(0)} KB`);
}

/** Fails when visible text inside the crop holds a UUID, a dev URL or the other vendor's file name. */
async function checkFrame(page, rect) {
  const bad = await page.evaluate((r) => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.data.trim() || el.closest("[hidden]") || getComputedStyle(el).display === "none" || getComputedStyle(el).visibility === "hidden") continue;
      const b = el.getBoundingClientRect();
      const top = b.top + scrollY;
      if (b.width === 0 || top + b.height < r.y || top > r.y + r.height || b.left > r.x + r.width || b.right < r.x) continue;
      const t = n.data;
      if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t) || /127\.0\.0\.1|localhost/.test(t) || /claude[-_.]?md/i.test(t) || /\bexp_[0-9A-Z]{10,}/.test(t)) out.push(t.trim().slice(0, 80));
    }
    return out;
  }, rect);
  if (bad.length) throw new Error("frame shows " + JSON.stringify(bad));
}

const hideAll = (page, sels) =>
  page.evaluate((sels) => {
    const hide = (el) => el && (el.hidden = true, el.style.setProperty("display", "none", "important"));
    for (const s of sels) document.querySelectorAll(s).forEach(hide);
  }, sels);

/** Hides the elements matching `sel` whose whole text matches `re` (a control, such as a disclosure). */
const hideText = (page, sel, re) =>
  page.evaluate((s, src) => {
    const re = new RegExp(src);
    document.querySelectorAll(s).forEach((el) => { if (re.test(el.textContent.trim())) (el.hidden = true, el.style.setProperty("display", "none", "important")); });
  }, sel, re.source);

/** Document y of the lowest visible text inside `sel` (containers can stretch past their content). */
const textBottom = (page, sel) =>
  page.evaluate((s) => {
    let max = 0;
    const walk = document.createTreeWalker(document.querySelector(s), NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!n.data.trim() || el.closest("[hidden]") || getComputedStyle(el).display === "none") continue;
      const b = el.getBoundingClientRect();
      if (b.height) max = Math.max(max, b.bottom + scrollY);
    }
    return max;
  }, sel);

/** Stacks several document rects of one page into one image, with a thin rule between them (as capture.mjs does). */
async function stitch(page, name, rects, quality = 82) {
  await sleep(250);
  const parts = [];
  for (const r of rects) {
    await checkFrame(page, r);
    parts.push(await page.screenshot({ type: "png", clip: { ...r, scale: 1 }, captureBeyondViewport: true }));
  }
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const metas = await Promise.all(parts.map((p) => sharp(p).metadata()));
  const W = Math.max(...metas.map((m) => m.width));
  const RULE = 2;
  const H = metas.reduce((h, m) => h + m.height, 0) + RULE * (parts.length - 1);
  const comp = [];
  let y = 0;
  parts.forEach((p, i) => {
    comp.push({ input: p, top: y, left: 0 });
    y += metas[i].height;
    if (i < parts.length - 1) {
      comp.push({ input: { create: { width: W, height: RULE, channels: 4, background: "#2a2a2e" } }, top: y, left: 0 });
      y += RULE;
    }
  });
  const info = await sharp({ create: { width: W, height: H, channels: 4, background: bg } }).composite(comp).webp({ quality, effort: 6 }).toFile(join(OUT, name + ".webp"));
  console.log(`${name}.webp ${info.width}x${info.height} ${(info.size / 1024).toFixed(0)} KB`);
}

/** The session pages: hide the top bar, the back link with the session id, the eval command, the step tools and hints. */
const SESSION_CHROME = [".topbar", ".crumbs", ".detail-head .actions", ".hintbar", ".tl-tools"];

/** Opens a session from a list by its title and selects the step whose text matches. */
async function openSession(base, title, step, width, height, mobile) {
  const o = await open(new URL("#/", base), width, height, mobile);
  const { page } = o;
  await page.waitForFunction((t) => [...document.querySelectorAll(".row")].some((r) => r.innerText.includes(t)), { timeout: 15000 }, title);
  await page.evaluate((t) => [...document.querySelectorAll(".row")].find((r) => r.innerText.includes(t)).click(), title);
  await page.waitForSelector(".st");
  await page.waitForFunction(() => !document.body.innerText.includes("Loading"));
  await page.evaluate((s) => [...document.querySelectorAll(".st")].find((r) => r.innerText.includes(s)).click(), step);
  await page.waitForFunction(() => document.querySelector("#event-pane .pane-title"));
  await sleep(300);
  return o;
}

/** Hides the facts a reader of this picture does not need (the start time, the latency line). */
const dropFacts = (page, re) =>
  page.evaluate((src) => {
    const re = new RegExp(src);
    document.querySelectorAll(".facts > div").forEach((d) => {
      if (re.test(d.querySelector("dt")?.textContent?.trim() || "")) (d.hidden = true, d.style.setProperty("display", "none", "important"));
    });
  }, re.source);

/** Hides the pane's "payload" and "stored content" sections: the raw event, not what a reader came for. */
const hidePayload = (page) =>
  page.evaluate(() => {
    const pane = document.querySelector("#event-pane");
    for (const el of pane.querySelectorAll("*")) {
      const t = el.firstChild?.nodeType === 3 ? el.firstChild.data.trim() : "";
      if (t === "payload" || t === "stored content") {
        let sec = el;
        while (sec.parentElement && sec.parentElement !== pane && sec.parentElement.children.length === 1) sec = sec.parentElement;
        sec.hidden = true;
        sec.style.setProperty("display", "none", "important");
        let next = sec.nextElementSibling;
        while (next && !/^(payload|stored content)$/.test(next.textContent.trim().split("\n")[0])) {
          if (next.querySelector(".json, pre, button") || /blob|\{/.test(next.textContent)) { next.hidden = true; next.style.setProperty("display", "none", "important"); }
          next = next.nextElementSibling;
        }
      }
    }
  });

/** Leaves only the session table: no header, chart, facets or tabs, and the table at full width. */
const listOnly = async (page) => {
  await hideAll(page, [".topbar", ".hintbar", ".panel.hist", ".facets", ".page-head", ".view-tabs", ".live-pill"]);
  await page.evaluate(() => {
    document.querySelector(".sessions-layout")?.style.setProperty("grid-template-columns", "minmax(0, 1fr)");
    // The column header sticks under the (hidden) top bar; in a still picture it sits in place.
    for (const el of document.querySelectorAll(".panel.table *")) if (getComputedStyle(el).position === "sticky") el.style.setProperty("position", "static", "important");
  });
  await sleep(200);
};

/** The table's frame, from just above it to the bottom of its `rows`-th row (all rows when omitted). */
const listRect = (page, rows) =>
  page.evaluate((n) => {
    const table = document.querySelector(".panel.table").getBoundingClientRect();
    const all = [...document.querySelectorAll(".list > .row")];
    const last = all[Math.min(n || all.length, all.length) - 1].getBoundingClientRect();
    return { top: Math.max(0, Math.round(table.top + scrollY - 16)), bottom: Math.round(last.bottom + scrollY + 1) };
  }, rows);

// ------------------------------------------------------------ sdk-session (serve)
// One coding-sh-triage run: the issue as its title and turn, the model call with its
// tokens and cost selected, and the answer. The pane's payload and stored blob are internals.
if (want("sdk-session")) for (const [w, h, m, name] of [[DESK_W, 900, false, "sdk-session"], [390, 844, true, "sdk-session-m"]]) {
  const { page, ctx } = await openSession(serve, "Viewer search misses tool output", "LLM call", w, h, m);
  await hideAll(page, [...SESSION_CHROME, "#event-pane .pane-top"]);
  await dropFacts(page, /^(started|latency)$/);
  await hidePayload(page);
  await sleep(200);
  await hideText(page, "button, summary, a", /^More details$/);
  const paneBottom = await textBottom(page, "#event-pane");
  const stepsBottom = await page.evaluate(() => [...document.querySelectorAll(".st")].pop().getBoundingClientRect().bottom + scrollY);
  const paneTop = await page.evaluate(() => document.querySelector("#event-pane").getBoundingClientRect().top + scrollY);
  if (paneTop < stepsBottom) {
    await shot(page, name, { x: 0, y: 0, width: w, height: Math.round(Math.max(paneBottom, stepsBottom) + 24) });
  } else {
    // At this width the pane sits under the step list, which keeps its own height: the title, facts
    // and steps, then the selected call's numbers, joined by a thin rule.
    await stitch(page, name, [
      { x: 0, y: 0, width: w, height: Math.round(stepsBottom + 8) },
      { x: 0, y: Math.round(paneTop), width: w, height: Math.round(paneBottom + 16 - paneTop) },
    ]);
  }
  await ctx.close();
}

// ------------------------------------------------------------ sessions-list (ui)
// The local viewer's list: today's newest 5 sessions from Claude Code, Codex and OpenCode.
if (want("sessions-list")) for (const [w, h, m, name, rows] of [[DESK_W, 1200, false, "sessions-list", 5], [390, 1400, true, "sessions-list-m", 5]]) {
  const { page, ctx } = await open(new URL("#/", ui), w, h, m);
  await page.waitForSelector(".list > .row");
  await listOnly(page);
  const r = await listRect(page, rows);
  await shot(page, name, { x: 0, y: r.top, width: w, height: r.bottom - r.top });
  await ctx.close();
}

// ------------------------------------------------------------ replay-diff (ui)
// The OpenCode session that fixes the Antigravity title, with its edit selected and the diff shown.
if (want("replay-diff")) for (const [w, h, m, name] of [[1100, 900, false, "replay-diff"], [390, 844, true, "replay-diff-m"]]) {
  const { page, ctx } = await openSession(ui, "Fix the Antigravity adapter's session title", "antigravity.ts", w, h, m);
  // The edit step: the first step that names the file and is not the read.
  await page.evaluate(() => {
    const st = [...document.querySelectorAll(".st")].filter((r) => r.innerText.includes("antigravity.ts"));
    const edit = st.find((r) => /edit/i.test(r.innerText)) || st[1] || st[0];
    edit.click();
  });
  await page.waitForFunction(() => document.querySelector("#event-pane .diff"), { timeout: 10000 });
  await hideAll(page, [...SESSION_CHROME, "#event-pane .pane-top", "#event-pane .badges .badge.mono"]);
  await dropFacts(page, /^(started|latency|tokens|snapshot)$/);
  await hidePayload(page);
  await hideText(page, "button, summary, a", /^More details$/);
  await sleep(200);
  const bottom = await page.evaluate((m) => {
    const diff = document.querySelector("#event-pane .diff").getBoundingClientRect().bottom;
    const steps = m ? 0 : [...document.querySelectorAll(".st")].pop().getBoundingClientRect().bottom;
    return Math.max(diff, steps) + scrollY + 20;
  }, m);
  await shot(page, name, { x: 0, y: 0, width: w, height: Math.round(bottom) });
  await ctx.close();
}

// ------------------------------------------------------------ compare (ui)
// agents-md-today vs agents-md-rewrite: the verdict, the pass rates with the interval, and the
// cases that changed. The experiment ids are looked up by name, so the URL never shows in a frame.
if (want("compare")) {
  const { page, ctx } = await open(new URL("#/experiments", ui), 1000, 900, false);
  const ids = await page.evaluate(async () => {
    const r = await fetch("/api/experiments").then((x) => x.json());
    const newest = (n) => r.items.filter((e) => e.name === n).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]?.id;
    return [newest("agents-md-today"), newest("agents-md-rewrite")];
  });
  if (!ids[0] || !ids[1]) throw new Error("run seed-docs.mjs first: no agents-md-today / agents-md-rewrite experiments");
  await ctx.close();
  const hash = `#/experiments/${encodeURIComponent(ids[0])}/vs/${encodeURIComponent(ids[1])}`;
  for (const [w, h, m, name] of [[1000, 1400, false, "compare"], [390, 1600, true, "compare-m"]]) {
    const { page, ctx } = await open(new URL(hash, ui), w, h, m);
    await page.waitForSelector(".verdict");
    await page.waitForFunction(() => document.querySelectorAll(".list > .row, .list .row").length > 0, { timeout: 10000 });
    await hideAll(page, [".topbar", ".crumbs", ".hintbar"]);
    // The graders section repeats the verdict for the one grader; the cases follow the verdict directly.
    await page.evaluate(() => {
      const head = [...document.querySelectorAll(".section-head")].find((s) => s.querySelector("h2")?.textContent === "Graders");
      if (head) for (const el of [head, head.nextElementSibling]) (el.hidden = true, el.style.setProperty("display", "none", "important"));
    });
    await sleep(200);
    const r = await page.evaluate((m) => {
      const v = document.querySelector(".verdict").getBoundingClientRect();
      const rows = [...document.querySelectorAll(".list .row")];
      const last = rows[Math.min(rows.length, 3) - 1].getBoundingClientRect();
      // The cases panel ends at its border; the page prints a stray "null" just below it.
      const panel = rows[0].closest(".panel")?.getBoundingClientRect();
      const bottom = m ? v.bottom + 12 : Math.min(last.bottom + 20, (panel?.bottom ?? last.bottom) + 2);
      return { top: v.top + scrollY - (m ? 12 : 20), bottom: bottom + scrollY };
    }, m);
    await shot(page, name, { x: 0, y: Math.round(r.top), width: w, height: Math.round(r.bottom - r.top) });
    await ctx.close();
  }
}

// ------------------------------------------------------------ team-list (team serve)
// The team server's list: sessions sent from two people's machines with --remote-mode full.
if (want("team-list")) for (const [w, h, m, name] of [[1100, 1000, false, "team-list"], [390, 1200, true, "team-list-m"]]) {
  const { page, ctx } = await open(team, w, h, m);
  await page.waitForSelector(".list > .row");
  await listOnly(page);
  const r = await listRect(page);
  await shot(page, name, { x: 0, y: r.top, width: w, height: r.bottom - r.top });
  await ctx.close();
}

await browser.close();
