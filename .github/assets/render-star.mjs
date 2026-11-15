// Renders star.html to star.gif (1000x250 at 1.5x) for the README's "Star the Repository" section.
// The page is a drawing with a seek(t) function; this steps it frame by frame, so the take is the
// same every time. Run from the repo root:
//
//   node .github/assets/render-star.mjs
//
// Needs ffmpeg on PATH. Uses puppeteer-core with the system Chrome; set CHROME for another binary.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FPS = 20;

const out = mkdtempSync(join(tmpdir(), "star-"));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--hide-scrollbars", "--allow-file-access-from-files", "--use-mock-keychain", "--password-store=basic"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 250, deviceScaleFactor: 1.5 });
  await page.goto(`${pathToFileURL(join(here, "star.html")).href}?still`, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.DURATION);
  const frames = Math.round(duration * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => new Promise((done) => { window.seek(t); requestAnimationFrame(() => requestAnimationFrame(done)); }), i / FPS);
    await page.screenshot({ path: join(out, `f${String(i).padStart(3, "0")}.png`), clip: { x: 0, y: 0, width: 1000, height: 250 } });
  }
  const gif = join(here, "star.gif");
  const filter = "split[a][b];[a]palettegen=max_colors=64:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(out, "f%03d.png"), "-vf", filter, "-loop", "0", gif]);
  console.log(`wrote .github/assets/star.gif (${statSync(gif).size} bytes, ${frames} frames)`);
} finally {
  await browser.close();
  rmSync(out, { recursive: true, force: true });
}
