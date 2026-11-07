// A/B of workflow variants (docs/design/workflows.md §6).
//
// runWorkflowExperiment schedules (case, attempt, variant) jobs interleaved
// across variants (like runner/experiment.ts scheduleJobs), concurrency 1 by
// default because a workflow already fans out internally. Each job gets
// CODING_SH_RUN_ID and CODING_SH_WORKFLOW_RUN_ID, its run tree is built from
// whatever the driver found, scored, tagged and stored.
//
// compareWorkflowVariants pairs by case: quality (per-case mean score
// difference → pairedBootstrap; per-case pass at the threshold → McNemar),
// cost / wall / critical path (per-case median difference → pairedBootstrap),
// a Pareto report over every variant, and a per-stage breakdown.
import { sortableId } from "../core/ids.ts";
import type { IndexStore } from "../core/types.ts";
import { infraKind, withRetries, type RetryPolicy } from "../jobs/retry.ts";
import type { JobScope } from "../jobs/store.ts";
import { pool } from "../runner/experiment.ts";
import { mcnemarPaired, mean, median, pairedBootstrap, type BootstrapResult, type McNemarResult } from "../stats/index.ts";
import { workflowStats } from "./metrics.ts";
import { extractFindings, matchFindings } from "./score/findings.ts";
import { splitTraces } from "./sources/otel.ts";
import type { WorkflowExperimentRecord, WorkflowStore } from "./store.ts";
import { buildWorkflowTree, type WorkflowTree } from "./tree.ts";
import type {
  MetricCompare,
  ParetoPoint,
  ReplayControl,
  StageDelta,
  WorkflowCase,
  WorkflowCompareReport,
  WorkflowDriver,
  WorkflowDriverResult,
  WorkflowFramework,
  WorkflowRun,
  WorkflowVariant,
} from "./types.ts";

export interface WorkflowJob {
  case: WorkflowCase;
  variant: WorkflowVariant;
  attempt: number;
}

/** Per case, attempts interleaved across variants (A1, B1, A2, B2, …). */
export function scheduleWorkflowJobs(cases: readonly WorkflowCase[], variants: readonly WorkflowVariant[], k: number): WorkflowJob[] {
  const jobs: WorkflowJob[] = [];
  for (const c of cases) for (let attempt = 1; attempt <= k; attempt++) for (const variant of variants) jobs.push({ case: c, variant, attempt });
  return jobs;
}

export type WorkflowScorer = (run: WorkflowRun, output: unknown, c: WorkflowCase) => Promise<number | undefined> | number | undefined;

/** Default scorer: F1 against seeded bugs; other truth kinds need an explicit scorer. */
export const defaultScorer: WorkflowScorer = (_run, output, c) => {
  if (c.truth.kind !== "seeded-bugs") return undefined;
  return matchFindings(extractFindings(output), c.truth.bugs).f1;
};

export interface RunWorkflowExperimentOpts {
  workflow: string;
  variants: WorkflowVariant[];
  cases: WorkflowCase[];
  k: number;
  driver: WorkflowDriver;
  store: WorkflowStore;
  /** Looked up for receiver spans tagged with the run id when the driver returns no sources. */
  index?: IndexStore;
  concurrency?: number;
  experimentId?: string;
  score?: WorkflowScorer;
  onProgress?: (p: { done: number; total: number; run: WorkflowRun; score?: number }) => void;
  /** No new job starts once aborted (a job already running is left to the process-exit kill). */
  signal?: AbortSignal;
  /** Graceful stop: no new job starts, the ones running finish and are kept. */
  drain?: AbortSignal;
  /**
   * Checkpoint and resume: each finished job is recorded here (run id and
   * score), and jobs already recorded are kept instead of run again. The
   * experiment id lives here too.
   */
  job?: JobScope;
  /** Re-run a job whose driver failed on an infrastructure error (rate limit, 5xx, network); a failed workflow is never retried. */
  retry?: RetryPolicy;
}

/** The checkpoint key of one (case, variant, attempt). */
export const workflowJobKey = (j: WorkflowJob): string => `${j.case.id}\u0000${j.variant.name}\u0000${j.attempt}`;

