// Magpie-style dataset curation: batch session mining with quality and near-duplicate
// filtering, deterministic complexity metadata, dataset statistics, and child dataset filtering.
import { isFailureFlag } from "../core/failure-flags.ts";
import { jaccardSets, shingles } from "../refine/mine.ts";
import type { AgentEvent, Session } from "../schema/index.ts";
import { caseContentHash, caseFromSession, DatasetError, type CaseFromSessionOpts } from "./dataset.ts";
import { canonicalJson } from "./hash.ts";
import { CASE_KINDS, SPLITS, type Case, type CaseKind, type Dataset, type Split } from "./types.ts";

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const DEFAULT_NEAR_THRESHOLD = 0.8;
export const DEFAULT_SHINGLE_SIZE = 5;

export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === "string" && (DIFFICULTIES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------- complexity

export interface SessionComplexity {
  difficulty: Difficulty;
  turns: number;
  toolCalls: number;
  filesChanged: number;
}

/** Deterministic complexity level and core activity counts derived from session stats. */
export function sessionComplexity(stats: Pick<Session["stats"], "turns" | "toolCalls" | "filesChanged">): SessionComplexity {
  const turns = stats.turns ?? 0;
  const toolCalls = stats.toolCalls ?? 0;
  const filesChanged = stats.filesChanged ?? 0;
  let difficulty: Difficulty = "easy";
  if (turns >= 6 || toolCalls >= 15 || filesChanged >= 5) difficulty = "hard";
  else if (turns >= 3 || toolCalls >= 5 || filesChanged >= 2) difficulty = "medium";
  return { difficulty, turns, toolCalls, filesChanged };
}

/** Reads a case's difficulty from metadata.difficulty or a difficulty:<level> tag. */
export function caseDifficulty(c: Pick<Case, "metadata" | "tags">): Difficulty | undefined {
  const meta = c.metadata?.difficulty;
  if (isDifficulty(meta)) return meta;
  for (const tag of c.tags ?? []) {
    if (tag.startsWith("difficulty:")) {
      const level = tag.slice("difficulty:".length);
      if (isDifficulty(level)) return level;
    }
  }
  return undefined;
}

/** Harvests a case from a session and attaches deterministic complexity metadata and tag. */
export function minedCaseFromSession(session: Session, events: readonly AgentEvent[], opts: CaseFromSessionOpts = {}): Case {
  const base = caseFromSession(session, events, opts);
  const cx = sessionComplexity(session.stats);
  const metadata: Record<string, unknown> = {
    ...(base.metadata ?? {}),
    difficulty: cx.difficulty,
    turns: cx.turns,
    toolCalls: cx.toolCalls,
    filesChanged: cx.filesChanged,
  };
  const tags = [...new Set([...(base.tags ?? []), `difficulty:${cx.difficulty}`])];
  return { ...base, metadata, tags };
}

// ---------------------------------------------------------------- text & similarity

/** Case input rendered as deterministic text for length checks and near-duplicate matching. */
export function caseInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === null || input === undefined) return "";
  return canonicalJson(input);
}

/** Normalized text used by character-shingle near-duplicate comparison. */
export function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Character length of a case's input text. */
export function caseInputLength(c: Pick<Case, "input">): number {
  return caseInputText(c.input).length;
}

/** Validates a Jaccard similarity threshold in (0, 1]. */
export function validateThreshold(threshold: number, label = "threshold"): number {
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new DatasetError(`${label} must be above 0 and at most 1, got ${threshold}`);
  }
  return threshold;
}

/** 5-character shingle Jaccard similarity between two normalized texts. */
export function inputSimilarity(a: string, b: string, shingleSize = DEFAULT_SHINGLE_SIZE): number {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return jaccardSets(shingles(na, shingleSize), shingles(nb, shingleSize));
}

