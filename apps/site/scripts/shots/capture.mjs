// Screenshots the real viewer for the landing page. Run seed.mjs first, then:
//
//   node scripts/shots/capture.mjs <ui url with ?t=…> <serve url> [outDir]
//
// Uses its own headless Chrome (puppeteer-core + the system Chrome), so it never
// shares tabs with anyone else's browser. Writes 2x WebP files to
// src/assets/product/ (Astro's image pipeline resizes them at build time).
// The viewer's own layout is shot as is: the only change is hiding the update
// pill, and each state is reached by clicking, like a person would.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const [uiArg, serveArg, outArg] = process.argv.slice(2);
if (!uiArg || !serveArg) {
  console.error("usage: node scripts/shots/capture.mjs <ui url> <serve url> [outDir]");
  process.exit(2);
}
const OUT = resolve(outArg || join(here, "../../src/assets/product"));
mkdirSync(OUT, { recursive: true });
const ui = new URL(uiArg);
const serve = new URL(serveArg);
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
  // The viewer's CSP blocks injected styles: hide the update pill the way the viewer does.
  await page.evaluate(() => { const u = document.querySelector("#update"); if (u) u.hidden = true; });
  if ((await page.evaluate(() => innerWidth)) !== width) throw new Error(`viewport is not ${width} wide`);
  return { page, ctx };
}

/** Saves a page-coordinate rect (CSS px) as a 2x WebP. */
async function shot(page, name, rect, quality = 82) {
  await sleep(250);
  const png = await page.screenshot({ type: "png", clip: { ...rect, scale: 1 }, captureBeyondViewport: true });
  const file = join(OUT, name + ".webp");
  const info = await sharp(png).webp({ quality, effort: 6 }).toFile(file);
  console.log(`${name}.webp ${info.width}x${info.height} ${(info.size / 1024).toFixed(0)} KB`);
}

const rectOf = (page, sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
  }, sel);

// ------------------------------------------------------------ session (hero + record)
/**
 * Staging for the landing crops. The viewer's layout and data stay as they
 * are; these only take out what a picture can't offer or a first-time visitor
 * cannot read, by setting `hidden` the way the update pill is hidden:
 * - the controls (the top bar's tabs and search, the back link, the step
 *   toolbar with its find box, toggles and failure pager), because a control
 *   in a screenshot looks like it should work and doesn't;
 * - the internals (the session UUID, latency and token rows, the eval command
 *   with the UUID, the tool-use id chip, the event names).
 * `brief` also drops the model and repo rows, for the phone crop.
 * Nothing is added or reworded.
 */
async function stage(page, { brief = false } = {}) {
  await page.evaluate((brief) => {
    const hide = (el) => el && (el.hidden = true, el.style.setProperty("display", "none", "important"));
    document.querySelectorAll(".topbar, .crumbs, .detail-head .actions, .hintbar, .tl-tools").forEach(hide);
    const drop = brief ? /^(latency|tokens|started|snapshot|model|repo)$/ : /^(latency|tokens|started|snapshot)$/;
    document.querySelectorAll(".facts > div").forEach((d) => {
      if (drop.test(d.querySelector("dt")?.textContent?.trim() || "")) hide(d);
    });
    const pane = document.querySelector("#event-pane");
    if (pane) {
      hide(pane.querySelector(".pane-top"));
      pane.querySelectorAll(".badges .badge.mono").forEach(hide);
    }
  }, brief);
  await sleep(150);
}

/** Opens the hero session, selects its failed test run and scrolls it to row `above + 1`. */
async function openHero(width, height, mobile, { above = 4, brief = false } = {}) {
  const o = await open(new URL("#/", ui), width, height, mobile);
  const { page } = o;
  await page.waitForFunction(() => [...document.querySelectorAll(".row")].some((r) => r.innerText.includes("Apply each SQLite migration once")), { timeout: 15000 });
  // Click the session in the list, then its failed step.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll(".row")].find((r) => r.innerText.includes("Apply each SQLite migration once"));
    row.click();
  });
  await page.waitForSelector(".st");
  await page.waitForFunction(() => !document.body.innerText.includes("Loading"));
  await page.evaluate(() => document.querySelector(".st.is-fail").click());
  await page.waitForFunction(() => document.querySelector("#event-pane .pane-title")?.textContent.includes("npm test"));
  await stage(page, { brief });
  // Scroll the step list (its own scroller) the way a person would after
  // clicking the failure: a few steps before it, the failure, then the fix.
  await page.evaluate((above) => {
    // Rows are virtualized (translateY inside .tl-inner), so measure, not offsetTop.
    const tl = document.querySelector(".tl");
    const fail = document.querySelector(".st.is-fail");
    const y = fail.getBoundingClientRect().top - tl.querySelector(".tl-inner").getBoundingClientRect().top;
    tl.scrollTop = y - above * fail.offsetHeight;
    scrollTo(0, 0);
  }, above);
  await sleep(300);
  return o;
}

/** Document rect of the line in `sel` that contains `text`. */
const lineRect = (page, sel, text) =>
  page.evaluate((s, t) => {
    const root = document.querySelector(s);
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.data.indexOf(t);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + t.length);
      const rects = [...r.getClientRects()];
      return { top: Math.min(...rects.map((x) => x.top)) + scrollY, bottom: Math.max(...rects.map((x) => x.bottom)) + scrollY };
    }
    throw new Error("no line with " + t);
  }, sel, text);

/** Document y of the bottom of the `n`th step row after the failed one. */
const rowsBelowFail = (page, n) =>
  page.evaluate((n) => {
    const fail = document.querySelector(".st.is-fail").getBoundingClientRect();
    return Math.round(fail.bottom + n * fail.height + scrollY);
  }, n);

