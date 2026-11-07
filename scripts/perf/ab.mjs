#!/usr/bin/env node
// Site perf A/B through `coding.sh exp metrics` (dogfood): arm A serves the
// baseline build, arm B the candidate build, and each run is one
// scripts/perf/lighthouse.mjs sample. The pairs are interleaved and the stats
// (medians, paired bootstrap CI, Holm-corrected sign test) come from coding.sh.
//
//   node scripts/perf/ab.mjs --base <dir> --cand <dir> [--pairs 11] [--warmup 1]
//        [--out result.json] [--baseline baseline.json] [--profile mobile] [--page home] [--seed N] [--fail-on-worse]
//        [--gate] [--budgets scripts/perf/budgets.json] [--skip-budget '*_ms']...
//
// --out writes the full exp result (every run included). --baseline writes the
// per-metric medians over all runs plus the run-to-run noise of the paired
// deltas: use it with --base and --cand set to the same build (an A/A run),
// where every metric should come out inconclusive.
// --gate (CI) fails when a gated metric's verdict is worse. The gated metrics
// (GATE below) are re-analysed on their own, so the Holm correction spans only
// them and 9 pairs can call a change. HTML and image bytes are left to the
// budgets: every new paragraph adds HTML, and a fixed build makes any added byte
// a "worse" verdict. --budgets fails when the candidate's median of a metric is
// over its budget; --skip-budget drops matching budgets (hosted runners skip
// the machine-dependent _ms ones).
// Exit code: coding.sh's (0 ok, 1 runs failed or --fail-on-worse tripped, 2 usage),
// or 1 when the gate or a budget fails.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "packages/coding.sh/src/cli/main.ts");
const HARNESS = join(ROOT, "scripts/perf/lighthouse.mjs");
const GATE = ["mobile.*.lcp_ms", "mobile.*.cls", "*.js_bytes", "*.font_bytes", "*.css_bytes", "mobile.*.startup_requests"];

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    cand: { type: "string" },
    pairs: { type: "string", default: "11" },
    warmup: { type: "string", default: "1" },
    out: { type: "string" },
    baseline: { type: "string" },
    profile: { type: "string", multiple: true },
    page: { type: "string", multiple: true },
    seed: { type: "string" },
    "fail-on-worse": { type: "boolean" },
    gate: { type: "boolean" },
    budgets: { type: "string" },
    "skip-budget": { type: "string", multiple: true },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help || !values.base || !values.cand) {
  console.error("usage: node scripts/perf/ab.mjs --base <dir> --cand <dir> [--pairs 11] [--warmup 1] [--out result.json] [--baseline baseline.json] [--profile p]... [--page p]... [--seed N] [--fail-on-worse] [--gate] [--budgets file] [--skip-budget pattern]...");
  process.exit(values.help ? 0 : 2);
}
const base = resolve(values.base);
const cand = resolve(values.cand);
for (const d of [base, cand]) {
  if (!existsSync(join(d, "index.html"))) {
    console.error(`${d} has no index.html: build the site first (cd apps/site && npm run build)`);
    process.exit(2);
  }
}

