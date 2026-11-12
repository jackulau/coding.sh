// One benchmark run: generate → sample → redact → freeze → run every
// contender on the frozen set in a seeded interleaved order → grade →
// summarize → store.
//
// Fairness, in code:
//  - the sample is frozen as a dataset version (content-hashed) before any
//    contender runs, and every contender gets exactly that set;
//  - jobs are ordered case by case, with the contender order shuffled per
//    case (seeded), so no contender always goes first or last;
//  - every contender runs under the same time limit and retry policy;
//  - a case that couldn't be measured for one contender (quota, rate limit,
//    a grader that failed twice) is dropped for all of them;
//  - the seed, the case list and its sha256 go into the run record;
//  - only the first complete scheduled run per date counts for history.
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { version as codingShVersion } from "../cli/meta.ts";
import { sortableId } from "../core/ids.ts";
import { costFrom, lookupPrice, PRICE_SOURCES, pricesFor, type Prices } from "../core/pricing.ts";
import { createRedactor } from "../core/redact.ts";
import type { Adapter, BlobStore, HarnessBundle, IndexStore } from "../core/types.ts";
import { createDataset } from "../datasets/dataset.ts";
import { canonicalJson, contentHash } from "../datasets/hash.ts";
import type { FileEvalStore } from "../datasets/store.ts";
import type { Case, ExperimentResult, Grader } from "../datasets/types.ts";
import { summarizeRuns } from "../experiments/run.ts";
import { createGrader, type GraderDeps } from "../graders/index.ts";
import { mapPool } from "../judge/limit.ts";
import { commitFor, maskSeed } from "./commit.ts";
import { resolveContender, type Answer, type ResolvedContender } from "./contenders.ts";
import { dateOf, resolveSeed, sampleCases, seededShuffle, type SampleResult } from "./sample.ts";
import { generateCases, snapshotPage, sourceRef, type FetchFn, type PageSnapshot } from "./sources.ts";
import { assignPlaces, cellsToRuns, comparePairs, countedCells, discordanceOf, powerPlan, summarizeContender, type PowerPlan } from "./stats.ts";
import { gridAnalysis, type GridAxes } from "./grid.ts";
import { specialization } from "./specialization.ts";
import { getBlob, historyRuns, ledger, listRuns, putBlob, putRun } from "./store.ts";
import { jobConfig } from "../jobs/config.ts";
import { infraKind, retryPolicy, withRetries, type InfraKind } from "../jobs/retry.ts";
import { JobStore, type Job } from "../jobs/store.ts";
import type { AnchorResult, BenchDef, BenchRun, Cell, ContenderRecord, ContenderSpec, ExcludeReason, FailureMode, FrozenCase, SeedCommit } from "./types.ts";

export class BenchRunError extends Error {
  /** The command that continues the stopped run, when there is one to continue. */
  readonly resume: string | undefined;
  constructor(message: string, o: { resume?: string } = {}) {
    super(message);
    this.name = "BenchRunError";
    this.resume = o.resume;
  }
}

/** The command that continues stopped run `id` of benchmark `name`. */
export const resumeCommand = (name: string, id: string): string => `coding.sh bench run ${name} --resume ${id}`;

export interface RunBenchOpts {
  def: BenchDef;
  env: NodeJS.ProcessEnv;
  now?: number;
  /** Count the run for this UTC date (YYYY-MM-DD); the default seed derives from it. Makes the run adhoc. */
  date?: string;
  /** Override the definition's seed with a fixed value. Makes the run adhoc. */
  seed?: string;
  /** Override the definition's case count. Makes the run adhoc. */
  cases?: number;
  /** Mark the run adhoc (kept out of history and the freshness ledger). */
  adhoc?: boolean;
  concurrency?: number;
  index?: IndexStore;
  evalStore?: FileEvalStore;
  blobs?: BlobStore;
  getAdapter?: (id: string) => Adapter | undefined;
  getBundle?: (ref: string) => Promise<HarnessBundle | undefined>;
  graderDeps?: GraderDeps;
  fetch?: FetchFn;
  signal?: AbortSignal;
  /** Graceful stop (first Ctrl-C): calls in flight finish and are kept, no new call starts. */
  drain?: AbortSignal;
  /** Sample only: no freeze, no contender runs, nothing stored. */
  dryRun?: boolean;
  /** Price table for calls that report tokens but no cost (default: built-in prices). The CLI passes pricesFor(config.pricing). */
  prices?: Prices;
  onProgress?: (done: number, total: number, phase: "sample" | "snapshot" | "run") => void;
}

export interface CostEstimate {
  /** Expected spend for the known contenders, undefined when none is known. */
  usd?: number;
  /** Per-call estimate by contender (costPerRun, else the mean from its last complete run). */
  perCall: Record<string, number | undefined>;
  /** Contenders with no price and no cost history. */
  unknown: string[];
  calls: number;
}

export interface DryRunResult {
  dryRun: true;
  bench: string;
  date: string;
  /** With seed = "secret" the salt is masked: it is revealed only in the run record. */
  seed: string;
  /** seed = "secret": sha256 of today's salt (what the previous run published). */
  commitment?: string;
  mode: "scheduled" | "adhoc";
  sampling: SampleResult;
  /** The anchor set this run would use: reused from a record, or picked now. */
  anchor?: { version: string; cases: number; stored: boolean };
  cases: FrozenCase[];
  redacted: number;
  plan: PowerPlan;
  estimate: CostEstimate;
  budgetUsd?: number;
}

const STANDARD_FAILURES = new Set(["timeout", "http-error", "crash", "empty", "wrong", "grader-error", "error"]);
const QUOTA_RE = /\b(quota|rate[ -]?limit(ed|s)?|too many requests|insufficient[_ ](credits?|balance|funds|quota)|credit balance|billing)\b/i;

/**
 * Whether an answer means "couldn't measure" rather than "did badly":
 * HTTP 401/402/429, quota and rate-limit errors, or a contender reporting
 * one of those as its failure. Timeouts and crashes are never excluded.
 */
export function exclusionOf(error: string | undefined, answer?: Pick<Answer, "failure">): ExcludeReason | undefined {
  if (answer?.failure && /^(quota|rate-?limit(ed)?|auth|unauthorized|billing|payment-required)$/i.test(answer.failure)) return "quota";
  if (error === undefined || /timed out/i.test(error)) return undefined;
  if (/\bHTTP (401|402|429)\b/.test(error) || QUOTA_RE.test(error)) return "quota";
  return undefined;
}

