// The one-item gate: does adding (or removing) a single rule, skill or context
// file help, judged only on tasks where the item reached the agent's context?
// Cortex (arXiv 2610.14216 §2, §3, §5; scorer bin/score.sh, "contains no model
// of any kind"). Additions: KEEP / RECHECK / KILL / RERUN; removals: ACCEPT /
// REJECT / UNMEASURED / UNCOVERED / RERUN. Pure: exposure comes in as a map.
//
// A removal is accepted only when the agent does well without the item, not
// merely as well: gain-only retirement cannot tell internalized (both arms
// high) from uncovered (both low), and retired 57-65% of uncovered skills in
// Wang et al., "Beyond Gain: Measuring Skill Internalization for Agent Skill
// Retirement" (arXiv 2610.32322 §4-5). Retiring only at a pass rate without
// the item U ≥ 0.8 cost no reward there and was more reproducible.
import type { RunResult } from "../core/types.ts";
import { harnessItem, type ExposureState, type HarnessItem } from "../core/exposure.ts";

export type ItemGateVerdict = "KEEP" | "RECHECK" | "KILL" | "RERUN" | "ACCEPT" | "REJECT" | "UNMEASURED" | "UNCOVERED";

/** A removal task's levels (arXiv 2610.32322 §3): A with the item, U without. */
export type ItemLevelLabel = "internalized" | "works" | "uncovered" | "hurts" | "between";

/** Pass-rate levels of the remove rule (arXiv 2610.32322 §3, §5). */
export interface ItemLevels {
  /** Mean U a removal needs (default 0.8). */
  retire?: number;
  /** A level at or above this is high (default 0.7). */
  high?: number;
  /** A level below this is low (default 0.4). */
  low?: number;
}

export interface ItemGateOpts {
  /** Bundle ids. In "add" mode the item lives in the candidate, in "remove" mode in the baseline. */
  baseline: string;
  candidate: string;
  mode: "add" | "remove";
  /** Exposure of the item per run id (item arm). A missing run counts as "unknown". */
  exposure: ReadonlyMap<string, ExposureState>;
  /** Agent version per run id; more than one distinct version is not scorable. */
  agentVersions?: ReadonlyMap<string, string | undefined>;
  /** Runs per task and arm (default: the most attempts seen). */
  k?: number;
  /** Largest per-task pass-rate drop allowed (default 0.34: one run in three). */
  tau?: number;
  /** Net run gain an addition needs, and the net loss that rejects a removal (default 2). */
  m?: number;
  /** Largest share of invalid (errored or cancelled) runs (default 0.10). */
  maxInvalid?: number;
  item?: Pick<HarnessItem, "path" | "kind" | "tier">;
  /** Remove mode: the levels U and A are read against. */
  levels?: ItemLevels;
}

export interface ItemGateTask {
  taskId: string;
  /** Passes out of k without the item (pb) and with it (pc), in the paper's add-mode naming: baseline / candidate. */
  baseline: number;
  candidate: number;
  /** candidate − baseline pass rate. */
  delta: number;
  /** Item-arm rollouts where the item was in context. */
  fired: number;
  /** Remove mode: internalized (A, U ≥ high), works (A ≥ high, U < low), uncovered (both < low), hurts (U ≥ high, A < low), else between. */
  label?: ItemLevelLabel;
}

export interface ItemGateReport {
  verdict: ItemGateVerdict;
  mode: "add" | "remove";
  item?: Pick<HarnessItem, "path" | "kind" | "tier">;
  k: number;
  /** Σ max(Δt, 0) over S. */
  G: number;
  /** Σ Δt over S. */
  N: number;
  /** k·N in whole runs: candidate passes − baseline passes over S. */
  kN: number;
  /** Largest drop, max(−Δt, 0) over S. */
  D: number;
  /** Tasks in S the baseline solved on every run. */
  P: string[];
  /** Item-arm rollouts (over M) where the item was in context. */
  f: { fired: number; rollouts: number };
  /** Paired tasks where the item was in context at least once (M ∩ X). */
  S: string[];
  /** Tasks with k valid runs in both arms. */
  M: number;
  invalid: { runs: number; of: number };
  tau: number;
  m: number;
  /** Why the verdict is not KEEP / ACCEPT (each failed gate or scorability check). */
  reasons: string[];
  /** RECHECK: re-run these tasks at the same k; a repeat drop kills the item. */
  recheck?: string[];
  /** Remove mode with exposed tasks: mean pass rate without (U) and with (A) the item over S, and the task labels. */
  level?: { U: number; A: number; labels: Partial<Record<ItemLevelLabel, number>> };
  tasks: ItemGateTask[];
}

