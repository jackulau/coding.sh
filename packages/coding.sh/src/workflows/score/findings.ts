// Review/find workflows scored against a seeded-bug set (docs/WORKFLOWS.md §5).
//
// One finding ↔ one bug, greedy by line distance: same file, finding line
// within [a − slack, b + slack] (slack 5). A finding with no line can match
// only through the optional judge (lowest priority). Extra findings that would
// match an already-matched bug are duplicates. Unmatched findings are kept for
// human labeling: an unseeded real bug counts against precision until labeled.
import type { SeededBug } from "../types.ts";

export interface Finding {
  file: string;
  line?: number;
  summary: string;
  severity?: string;
}

/** Decides whether a line-less finding describes a bug (e.g. a calibrated judge). */
export type JudgeFn = (finding: Finding, bug: SeededBug) => boolean;

export interface FindingsScore {
  /** [finding index, bug id]. */
  matches: [number, string][];
  precision: number;
  recall: number;
  f1: number;
  /** Severity-weighted recall (P0 = 3, P1 = 2, P2 = 1). */
  weightedRecall: number;
  duplicates: number;
  /** duplicates / findings. */
  duplicateRate: number;
  /** Finding indices matched to no bug and not duplicates (to label by hand). */
  unmatched: number[];
  /** Bug ids no finding matched. */
  missed: string[];
}

export const DEFAULT_SLACK = 5;
const SEVERITY_WEIGHT: Record<SeededBug["severity"], number> = { P0: 3, P1: 2, P2: 1 };

export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").trim();
}

/** Same file: equal, or one is a path suffix of the other (absolute vs package-relative). */
export function sameFile(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** Distance from a line to [a, b]; 0 inside. */
export function lineDistance(line: number, [a, b]: [number, number]): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return line < lo ? lo - line : line > hi ? line - hi : 0;
}

export function matchFindings(findings: Finding[], bugs: SeededBug[], o: { slack?: number; judge?: JudgeFn } = {}): FindingsScore {
  const slack = o.slack ?? DEFAULT_SLACK;
  type Cand = { f: number; b: number; d: number };
  const cands: Cand[] = [];
  findings.forEach((f, fi) => {
    bugs.forEach((bug, bi) => {
      if (!sameFile(f.file, bug.file)) return;
      if (typeof f.line === "number" && Number.isFinite(f.line)) {
        const d = lineDistance(f.line, bug.lines);
        if (d <= slack) cands.push({ f: fi, b: bi, d });
      } else if (o.judge?.(f, bug)) {
        cands.push({ f: fi, b: bi, d: slack + 1 });
      }
    });
  });
  cands.sort((x, y) => x.d - y.d || x.f - y.f || x.b - y.b);
  const fUsed = new Map<number, number>();
  const bUsed = new Set<number>();
  for (const c of cands) {
    if (fUsed.has(c.f) || bUsed.has(c.b)) continue;
    fUsed.set(c.f, c.b);
    bUsed.add(c.b);
  }
  const candFindings = new Set(cands.map((c) => c.f));
  let duplicates = 0;
  const unmatched: number[] = [];
  findings.forEach((_f, i) => {
    if (fUsed.has(i)) return;
    // It had a candidate bug, but every candidate was taken by a closer finding.
    if (candFindings.has(i)) duplicates++;
    else unmatched.push(i);
  });
  const matches: [number, string][] = [...fUsed.entries()].sort((a, b) => a[0] - b[0]).map(([f, b]) => [f, bugs[b]!.id]);
  const precision = findings.length ? fUsed.size / findings.length : bugs.length ? 0 : 1;
  const recall = bugs.length ? bUsed.size / bugs.length : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const totalW = bugs.reduce((s, b) => s + (SEVERITY_WEIGHT[b.severity] ?? 1), 0);
  const gotW = bugs.reduce((s, b, i) => s + (bUsed.has(i) ? (SEVERITY_WEIGHT[b.severity] ?? 1) : 0), 0);
  return {
    matches,
    precision,
    recall,
    f1,
    weightedRecall: totalW ? gotW / totalW : 1,
    duplicates,
    duplicateRate: findings.length ? duplicates / findings.length : 0,
    unmatched,
    missed: bugs.filter((_b, i) => !bUsed.has(i)).map((b) => b.id),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Findings out of a workflow's return value: an array of findings, or an
 * object holding one under findings / issues / bugs / items. Accepts
 * `path` or `file`, and `line` or `lines: [a, b]` or "file:line" strings.
 */
export function extractFindings(output: unknown): Finding[] {
  let list: unknown = output;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (isObj(list)) list = list.findings ?? list.issues ?? list.bugs ?? list.items ?? (isObj(list.review) ? list.review.findings : undefined);
  if (!Array.isArray(list)) return [];
  const out: Finding[] = [];
  for (const x of list) {
    if (!isObj(x)) continue;
    let file = typeof x.file === "string" ? x.file : typeof x.path === "string" ? x.path : typeof x.location === "string" ? x.location : undefined;
    if (!file) continue;
    let line: number | undefined = typeof x.line === "number" ? x.line : Array.isArray(x.lines) && typeof x.lines[0] === "number" ? x.lines[0] : undefined;
    const m = /^(.*?):(\d+)(?::\d+)?$/.exec(file);
    if (m) {
      file = m[1]!;
      line ??= Number(m[2]);
    }
    const summary = typeof x.summary === "string" ? x.summary : typeof x.title === "string" ? x.title : typeof x.description === "string" ? x.description : "";
    const f: Finding = { file, summary };
    if (line !== undefined) f.line = line;
    if (typeof x.severity === "string") f.severity = x.severity;
    out.push(f);
  }
  return out;
}
