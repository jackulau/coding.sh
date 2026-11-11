// The site keeps the shape the user set in tasks/lessons.md. Each rule is a
// check on the source and on the built site (dist) when there is a build:
//   top nav is Docs and Changelog only; no Human/Agent toggle; the Works-with
//   carousel names agents that have an adapter and no generic chip; no "acme";
//   no tiers; the cube brand mark and the favicon; no dev host and port in a
//   screenshot frame or window title; sameAs pinned and no brand org links;
//   every package names github.com/jackulau/coding.sh as its repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { distOpts, needDist } from "./_dist.mjs";

const SITE = fileURLToPath(new URL("../", import.meta.url));
const ROOT = join(SITE, "../../");
const DIST = join(SITE, "dist");
const read = (p, base = SITE) => readFileSync(join(base, p), "utf8");
const TEXT = new Set([".astro", ".ts", ".mjs", ".js", ".md", ".mdx", ".html", ".css", ".json", ".xml", ".txt", ""]);

function walk(dir) {
  const abs = join(SITE, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return ["node_modules", "pagefind", ".astro"].includes(e.name) ? [] : walk(rel);
    return TEXT.has(extname(e.name)) ? [rel] : [];
  });
}
const srcFiles = () => [...walk("src"), ...walk("scripts"), ...walk("worker")].filter((f) => !f.endsWith(".test.mjs"));
const distFiles = () => walk("dist").filter((f) => f.endsWith(".html"));

/** "file:line: text" for each line of files that matches re. */
function hits(files, re) {
  return files.flatMap((f) => read(f).split("\n").flatMap((l, i) => (re.test(l) ? [`${f}:${i + 1}: ${l.trim().slice(0, 140)}`] : [])));
}

// ---- the rules, each as a function a seeded string can be run through ----

/** The labels of the top nav's links in a built page ([] when the page has no primary nav). */
export function primaryNavLabels(html) {
  const nav = /<nav aria-label="Primary"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1];
  return nav ? [...nav.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim()) : [];
}
/** Labels in the LINKS array of Nav.astro. */
export const navSourceLabels = (astro) => [...(/const LINKS = \[([\s\S]*?)\n\];/.exec(astro)?.[1] ?? "").matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]);

export const TOGGLE = /ViewToggle|data-viewtog|\?view=(?:human|agent)|view-agent|Human\s*\/\s*Agent/;
export const ACME = /\bacme\b/i;
export const TIER = /\btier[- ]?[abc]\b|\btier:\s*["'][abc]["']|<th>\s*Tier\s*<\/th>/i;
export const DEV_HOST = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}/;
export const BRAND_ORG = /github\.com\/(?:codingdotsh|coding-sh|codingsh)\b|(?:x|twitter)\.com\/(?:codingdotsh|coding_sh|codingsh)\b|linkedin\.com\/company\/coding/i;
export const GENERIC_CHIP = /\b(?:any|other|generic|otel|opentelemetry)\b/i;

/** Dev host and port in the text of a Shot bar or a Terminal title. */
export function devHostInFrames(src) {
  const found = [];
  for (const m of src.matchAll(/<(?:Shot|Terminal)\b[^>]*?\b(?:bar|title)=(?:"([^"]*)"|\{`([^`]*)`\})/g)) if (DEV_HOST.test(m[1] ?? m[2])) found.push(m[1] ?? m[2]);
  for (const m of src.matchAll(/class="(?:shot__bar|shot__title|term__bar|term__title)"[^>]*>([^<]*)/g)) if (DEV_HOST.test(m[1])) found.push(m[1]);
  return found;
}

/** WORKS_WITH entries of the landing page. */
export const worksWith = (astro) => [...(/const WORKS_WITH = \[([\s\S]*?)\n\];/.exec(astro)?.[1] ?? "").matchAll(/id:\s*"([^"]+)",\s*name:\s*"([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2] }));

// ---- seeded bad examples ----

test("each rule catches its seeded bad example", () => {
  assert.deepEqual(primaryNavLabels('<nav aria-label="Primary"><a href="/docs">Docs</a><a href="/agents">Agents</a></nav>'), ["Docs", "Agents"]);
  assert.deepEqual(navSourceLabels('const LINKS = [\n  { href: "/docs", label: "Docs" },\n  { href: "/agents", label: "Agents" },\n];'), ["Docs", "Agents"]);
  assert.ok(TOGGLE.test('<button data-viewtog="agent">'));
  assert.ok(ACME.test("acme-corp/api"));
  assert.ok(TIER.test("<th>Tier</th>") && TIER.test("Tier B"));
  assert.deepEqual(devHostInFrames('<Shot bar="localhost:4319" />'), ["localhost:4319"]);
  assert.deepEqual(devHostInFrames('<Terminal title="127.0.0.1:4318/v1" />'), ["127.0.0.1:4318/v1"]);
  assert.deepEqual(devHostInFrames('<span class="term__title">~/coding.sh</span>'), []);
  assert.ok(BRAND_ORG.test("https://github.com/codingdotsh/coding.sh"));
  assert.ok(GENERIC_CHIP.test("Any OTel agent"));
  const chips = worksWith('const WORKS_WITH = [\n  { id: "claude-code", name: "Claude Code" },\n  { id: "otel", name: "Any OTel agent" },\n];');
  assert.deepEqual(chips.map((c) => c.id), ["claude-code", "otel"]);
});

