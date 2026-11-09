// Checklist diagnostics and judge-version diffs (BinEval §5.6 / §3.3, read
// through docs/research/2606.27226.md §7.1 A3–A4).
//
// Over a judged set, per question: how often it says yes (near-constant items
// carry little information), how well it tracks the case outcome (φ), and
// whether it is the only thing keeping cases off the ceiling. Across questions:
// redundant pairs (|φ| > 0.8) and the share of cases at a perfect score.
//
// The diff compares two checklist judge versions question by question: what
// was added, removed, edited or reordered, and — given both versions' verdicts
// on the same cases — how often each shared question flips, with κ and the
// cases that disagree most. A model reference only diagnoses a migration;
// a migrated judge is a new version and must be calibrated against humans again.
import { cohenKappa } from "../stats/agreement.ts";
import type { ChecklistItemAnswer, ChecklistJudgeVersion, ChecklistVerdict, FrozenChecklistItem } from "./checklist.ts";

/** One judged case: its id and (a subset of) the checklist verdict. */
export interface ChecklistRun {
  caseId: string;
  verdict: Pick<ChecklistVerdict, "items" | "score" | "pass">;
}

/** Case outcomes to correlate with: true = good/pass (e.g. the human label or the verifier result). */
export type Outcomes = ReadonlyMap<string, boolean> | Readonly<Record<string, boolean>>;

function outcomeOf(o: Outcomes | undefined, caseId: string): boolean | undefined {
  if (!o) return undefined;
  if (o instanceof Map) return o.get(caseId);
  const v = (o as Record<string, boolean>)[caseId];
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Phi coefficient of two paired binary vectors (Pearson r on 0/1).
 * NaN when either side is constant (or n = 0): φ is undefined there.
 */
export function phi(a: readonly boolean[], b: readonly boolean[]): number {
  if (a.length !== b.length) throw new RangeError("phi: vectors differ in length");
  let n11 = 0;
  let n10 = 0;
  let n01 = 0;
  let n00 = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i]) b[i] ? n11++ : n10++;
    else b[i] ? n01++ : n00++;
  }
  const den = Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
  return den === 0 ? NaN : (n11 * n00 - n10 * n01) / den;
}

export interface ItemDiagnostics {
  id: string;
  dimension?: string;
  critical: boolean;
  source: "predicate" | "llm" | "mixed";
  /** Cases where this item was answered (not null). */
  n: number;
  yes: number;
  /** yes / n; NaN when n = 0. */
  yesRate: number;
  /** yesRate below `nearConstant` or above 1 − `nearConstant`: little information. */
  nearConstant: boolean;
  /** φ(item yes, outcome) over cases answered with a known outcome; NaN when undefined. */
  phiOutcome: number;
  nOutcome: number;
  /** Of the answered cases not at the ceiling, the share where this item was the only "no". */
  soleNoShare: number;
  /** Share of this item's LLM "no" answers without a verified citation. */
  unverifiedNoShare: number;
  /** Critical items only: share of answered cases this item gated. */
  gateRate?: number;
  /** Cases where the model abstained (cannot_decide) on this item. Absent when 0. */
  abstained?: number;
  /** abstained / (n + abstained). Absent when nothing abstained. */
  abstainRate?: number;
}

export interface DimensionDiagnostics {
  dimension: string;
  items: string[];
  /** max − min yes-rate across the dimension's items (BinEval §5.6). */
  yesRateSpread: number;
  /** Share of cases where every answered item of the dimension said yes. */
  ceilingShare: number;
}

export interface ChecklistDiagnostics {
  n: number;
  /** Share of cases at score 1.0 (the ceiling compression holistic judges show). */
  ceilingShare: number;
  passRate: number;
  /** φ(verdict pass, outcome); NaN when undefined or no outcomes. */
  phiOutcome: number;
  nOutcome: number;
  items: ItemDiagnostics[];
  dimensions: DimensionDiagnostics[];
  /** Item pairs with |φ| above `redundantPhi` over ≥ `minPairN` co-answered cases. */
  redundantPairs: { a: string; b: string; phi: number; n: number }[];
}

export interface DiagnosticsOpts {
  outcomes?: Outcomes;
  /** Default 0.05. */
  nearConstant?: number;
  /** Default 0.8. */
  redundantPhi?: number;
  /** Default 5. */
  minPairN?: number;
}

const answerMap = (items: readonly ChecklistItemAnswer[]) => new Map(items.map((a) => [a.id, a]));