export function classifyFailure(o: { error?: string; answer?: Pick<Answer, "output" | "failure">; graderError?: boolean; pass?: boolean }): FailureMode | undefined {
  if (o.error !== undefined) {
    if (/timed out/i.test(o.error)) return "timeout";
    if (/HTTP \d{3}/.test(o.error)) return "http-error";
    if (/exited -?\d+|killed by|could not start/.test(o.error)) return "crash";
    return "error";
  }
  if (o.answer?.failure) return o.answer.failure;
  if (isEmpty(o.answer?.output)) return "empty";
  if (o.graderError) return "grader-error";
  if (o.pass === false) return "wrong";
  return undefined;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

function preview(v: unknown, n = 400): string | undefined {
  if (v === undefined) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return undefined;
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function freeze(sample: SampleResult): FrozenCase[] {
  return sample.cases.map((s) => {
    const f: FrozenCase = { id: s.case.id, key: s.key, input: s.case.input };
    if (s.stratum !== undefined) f.stratum = s.stratum;
    if (s.case.expected !== undefined) f.expected = s.case.expected;
    if (s.case.metadata) f.metadata = s.case.metadata;
    if (s.case.sourceSessionId) f.sourceSessionId = s.case.sourceSessionId;
    const created = s.case.metadata?.createdAt;
    if (typeof created === "string") f.createdAt = created;
    f.contentSha256 = caseContentHash(s.case);
    return f;
  });
}

/** sha256 over the canonical, id-sorted case list: anyone can recompute it from the published cases. */
export function casesSha256(cases: readonly Pick<Case, "id" | "input" | "expected" | "metadata">[]): string {
  return contentHash([...cases].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((c) => ({ id: c.id, input: c.input ?? null, expected: c.expected, metadata: c.metadata })));
}

/** Redact secrets in every case at freeze (input, expected, metadata). Returns how many cases changed. */
export function redactCases(cases: Case[]): number {
  const r = createRedactor({ redact: ["secrets"] });
  let changed = 0;
  for (const c of cases) {
    const before = canonicalJson({ i: c.input ?? null, e: c.expected ?? null, m: c.metadata ?? null });
    c.input = r.value(c.input);
    if (c.expected !== undefined) c.expected = r.value(c.expected);
    if (c.metadata) c.metadata = r.value(c.metadata);
    if (canonicalJson({ i: c.input ?? null, e: c.expected ?? null, m: c.metadata ?? null }) !== before) changed++;
  }
  return changed;
}

/** Expected spend: per-call price (costPerRun, else the contender's mean cost in its last complete run) × calls. */
export function estimateCost(def: BenchDef, past: readonly BenchRun[], cases: number): CostEstimate {
  const perCall: Record<string, number | undefined> = {};
  const unknown: string[] = [];
  for (const c of def.contenders) {
    let v = c.costPerRun;
    if (v === undefined) {
      for (const r of [...past].reverse()) {
        if ((r.status ?? "complete") !== "complete") continue;
        const rec = r.contenders.find((x) => x.name === c.name);
        if (!rec || (rec.hash && rec.hash !== def.contenderHashes[c.name])) continue;
        const costs = r.cells.filter((x) => x.contender === c.name && x.costUsd !== undefined).map((x) => x.costUsd!);
        if (costs.length) {
          v = costs.reduce((a, b) => a + b, 0) / costs.length;
          break;
        }
      }
    }
    perCall[c.name] = v;
    if (v === undefined) unknown.push(c.name);
  }
  const calls = cases * def.trials;
  const known = def.contenders.filter((c) => perCall[c.name] !== undefined);
  const est: CostEstimate = { perCall, unknown, calls };
  if (known.length) est.usd = known.reduce((s, c) => s + perCall[c.name]! * calls, 0);
  return est;
}

// ---------------------------------------------------------------- grading

type GradeRow = NonNullable<Cell["grades"]>[number];

async function gradeAll(graders: readonly Grader[], c: Case, output: unknown, expected: unknown, signal?: AbortSignal): Promise<{ grades: GradeRow[]; failed: boolean }> {
  let failed = false;
  const grades = await Promise.all(
    graders.map(async (g): Promise<GradeRow> => {
      let last: unknown;
      // A grader error gets one retry; a second failure excludes the case for everyone.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await g.grade({ input: c.input, output, expected, caseId: c.id, ...(c.metadata ? { metadata: c.metadata } : {}), ...(signal ? { signal } : {}) });
          return { grader: g.id, score: r.score, pass: r.pass, ...(r.reason ? { reason: r.reason.slice(0, 300) } : {}) };
        } catch (e) {
          last = e;
        }
      }
      failed = true;
      return { grader: g.id, score: 0, pass: false, reason: `grader error: ${(last as Error)?.message ?? String(last)}`.slice(0, 300) };
    }),
  );
  return { grades, failed };
}

/** Pass, score, failure mode and exclusion for a cell once its answer and grades are known. */
function settle(cell: Cell, o: { answer?: Pick<Answer, "output" | "failure">; grades?: GradeRow[]; graderFailed: boolean; graders: number }): void {
  let pass = cell.error === undefined;
  delete cell.failure;
  if (o.grades) {
    cell.grades = o.grades;
    cell.score = o.grades.length ? o.grades.reduce((s, g) => s + g.score, 0) / o.grades.length : 0;
    pass = pass && o.grades.every((g) => g.pass);
  }
  if (o.graderFailed && cell.error === undefined) cell.excluded = "grader-error";
  const failure = classifyFailure({ ...(cell.error !== undefined ? { error: cell.error } : {}), ...(o.answer ? { answer: o.answer } : {}), graderError: o.graderFailed, pass });
  if (failure) cell.failure = failure;
  cell.pass = pass && !failure && !cell.excluded;
  if (!o.graders) cell.score = cell.pass ? 1 : 0;
}

/** Graders compare against the case's expected value, else the page snapshot taken at freeze (urls source). */
function expectedFor(def: Pick<BenchDef, "name">, env: NodeJS.ProcessEnv): (c: Case) => Promise<unknown> {
  const cache = new Map<string, Promise<unknown>>();
  return (c) => {
    if (c.expected !== undefined) return Promise.resolve(c.expected);
    const sha = (c.metadata?.snapshot as PageSnapshot | undefined)?.sha256;
    if (!sha) return Promise.resolve(undefined);
    if (!cache.has(sha)) cache.set(sha, getBlob(def.name, sha, env).then((b) => b?.toString("utf8")));
    return cache.get(sha)!;
  };
}

async function loadGraders(def: BenchDef, env: NodeJS.ProcessEnv, deps?: GraderDeps): Promise<Grader[]> {
  let graders: Grader[];
  try {
    graders = await Promise.all(def.graders.map((g) => createGrader(g, { baseDir: def.baseDir, env, ...(deps ?? {}) })));
  } catch (e) {
    throw new BenchRunError(`invalid grader: ${(e as Error).message}`);
  }
  const ids = new Set<string>();
  for (const g of graders) {
    if (ids.has(g.id)) throw new BenchRunError(`two graders share the id ${JSON.stringify(g.id)}; give one a distinct name`);
    ids.add(g.id);
  }
  return graders;
}

// ---------------------------------------------------------------- stats

/** Comparisons, summaries, exclusions and warnings from a run's cells. Shared by run and regrade. */
function finalize(
  cells: readonly Cell[],
  contenders: readonly { name: string; kind: string; ref: string; experimentId?: string; axes?: GridAxes }[],
  o: { trials: number; dataset: { id: string; name: string; version: string }; graders: string[]; cases: number; stopReason?: string },
): Pick<BenchRun, "summaries" | "comparisons" | "excluded" | "warnings" | "specialization" | "grid"> {
  const names = contenders.map((c) => c.name);
  const { cells: counted, dropped } = countedCells(cells, names, o.trials);
  const byReason: Record<string, number> = {};
  for (const id of dropped) {
    const why = cells.find((x) => x.caseId === id && x.excluded)?.excluded ?? (o.stopReason === "budget" ? "budget" : "aborted");
    byReason[why] = (byReason[why] ?? 0) + 1;
  }
  const share = o.cases ? dropped.size / o.cases : 0;
  const warnings: string[] = [];
  const noVerdict = share > 0.1;
  if (dropped.size) {
    const parts = Object.entries(byReason).map(([k, v]) => `${v} ${k}`).join(", ");
    if (noVerdict) warnings.push(`${dropped.size} of ${o.cases} cases excluded for every contender (${parts}): over 10%, so no winner is declared`);
    else if (share > 0.02) warnings.push(`degraded: ${dropped.size} of ${o.cases} cases excluded for every contender (${parts})`);
    else warnings.push(`${dropped.size} of ${o.cases} cases excluded for every contender (${parts})`);
  }
  const comparisons = comparePairs(counted, names, { trials: o.trials, dataset: o.dataset, graders: o.graders, noVerdict: noVerdict && `${dropped.size} of ${o.cases} cases excluded, over 10%` });
  const summaries = assignPlaces(
    contenders.map((c) => summarizeContender(counted, c, o.trials)),
    comparisons,
  );
  for (const s of summaries) if (s.n && s.errors === s.n) warnings.push(`${s.contender} errored on every case: check its command or endpoint`);
  // Both are left out of the record when they don't apply (too few cases or contenders, no complete grid).
  const spec = specialization(counted, names, o.trials);
  const grid = gridAnalysis(counted, contenders);
  return {
    summaries,
    comparisons,
    excluded: { cases: dropped.size, ids: [...dropped].sort(), byReason },
    warnings,
    ...("skipped" in spec ? {} : { specialization: spec }),
    ...("skipped" in grid ? {} : { grid }),
  };
}

