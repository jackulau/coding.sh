#!/usr/bin/env node
// One perf sample of a built site: serve it (scripts/perf/serve.mjs), run
// Lighthouse on fixed pages under two profiles, print one JSON object of
// numbers on stdout. It is the metric command for `coding.sh exp metrics`
// (scripts/perf/ab.mjs), which repeats it in interleaved pairs and does the
// statistics.
//
//   node scripts/perf/lighthouse.mjs --dir <built-site> [--profile desktop|mobile]... [--page name|/path]... [--reports <dir>]
//
// Pages default to coding.sh's five (PAGES below). Any site works with --page
// /path: the metrics are then keyed by the path ("/" is "home", "/docs/intro"
// is "docs-intro").
//
// Profiles:
//   desktop  1350x940, no network or CPU throttling.
//   mobile   412x823, Slow 4G: 150 ms RTT, 1.6 Mbps down, 750 Kbps up, 4x CPU.
//            Applied by Chrome ("devtools" throttling), so the custom mark below
//            is throttled too. Lighthouse's mobileSlow4G constants: Chrome's
//            per-request latency is RTT x 3.75 and throughput x 0.9, its
//            documented adjustment for request-level throttling.
// Every page loads in a fresh Chrome with a fresh profile, and Lighthouse resets
// storage first: empty cache, no service worker.
//
// Per page and profile (keys "<profile>.<page>.<metric>"):
//   fcp_ms lcp_ms tbt_ms cls ttfb_ms   Lighthouse's observed metrics
//   dcl_ms   observed DOMContentLoaded (module scripts have run)
//   js_bytes css_bytes html_bytes font_bytes img_bytes   encoded body bytes by resource type
//   startup_requests   requests started before the load event
//   first_viewer_row_ms   home only: the "first-viewer-row" performance mark,
//                         set when the hero viewer screenshot is painted
//                         (apps/site/src/pages/index.astro)
//   cpu_busy   share of the machine's CPU time (all cores, every process: this
//              sample's Chrome too) that was busy while the page was measured,
//              0 to 1. The timings mean little on a busy machine; ab.mjs checks
//              the _ms budgets on quiet samples only.
// Chrome: $CHROME_PATH, else Playwright's Chromium (npx playwright install
// chromium), else whatever chrome-launcher finds.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "./serve.mjs";

export const PAGES = { home: "/", quickstart: "/docs/quickstart", evals: "/docs/evals", changelog: "/changelog", cli: "/docs/cli" };
const MARK = "first-viewer-row";

