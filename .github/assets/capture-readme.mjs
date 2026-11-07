// Screenshots the real viewer for the README (viewer-sessions.png, viewer-session.png) from the
// sessions sample-sessions.mjs writes (see its header for the whole run). 1280x800 at 2x, dark:
//
//   node .github/assets/capture-readme.mjs <ui url>
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
    await sharp(await page.screenshot({ type: "png" })).removeAlpha().png({ compressionLevel: 9 }).toFile(join(here, name));
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
} finally {
  await browser.close();
}
