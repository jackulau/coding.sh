// Sample data for the A/B section: 20 tasks x 5 runs per arm, paired by task and
// run index. The statistics are computed from these rows at build time, so the
// numbers on the page are exactly what the method gives for this sample.

export interface TaskRow {
  task: string;
  /** One char per run, "1" = pass. */
  base: string;
  cand: string;
  /** Where the two traces first differ, for the tasks we annotate. */
  note?: string;
}

export const ARMS = {
  base: { name: "baseline", sub: "CLAUDE.md as it is today" },
  cand: { name: "candidate", sub: "+ test-feedback hook, trimmed CLAUDE.md" },
} as const;

export const TASKS: TaskRow[] = [
  { task: "add-retry-handling", base: "00100", cand: "11111", note: "first divergence at step 8: the test-feedback hook fed the 2 failing tests back before the turn ended" },
  { task: "fix-date-parsing", base: "11011", cand: "11110" },
  { task: "migrate-to-esm", base: "11111", cand: "11111" },
  { task: "paginate-orders-api", base: "10010", cand: "11011", note: "first divergence at step 4: candidate read the API contract before editing" },
  { task: "debounce-search", base: "01101", cand: "11101" },
  { task: "fix-flaky-auth-test", base: "00000", cand: "01001", note: "first divergence at step 9: candidate ran the test 3 times instead of once" },
  { task: "add-rate-limit", base: "11110", cand: "11111" },
  { task: "rename-user-field", base: "11111", cand: "11111" },
  { task: "cache-invalidation", base: "10110", cand: "11110" },
  { task: "handle-empty-cart", base: "11101", cand: "11101" },
  { task: "upgrade-zod-v4", base: "01010", cand: "01011" },
  { task: "csv-export", base: "11111", cand: "11111" },
  { task: "fix-n-plus-one", base: "00010", cand: "11011", note: "first divergence at step 6: candidate checked the query log after the change" },
  { task: "timezone-display", base: "11100", cand: "10110" },
  { task: "webhook-signature", base: "11011", cand: "11111" },
  { task: "retry-idempotency", base: "00110", cand: "10111" },
  { task: "i18n-plurals", base: "11111", cand: "11111" },
  { task: "stream-large-upload", base: "11010", cand: "10010", note: "first divergence at step 5: trimmed CLAUDE.md lost the upload size rule" },
  { task: "fix-memory-leak", base: "11110", cand: "01110" },
  { task: "dark-mode-tokens", base: "10111", cand: "10101" },
];

const passes = (s: string) => [...s].filter((c) => c === "1").length;

/** Wilson score interval, 95%. */
function wilson(k: number, n: number, z = 1.96) {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h] as const;
}

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

/** Paired bootstrap over tasks: resample tasks, keep each task's pair intact. */
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

function choose(n: number, k: number) {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
}

/** Exact two-sided McNemar test on discordant pairs. */
function mcnemar(b: number, c: number) {
  const n = b + c;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += choose(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Pass rates with Wilson CIs, the paired-bootstrap CI of the per-task difference, and McNemar on discordant runs. */
export function computeStats(tasks: TaskRow[], seed = 1842) {
  const k = tasks[0].base.length;
  const runs = tasks.length * k;
  const baseK = tasks.reduce((s, t) => s + passes(t.base), 0);
  const candK = tasks.reduce((s, t) => s + passes(t.cand), 0);
  let b = 0; // base pass, candidate fail
  let c = 0; // base fail, candidate pass
  for (const t of tasks)
    for (let i = 0; i < t.base.length; i++) {
      if (t.base[i] === "1" && t.cand[i] === "0") b++;
      if (t.base[i] === "0" && t.cand[i] === "1") c++;
    }
  const diffs = tasks.map((t) => (passes(t.cand) - passes(t.base)) / t.base.length);
  const [dLo, dHi] = pairedBootstrap(diffs, 10000, seed);
  const pct = (x: number) => Math.round(x * 100);
  return {
    tasks: tasks.length,
    runsPerTask: k,
    runs,
    baseK,
    candK,
    baseRate: pct(baseK / runs),
    candRate: pct(candK / runs),
    baseCI: wilson(baseK, runs).map(pct) as [number, number],
    candCI: wilson(candK, runs).map(pct) as [number, number],
    diff: pct((candK - baseK) / runs),
    diffCI: [pct(dLo), pct(dHi)] as [number, number],
    b,
    c,
    p: mcnemar(b, c),
    improved: tasks.filter((t) => passes(t.cand) > passes(t.base)).length,
    regressed: tasks.filter((t) => passes(t.cand) < passes(t.base)).length,
  };
}

export const STATS = computeStats(TASKS);

export const taskDelta = (t: TaskRow) => passes(t.cand) - passes(t.base);
export const taskPasses = passes;