const EPS = 1e-9;

/** A remove-mode task's label from its pass rates with (A) and without (U) the item. */
export function levelLabel(A: number, U: number, high = 0.7, low = 0.4): ItemLevelLabel {
  const hi = (x: number) => x >= high - EPS;
  const lo = (x: number) => x < low - EPS;
  if (hi(A) && hi(U)) return "internalized";
  if (hi(A) && lo(U)) return "works";
  if (lo(A) && lo(U)) return "uncovered";
  if (hi(U) && lo(A)) return "hurts";
  return "between";
}

const valid = (r: RunResult) => !r.error && !r.cancelled;

/** "0.33" → ".33", 1.67 stays, 0 → "0". */
export function dec(x: number): string {
  if (x === 0) return "0";
  return x.toFixed(2).replace(/^(-?)0\./, "$1.");
}

const runs = (n: number) => `${n} run${Math.abs(n) === 1 ? "" : "s"}`;
const signedRuns = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${runs(Math.abs(n))}`;

interface Cells {
  k: number;
  /** taskId → first k valid runs per arm, in attempt order; only tasks with k valid runs in both. */
  paired: Map<string, { a: RunResult[]; b: RunResult[] }>;
  incomplete: string[];
  invalid: number;
  total: number;
}

function cells(results: readonly RunResult[], o: Pick<ItemGateOpts, "baseline" | "candidate" | "k">, only?: ReadonlySet<string>): Cells {
  const mine = results.filter((r) => (r.bundleId === o.baseline || r.bundleId === o.candidate) && (!only || only.has(r.taskId)));
  const by = new Map<string, { a: RunResult[]; b: RunResult[] }>();
  for (const r of mine) {
    const c = by.get(r.taskId) ?? { a: [], b: [] };
    (r.bundleId === o.baseline ? c.a : c.b).push(r);
    by.set(r.taskId, c);
  }
  const k = o.k ?? Math.max(0, ...[...by.values()].flatMap((c) => [c.a.length, c.b.length]));
  const paired = new Map<string, { a: RunResult[]; b: RunResult[] }>();
  const incomplete: string[] = [];
  for (const id of [...by.keys()].sort()) {
    const c = by.get(id)!;
    const first = (rs: RunResult[]) => rs.filter(valid).sort((x, y) => x.attempt - y.attempt).slice(0, k);
    const a = first(c.a);
    const b = first(c.b);
    if (k > 0 && a.length === k && b.length === k) paired.set(id, { a, b });
    else incomplete.push(id);
  }
  return { k, paired, incomplete, invalid: mine.filter((r) => !valid(r)).length, total: mine.length };
}

const passes = (rs: readonly RunResult[]) => rs.filter((r) => r.pass).length;

/** The one-item gate over two arms' runs (Cortex's scorer). */
export function itemGate(results: readonly RunResult[], o: ItemGateOpts): ItemGateReport {
  const tau = o.tau ?? 0.34;
  const m = o.m ?? 2;
  const maxInvalid = o.maxInvalid ?? 0.1;
  const retire = o.levels?.retire ?? 0.8;
  const high = o.levels?.high ?? 0.7;
  const low = o.levels?.low ?? 0.4;
  const { k, paired, incomplete, invalid, total } = cells(results, o);
  const itemArm = (c: { a: RunResult[]; b: RunResult[] }) => (o.mode === "add" ? c.b : c.a);
  const state = (r: RunResult): ExposureState => o.exposure.get(r.id) ?? "unknown";

  const tasks: ItemGateTask[] = [];
  let rollouts = 0;
  let fired = 0;
  for (const [taskId, c] of paired) {
    const arm = itemArm(c);
    const f = arm.filter((r) => state(r) === "in-context").length;
    rollouts += arm.length;
    fired += f;
    // A listed-but-unopened skill was never in context: the task is outside X.
    if (f > 0) {
      const pb = passes(c.a);
      const pc = passes(c.b);
      // Remove mode: the baseline has the item (A), the candidate does not (U).
      tasks.push({ taskId, baseline: pb, candidate: pc, delta: (pc - pb) / k, fired: f, ...(o.mode === "remove" ? { label: levelLabel(pb / k, pc / k, high, low) } : {}) });
    }
  }
  const S = tasks.map((t) => t.taskId);
  const G = tasks.reduce((s, t) => s + Math.max(t.delta, 0), 0);
  const kN = tasks.reduce((s, t) => s + t.candidate - t.baseline, 0);
  const N = k ? kN / k : 0;
  const worst = tasks.reduce<ItemGateTask | undefined>((w, t) => (t.delta < (w?.delta ?? 0) ? t : w), undefined);
  const D = worst ? -worst.delta : 0;
  const P = tasks.filter((t) => t.baseline === k).map((t) => t.taskId);
  const pLost = tasks.filter((t) => t.baseline === k && t.candidate < k);
  const overTau = tasks.filter((t) => -t.delta > tau + 1e-9);
  let level: ItemGateReport["level"];
  if (o.mode === "remove" && tasks.length) {
    const labels: Partial<Record<ItemLevelLabel, number>> = {};
    for (const t of tasks) labels[t.label as ItemLevelLabel] = (labels[t.label as ItemLevelLabel] ?? 0) + 1;
    level = { U: tasks.reduce((s, t) => s + t.candidate, 0) / (k * tasks.length), A: tasks.reduce((s, t) => s + t.baseline, 0) / (k * tasks.length), labels };
  }

  const base = {
    mode: o.mode,
    ...(o.item ? { item: o.item } : {}),
    k,
    G,
    N,
    kN,
    D,
    P,
    f: { fired, rollouts },
    S,
    M: paired.size,
    invalid: { runs: invalid, of: total },
    tau,
    m,
    ...(level ? { level } : {}),
    tasks,
  };
  const ids = (ts: readonly ItemGateTask[]) => ts.map((t) => t.taskId).join(", ");
  const drop = `worst drop ${dec(D)} > τ ${dec(tau)} (${ids(overTau)})`;
  const lostRun = `${pLost.length === 1 ? "a task" : `${pLost.length} tasks`} solved every run without the change lost a run (${pLost.map((t) => `${t.taskId} ${t.baseline}/${k} → ${t.candidate}/${k}`).join(", ")})`;

  // Scorable at all?
  const rerun: string[] = [];
  if (!paired.size) rerun.push(`no task has ${k || "any"} valid run${k === 1 ? "" : "s"} in both arms`);
  else if (incomplete.length) rerun.push(`incomplete sweep: ${incomplete.length} task${incomplete.length === 1 ? "" : "s"} without ${k} valid runs per arm (${incomplete.slice(0, 5).join(", ")}${incomplete.length > 5 ? ", …" : ""})`);
  if (total && invalid / total > maxInvalid) rerun.push(`${invalid} of ${total} runs invalid (errored or cancelled) > ${Math.round(maxInvalid * 100)}%`);
  const itemRuns = results.filter((r) => r.bundleId === (o.mode === "add" ? o.candidate : o.baseline) && valid(r));
  const unknown = itemRuns.filter((r) => state(r) === "unknown").length;
  if (unknown) rerun.push(`exposure unknown on ${unknown} of ${itemRuns.length} ${o.mode === "add" ? "candidate" : "baseline"} rollouts (no captured trace)`);
  const versions = new Set([...(o.agentVersions?.entries() ?? [])].filter(([id, v]) => v && results.some((r) => r.id === id && valid(r))).map(([, v]) => v));
  if (versions.size > 1) rerun.push(`${versions.size} agent versions across runs (${[...versions].sort().join(", ")})`);
  if (o.mode === "add" && paired.size && !S.length) rerun.push("the item was never in context, so no task measures it");
  if (o.mode === "add" && S.length && !tasks.some((t) => t.baseline < k)) rerun.push("every exposed task already passed every run without the item: nothing to gain");
  if (rerun.length) return { verdict: "RERUN", ...base, reasons: rerun };

  if (o.mode === "remove") {
    if (fired === 0) return { verdict: "UNMEASURED", ...base, reasons: ["never fired in base rollouts; keep"] };
    const reasons: string[] = [];
    if (kN <= -m) reasons.push(`net ${signedRuns(kN)} ≤ −${m}`);
    if (overTau.length) reasons.push(drop);
    if (pLost.length) reasons.push(lostRun);
    if (reasons.length) return { verdict: "REJECT", ...base, reasons };
    // No regression: retire only when the agent does well without the item (arXiv 2610.32322 §5).
    const { U, A } = level as NonNullable<typeof level>;
    const near = Math.abs(U - retire) <= 0.2 + EPS && S.length < 3 ? [`near the retire level on ${S.length} task${S.length === 1 ? "" : "s"}: add tasks rather than runs (arXiv 2610.32322)`] : [];
    if (U < low - EPS && A < low - EPS) {
      return { verdict: "UNCOVERED", ...base, reasons: [`neither arm solves the exposed tasks (U ${dec(U)}, A ${dec(A)}): the item does not deliver what it teaches; keep and repair it, or check the tasks`] };
    }
    // An item whose removal wins m runs net hurts: drop it even below the retire level.
    if (kN >= m && U < retire - EPS) return { verdict: "ACCEPT", ...base, reasons: [`removing the item wins ${signedRuns(kN)} net, so it hurts; the pass rate without it (${dec(U)}) is still below the retire level ${dec(retire)}`] };
    if (U < retire - EPS) return { verdict: "UNMEASURED", ...base, reasons: [`pass rate without the item ${dec(U)} is below the retire level ${dec(retire)}; the agent has not shown it can do these tasks alone; keep`, ...near] };
    return { verdict: "ACCEPT", ...base, reasons: near };
  }

  const failed: { g: number; why: string }[] = [];
  if (!(G > 0)) failed.push({ g: 1, why: "g1: no exposed task improved (G=0)" });
  if (overTau.length) failed.push({ g: 2, why: `g2: ${drop}` });
  if (pLost.length) failed.push({ g: 3, why: `g3: ${lostRun}` });
  if (kN < m) failed.push({ g: 4, why: `g4: net ${signedRuns(kN)} < ${m}` });
  if (fired < 1) failed.push({ g: 5, why: "g5: never fired" });
  const reasons = failed.map((x) => x.why);
  if (!failed.length) return { verdict: "KEEP", ...base, reasons };
  if (failed.every((x) => x.g === 2 || x.g === 3)) {
    const recheck = [...new Set([...overTau, ...pLost].map((t) => t.taskId))].sort();
    return { verdict: "RECHECK", ...base, reasons, recheck };
  }
  return { verdict: "KILL", ...base, reasons };
}

/**
 * Settle a RECHECK with a re-run of its tasks at the same k: a drop on any of
 * them again kills the item, otherwise it is kept.
 */
export function resolveRecheck(first: ItemGateReport, results: readonly RunResult[], o: Pick<ItemGateOpts, "baseline" | "candidate">): ItemGateReport {
  if (first.verdict !== "RECHECK" || !first.recheck?.length) return first;
  const { paired, incomplete } = cells(results, { ...o, k: first.k }, new Set(first.recheck));
  const missing = [...first.recheck.filter((id) => !paired.has(id) && !incomplete.includes(id)), ...incomplete];
  if (missing.length) return { ...first, verdict: "RERUN", reasons: [`recheck incomplete: ${missing.join(", ")} without ${first.k} valid runs per arm`] };
  const again = [...paired].filter(([, c]) => passes(c.b) < passes(c.a)).map(([id]) => id);
  if (again.length) return { ...first, verdict: "KILL", reasons: [`regression recurred: ${again.join(", ")}`], recheck: undefined };
  return { ...first, verdict: "KEEP", reasons: [], recheck: undefined };
}

/**
 * The single instruction item B adds or removes, when that is B's only change:
 * one rule, one skill (its SKILL.md plus files under its dir) or one context
 * file. `other` is true when anything else differs (agent, model, flags, env,
 * changed files).
 */
export function singleItemChange(files: { added: readonly string[]; removed: readonly string[] }, other: boolean): { mode: "add" | "remove"; path: string } | undefined {
  if (other || (files.added.length && files.removed.length)) return undefined;
  const mode = files.added.length ? "add" : "remove";
  const paths = mode === "add" ? files.added : files.removed;
  const items = paths.filter((p) => harnessItem(p, ""));
  if (items.length !== 1) return undefined;
  const path = items[0] as string;
  const dir = /\/SKILL\.md$/.test(path) ? path.slice(0, -"SKILL.md".length) : undefined;
  if (!paths.every((p) => p === path || (dir && p.startsWith(dir)))) return undefined;
  return { mode, path };
}