// ---- source ----

test("the top nav is Docs and Changelog", () => {
  assert.deepEqual(navSourceLabels(read("src/components/Nav.astro")), ["Docs", "Changelog"]);
});

test("no Human/Agent toggle in the source", () => {
  assert.deepEqual(hits(srcFiles(), TOGGLE), []);
});

test("the Works-with carousel names agents that have an adapter, and no generic chip", () => {
  const rows = worksWith(read("src/pages/index.astro"));
  assert.ok(rows.length >= 8, "WORKS_WITH not parsed");
  const agents = read("src/components/docs/agents.ts");
  const adapters = new Set([...agents.matchAll(/^\s*id:\s*"([^"]+)"/gm)].map((m) => m[1]));
  adapters.delete("wrapper");
  const planned = (/PLANNED_AGENTS\s*=\s*\[([^\]]*)\]/.exec(agents)?.[1] ?? "").match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1).toLowerCase()) ?? [];
  const notAgents = rows.filter((r) => !adapters.has(r.id) && !planned.some((p) => p.startsWith(r.name.toLowerCase().split(" ")[0])));
  assert.deepEqual(notAgents, [], "A chip with no adapter and not in PLANNED_AGENTS");
  assert.deepEqual(rows.filter((r) => GENERIC_CHIP.test(r.name)), [], "no generic or OpenTelemetry chip");
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "a chip is listed twice");
});

test("no acme in the site source, the screenshot scripts or the built site", () => {
  assert.deepEqual(hits(srcFiles().filter((f) => !f.endsWith("clean-text.mjs")), ACME), []);
});

test("no tiers on the site", () => {
  assert.deepEqual(hits(srcFiles(), TIER), []);
});

test("no screenshot frame or window title names a dev host and port", () => {
  const found = srcFiles().filter((f) => f.endsWith(".astro")).flatMap((f) => devHostInFrames(read(f)).map((t) => `${f}: ${t}`));
  assert.deepEqual(found, []);
});

test("sameAs is pinned and no link goes to a brand org", () => {
  const site = read("src/data/site.ts");
  assert.match(site, /export const SAME_AS = \[REPO_URL, NPM_URL, NPM_ORG_URL\] as const;/, "SAME_AS changed; the pinned list is the repo, the npm package and the npm scope");
  assert.match(site, /export const REPO_URL = "https:\/\/github\.com\/jackulau\/coding\.sh"/);
  assert.deepEqual(hits(srcFiles(), BRAND_ORG), []);
});

test("every package names github.com/jackulau/coding.sh as its repository", () => {
  const bad = [];
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    const pkg = join(ROOT, "packages", dir, "package.json");
    if (existsSync(pkg)) {
      const repo = JSON.parse(readFileSync(pkg, "utf8")).repository;
      const url = typeof repo === "string" ? repo : repo?.url;
      if (!url || !/github\.com\/jackulau\/coding\.sh(?:\.git)?$/.test(url)) bad.push(`packages/${dir}/package.json: ${url}`);
    }
  }
  const py = join(ROOT, "packages/sdk-python/pyproject.toml");
  if (existsSync(py)) {
    const url = /^Repository\s*=\s*"([^"]+)"/m.exec(readFileSync(py, "utf8"))?.[1];
    if (url !== "https://github.com/jackulau/coding.sh") bad.push(`packages/sdk-python/pyproject.toml: ${url}`);
  }
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).repository;
  if (rootPkg && !/github\.com\/jackulau\/coding\.sh/.test(typeof rootPkg === "string" ? rootPkg : rootPkg.url)) bad.push(`package.json: ${JSON.stringify(rootPkg)}`);
  assert.deepEqual(bad, []);
});

// ---- the built site ----

const built = distOpts(join(DIST, "index.html"));

test("every built page has the top nav Docs and Changelog only, no toggle, no acme, no tiers", built, () => {
  needDist(join(DIST, "index.html"));
  const problems = [];
  for (const f of distFiles()) {
    const html = read(f);
    const labels = primaryNavLabels(html);
    if (labels.length && JSON.stringify(labels) !== JSON.stringify(["Docs", "Changelog"])) problems.push(`${f}: top nav is ${labels.join(", ")}`);
    for (const [name, re] of [["a toggle", TOGGLE], ["acme", ACME], ["a tier", TIER], ["a brand org link", BRAND_ORG]]) {
      const m = re.exec(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, ""));
      if (m) problems.push(`${f}: ${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the built landing has the cube brand mark, the favicon, and no dev host in a frame", built, () => {
  needDist(join(DIST, "index.html"));
  const html = read("dist/index.html");
  assert.match(html, /<a href="\/" class="nav__home"[^>]*>\s*<svg class="mark"/, "the nav lost the cube brand mark");
  assert.match(html, /<link rel="icon" href="\/favicon\.ico"/);
  for (const f of ["public/favicon.ico", "public/favicon.svg", "public/apple-touch-icon.png"]) assert.ok(existsSync(join(SITE, f)), `${f} is missing`);
  assert.deepEqual(devHostInFrames(html), []);
});
