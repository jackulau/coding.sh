// Signal validity (Z-11): does a trace signal predict failure beyond task difficulty?
//
// A failure flag can look predictive only because hard tasks fail more and also
// produce more flags. arXiv 2611.08285 (Table 2, §4) shows this on 2,840 SWE-bench
// Verified runs: a difficulty-only score reaches pooled AUROC 0.924, trajectory
// predictors about 0.62, and within one issue the trajectory predictors are no
// better than length plus model identity. So each signal gets three AUROCs:
//
//   pooled          every (failed, passed) pair of runs
//   within task     pairs from the same task (difficulty is held fixed)
//   within task+arm pairs from the same task and the same arm (harness/model held fixed too)
//
// and the verdict reads the within-task-and-arm AUROC with a task-cluster
// bootstrap CI. Run-blind reference rows (difficulty, arm, turns, tokens) come
// first, so a signal is read against what difficulty and length alone reach.
//
// The CI resamples tasks, so it is only as good as the number of tasks behind
// it: one task gives the same value on every draw, and with a coin-flip score a
// CI over 2 tasks sits above 0.5 in about 1 table in 5. Below `minTasks` tasks
// there is no verdict, however many pairs those tasks hold.
import type { Session } from "../schema/index.ts";
import { mulberry32 } from "./prng.ts";
import { quantileSorted } from "./summary.ts";

/** One run: its task, arm and outcome, and its scores oriented higher = more likely to fail. */
export interface SignalRow {
  runId: string;
  taskId: string;
  arm: string;
  pass: boolean;
  scores: Record<string, number | undefined>;
}

export type SignalVerdict = "adds-run-signal" | "tracks-difficulty" | "no-signal" | "too-few-pairs";

export interface SignalValidity {
  signal: string;
  /** Runs with a score for this signal (runs whose task has no other run are left out). */
  n: number;
  /** AUROC over every (failed, passed) pair; NaN when there is no pair. */
  pooled: number;
  withinTask: { auroc: number; pairs: number };
  /** Same task and arm; `tasks` counts the tasks that hold such a pair. The task-cluster bootstrap CI is NaN with fewer than 2 of them. */
  withinTaskArm: { auroc: number; pairs: number; tasks: number; ci: [number, number] };
  verdict: SignalVerdict;
  /** A reference row (difficulty, arm, length), not a trace signal. */
  reference?: true;
}

export interface SignalValidityOpts {
  /** Bootstrap draws for the within-task-and-arm CI (default 1000). */
  iters?: number;
  seed?: number;
  /** Fewer within-task-and-arm pairs than this → too-few-pairs (default 20). */
  minPairs?: number;
  /** Fewer tasks holding such a pair than this → too-few-pairs, whatever the pair count (default 8). */
  minTasks?: number;
  /** Two-sided CI level (default 0.05 → 95%). */
  alpha?: number;
  /** Score keys read as reference rows rather than signals (default turns, tokens). */
  references?: readonly string[];
}

/** Outcome-based references: the fail share of the task's (or arm's) other runs. */
export const DIFFICULTY_REF = "difficulty(loo)";
export const ARM_REF = "arm(loo)";
const LENGTH_REFS: readonly string[] = ["turns", "tokens"];
/** Default `minTasks`: at 8 tasks a coin-flip score gets adds-run-signal in about 5% of tables (45% at 1, 21% at 2). */
export const MIN_SIGNAL_TASKS = 8;

/** A flag with a colon is a tag (gateway:vercel, skill:pdf), not a failure symptom. */
function isFailureFlag(f: string): boolean {
  return !f.includes(":") && !f.startsWith("gateway");
}

/**
 * One row per counted run (cancelled, superseded and infra-failed runs are left
 * out, as compare does): each failure flag on its session as 1/0, the session's
 * tool errors, and its turns and tokens. A run without a session has no scores.
 */
export function signalRows(
  results: readonly { id: string; taskId: string; bundleId: string; pass: boolean; cancelled?: true; superseded?: true; infra?: string }[],
  sessions: ReadonlyMap<string, Pick<Session, "flags" | "stats">>,
): SignalRow[] {
  const counted = results.filter((r) => !r.cancelled && !r.superseded && !r.infra);
  const flags = new Set<string>();
  for (const r of counted) for (const f of sessions.get(r.id)?.flags ?? []) if (isFailureFlag(f)) flags.add(f);
  const flagList = [...flags].sort();
  return counted.map((r) => {
    const s = sessions.get(r.id);
    const scores: Record<string, number | undefined> = {};
    if (s) {
      scores.toolErrors = s.stats.toolErrors;
      for (const f of flagList) scores[f] = s.flags.includes(f) ? 1 : 0;
      scores.turns = s.stats.turns;
      const u = s.stats.usage;
      const tokens = (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0);
      if (u && tokens > 0) scores.tokens = tokens;
    }
    return { runId: r.id, taskId: r.taskId, arm: r.bundleId, pass: r.pass, scores };
  });
}

