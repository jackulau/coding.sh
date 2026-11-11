// Screenshots the real viewer for the README (viewer-sessions.png, viewer-session.png) and the
// banner (banner-session.png) from the sessions sample-sessions.mjs writes (see its header for
// the whole run). 1280x800 at 2x, dark:
//
//   node .github/assets/capture-readme.mjs <ui url>   # the full URL `coding.sh ui` prints, with ?t=
//
// Uses its own headless Chrome (puppeteer-core + the system Chrome; set CHROME for another
// binary), so it never shares tabs with anyone else's browser. The only staging is hiding the
// update pill; each state is reached by clicking, like a person would.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2];
if (!url) {
  console.error("usage: node .github/assets/capture-readme.mjs <ui url>");
  process.exit(2);
}
// 256-color PNGs: the dark UI quantizes without visible loss at under 60% of the bytes.
const PNG = { palette: true, quality: 100, effort: 10, compressionLevel: 9, dither: 0 };
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--hide-scrollbars"] });
try {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }]);
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelectorAll("[role=option]").length >= 10 && document.querySelector(".sum-cost"), { timeout: 15000 });
  await page.evaluate(() => { const u = document.querySelector("#update"); if (u) u.hidden = true; });
  const save = async (name) => {
    await sleep(400);
    await sharp(await page.screenshot({ type: "png" })).removeAlpha().png(PNG).toFile(join(here, name));
    console.log("wrote .github/assets/" + name);
  };
  await save("viewer-sessions.png");

  // Session 1 (the newest Claude Code session), then its file change.
  await page.evaluate(() => [...document.querySelectorAll("[role=option]")].find((r) => r.innerText.includes("prints NaN for cache hits")).click());
  await page.waitForSelector("#steps .st");
  await page.evaluate(() => [...document.querySelectorAll("#steps .st")].find((s) => s.querySelector(".name")?.textContent === "Changed").click());
  await page.waitForFunction(() => document.querySelector("#event-pane .diff, #event-pane pre"));
  await page.evaluate(() => { const u = document.querySelector("#update"); if (u) u.hidden = true; });
  await save("viewer-session.png");

  // The banner's picture (banner-session.png, for banner.html): the session that raised the OTLP
  // body limit, in the viewer's one-column layout (860 wide). Its head (title, facts, chips) and
  // its steps from the first edit on are stacked with a thin rule between them, as the site's
  // shots do. Like the site's hero shot, controls and internals (the top bar, back link, step
  // toolbar, key hints, latency, token and start rows) are hidden; nothing is added or reworded.
  const narrow = await browser.newPage();
  await narrow.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }]);
  await narrow.setViewport({ width: 860, height: 1000, deviceScaleFactor: 2 });
  await narrow.goto(url, { waitUntil: "networkidle0" });
  await narrow.waitForFunction(() => document.querySelectorAll("[role=option]").length >= 10, { timeout: 15000 });
  await narrow.evaluate(() => [...document.querySelectorAll("[role=option]")].find((r) => r.innerText.includes("OTLP receiver body limit")).click());
  await narrow.waitForSelector("#steps .st");
  await narrow.evaluate(() => {
    const hide = (el) => el && (el.hidden = true, el.style.setProperty("display", "none", "important"));
    document.querySelectorAll("#update, .topbar, .crumbs, .detail-head .actions, .hintbar, .tl-tools").forEach(hide);
    document.querySelectorAll(".facts > div").forEach((d) => { if (/^(latency|tokens|started|snapshot)$/.test(d.querySelector("dt")?.textContent?.trim() || "")) hide(d); });
  });
  await sleep(400);
  // 852 wide, like the site's hero: the timeline's scroll track at the right edge reads as stray dots.
  const [head, steps] = await narrow.evaluate(() => {
    const rows = [...document.querySelectorAll("#steps .st")];
    const first = rows.find((s) => s.querySelector(".name")?.textContent === "Edit").getBoundingClientRect();
    const h = document.querySelector(".detail-head").getBoundingClientRect();
    return [{ x: 0, y: 0, width: 852, height: Math.round(h.bottom) }, { x: 0, y: Math.round(first.top), width: 852, height: Math.round(6 * first.height) }];
  });
  const parts = [];
  for (const clip of [head, steps]) parts.push(await narrow.screenshot({ type: "png", clip: { ...clip, scale: 1 } }));
  const RULE = 2, H = 2 * (head.height + steps.height) + RULE;
  await sharp({ create: { width: 2 * 852, height: H, channels: 3, background: "#2a2a2e" } })
    .composite([{ input: parts[0], top: 0, left: 0 }, { input: parts[1], top: 2 * head.height + RULE, left: 0 }])
    .png(PNG).toFile(join(here, "banner-session.png"));
  console.log("wrote .github/assets/banner-session.png");
} finally {
  await browser.close();
}
