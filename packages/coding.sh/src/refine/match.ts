// Scoring diagnoses against human labels (Signals, Rambatla et al., arXiv
// 2611.04507v2 §6.1-6.4): code decides every match, never a model.
//
// An occurrence is one problem in one session: the component it happened in,
// up to three ranked type ids from the taxonomy (src/refine/taxonomy.ts), and
// the Signal (the issue a developer would fix) it belongs to. A predicted
// occurrence matches a labelled one when both are in the same session, name
// the same component (same type, equal normalizeComponentName) and their top-3
// type ids share at least one id. Matching is a maximum one-to-one matching
// (Kuhn's augmenting paths over ids in sorted order), so the result does not
// depend on input order, and every unmatched item stays in a denominator. A
// rate with a zero denominator is NaN and named in `empty`, never 1.
//
// Flag mode: a deterministic flag diagnosis (FLAG_DIAGNOSIS) names a session
// and types but no component. An occurrence without a component matches on
// session and types alone (flagPredictions).
//
// `coding.sh refine score` runs this on a labels file. Y-5's `refine diagnose
// --eval` should call the same functions on its diagnoses.
//
// Pure apart from the taxonomy lookups.
import { FAMILIES, FLAG_DIAGNOSIS, diagnosticType, type FamilyId, type Nature } from "./taxonomy.ts";

export const COMPONENT_TYPES = ["agent", "subagent", "tool", "model", "runtime", "harness"] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export interface Component {
  type: ComponentType;
  name: string;
}

export interface Occurrence {
  sessionId: string;
  /** The Signal this occurrence belongs to; one Signal can span sessions. */
  signalId: string;
  /** Absent for a flag diagnosis: it matches any component. */
  component?: Component;
  /** 1-3 taxonomy ids, best first. Only the first three count. */
  typeIds: readonly string[];
  nature?: Nature;
  /** The session flag a deterministic prediction came from. */
  flag?: string;
}

