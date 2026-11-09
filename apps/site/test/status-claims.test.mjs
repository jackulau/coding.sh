// Status claims on the site and in docs/ must match the code. A page may call
// something "planned" (a <Tag status="planned" />, "(planned)", "not
// implemented yet", "not built yet", a design doc's "Status: design") only while the feature is
// missing from packages/coding.sh. Each claim has to name a feature in
// FEATURES, and each feature has a check that says whether it is built, so a
// page that still says "planned" after the module lands fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CORE = "packages/coding.sh";

const has = (p) => existsSync(join(ROOT, p));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const contains = (p, s) => has(p) && read(p).includes(s);

/** Files under dir (relative to the repo root) whose path passes keep. */
function walk(dir, keep = () => true) {
  const out = [];
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") out.push(...walk(rel, keep));
    } else if (keep(rel)) out.push(rel);
  }
  return out;
}

const registry = () => read(`${CORE}/src/cli/registry.ts`);
const adapterFiles = () => walk(`${CORE}/src/adapters`, (p) => p.endsWith(".ts")).map((p) => basename(p).toLowerCase());

/**
 * Every feature a page may still call planned. `match` finds the feature in
 * the text around a claim; `built` checks the code. Keep a feature here while
 * it is a real gap; when its module lands, the pages that call it planned fail.
 */
export const FEATURES = [
  {
    id: "tool-evals",
    match: /tool[- ]evals?\b|toolevals/i,
    built: () => has(`${CORE}/src/toolevals/index.ts`) && has(`${CORE}/test/toolevals`) && registry().includes('name: "toolevals"'),
  },
  {
    id: "workflows",
    match: /\bworkflows?\b/i,
    built: () => has(`${CORE}/src/workflows/cli-spec.ts`) && has(`${CORE}/test/workflows`),
  },
  {
    id: "npm-package",
    match: /npm package|\bon npm\b|\bpublished\b/i,
    // coding.sh and every package in PUBLISHED_ON_NPM are on the registry.
    built: () => true,
  },
  {
    // R2-A1 in tasks/research-queue.md.
    id: "kiro-adapter",
    match: /\bkiro\b/i,
    built: () => adapterFiles().some((f) => f.includes("kiro")),
  },
  {
    // PLAN-2: a JSON Schema for coding.sh/trace.
    id: "trace-json-schema",
    match: /JSON Schema/i,
    built: () =>
      walk(`${CORE}/src/schema`).some((p) => /json/i.test(basename(p))) || walk(`${CORE}/schema`).some((p) => p.endsWith(".json")),
  },
  {
    // AB-5: events from the OTLP receiver reach the configured sinks.
    id: "otlp-sink-mirror",
    match: /(OTLP|receiver)[^.]*\b(mirror\w*|sinks?)\b|\b(mirror\w*|sinks?)\b[^.]*(OTLP|receiver)/i,
    built: () => has(`${CORE}/src/server/mirror.ts`) && contains(`${CORE}/src/cli/commands/collector.ts`, "SinkMirror"),
  },
  {
    // B-1: `coding.sh bench` as the one noun over eval/exp/compare, plus `coding.sh try`.
    id: "bench-wrapper",
    match: /\bbench\b/i,
    built: () => registry().includes('name: "try"'),
  },
];

/** Packages from this repo that are on npm (checked with `npm view <name> version`, 2026-11-08). */
export const PUBLISHED_ON_NPM = ["coding.sh", "@codingdotsh/sdk", "coding.sh-store-postgres", "coding.sh-store-s3", "coding.sh-store-clickhouse"];

/** Phrases that say a published npm package is not published. The Python SDK on PyPI is still unpublished, so "not on PyPI" is fine. */
const STALE = [
  /not (?:yet )?(?:on|in) npm/i,
  /not on npm or PyPI/i,
  /\bnot published yet\b/i,
  /nothing is published yet/i,
  /None of these packages are on npm/i,
  /The name is reserved in/i,
];

const MARKERS = [
  /<Tag\s+status="planned"/,
  /\(planned\)/i,
  /\bplanned, not implemented\b/i,
  /\bnot implemented yet\b/i,
  /\bnot built yet\b/i,
  /\bdesign spec, not implemented\b/i,
  /^Status: (?:design|plan)\b/,
];

/** Planned claims in text: each with its line number and the lines around it. */
export function findMarkers(text) {
  const lines = text.split("\n");
  const found = [];
  lines.forEach((line, i) => {
    if (!MARKERS.some((re) => re.test(line))) return;
    const context = lines.slice(Math.max(0, i - 2), i + 2).join(" ");
    found.push({ line: i + 1, text: line.trim(), context });
  });
  return found;
}