/** Per-question diagnostics over a judged set. Item order follows first appearance. */
export function checklistDiagnostics(runs: readonly ChecklistRun[], opts: DiagnosticsOpts = {}): ChecklistDiagnostics {
  const lo = opts.nearConstant ?? 0.05;
  const redundantPhi = opts.redundantPhi ?? 0.8;
  const minPairN = opts.minPairN ?? 5;
  const order: string[] = [];
  const meta = new Map<string, { dimension?: string; critical: boolean; sources: Set<string> }>();
  const maps = runs.map((r) => answerMap(r.verdict.items));
  for (const r of runs) {
    for (const a of r.verdict.items) {
      let m = meta.get(a.id);
      if (!m) {
        m = { critical: a.critical, sources: new Set() };
        if (a.dimension) m.dimension = a.dimension;
        meta.set(a.id, m);
        order.push(a.id);
      }
      m.sources.add(a.source);
    }
  }
  const atCeiling = runs.map((r) => r.verdict.score >= 1);

  const items: ItemDiagnostics[] = order.map((id) => {
    const m = meta.get(id) as { dimension?: string; critical: boolean; sources: Set<string> };
    let n = 0;
    let yes = 0;
    let offCeiling = 0;
    let sole = 0;
    let llmNo = 0;
    let unverified = 0;
    let abstained = 0;
    const xs: boolean[] = [];
    const ys: boolean[] = [];
    runs.forEach((r, i) => {
      const a = (maps[i] as Map<string, ChecklistItemAnswer>).get(id);
      if (a?.abstained) abstained++;
      if (!a || a.answer === null) return;
      n++;
      if (a.answer) yes++;
      else {
        if (a.source === "llm") {
          llmNo++;
          if (a.unverifiedNo) unverified++;
        }
      }
      if (!atCeiling[i]) {
        offCeiling++;
        if (!a.answer && r.verdict.items.filter((x) => x.answer === false).length === 1) sole++;
      }
      const o = outcomeOf(opts.outcomes, r.caseId);
      if (o !== undefined) {
        xs.push(a.answer);
        ys.push(o);
      }
    });
    const yesRate = n ? yes / n : NaN;
    const d: ItemDiagnostics = {
      id,
      critical: m.critical,
      source: m.sources.size > 1 ? "mixed" : ([...m.sources][0] as "predicate" | "llm"),
      n,
      yes,
      yesRate,
      nearConstant: n > 0 && (yesRate < lo || yesRate > 1 - lo),
      phiOutcome: phi(xs, ys),
      nOutcome: xs.length,
      soleNoShare: offCeiling ? sole / offCeiling : 0,
      unverifiedNoShare: llmNo ? unverified / llmNo : 0,
    };
    if (m.dimension) d.dimension = m.dimension;
    if (m.critical) d.gateRate = n ? (n - yes) / n : NaN;
    if (abstained) {
      d.abstained = abstained;
      d.abstainRate = abstained / (n + abstained);
    }
    return d;
  });

  const redundantPairs: ChecklistDiagnostics["redundantPairs"] = [];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a: boolean[] = [];
      const b: boolean[] = [];
      for (const m of maps) {
        const x = m.get(order[i] as string)?.answer;
        const y = m.get(order[j] as string)?.answer;
        if (typeof x === "boolean" && typeof y === "boolean") {
          a.push(x);
          b.push(y);
        }
      }
      if (a.length < minPairN) continue;
      const p = phi(a, b);
      if (Number.isFinite(p) && Math.abs(p) > redundantPhi) redundantPairs.push({ a: order[i] as string, b: order[j] as string, phi: p, n: a.length });
    }
  }

  const dims = new Map<string, string[]>();
  for (const it of items) if (it.dimension) dims.set(it.dimension, [...(dims.get(it.dimension) ?? []), it.id]);
  const dimensions: DimensionDiagnostics[] = [...dims].map(([dimension, ids]) => {
    const rates = items.filter((it) => ids.includes(it.id) && it.n > 0).map((it) => it.yesRate);
    let ceil = 0;
    let counted = 0;
    for (const m of maps) {
      const ans = ids.map((id) => m.get(id)?.answer).filter((x): x is boolean => typeof x === "boolean");
      if (!ans.length) continue;
      counted++;
      if (ans.every(Boolean)) ceil++;
    }
    return { dimension, items: ids, yesRateSpread: rates.length ? Math.max(...rates) - Math.min(...rates) : NaN, ceilingShare: counted ? ceil / counted : NaN };
  });

  const px: boolean[] = [];
  const py: boolean[] = [];
  for (const r of runs) {
    const o = outcomeOf(opts.outcomes, r.caseId);
    if (o !== undefined) {
      px.push(r.verdict.pass);
      py.push(o);
    }
  }
  return {
    n: runs.length,
    ceilingShare: runs.length ? atCeiling.filter(Boolean).length / runs.length : NaN,
    passRate: runs.length ? runs.filter((r) => r.verdict.pass).length / runs.length : NaN,
    phiOutcome: phi(px, py),
    nOutcome: px.length,
    items,
    dimensions,
    redundantPairs,
  };
}

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "–");