/**
 * Stacks several document-coordinate rects of one page into one image, with a
 * thin rule between them (the parts that matter, without the scroll between).
 */
async function stitch(page, name, rects, bg, quality = 82) {
  await sleep(250);
  const parts = [];
  for (const r of rects) parts.push(await sharp(await page.screenshot({ type: "png", clip: { ...r, scale: 1 }, captureBeyondViewport: false })).toBuffer());
  const metas = await Promise.all(parts.map((p) => sharp(p).metadata()));
  const W = Math.max(...metas.map((m) => m.width));
  const RULE = 2;
  const H = metas.reduce((h, m) => h + m.height, 0) + RULE * (parts.length - 1);
  let y = 0;
  const comp = [];
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

{
  // Desktop hero: the session's title, facts and chips, then its steps, in
  // the viewer's one-column layout (860 wide), so the picture is the run
  // itself: the red failed test, then the fix and the green rerun. The
  // failed step's output is the Record section's picture, not this one's.
  const { page, ctx } = await openHero(860, 1000, false, { above: 4 });
  const bottom = await rowsBelowFail(page, 7);
  await shot(page, "hero-session", { x: 0, y: 0, width: 860, height: bottom + 1 }, 82);
  await ctx.close();
}
{
  // Phone hero: title, agent, duration and cost, the chips, then the steps
  // around the failed run.
  const { page, ctx } = await openHero(390, 844, true, { above: 2, brief: true });
  const bottom = await rowsBelowFail(page, 2);
  await shot(page, "hero-session-m", { x: 0, y: 0, width: 390, height: bottom + 1 }, 80);
  await ctx.close();
}

/**
 * Record: the failed step's title, then only the lines of its output that say
 * why (the failed test, the error, where it was thrown), which the viewer
 * tints red. The startup lines and the passing tests are left out of the crop.
 */
async function record(width, name) {
  const { page, ctx } = await openHero(width, 3600, width < 640);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.evaluate(() => {
    const pane = document.querySelector("#event-pane");
    pane.querySelector(".pane-title").id = "shot-title";
    pane.querySelector(".pane-title + .badges").id = "shot-badges";
    const out = [...pane.querySelectorAll("pre")].pop();
    out.classList.add("wrap-lines");
    out.id = "shot-out";
  });
  await sleep(200);
  const pane = await rectOf(page, "#event-pane");
  const title = await docRect(page, "#shot-title|#shot-badges", { padTop: 16, padBottom: 16 });
  const out = await rectOf(page, "#shot-out");
  const from = await lineRect(page, "#shot-out", "✖ applies");
  const to = await lineRect(page, "#shot-out", "sqlite.ts:428:17)");
  const PAD = 14;
  await stitch(page, name, [
    { x: pane.x, y: title.y, width: pane.width, height: title.height },
    // Inside the output box's edge, so the excerpt reads as one tinted block.
    { x: pane.x, y: Math.round(from.top - PAD), width: pane.width, height: Math.round(to.bottom - from.top + 2 * PAD), clipX: [out.x + 1, out.x + out.width - 1] },
  ].map(({ clipX, ...r }) => (clipX ? { ...r, x: clipX[0], width: clipX[1] - clipX[0] } : r)), bg);
  await ctx.close();
}

const docRect = (page, sel, opts = {}) =>
  page.evaluate((s, o) => {
    const els = s.split("|").map((x) => document.querySelector(x));
    const rs = els.map((e) => e.getBoundingClientRect());
    const top = Math.min(...rs.map((r) => r.top)) + scrollY - (o.padTop ?? 0);
    const bottom = Math.max(...rs.map((r) => r.bottom)) + scrollY + (o.padBottom ?? 0);
    const left = Math.min(...rs.map((r) => r.left));
    const right = Math.max(...rs.map((r) => r.right));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, sel, opts);

// 1272 wide puts the pane at the landing column's width (about 578px), so the
// picture shows at 1:1. 430 is a large phone: the error lines wrap less.
await record(1272, "record-failure");
await record(430, "record-failure-m");

// ------------------------------------------------------------ production (serve)
// The request list from its "Sessions" heading down: desktop 6 rows, phones 3
// (the failed run is the second), so the section stays about one screen tall.
// The facets and the chart above the heading are left out of the crop.
for (const [w, h, m, name, rows] of [[660, 900, false, "production-requests", 6], [390, 844, true, "production-requests-m", 3]]) {
  const { page, ctx } = await open(new URL("#/", serve), w, h, m);
  await page.waitForSelector(".row");
  // Staging, as for the session: hide the keyboard hints, the search box (a
  // control), the agent and model filters and the "Sessions over time" chart,
  // so the crop is the heading and the requests.
  await page.evaluate(() => {
    const hide = (el) => el && (el.hidden = true, el.style.setProperty("display", "none", "important"));
    document.querySelectorAll(".topbar, .hintbar").forEach(hide);
    hide(document.querySelector(".panel.hist"));
    hide(document.querySelector(".facets"));
  });
  await sleep(150);
  const r = await page.evaluate((n) => {
    const head = [...document.querySelectorAll("main h1, main h2, #view h1, #view h2")].find((x) => x.textContent.trim() === "Sessions");
    const all = [...document.querySelectorAll(".row")];
    const last = all[Math.min(n, all.length) - 1].getBoundingClientRect();
    return { top: head.getBoundingClientRect().top - 20 + scrollY, bottom: last.bottom + scrollY };
  }, rows);
  const top = Math.round(r.top);
  await shot(page, name, { x: 0, y: top, width: w, height: Math.round(r.bottom + 1 - top) });
  await ctx.close();
}

await browser.close();
