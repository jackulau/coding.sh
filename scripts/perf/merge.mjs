// Joins the parts of one site perf A/B that ran as several jobs, one per page
// (scripts/perf/ab.mjs --part), into the result a single run would have written, so the gate and
// the budgets judge it once: the same pairs, and one Holm correction across every gated metric.
//
// Every part runs the same pairs in the same arm order (the same --seed, --pairs and --warmup), so
// run i of each part is the same pair and arm. The merged run i holds the metrics of all of them.
// A page's samples all come from one job, so each metric's pairs are measured as before.
import { analyzeMetrics } from "../../packages/coding.sh/src/experiments/metrics.ts";

// As in runMetrics: a metric with no spread on either arm and no change is "same".
const isSame = (m) => m.verdict === "inconclusive" && m.deterministic && m.delta.median === 0;

/** The words two task refs share from the start: the command without a part's own --page and --profile. */
function commonRef(refs) {
  const words = refs.map((r) => String(r).split(" "));
  let n = 0;
  while (words.every((w) => w[n] !== undefined && w[n] === words[0][n])) n++;
  const shared = words[0].slice(0, n);
  while (shared.at(-1)?.startsWith("--")) shared.pop();
  return shared.join(" ");
}

/**
 * The merged result of `parts` (each an `ab.mjs --out` result). Throws when the parts are not one
 * experiment: a different seed, pair count or arm, a part cut short, or a metric measured twice.
 * `expect` lists the metric prefixes ("mobile.home") that must be there; one with no metrics in
 * any pair (its job never uploaded a part) is returned in `missing`.
 */
export function mergeResults(parts, { expect = [] } = {}) {
  if (!parts.length) throw new Error("no parts to merge");
  const [first] = parts;
  const same = (label, get) => {
    const want = JSON.stringify(get(first));
    for (const p of parts) if (JSON.stringify(get(p)) !== want) throw new Error(`the parts disagree on ${label}: ${want} and ${JSON.stringify(get(p))}`);
  };
  same("the seed", (p) => p.seed);
  same("the pairs", (p) => p.pairs);
  same("the warm-up rounds", (p) => p.warmup);
  same("alpha", (p) => p.alpha);
  same("the correction", (p) => p.correction);
  same("the arms", (p) => p.arms.map((a) => a.name));
  const total = 2 * (first.pairs + first.warmup);
  for (const p of parts) if (p.status !== "completed" || p.runs.length !== total) throw new Error(`a part stopped early: ${p.runs.length} of ${total} runs (${p.arms[0].task.ref})`);
  same("the order of the runs", (p) => p.runs.map((r) => [r.pair, r.arm]));

  const runs = first.runs.map((r, i) => {
    const run = { pair: r.pair, arm: r.arm, startedAt: Math.min(...parts.map((p) => p.runs[i].startedAt)), durationMs: parts.reduce((s, p) => s + p.runs[i].durationMs, 0) };
    if (r.warmup) run.warmup = true;
    const errors = parts.map((p) => p.runs[i].error).filter((e) => e !== undefined);
    // One failed sample drops the pair from every metric, as it does in a single run.
    if (errors.length) return { ...run, error: errors.join("; ") };
    run.metrics = {};
    for (const p of parts) {
      for (const [name, v] of Object.entries(p.runs[i].metrics ?? {})) {
        if (name in run.metrics) throw new Error(`two parts measured ${name}`);
        run.metrics[name] = v;
      }
    }
    return run;
  });

  const analysis = analyzeMetrics(runs, { correction: first.correction, alpha: first.alpha, seed: first.seed });
  const failedRuns = runs.filter((r) => !r.warmup && r.error !== undefined).length;
  const notes = [...analysis.notes];
  if (failedRuns) notes.unshift(`${failedRuns} run(s) failed; their pairs are left out of every metric`);
  const measured = analysis.metrics.map((m) => m.name);
  const missing = expect.filter((prefix) => !measured.some((name) => name.startsWith(`${prefix}.`)));
  const result = {
    id: first.id,
    name: first.name,
    status: "completed",
    createdAt: Math.min(...parts.map((p) => p.createdAt)),
    finishedAt: Math.max(...parts.map((p) => p.finishedAt)),
    seed: first.seed,
    pairs: first.pairs,
    warmup: first.warmup,
    arms: first.arms.map((a, k) => ({ name: a.name, task: { ...a.task, ref: commonRef(parts.map((p) => p.arms[k].task.ref)) } })),
    order: first.order,
    runs,
    alpha: first.alpha,
    correction: first.correction,
    metrics: analysis.metrics,
    summary: {
      better: analysis.metrics.filter((m) => m.verdict === "better").length,
      worse: analysis.metrics.filter((m) => m.verdict === "worse").length,
      same: analysis.metrics.filter(isSame).length,
      inconclusive: analysis.metrics.filter((m) => m.verdict === "inconclusive" && !isSame(m)).length,
      pairsComplete: analysis.pairsComplete,
      failedRuns,
    },
    notes,
  };
  return { result, missing };
}
