// Records agents-flow.gif for the README: the front page's "Every agent, one record" diagram
// (apps/site/src/landing/flow.html), taken from the page itself. On the site the columns move with
// the scroll offset, so the take scrolls the page down and back up once and screenshots the diagram
// at each step. Nothing on the page is changed or restyled. Dark, 1000x476 at 1.5x.
//
//   node .github/assets/capture-flow.mjs [url]   # default https://coding.sh/
//
// Needs ffmpeg on PATH. Uses its own headless Chrome (puppeteer-core + the system Chrome; set
// CHROME for another binary). For a local build, pass the URL `npm run preview` prints.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "https://coding.sh/";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const W = 1000, SCALE = Number(process.env.SCALE) || 1.5; // the diagram is 968 wide; the stage's sides hold only grid
const TRIM = 4;                   // px off the bottom: the stage's border and the row the fade leaves above it
const FPS = 15;
const TRAVEL = 560;               // px of page scroll each way
const MOVE = 3.8, HOLD = 1.2;     // seconds: one way, then a rest at each end
// Every clip edge is an even CSS pixel, so each frame is the same whole number of device pixels.
const even = (n) => 2 * Math.round(n / 2);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); // no overshoot

const out = mkdtempSync(join(tmpdir(), "flow-"));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-first-run", "--hide-scrollbars", "--use-mock-keychain", "--password-store=basic"],
});
try {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "no-preference" }]);
  // A tall window, so the whole diagram stays in view for the full travel.
  await page.setViewport({ width: 1280, height: 2000, deviceScaleFactor: SCALE });
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-flow] .f-flow__col:nth-child(3)");
  await page.evaluate(() => document.fonts.ready);
  const stage = await page.evaluate(() => {
    const r = document.querySelector("[data-flow]").getBoundingClientRect();
    return { left: r.left, top: r.top + scrollY, width: r.width, height: r.height };
  });
  const steps = Math.round(MOVE * FPS);
  const frame = (i) => join(out, `f${String(i).padStart(3, "0")}.png`);
  for (let i = 0; i <= steps; i++) {
    const y = even(ease(i / steps) * TRAVEL);
    await page.evaluate((y) => new Promise((done) => {
      scrollTo(0, y);
      // The page places the columns in an animation frame after the scroll event.
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)));
    }), y);
    await page.screenshot({
      path: frame(i),
      captureBeyondViewport: false,
      // The clip is in page coordinates, so it stays put while the page scrolls under it.
      clip: { x: even(stage.left + (stage.width - W) / 2), y: even(stage.top), width: W, height: even(stage.height) - TRIM },
    });
  }
  // Down, rest, back up, rest. The way back reuses the frames, as scrolling back does on the page.
  // A rest is the same frame repeated, which costs a GIF almost nothing.
  const rest = Math.round(HOLD * FPS);
  const order = [];
  for (let i = 0; i <= steps; i++) order.push(i);
  for (let k = 1; k < rest; k++) order.push(steps);
  for (let i = steps - 1; i >= 0; i--) order.push(i);
  for (let k = 1; k < rest; k++) order.push(0);
  order.forEach((i, n) => symlinkSync(frame(i), join(out, `s${String(n).padStart(3, "0")}.png`)));
  const gif = join(here, "agents-flow.gif");
  const filter = "split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(out, "s%03d.png"), "-vf", filter, "-loop", "0", gif]);
  console.log(`wrote .github/assets/agents-flow.gif (${statSync(gif).size} bytes, ${order.length} frames)`);
} finally {
  await browser.close();
  rmSync(out, { recursive: true, force: true });
}