/** 'createPayment', 'create_payment' and 'Create Payment' all give 'create-payment'. */
export function normalizeComponentName(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/(\p{Ll}|\p{Nd})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{Nd})/gu, "$1 $2")
    .replace(/(\p{Nd})(\p{L})/gu, "$1 $2")
    .toLowerCase()
    .replace(/[-_./\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Maximum one-to-one matching between `left` and `right` where `edge` allows a
 * pair. Kuhn's augmenting paths, visiting both sides in id order, so the same
 * sets give the same pairs in any input order. Pairs come back in left-id order.
 */
export function maxMatching<L extends { id: string }, R extends { id: string }>(left: readonly L[], right: readonly R[], edge: (l: L, r: R) => boolean): [L, R][] {
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ls = [...left].sort(byId);
  const rs = [...right].sort(byId);
  const adj = ls.map((l) => rs.flatMap((r, j) => (edge(l, r) ? [j] : [])));
  const owner = new Array<number>(rs.length).fill(-1);
  const augment = (i: number, seen: Uint8Array): boolean => {
    for (const j of adj[i]!) {
      if (seen[j]) continue;
      seen[j] = 1;
      if (owner[j]! < 0 || augment(owner[j]!, seen)) {
        owner[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < ls.length; i++) if (adj[i]!.length) augment(i, new Uint8Array(rs.length));
  const pairs: [L, R][] = [];
  for (let j = 0; j < rs.length; j++) if (owner[j]! >= 0) pairs.push([ls[owner[j]!]!, rs[j]!]);
  return pairs.sort((a, b) => byId(a[0], b[0]));
}

export type RateName = "precision" | "recall" | "f1";

export interface Rates {
  tp: number;
  fp: number;
  fn: number;
  /** tp / (tp + fp). */
  precision: number;
  /** tp / (tp + fn). */
  recall: number;
  /** 2tp / (2tp + fp + fn). */
  f1: number;
  /** The rates whose denominator is 0 (they are NaN). Absent when there are none. */
  empty?: RateName[];
}

export function rates(tp: number, fp: number, fn: number): Rates {
  const ratio = (n: number, d: number) => (d > 0 ? n / d : NaN);
  const r: Rates = { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), f1: ratio(2 * tp, 2 * tp + fp + fn) };
  const empty = (["precision", "recall", "f1"] as const).filter((k) => Number.isNaN(r[k]));
  if (empty.length) r.empty = empty;
  return r;
}

// ------------------------------------------------------------ occurrences

interface Keyed {
  id: string;
  o: Occurrence;
  name?: string;
  types: readonly string[];
}

const occKey = (o: Occurrence): string => JSON.stringify([o.sessionId, o.signalId, o.component?.type ?? "", o.component?.name ?? "", o.typeIds, o.nature ?? "", o.flag ?? ""]);

/** Ids that sort by content; exact duplicates get #0, #1, … and are interchangeable. */
function keyed(items: readonly Occurrence[]): Keyed[] {
  const seen = new Map<string, number>();
  return items
    .map((o) => ({ k: occKey(o), o }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map(({ k, o }) => {
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      return { id: `${k}#${n}`, o, ...(o.component ? { name: normalizeComponentName(o.component.name) } : {}), types: o.typeIds.slice(0, 3) };
    });
}

const shareAny = (a: readonly string[], b: readonly string[]): boolean => a.some((x) => b.includes(x));

/** Same session, same component (or none given), top-3 types overlap. */
function occurrenceEdge(p: Keyed, r: Keyed): boolean {
  if (p.o.sessionId !== r.o.sessionId) return false;
  if (p.o.component && r.o.component && (p.o.component.type !== r.o.component.type || p.name !== r.name)) return false;
  return shareAny(p.types, r.types);
}

/** True when the two occurrences can be matched. */
export function occurrencesMatch(pred: Occurrence, ref: Occurrence): boolean {
  const [p] = keyed([pred]);
  const [r] = keyed([ref]);
  return occurrenceEdge(p!, r!);
}

export interface OccurrencePair {
  pred: Occurrence;
  ref: Occurrence;
}

export interface FamilyRecall {
  /** Labelled occurrences whose first type is in this family, and how many were matched. */
  n: number;
  tp: number;
  recall: number;
}

export interface OccurrenceScore extends Rates {
  /** Matched pairs, in reference order. */
  pairs: OccurrencePair[];
  /** Recall per family of the labelled occurrence's first type, in FAMILIES order. */
  byFamily: Partial<Record<FamilyId, FamilyRecall>>;
}

const groupBy = <T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
};

/** Occurrence P/R/F1 over a maximum one-to-one matching, run per session (no edge crosses sessions). */
export function scoreOccurrences(pred: readonly Occurrence[], ref: readonly Occurrence[]): OccurrenceScore {
  const P = groupBy(keyed(pred), (k) => k.o.sessionId);
  const R = groupBy(keyed(ref), (k) => k.o.sessionId);
  const matched: [Keyed, Keyed][] = [];
  for (const [sid, rs] of R) matched.push(...maxMatching(P.get(sid) ?? [], rs, occurrenceEdge));
  matched.sort((a, b) => (a[1].id < b[1].id ? -1 : 1));
  const tp = matched.length;
  const hit = new Set(matched.map(([, r]) => r.o));
  const byFamily: Partial<Record<FamilyId, FamilyRecall>> = {};
  const fam = groupBy(ref, (o) => diagnosticType(o.typeIds[0] ?? "")?.family ?? "");
  for (const f of FAMILIES) {
    const list = fam.get(f.id);
    if (!list) continue;
    const n = list.length;
    const t = list.filter((o) => hit.has(o)).length;
    byFamily[f.id] = { n, tp: t, recall: t / n };
  }
  return { ...rates(tp, pred.length - tp, ref.length - tp), pairs: matched.map(([p, r]) => ({ pred: p.o, ref: r.o })), byFamily };
}

// ---------------------------------------------------------------- Signals

export interface Coverage {
  /** Labelled Signals. */
  signals: number;
  /** Signals with at least one matched occurrence. */
  atLeastOne: number;
  /** Signals with at least half of their occurrences matched. */
  atLeastHalf: number;
  atLeastOneRate: number;
  atLeastHalfRate: number;
  /** True when there are no labelled Signals (the rates are NaN). */
  empty?: true;
}

/** How many labelled Signals the matched pairs reach: with at least one, and with at least half, of their occurrences matched. */
export function signalCoverage(pairs: readonly OccurrencePair[], ref: readonly Occurrence[]): Coverage {
  const total = groupBy(ref, (o) => o.signalId);
  const hit = groupBy(pairs, (p) => p.ref.signalId);
  let one = 0;
  let half = 0;
  for (const [id, list] of total) {
    const m = hit.get(id)?.length ?? 0;
    if (m >= 1) one++;
    if (m >= 1 && 2 * m >= list.length) half++;
  }
  const n = total.size;
  const c: Coverage = { signals: n, atLeastOne: one, atLeastHalf: half, atLeastOneRate: n ? one / n : NaN, atLeastHalfRate: n ? half / n : NaN };
  if (!n) c.empty = true;
  return c;
}

interface SignalShape {
  id: string;
  batches: Set<string>;
  /** `type:normalized-name`; null when an occurrence has no component (matches any). */
  components: Set<string> | null;
  types: Set<string>;
}

function signalShapes(items: readonly Occurrence[], batchOf: (sessionId: string) => string): SignalShape[] {
  return [...groupBy(items, (o) => o.signalId)].map(([id, list]) => ({
    id,
    batches: new Set(list.map((o) => batchOf(o.sessionId))),
    components: list.every((o) => o.component) ? new Set(list.map((o) => `${o.component!.type}:${normalizeComponentName(o.component!.name)}`)) : null,
    types: new Set(list.flatMap((o) => o.typeIds.slice(0, 3))),
  }));
}

const overlaps = (a: Set<string>, b: Set<string>): boolean => [...a].some((x) => b.has(x));

export interface SignalScore extends Rates {
  pairs: { pred: string; ref: string }[];
}

/**
 * Signal-to-Signal P/R/F1. Occurrences group into Signals by signalId. Two
 * Signals can match when they share a batch (`batchOf`, default: one batch), a
 * component and a type id. How many occurrences each side has does not matter.
 */
export function scoreSignals(pred: readonly Occurrence[], ref: readonly Occurrence[], opts: { batchOf?: (sessionId: string) => string } = {}): SignalScore {
  const batchOf = opts.batchOf ?? (() => "");
  const P = signalShapes(pred, batchOf);
  const R = signalShapes(ref, batchOf);
  const pairs = maxMatching(P, R, (p, r) => overlaps(p.batches, r.batches) && (!p.components || !r.components || overlaps(p.components, r.components)) && overlaps(p.types, r.types));
  return { ...rates(pairs.length, P.length - pairs.length, R.length - pairs.length), pairs: pairs.map(([p, r]) => ({ pred: p.id, ref: r.id })) };
}

// --------------------------------------------------------------- sessions

/** Session-level P/R/F1: a session is positive when it has at least one occurrence. */
export function sessionPresence(pred: readonly Occurrence[], ref: readonly Occurrence[]): Rates {
  const p = new Set(pred.map((o) => o.sessionId));
  const r = new Set(ref.map((o) => o.sessionId));
  const tp = [...p].filter((s) => r.has(s)).length;
  return rates(tp, p.size - tp, r.size - tp);
}

export interface Agreement {
  /** Mean over run pairs of the share of sessions where both runs agree on presence. */
  agreement: number;
  runs: number;
  pairs: number;
  sessions: number;
  /** True with fewer than 2 runs or no sessions (agreement is NaN). */
  empty?: true;
}

/**
 * Repeat agreement: for each pair of runs, the share of `sessions` (default:
 * every session any run names) where both runs say the same about whether the
 * session has a problem; then the mean over pairs.
 */
export function repeatAgreement(runs: readonly (readonly Occurrence[])[], sessions?: readonly string[]): Agreement {
  const universe = [...new Set(sessions ?? runs.flatMap((r) => r.map((o) => o.sessionId)))];
  const present = runs.map((r) => new Set(r.map((o) => o.sessionId)));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < present.length; i++)
    for (let j = i + 1; j < present.length; j++) {
      pairs++;
      if (universe.length) sum += universe.filter((s) => present[i]!.has(s) === present[j]!.has(s)).length / universe.length;
    }
  const a: Agreement = { agreement: pairs && universe.length ? sum / pairs : NaN, runs: runs.length, pairs, sessions: universe.length };
  if (Number.isNaN(a.agreement)) a.empty = true;
  return a;
}

// ------------------------------------------------------------------ flags

/**
 * One occurrence per diagnosed flag per session (FLAG_DIAGNOSIS), with no
 * component: Signal `flag:<name>`. Tags (with a colon) and context-only flags
 * are not diagnoses.
 */
export function flagPredictions(sessions: readonly { id: string; flags?: readonly string[] }[]): Occurrence[] {
  const out: Occurrence[] = [];
  for (const s of sessions)
    for (const flag of new Set(s.flags ?? [])) {
      if (flag.includes(":")) continue;
      const d = FLAG_DIAGNOSIS[flag];
      if (!d || d === "context-only") continue;
      out.push({ sessionId: s.id, signalId: `flag:${flag}`, typeIds: d.typeIds.slice(0, 3), nature: d.nature, flag });
    }
  return out;
}

export interface FlagPrecision {
  flag: string;
  /** Sessions with the flag, and how many match a labelled occurrence. */
  n: number;
  tp: number;
  precision: number;
}

/** Per-flag precision. Each flag is matched against the labels on its own, so two flags can both be credited with one labelled occurrence. */
export function flagPrecision(pred: readonly Occurrence[], ref: readonly Occurrence[]): FlagPrecision[] {
  return [...groupBy(pred.filter((o) => o.flag), (o) => o.flag!)]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([flag, list]) => {
      const s = scoreOccurrences(list, ref);
      return { flag, n: list.length, tp: s.tp, precision: s.precision };
    });
}

// ----------------------------------------------------------------- labels

export interface LabelError {
  line: number;
  message: string;
}

export interface Labels {
  occurrences: Occurrence[];
  /** Every session the file names, including sessions labelled with nothing found; sorted. */
  sessions: string[];
  errors: LabelError[];
}

const NATURES: readonly Nature[] = ["defect", "risk", "inefficiency"];

/**
 * Parses labels JSONL: one occurrence per line,
 * `{"sessionId", "signalId", "component": {"type", "name"}, "typeIds": [1-3 ids], "nature"?}`.
 * A line with only `sessionId` marks a session reviewed with nothing found.
 * Unknown type ids, components and natures are errors with their line number;
 * a line with an error is left out.
 */
export function parseLabels(text: string): Labels {
  const occurrences: Occurrence[] = [];
  const sessions = new Set<string>();
  const errors: LabelError[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    const line = i + 1;
    const err = (message: string) => errors.push({ line, message });
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      err("not valid JSON");
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      err("not a JSON object");
      continue;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.sessionId !== "string" || !o.sessionId) {
      err("sessionId must be a non-empty string");
      continue;
    }
    const sessionId = o.sessionId;
    if (o.signalId === undefined && o.component === undefined && o.typeIds === undefined && o.nature === undefined) {
      sessions.add(sessionId);
      continue;
    }
    const before = errors.length;
    if (typeof o.signalId !== "string" || !o.signalId) err("signalId must be a non-empty string");
    const c = o.component as Record<string, unknown> | undefined;
    if (!c || typeof c !== "object" || Array.isArray(c)) err(`component must be {"type", "name"}`);
    else {
      if (!COMPONENT_TYPES.includes(c.type as ComponentType)) err(`unknown component type ${JSON.stringify(c.type)} (one of ${COMPONENT_TYPES.join(", ")})`);
      if (typeof c.name !== "string" || !normalizeComponentName(c.name)) err("component.name must be a non-empty string");
    }
    const ids = o.typeIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3) err("typeIds must be a list of 1 to 3 type ids");
    else {
      for (const id of ids) if (typeof id !== "string" || !diagnosticType(id)) err(`unknown type id ${JSON.stringify(id)}`);
      if (new Set(ids).size !== ids.length) err("typeIds repeats an id");
    }
    if (o.nature !== undefined) {
      if (!NATURES.includes(o.nature as Nature)) err(`unknown nature ${JSON.stringify(o.nature)} (one of ${NATURES.join(", ")})`);
      else if (Array.isArray(ids) && typeof ids[0] === "string") {
        const t = diagnosticType(ids[0]);
        if (t && !t.natures.includes(o.nature as Nature)) err(`nature ${JSON.stringify(o.nature)} is not allowed for ${t.id} (${t.natures.join(", ")})`);
      }
    }
    if (errors.length > before) continue;
    const comp = c as { type: ComponentType; name: string };
    sessions.add(sessionId);
    occurrences.push({
      sessionId,
      signalId: o.signalId as string,
      component: { type: comp.type, name: comp.name },
      typeIds: [...(ids as string[])],
      ...(o.nature !== undefined ? { nature: o.nature as Nature } : {}),
    });
  }
  return { occurrences, sessions: [...sessions].sort(), errors };
}