const extra = [...(values.profile ?? []).flatMap((p) => ["--profile", p]), ...(values.page ?? []).flatMap((p) => ["--page", p])];
// A JSON task spec, so paths with spaces need no shell quoting. 15 minutes per sample at most.
const arm = (name, dir) => `${name}=${JSON.stringify({ kind: "command", command: process.execPath, args: [HARNESS, "--dir", dir, ...extra], timeoutMs: 900_000 })}`;
const args = [
  "--no-warnings",
  CLI,
  "exp",
  "metrics",
  "--arm",
  arm("base", base),
  "--arm",
  arm("cand", cand),
  "--pairs",
  values.pairs,
  "--warmup",
  values.warmup,
  "--name",
  base === cand ? "site-perf-aa" : "site-perf",
  ...(values.seed ? ["--seed", values.seed] : []),
  ...(values["fail-on-worse"] ? ["--fail-on-worse"] : []),
  "--json",
];
const r = spawnSync(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
if (r.error) throw r.error;
let doc;
try {
  doc = JSON.parse(r.stdout);
} catch {
  process.stdout.write(r.stdout);
  process.exit(r.status ?? 1);
}
const result = doc.experiment;
if (values.out) {
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(resolve(values.out), `${JSON.stringify(result, null, 2)}\n`);
}
const { renderMetrics, analyzeMetrics, metricMatches } = await import(join(ROOT, "packages/coding.sh/src/experiments/metrics.ts"));
process.stdout.write(`${renderMetrics(result, { color: process.stdout.isTTY === true })}\n`);

const failures = [];
if (values.gate) {
  const gated = analyzeMetrics(result.runs, { only: GATE, correction: result.correction, alpha: result.alpha, seed: result.seed });
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  for (const m of gated.metrics.filter((x) => x.verdict === "worse")) {
    const ci = m.deterministic ? "every run" : `95% CI [${r4(m.delta.lo)}, ${r4(m.delta.hi)}], p ${m.pAdjusted.toFixed(3)}`;
    failures.push(`${m.name} got worse: ${m.a.median} -> ${m.b.median} (${ci})`);
  }
  console.log(`gate: ${gated.metrics.length} gated metrics over ${gated.pairsComplete} pairs, ${failures.length} worse`);
}
if (values.budgets) {
  const budgets = JSON.parse(readFileSync(resolve(values.budgets), "utf8"));
  const skip = values["skip-budget"] ?? [];
  let checked = 0;
  for (const [pattern, max] of Object.entries(budgets)) {
    if (pattern.startsWith("$") || metricMatches(pattern, skip)) continue;
    const hits = result.metrics.filter((m) => metricMatches(m.name, [pattern]));
    for (const m of hits) {
      checked++;
      if (m.b.median > max) failures.push(`${m.name} is ${m.b.median}, budget ${max} (${pattern})`);
    }
  }
  console.log(`budgets: ${checked} checked`);
}
for (const f of failures) console.log(`${process.env.GITHUB_ACTIONS ? "::error::perf: " : "FAIL "}${f}`);

if (values.baseline) {
  const { median, stddev } = await import(join(ROOT, "packages/coding.sh/src/stats/summary.ts"));
  const runs = result.runs.filter((x) => !x.warmup && x.metrics);
  const metrics = {};
  for (const m of result.metrics) {
    const all = runs.map((x) => x.metrics[m.name]).filter((v) => typeof v === "number");
    const diffs = [];
    for (let p = 1; p <= result.pairs; p++) {
      const [a, b] = [0, 1].map((arm) => runs.find((x) => x.pair === p && x.arm === arm)?.metrics[m.name]);
      if (typeof a === "number" && typeof b === "number") diffs.push(b - a);
    }
    metrics[m.name] = {
      median: median(all),
      n: all.length,
      min: Math.min(...all),
      max: Math.max(...all),
      unit: m.unit,
      better: m.better,
      // Run-to-run noise: SD of the paired A/A deltas, and the shift 11 pairs could detect.
      pairedDeltaSd: diffs.length >= 2 ? stddev(diffs) : null,
      mde: Number.isFinite(m.mde) ? m.mde : null,
      aaVerdict: m.verdict,
    };
  }
  const out = {
    createdAt: new Date().toISOString(),
    build: base,
    experiment: { id: result.id, name: result.name, pairs: result.pairs, pairsComplete: result.summary.pairsComplete, seed: result.seed, correction: result.correction },
    aa: base === cand ? { clean: result.summary.better === 0 && result.summary.worse === 0, ...result.summary } : null,
    metrics,
  };
  mkdirSync(dirname(resolve(values.baseline)), { recursive: true });
  writeFileSync(resolve(values.baseline), `${JSON.stringify(out, null, 2)}\n`);
  console.error(`baseline medians written to ${resolve(values.baseline)}`);
}
process.exit(r.status === null ? 1 : r.status || (failures.length ? 1 : 0));