// ---------------------------------------------------------------- run

/** What a case measures, hashed at freeze: the page body for a urls snapshot that loaded, else {input, expected}. */
export function caseContentHash(c: Pick<Case, "input" | "expected" | "metadata">): string {
  const snap = c.metadata?.snapshot as PageSnapshot | undefined;
  if (snap?.sha256 && snap.status >= 200 && snap.status < 300) return snap.sha256;
  return contentHash({ input: c.input ?? null, expected: c.expected ?? null });
}

function toCase(f: FrozenCase): Case {
  return { id: f.id, input: f.input, ...(f.expected !== undefined ? { expected: f.expected } : {}), ...(f.metadata ? { metadata: f.metadata } : {}), ...(f.sourceSessionId ? { sourceSessionId: f.sourceSessionId } : {}) };
}

/**
 * The anchor set a run reuses: the one in the newest record (counted runs
 * first) whose anchor version and size match the definition. Records carry
 * the cases themselves, so the set survives source changes and lost blobs.
 */
export function storedAnchor(def: Pick<BenchDef, "anchor">, past: readonly BenchRun[]): { cases: FrozenCase[]; frozenBy: string } | undefined {
  const spec = def.anchor;
  if (!spec) return undefined;
  const match = (r: BenchRun) => r.anchor?.version === spec.version && r.anchor.requested === spec.cases && r.cases.some((c) => c.anchor);
  const from = historyRuns(past).filter(match).at(-1) ?? [...past].filter(match).sort((a, b) => a.startedAt - b.startedAt).at(-1);
  if (!from) return undefined;
  return { cases: from.cases.filter((c) => c.anchor).map((c) => structuredClone(c)), frozenBy: from.anchor!.frozenBy };
}

/** Everything a run needs before the first call; a resume rebuilds it from the record. */
interface Plan {
  runId: string;
  date: string;
  seed: string;
  seedCommit?: SeedCommit;
  mode: "scheduled" | "adhoc";
  requested: number;
  frozen: FrozenCase[];
  cases: Case[];
  dataset: { id: string; name: string; version: string };
  sha256: string;
  sampling: BenchRun["sampling"];
  snapshots?: BenchRun["snapshots"];
  redacted: number;
  /** What the source returned (for the "asked for N, got M" warning). */
  poolSize: number;
  anchor?: { version: string; requested: number; frozenBy: string };
  estimate: CostEstimate;
  startedAt: number;
  /** Cells already finished (resume). */
  kept: Cell[];
  spent: number;
  resumed?: NonNullable<BenchRun["resumed"]>;
  /** Contender order the job shuffle starts from (the original record's, on resume). */
  order: string[];
  /** Versions recorded by the original run (resume keeps them). */
  versions?: Record<string, string | undefined>;
}

interface Executed {
  cells: Cell[];
  stopReason?: BenchRun["stopReason"];
  spent: number;
  calls: number;
  total: number;
  contenders: ResolvedContender[];
  versions: (string | undefined)[];
  graders: Grader[];
  priced: boolean;
}

function cellKey(x: Pick<Cell, "caseId" | "contender" | "trial">): string {
  return `${x.caseId}\u0000${x.contender}\u0000${x.trial}`;
}

/** The checkpoint of a bench run (one line per finished cell); its config is the protocol and the contenders. */
function benchJobConfig(def: BenchDef) {
  return jobConfig({ protocol: def.protocolHash, contenders: def.contenderHashes });
}