async function spansFor(index: IndexStore, runId: string): Promise<WorkflowTree | undefined> {
  const sessions = await index.listSessions({ runId, limit: 1000 });
  if (!sessions.length) return undefined;
  const events = (await Promise.all(sessions.map((s) => index.listEvents(s.id)))).flat().filter((e) => e.spanId);
  if (!events.length) return undefined;
  const tagged = events.map((e) => ({ ...e, runId }));
  const one = splitTraces(tagged).get(runId);
  return one ? buildWorkflowTree({ spans: one, runId }) : undefined;
}

function minimalRun(id: string, framework: WorkflowFramework, name: string, res: WorkflowDriverResult): WorkflowTree {
  const run: WorkflowRun = {
    id,
    framework,
    name,
    startedAt: res.startedAt ?? Date.now(),
    status: res.exitCode === 0 && !res.error ? "ok" : "failed",
    stats: undefined as unknown as WorkflowRun["stats"],
    tags: [],
    source: { kind: "driver" },
  };
  if (res.endedAt !== undefined) run.endedAt = res.endedAt;
  run.stats = workflowStats(run, []);
  return { run, nodes: [], outputs: {} };
}

const FRAMEWORKS = new Set<WorkflowFramework>(["claude-code-workflow", "claude-agent-sdk", "openai-agents", "langgraph", "crewai", "mastra", "otel", "command"]);

