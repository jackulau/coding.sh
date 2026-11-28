// Workflow benefit and overhead validation (`coding.sh impact`).
// Summarizes local store overhead, surfaced session issues, eval artifacts,
// and honest 14-day before/after comparisons for applied refinements.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoGroup } from "../query/where.ts";
import { liveApplies, tests, type ApplyEntry, type LedgerEntry } from "../refine/ledger.ts";
import type { Session } from "../schema/index.ts";
import { isoMs } from "./dates.ts";
import { isFailureFlag } from "./failure-flags.ts";

/** Minimum organic sessions required on each side of an applied refinement before scoring a delta. */
export const MIN_REFINEMENT_SESSIONS = 5;
/** Default before/after comparison window around an applied refinement (14 days). */
export const DEFAULT_REFINEMENT_WINDOW_MS = 14 * 86_400_000;
/** Default cap on applied refinements included in the report, newest first. */
export const MAX_REFINEMENTS_SHOWN = 5;
/** Threshold for counting a session's unverified edit streak as long. */
export const LONG_UNVERIFIED_STREAK = 5;

const RATE_THRESHOLD_PP = 5;
const UNVERIFIED_THRESHOLD = 0.05;
const COST_REL_THRESHOLD = 0.15;

export interface StoreOverheadPaths {
  index: string;
  blobs: string;
  spool: string;
  spoolErrors?: string;
}

export interface StoreOverhead {
  indexBytes: number;
  blobsBytes: number;
  spoolBytes: number;
  totalBytes: number;
  spoolErrors: number;
}

export interface ImpactWindow {
  since: string;
  until: string;
  sessions: number;
  organicSessions: number;
  agents: string[];
  repos: number;
}

export interface ImpactCatches {
  tamperFlags: number;
  highRiskSessions: number;
  mediumRiskSessions: number;
  proofSessions: number;
  proofOscillatingSessions: number;
  proofWithEscapes: number;
  unverifiedLongStreaks: number;
  flaggedSessions: number;
  failureRate: number | null;
  totalCostUsd?: number;
  wastedSpendUsd?: number;
}

export interface ImpactArtifacts {
  datasets: number;
  experiments: number;
  appliedRefinements: number;
}

export interface ImpactSlice {
  sessions: number;
  flaggedSessions: number;
  failureRate: number | null;
  pushbackTurns: number;
  repliedTurns: number;
  pushbackRate: number | null;
  unverifiedLongStreaks: number;
  unverifiedEditRate: number | null;
  medianCostUsd: number | null;
  toolErrorRate: number | null;
}

export interface RefinementImpactDelta {
  failureRatePp: number | null;
  pushbackRatePp: number | null;
  unverifiedEditRate: number | null;
  medianCostUsd: number | null;
  toolErrorRatePp: number | null;
}

export type RefinementStatus = "improved" | "regressed" | "mixed" | "insufficient-data";

export interface RefinementImpact {
  id: string;
  candidate: string;
  appliedAt: string;
  target: string;
  before: ImpactSlice;
  after: ImpactSlice;
  delta?: RefinementImpactDelta;
  status: RefinementStatus;
}

export interface ImpactReport {
  window: ImpactWindow;
  catches: ImpactCatches;
  artifacts: ImpactArtifacts;
  refinements: RefinementImpact[];
  overhead: StoreOverhead;
}

export interface ComputeImpactOptions {
  since: number;
  until: number;
  sessions: readonly Session[];
  /** Optional wider session pool for refinement before/after windows (defaults to `sessions`). */
  comparisonSessions?: readonly Session[];
  ledgerEntries?: readonly LedgerEntry[];
  datasets?: number;
  experiments?: number;
  overhead: StoreOverhead;
  /** Window duration on each side of `appliedAt` in ms (default 14 days). */
  refinementWindowMs?: number;
  /** Minimum organic sessions on each side before reporting a delta and verdict (default 5). */
  minRefinementSessions?: number;
  /** Maximum applied refinements to include, most recent first (default 5). */
  maxRefinements?: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function fileSize(path: string): number {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function dirSize(dir: string): number {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(abs);
    else if (entry.isFile()) total += fileSize(abs);
  }
  return total;
}

function countNonEmptyLines(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length > 0) count++;
  }
  return count;
}