/** The site source and the docs the site renders or links to (research notes are left out). */
function scannedFiles() {
  const site = walk("apps/site/src", (p) => /\.(astro|ts|mjs|md|mdx)$/.test(p));
  const docs = walk("docs", (p) => p.endsWith(".md") && !p.startsWith(join("docs", "research")));
  return [...site, ...docs, "README.md"].filter(has);
}

test("findMarkers finds planned claims and keeps the lines around them", () => {
  const text = ["<tr>", "  <td>Trace format JSON Schema</td>", '  <td><Tag status="planned" /></td>', "  <td>Not yet.</td>", "</tr>"].join("\n");
  const [m] = findMarkers(text);
  assert.equal(m.line, 3);
  assert.match(m.context, /JSON Schema/);
  assert.deepEqual(findMarkers("Status: design, queued.\nfoo").map((x) => x.line), [1]);
  assert.deepEqual(findMarkers("a few planned points; a planned edit"), []);
});

test("nothing built is called planned", () => {
  const built = new Map(FEATURES.map((f) => [f.id, f.built()]));
  const problems = [];
  for (const file of scannedFiles()) {
    for (const m of findMarkers(read(file))) {
      const features = FEATURES.filter((f) => f.match.test(m.context));
      const where = `${relative(ROOT, join(ROOT, file))}:${m.line}: ${m.text.slice(0, 120)}`;
      if (features.length === 0) problems.push(`${where}\n    names no feature in FEATURES (apps/site/test/status-claims.test.mjs); add it with a check, or drop the claim`);
      else if (features.every((f) => built.get(f.id)))
        problems.push(`${where}\n    calls ${features.map((f) => f.id).join(", ")} planned, but the code is there; tag it built or partial`);
    }
  }
  assert.deepEqual(problems, [], `Stale planned claims:\n${problems.join("\n")}`);
});

test("no page says a published npm package is unpublished", () => {
  const problems = [];
  for (const file of scannedFiles()) {
    read(file)
      .split("\n")
      .forEach((line, i) => {
        if (STALE.some((re) => re.test(line))) problems.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
  }
  assert.deepEqual(problems, [], `Stale publish claims:\n${problems.join("\n")}`);
});

test("every npm package in the repo is in PUBLISHED_ON_NPM", () => {
  const names = readdirSync(join(ROOT, "packages"))
    .map((dir) => join("packages", dir, "package.json"))
    .filter(has)
    .map((p) => JSON.parse(read(p)))
    .filter((pkg) => !pkg.private)
    .map((pkg) => pkg.name);
  const missing = names.filter((n) => !PUBLISHED_ON_NPM.includes(n));
  assert.deepEqual(missing, [], "A new npm package: publish it, or say on the site that it is not on npm and allow that here");
});

/** Display names whose adapter file is not named after their first word. */
const ADAPTER_SLUG = { "Factory Droid": "droid" };

/** True when src/adapters has a file named after the agent's first word ("Kiro CLI" -> kiro). */
const hasAdapter = (name) => {
  const slug = ADAPTER_SLUG[name] ?? name.split(/\s+/)[0].toLowerCase();
  return adapterFiles().some((f) => f.includes(slug));
};

test("agents listed as planned have no adapter", () => {
  const src = read("apps/site/src/components/docs/agents.ts");
  const list = src.match(/PLANNED_AGENTS\s*=\s*\[([^\]]*)\]/);
  assert.ok(list, "PLANNED_AGENTS not found in components/docs/agents.ts");
  const names = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names.filter(hasAdapter), [], "These agents have an adapter now: move them from PLANNED_AGENTS to ADAPTER_ROWS");
});

test("data/agents.ts calls an agent planned exactly when it has no adapter", () => {
  const rows = [...read("apps/site/src/data/agents.ts").matchAll(/\{\s*name:\s*"([^"]+)"[^}]*status:\s*"([^"]+)"/g)].map((m) => ({ name: m[1], status: m[2] }));
  assert.ok(rows.length > 5, "no rows parsed from data/agents.ts");
  const named = rows.filter((r) => r.name !== "anything else");
  const stale = named.filter((r) => r.status === "planned" && hasAdapter(r.name)).map((r) => r.name);
  const missing = named.filter((r) => r.status !== "planned" && !hasAdapter(r.name)).map((r) => r.name);
  assert.deepEqual(stale, [], "These agents have an adapter now: mark them supported");
  assert.deepEqual(missing, [], "These agents have no adapter in src/adapters: mark them planned");
});