export async function runWorkflowExperiment(o: RunWorkflowExperimentOpts): Promise<{ experimentId: string; runs: WorkflowRun[]; scores: Map<string, number>; cancelled: boolean }> {
  const jobScope = o.job;
  const experimentId = jobScope?.state<string>("experimentId") ?? o.experimentId ?? sortableId("wfx_");
  const resumed = jobScope?.state<string>("experimentId") !== undefined;
  if (jobScope && !resumed) {
    await jobScope.setState("experimentId", experimentId);
    await jobScope.job.addRefs(experimentId);
  }
  const jobs = scheduleWorkflowJobs(o.cases, o.variants, Math.max(1, o.k));
  if (jobScope && jobScope.prefix === "") await jobScope.job.setTotal(jobs.length);
  const score = o.score ?? defaultScorer;
  const scores = new Map<string, number>();
  const runs: WorkflowRun[] = [];
  // A resume keeps the jobs already recorded; their runs are in the store.
  const kept = new Map<number, string>();
  jobs.forEach((j, i) => {
    const l = jobScope?.done(workflowJobKey(j));
    const id = l && !l.infra ? (l.data as { runId?: string } | undefined)?.runId : undefined;
    if (id) kept.set(i, id);
  });
  if (kept.size) {
    const byId = new Map((await o.store.listRuns({ experimentId })).map((r) => [r.id, r]));
    const rec = await o.store.getExperiment(experimentId);
    for (const [i, id] of [...kept]) {
      const r = byId.get(id);
      if (!r) {
        kept.delete(i); // recorded but not stored (killed between the two): run it again
        continue;
      }
      runs.push(r);
      const sc = rec?.scores[id];
      if (typeof sc === "number") scores.set(id, sc);
    }
  }
  let finished = 0;
  const record: WorkflowExperimentRecord = {
    id: experimentId,
    workflow: o.workflow,
    driver: o.driver.id,
    variants: o.variants,
    caseIds: o.cases.map((c) => c.id),
    k: Math.max(1, o.k),
    runIds: [],
    scores: {},
    createdAt: Date.now(),
  };
  if (!resumed) await o.store.putExperiment(record);
  let done = kept.size;
  await pool(jobs, o.concurrency ?? 1, async (job, i) => {
    if (kept.has(i)) {
      finished++;
      return;
    }
    if (o.signal?.aborted || o.drain?.aborted) return;
    const t0 = Date.now();
    let ourId = "";
    const tried = await withRetries(
      async (): Promise<WorkflowDriverResult> => {
        ourId = sortableId("wfr_");
        const env = { CODING_SH_RUN_ID: ourId, CODING_SH_WORKFLOW_RUN_ID: ourId };
        const started = Date.now();
        try {
          return await o.driver.run(job.variant, job.case, env);
        } catch (e) {
          return { runId: ourId, output: null, exitCode: null, startedAt: started, endedAt: Date.now(), error: e instanceof Error ? e.message : String(e) };
        }
      },
      {
        policy: o.retry ?? { retries: 0, baseMs: 0, maxMs: 0 },
        errorOf: (r) => r.error,
        // Only a driver that failed (no clean exit) can have failed on infrastructure.
        classify: (r) => (r.exitCode === 0 && !r.error ? undefined : infraKind(r.error ?? `exited ${r.exitCode}`)),
        stop: [o.signal, o.drain],
      },
    );
    const res = tried.result;
    if (o.signal?.aborted) return; // killed mid-run: not a finished job
    let tree: WorkflowTree | undefined;
    try {
      if (res.sources) tree = buildWorkflowTree(res.sources);
      else if (o.index) tree = await spansFor(o.index, res.runId || ourId);
    } catch {
      tree = undefined; // unreadable sources: keep the driver's view of the run
    }
    const framework: WorkflowFramework = FRAMEWORKS.has(o.driver.id as WorkflowFramework) ? (o.driver.id as WorkflowFramework) : "command";
    tree ??= minimalRun(res.runId || ourId, framework, o.workflow, res);
    const run = tree.run;
    run.variant = job.variant.name;
    run.experimentId = experimentId;
    run.caseId = job.case.id;
    run.attempt = job.attempt;
    run.tags = [...new Set([...run.tags, `variant:${job.variant.name}`, `case:${job.case.id}`])];
    if (res.error && run.status === "ok") run.status = "failed";
    if (tried.attempts > 1) run.attempts = tried.attempts;
    if (tried.infra) run.infra = tried.infra;
    let s: number | undefined;
    try {
      s = await score(run, res.output, job.case);
    } catch {
      s = undefined;
    }
    if (typeof s === "number" && Number.isFinite(s)) scores.set(run.id, s);
    await o.store.putRun(run, tree.nodes, { outputs: tree.outputs, runOutput: res.output ?? tree.runOutput, ...(res.sources?.script !== undefined ? { script: res.sources.script } : {}) });
    runs.push(run);
    // Append, never rewrite the record: a rewrite from this in-memory copy would
    // erase a `workflows score` written meanwhile, and concurrent jobs' rewrites
    // could land out of order and drop a run (VWR-6).
    await o.store.addExperimentRun(experimentId, run.id, scores.get(run.id));
    if (jobScope) {
      await jobScope.record(workflowJobKey(job), {
        ms: Date.now() - t0,
        ...(tried.attempts > 1 ? { attempts: tried.attempts } : {}),
        ...(typeof run.stats?.costUsd === "number" && Number.isFinite(run.stats.costUsd) ? { costUsd: run.stats.costUsd } : {}),
        ...(tried.infra ? { infra: tried.infra } : {}),
        outcome: run.status === "ok" ? "pass" : "fail",
        data: { runId: run.id },
      });
    }
    done++;
    finished++;
    o.onProgress?.({ done, total: jobs.length, run, ...(s !== undefined ? { score: s } : {}) });
  });
  return { experimentId, runs, scores, cancelled: finished < jobs.length };
}

// ------------------------------------------------------------ comparing

export interface CompareWorkflowOpts {
  baseline: string;
  candidate: string;
  /** Pass threshold for the binary outcome: one number, or per case id. Default: case threshold, else 0.5. */
  threshold?: number | Map<string, number>;
  alpha?: number;
  iters?: number;
  seed?: number;
}

const finite = (xs: (number | undefined)[]): number[] => xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));