/**
 * Safely measures local store disk usage (`index.db` + WAL/SHM, `blobs/`, `spool/`)
 * and counts recorded hook errors in `spool/errors.log`. Missing paths yield zeros.
 */
export function measureStoreOverhead(storePaths: StoreOverheadPaths): StoreOverhead {
  const indexBytes = fileSize(storePaths.index) + fileSize(`${storePaths.index}-wal`) + fileSize(`${storePaths.index}-shm`);
  const blobsBytes = dirSize(storePaths.blobs);
  const spoolBytes = dirSize(storePaths.spool);
  const errorsPath = storePaths.spoolErrors ?? join(storePaths.spool, "errors.log");
  const spoolErrors = countNonEmptyLines(errorsPath);
  return {
    indexBytes,
    blobsBytes,
    spoolBytes,
    totalBytes: indexBytes + blobsBytes + spoolBytes,
    spoolErrors,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return round4(sorted[mid]!);
  return round4((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function repoKey(s: Session): string | undefined {
  const g = repoGroup(s);
  if (g.path) return `path:${g.path.replace(/\\/g, "/").toLowerCase()}`;
  if (g.name) return `name:${g.name.toLowerCase()}`;
  if (s.cwd) return `cwd:${s.cwd.replace(/\\/g, "/").toLowerCase()}`;
  return undefined;
}

function finiteCost(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function computeSlice(sessions: readonly Session[]): ImpactSlice {
  let flaggedSessions = 0;
  let repliedTurns = 0;
  let pushbackTurns = 0;
  let unverifiedLongStreaks = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const costs: number[] = [];

  for (const s of sessions) {
    if (s.flags.some(isFailureFlag)) flaggedSessions++;
    if ((s.stats.verification?.maxUnverifiedEdits ?? 0) >= LONG_UNVERIFIED_STREAK) unverifiedLongStreaks++;
    toolCalls += s.stats.toolCalls;
    toolErrors += s.stats.toolErrors;

    const cost = finiteCost(s.stats.usage?.costUsd);
    if (cost !== undefined) costs.push(cost);

    if (s.stats.turnsByModel) {
      for (const tally of Object.values(s.stats.turnsByModel)) {
        repliedTurns += tally.replied ?? 0;
        if (tally.pushback) {
          for (const count of Object.values(tally.pushback)) {
            if (typeof count === "number" && Number.isFinite(count)) pushbackTurns += count;
          }
        }
      }
    }
  }

  const n = sessions.length;
  return {
    sessions: n,
    flaggedSessions,
    failureRate: n > 0 ? round4(flaggedSessions / n) : null,
    pushbackTurns,
    repliedTurns,
    pushbackRate: repliedTurns > 0 ? round4(pushbackTurns / repliedTurns) : null,
    unverifiedLongStreaks,
    unverifiedEditRate: n > 0 ? round4(unverifiedLongStreaks / n) : null,
    medianCostUsd: median(costs),
    toolErrorRate: toolCalls > 0 ? round4(toolErrors / toolCalls) : null,
  };
}

function classifyRefinement(before: ImpactSlice, after: ImpactSlice, delta: RefinementImpactDelta): Exclude<RefinementStatus, "insufficient-data"> {
  let better = 0;
  let worse = 0;

  if (delta.failureRatePp !== null) {
    if (delta.failureRatePp <= -RATE_THRESHOLD_PP) better++;
    else if (delta.failureRatePp >= RATE_THRESHOLD_PP) worse++;
  }
  if (delta.unverifiedEditRate !== null) {
    if (delta.unverifiedEditRate <= -UNVERIFIED_THRESHOLD) better++;
    else if (delta.unverifiedEditRate >= UNVERIFIED_THRESHOLD) worse++;
  }
  if (delta.pushbackRatePp !== null) {
    if (delta.pushbackRatePp <= -RATE_THRESHOLD_PP) better++;
    else if (delta.pushbackRatePp >= RATE_THRESHOLD_PP) worse++;
  }
  if (delta.toolErrorRatePp !== null) {
    if (delta.toolErrorRatePp <= -RATE_THRESHOLD_PP) better++;
    else if (delta.toolErrorRatePp >= RATE_THRESHOLD_PP) worse++;
  }
  if (delta.medianCostUsd !== null && before.medianCostUsd !== null && before.medianCostUsd > 0) {
    const rel = delta.medianCostUsd / before.medianCostUsd;
    if (rel <= -COST_REL_THRESHOLD) better++;
    else if (rel >= COST_REL_THRESHOLD) worse++;
  }

  if (better > 0 && worse === 0) return "improved";
  if (worse > 0 && better === 0) return "regressed";
  return "mixed";
}

function targetLabel(apply: ApplyEntry, candidateLabels: ReadonlyMap<string, string>): string {
  const paths = apply.files.map((f) => f.path).filter((p) => p.length > 0);
  if (paths.length === 1) return paths[0]!;
  if (paths.length === 2) return `${paths[0]}, ${paths[1]}`;
  if (paths.length > 2) return `${paths[0]} (+${paths.length - 1} more)`;
  return candidateLabels.get(apply.candidate) ?? apply.candidate;
}

/**
 * Pure workflow impact report over captured sessions, refine ledger entries,
 * eval artifact counts, and local store overhead measurements.
 */
export function computeImpact(opts: ComputeImpactOptions): ImpactReport {
  const sessions = opts.sessions;
  const agents = new Set<string>();
  const repos = new Set<string>();

  let organicSessions = 0;
  let tamperFlags = 0;
  let highRiskSessions = 0;
  let mediumRiskSessions = 0;
  let proofSessions = 0;
  let proofOscillatingSessions = 0;
  let proofWithEscapes = 0;
  let unverifiedLongStreaks = 0;
  let flaggedSessions = 0;

  let totalCostUsd = 0;
  let wastedSpendUsd = 0;
  let hasPricedSession = false;
  let hasCacheWaste = false;

  for (const s of sessions) {
    agents.add(s.agent);
    const rk = repoKey(s);
    if (rk !== undefined) repos.add(rk);
    if (!s.runId) organicSessions++;

    const hasFailure = s.flags.some(isFailureFlag);
    if (hasFailure) flaggedSessions++;
    if (s.flags.includes("test-tamper")) tamperFlags++;

    const risk = s.stats.contextHygiene?.supervisionRisk;
    if (risk === "high") highRiskSessions++;
    else if (risk === "medium") mediumRiskSessions++;

    const ver = s.stats.verification;
    if (ver) {
      if (ver.maxUnverifiedEdits >= LONG_UNVERIFIED_STREAK) unverifiedLongStreaks++;
      if (ver.proof) {
        proofSessions++;
        if ((ver.proof.oscillatingChecks ?? 0) > 0) proofOscillatingSessions++;
        if ((ver.proof.escapeRemaining ?? 0) > 0) proofWithEscapes++;
      }
    }

    const cost = finiteCost(s.stats.usage?.costUsd);
    const cacheExtra = finiteCost(s.stats.cacheBreaks?.extraUsd);
    if (cost !== undefined) {
      hasPricedSession = true;
      totalCostUsd += cost;
    }
    if (hasFailure && cost !== undefined) {
      wastedSpendUsd += cost;
    } else if (cacheExtra !== undefined && cacheExtra > 0) {
      hasCacheWaste = true;
      wastedSpendUsd += cost !== undefined ? Math.min(cacheExtra, cost) : cacheExtra;
    }
  }

  const catches: ImpactCatches = {
    tamperFlags,
    highRiskSessions,
    mediumRiskSessions,
    proofSessions,
    proofOscillatingSessions,
    proofWithEscapes,
    unverifiedLongStreaks,
    flaggedSessions,
    failureRate: sessions.length > 0 ? round4(flaggedSessions / sessions.length) : null,
  };
  if (hasPricedSession) {
    catches.totalCostUsd = round4(totalCostUsd);
    catches.wastedSpendUsd = round4(wastedSpendUsd);
  } else if (hasCacheWaste) {
    catches.wastedSpendUsd = round4(wastedSpendUsd);
  }

  const ledger = opts.ledgerEntries ?? [];
  const applied = liveApplies(ledger);
  const candidateLabels = new Map<string, string>();
  for (const t of tests(ledger)) candidateLabels.set(t.id, t.candidate.label);

  const windowMs = opts.refinementWindowMs ?? DEFAULT_REFINEMENT_WINDOW_MS;
  const minSessions = opts.minRefinementSessions ?? MIN_REFINEMENT_SESSIONS;
  const maxRefinements = opts.maxRefinements ?? MAX_REFINEMENTS_SHOWN;

  const organicPool = (opts.comparisonSessions ?? sessions).filter((s) => !s.runId && !s.parent?.sessionId);
  const recentApplies = applied
    .map((entry) => ({ entry, atMs: Date.parse(entry.at) }))
    .filter((item) => Number.isFinite(item.atMs))
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, maxRefinements);

  const refinements: RefinementImpact[] = recentApplies.map(({ entry, atMs }) => {
    const beforePool = organicPool.filter((s) => s.startedAt >= atMs - windowMs && s.startedAt < atMs);
    const afterPool = organicPool.filter((s) => s.startedAt >= atMs && s.startedAt < atMs + windowMs && s.startedAt <= opts.until);
    const before = computeSlice(beforePool);
    const after = computeSlice(afterPool);

    const item: RefinementImpact = {
      id: entry.id,
      candidate: entry.candidate,
      appliedAt: entry.at,
      target: targetLabel(entry, candidateLabels),
      before,
      after,
      status: "insufficient-data",
    };

    if (before.sessions >= minSessions && after.sessions >= minSessions) {
      const delta: RefinementImpactDelta = {
        failureRatePp: before.failureRate !== null && after.failureRate !== null ? round2((after.failureRate - before.failureRate) * 100) : null,
        pushbackRatePp: before.pushbackRate !== null && after.pushbackRate !== null ? round2((after.pushbackRate - before.pushbackRate) * 100) : null,
        unverifiedEditRate: before.unverifiedEditRate !== null && after.unverifiedEditRate !== null ? round4(after.unverifiedEditRate - before.unverifiedEditRate) : null,
        medianCostUsd: before.medianCostUsd !== null && after.medianCostUsd !== null ? round4(after.medianCostUsd - before.medianCostUsd) : null,
        toolErrorRatePp: before.toolErrorRate !== null && after.toolErrorRate !== null ? round2((after.toolErrorRate - before.toolErrorRate) * 100) : null,
      };
      item.delta = delta;
      item.status = classifyRefinement(before, after, delta);
    }

    return item;
  });

  return {
    window: {
      since: isoMs(opts.since) ?? new Date(opts.since).toISOString(),
      until: isoMs(opts.until) ?? new Date(opts.until).toISOString(),
      sessions: sessions.length,
      organicSessions,
      agents: [...agents].sort(),
      repos: repos.size,
    },
    catches,
    artifacts: {
      datasets: opts.datasets ?? 0,
      experiments: opts.experiments ?? 0,
      appliedRefinements: applied.length,
    },
    refinements,
    overhead: opts.overhead,
  };
}