/** Whether any task has two runs in the same arm, which the within-task-and-arm AUROC needs. */
export function hasRepeatedAttempts(rows: readonly Pick<SignalRow, "taskId" | "arm">[]): boolean {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.taskId}\u0000${r.arm}`;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

type PairScore = (i: number, j: number) => readonly [number, number] | undefined;

/**
 * AUROC of each signal and reference, oriented higher = more likely to fail:
 * the share of (failed, passed) pairs where the failed run scores higher, ties
 * count 0.5, a pair with a missing score is dropped. The references
 * `difficulty(loo)` and `arm(loo)` score a run by the fail share of its task's
 * (arm's) other runs, leaving out both runs of the pair, so no run sees its
 * own outcome and two runs of one task tie on difficulty by construction.
 */
export function signalValidity(input: readonly SignalRow[], opts: SignalValidityOpts = {}): SignalValidity[] {
  const iters = opts.iters ?? 1000;
  const seed = opts.seed ?? 1;
  const minPairs = opts.minPairs ?? 20;
  const minTasks = opts.minTasks ?? MIN_SIGNAL_TASKS;
  const alpha = opts.alpha ?? 0.05;
  const refs = new Set(opts.references ?? LENGTH_REFS);
  // A run whose task has no other run can't be compared within its task, and has no difficulty.
  const perTask = new Map<string, number>();
  for (const r of input) perTask.set(r.taskId, (perTask.get(r.taskId) ?? 0) + 1);
  const rows = input.filter((r) => (perTask.get(r.taskId) ?? 0) > 1);
  if (!rows.length) return [];
  const taskIdx = indexOf(rows.map((r) => r.taskId));
  const armIdx = indexOf(rows.map((r) => r.arm));
  const fail = rows.map((r) => (r.pass ? 0 : 1));
  const tally = (idx: number[], k: number) => {
    const n = new Array<number>(k).fill(0);
    const f = new Array<number>(k).fill(0);
    idx.forEach((g, i) => {
      n[g]!++;
      f[g]! += fail[i]!;
    });
    return { n, f };
  };
  const tasks = tally(taskIdx, Math.max(...taskIdx) + 1);
  const arms = tally(armIdx, Math.max(...armIdx) + 1);
  const loo = (idx: number[], t: { n: number[]; f: number[] }): PairScore => (i, j) => {
    const side = (a: number, b: number) => {
      const g = idx[a]!;
      const same = idx[b] === g ? 1 : 0;
      const others = t.n[g]! - 1 - same;
      return others > 0 ? (t.f[g]! - fail[a]! - same * fail[b]!) / others : undefined;
    };
    const si = side(i, j);
    const sj = side(j, i);
    return si === undefined || sj === undefined ? undefined : [si, sj];
  };
  const plain = (key: string): PairScore => (i, j) => {
    const si = rows[i]!.scores[key];
    const sj = rows[j]!.scores[key];
    return typeof si === "number" && Number.isFinite(si) && typeof sj === "number" && Number.isFinite(sj) ? [si, sj] : undefined;
  };
  const keys = new Set<string>();
  for (const r of rows) for (const [k, v] of Object.entries(r.scores)) if (typeof v === "number" && Number.isFinite(v)) keys.add(k);
  const refKeys = LENGTH_REFS.filter((k) => keys.has(k) && refs.has(k)).concat([...refs].filter((k) => keys.has(k) && !LENGTH_REFS.includes(k)).sort());
  const sigKeys = [...keys].filter((k) => !refs.has(k)).sort((a, b) => (a === "toolErrors" ? -1 : b === "toolErrors" ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const specs: { signal: string; score: PairScore; n: number; reference: boolean }[] = [
    { signal: DIFFICULTY_REF, score: loo(taskIdx, tasks), n: rows.length, reference: true },
    { signal: ARM_REF, score: loo(armIdx, arms), n: rows.length, reference: true },
    ...refKeys.map((k) => ({ signal: k, score: plain(k), n: countScored(rows, k), reference: true })),
    ...sigKeys.map((k) => ({ signal: k, score: plain(k), n: countScored(rows, k), reference: false })),
  ];
  const failed = rows.flatMap((r, i) => (r.pass ? [] : [i]));
  const passed = rows.flatMap((r, i) => (r.pass ? [i] : []));
  const nTasks = tasks.n.length;
  return specs.map(({ signal, score, n, reference }) => {
    let pw = 0;
    let pp = 0;
    let tw = 0;
    let tp = 0;
    const armW = new Array<number>(nTasks).fill(0);
    const armP = new Array<number>(nTasks).fill(0);
    for (const i of failed) {
      for (const j of passed) {
        const s = score(i, j);
        if (!s) continue;
        const w = s[0] > s[1] ? 1 : s[0] === s[1] ? 0.5 : 0;
        pw += w;
        pp++;
        if (taskIdx[i] !== taskIdx[j]) continue;
        tw += w;
        tp++;
        if (armIdx[i] !== armIdx[j]) continue;
        armW[taskIdx[i]!]! += w;
        armP[taskIdx[i]!]!++;
      }
    }
    const aw = armW.reduce((s, x) => s + x, 0);
    const ap = armP.reduce((s, x) => s + x, 0);
    const at = armP.reduce((s, x) => s + (x > 0 ? 1 : 0), 0);
    const within = ap ? aw / ap : NaN;
    const ci = clusterCi(armW, armP, iters, seed, alpha);
    const pooled = pp ? pw / pp : NaN;
    const verdict: SignalVerdict = ap < minPairs || at < minTasks ? "too-few-pairs" : ci[0] > 0.5 ? "adds-run-signal" : pooled >= 0.6 && ci[0] <= 0.5 && ci[1] >= 0.5 ? "tracks-difficulty" : "no-signal";
    const out: SignalValidity = { signal, n, pooled, withinTask: { auroc: tp ? tw / tp : NaN, pairs: tp }, withinTaskArm: { auroc: within, pairs: ap, tasks: at, ci }, verdict };
    if (reference) out.reference = true;
    return out;
  });
}

function indexOf(keys: readonly string[]): number[] {
  const m = new Map<string, number>();
  return keys.map((k) => {
    let i = m.get(k);
    if (i === undefined) m.set(k, (i = m.size));
    return i;
  });
}

function countScored(rows: readonly SignalRow[], key: string): number {
  let n = 0;
  for (const r of rows) {
    const v = r.scores[key];
    if (typeof v === "number" && Number.isFinite(v)) n++;
  }
  return n;
}

/**
 * Percentile CI of Σwins/Σpairs over tasks resampled with replacement (seeded).
 * NaN with fewer than 2 tasks: one task is the same value on every draw, a
 * zero-width interval that says nothing about other tasks.
 */
function clusterCi(wins: readonly number[], pairs: readonly number[], iters: number, seed: number, alpha: number): [number, number] {
  const use = pairs.flatMap((p, t) => (p > 0 ? [t] : []));
  if (use.length < 2) return [NaN, NaN];
  const rand = mulberry32(seed);
  const m = use.length;
  const draws: number[] = [];
  for (let b = 0; b < iters; b++) {
    let w = 0;
    let p = 0;
    for (let k = 0; k < m; k++) {
      const t = use[Math.floor(rand() * m)]!;
      w += wins[t]!;
      p += pairs[t]!;
    }
    draws.push(w / p);
  }
  draws.sort((a, b) => a - b);
  return [quantileSorted(draws, alpha / 2), quantileSorted(draws, 1 - alpha / 2)];
}

/** The headline under the table: pooled AUROC mostly measures task difficulty. */
export const SIGNALS_CAPTION = "pooled AUROC mostly measures task difficulty (arXiv 2611.08285: difficulty-only 0.92 vs trajectory 0.62); trust within-task+arm";

/**
 * The table: reference rows first, then signals; `repeated: false` adds the k ≥ 2 hint.
 * When pairs exist but come from fewer than `minTasks` tasks, a line says why no row has a verdict.
 */
export function formatSignalValidity(v: readonly SignalValidity[], o: { repeated?: boolean; minTasks?: number } = {}): string {
  const lines = ["signals  " + SIGNALS_CAPTION];
  if (o.repeated === false) lines.push("  needs k>=2: no task has two runs in the same arm, so within-task+arm AUROC can't be computed (rerun with --k 3)");
  if (!v.length) {
    lines.push("  no task has two runs, so no signal can be checked within a task");
    return lines.join("\n");
  }
  const minTasks = o.minTasks ?? MIN_SIGNAL_TASKS;
  const tasks = Math.max(...v.map((r) => r.withinTaskArm.tasks));
  if (tasks > 0 && tasks < minTasks) lines.push(`  needs ${minTasks} tasks: ${tasks === 1 ? "1 task has" : `${tasks} tasks have`} a failed and a passed run in the same arm, and the 95% CI resamples tasks, so no row gets a verdict (add tasks)`);
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");
  const head = ["signal", "n", "pooled", "task", "task+arm", "95% CI", "pairs", "verdict"];
  const body = v.map((r) => [
    r.reference ? `${r.signal} (ref)` : r.signal,
    String(r.n),
    f(r.pooled),
    f(r.withinTask.auroc),
    f(r.withinTaskArm.auroc),
    Number.isFinite(r.withinTaskArm.ci[0]) ? `[${f(r.withinTaskArm.ci[0])}, ${f(r.withinTaskArm.ci[1])}]` : "–",
    String(r.withinTaskArm.pairs),
    r.verdict,
  ]);
  const w = head.map((h, c) => Math.max(h.length, ...body.map((b) => b[c]!.length)));
  const row = (cells: string[]) => "  " + cells.map((x, c) => (c === 0 || c === cells.length - 1 ? x.padEnd(w[c]!) : x.padStart(w[c]!))).join("  ").trimEnd();
  lines.push(row(head), ...body.map(row));
  return lines.join("\n");
}
