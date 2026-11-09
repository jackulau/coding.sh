// What a run's model calls did, for the experiment view and for compare:
// the "LLM calls" line, the replay noise floor of a control arm, and the note
// that replayed arms are correlated.
import type { CaseRun, ExperimentResult } from "../datasets/types.ts";
import { wilson } from "../stats/interval.ts";

export interface LlmTotals {
  calls: number;
  hits: number;
  live: number;
  /** Case-trials that ran with the cache. */
  trials: number;
  /** Replayed case-trials that could not run past the boundary (left unscored). */
  unscored: number;
}

export function llmTotals(runs: readonly Pick<CaseRun, "llm">[]): LlmTotals | undefined {
  const t: LlmTotals = { calls: 0, hits: 0, live: 0, trials: 0, unscored: 0 };
  for (const r of runs) {
    if (!r.llm) continue;
    t.trials++;
    t.calls += r.llm.calls;
    t.hits += r.llm.hits;
    t.live += r.llm.live;
    if (r.llm.unscored) t.unscored++;
  }
  return t.trials ? t : undefined;
}

/** `LLM calls: 412 (318 cached, 94 live)`, or undefined when the run did not use the cache. */
export function llmLine(r: Pick<ExperimentResult, "runs">): string | undefined {
  const t = llmTotals(r.runs);
  if (!t) return undefined;
  return `LLM calls: ${t.calls} (${t.hits} cached, ${t.live} live)`;
}

/** The run's `metadata.llm`, when it used the cache. */
export function llmMeta(r: Pick<ExperimentResult, "metadata">): { mode?: string; source?: string; until?: number; control?: string; noise?: LlmReplayNoise } | undefined {
  const m = r.metadata?.llm;
  return m && typeof m === "object" ? (m as { mode?: string }) : undefined;
}

/**
 * EM-19 for replays: how far a control arm (the recorded config, replayed at
 * the same boundary) drifts from the recording it replays.
 */
export interface LlmReplayNoise {
  source: string;
  /** Case-trials paired with the source by case and trial (scored on both sides). */
  n: number;
  /** Outputs that differ from the source's. */
  outputsDiffer: number;
  /** Pass verdicts that differ from the source's: the noise floor. */
  passDiffer: number;
  rate: number;
  lo: number;
  hi: number;
  /** Spread of firstLiveOrdinal over the control's case-trials that went live. */
  firstLive?: { n: number; min: number; median: number; max: number };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The control arm's divergence from the source recording; undefined when nothing pairs. */
export function controlNoise(control: Pick<ExperimentResult, "runs">, source: Pick<ExperimentResult, "id" | "runs">): LlmReplayNoise | undefined {
  const src = new Map(source.runs.map((r) => [`${r.caseId}\u0000${r.trial}`, r]));
  let n = 0;
  let outputsDiffer = 0;
  let passDiffer = 0;
  const firsts: number[] = [];
  for (const r of control.runs) {
    if (r.llm?.firstLiveOrdinal !== undefined) firsts.push(r.llm.firstLiveOrdinal);
    const s = src.get(`${r.caseId}\u0000${r.trial}`);
    if (!s || r.ungraded || s.ungraded || r.error !== undefined || s.error !== undefined) continue;
    n++;
    if (!same(r.output, s.output)) outputsDiffer++;
    if (r.pass !== s.pass) passDiffer++;
  }
  if (!n) return undefined;
  const w = wilson(passDiffer, n);
  const out: LlmReplayNoise = { source: source.id, n, outputsDiffer, passDiffer, rate: passDiffer / n, lo: w.lo, hi: w.hi };
  if (firsts.length) {
    firsts.sort((a, b) => a - b);
    out.firstLive = { n: firsts.length, min: firsts[0]!, median: firsts[Math.floor((firsts.length - 1) / 2)]!, max: firsts[firsts.length - 1]! };
  }
  return out;
}

export interface ComparisonLlmReplay {
  /** Which sides replayed recorded model calls. */
  replayed: ("a" | "b")[];
  note: string;
  /** The control arm's noise floor (A's metadata.llm.noise), when A was the control of a replay. */
  noise?: LlmReplayNoise;
  /** Set when |B − A| is below the noise floor. */
  warning?: string;
  /** Set when a side replayed with no control arm (--no-control). */
  controlWarning?: string;
}

/** The compare note for experiments that replayed recorded model calls; undefined when neither did. */
export function llmReplayNote(a: Pick<ExperimentResult, "metadata">, b: Pick<ExperimentResult, "metadata">, diffMean?: number): ComparisonLlmReplay | undefined {
  const ma = llmMeta(a);
  const mb = llmMeta(b);
  const replayed = ([["a", ma], ["b", mb]] as const).filter(([, m]) => m?.mode === "replay").map(([s]) => s);
  if (!replayed.length) return undefined;
  const out: ComparisonLlmReplay = {
    replayed: [...replayed],
    note: "Replayed arms are correlated: they reuse recorded model responses up to the first changed call, so the difference is smaller and less noisy than two live runs would show. Confirm with a fresh live run before you ship",
  };
  if (ma?.noise) {
    out.noise = ma.noise;
    if (diffMean !== undefined && Number.isFinite(diffMean) && Math.abs(diffMean) < ma.noise.rate) {
      out.warning = `B − A (${(diffMean * 100).toFixed(1)} points) is smaller than the replay noise floor (${(ma.noise.rate * 100).toFixed(0)}%): the control arm alone flips that many verdicts against the recording`;
    }
  }
  if (ma?.control === "skipped" || mb?.control === "skipped") out.controlWarning = "A replay ran without a control arm (--no-control): there is no replay noise floor to read the difference against";
  return out;
}

/** Lines for the compare view. */
export function renderLlmReplay(r: ComparisonLlmReplay, paint: (s: string, style: "dim" | "yellow") => string): string[] {
  const out: string[] = [];
  if (r.noise) {
    const n = r.noise;
    const fl = n.firstLive ? `; first live call ${n.firstLive.min}–${n.firstLive.max} (median ${n.firstLive.median})` : "";
    out.push(`llm replay noise floor ${(n.rate * 100).toFixed(0)}% (n=${n.n}) ${paint(`[${(n.lo * 100).toFixed(0)}%, ${(n.hi * 100).toFixed(0)}%]; control vs ${n.source}: ${n.outputsDiffer} output(s) differ${fl}`, "dim")}`);
  }
  if (r.warning) out.push(paint(`! ${r.warning}`, "yellow"));
  if (r.controlWarning) out.push(paint(`! ${r.controlWarning}`, "yellow"));
  out.push(paint(`! ${r.note}`, "yellow"));
  return out;
}
