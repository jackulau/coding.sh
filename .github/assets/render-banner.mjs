// Renders banner.html to banner.png (1280x640 at 2x = 2560x1280) for the README.
// Uses puppeteer-core with the system Chrome and sharp, both already in the repo's
// node_modules after `npm ci`. Run from the repo root:
//
//   node .github/assets/render-banner.mjs
//
// Set CHROME to another Chrome or Chromium binary if it isn't in /Applications.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--hide-scrollbars", "--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(join(here, "banner.html")).href, { waitUntil: "networkidle0" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode()));
  });
  const el = await page.$("#banner");
  const shot = await el.screenshot({ type: "png" });
  // Opaque background, so drop the alpha channel; sharp writes no metadata by default.
  await sharp(shot).removeAlpha().png({ compressionLevel: 9 }).toFile(join(here, "banner.png"));
  console.log("wrote .github/assets/banner.png");
} finally {
  await browser.close();
}
