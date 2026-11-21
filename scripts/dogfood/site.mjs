#!/usr/bin/env node
// Site scores (docs/design/dogfood.md §3.4).
//
//   site.js          gzip bytes of JS shipped on / (apps/site/dist), following static imports
//   site.lighthouse  min category score over desktop + mobile (the site's devDependency lighthouse, else one on
//   site.vitals      PATH, plus Chrome; the scorer never downloads it), against `astro preview` on 127.0.0.1:4329
//   site.council     not automated here: it needs the council members (see docs) and is skipped
//
//   node scripts/dogfood/site.mjs [js|lighthouse]... [--json]
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { browserEnv, findLighthouse, LIGHTHOUSE_HINT, lighthouseReport, log, parseArgs, runLighthouse, SITE } from "./lib/util.mjs";
import { isMain } from "./lib/main.mjs";

export const SITE_TARGETS = {
  jsKb: 60,
  lighthouse: { performance: 0.95, accessibility: 1.0, "best-practices": 0.95, seo: 1.0 },
  vitals: { lcpMs: 2000, cls: 0.02, tbtMs: 100 },
};

/** Collect the JS a page loads: <script src>, inline <script>, modulepreload links, then static imports transitively. */
export function siteJs({ dist = join(SITE, "dist"), page = "index.html" } = {}) {
  const html = readFileSync(join(dist, page), "utf8");
  const files = new Map();
  let inlineBytes = 0;
  let inlineGzip = 0;
  const queue = [];
  const add = (src, from) => {
    if (!src || /^(https?:)?\/\//.test(src) || src.startsWith("data:")) return;
    const p = src.startsWith("/") ? join(dist, src) : resolve(from, src);
    const n = normalize(p.split(/[?#]/)[0]);
    if (!files.has(n) && existsSync(n)) {
      files.set(n, null);
      queue.push(n);
    }
  };
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    const type = /type=["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    if (type && !/module|javascript/i.test(type)) continue; // JSON-LD etc. is not JS
    const src = /src=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (src) add(src, dist);
    else if (m[2].trim()) {
      inlineBytes += Buffer.byteLength(m[2]);
      inlineGzip += gzipSync(m[2]).length;
      for (const im of m[2].matchAll(/(?:import|from)\s*["']([^"']+\.m?js)["']/g)) add(im[1], dist);
    }
  }
  for (const m of html.matchAll(/<link\b[^>]*rel=["']modulepreload["'][^>]*>/gi)) add(/href=["']([^"']+)["']/i.exec(m[0])?.[1], dist);
  while (queue.length) {
    const f = queue.shift();
    const src = readFileSync(f, "utf8");
    files.set(f, { bytes: Buffer.byteLength(src), gzip: gzipSync(src).length });
    for (const im of src.matchAll(/(?:^|[;\s}])(?:import|export)\s*(?:[\w*{}\s,$]+from\s*)?["']([^"']+\.m?js)["']/g)) add(im[1], dirname(f));
  }
  const gzip = [...files.values()].reduce((a, v) => a + v.gzip, 0) + inlineGzip;
  return { value: gzip, kb: Math.round((gzip / 1024) * 10) / 10, target: SITE_TARGETS.jsKb * 1024, files: [...files.entries()].map(([f, v]) => ({ file: f.slice(dist.length + 1), ...v })), inline: { bytes: inlineBytes, gzip: inlineGzip } };
}

/**
 * site.lighthouse and site.vitals. A machine without the lighthouse CLI or without Chrome gets
 * { value: null, skipped } naming what is missing; a lighthouse run that fails otherwise gets
 * { value: null, error }. The scorer never downloads lighthouse (no npx).
 */
export async function siteLighthouse({ port = 4329, lighthouse = findLighthouse() } = {}) {
  const lh = lighthouse;
  if (!lh) return { value: null, skipped: `lighthouse CLI not found: ${LIGHTHOUSE_HINT}` };
  // astro's own entry run with this node: npx is a .cmd shim on Windows, which spawn cannot start without a shell.
  const astro = join(dirname(createRequire(join(SITE, "package.json")).resolve("astro/package.json")), "astro.js");
  const preview = spawn(process.execPath, [astro, "preview", "--host", "127.0.0.1", "--port", String(port)], { cwd: SITE, stdio: "ignore" });
  preview.on("error", () => {});
  try {
    const url = `http://127.0.0.1:${port}/`;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(url)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    const runs = {};
    for (const [name, extra] of [["mobile", []], ["desktop", ["--preset=desktop"]]]) {
      const r = runLighthouse(lh, [url, "--output=json", "--quiet", "--chrome-flags=--headless=new", ...extra], { env: browserEnv(), timeout: 300_000 });
      try {
        runs[name] = lighthouseReport(r);
      } catch (e) {
        return e.missing ? { value: null, skipped: `${e.missing} not found for lighthouse (${e.message})` } : { value: null, error: e.message, lighthouse: lh.source };
      }
    }
    const cats = Object.fromEntries(Object.entries(runs).map(([k, rep]) => [k, Object.fromEntries(Object.entries(rep.categories).map(([c, v]) => [c, v.score]))]));
    const m = runs.mobile.audits;
    const vitals = { lcpMs: m["largest-contentful-paint"].numericValue, cls: m["cumulative-layout-shift"].numericValue, tbtMs: m["total-blocking-time"].numericValue };
    const T = SITE_TARGETS.lighthouse;
    const budgets = [cats.mobile.performance >= T.performance, ...["accessibility", "best-practices", "seo"].flatMap((c) => [cats.mobile[c] >= T[c], cats.desktop[c] >= T[c]])];
    const vb = [vitals.lcpMs <= SITE_TARGETS.vitals.lcpMs, vitals.cls <= SITE_TARGETS.vitals.cls, vitals.tbtMs <= SITE_TARGETS.vitals.tbtMs];
    return { value: Math.min(...Object.values(cats.mobile), ...Object.values(cats.desktop)), lighthouse: lh.source, categories: cats, vitals, lighthouseMet: budgets.every(Boolean), vitalsMet: vb.every(Boolean) };
  } finally {
    preview.kill("SIGTERM");
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2), { booleans: ["json"] });
  const which = args._.length ? args._ : ["js", "lighthouse"];
  const out = {};
  if (which.includes("js")) out["site.js"] = siteJs();
  if (which.includes("lighthouse")) out["site.lighthouse"] = await siteLighthouse();
  if (!args.json) log(`site.js ${out["site.js"]?.kb} KB gzip`);
  process.stdout.write(JSON.stringify(out, null, args.json ? 0 : 2) + "\n");
}
