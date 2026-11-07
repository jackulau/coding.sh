// Deterministic sampling. The same seed over the same candidate pool always
// yields the same cases, in any input order: each candidate is ranked by a
// hash of (seed, dedupe key). A new day means a new seed, so a new sample,
// and `fresh` drops every key an earlier run already tested.
import { hashUnit } from "../datasets/hash.ts";
import type { Case } from "../datasets/types.ts";

/** Value at a dotted path (`metadata.url`, `input.title`, `id`). */
export function fieldAt(c: Case, path: string): unknown {
  let v: unknown = c;
  for (const k of path.split(".")) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

function keyText(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Dedupe key for a case: the configured field, else the case id (a content hash by default). */
export function dedupeKey(c: Case, dedupeBy?: string): string {
  if (dedupeBy) {
    const k = keyText(fieldAt(c, dedupeBy));
    if (k !== undefined) return k;
  }
  return c.id;
}

export function dateOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** The seed string a run uses. "date" → `<name>:<YYYY-MM-DD>`, "run" → `<name>:<runId>`, else the value itself. */
export function resolveSeed(seed: string, o: { name: string; date: string; runId: string }): string {
  if (seed === "date") return `${o.name}:${o.date}`;
  if (seed === "run") return `${o.name}:${o.runId}`;
  return seed;
}

export interface SampleOpts {
  n: number;
  seed: string;
  dedupeBy?: string;
  stratify?: string;
  /** Keys tested by earlier runs; skipped when given. */
  seen?: ReadonlySet<string>;
  /** Content hashes tested by earlier runs (the ledger's second column); with contentOf, matching candidates are skipped. */
  seenContent?: ReadonlySet<string>;
  /** Content hash of a candidate; also drops a second candidate with the same content under another key. */
  contentOf?: (c: Case) => string | undefined;
  /** Keys taken by something else this run (the anchor set): skipped without counting as already tested. */
  exclude?: ReadonlySet<string>;
  /** At most n cases per value of a field (e.g. metadata.host), applied in rank order. */
  caps?: { field: string; n: number }[];
}

export interface SampledCase {
  case: Case;
  key: string;
  stratum?: string;
}

export interface SampleResult {
  cases: SampledCase[];
  candidates: number;
  duplicates: number;
  excludedSeen: number;
  /** Candidates skipped by caps. */
  capped: number;
  /** Candidates skipped because their content was tested before or repeats another candidate's. */
  contentSeen: number;
  strata?: Record<string, number>;
}

/**
 * Pick up to n cases. Duplicates (same key) collapse to the first seen;
 * keys in `seen` are skipped. With `stratify`, strata get equal shares
 * (the remainder goes to strata that still have cases, in rank order), so a
 * big category can't crowd out the small ones. The result is sorted by rank.
 */
export function sampleCases(pool: readonly Case[], o: SampleOpts): SampleResult {
  const keys = new Set<string>();
  const fresh: SampledCase[] = [];
  let duplicates = 0;
  let excludedSeen = 0;
  let contentSeen = 0;
  const contents = new Set<string>();
  for (const c of pool) {
    const key = dedupeKey(c, o.dedupeBy);
    if (keys.has(key)) {
      duplicates++;
      continue;
    }
    keys.add(key);
    if (o.exclude?.has(key)) continue;
    if (o.seen?.has(key)) {
      excludedSeen++;
      continue;
    }
    const h = o.contentOf?.(c);
    if (h !== undefined) {
      if (o.seenContent?.has(h) || contents.has(h)) {
        contentSeen++;
        continue;
      }
      contents.add(h);
    }
    const s: SampledCase = { case: c, key };
    if (o.stratify) s.stratum = keyText(fieldAt(c, o.stratify)) ?? "(none)";
    fresh.push(s);
  }
  // Rank by seed first; caps then walk that order, so which cases a cap keeps is random too.
  let ranked = fresh
    .map((s) => ({ s, r: hashUnit(o.seed, s.key) }))
    .sort((a, b) => a.r - b.r || (a.s.key < b.s.key ? -1 : 1))
    .map((x) => x.s);
  let capped = 0;
  for (const cap of o.caps ?? []) {
    const count = new Map<string, number>();
    ranked = ranked.filter((s) => {
      const v = keyText(fieldAt(s.case, cap.field));
      if (v === undefined) return true;
      const k = (count.get(v) ?? 0) + 1;
      count.set(v, k);
      if (k > cap.n) capped++;
      return k <= cap.n;
    });
  }
  const candidates = ranked.length;
  const n = Math.max(0, Math.floor(o.n));
  let picked: SampledCase[];
  let strata: Record<string, number> | undefined;
  if (!o.stratify) picked = ranked.slice(0, n);
  else {
    const groups = new Map<string, SampledCase[]>();
    for (const s of ranked) {
      const g = groups.get(s.stratum!) ?? [];
      g.push(s);
      groups.set(s.stratum!, g);
    }
    // Round-robin over strata in rank order of their best case: equal shares, leftovers to whoever has more.
    const order = [...groups.keys()].sort((a, b) => ranked.indexOf(groups.get(a)![0]!) - ranked.indexOf(groups.get(b)![0]!));
    const take = new Map<string, number>(order.map((k) => [k, 0]));
    let left = Math.min(n, candidates);
    while (left > 0) {
      let moved = false;
      for (const k of order) {
        if (left === 0) break;
        if (take.get(k)! < groups.get(k)!.length) {
          take.set(k, take.get(k)! + 1);
          left--;
          moved = true;
        }
      }
      if (!moved) break;
    }
    const chosen = new Set<SampledCase>();
    strata = {};
    for (const k of order) {
      const t = take.get(k)!;
      if (t) strata[k] = t;
      for (const s of groups.get(k)!.slice(0, t)) chosen.add(s);
    }
    picked = ranked.filter((s) => chosen.has(s));
  }
  return { cases: picked, candidates, duplicates, excludedSeen, capped, contentSeen, ...(strata ? { strata } : {}) };
}

/** Seeded Fisher–Yates over a copy (hash-driven, so it's stable across machines). */
export function seededShuffle<T>(xs: readonly T[], seed: string): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(hashUnit(seed, String(i)) * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
