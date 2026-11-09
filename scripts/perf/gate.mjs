// The pass/fail rules of scripts/perf/ab.mjs --gate and --budgets, kept apart
// so scripts/perf/test/gate.test.mjs can feed them synthetic runs.
//
// Gate: a gated metric fails when coding.sh calls it worse (the paired
// bootstrap CI excludes 0 and the Holm-corrected sign test agrees) and its
// median paired delta is at least MIN_EFFECT for that metric. Nine quiet pairs
// can call a 15 ms shift in a 1.6 s LCP significant, but no visitor sees it.
//
// Budgets: a budget fails when the lower end of the 95% bootstrap CI of the
// candidate's median is over it, so "over budget" means the samples say so,
// not that one noisy median landed 0.5 ms past the line. A fixed number (bytes,
// requests) has a CI of zero width and is compared as is.
import { analyzeMetrics, metricMatches, metricUnit } from "../../packages/coding.sh/src/experiments/metrics.ts";
import { pairedBootstrapMedian } from "../../packages/coding.sh/src/stats/interval.ts";
import { median } from "../../packages/coding.sh/src/stats/summary.ts";

export const GATE = ["mobile.*.lcp_ms", "mobile.*.cls", "*.js_bytes", "*.font_bytes", "*.css_bytes", "mobile.*.startup_requests"];

// Smallest worsening that fails the gate: the larger of `rel` times the base
// median and `abs`. First match wins; a metric with no entry fails on any
// significant worsening (bytes and request counts of a fixed build have no
// noise, so every added byte is real).
export const MIN_EFFECT = [
  ["*_ms", { rel: 0.03, abs: 20 }],
  ["*.cls", { rel: 0.03, abs: 0.01 }],
];

export function minEffect(name, baseMedian) {
  const hit = MIN_EFFECT.find(([pattern]) => metricMatches(name, [pattern]));
  if (!hit) return 0;
  const { rel, abs } = hit[1];
  return Math.max(rel * Math.abs(baseMedian), abs);
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** The --gate check. Returns the failures and the significant changes too small to fail. */
export function checkGate(result) {
  const gated = analyzeMetrics(result.runs, { only: GATE, correction: result.correction, alpha: result.alpha, seed: result.seed });
  const failures = [];
  const small = [];
  for (const m of gated.metrics.filter((x) => x.verdict === "worse")) {
    const ci = m.deterministic ? "every run" : `95% CI [${r4(m.delta.lo)}, ${r4(m.delta.hi)}], p ${m.pAdjusted.toFixed(3)}`;
    const floor = minEffect(m.name, m.a.median);
    const line = `${m.name} got worse: ${m.a.median} -> ${m.b.median}, ${r4(m.delta.median)} (${ci})`;
    if (Math.abs(m.delta.median) >= floor) failures.push(line);
    else small.push(`${line}, under the ${r4(floor)} that counts`);
  }
  return { metrics: gated.metrics.length, pairs: gated.pairsComplete, failures, small };
}

/**
 * The --budgets check. `_ms` budgets use only the candidate's quiet samples
 * (cpu_busy at most quietCpu) and are skipped, listed in `busy`, when fewer
 * than half the pairs had one.
 */
export function checkBudgets(result, budgets, { skip = [], quietCpu = 0.5 } = {}) {
  const candRuns = result.runs.filter((x) => !x.warmup && x.metrics && x.arm === 1);
  const failures = [];
  const busy = [];
  let checked = 0;
  for (const [pattern, max] of Object.entries(budgets)) {
    if (pattern.startsWith("$") || metricMatches(pattern, skip)) continue;
    for (const m of result.metrics.filter((x) => metricMatches(x.name, [pattern]))) {
      let samples = candRuns.map((x) => x.metrics[m.name]).filter((v) => typeof v === "number");
      if (metricUnit(m.name) === "ms") {
        // "mobile.quickstart.lcp_ms" -> that page's "mobile.quickstart.cpu_busy"; a sample without one counts as quiet.
        const load = `${m.name.slice(0, m.name.lastIndexOf("."))}.cpu_busy`;
        samples = candRuns.filter((x) => typeof x.metrics[m.name] === "number" && !(x.metrics[load] > quietCpu)).map((x) => x.metrics[m.name]);
        if (samples.length * 2 < result.pairs) {
          busy.push(`${m.name} (${samples.length} of ${result.pairs})`);
          continue;
        }
      }
      if (!samples.length) continue;
      checked++;
      const { lo } = pairedBootstrapMedian(samples, { seed: result.seed, alpha: result.alpha });
      if (lo > max) failures.push(`${m.name} is ${Math.round(median(samples) * 10) / 10} (95% CI from ${Math.round(lo * 10) / 10}), budget ${max} (${pattern})`);
    }
  }
  return { checked, failures, busy };
}
