// Example numbers for the Compare section, written by hand: a coding.sh AGENTS.md
// before and after a rewrite, on 20 tasks, 5 runs each. They are not an experiment
// export. scripts/shots/seed.mjs writes these exact runs into the viewer for the
// screenshot, so the page and the picture agree.

export interface TaskRow {
  task: string;
  /** What the task asks for, in words. The landing shows this, not the id. */
  label: string;
  /** One char per run, "1" = pass. */
  base: string;
  cand: string;
}

export const TASKS: TaskRow[] = [
  { task: "retry-locked-index", label: "Retry when the database is locked", base: "00100", cand: "11111" },
  { task: "parse-since-flag", label: "Parse the --since flag", base: "11011", cand: "11110" },
  { task: "usage-by-repo", label: "Show usage by repo", base: "11111", cand: "11111" },
  { task: "paginate-sessions-api", label: "Paginate the sessions API", base: "10010", cand: "11011" },
  { task: "debounce-viewer-search", label: "Debounce search in the viewer", base: "01101", cand: "11101" },
  { task: "fix-flaky-hook-test", label: "Fix a flaky hook test", base: "00000", cand: "01001" },
  { task: "otlp-body-limit", label: "Cap the size of OTLP request bodies", base: "11110", cand: "11111" },
  { task: "rename-tok-turn-column", label: "Rename a database column", base: "11111", cand: "11111" },
  { task: "blob-cache-eviction", label: "Evict old entries from the blob cache", base: "10110", cand: "11110" },
  { task: "empty-spool-ingest", label: "Ingest with an empty spool", base: "11101", cand: "11101" },
  { task: "upgrade-esbuild", label: "Upgrade esbuild", base: "01010", cand: "01011" },
  { task: "sessions-json-output", label: "JSON output for the sessions command", base: "11111", cand: "11111" },
  { task: "fix-n-plus-one-subagents", label: "Fix slow subagent queries", base: "00010", cand: "11011" },
  { task: "timezone-in-usage", label: "Use the local time zone in usage", base: "11100", cand: "10110" },
  { task: "redact-bearer-tokens", label: "Redact bearer tokens", base: "11011", cand: "11111" },
  { task: "idempotent-ingest", label: "Make ingest safe to run twice", base: "00110", cand: "10111" },
  { task: "plural-helper", label: "Add a plural helper", base: "11111", cand: "11111" },
  { task: "stream-large-blobs", label: "Stream large blobs", base: "11010", cand: "10010" },
  { task: "viewer-memory-leak", label: "Fix a memory leak in the viewer", base: "11110", cand: "01110" },
  { task: "codex-adapter-tokens", label: "Count tokens in the Codex adapter", base: "10111", cand: "10101" },
];

const passes = (s: string) => [...s].filter((c) => c === "1").length;

/** Seeded PRNG so the bootstrap is the same on every build. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paired bootstrap over tasks: resample tasks, keep each task's pair intact. 95% interval. */
function pairedBootstrap(diffs: number[], iters = 10000, seed = 1842) {
  const r = rng(seed);
  const n = diffs.length;
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += diffs[Math.floor(r() * n)];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iters * 0.025)], means[Math.floor(iters * 0.975)]] as const;
}

export function computeStats(tasks: TaskRow[], seed = 1842) {
  const k = tasks[0].base.length;
  const runs = tasks.length * k;
  const baseK = tasks.reduce((s, t) => s + passes(t.base), 0);
  const candK = tasks.reduce((s, t) => s + passes(t.cand), 0);
  const diffs = tasks.map((t) => (passes(t.cand) - passes(t.base)) / k);
  const [lo, hi] = pairedBootstrap(diffs, 10000, seed);
  const pct = (x: number) => Math.round(x * 100);
  // The product's rule (packages/coding.sh/src/experiments/compare.ts): "better"
  // when the interval's low end is above 0, "worse" when its high end is below 0.
  const verdict: "better" | "worse" | "inconclusive" = lo > 0 ? "better" : hi < 0 ? "worse" : "inconclusive";
  return {
    tasks: tasks.length,
    runsPerTask: k,
    runs,
    baseK,
    candK,
    baseRate: pct(baseK / runs),
    candRate: pct(candK / runs),
    diff: pct((candK - baseK) / runs),
    verdict,
  };
}

export const STATS = computeStats(TASKS);

// The landing says "Better by 15 points. That's more than luck would explain." Fail the
// build if the data ever stops saying that.
if (STATS.verdict !== "better" || STATS.baseRate !== 64 || STATS.candRate !== 79) {
  throw new Error(`compare.ts: the landing copy expects 64% → 79% and a "better" verdict, got ${STATS.baseRate}% → ${STATS.candRate}% (${STATS.verdict})`);
}

/** One task's label and its passes out of runs, before and after: "1/5". */
export function taskScore(name: string) {
  const t = TASKS.find((x) => x.task === name);
  if (!t) throw new Error(`compare.ts: no task ${name}`);
  return { label: t.label, before: `${passes(t.base)}/${t.base.length}`, after: `${passes(t.cand)}/${t.cand.length}`, worse: passes(t.cand) < passes(t.base) };
}