function roundSim(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ---------------------------------------------------------------- near-dedup

export interface NearDedupeDrop {
  dropped: string;
  kept: string;
  similarity: number;
  kind: "exact" | "near";
}

export interface NearDedupeReport {
  cases: Case[];
  duplicates: NearDedupeDrop[];
  exactDropped: number;
  nearDropped: number;
}

export interface NearDedupeOpts {
  /** Cases already in the destination dataset; participate in matching without being returned in `cases`. */
  existing?: readonly Case[];
  /** Character shingle width (default 5). */
  shingleSize?: number;
}

interface KeptEntry {
  case: Case;
  mutable: boolean;
  norm: string;
  sh: Set<string>;
}

class CaseDeduper {
  private readonly threshold: number | undefined;
  private readonly shingleSize: number;
  private readonly byHash = new Map<string, KeptEntry>();
  private readonly byNorm = new Map<string, KeptEntry>();
  private readonly kept: KeptEntry[] = [];

  constructor(threshold: number | undefined, shingleSize: number, existing: readonly Case[] = []) {
    if (threshold !== undefined) validateThreshold(threshold, "near-duplicate threshold");
    this.threshold = threshold;
    this.shingleSize = shingleSize;
    for (const c of existing) this.register(c, false);
  }

  private register(c: Case, mutable: boolean): KeptEntry {
    const hash = caseContentHash(c);
    const norm = this.threshold !== undefined ? normalizeForSimilarity(caseInputText(c.input)) : "";
    const sh = this.threshold !== undefined ? shingles(norm, this.shingleSize) : new Set<string>();
    const entry: KeptEntry = { case: c, mutable, norm, sh };
    if (!this.byHash.has(hash)) this.byHash.set(hash, entry);
    if (this.threshold !== undefined && !this.byNorm.has(norm)) this.byNorm.set(norm, entry);
    this.kept.push(entry);
    return entry;
  }

  /** Checks a candidate against kept cases; records and returns `undefined` when kept, else the drop record. */
  consider(c: Case): NearDedupeDrop | undefined {
    const hash = caseContentHash(c);
    const exact = this.byHash.get(hash);
    if (exact) {
      if (exact.mutable && c.tags?.length) {
        exact.case.tags = [...new Set([...(exact.case.tags ?? []), ...c.tags])];
      }
      if (exact.mutable && c.kind && !exact.case.kind) {
        exact.case.kind = c.kind;
      }
      return { dropped: c.id, kept: exact.case.id, similarity: 1, kind: "exact" };
    }
    if (this.threshold !== undefined) {
      const norm = normalizeForSimilarity(caseInputText(c.input));
      const sameNorm = this.byNorm.get(norm);
      if (sameNorm) {
        return { dropped: c.id, kept: sameNorm.case.id, similarity: 1, kind: "near" };
      }
      const sh = shingles(norm, this.shingleSize);
      for (const prev of this.kept) {
        const minSize = Math.min(sh.size, prev.sh.size);
        const maxSize = Math.max(sh.size, prev.sh.size);
        if (maxSize === 0) {
          return { dropped: c.id, kept: prev.case.id, similarity: 1, kind: "near" };
        }
        if (minSize / maxSize < this.threshold) continue;
        const sim = jaccardSets(sh, prev.sh);
        if (sim >= this.threshold) {
          return { dropped: c.id, kept: prev.case.id, similarity: roundSim(sim), kind: "near" };
        }
      }
      const copy: Case = { ...c };
      if (c.tags) copy.tags = [...c.tags];
      const entry: KeptEntry = { case: copy, mutable: true, norm, sh };
      this.byHash.set(hash, entry);
      if (!this.byNorm.has(norm)) this.byNorm.set(norm, entry);
      this.kept.push(entry);
      return undefined;
    }
    const copy: Case = { ...c };
    if (c.tags) copy.tags = [...c.tags];
    this.register(copy, true);
    return undefined;
  }

  keptCases(): Case[] {
    return this.kept.filter((e) => e.mutable).map((e) => e.case);
  }
}

/** Drops exact duplicates and near-duplicate inputs at or above `threshold` (5-shingle Jaccard). */
export function dedupeNearCases(cases: readonly Case[], threshold: number, opts: NearDedupeOpts = {}): NearDedupeReport {
  validateThreshold(threshold, "near-duplicate threshold");
  const deduper = new CaseDeduper(threshold, opts.shingleSize ?? DEFAULT_SHINGLE_SIZE, opts.existing);
  const duplicates: NearDedupeDrop[] = [];
  let exactDropped = 0;
  let nearDropped = 0;
  for (const c of cases) {
    const drop = deduper.consider(c);
    if (drop) {
      duplicates.push(drop);
      if (drop.kind === "exact") exactDropped++;
      else nearDropped++;
    }
  }
  return { cases: deduper.keptCases(), duplicates, exactDropped, nearDropped };
}

// ---------------------------------------------------------------- score filter

export interface MinScoreFilter {
  name: string;
  min: number;
}

/** Parses `<name>=<value>` or `<name>>=<value>` for `--min-score`. */
export function parseMinScore(raw: string): MinScoreFilter {
  const m = /^([\w.:/-]+)\s*(?:>=|=)\s*(-?\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) {
    throw new DatasetError(`invalid --min-score ${JSON.stringify(raw)}; use <name>=<value> or <name>>=<value> (e.g. quality=0.8)`);
  }
  const min = Number(m[2]!);
  if (!Number.isFinite(min)) {
    throw new DatasetError(`invalid --min-score value in ${JSON.stringify(raw)}`);
  }
  return { name: m[1]!, min };
}

// ---------------------------------------------------------------- mining

export type MineDropReason =
  | "min-turns"
  | "min-score"
  | "flagged"
  | "no-user-message"
  | "exact-duplicate"
  | "near-duplicate"
  | "limit";

export interface MineSessionsOpts {
  sessions: readonly Session[];
  getEvents: (sessionId: string) => Promise<readonly AgentEvent[]>;
  /** Session id to score name to mean numeric score (required only when `minScores` is set). */
  scores?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  minTurns?: number;
  minScores?: readonly MinScoreFilter[];
  excludeFlagged?: boolean;
  dedupeNear?: number;
  split?: Split;
  tags?: string[];
  limit?: number;
  existing?: readonly Case[];
  shingleSize?: number;
}

export interface MineSessionsReport {
  cases: Case[];
  matched: number;
  kept: number;
  dropped: number;
  droppedBy: Partial<Record<MineDropReason, number>>;
  duplicates: NearDedupeDrop[];
}

function bumpReason<K extends string>(counts: Partial<Record<K, number>>, reason: K, delta = 1): void {
  counts[reason] = (counts[reason] ?? 0) + delta;
}

/**
 * Mines candidate sessions into dataset cases, applying turn/score/flag quality filters,
 * deterministic complexity tagging, exact and optional near-duplicate filtering, and cap.
 */
export async function mineDatasetSessions(opts: MineSessionsOpts): Promise<MineSessionsReport> {
  if (opts.dedupeNear !== undefined) validateThreshold(opts.dedupeNear, "--dedupe-near");
  if (opts.minTurns !== undefined && (!Number.isSafeInteger(opts.minTurns) || opts.minTurns < 0)) {
    throw new DatasetError(`--min-turns must be a whole number of at least 0, got ${opts.minTurns}`);
  }
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
    throw new DatasetError(`--limit must be a whole number of at least 1, got ${opts.limit}`);
  }

  const deduper = new CaseDeduper(opts.dedupeNear, opts.shingleSize ?? DEFAULT_SHINGLE_SIZE, opts.existing);
  const droppedBy: Partial<Record<MineDropReason, number>> = {};
  const duplicates: NearDedupeDrop[] = [];
  let kept = 0;

  for (let i = 0; i < opts.sessions.length; i++) {
    if (opts.limit !== undefined && kept >= opts.limit) {
      bumpReason(droppedBy, "limit", opts.sessions.length - i);
      break;
    }
    const s = opts.sessions[i]!;
    if (opts.minTurns !== undefined && (s.stats.turns ?? 0) < opts.minTurns) {
      bumpReason(droppedBy, "min-turns");
      continue;
    }
    if (opts.excludeFlagged && (s.flags ?? []).some(isFailureFlag)) {
      bumpReason(droppedBy, "flagged");
      continue;
    }
    if (opts.minScores?.length) {
      const sScores = opts.scores?.get(s.id);
      const ok = opts.minScores.every((f) => {
        const v = sScores?.get(f.name);
        return v !== undefined && v >= f.min;
      });
      if (!ok) {
        bumpReason(droppedBy, "min-score");
        continue;
      }
    }
    const events = await opts.getEvents(s.id);
    const harvestOpts: CaseFromSessionOpts = {};
    if (opts.split) harvestOpts.split = opts.split;
    if (opts.tags?.length) harvestOpts.tags = opts.tags;
    let harvested: Case;
    try {
      harvested = minedCaseFromSession(s, events, harvestOpts);
    } catch (e) {
      if (e instanceof DatasetError && e.message.includes("no user message")) {
        bumpReason(droppedBy, "no-user-message");
        continue;
      }
      throw e;
    }
    const drop = deduper.consider(harvested);
    if (drop) {
      duplicates.push(drop);
      bumpReason(droppedBy, drop.kind === "exact" ? "exact-duplicate" : "near-duplicate");
      continue;
    }
    kept++;
  }

  const cases = deduper.keptCases();
  const matched = opts.sessions.length;
  return { cases, matched, kept: cases.length, dropped: matched - cases.length, droppedBy, duplicates };
}