export function formatChecklistDiagnostics(d: ChecklistDiagnostics): string {
  const lines = [
    `checklist diagnostics: n=${d.n} pass=${f2(d.passRate)} ceiling=${f2(d.ceilingShare)} φ(pass,outcome)=${f2(d.phiOutcome)} (n=${d.nOutcome})`,
    ...d.items.map(
      (it) =>
        `  ${it.critical ? "!" : " "} ${it.id.padEnd(28)} yes=${f2(it.yesRate)} n=${it.n} φ=${f2(it.phiOutcome)} sole-no=${f2(it.soleNoShare)}` +
        (it.gateRate !== undefined ? ` gate=${f2(it.gateRate)}` : "") +
        (it.nearConstant ? " [near-constant]" : "") +
        (it.unverifiedNoShare > 0 ? ` [unverified-no ${f2(it.unverifiedNoShare)}]` : "") +
        (it.abstainRate !== undefined ? ` [abstained ${f2(it.abstainRate)}]` : ""),
    ),
    ...d.dimensions.map((x) => `  dim ${x.dimension}: spread=${f2(x.yesRateSpread)} ceiling=${f2(x.ceilingShare)}`),
    ...d.redundantPairs.map((p) => `  redundant: ${p.a} ~ ${p.b} φ=${f2(p.phi)} (n=${p.n})`),
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------- version diff

type ItemField = "question" | "dimension" | "violationExample" | "critical" | "weight" | "check";
const ITEM_FIELDS: readonly ItemField[] = ["question", "dimension", "violationExample", "critical", "weight", "check"];

export interface ChecklistItemChange {
  id: string;
  fields: ItemField[];
  before: FrozenChecklistItem;
  after: FrozenChecklistItem;
}

export interface ChecklistVersionDiff {
  from: string;
  to: string;
  /** Same ordered question list (checklistHash equal). */
  sameQuestions: boolean;
  added: FrozenChecklistItem[];
  removed: FrozenChecklistItem[];
  changed: ChecklistItemChange[];
  unchanged: string[];
  /** Shared ids appear in a different relative order. */
  reordered: boolean;
  /** Version-level settings that differ (model, provider, mode, passThreshold, promptHash, criterion). */
  settings: { key: string; from: unknown; to: unknown }[];
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/** Question-level diff between two checklist judge versions (definitions only; no model calls). */
export function diffChecklistVersions(a: ChecklistJudgeVersion, b: ChecklistJudgeVersion): ChecklistVersionDiff {
  const am = new Map(a.items.map((it) => [it.id, it]));
  const bm = new Map(b.items.map((it) => [it.id, it]));
  const added = b.items.filter((it) => !am.has(it.id));
  const removed = a.items.filter((it) => !bm.has(it.id));
  const changed: ChecklistItemChange[] = [];
  const unchanged: string[] = [];
  for (const before of a.items) {
    const after = bm.get(before.id);
    if (!after) continue;
    const fields = ITEM_FIELDS.filter((k) => json(before[k]) !== json(after[k]));
    if (fields.length) changed.push({ id: before.id, fields, before, after });
    else unchanged.push(before.id);
  }
  const sharedA = a.items.filter((it) => bm.has(it.id)).map((it) => it.id);
  const sharedB = b.items.filter((it) => am.has(it.id)).map((it) => it.id);
  const settings: ChecklistVersionDiff["settings"] = [];
  for (const key of ["provider", "model", "mode", "passThreshold", "promptHash", "criterion"] as const) {
    const x = a[key];
    const y = b[key];
    if (json(x) !== json(y)) settings.push({ key, from: x, to: y });
  }
  return {
    from: a.id,
    to: b.id,
    sameQuestions: a.checklistHash === b.checklistHash,
    added,
    removed,
    changed,
    unchanged,
    reordered: sharedA.join("\u001f") !== sharedB.join("\u001f"),
    settings,
  };
}

export interface ItemAnswerDiff {
  id: string;
  /** Cases where both versions answered (non-null). */
  n: number;
  disagree: number;
  disagreementRate: number;
  /** Cohen's κ between the two versions' yes/no on this item; NaN when undefined. */
  kappa: number;
  yesRateFrom: number;
  yesRateTo: number;
  /** Up to `top` disagreeing cases, with both explanations. */
  examples: { caseId: string; from: { answer: boolean; explanation?: string }; to: { answer: boolean; explanation?: string } }[];
}

export interface ChecklistAnswerDiff {
  /** Cases judged by both versions. */
  n: number;
  /** Cases whose overall pass flips. */
  passFlips: string[];
  items: ItemAnswerDiff[];
  /** Ids answered by only one side. */
  onlyFrom: string[];
  onlyTo: string[];
}

/**
 * Answer-level diff of two judge versions over the same cases: per shared
 * question, how often the answers disagree, κ, and example cases. Items are
 * sorted by disagreement rate, highest first.
 */
export function diffChecklistAnswers(from: readonly ChecklistRun[], to: readonly ChecklistRun[], opts: { top?: number } = {}): ChecklistAnswerDiff {
  const top = opts.top ?? 5;
  const toBy = new Map(to.map((r) => [r.caseId, r]));
  const pairs = from.filter((r) => toBy.has(r.caseId)).map((r) => ({ caseId: r.caseId, a: r, b: toBy.get(r.caseId) as ChecklistRun }));
  const idsFrom = new Set(from.flatMap((r) => r.verdict.items.map((x) => x.id)));
  const idsTo = new Set(to.flatMap((r) => r.verdict.items.map((x) => x.id)));
  const shared = [...idsFrom].filter((id) => idsTo.has(id));
  const items: ItemAnswerDiff[] = shared.map((id) => {
    const xa: string[] = [];
    const xb: string[] = [];
    const examples: ItemAnswerDiff["examples"] = [];
    let disagree = 0;
    for (const p of pairs) {
      const a = p.a.verdict.items.find((x) => x.id === id);
      const b = p.b.verdict.items.find((x) => x.id === id);
      if (!a || !b || a.answer === null || b.answer === null) continue;
      xa.push(a.answer ? "yes" : "no");
      xb.push(b.answer ? "yes" : "no");
      if (a.answer !== b.answer) {
        disagree++;
        if (examples.length < top) {
          const fa: { answer: boolean; explanation?: string } = { answer: a.answer };
          if (a.explanation) fa.explanation = a.explanation;
          const fb: { answer: boolean; explanation?: string } = { answer: b.answer };
          if (b.explanation) fb.explanation = b.explanation;
          examples.push({ caseId: p.caseId, from: fa, to: fb });
        }
      }
    }
    const n = xa.length;
    const yr = (xs: string[]) => (xs.length ? xs.filter((x) => x === "yes").length / xs.length : NaN);
    return { id, n, disagree, disagreementRate: n ? disagree / n : NaN, kappa: n ? cohenKappa(xa, xb, ["yes", "no"]).kappa : NaN, yesRateFrom: yr(xa), yesRateTo: yr(xb), examples };
  });
  items.sort((x, y) => (Number.isFinite(y.disagreementRate) ? y.disagreementRate : -1) - (Number.isFinite(x.disagreementRate) ? x.disagreementRate : -1) || x.id.localeCompare(y.id));
  return {
    n: pairs.length,
    passFlips: pairs.filter((p) => p.a.verdict.pass !== p.b.verdict.pass).map((p) => p.caseId),
    items,
    onlyFrom: [...idsFrom].filter((id) => !idsTo.has(id)),
    onlyTo: [...idsTo].filter((id) => !idsFrom.has(id)),
  };
}

export function formatChecklistDiff(d: ChecklistVersionDiff, answers?: ChecklistAnswerDiff): string {
  const lines = [`checklist diff ${d.from} → ${d.to}${d.sameQuestions ? " (same questions)" : ""}${d.reordered ? " [reordered]" : ""}`];
  for (const s of d.settings) lines.push(`  ~ ${s.key}: ${json(s.from)} → ${json(s.to)}`);
  for (const it of d.added) lines.push(`  + ${it.id}: ${it.question}`);
  for (const it of d.removed) lines.push(`  - ${it.id}: ${it.question}`);
  for (const c of d.changed) lines.push(`  ~ ${c.id}: ${c.fields.join(", ")}`);
  if (answers) {
    lines.push(`  answers over ${answers.n} shared cases; pass flips: ${answers.passFlips.length}`);
    for (const it of answers.items) lines.push(`    ${it.id.padEnd(28)} disagree=${f2(it.disagreementRate)} (${it.disagree}/${it.n}) κ=${f2(it.kappa)} yes ${f2(it.yesRateFrom)}→${f2(it.yesRateTo)}`);
  }
  return lines.join("\n");
}
