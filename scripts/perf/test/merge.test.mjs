// Run: node --no-warnings --test scripts/perf/test/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeMetrics, pairOrder } from "../../../packages/coding.sh/src/experiments/metrics.ts";
import { checkGate } from "../gate.mjs";
import { PAGES, PROFILES } from "../lighthouse.mjs";
import { mergeResults } from "../merge.mjs";

const AB = fileURLToPath(new URL("../ab.mjs", import.meta.url));
const PREFIXES = PROFILES.flatMap((profile) => Object.keys(PAGES).map((page) => `${profile}.${page}`));
const SEED = 7;
const PAIRS = 9;

// One run of every page and profile, as a single `ab.mjs --pairs 9 --warmup 1` writes it: a
// warm-up round, then the pairs in the seed's arm order. Mobile home LCP is 80 ms slower on the
// candidate; the other timings only wobble.
function full() {
  let tick = 0;
  const sample = (arm) => {
    const m = {};
    for (const prefix of PREFIXES) {
      const wobble = (tick++ * 37) % 23;
      m[`${prefix}.lcp_ms`] = 1600 + wobble + (arm === 1 && prefix === "mobile.home" ? 80 : 0);
      m[`${prefix}.js_bytes`] = 5400;
      m[`${prefix}.cpu_busy`] = 0.2;
    }
    return m;
  };
  const jobs = [
    { pair: 0, arm: 0 },
    { pair: 0, arm: 1 },
    ...pairOrder(PAIRS, SEED).flatMap((o, i) => (o === "AB" ? [0, 1] : [1, 0]).map((arm) => ({ pair: i + 1, arm }))),
  ];
  const runs = jobs.map((j, i) => {
    const run = { ...j, startedAt: 1000 + i, durationMs: 150, metrics: sample(j.arm) };
    if (j.pair === 0) run.warmup = true;
    return run;
  });
  const ref = (dir) => `node scripts/perf/lighthouse.mjs --dir ${dir}`;
  return {
    id: "mexp_test",
    name: "site-perf",
    status: "completed",
    createdAt: 1000,
    finishedAt: 5000,
    seed: SEED,
    pairs: PAIRS,
    warmup: 1,
    arms: [
      { name: "base", task: { kind: "command", ref: ref("/tmp/base-dist") } },
      { name: "cand", task: { kind: "command", ref: ref("/tmp/head-dist") } },
    ],
    order: pairOrder(PAIRS, SEED),
    runs,
    alpha: 0.05,
    correction: "holm",
    metrics: analyzeMetrics(runs, { seed: SEED }).metrics,
  };
}

// What `ab.mjs --part --page <page>` writes: the same runs with that page's metrics only, under
// both profiles.
const PARTS = Object.keys(PAGES);
function part(whole, page) {
  return {
    ...whole,
    arms: whole.arms.map((a) => ({ ...a, task: { ...a.task, ref: `${a.task.ref} --page ${page}` } })),
    runs: whole.runs.map((r) => ({ ...r, durationMs: 30, metrics: Object.fromEntries(Object.entries(r.metrics).filter(([k]) => k.split(".")[1] === page)) })),
    metrics: [],
  };
}

test("parts by page merge into the result one run would have written", () => {
  const whole = full();
  const { result, missing } = mergeResults(PARTS.map((p) => part(whole, p)), { expect: PREFIXES });
  assert.deepEqual(missing, []);
  assert.deepEqual(result.metrics, whole.metrics, "the same statistics, one Holm family");
  assert.deepEqual(result.runs.map((r) => [r.pair, r.arm, r.warmup, r.metrics]), whole.runs.map((r) => [r.pair, r.arm, r.warmup, r.metrics]));
  assert.equal(result.runs[0].durationMs, 150, "a run's time is the sum over its parts");
  // 10 load times (one worse, nine in the noise) and 20 metrics that never move.
  assert.deepEqual(result.summary, { better: 0, worse: 1, same: 20, inconclusive: 9, pairsComplete: 9, failedRuns: 0 });
  assert.equal(result.arms[0].task.ref, whole.arms[0].task.ref, "the arm is named without a part's page and profile");
  const [gate, wholeGate] = [checkGate(result), checkGate(whole)];
  assert.deepEqual(gate, wholeGate);
  assert.equal(gate.failures.length, 1);
  assert.match(gate.failures[0], /^mobile\.home\.lcp_ms got worse/);
});