// ---------------------------------------------------------------- stats

export interface LengthSummary {
  min: number;
  median: number;
  max: number;
}

export interface DatasetStats {
  id: string;
  name: string;
  version: string;
  total: number;
  splits: Record<Split, number> & { unassigned?: number };
  kinds?: Partial<Record<CaseKind, number>>;
  tags: Record<string, number>;
  difficulty?: Partial<Record<Difficulty, number>>;
  inputChars: LengthSummary | null;
  nearDuplicates: {
    threshold: number;
    pairs: number;
  };
}

/** Counts unordered case pairs whose normalized input 5-shingle Jaccard similarity meets `threshold`. */
export function countNearDuplicatePairs(cases: readonly Case[], threshold = DEFAULT_NEAR_THRESHOLD, shingleSize = DEFAULT_SHINGLE_SIZE): number {
  validateThreshold(threshold, "--near-threshold");
  if (cases.length < 2) return 0;
  // Bucket identical normalized texts so repeated inputs count in O(1).
  const buckets = new Map<string, number>();
  for (const c of cases) {
    const norm = normalizeForSimilarity(caseInputText(c.input));
    buckets.set(norm, (buckets.get(norm) ?? 0) + 1);
  }
  const unique = [...buckets.entries()].map(([norm, count]) => ({ count, sh: shingles(norm, shingleSize) }));
  let pairs = 0;
  for (const u of unique) {
    if (u.count > 1) pairs += (u.count * (u.count - 1)) / 2;
  }
  for (let i = 0; i < unique.length; i++) {
    const a = unique[i]!;
    for (let j = i + 1; j < unique.length; j++) {
      const b = unique[j]!;
      const minSize = Math.min(a.sh.size, b.sh.size);
      const maxSize = Math.max(a.sh.size, b.sh.size);
      if (maxSize === 0) {
        pairs += a.count * b.count;
        continue;
      }
      if (minSize / maxSize < threshold) continue;
      if (jaccardSets(a.sh, b.sh) >= threshold) pairs += a.count * b.count;
    }
  }
  return pairs;
}