function byCase(runs: readonly WorkflowRun[]): Map<string, WorkflowRun[]> {
  const m = new Map<string, WorkflowRun[]>();
  for (const r of runs) {
    const k = r.caseId ?? "";
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}

const METRIC_GET: Record<Exclude<MetricCompare["key"], "quality">, (r: WorkflowRun) => number | undefined> = {
  costUsd: (r) => r.stats.costUsd,
  wallMs: (r) => r.stats.wallMs,
  criticalPathMs: (r) => r.stats.criticalPathMs,
};

function pairedMetric(
  key: MetricCompare["key"],
  a: Map<string, WorkflowRun[]>,
  b: Map<string, WorkflowRun[]>,
  perCase: (rs: WorkflowRun[]) => number | undefined,
  boot: { iters?: number; seed?: number; alpha: number },
): MetricCompare & { cases: string[]; va: number[]; vb: number[] } {
  const va: number[] = [];
  const vb: number[] = [];
  const cases: string[] = [];
  for (const [id, ra] of a) {
    const rb = b.get(id);
    if (!rb) continue;
    const x = perCase(ra);
    const y = perCase(rb);
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    va.push(x);
    vb.push(y);
    cases.push(id);
  }
  const diff = pairedBootstrap(vb.map((y, i) => y - va[i]!), boot);
  return { key, baseline: mean(va), candidate: mean(vb), diff, pairs: va.length, cases, va, vb };
}

function interval(xs: number[], boot: { iters?: number; seed?: number; alpha: number }): { mean: number; lo: number; hi: number } {
  const r = pairedBootstrap(xs, boot);
  return { mean: r.mean, lo: r.lo, hi: r.hi };
}

const pp = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
const pval = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

function decide(paired: number, boot: BootstrapResult, mcn: McNemarResult, alpha: number): WorkflowCompareReport["verdict"] {
  if (paired === 0) return { kind: "inconclusive", text: "inconclusive: no scored case ran in both variants" };
  const level = `${Math.round((1 - alpha) * 100)}%`;
  const ci = `${level} CI [${pp(boot.lo)}, ${pp(boot.hi)}]`;
  const bootSig = boot.lo > 0 || boot.hi < 0;
  const mcSig = mcn.p < alpha;
  const small = paired < 10 ? ` (only ${paired} case${paired === 1 ? "" : "s"}; underpowered)` : "";
  if (bootSig && mcSig) {
    const better = boot.mean > 0;
    return { kind: better ? "better" : "worse", text: `candidate ${better ? "better" : "worse"}: ${pp(boot.mean)} quality, ${ci}, McNemar ${pval(mcn.p)}` };
  }
  if (!bootSig && !mcSig) return { kind: "no-difference", text: `no significant difference: ${pp(boot.mean)} quality, ${ci} includes 0, McNemar ${pval(mcn.p)}${small}` };
  return {
    kind: "inconclusive",
    text: `inconclusive: ${pp(boot.mean)} quality; ${bootSig ? `bootstrap ${ci} excludes 0 but McNemar ${pval(mcn.p)}` : `McNemar ${pval(mcn.p)} but bootstrap ${ci} includes 0`}${small}; run more cases or attempts`,
  };
}

function stageDeltas(a: readonly WorkflowRun[], b: readonly WorkflowRun[]): StageDelta[] {
  const agg = (runs: readonly WorkflowRun[]) => {
    const m = new Map<string, { cost: number[]; wall: number[]; agent: number[] }>();
    for (const r of runs) {
      for (const p of r.stats.perPhase ?? []) {
        const x = m.get(p.phase) ?? { cost: [], wall: [], agent: [] };
        if (p.costUsd !== undefined) x.cost.push(p.costUsd);
        if (p.wallMs !== undefined) x.wall.push(p.wallMs);
        x.agent.push(p.agentMs);
        m.set(p.phase, x);
      }
    }
    return m;
  };
  const ma = agg(a);
  const mb = agg(b);
  const phases = [...new Set([...ma.keys(), ...mb.keys()])];
  return phases.map((phase) => {
    const x = ma.get(phase) ?? { cost: [], wall: [], agent: [] };
    const y = mb.get(phase) ?? { cost: [], wall: [], agent: [] };
    const side = (v: typeof x) => {
      const o: StageDelta["baseline"] = { agentMs: v.agent.length ? mean(v.agent) : 0 };
      if (v.cost.length) o.costUsd = mean(v.cost);
      if (v.wall.length) o.wallMs = mean(v.wall);
      return o;
    };
    const bs = side(x);
    const cs = side(y);
    const d: StageDelta = { phase, baseline: bs, candidate: cs, deltaAgentMs: cs.agentMs - bs.agentMs };
    if (bs.costUsd !== undefined && cs.costUsd !== undefined) d.deltaCostUsd = cs.costUsd - bs.costUsd;
    if (bs.wallMs !== undefined && cs.wallMs !== undefined) d.deltaWallMs = cs.wallMs - bs.wallMs;
    return d;
  });
}

function pareto(runs: readonly WorkflowRun[], scores: Map<string, number>, boot: { iters?: number; seed?: number; alpha: number }): ParetoPoint[] {
  const variants = [...new Set(runs.map((r) => r.variant).filter((v): v is string => !!v))].sort();
  const pts: ParetoPoint[] = variants.map((variant) => {
    const cases = byCase(runs.filter((r) => r.variant === variant));
    const q = finite([...cases.values()].map((rs) => (finite(rs.map((r) => scores.get(r.id))).length ? mean(finite(rs.map((r) => scores.get(r.id)))) : undefined)));
    const c = finite([...cases.values()].map((rs) => (finite(rs.map(METRIC_GET.costUsd)).length ? median(finite(rs.map(METRIC_GET.costUsd))) : undefined)));
    const w = finite([...cases.values()].map((rs) => (finite(rs.map(METRIC_GET.wallMs)).length ? median(finite(rs.map(METRIC_GET.wallMs))) : undefined)));
    return { variant, cases: cases.size, quality: interval(q, boot), costUsd: interval(c, boot), wallMs: interval(w, boot), dominated: false };
  });
  // x dominates y: no worse on every dimension both know, strictly better on one.
  const dominates = (x: ParetoPoint, y: ParetoPoint): boolean => {
    const dims: [number, number, 1 | -1][] = [
      [x.quality.mean, y.quality.mean, 1],
      [x.costUsd.mean, y.costUsd.mean, -1],
      [x.wallMs.mean, y.wallMs.mean, -1],
    ];
    let strict = false;
    let compared = 0;
    for (const [a, b, dir] of dims) {
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      compared++;
      if ((a - b) * dir < 0) return false;
      if ((a - b) * dir > 0) strict = true;
    }
    return compared > 0 && strict;
  };
  for (const p of pts) {
    const by = pts.filter((q) => q !== p && dominates(q, p)).map((q) => q.variant);
    if (by.length) {
      p.dominated = true;
      p.dominatedBy = by;
    }
  }
  return pts;
}

/**
 * Control fork for replays (EM-19). A candidate that resumes from recorded runs differs from
 * a fresh baseline in two ways: the edit, and the replay itself (cached prefix, drifted
 * environment). Only a baseline replayed from the same recorded runs separates the two, and
 * how often that control's outcome moves away from its source run is the replay noise floor.
 */
function replayControl(A: readonly WorkflowRun[], B: readonly WorkflowRun[], scores: Map<string, number>, thr: (caseId: string) => number): ReplayControl | undefined {
  const sources = new Set(B.map((r) => r.resumedFrom).filter((s): s is string => !!s));
  if (!sources.size) return undefined;
  const controls = A.filter((r) => r.resumedFrom && sources.has(r.resumedFrom));
  const out: ReplayControl = { sources: [...sources].sort(), controlRuns: controls.length };
  let n = 0;
  let changed = 0;
  for (const r of controls) {
    const s = scores.get(r.id);
    const s0 = scores.get(r.resumedFrom!);
    if (s === undefined || s0 === undefined) continue;
    n++;
    const t = thr(r.caseId ?? "");
    if (s >= t !== s0 >= t) changed++;
  }
  if (n) out.drift = { n, changed, rate: changed / n };
  return out;
}

export function compareWorkflowVariants(runs: WorkflowRun[], scores: Map<string, number>, o: CompareWorkflowOpts): WorkflowCompareReport {
  const alpha = o.alpha ?? 0.05;
  const boot = { ...(o.iters !== undefined ? { iters: o.iters } : {}), ...(o.seed !== undefined ? { seed: o.seed } : {}), alpha };
  // A run that failed on infrastructure never measured the workflow.
  const A = runs.filter((r) => r.variant === o.baseline && !r.infra);
  const B = runs.filter((r) => r.variant === o.candidate && !r.infra);
  const ca = byCase(A);
  const cb = byCase(B);
  const all = [...new Set([...ca.keys(), ...cb.keys()])].sort();
  const unpaired = all.filter((id) => !ca.has(id) || !cb.has(id));

  const qOf = (rs: WorkflowRun[]) => {
    const xs = finite(rs.map((r) => scores.get(r.id)));
    return xs.length ? mean(xs) : undefined;
  };
  const quality = pairedMetric("quality", ca, cb, qOf, boot);
  const thr = (id: string) => (typeof o.threshold === "number" ? o.threshold : (o.threshold?.get(id) ?? 0.5));
  const mcn = mcnemarPaired(
    quality.va.map((x, i) => x >= thr(quality.cases[i]!)),
    quality.vb.map((x, i) => x >= thr(quality.cases[i]!)),
  );
  const metrics: MetricCompare[] = [];
  for (const key of ["costUsd", "wallMs", "criticalPathMs"] as const) {
    const get = METRIC_GET[key];
    const m = pairedMetric(key, ca, cb, (rs) => {
      const xs = finite(rs.map(get));
      return xs.length ? median(xs) : undefined;
    }, boot);
    if (m.pairs) metrics.push({ key: m.key, baseline: m.baseline, candidate: m.candidate, diff: m.diff, pairs: m.pairs });
  }
  const notes: string[] = [];
  if (unpaired.length) notes.push(`${unpaired.length} case(s) ran in only one variant and are excluded from paired stats`);
  const unscored = [...A, ...B].filter((r) => !scores.has(r.id)).length;
  if (unscored) notes.push(`${unscored} run(s) have no score and are left out of quality`);
  const failed = [...A, ...B].filter((r) => r.status !== "ok").length;
  if (failed) notes.push(`${failed} run(s) did not finish ok`);
  if (A.some((r) => r.resumedFrom) || B.some((r) => r.resumedFrom)) notes.push("replayed runs hold upstream outputs fixed, which understates variance; use ≥ 3 base runs per case");
  const control = replayControl(A, B, scores, thr);
  if (control && !control.controlRuns) {
    notes.push(
      `no control fork: ${o.candidate} resumes from ${control.sources.length} recorded run(s) but no ${o.baseline} run resumes from the same one(s), so the difference mixes the edit with the replay itself; add a variant that resumes the unedited script from the same run(s) and compare against it`,
    );
  } else if (control?.drift) {
    const d = control.drift;
    notes.push(`replay noise floor: ${d.changed} of ${d.n} control replay(s) changed outcome from their source run (${(d.rate * 100).toFixed(0)}%); differences below that are replay drift`);
  }
  const verdict = decide(quality.pairs, quality.diff, mcn, alpha);
  const cost = metrics.find((m) => m.key === "costUsd");
  if (cost && Number.isFinite(cost.baseline) && cost.baseline > 0) {
    const rel = (cost.candidate - cost.baseline) / cost.baseline;
    if (Math.abs(rel) >= 0.05) notes.push(`quality aside, candidate is ${Math.abs(rel * 100).toFixed(0)}% ${rel < 0 ? "cheaper" : "more expensive"} per run`);
  }
  return {
    baseline: o.baseline,
    candidate: o.candidate,
    runs: { baseline: A.length, candidate: B.length },
    pairedCases: quality.pairs,
    unpairedCases: unpaired,
    quality: { key: "quality", baseline: quality.baseline, candidate: quality.candidate, diff: quality.diff, pairs: quality.pairs },
    mcnemar: mcn,
    metrics,
    pareto: pareto(runs, scores, boot),
    stages: stageDeltas(A, B),
    verdict,
    notes,
    alpha,
    ...(control ? { control } : {}),
  };
}