test("a page with no part is reported as missing under each profile", () => {
  const whole = full();
  const parts = PARTS.filter((p) => p !== "cli").map((p) => part(whole, p));
  assert.deepEqual(mergeResults(parts, { expect: PREFIXES }).missing, ["desktop.cli", "mobile.cli"]);
});

test("a failed sample in one part drops its pair from every metric", () => {
  const whole = full();
  const parts = PARTS.map((p) => part(whole, p));
  const bad = parts[3].runs.findIndex((r) => r.pair === 4);
  parts[3].runs[bad] = { pair: 4, arm: parts[3].runs[bad].arm, startedAt: 0, durationMs: 1, error: "Lighthouse: NO_FCP" };
  const { result } = mergeResults(parts, { expect: PREFIXES });
  assert.equal(result.summary.failedRuns, 1);
  assert.equal(result.summary.pairsComplete, 8);
  assert.equal(result.runs[bad].error, "Lighthouse: NO_FCP");
  assert.equal(result.runs[bad].metrics, undefined);
  assert.ok(result.metrics.every((m) => m.n === 8));
});

test("parts of different experiments do not merge", () => {
  const whole = full();
  const two = () => [part(whole, "home"), part(whole, "cli")];
  let parts = two();
  parts[1].seed = 8;
  assert.throws(() => mergeResults(parts), /disagree on the seed/);
  parts = two();
  parts[1].runs.pop();
  assert.throws(() => mergeResults(parts), /stopped early: 19 of 20 runs/);
  parts = two();
  parts[1].arms[1].name = "other";
  assert.throws(() => mergeResults(parts), /disagree on the arms/);
  assert.throws(() => mergeResults([part(whole, "home"), part(whole, "home")]), /two parts measured desktop\.home\./);
  assert.throws(() => mergeResults([]), /no parts/);
});

test("ab.mjs --merge gates the merged parts and fails when a part is missing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "csh-perf-merge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const whole = full();
  const files = PARTS.map((p) => {
    const f = join(dir, `${p}.json`);
    writeFileSync(f, JSON.stringify(part(whole, p)));
    return f;
  });
  const run = (args) => spawnSync(process.execPath, ["--no-warnings", AB, "--merge", ...args], { encoding: "utf8" });

  const out = join(dir, "result.json");
  const all = run(["--gate", "--out", out, ...files]);
  assert.equal(all.status, 1, all.stderr);
  assert.match(all.stdout, /FAIL mobile\.home\.lcp_ms got worse/);
  assert.match(all.stdout, /gate: \d+ gated metrics over 9 pairs, 1 worse/);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")).metrics, JSON.parse(JSON.stringify(whole.metrics)));

  // Without the regressed page the gate has nothing to fail on, and the missing part fails the run.
  const some = run(["--gate", ...files.filter((f) => !f.endsWith("home.json"))]);
  assert.equal(some.status, 1, some.stderr);
  assert.match(some.stdout, /gate: \d+ gated metrics over 9 pairs, 0 worse/);
  assert.match(some.stdout, /FAIL no part measured mobile\.home/);

  assert.equal(run(["--gate"]).status, 2, "no part files is a usage error");
});

test("site-perf.yml splits pull requests by lighthouse.mjs's pages", () => {
  const yml = readFileSync(new URL("../../../.github/workflows/site-perf.yml", import.meta.url), "utf8");
  const list = (key) => JSON.parse(new RegExp(`^ +${key}: .*pull_request' && '(\\[[^']+\\])'`, "m").exec(yml)?.[1] ?? "null");
  assert.deepEqual(list("page"), Object.keys(PAGES));
  assert.doesNotMatch(yml, /--part[^\n]*--profile|--profile[^\n]*\n[^\n]*--part/, "a part measures both profiles");
});