/** Run every job not already finished, in the seeded interleaved order. */
async function execute(def: BenchDef, plan: Plan, opts: RunBenchOpts, job?: Job): Promise<Executed> {
  const { env } = opts;
  const byName = new Map(def.contenders.map((c) => [c.name, c]));
  const contenders: ResolvedContender[] = plan.order.map((name) =>
    resolveContender(byName.get(name)!, {
      baseDir: def.baseDir,
      env,
      timeoutMs: def.timeoutMs,
      ...(opts.getAdapter ? { getAdapter: opts.getAdapter } : {}),
      ...(opts.getBundle ? { getBundle: opts.getBundle } : {}),
      ...(opts.blobs ? { blobs: opts.blobs } : {}),
    }),
  );
  const versions = await Promise.all(contenders.map(async (c) => plan.versions?.[c.name] ?? (await c.version())));
  const graders = await loadGraders(def, env, opts.graderDeps);
  const expected = expectedFor(def, env);
  const redactor = createRedactor({ redact: ["secrets"] });
  const prices = opts.prices ?? pricesFor();
  let priced = false;

  // Interleaved, seeded order: cases shuffled, and contenders shuffled within each case and trial.
  const byId = new Map(plan.cases.map((c) => [c.id, c]));
  const all: { c: Case; who: ResolvedContender; trial: number; position: number }[] = [];
  for (const f of seededShuffle(plan.frozen, `${plan.seed}:cases`)) {
    const c = byId.get(f.id);
    if (!c) continue;
    for (let t = 1; t <= def.trials; t++) {
      for (const who of seededShuffle(contenders, `${plan.seed}:${f.id}:${t}`)) all.push({ c, who, trial: t, position: all.length });
    }
  }
  const finished = new Set(plan.kept.map(cellKey));
  const jobs = all.filter((j) => !finished.has(cellKey({ caseId: j.c.id, contender: j.who.name, trial: j.trial })));
  const policy = retryPolicy(env, def.retries);
  if (job) {
    await job.setTotal(all.length);
    // The record exists from the first call on, so a crash (SIGKILL, reboot) leaves a run to resume.
    if (!job.resumed) await putRun(await assemble(def, plan, { cells: [...plan.kept], stopReason: "interrupted", spent: plan.spent, calls: 0, total: all.length, contenders, versions, graders, priced: false }, opts), env);
  }

  const cap = def.budgetUsd;
  let spent = plan.spent;
  let reserved = 0;
  let stopReason: BenchRun["stopReason"];
  let done = 0;
  opts.onProgress?.(0, jobs.length, "run");
  const results = await mapPool(jobs, opts.concurrency ?? def.concurrency, async ({ c, who, trial, position }): Promise<Cell | null> => {
    if (opts.signal?.aborted || opts.drain?.aborted) {
      stopReason ??= "interrupted";
      return null;
    }
    if (stopReason) return null;
    // Budget: never start a call whose expected cost could cross the cap.
    const est = plan.estimate.perCall[who.name] ?? 0;
    if (cap !== undefined && spent + reserved + est > cap + 1e-9) {
      stopReason = "budget";
      return null;
    }
    reserved += est;
    const cell: Cell = { caseId: c.id, contender: who.name, trial, position, pass: false, score: 0, latencyMs: 0 };
    let answer: Answer | undefined;
    let infra: InfraKind | undefined;
    try {
      // Only infrastructure errors (rate limit, 5xx, network, exit 75) are retried, with backoff: a crash,
      // a timeout or a wrong answer is the contender's result, and retrying it would bias the comparison.
      const r = await withRetries(
        async () => {
          const t0 = performance.now();
          let a: Answer | undefined;
          let error: string | undefined;
          try {
            a = await who.run(c.input, { runId: plan.runId, caseId: c.id, trial, ...(c.metadata ? { metadata: c.metadata } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
          } catch (e) {
            error = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
          }
          return { answer: a, error, latencyMs: Math.round((performance.now() - t0) * 100) / 100 };
        },
        {
          policy,
          errorOf: (x) => x.error,
          classify: (x) => (x.error !== undefined ? infraKind(x.error) : x.answer?.failure && /^rate-?limit(ed)?$/i.test(x.answer.failure) ? "rate-limit" : undefined),
          stop: [opts.signal, opts.drain],
        },
      );
      answer = r.result.answer;
      if (r.result.error !== undefined) cell.error = r.result.error;
      cell.latencyMs = r.result.latencyMs;
      cell.attempts = r.attempts;
      infra = r.infra;
    } finally {
      reserved -= est;
    }
    // A rate limit that outlasted the retries is a quota exclusion; a 5xx or network error that did is "infra".
    const excluded = exclusionOf(cell.error, answer) ?? (infra && !opts.signal?.aborted ? "infra" : undefined);
    if (excluded) {
      cell.excluded = excluded;
      cell.failure = excluded;
      cell.score = 0;
    } else if (opts.signal?.aborted && cell.error !== undefined) {
      cell.excluded = "aborted";
      cell.failure = "aborted";
    } else {
      let grades: GradeRow[] | undefined;
      let graderFailed = false;
      if (answer) {
        const safe = redactor.value(answer.output);
        cell.outputSha256 = await putBlob(def.name, JSON.stringify(safe) ?? "null", env);
        const out = preview(safe);
        if (out !== undefined) cell.output = out;
        if (answer.sessionId) cell.sessionId = answer.sessionId;
        if (answer.tokens !== undefined) cell.tokens = answer.tokens;
        if (answer.usage) cell.usage = answer.usage;
        if (answer.model) cell.model = answer.model;
        const spec = byName.get(who.name)!;
        // Cost provenance: the contender's own number, else the definition's per-call price, else tokens × the model's list price.
        if (answer.costUsd !== undefined) {
          cell.costUsd = answer.costUsd;
          cell.costSource = "reported";
        } else if (spec.costPerRun !== undefined) {
          cell.costUsd = spec.costPerRun;
          cell.costSource = "configured";
        } else if (answer.usage) {
          const p = lookupPrice(answer.model ?? (spec.kind === "agent" ? spec.model : undefined), prices);
          if (p) {
            cell.costUsd = costFrom(answer.usage, p);
            cell.costSource = "price-table";
            priced = true;
          }
        }
        if (graders.length) ({ grades, failed: graderFailed } = await gradeAll(graders, c, answer.output, await expected(c), opts.signal));
      }
      settle(cell, { ...(answer ? { answer } : {}), ...(grades ? { grades } : {}), graderFailed, graders: graders.length });
    }
    spent += cell.costUsd ?? 0;
    if (cap !== undefined && spent > 0 && spent >= cap - 1e-9 && done + 1 < jobs.length) stopReason ??= "budget";
    // Checkpoint: a call cut off by a hard stop runs again on resume; every other cell is final.
    if (job && cell.excluded !== "aborted") {
      await job.record({ key: cellKey(cell), at: Date.now(), ms: cell.latencyMs, ...(cell.attempts && cell.attempts > 1 ? { attempts: cell.attempts } : {}), ...(cell.costUsd !== undefined ? { costUsd: cell.costUsd } : {}), outcome: cell.excluded ? "error" : cell.pass ? "pass" : "fail", data: cell });
    }
    opts.onProgress?.(++done, jobs.length, "run");
    return cell;
  });
  const fresh = results.filter((x): x is Cell => x !== null);
  if (opts.signal?.aborted || (opts.drain?.aborted && fresh.length < jobs.length)) stopReason = "interrupted";
  const cells = [...plan.kept, ...fresh].sort((a, b) => a.position - b.position);
  return { cells, ...(stopReason ? { stopReason } : {}), spent, calls: fresh.length, total: all.length, contenders, versions, graders, priced: priced || plan.kept.some((x) => x.costSource === "price-table") };
}

/** Fresh-sample numbers and anchor-set numbers, kept apart. Shared by run, resume and regrade. */
function finalizeSplit(
  cells: readonly Cell[],
  frozen: readonly FrozenCase[],
  contenders: readonly { name: string; kind: string; ref: string; experimentId?: string; axes?: GridAxes }[],
  o: { trials: number; dataset: { id: string; name: string; version: string }; graders: string[]; stopReason?: string; anchor?: { version: string; requested: number; frozenBy: string } },
): { fin: ReturnType<typeof finalize>; anchor?: AnchorResult } {
  const anchorCases = frozen.filter((c) => c.anchor);
  const anchorIds = new Set(anchorCases.map((c) => c.id));
  const base = { trials: o.trials, dataset: o.dataset, graders: o.graders, ...(o.stopReason ? { stopReason: o.stopReason } : {}) };
  const fin = finalize(
    anchorIds.size ? cells.filter((x) => !anchorIds.has(x.caseId)) : cells,
    contenders,
    { ...base, cases: frozen.length - anchorCases.length },
  );
  if (!anchorIds.size || !o.anchor) return { fin };
  const a = finalize(
    cells.filter((x) => anchorIds.has(x.caseId)),
    contenders,
    { ...base, cases: anchorCases.length },
  );
  fin.warnings.push(...a.warnings.map((w) => `anchor set: ${w}`));
  return {
    fin,
    anchor: { version: o.anchor.version, requested: o.anchor.requested, cases: anchorCases.length, sha256: casesSha256(anchorCases), frozenBy: o.anchor.frozenBy, summaries: a.summaries, comparisons: a.comparisons, excluded: a.excluded! },
  };
}

/**
 * Grid coordinates of a contender. Agents: harness = agent id (+ " +<harness>"),
 * model = the configured one, else the one its calls reported most often;
 * `axes` in the definition overrides either. Others: `axes` only.
 */
export function axesOf(spec: ContenderSpec, cells: readonly Cell[]): GridAxes | undefined {
  const out: GridAxes = {};
  if (spec.kind === "agent") {
    out.harness = `${spec.agent}${spec.harness ? ` +${spec.harness}` : ""}`;
    let model = spec.model;
    if (!model) {
      const n = new Map<string, number>();
      for (const x of cells) if (x.contender === spec.name && x.model) n.set(x.model, (n.get(x.model) ?? 0) + 1);
      model = [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    }
    if (model) out.model = model;
  }
  if (spec.axes?.model) out.model = spec.axes.model;
  if (spec.axes?.harness) out.harness = spec.axes.harness;
  return out.model || out.harness ? out : undefined;
}

/** The run record from a plan and what ran; creates the experiments when the run is complete. */
async function assemble(def: BenchDef, plan: Plan, ex: Executed, opts: RunBenchOpts): Promise<BenchRun> {
  const { stopReason, cells } = ex;
  const complete = !stopReason;
  const fresh = plan.frozen.filter((c) => !c.anchor).length;

  // One experiment per contender, so `coding.sh exp compare` works on bench runs too.
  const experimentIds = new Map<string, string>();
  if (opts.evalStore && complete) {
    for (const who of ex.contenders) {
      const runs = cellsToRuns(cells.filter((x) => !x.excluded), who.name).map((r) => ({ ...r, startedAt: plan.startedAt }));
      const exp: ExperimentResult = {
        id: sortableId("exp_"),
        name: `bench/${def.name}/${who.name}`,
        dataset: plan.dataset,
        task: { kind: who.kind === "http" ? "http" : "command", ref: who.ref },
        graders: ex.graders.map((g) => ({ id: g.id, version: g.version, kind: g.kind, ...(g.calibration ? { calibration: g.calibration } : {}) })),
        trials: def.trials,
        createdAt: plan.startedAt,
        finishedAt: Date.now(),
        runs,
        summary: summarizeRuns(runs, ex.graders, def.trials),
        metadata: { bench: def.name, benchRun: plan.runId, contender: who.name, date: plan.date, seed: plan.seed },
      };
      await opts.evalStore.putExperiment(exp);
      experimentIds.set(who.name, exp.id);
    }
  }

  const byName = new Map(def.contenders.map((c) => [c.name, c]));
  const records: ContenderRecord[] = ex.contenders.map((who, i) => {
    const spec = byName.get(who.name)!;
    const model = (spec.kind === "agent" ? spec.model : undefined) ?? cells.find((x) => x.contender === who.name && x.model)?.model;
    const v = ex.versions[i];
    const axes = axesOf(spec, cells);
    return {
      name: who.name,
      kind: who.kind,
      ref: who.ref,
      hash: def.contenderHashes[who.name]!,
      ...(model ? { model } : {}),
      ...(v ? { version: v } : {}),
      ...(experimentIds.has(who.name) ? { experimentId: experimentIds.get(who.name)! } : {}),
      ...(axes ? { axes } : {}),
    };
  });
  const { fin, anchor } = finalizeSplit(cells, plan.frozen, records, {
    trials: def.trials,
    dataset: plan.dataset,
    graders: ex.graders.map((g) => g.id),
    ...(stopReason ? { stopReason } : {}),
    ...(plan.anchor ? { anchor: plan.anchor } : {}),
  });
  const cap = def.budgetUsd;
  const s = plan.sampling;
  const warnings: string[] = [];
  if (stopReason === "budget") warnings.push(`stopped at the $${cap} budget after ${cells.length} of ${ex.total} calls: this run is incomplete and stays out of history (bench run ${def.name} --resume continues it)`);
  if (stopReason === "interrupted") warnings.push(`interrupted after ${cells.length} of ${ex.total} calls: this run is incomplete and stays out of history (bench run ${def.name} --resume continues it)`);
  if (fresh < plan.requested) warnings.push(`asked for ${plan.requested} cases, got ${fresh} (source returned ${plan.poolSize}${s.excludedSeen ? `, ${s.excludedSeen} already tested` : ""}${s.contentSeen ? `, ${s.contentSeen} with content already tested` : ""}${s.capped ? `, ${s.capped} over a per-host/org cap` : ""})`);
  if (plan.anchor && anchor && anchor.cases < plan.anchor.requested) warnings.push(`anchor set has ${anchor.cases} of ${plan.anchor.requested} cases (the source had no more when it was picked)`);
  if (plan.redacted) warnings.push(`${plan.redacted} case${plan.redacted === 1 ? "" : "s"} contained secrets and were redacted at freeze`);
  if (plan.snapshots && plan.snapshots.ok < plan.snapshots.fetched) warnings.push(`${plan.snapshots.fetched - plan.snapshots.ok} of ${plan.snapshots.fetched} page snapshots failed (status recorded per case)`);
  warnings.push(...fin.warnings);

  return {
    v: 1,
    id: plan.runId,
    bench: def.name,
    ...(def.description ? { description: def.description } : {}),
    date: plan.date,
    startedAt: plan.startedAt,
    finishedAt: Date.now(),
    mode: plan.mode,
    status: complete ? "complete" : "incomplete",
    ...(stopReason ? { stopReason } : {}),
    codingShVersion: codingShVersion(),
    definition: { file: def.file, hash: def.hash, protocolHash: def.protocolHash },
    visibility: def.visibility,
    policy: { timeoutMs: def.timeoutMs, retries: def.retries },
    ...(cap !== undefined ? { budget: { capUsd: cap, ...(plan.estimate.usd !== undefined ? { estimatedUsd: plan.estimate.usd } : {}), spentUsd: ex.spent } } : {}),
    excluded: fin.excluded!,
    redacted: plan.redacted,
    seed: plan.seed,
    ...(plan.seedCommit ? { seedCommit: plan.seedCommit } : {}),
    ...(plan.resumed?.length ? { resumed: plan.resumed } : {}),
    ...(anchor ? { anchor } : {}),
    ...(ex.priced ? { pricing: { updated: Object.fromEntries(Object.entries(PRICE_SOURCES).map(([k, v]) => [k, v.updated])) } } : {}),
    sampling: plan.sampling,
    ...(plan.snapshots ? { snapshots: plan.snapshots } : {}),
    source: { kind: def.source.kind, ref: sourceRef(def.source) },
    dataset: { id: plan.dataset.id, version: plan.dataset.version, sha256: plan.sha256 },
    cases: plan.frozen,
    contenders: records,
    order: "interleaved-random",
    trials: def.trials,
    graders: ex.graders.map((g) => ({ id: g.id, kind: g.kind, version: g.version })),
    cells,
    summaries: fin.summaries,
    comparisons: fin.comparisons,
    ...(fin.specialization ? { specialization: fin.specialization } : {}),
    ...(fin.grid ? { grid: fin.grid } : {}),
    warnings,
  };
}

/** The seed for a date: the definition's recipe, or a commit-reveal salt from the key env (seed = "secret"). */
function seedFor(def: BenchDef, env: NodeJS.ProcessEnv, date: string, runId: string): { seed: string; commit?: SeedCommit } {
  if (def.seed !== "secret") return { seed: resolveSeed(def.seed, { name: def.name, date, runId }) };
  const envName = def.seedKeyEnv ?? "CODING_SH_BENCH_SEED_KEY";
  const key = env[envName];
  if (!key) throw new BenchRunError(`seed = "secret" needs ${envName} set: a long random string kept out of the repo (a CI secret for scheduled runs). Every run with the same key and date gets the same sample.`);
  return commitFor(key, def.name, date);
}

export async function runBench(opts: RunBenchOpts & { dryRun: true }): Promise<DryRunResult>;
export async function runBench(opts: RunBenchOpts): Promise<BenchRun | DryRunResult>;
export async function runBench(opts: RunBenchOpts): Promise<BenchRun | DryRunResult> {
  const { def, env } = opts;
  const now = opts.now ?? Date.now();
  const runId = sortableId("bench_", now);
  const date = opts.date ?? dateOf(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new BenchRunError(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  const { seed, commit: seedCommit } = opts.seed !== undefined ? { seed: opts.seed, commit: undefined } : seedFor(def, env, date, runId);
  const n = opts.cases ?? def.cases;
  const past = await listRuns(def.name, env);
  const counted = historyRuns(past);
  const adhoc = opts.adhoc || opts.seed !== undefined || opts.cases !== undefined || opts.date !== undefined || counted.some((r) => r.date === date);
  const mode = adhoc ? "adhoc" : "scheduled";

  opts.onProgress?.(0, 0, "sample");
  const pool = await generateCases({
    def,
    seed,
    date,
    runId,
    now,
    env,
    ...(opts.index ? { index: opts.index } : {}),
    ...(opts.evalStore ? { evalStore: opts.evalStore } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const caps = [...(def.maxPerHost ? [{ field: "metadata.host", n: def.maxPerHost }] : []), ...(def.maxPerOrg ? [{ field: "metadata.org", n: def.maxPerOrg }] : [])];
  const shape = { ...(def.dedupeBy ? { dedupeBy: def.dedupeBy } : {}), ...(def.stratify ? { stratify: def.stratify } : {}), ...(caps.length ? { caps } : {}) };

  // Anchor set: the stored one, else picked now from this pool with a seed that only the version changes.
  const stored = storedAnchor(def, past);
  const anchorPick = def.anchor && !stored ? sampleCases(pool, { n: def.anchor.cases, seed: `${def.name}:anchor:${def.anchor.version}`, ...shape }) : undefined;
  const anchorKeys = new Set([...(stored?.cases.map((c) => c.key) ?? []), ...(anchorPick?.cases.map((s) => s.key) ?? [])]);
  const anchorIds = new Set([...(stored?.cases.map((c) => c.id) ?? []), ...(anchorPick?.cases.map((s) => s.case.id) ?? [])]);
  const anchorContent = new Set([...(stored?.cases.map((c) => c.contentSha256).filter((x): x is string => !!x) ?? []), ...(anchorPick?.cases.map((s) => caseContentHash(s.case)) ?? [])]);

  // Freshness: keys and content hashes tested by counted runs. urls content is the page body, known only after the snapshot (below).
  const led = def.fresh ? ledger(past) : undefined;
  const urls = def.source.kind === "urls" && def.source.snapshot !== false;
  const seenContent = new Set([...(led?.content ?? []), ...anchorContent]);
  const freshPool = anchorIds.size ? pool.filter((c) => !anchorIds.has(c.id)) : pool;
  const extraSeen = new Set<string>();
  const pick = () =>
    sampleCases(freshPool, {
      n,
      seed,
      ...shape,
      ...(anchorKeys.size ? { exclude: anchorKeys } : {}),
      ...(led || extraSeen.size ? { seen: new Set([...(led?.keys ?? []), ...extraSeen]) } : {}),
      ...(urls ? {} : { contentOf: caseContentHash, seenContent }),
    });
  let sample = pick();
  // Secrets never reach the frozen set, the run record or a report.
  const cleaned = new Set<Case>();
  let redacted = 0;
  const redactNew = (cs: Case[]) => {
    const todo = cs.filter((c) => !cleaned.has(c));
    for (const c of todo) cleaned.add(c);
    redacted += redactCases(todo);
  };
  redactNew([...sample.cases, ...(anchorPick?.cases ?? [])].map((s) => s.case));
  const anchorFrozen = stored?.cases ?? (anchorPick ? freeze(anchorPick).map((f) => ({ ...f, anchor: true as const })) : []);
  const lastCounted = counted.at(-1);
  const plan = powerPlan(sample.cases.length, def.contenders.length, lastCounted ? discordanceOf(lastCounted.comparisons) : undefined);
  let estimate = estimateCost(def, past, sample.cases.length + anchorFrozen.length);
  if (opts.dryRun) {
    return {
      dryRun: true,
      bench: def.name,
      date,
      seed: maskSeed(seed, seedCommit),
      ...(seedCommit ? { commitment: seedCommit.commitment } : {}),
      mode,
      sampling: sample,
      cases: [...freeze(sample), ...anchorFrozen],
      ...(def.anchor ? { anchor: { version: def.anchor.version, cases: anchorFrozen.length, stored: !!stored } } : {}),
      redacted,
      plan,
      estimate,
      ...(def.budgetUsd !== undefined ? { budgetUsd: def.budgetUsd } : {}),
    };
  }
  if (!sample.cases.length) {
    throw new BenchRunError(
      sample.excludedSeen || sample.contentSeen
        ? `no fresh cases: the source returned ${pool.length}, and all ${sample.excludedSeen + sample.contentSeen} unique ones were tested by earlier runs (set fresh = false to allow repeats)`
        : `the source returned no cases (${sourceRef(def.source)})`,
    );
  }
  if (def.budgetUsd !== undefined && estimate.usd !== undefined && estimate.usd > def.budgetUsd) {
    throw new BenchRunError(`estimated cost $${estimate.usd.toFixed(4)} is over budget_usd $${def.budgetUsd} (${estimate.calls} calls per contender); lower cases or raise the budget`);
  }

  // urls: fetch each sampled page once, now, and pin its body hash into the frozen set.
  // A page whose body was already tested under another URL (or appears twice) is
  // swapped for the next-ranked candidate, up to three rounds.
  let snapshots: BenchRun["snapshots"];
  let contentSeen = sample.contentSeen;
  if (urls) {
    const snapAll = async (cs: Case[]) => {
      const todo = cs.filter((c) => !(c.metadata?.snapshot as PageSnapshot | undefined)?.fetchedAt);
      let done = 0;
      opts.onProgress?.(0, todo.length, "snapshot");
      await mapPool(todo, 4, async (c) => {
        const url = String(c.metadata?.url ?? c.input);
        const snap = await snapshotPage(url, (body) => putBlob(def.name, body, env), { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: Math.min(def.timeoutMs, 30_000) });
        c.metadata = { ...(c.metadata ?? {}), snapshot: snap };
        opts.onProgress?.(++done, todo.length, "snapshot");
      });
    };
    await snapAll([...sample.cases, ...(anchorPick?.cases ?? [])].map((s) => s.case));
    for (const s of anchorPick?.cases ?? []) seenContent.add(caseContentHash(s.case));
    for (let round = 0; ; round++) {
      const inSample = new Set<string>();
      const drop = new Set<string>();
      for (const s of sample.cases) {
        const snap = s.case.metadata?.snapshot as PageSnapshot | undefined;
        if (!snap?.sha256 || snap.status < 200 || snap.status >= 300) continue;
        if (seenContent.has(snap.sha256) || inSample.has(snap.sha256)) drop.add(s.key);
        else inSample.add(snap.sha256);
      }
      if (!drop.size) break;
      contentSeen += drop.size;
      if (round === 3) {
        sample = { ...sample, cases: sample.cases.filter((s) => !drop.has(s.key)) };
        break;
      }
      for (const k of drop) extraSeen.add(k);
      sample = pick();
      redactNew(sample.cases.map((s) => s.case));
      await snapAll(sample.cases.map((s) => s.case));
    }
    const snapped = [...sample.cases, ...(anchorPick?.cases ?? [])].map((s) => s.case.metadata?.snapshot as PageSnapshot | undefined).filter((x): x is PageSnapshot => !!x);
    snapshots = { fetched: snapped.length, ok: snapped.filter((x) => x.status >= 200 && x.status < 300).length };
    if (!sample.cases.length) throw new BenchRunError(`no fresh cases: every sampled page's content was already tested under another URL`);
    estimate = estimateCost(def, past, sample.cases.length + anchorFrozen.length);
  }
  const frozen = [...freeze(sample), ...(anchorPick ? freeze(anchorPick).map((f) => ({ ...f, anchor: true as const })) : anchorFrozen)];

  // Freeze: one dataset version per sample (anchor cases included), content-hashed.
  const ds = createDataset({ name: `bench-${def.name}`, cases: [...sample.cases.map((s) => s.case), ...(anchorPick ? anchorPick.cases.map((s) => s.case) : anchorFrozen.map(toCase))], description: `${def.name} benchmark samples` });
  if (opts.evalStore) await opts.evalStore.putDataset({ id: ds.id, name: ds.name, version: ds.version, cases: ds.cases, ...(ds.description ? { description: ds.description } : {}) }, { note: `bench run ${runId} (${date}, seed ${maskSeed(seed, seedCommit)})`, now });

  const p: Plan = {
    runId,
    date,
    seed,
    ...(seedCommit ? { seedCommit } : {}),
    mode,
    requested: n,
    frozen,
    cases: ds.cases,
    dataset: { id: ds.id, name: ds.name, version: ds.version },
    sha256: casesSha256(ds.cases),
    sampling: {
      requested: n,
      candidates: sample.candidates + (sample.excludedSeen - extraSeen.size) + sample.capped,
      excludedSeen: sample.excludedSeen - extraSeen.size,
      duplicates: sample.duplicates,
      fresh: def.fresh,
      ...(def.stratify ? { stratify: def.stratify } : {}),
      ...(def.dedupeBy ? { dedupeBy: def.dedupeBy } : {}),
      ...(sample.strata ? { strata: sample.strata } : {}),
      ...(caps.length ? { caps, capped: sample.capped } : {}),
      ...(contentSeen ? { contentSeen } : {}),
    },
    ...(snapshots ? { snapshots } : {}),
    redacted,
    poolSize: pool.length,
    ...(def.anchor ? { anchor: { version: def.anchor.version, requested: def.anchor.cases, frozenBy: stored?.frozenBy ?? runId } } : {}),
    estimate,
    startedAt: Date.now(),
    kept: [],
    spent: 0,
    order: def.contenders.map((c) => c.name),
  };
  const job = await JobStore.forEnv(env).create({ id: runId, kind: "bench run", name: def.name, config: benchJobConfig(def), total: 0, concurrency: opts.concurrency ?? def.concurrency });
  const ex = await execute(def, p, opts, job).catch(async (e) => {
    await job.finish("interrupted");
    throw e;
  });
  const run = await assemble(def, p, ex, opts);
  await putRun(run, env);
  await job.finish(ex.stopReason === "interrupted" ? "interrupted" : ex.stopReason ? "incomplete" : "completed");
  if (ex.stopReason === "interrupted") throw new BenchRunError(`interrupted; the partial run is saved as ${runId} and kept out of history`, { resume: resumeCommand(def.name, runId) });
  return run;
}

// ---------------------------------------------------------------- resume

/** The run `bench run --resume` continues: the given id or date, else the newest incomplete run. */
export function resumeTarget(runs: readonly BenchRun[], ref?: string): BenchRun | undefined {
  const open = runs.filter((r) => r.status === "incomplete" && !r.regradeOf);
  if (!ref) return [...open].sort((a, b) => a.startedAt - b.startedAt).at(-1);
  return runs.find((r) => r.id === ref) ?? [...open].filter((r) => r.date === ref).sort((a, b) => a.startedAt - b.startedAt).at(-1);
}

/**
 * Continue an incomplete run (budget stop or interrupt) from its record: the
 * same seed, the same frozen cases and the same job order. Finished cells are
 * kept; calls that never ran or were cut off by the interrupt run now. The
 * record keeps its id and is overwritten. Needs the same protocol and the same
 * contender definitions; budget_usd may be raised to let it finish.
 */
export async function resumeBench(opts: Omit<RunBenchOpts, "dryRun" | "seed" | "cases" | "date" | "adhoc"> & { run?: string }): Promise<BenchRun> {
  const { def, env } = opts;
  const past = await listRuns(def.name, env);
  const target = resumeTarget(past, opts.run);
  if (!target) throw new BenchRunError(opts.run ? `no run ${JSON.stringify(opts.run)} of ${def.name}` : `${def.name} has no incomplete run to resume`);
  if (target.regradeOf) throw new BenchRunError(`run ${target.id} is a regrade; resume the run it came from (${target.regradeOf})`);
  if (target.status !== "incomplete") throw new BenchRunError(`run ${target.id} is complete; nothing to resume`);
  if (target.definition.protocolHash && target.definition.protocolHash !== def.protocolHash) {
    throw new BenchRunError(`the definition's protocol changed since run ${target.id} (source, sampling, graders, trials, timeout or seed), so its cells aren't comparable; start a new run instead`);
  }
  const want = def.contenders.map((c) => c.name).sort();
  const had = target.contenders.map((c) => c.name).sort();
  if (want.join("\u0000") !== had.join("\u0000")) throw new BenchRunError(`contenders changed since run ${target.id} (was ${had.join(", ")}, now ${want.join(", ")}); start a new run instead`);
  for (const c of target.contenders) {
    if (c.hash && c.hash !== def.contenderHashes[c.name]) throw new BenchRunError(`contender ${c.name} changed since run ${target.id}; start a new run instead`);
  }
  const now = opts.now ?? Date.now();
  // Cells checkpointed after the record was last written (a crash, a SIGKILL) count too.
  const store = JobStore.forEnv(env);
  const prior = await store.get(target.id);
  const byKey = new Map(target.cells.filter((x) => x.excluded !== "aborted").map((x) => [cellKey(x), x]));
  for (const l of prior?.lines.values() ?? []) {
    const c = l.data as Cell | undefined;
    if (c && typeof c.caseId === "string" && c.excluded !== "aborted" && !byKey.has(cellKey(c))) byKey.set(cellKey(c), c);
  }
  const kept = [...byKey.values()];
  if (prior?.status === "running") throw new BenchRunError(`run ${target.id} is still running (pid ${prior.header.sessions.at(-1)?.pid ?? "?"} on ${prior.header.sessions.at(-1)?.host ?? "?"}); stop it first`);
  const spent = target.budget?.spentUsd ?? kept.reduce((s, x) => s + (x.costUsd ?? 0), 0);
  if (def.budgetUsd !== undefined && spent >= def.budgetUsd - 1e-9) throw new BenchRunError(`run ${target.id} already spent $${spent.toFixed(4)} of budget_usd $${def.budgetUsd}; raise budget_usd to let it finish`);
  const others = past.filter((r) => r.id !== target.id);
  // A run that finishes after another counted run took its date can't count too.
  const mode = (target.mode ?? "scheduled") === "scheduled" && !historyRuns(others).some((r) => r.date === target.date) ? "scheduled" : "adhoc";
  const s = target.sampling;
  const p: Plan = {
    runId: target.id,
    date: target.date,
    seed: target.seed,
    ...(target.seedCommit ? { seedCommit: target.seedCommit } : {}),
    mode,
    requested: s.requested,
    frozen: target.cases,
    cases: target.cases.map(toCase),
    dataset: { id: target.dataset.id, name: `bench-${def.name}`, version: target.dataset.version },
    sha256: target.dataset.sha256,
    sampling: s,
    ...(target.snapshots ? { snapshots: target.snapshots } : {}),
    redacted: target.redacted ?? 0,
    poolSize: s.candidates + s.duplicates,
    ...(target.anchor ? { anchor: { version: target.anchor.version, requested: target.anchor.requested, frozenBy: target.anchor.frozenBy } } : {}),
    estimate: estimateCost(def, others, target.cases.length),
    startedAt: target.startedAt,
    kept,
    spent,
    resumed: [...(target.resumed ?? [])],
    order: target.contenders.map((c) => c.name),
    versions: Object.fromEntries(target.contenders.map((c) => [c.name, c.version])),
  };
  const job = prior ? await store.resume(target.id, { ...(opts.concurrency ? { concurrency: opts.concurrency } : {}) }) : await store.create({ id: target.id, kind: "bench run", name: def.name, config: benchJobConfig(def), total: 0, concurrency: opts.concurrency ?? def.concurrency });
  const ex = await execute(def, p, opts, job).catch(async (e) => {
    await job.finish("interrupted");
    throw e;
  });
  await job.finish(ex.stopReason === "interrupted" ? "interrupted" : ex.stopReason ? "incomplete" : "completed");
  p.resumed!.push({ at: now, calls: ex.calls });
  const run = await assemble(def, p, ex, opts);
  if (target.mode === "scheduled" && mode === "adhoc") run.warnings.unshift(`another run now counts for ${target.date}, so this resumed run is adhoc`);
  await putRun(run, env);
  if (ex.stopReason === "interrupted") throw new BenchRunError(`interrupted again; run ${target.id} is saved and can be resumed`, { resume: resumeCommand(def.name, target.id) });
  return run;
}

// ---------------------------------------------------------------- regrade

export interface RegradeOpts {
  def: BenchDef;
  env: NodeJS.ProcessEnv;
  graderDeps?: GraderDeps;
  signal?: AbortSignal;
  concurrency?: number;
  now?: number;
}

/**
 * Re-score a run's stored outputs with the definition's current graders and
 * store the result as a new record (regradeOf = the original). Contenders
 * are not called again: latency, cost and errors carry over unchanged.
 * History uses the newest regrade of each counted run.
 */
export async function regradeRun(orig: BenchRun, o: RegradeOpts): Promise<BenchRun> {
  const { def, env } = o;
  if (orig.bench !== def.name) throw new BenchRunError(`run ${orig.id} belongs to ${orig.bench}, not ${def.name}`);
  const missing = orig.cells.filter((x) => x.error === undefined && !x.excluded && !x.outputSha256).length;
  if (missing) throw new BenchRunError(`run ${orig.id} has ${missing} answers without stored outputs (recorded before coding.sh kept full outputs), so it can't be regraded`);
  const graders = await loadGraders(def, env, o.graderDeps);
  const expected = expectedFor(def, env);
  const byId = new Map(orig.cases.map((c) => [c.id, { id: c.id, input: c.input, ...(c.expected !== undefined ? { expected: c.expected } : {}), ...(c.metadata ? { metadata: c.metadata } : {}) } as Case]));
  const cells = await mapPool(orig.cells, o.concurrency ?? def.concurrency, async (old): Promise<Cell> => {
    const cell: Cell = structuredClone(old);
    // Calls that never produced an answer (errors, quota, budget) have nothing to re-score.
    if (cell.error !== undefined || (cell.excluded && cell.excluded !== "grader-error")) return cell;
    delete cell.excluded;
    delete cell.grades;
    const blob = cell.outputSha256 ? await getBlob(def.name, cell.outputSha256, env) : undefined;
    if (!blob) throw new BenchRunError(`run ${orig.id}: stored output ${cell.outputSha256} is missing from ${def.name}/blobs`);
    const output = JSON.parse(blob.toString("utf8")) as unknown;
    const reported = old.failure && !STANDARD_FAILURES.has(old.failure) && old.failure !== "aborted" ? old.failure : undefined;
    const answer = { output, ...(reported ? { failure: reported } : {}) };
    const c = byId.get(cell.caseId)!;
    let grades: GradeRow[] | undefined;
    let graderFailed = false;
    if (graders.length) ({ grades, failed: graderFailed } = await gradeAll(graders, c, output, await expected(c), o.signal));
    settle(cell, { answer, ...(grades ? { grades } : {}), graderFailed, graders: graders.length });
    return cell;
  });
  const now = o.now ?? Date.now();
  const datasetRef = { id: orig.dataset.id, name: orig.dataset.id, version: orig.dataset.version };
  const contenders = orig.contenders.map(({ experimentId: _e, ...c }) => c);
  const { fin, anchor } = finalizeSplit(cells, orig.cases, contenders, {
    trials: orig.trials,
    dataset: datasetRef,
    graders: graders.map((g) => g.id),
    ...(orig.stopReason ? { stopReason: orig.stopReason } : {}),
    ...(orig.anchor ? { anchor: { version: orig.anchor.version, requested: orig.anchor.requested, frozenBy: orig.anchor.frozenBy } } : {}),
  });
  const integrity = await verifyFrozen(orig, env);
  const { experimentId: _x, specialization: _s, grid: _g, ...rest } = orig as BenchRun & { experimentId?: string };
  const run: BenchRun = {
    ...rest,
    id: sortableId("bench_", now),
    startedAt: now,
    finishedAt: Date.now(),
    regradeOf: orig.id,
    codingShVersion: codingShVersion(),
    definition: { file: def.file, hash: def.hash, protocolHash: def.protocolHash },
    contenders,
    graders: graders.map((g) => ({ id: g.id, kind: g.kind, version: g.version })),
    cells,
    summaries: fin.summaries,
    comparisons: fin.comparisons,
    ...(fin.specialization ? { specialization: fin.specialization } : {}),
    ...(fin.grid ? { grid: fin.grid } : {}),
    excluded: fin.excluded!,
    ...(anchor ? { anchor } : {}),
    warnings: [`regraded from ${orig.id} with the current graders`, ...integrity, ...fin.warnings],
  };
  await putRun(run, env);
  return run;
}

/**
 * Check a stored run's frozen inputs before re-scoring them: the case list
 * still hashes to the recorded dataset sha256, each case still hashes to its
 * recorded content hash, and each page snapshot blob still has the body hash
 * the record pinned. Returns one warning per kind of mismatch.
 */
export async function verifyFrozen(run: BenchRun, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const out: string[] = [];
  if (casesSha256(run.cases) !== run.dataset.sha256) out.push(`the frozen cases of ${run.id} no longer hash to the recorded dataset sha256 (${run.dataset.sha256.slice(0, 12)}…): the record was edited`);
  const changed = run.cases.filter((c) => c.contentSha256 && caseContentHash(c) !== c.contentSha256).map((c) => c.id);
  if (changed.length) out.push(`${changed.length} case${changed.length === 1 ? "" : "s"} no longer match the content hash recorded at freeze (${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""})`);
  const missing: string[] = [];
  const altered: string[] = [];
  for (const c of run.cases) {
    const snap = c.metadata?.snapshot as PageSnapshot | undefined;
    if (!snap?.sha256) continue;
    const body = await getBlob(run.bench, snap.sha256, env);
    if (!body) missing.push(c.id);
    else if (createHash("sha256").update(body).digest("hex") !== snap.sha256) altered.push(c.id);
  }
  if (altered.length) out.push(`${altered.length} page snapshot${altered.length === 1 ? "" : "s"} changed on disk since freeze (${altered.slice(0, 3).join(", ")}${altered.length > 3 ? ", …" : ""}): graders compare against altered pages`);
  if (missing.length) out.push(`${missing.length} page snapshot${missing.length === 1 ? " is" : "s are"} missing from ${run.bench}/blobs: graders get no expected page for ${missing.length === 1 ? "it" : "them"}`);
  return out;
}