async function deps() {
  try {
    const lighthouse = (await import("lighthouse")).default;
    const constants = await import("lighthouse/core/config/constants.js");
    const chromeLauncher = await import("chrome-launcher");
    return { lighthouse, constants, chromeLauncher };
  } catch (e) {
    console.error(`lighthouse is not installed (${e.message}). It is a devDependency of apps/site: run npm install at the repo root.`);
    process.exit(1);
  }
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium"]) {
      const p = join(root, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

function settings(profile, constants) {
  const common = { onlyCategories: ["performance"], output: "json", disableFullPageScreenshot: true };
  if (profile === "desktop") {
    return {
      ...common,
      formFactor: "desktop",
      screenEmulation: constants.screenEmulationMetrics.desktop,
      emulatedUserAgent: constants.userAgents.desktop,
      throttlingMethod: "provided",
      throttling: { rttMs: 0, throughputKbps: 0, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0, cpuSlowdownMultiplier: 1 },
    };
  }
  const t = constants.throttling.mobileSlow4G;
  if (t.rttMs !== 150 || t.cpuSlowdownMultiplier !== 4 || Math.round(t.throughputKbps) !== 1638) throw new Error(`Lighthouse's mobileSlow4G changed: ${JSON.stringify(t)}`);
  return {
    ...common,
    formFactor: "mobile",
    screenEmulation: constants.screenEmulationMetrics.mobile,
    emulatedUserAgent: constants.userAgents.mobile,
    throttlingMethod: "devtools",
    throttling: { ...t, uploadThroughputKbps: 750 * 0.9 },
  };
}

/** Busy and total CPU time over every core so far (ms). */
function cpuTimes() {
  let busy = 0;
  let total = 0;
  for (const { times: t } of cpus()) {
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

const r1 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 10) / 10 : undefined);

/** The numbers we keep from one Lighthouse result. */
export function extract(lhr, page, served) {
  if (lhr.runtimeError) throw new Error(`Lighthouse: ${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
  const a = lhr.audits;
  const num = (id) => a[id]?.numericValue;
  const m = a.metrics?.details?.items?.[0] ?? {};
  const reqs = a["network-requests"]?.details?.items ?? [];
  if (!reqs.length) throw new Error("Lighthouse recorded no network requests");
  // Encoded body bytes as the server sent them (served(path) lists each response's size). Lighthouse's
  // transferSize adds HTTP/2 header bytes, which wobble by a few bytes with HPACK state.
  const queues = new Map();
  const bodyOf = (r) => {
    let path;
    try {
      path = decodeURIComponent(new URL(r.url).pathname);
    } catch {
      return r.transferSize ?? 0;
    }
    if (!served) return r.transferSize ?? 0;
    if (!queues.has(path)) queues.set(path, [...served(path)]);
    const next = queues.get(path).shift();
    return next ?? r.transferSize ?? 0;
  };
  const sizes = new Map(reqs.map((r) => [r, bodyOf(r)]));
  if (process.env.PERF_DEBUG) for (const [r, b] of sizes) console.error(`  ${r.resourceType} body ${b} transfer ${r.transferSize} ${r.url}`);
  const bytes = (types) => reqs.filter((r) => types.includes(r.resourceType)).reduce((s, r) => s + sizes.get(r), 0);
  // network-requests times and the metrics' observed* times share the navigation's time origin.
  const load = m.observedLoad;
  const out = {
    fcp_ms: r1(num("first-contentful-paint")),
    lcp_ms: r1(num("largest-contentful-paint")),
    tbt_ms: r1(num("total-blocking-time")),
    cls: typeof num("cumulative-layout-shift") === "number" ? Math.round(num("cumulative-layout-shift") * 10_000) / 10_000 : undefined,
    ttfb_ms: r1(m.timeToFirstByte ?? num("server-response-time")),
    dcl_ms: r1(m.observedDomContentLoaded),
    js_bytes: bytes(["Script"]),
    css_bytes: bytes(["Stylesheet"]),
    html_bytes: bytes(["Document"]),
    font_bytes: bytes(["Font"]),
    img_bytes: bytes(["Image"]),
    startup_requests: typeof load === "number" ? reqs.filter((r) => (r.rendererStartTime ?? r.networkRequestTime ?? Infinity) <= load).length : undefined,
  };
  if (page === "home") {
    const mark = (a["user-timings"]?.details?.items ?? []).find((i) => i.name === MARK && i.timingType === "Mark");
    if (mark) out.first_viewer_row_ms = r1(mark.startTime);
    else console.error(`warning: no "${MARK}" mark on ${page}; first_viewer_row_ms left out`);
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      profile: { type: "string", multiple: true },
      page: { type: "string", multiple: true },
      reports: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !values.dir) {
    console.error("usage: node scripts/perf/lighthouse.mjs --dir <built-site> [--profile desktop|mobile]... [--page home|quickstart|evals|changelog|cli|/path]... [--reports <dir>]");
    process.exit(values.help ? 0 : 2);
  }
  const profiles = values.profile?.length ? values.profile : ["desktop", "mobile"];
  for (const p of profiles) if (p !== "desktop" && p !== "mobile") throw new Error(`unknown profile ${p}; use desktop or mobile`);
  const targets = {};
  for (const p of values.page?.length ? values.page : Object.keys(PAGES)) {
    if (PAGES[p]) targets[p] = PAGES[p];
    else if (p.startsWith("/")) targets[p === "/" ? "home" : p.replace(/^\/+|\/+$/g, "").replace(/[^\w-]+/g, "-")] = p;
    else throw new Error(`unknown page ${p}; use ${Object.keys(PAGES).join(", ")} or a /path`);
  }
  const pages = Object.keys(targets);
  const { lighthouse, constants, chromeLauncher } = await deps();
  const server = await serve(values.dir);
  const reports = values.reports ? resolve(values.reports) : undefined;
  if (reports) mkdirSync(reports, { recursive: true });
  const chrome = chromePath();
  const result = {};
  try {
    for (const profile of profiles) {
      const config = { extends: "lighthouse:default", settings: settings(profile, constants) };
      result[profile] = {};
      for (const page of pages) {
        const url = server.origin + targets[page];
        // Our own profile dir: a fresh, empty profile per page. Under WSL chrome-launcher rewrites
        // --user-data-dir to a Windows path, which a Linux Chrome takes as a relative dir in the cwd,
        // so the flag is repeated with the real path (Chrome keeps the last one).
        const userDataDir = mkdtempSync(join(tmpdir(), "csh-perf-chrome-"));
        const browser = await chromeLauncher.launch({
          ...(chrome ? { chromePath: chrome } : {}),
          userDataDir,
          chromeFlags: ["--headless=new", "--no-sandbox", "--ignore-certificate-errors", "--disable-dev-shm-usage", "--no-first-run", "--mute-audio", `--user-data-dir=${userDataDir}`],
        });
        const t0 = Date.now();
        try {
          server.reset();
          const c0 = cpuTimes();
          const run = await lighthouse(url, { port: browser.port, output: "json", logLevel: "error" }, config);
          const c1 = cpuTimes();
          if (!run?.lhr) throw new Error(`Lighthouse returned nothing for ${url}`);
          if (reports) writeFileSync(join(reports, `${profile}-${page}.json`), JSON.stringify(run.lhr));
          result[profile][page] = extract(run.lhr, page, server.served);
          if (c1.total > c0.total) result[profile][page].cpu_busy = Math.round(((c1.busy - c0.busy) / (c1.total - c0.total)) * 100) / 100;
        } finally {
          await browser.kill();
          rmSync(userDataDir, { recursive: true, force: true });
        }
        console.error(`${profile} ${page}: ${Math.round((Date.now() - t0) / 100) / 10}s`);
      }
    }
  } finally {
    await server.close();
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  // Lighthouse and Chrome can leave handles open; the answer is out, so leave.
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