/** Computes composition, input-length summary, and near-duplicate pair count for a dataset. */
export function computeDatasetStats(ds: Dataset, opts: { nearThreshold?: number; shingleSize?: number } = {}): DatasetStats {
  const threshold = opts.nearThreshold ?? DEFAULT_NEAR_THRESHOLD;
  validateThreshold(threshold, "--near-threshold");

  const splits: Record<Split, number> & { unassigned?: number } = { train: 0, dev: 0, test: 0 };
  let unassigned = 0;
  const kinds: Partial<Record<CaseKind, number>> = {};
  const tagCounts = new Map<string, number>();
  const difficulty: Partial<Record<Difficulty, number>> = {};
  const lengths: number[] = [];

  for (const c of ds.cases) {
    if (c.split && (SPLITS as readonly string[]).includes(c.split)) splits[c.split]++;
    else unassigned++;
    if (c.kind && (CASE_KINDS as readonly string[]).includes(c.kind)) {
      kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
    }
    for (const tag of c.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    const diff = caseDifficulty(c);
    if (diff) difficulty[diff] = (difficulty[diff] ?? 0) + 1;
    lengths.push(caseInputLength(c));
  }
  if (unassigned > 0) splits.unassigned = unassigned;

  const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const tags: Record<string, number> = {};
  for (const [k, n] of sortedTags) tags[k] = n;

  let inputChars: LengthSummary | null = null;
  if (lengths.length > 0) {
    lengths.sort((a, b) => a - b);
    const mid = Math.floor(lengths.length / 2);
    const median = lengths.length % 2 === 1 ? lengths[mid]! : (lengths[mid - 1]! + lengths[mid]!) / 2;
    inputChars = { min: lengths[0]!, median, max: lengths[lengths.length - 1]! };
  }

  const pairs = countNearDuplicatePairs(ds.cases, threshold, opts.shingleSize ?? DEFAULT_SHINGLE_SIZE);
  const stats: DatasetStats = {
    id: ds.id,
    name: ds.name,
    version: ds.version,
    total: ds.cases.length,
    splits,
    tags,
    inputChars,
    nearDuplicates: { threshold, pairs },
  };
  if (Object.keys(kinds).length > 0) stats.kinds = kinds;
  if (Object.keys(difficulty).length > 0) stats.difficulty = difficulty;
  return stats;
}

// ---------------------------------------------------------------- filtering

export type FilterDropReason =
  | "split"
  | "tag"
  | "difficulty"
  | "min-chars"
  | "max-chars"
  | "exact-duplicate"
  | "near-duplicate"
  | "limit";

export interface FilterCasesOpts {
  splits?: readonly Split[];
  tags?: readonly string[];
  difficulties?: readonly Difficulty[];
  minChars?: number;
  maxChars?: number;
  dedupeNear?: number;
  limit?: number;
  shingleSize?: number;
}

export interface FilterCasesReport {
  cases: Case[];
  total: number;
  kept: number;
  dropped: number;
  droppedBy: Partial<Record<FilterDropReason, number>>;
  duplicates: NearDedupeDrop[];
}

/** Filters cases by split, tag, difficulty, input length, optional near-dedup, and limit. */
export function filterDatasetCases(cases: readonly Case[], opts: FilterCasesOpts = {}): FilterCasesReport {
  if (opts.dedupeNear !== undefined) validateThreshold(opts.dedupeNear, "--dedupe-near");
  if (opts.minChars !== undefined && (!Number.isSafeInteger(opts.minChars) || opts.minChars < 0)) {
    throw new DatasetError(`--min-chars must be a whole number of at least 0, got ${opts.minChars}`);
  }
  if (opts.maxChars !== undefined && (!Number.isSafeInteger(opts.maxChars) || opts.maxChars < 0)) {
    throw new DatasetError(`--max-chars must be a whole number of at least 0, got ${opts.maxChars}`);
  }
  if (opts.minChars !== undefined && opts.maxChars !== undefined && opts.minChars > opts.maxChars) {
    throw new DatasetError(`--min-chars (${opts.minChars}) cannot exceed --max-chars (${opts.maxChars})`);
  }
  if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
    throw new DatasetError(`--limit must be a whole number of at least 1, got ${opts.limit}`);
  }

  const splitSet = opts.splits?.length ? new Set<Split>(opts.splits) : undefined;
  const tagSet = opts.tags?.length ? new Set<string>(opts.tags) : undefined;
  const diffSet = opts.difficulties?.length ? new Set<Difficulty>(opts.difficulties) : undefined;
  const deduper = opts.dedupeNear !== undefined ? new CaseDeduper(opts.dedupeNear, opts.shingleSize ?? DEFAULT_SHINGLE_SIZE) : undefined;

  const droppedBy: Partial<Record<FilterDropReason, number>> = {};
  const duplicates: NearDedupeDrop[] = [];
  const kept: Case[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    if (splitSet && (!c.split || !splitSet.has(c.split))) {
      bumpReason(droppedBy, "split");
      continue;
    }
    if (tagSet && !(c.tags ?? []).some((t) => tagSet.has(t))) {
      bumpReason(droppedBy, "tag");
      continue;
    }
    if (diffSet) {
      const diff = caseDifficulty(c);
      if (!diff || !diffSet.has(diff)) {
        bumpReason(droppedBy, "difficulty");
        continue;
      }
    }
    const len = caseInputLength(c);
    if (opts.minChars !== undefined && len < opts.minChars) {
      bumpReason(droppedBy, "min-chars");
      continue;
    }
    if (opts.maxChars !== undefined && len > opts.maxChars) {
      bumpReason(droppedBy, "max-chars");
      continue;
    }
    if (opts.limit !== undefined && kept.length >= opts.limit) {
      bumpReason(droppedBy, "limit");
      continue;
    }
    if (deduper) {
      const drop = deduper.consider(c);
      if (drop) {
        duplicates.push(drop);
        bumpReason(droppedBy, drop.kind === "exact" ? "exact-duplicate" : "near-duplicate");
        continue;
      }
    }
    kept.push(c);
  }

  const out = deduper ? deduper.keptCases() : kept;
  const total = cases.length;
  return { cases: out, total, kept: out.length, dropped: total - out.length, droppedBy, duplicates };
}
