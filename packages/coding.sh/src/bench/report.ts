// Publishable benchmark report: one self-contained HTML page (inline CSS and
// SVG, no scripts, no external assets) plus the same data as JSON. Built from
// run records alone, so CI can rebuild it from a copied benchmarks/ folder.
//
// Safe to publish by default: local paths never appear, and for private
// benchmarks (sessions, command and dataset sources unless the definition
// says otherwise) case contents, outputs and session ids stay out unless the
// caller passes includePrivate.
import { basename } from "node:path";
import { verifySeed, type SeedCheck } from "./commit.ts";
import { pooledGap, type PooledGap } from "./stats.ts";
import { contentChanges, historyRuns, otherRuns, protocolBreaks, series, vsSeries, type ContentChange } from "./store.ts";
import type { AnchorResult, BenchRun, ContenderSummary, FrozenCase, Metric, PairComparison, SeriesPoint } from "./types.ts";

export interface ReportOpts {
  /** Only runs within this many days of the latest run. Default 90. */
  days?: number;
  /** Base URL of a coding.sh viewer for session links. Default http://127.0.0.1:4319. */
  viewerUrl?: string;
  /** Worst cases listed per contender. Default 10. */
  worst?: number;
  /** Contender the paired history is measured against. Default: the latest run's first contender. */
  reference?: string;
  /** Include case contents, outputs and session links even for a private benchmark (for local viewing). */
  includePrivate?: boolean;
  /** Counted runs pooled for the window estimate (the definition's `window`). Default 28. */
  window?: number;
  now?: number;
}

export interface FailureRow {
  caseId: string;
  input: string;
  failure: string;
  detail?: string;
  score: number;
  latencyMs: number;
  sessionId?: string;
  sessionUrl?: string;
}

export interface RunRow {
  id: string;
  date: string;
  seed: string;
  dataset: string;
  sha256: string;
  cases: number;
  contenders: string[];
  mode: string;
  status: string;
  regradeOf?: string;
  protocolHash?: string;
}

export interface BenchReport {
  v: 1;
  bench: string;
  description?: string;
  generatedAt: string;
  /** Whether case contents are shown. */
  visibility: "public" | "private";
  redactedPrivate: boolean;
  latest: Omit<BenchRun, "cells" | "cases"> & { cases: number };
  history: Record<"pass" | "score" | "latency" | "p95" | "cost" | "errors", Record<string, SeriesPoint[]>>;
  /** Each contender's pass-rate gap to the reference, per counted run (paired on that run's cases). */
  reference: string;
  vsReference: Record<string, SeriesPoint[]>;
  /** Indexes into runs where the protocol changed (lines break there). */
  protocolBreaks: number[];
  /** Counted runs: the first complete scheduled run per date. */
  runs: RunRow[];
  /** Adhoc runs, reruns, incomplete runs and superseded originals: listed, never charted. */
  otherRuns: RunRow[];
  failures: Record<string, FailureRow[]>;
  /** Latest-run cases no contender passed. */
  unsolved: { caseId: string; input: string }[];
  /** The latest frozen case list, in full, for auditing. */
  cases: FrozenCase[];
  /** Each contender's gap to the reference pooled over the last `window` counted runs of its current segment (DerSimonian-Laird, HKSJ interval). */
  window: number;
  pooled: Record<string, PooledGap | undefined>;
  /** Mean pass rate over contenders per counted run: fresh cases, and the anchor set when there is one. A drop in both is the contenders; a drop in fresh only is a harder day. */
  difficulty: Record<string, SeriesPoint[]>;
  /** Anchor set: the same cases every day, so its trend has no day-to-day difficulty in it. */
  anchor?: { version: string; cases: number; sha256: string; frozenBy: string; history: Record<string, SeriesPoint[]>; vsReference: Record<string, SeriesPoint[]> };
  /** Keys whose content changed between counted runs. */
  contentChanges: ContentChange[];
  /** seed = "secret": the check of the latest run's revealed salt. */
  seedCheck?: SeedCheck;
}

const HISTORY_METRICS = ["pass", "score", "latency", "p95", "cost", "errors"] as const;

function clipText(v: unknown, n = 160): string {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

const SEVERITY: Record<string, number> = { crash: 0, timeout: 1, "http-error": 2, error: 3, empty: 4, "grader-error": 5, wrong: 6 };

/** Local paths out of anything published: /Users/x/proj/gen.mjs → gen.mjs. */
export function scrubPaths(s: string): string {
  return s.replace(/(?:~|\/(?:Users|home|private|tmp|var|opt|root|mnt|Volumes|srv|workspace|runner))\/[^\s'"`)]*|[A-Za-z]:\\[^\s'"`)]*/g, (m) => basename(m.replace(/\\/g, "/")) || "…");
}

function rowOf(r: BenchRun): RunRow {
  return {
    id: r.id,
    date: r.date,
    seed: r.seed,
    dataset: `${r.dataset.id}@${r.dataset.version}`,
    sha256: r.dataset.sha256,
    cases: r.cases.filter((c) => !c.anchor).length,
    contenders: r.contenders.map((c) => c.name),
    mode: r.mode ?? "scheduled",
    status: r.status ?? "complete",
    ...(r.regradeOf ? { regradeOf: r.regradeOf } : {}),
    ...(r.definition.protocolHash ? { protocolHash: r.definition.protocolHash } : {}),
  };
}

export function buildReport(all: readonly BenchRun[], opts: ReportOpts = {}): BenchReport {
  if (!all.length) throw new Error("no runs to report on");
  const counted = historyRuns(all);
  // The headline run is the newest counted one; with none yet (only adhoc runs), the newest complete run.
  const latest = counted.at(-1) ?? all.filter((r) => (r.status ?? "complete") === "complete").at(-1) ?? all.at(-1)!;
  const days = opts.days ?? 90;
  const cutoff = Date.parse(latest.date) - days * 86400e3;
  const runs = counted.filter((r) => Date.parse(r.date) > cutoff);
  const viewer = (opts.viewerUrl ?? "http://127.0.0.1:4319").replace(/\/+$/, "");
  const visibility = latest.visibility ?? "private";
  const hide = visibility === "private" && !opts.includePrivate;
  const byCase = new Map(latest.cases.map((c) => [c.id, c]));
  const show = (v: unknown, n?: number) => (hide ? "(private)" : scrubPaths(clipText(v, n)));
  const failures: Record<string, FailureRow[]> = {};
  for (const c of latest.contenders) {
    const bad = latest.cells.filter((x) => x.contender === c.name && !x.pass);
    bad.sort((x, y) => x.score - y.score || (SEVERITY[x.failure ?? ""] ?? 3) - (SEVERITY[y.failure ?? ""] ?? 3) || y.latencyMs - x.latencyMs || (x.caseId < y.caseId ? -1 : 1));
    failures[c.name] = bad.slice(0, opts.worst ?? 10).map((x) => {
      const fc = byCase.get(x.caseId);
      const sid = hide ? undefined : (x.sessionId ?? fc?.sourceSessionId);
      const row: FailureRow = { caseId: x.caseId, input: show(fc?.input), failure: x.failure ?? "wrong", score: x.score, latencyMs: x.latencyMs };
      const failedGrader = x.grades?.find((g) => !g.pass);
      const detail = hide ? (failedGrader ? `failed ${failedGrader.grader}` : undefined) : (x.error ?? failedGrader?.reason ?? (x.output !== undefined ? `output: ${x.output}` : undefined));
      if (detail) row.detail = scrubPaths(clipText(detail, 240));
      if (sid) {
        row.sessionId = sid;
        row.sessionUrl = `${viewer}/#/s/${encodeURIComponent(sid)}`;
      }
      return row;
    });
  }
  const passedBy = new Map<string, boolean>();
  for (const x of latest.cells) passedBy.set(x.caseId, (passedBy.get(x.caseId) ?? false) || x.pass);
  const excludedIds = new Set(latest.excluded?.ids ?? []);
  const unsolved = latest.cases.filter((c) => passedBy.get(c.id) === false && !excludedIds.has(c.id)).map((c) => ({ caseId: c.id, input: show(c.input) }));
  const { cells: _cells, cases, ...rest } = latest;
  const history = Object.fromEntries(HISTORY_METRICS.map((m) => [m, series(runs, m as Metric)])) as BenchReport["history"];
  const reference = opts.reference && latest.contenders.some((c) => c.name === opts.reference) ? opts.reference : latest.contenders[0]!.name;
  const vsReference = vsSeries(runs, reference);
  const window = opts.window ?? 28;
  const pooled: Record<string, PooledGap | undefined> = {};
  for (const [n, pts] of Object.entries(vsReference)) {
    const seg = pts.at(-1)?.segment;
    const use = pts.filter((x) => x.segment === seg && x.value !== null && x.lo !== undefined && x.hi !== undefined).slice(-window);
    pooled[n] = pooledGap(use.map((x) => ({ value: x.value!, lo: x.lo!, hi: x.hi!, n: x.n })));
  }
  const meanPass = (xs: readonly ContenderSummary[] | undefined) => {
    const v = (xs ?? []).filter((x) => x.n).map((x) => x.passRate.p);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const difficulty: Record<string, SeriesPoint[]> = { fresh: runs.map((r) => ({ date: r.date, run: r.id, value: meanPass(r.summaries), n: r.cases.filter((c) => !c.anchor).length })) };
  if (runs.some((r) => r.anchor)) difficulty.anchor = runs.map((r) => ({ date: r.date, run: r.id, value: meanPass(r.anchor?.summaries), n: r.anchor?.cases ?? 0 }));
  const la: AnchorResult | undefined = latest.anchor;
  const anchor = la
    ? { version: la.version, cases: la.cases, sha256: la.sha256, frozenBy: la.frozenBy, history: series(runs, "pass", { anchor: true }), vsReference: vsSeries(runs, reference, { anchor: true }) }
    : undefined;
  const seedCheck = verifySeed(latest, all);
  const publicCases: FrozenCase[] = hide
    ? cases.map((c) => ({ id: c.id, key: /^[0-9a-f]{16,64}$/.test(c.key) || c.key === c.id ? c.key : "(private)", input: "(private)", ...(c.stratum !== undefined ? { stratum: c.stratum } : {}), ...(c.contentSha256 ? { contentSha256: c.contentSha256 } : {}), ...(c.anchor ? { anchor: true as const } : {}) }))
    : cases.map(({ sourceSessionId: _s, ...c }) => c);
  return {
    v: 1,
    bench: latest.bench,
    ...(latest.description ? { description: latest.description } : {}),
    generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
    visibility,
    redactedPrivate: hide,
    latest: {
      ...rest,
      definition: { ...rest.definition, file: basename(rest.definition.file) },
      source: { kind: rest.source.kind, ref: scrubPaths(rest.source.ref) },
      contenders: rest.contenders.map((c) => ({ ...c, ref: scrubPaths(c.ref) })),
      summaries: rest.summaries.map((x) => ({ ...x, ref: scrubPaths(x.ref) })),
      warnings: rest.warnings.map(scrubPaths),
      cases: cases.length,
    },
    history,
    reference,
    vsReference,
    protocolBreaks: protocolBreaks(runs),
    runs: runs.map(rowOf),
    otherRuns: otherRuns(all).filter((r) => Date.parse(r.date) > cutoff).map(rowOf),
    failures,
    unsolved,
    cases: publicCases,
    window,
    pooled,
    difficulty,
    ...(anchor ? { anchor } : {}),
    contentChanges: contentChanges(runs),
    ...(seedCheck ? { seedCheck } : {}),
  };
}

// ---------------------------------------------------------------- HTML

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const PALETTE = ["#e4e4e7", "#60a5fa", "#f5b041", "#c084fc", "#2dd4bf", "#f472b6", "#a3e635", "#fb923c"];

const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(d)}%`);
const ms = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : x < 1000 ? `${Math.round(x)} ms` : `${(x / 1000).toFixed(x < 10_000 ? 2 : 1)} s`);
const usd = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `$${x < 1 ? x.toFixed(4) : x.toFixed(2)}`);
const pp = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}` : "–");
const pval = (p: number) => (!Number.isFinite(p) ? "–" : p < 0.001 ? "<0.001" : p.toFixed(3));
const num = (x: number) => (Number.isFinite(x) ? (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(Math.round(x))) : "–");

function colorFor(names: string[]): Map<string, string> {
  return new Map(names.map((n, i) => [n, PALETTE[i % PALETTE.length]!]));
}

function fmtMetric(m: string, v: number | null): string {
  if (m === "gap") return v === null ? "–" : `${pp(v)} pp`;
  if (m === "pass" || m === "errors" || m === "score") return pct(v, m === "score" ? 0 : 1);
  if (m === "latency" || m === "p95") return ms(v);
  if (m === "cost") return usd(v);
  return v === null ? "–" : String(v);
}

/** Gap axis ticks in whole points ("+37 pp"), so the sign fits the left margin. */
const gapTick = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.round(Math.abs(v * 100))} pp`;

/** Line chart, one line per contender over runs (x = run index, labelled by date). Gaps stay gaps. */
export function trendSvg(data: Record<string, SeriesPoint[]>, metric: string, colors: Map<string, string>, title: string, size: { w: number; h: number } = { w: 720, h: 220 }, breaks: readonly number[] = [], cls = ""): string {
  const W = size.w;
  const H = size.h;
  const L = 56;
  const R = 16;
  const T = 14;
  const B = 30;
  const names = Object.keys(data);
  const pts = names.flatMap((n) => data[n]!.map((p) => p.value)).filter((v): v is number => v !== null && Number.isFinite(v));
  const runs = names.length ? data[names[0]!]!.map((p) => p.date) : [];
  if (!pts.length || !runs.length) return `<p class="muted">No ${esc(title.toLowerCase())} data yet.</p>`;
  const ratio = metric === "pass" || metric === "errors" || metric === "score";
  const gap = metric === "gap";
  let lo = ratio ? 0 : Math.min(...pts);
  let hi = ratio ? 1 : Math.max(...pts);
  if (gap) {
    const ends = names.flatMap((n) => data[n]!.flatMap((p) => [p.lo, p.hi])).filter((v): v is number => v !== undefined && Number.isFinite(v));
    const m = Math.max(0.05, ...pts.map(Math.abs), ...ends.map(Math.abs));
    lo = -m;
    hi = m;
  } else if (!ratio) {
    lo = Math.max(0, lo - (hi - lo) * 0.15);
    hi = hi + (hi - lo) * 0.15 || hi + 1;
  }
  if (hi === lo) hi = lo + 1;
  const x = (i: number) => (runs.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (runs.length - 1));
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const marks = breaks
    .filter((i) => i > 0 && i < runs.length)
    .map((i) => {
      const bx = (x(i - 1) + x(i)) / 2;
      return `<line x1="${bx.toFixed(1)}" x2="${bx.toFixed(1)}" y1="${T}" y2="${H - B}" class="brk"><title>Protocol changed: sampling, source, graders or limits differ, so values on each side are not comparable</title></line>`;
    })
    .join("");
  const band = gap
    ? names
        .map((n) => {
          const c = colors.get(n) ?? PALETTE[0]!;
          return data[n]!.map((p, i) => (p.lo === undefined || p.hi === undefined || p.value === null ? "" : `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(p.lo).toFixed(1)}" y2="${y(p.hi).toFixed(1)}" stroke="${c}" stroke-opacity=".35" stroke-width="5" stroke-linecap="round"/>`)).join("");
        })
        .join("")
    : "";
  const grid = (gap ? [0, 0.5, 1] : [0, 0.5, 1])
    .map((f) => {
      const v = lo + f * (hi - lo);
      return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="axis">${esc(gap ? gapTick(v) : fmtMetric(metric, v))}</text>`;
    })
    .join("");
  const step = Math.max(1, Math.ceil(runs.length / 8));
  const xl = runs
    .map((d, i) => (i % step === 0 || i === runs.length - 1 ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="axis">${esc(d.slice(5))}</text>` : ""))
    .join("");
  const lines = names
    .map((n) => {
      const c = colors.get(n) ?? PALETTE[0]!;
      const segs: string[] = [];
      let cur = "";
      data[n]!.forEach((p, i) => {
        const prev = data[n]![i - 1];
        if (p.value === null || !Number.isFinite(p.value) || (prev && (prev.segment ?? 0) !== (p.segment ?? 0))) {
          if (cur) segs.push(cur);
          cur = "";
          if (p.value === null || !Number.isFinite(p.value)) return;
        }
        cur += `${cur ? " L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`;
      });
      if (cur) segs.push(cur);
      const dots = data[n]!.map((p, i) =>
        p.value === null || !Number.isFinite(p.value) ? "" : `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" fill="${c}"><title>${esc(`${n} · ${p.date} · ${fmtMetric(metric, p.value)}${p.lo !== undefined && p.hi !== undefined ? ` (95% CI ${fmtMetric(metric, p.lo)}–${fmtMetric(metric, p.hi)})` : ""} · n=${p.n}`)}</title></circle>`,
      ).join("");
      return `<g data-contender="${esc(n)}">${segs.map((d) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join("")}${dots}</g>`;
    })
    .join("");
  const zero = gap ? `<line x1="${L}" x2="${W - R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="zero"/>` : "";
  return `<svg class="trend${cls ? ` ${cls}` : ""}" data-metric="${esc(metric)}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)} by day">${grid}${zero}${marks}${xl}${band}${lines}</svg>`;
}

function legend(names: string[], colors: Map<string, string>): string {
  return `<div class="legend">${names.map((n) => `<span><i style="background:${colors.get(n)}"></i>${esc(n)}</span>`).join("")}</div>`;
}

const SOURCE_LABEL: Record<string, string> = { reported: "reported", configured: "costPerRun", "price-table": "price table", unknown: "unknown" };

/** "reported" when every priced call reported its own cost, else the mix ("8 reported, 4 price table"). */
function costMix(x: ContenderSummary): string {
  const all: Record<string, number | undefined> = x.costUsd.sources ?? (x.costUsd.known ? { reported: x.costUsd.known } : {});
  const src = Object.keys(SOURCE_LABEL).filter((k) => all[k]).map((k) => [k, all[k]!] as const);
  if (src.length === 1) return SOURCE_LABEL[src[0]![0]] ?? src[0]![0];
  return src.map(([k, v]) => `${v} ${SOURCE_LABEL[k] ?? k}`).join(", ");
}

function leaderboard(s: readonly ContenderSummary[], colors: Map<string, string>, anchor?: readonly ContenderSummary[]): string {
  const anc = new Map((anchor ?? []).map((x) => [x.contender, x]));
  const rows = s
    .map(
      (x) => `<tr>
  <td class="num">${x.place}</td>
  <td><span class="sw" style="background:${colors.get(x.contender)}"></span>${esc(x.contender)}<div class="meta">${esc(x.kind)} · ${esc(x.ref)}</div></td>
  <td class="num strong">${pct(x.passRate.p)}<div class="meta">${pct(x.passRate.lo)}–${pct(x.passRate.hi)}</div></td>
  <td class="num">${x.passed}/${x.n}</td>
  ${anchor ? `<td class="num">${anc.get(x.contender)?.n ? `${pct(anc.get(x.contender)!.passRate.p)}<div class="meta">${anc.get(x.contender)!.passed}/${anc.get(x.contender)!.n}</div>` : "–"}</td>` : ""}
  <td class="num">${pct(x.meanScore, 0)}</td>
  <td class="num">${ms(x.latencyMs.p50)}</td>
  <td class="num">${ms(x.latencyMs.p95)}</td>
  <td class="num">${x.costUsd.known ? `${usd(x.costUsd.perRun)}<div class="meta">${esc(costMix(x))}</div>` : "–"}</td>
  <td class="num">${x.costUsd.known && x.passed ? usd(x.costUsd.perThousandPasses) : "–"}</td>
  <td class="num">${x.tokensIn?.known || x.tokensOut?.known ? `${x.tokensIn?.known ? num(x.tokensIn.mean) : "–"} / ${x.tokensOut?.known ? num(x.tokensOut.mean) : "–"}` : x.tokens.known ? num(x.tokens.mean) : "–"}</td>
  <td class="num">${x.errors}</td>
</tr>`,
    )
    .join("");
  return `<div class="scroll"><table class="board"><thead><tr><th class="num">#</th><th>Contender</th><th class="num">Pass rate</th><th class="num">Passed</th>${anchor ? `<th class="num">Anchor set</th>` : ""}<th class="num">Score</th><th class="num">p50</th><th class="num">p95</th><th class="num">Cost / run</th><th class="num">Cost / 1k passes</th><th class="num">Tokens in / out</th><th class="num">Errors</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function headToHead(pairs: readonly PairComparison[]): string {
  if (!pairs.length) return "";
  const rows = pairs
    .map((p) => {
      const verdict = p.verdict === "tie" ? `<span class="muted">no significant difference</span>` : `<span class="win">${esc(p.verdict === "a" ? p.a : p.b)} ahead</span>`;
      const ratio = (r?: number) => (r === undefined ? "" : ` · ${r.toFixed(2)}×`);
      const lat = p.latencyDiffMs ? `${p.latencyDiffMs.mean >= 0 ? "+" : "−"}${ms(Math.abs(p.latencyDiffMs.mean))}<div class="meta">${ms(p.latencyDiffMs.lo)} to ${ms(p.latencyDiffMs.hi)}${ratio(p.latencyRatio)}</div>` : "–";
      const cost = p.costRatio === undefined ? "–" : `${p.costRatio.toFixed(2)}×`;
      return `<tr>
  <td>${esc(p.a)} <span class="muted">vs</span> ${esc(p.b)}</td>
  <td class="num">${p.paired}</td>
  <td class="num">${pp(p.diff.mean)} pp<div class="meta">${pp(p.diff.lo)} to ${pp(p.diff.hi)}</div></td>
  <td class="num">${p.aOnly}</td>
  <td class="num">${p.bOnly}</td>
  <td class="num">${pval(p.p)}</td>
  <td class="num">${pval(p.pAdj)}</td>
  <td class="num">${lat}</td>
  <td class="num">${cost}</td>
  <td>${verdict}</td>
</tr>`;
    })
    .join("");
  const warn = [...new Set(pairs.flatMap((p) => p.warnings))].slice(0, 3);
  return `<div class="scroll"><table><thead><tr><th>Pair (A vs B)</th><th class="num">Paired cases</th><th class="num">A − B pass rate<br><span class="meta">95% CI, unadjusted</span></th><th class="num">Only A passed</th><th class="num">Only B passed</th><th class="num">McNemar p</th><th class="num">Holm p</th><th class="num">A − B latency<br><span class="meta">A/B geo-mean</span></th><th class="num">Cost A/B<br><span class="meta">geo-mean</span></th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table></div>${warn.length ? `<ul class="notes">${warn.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}`;
}

/** The window estimate: each contender's gap pooled over recent days, fixed and random effects side by side. */
function pooledTable(r: BenchReport): string {
  const rows = Object.entries(r.pooled).filter((e): e is [string, PooledGap] => !!e[1]);
  if (!rows.length) return "";
  const body = rows
    .map(
      ([n, g]) => `<tr>
  <td>${esc(n)} <span class="muted">vs</span> ${esc(r.reference)}</td>
  <td class="num">${g.k}</td>
  <td class="num">${g.cases}</td>
  <td class="num strong">${pp(g.random.mean)} pp<div class="meta">${pp(g.random.lo)} to ${pp(g.random.hi)}</div></td>
  <td class="num">${g.predict ? `${pp(g.predict.lo)} to ${pp(g.predict.hi)}` : "–"}</td>
  <td class="num">${pp(g.fixed.mean)} pp<div class="meta">${pp(g.fixed.lo)} to ${pp(g.fixed.hi)}</div></td>
  <td class="num">${Math.round(g.i2 * 100)}%</td>
</tr>`,
    )
    .join("");
  return `<h3>Gap over the last ${r.window} days</h3><p class="meta">Each day's paired gap, pooled. The main interval lets the true gap move from day to day (DerSimonian-Laird with the Hartung-Knapp correction); "next day" is where one more day's gap should land; I² is the share of day-to-day spread that is real rather than sampling noise. The window size is set in the definition before looking at results.</p><div class="scroll"><table><thead><tr><th>Pair</th><th class="num">Days</th><th class="num">Cases</th><th class="num">Pooled gap<br><span class="meta">95% CI</span></th><th class="num">Next day<br><span class="meta">95%</span></th><th class="num">Fixed effect<br><span class="meta">95% CI</span></th><th class="num">I²</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

const MODE_COLORS: Record<string, string> = { wrong: "#f59ba1", timeout: "#f5b041", crash: "#f0616a", "http-error": "#fb923c", empty: "#a8a8ae", "grader-error": "#c084fc", error: "#6f6f76" };

function failureBars(s: readonly ContenderSummary[]): string {
  const modes = [...new Set(s.flatMap((x) => Object.keys(x.failures)))].sort((a, b) => (SEVERITY[a] ?? 9) - (SEVERITY[b] ?? 9) || a.localeCompare(b));
  if (!modes.length) return `<p class="muted">No failures in the latest run.</p>`;
  const color = (m: string, i: number) => MODE_COLORS[m] ?? PALETTE[(i + 2) % PALETTE.length]!;
  const rows = s
    .map((x) => {
      const bar = modes
        .map((m, i) => {
          const k = x.failures[m] ?? 0;
          return k ? `<span style="width:${((k / Math.max(1, x.n)) * 100).toFixed(2)}%;background:${color(m, i)}" title="${esc(`${m}: ${k}`)}"></span>` : "";
        })
        .join("");
      const failed = x.n - x.passed;
      return `<div class="frow"><div class="fname">${esc(x.contender)}<span class="meta"> ${failed}/${x.n} failed</span></div><div class="fbar">${bar}</div></div>`;
    })
    .join("");
  return `<div class="fbars">${rows}</div><div class="legend">${modes.map((m, i) => `<span><i style="background:${color(m, i)}"></i>${esc(m)}</span>`).join("")}</div>`;
}

function failureTables(r: BenchReport): string {
  return Object.entries(r.failures)
    .map(([name, rows]) => {
      if (!rows.length) return `<h3>${esc(name)}</h3><p class="muted">Passed every case.</p>`;
      const body = rows
        .map(
          (f) => `<tr>
  <td><code>${esc(f.caseId)}</code><div class="dim">${esc(f.input)}</div></td>
  <td><span class="tag">${esc(f.failure)}</span></td>
  <td class="dim">${esc(f.detail ?? "")}</td>
  <td class="num">${ms(f.latencyMs)}</td>
  <td>${f.sessionUrl ? `<a href="${esc(f.sessionUrl)}">session</a>` : `<span class="muted">–</span>`}</td>
</tr>`,
        )
        .join("");
      return `<h3>${esc(name)}</h3><div class="scroll"><table class="fails"><thead><tr><th>Case</th><th>Failure</th><th>Detail</th><th class="num">Latency</th><th>Trace</th></tr></thead><tbody>${body}</tbody></table></div>`;
    })
    .join("");
}

const CSS = `
:root{--bg:#08080a;--surface:#111114;--raised:#18181c;--text:#f4f4f5;--text-2:#a8a8ae;--muted:#6f6f76;--line:rgba(255,255,255,.08);--line-strong:rgba(255,255,255,.14);--pass:#3ccf7a;--pass-ink:#7ee2a8;--fail:#f0616a;--fail-ink:#f59ba1;--sans:"Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:"Geist Mono",ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;color-scheme:dark}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;font:14px/1.55 var(--sans);background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
main{max-width:1080px;margin:0 auto;padding:40px 16px 80px}
h1,h2,h3{font-family:var(--mono);font-weight:560;letter-spacing:-.02em;margin:0}
h1{font-size:1.5rem;letter-spacing:-.035em}h2{font-size:1rem;margin:0 0 4px}h3{font-size:.875rem;margin:20px 0 8px;color:var(--text-2)}
p{margin:0}a{color:var(--text);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:3px}a:hover{text-decoration-color:var(--text)}
code{font-family:var(--mono);font-size:12px}
section{margin-top:28px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px}
.lead{color:var(--text-2);margin-top:6px;max-width:70ch}
.meta{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.muted{color:var(--muted)}.dim{color:var(--text-2)}.strong{font-weight:600}
.facts{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:14px;font-family:var(--mono);font-size:12px;color:var(--text-2)}
.facts b{color:var(--text);font-weight:500}
.sub{color:var(--muted);margin-bottom:14px}
.scroll{overflow-x:auto;margin:0 -4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{font-weight:500;color:var(--muted);text-align:left;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line-strong);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.sw{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:8px;vertical-align:1px}
.win{color:var(--pass-ink)}
.tag{font-family:var(--mono);font-size:11.5px;padding:2px 7px;border-radius:6px;background:rgba(240,97,106,.1);color:var(--fail-ink);white-space:nowrap}
.trend{width:100%;height:auto;display:block}.trend.sm{display:none}@media(max-width:640px){.trend.lg{display:none}.trend.sm{display:block}}
.trend .grid{stroke:var(--line)}.trend .axis{fill:var(--muted);font:11px var(--mono)}.trend .zero{stroke:var(--line-strong)}.trend .brk{stroke:var(--text-2);stroke-dasharray:3 4}
.charts{display:grid;gap:18px}.vs{margin-top:22px}
@media(min-width:900px){.charts{grid-template-columns:1fr 1fr}.charts>div:first-child{grid-column:1/-1}}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font-size:12px;color:var(--text-2)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px}
.fbars{display:grid;gap:10px}
.frow{display:grid;grid-template-columns:minmax(120px,220px) 1fr;gap:12px;align-items:center}
.fname{font-size:13px}
.fbar{height:12px;border-radius:6px;background:var(--raised);overflow:hidden;display:flex}
.fbar span{display:block;height:100%}
.notes{margin:12px 0 0;padding-left:18px;color:var(--muted);font-size:12.5px}
details{margin-top:12px}summary{cursor:pointer;color:var(--text-2)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px}
.kv dt{color:var(--muted)}.kv dd{margin:0;font-family:var(--mono);font-size:12px;word-break:break-all}
footer{margin-top:28px;color:var(--muted);font-size:12px}
@media(max-width:600px){main{padding-top:24px}section{padding:16px}.frow{grid-template-columns:1fr}}
`;

export function renderReportHtml(r: BenchReport): string {
  const L = r.latest;
  const names = L.contenders.map((c) => c.name);
  const colors = colorFor([...new Set([...names, ...Object.keys(r.history.pass)])]);
  const histNames = Object.keys(r.history.pass);
  const charts: [string, string, string][] = [
    ["pass", "Pass rate", "Share of cases each contender passed, per run."],
    ["latency", "Median latency", "p50 over answered requests."],
    ["cost", "Cost per run", "Mean cost per call: reported by the contender, its costPerRun, or tokens × list price."],
  ];
  // A full-width chart is drawn twice: 720 wide for desktop and 400 wide for
  // phones, where a 720 viewBox would shrink the axis labels to ~5px. CSS
  // shows one, so the page stays script-free.
  const wide = (data: Record<string, SeriesPoint[]>, m: string, title: string, h: number) =>
    trendSvg(data, m, colors, title, { w: 720, h }, r.protocolBreaks, "lg") + trendSvg(data, m, colors, title, { w: 400, h: 230 }, r.protocolBreaks, "sm");
  const chartHtml = charts
    .map(([m, title, sub]) => {
      const data = r.history[m as keyof BenchReport["history"]];
      return `<div><h3>${esc(title)}</h3><p class="meta">${esc(sub)}</p>${m === "pass" ? wide(data, m, title, 220) : trendSvg(data, m, colors, title, { w: 400, h: 190 }, r.protocolBreaks)}</div>`;
    })
    .join("");
  const vsNames = Object.keys(r.vsReference);
  const vsChart = vsNames.length
    ? `<div class="vs"><h3>Gap to ${esc(r.reference)}</h3><p class="meta">Pass-rate difference on the cases both ran that day, with its 95% paired CI. Above zero beats ${esc(r.reference)}. Easier or harder days cancel out here.</p>${wide(r.vsReference, "gap", `Gap to ${r.reference}`, 200)}${legend(vsNames, colors)}${pooledTable(r)}</div>`
    : "";
  const diffColors = new Map([["fresh", PALETTE[0]!], ["anchor", PALETTE[1]!]]);
  const difficulty = r.runs.length > 1
    ? `<div class="vs"><h3>Difficulty</h3><p class="meta">Mean pass rate over all contenders, per day${r.difficulty.anchor ? ": fresh cases and the anchor set. When both drop, the contenders got worse; when only fresh drops, the day's cases were harder" : ". A day where every contender drops was probably a harder sample, not a worse field. Add an [anchor] set to tell the two apart"}.</p>${trendSvg(r.difficulty, "pass", diffColors, "Difficulty", { w: 720, h: 160 }, r.protocolBreaks, "lg difficulty")}${trendSvg(r.difficulty, "pass", diffColors, "Difficulty", { w: 400, h: 200 }, r.protocolBreaks, "sm difficulty")}${r.difficulty.anchor ? legend(["fresh", "anchor"], diffColors) : ""}</div>`
    : "";
  const A = r.anchor;
  const anchorSection = A && L.anchor
    ? `<section id="anchor">
  <h2>Anchor set</h2>
  <p class="sub">${A.cases} fixed cases (version ${esc(A.version)}, picked by run <code>${esc(A.frozenBy)}</code>, sha256 <code title="${esc(A.sha256)}">${esc(A.sha256.slice(0, 12))}</code>) run every day next to the fresh sample and are scored apart from it. The cases never change, so this trend has no day-to-day difficulty in it. They can leak into training data over time: read it next to the fresh numbers, not instead of them.</p>
  ${leaderboard(L.anchor.summaries, colors)}
  <h3>Pass rate on the anchor set</h3>
  ${trendSvg(A.history, "pass", colors, "Anchor pass rate", { w: 720, h: 200 }, r.protocolBreaks, "lg anchor")}${trendSvg(A.history, "pass", colors, "Anchor pass rate", { w: 400, h: 230 }, r.protocolBreaks, "sm anchor")}
  ${Object.keys(A.vsReference).length ? `<h3>Gap to ${esc(r.reference)} on the anchor set</h3>${trendSvg(A.vsReference, "gap", colors, "Anchor gap", { w: 720, h: 180 }, r.protocolBreaks, "lg anchor")}${trendSvg(A.vsReference, "gap", colors, "Anchor gap", { w: 400, h: 230 }, r.protocolBreaks, "sm anchor")}` : ""}
  ${headToHead(L.anchor.comparisons)}
</section>`
    : "";
  const sc = r.seedCheck;
  const seedFact = L.seedCommit ? "secret" : L.seed;
  const seedRow = L.seedCommit
    ? `<dt>Seed</dt><dd>secret, revealed after the run. Salt ${esc(L.seedCommit.salt)}; sha256(salt) = ${esc(L.seedCommit.commitment)}${sc ? (sc.ok ? ` <span class="win">verified</span>: ${esc(sc.checks.map((x) => x.detail).join("; "))}` : ` <span class="tag">check failed</span>: ${esc(sc.checks.filter((x) => !x.ok).map((x) => x.detail).join("; "))}`) : ""}</dd>${L.seedCommit.next ? `<dt>Next seed</dt><dd>${esc(L.seedCommit.next.date)}: sha256(salt) = ${esc(L.seedCommit.next.commitment)}. That run's revealed salt must hash to this, so its sample was fixed before it ran.</dd>` : ""}`
    : `<dt>Seed</dt><dd>${esc(L.seed)}</dd>`;
  const allSources: Record<string, number> = {};
  for (const x of L.summaries) for (const [k, v] of Object.entries(x.costUsd.sources ?? {})) allSources[k] = (allSources[k] ?? 0) + (v ?? 0);
  const costRow = Object.keys(allSources).length
    ? `<dt>Cost</dt><dd>${esc(Object.keys(SOURCE_LABEL).filter((k) => allSources[k]).map((k) => `${allSources[k]} ${SOURCE_LABEL[k]}`).join(", "))} calls${L.pricing ? `; price table: tokens × list price per model (prices checked ${esc([...new Set(Object.values(L.pricing.updated))].sort().join(", "))})` : ""}</dd>`
    : "";
  const changes = r.contentChanges.length
    ? `<ul class="notes">${r.contentChanges.slice(0, 10).map((x) => `<li>${x.anchor ? "Anchor case" : "Case"} ${esc(clipText(x.key, 60))} changed content between ${esc(x.from.date)} and ${esc(x.to.date)}: its scores on each side measure different things.</li>`).join("")}${r.contentChanges.length > 10 ? `<li>… and ${r.contentChanges.length - 10} more (report.json lists them).</li>` : ""}</ul>`
    : "";
  const unsolved = r.unsolved.length
    ? `<h3>No contender passed (${r.unsolved.length})</h3><div class="scroll"><table><tbody>${r.unsolved.slice(0, 25).map((u) => `<tr><td><code>${esc(u.caseId)}</code></td><td class="dim">${esc(u.input)}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  const strata = L.sampling.strata ? Object.entries(L.sampling.strata).map(([k, v]) => `${k}: ${v}`).join(", ") : "";
  const ex = L.excluded;
  const exText = ex && ex.cases ? `${ex.cases} (${Object.entries(ex.byReason).map(([k, v]) => `${v} ${k}`).join(", ")}), dropped for every contender` : "none";
  const versions = L.contenders.map((c) => `${c.name}: ${[c.model, c.version].filter(Boolean).join(" ") || "–"}`).join("; ");
  const caseRows = r.cases.map((c) => `<tr><td><code>${esc(c.id)}</code>${c.anchor ? ` <span class="meta">anchor</span>` : ""}</td><td class="dim">${esc(clipText(c.key, 80))}</td>${L.sampling.stratify ? `<td>${esc(c.stratum ?? "")}</td>` : ""}<td class="dim">${esc(clipText(c.input, 120))}</td></tr>`).join("");
  const runRow = (x: RunRow) => `<tr><td class="num">${esc(x.date)}</td><td><code>${esc(x.id)}</code>${x.regradeOf ? `<div class="meta">regrade of ${esc(x.regradeOf)}</div>` : ""}</td><td>${esc(x.mode)}${x.status !== "complete" ? ` · ${esc(x.status)}` : ""}</td><td><code title="${esc(x.seed)}">${esc(x.seed.length > 40 ? x.seed.slice(0, 39) + "…" : x.seed)}</code></td><td class="num">${x.cases}</td><td><code title="${esc(x.sha256)}">${esc(x.sha256.slice(0, 16))}…</code></td></tr>`;
  const runHead = `<thead><tr><th class="num">Date</th><th>Run</th><th>Kind</th><th>Seed</th><th class="num">Cases</th><th>sha256</th></tr></thead>`;
  const runRows = [...r.runs].reverse().map(runRow).join("");
  const otherRows = [...r.otherRuns].reverse().map(runRow).join("");
  const leader = L.summaries.filter((s) => s.place === 1).map((s) => s.contender);
  const lead =
    leader.length === 1
      ? `${esc(leader[0])} leads on ${esc(L.date)}.`
      : `${leader.map(esc).join(" and ")} share first place on ${esc(L.date)}: the difference between them is not significant.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="coding.sh bench">
<title>${esc(r.bench)} benchmark</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <p class="meta">coding.sh benchmark</p>
  <h1>${esc(r.bench)}</h1>
  <p class="lead">${r.description ? `${esc(r.description)} ` : ""}${r.runs.length} run${r.runs.length === 1 ? "" : "s"} from ${esc(r.runs[0]!.date)} to ${esc(L.date)}. Each run draws new cases, freezes them, and gives every contender the same set in random order. ${lead}</p>
  <div class="facts"><span>latest <b>${esc(L.date)}</b></span><span>cases <b>${L.cases - (L.anchor?.cases ?? 0)}</b>${L.anchor ? ` + ${L.anchor.cases} anchor` : ""}</span>${ex && ex.cases ? `<span>excluded <b>${ex.cases}</b></span>` : ""}<span>seed <b>${esc(seedFact)}</b></span><span>sha256 <b title="${esc(L.dataset.sha256)}">${esc(L.dataset.sha256.slice(0, 12))}</b></span><span>source <b>${esc(L.source.kind)}</b></span><span><a href="report.json">report.json</a></span></div>
</header>

<section id="leaderboard">
  <h2>Leaderboard</h2>
  <p class="sub">Latest counted run. Contenders share a place when their difference is not significant (exact McNemar, Holm-adjusted, α 0.05). Pass rate shows a 95% ${L.summaries[0]?.ciMethod === "cluster-bootstrap" ? "bootstrap interval that resamples cases, so repeated trials of one case move together" : "Wilson interval over cases"}.${ex && ex.cases ? ` ${ex.cases} excluded case${ex.cases === 1 ? " is" : "s are"} left out for everyone.` : ""}</p>
  ${leaderboard(L.summaries, colors, L.anchor?.summaries)}
  ${L.warnings.length ? `<ul class="notes">${L.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
</section>

<section id="trend">
  <h2>Trend</h2>
  <p class="sub">One point per day: the first complete scheduled run. Reruns and manual runs are listed under Method, never charted. Gaps mean the contender was not in that run${r.protocolBreaks.length ? "; a dashed line means the protocol changed and the two sides are not comparable" : ""}.</p>
  ${legend(histNames, colors)}
  <div class="charts">${chartHtml}</div>
  ${vsChart}
  ${difficulty}
</section>
${anchorSection}

<section id="head-to-head">
  <h2>Head to head</h2>
  <p class="sub">Paired on the same cases. The pass-rate interval is a paired bootstrap and is not adjusted for the number of pairs; the verdict uses McNemar's test on cases where only one side passed, Holm-adjusted across pairs.</p>
  ${headToHead(L.comparisons)}
</section>

<section id="failures">
  <h2>Where each contender fails</h2>
  <p class="sub">Failure reasons in the latest run, then the worst cases for each contender.</p>
  ${failureBars(L.summaries)}
  ${failureTables(r)}
  ${unsolved}
</section>

<section id="method">
  <h2>Method and audit</h2>
  <p class="sub">Everything needed to check the sample was not cherry-picked.</p>
  <dl class="kv">
    <dt>Source</dt><dd>${esc(L.source.kind)}: ${esc(L.source.ref)}</dd>
    <dt>Sampling</dt><dd>${L.sampling.requested} requested from ${L.sampling.candidates} candidates${L.sampling.fresh ? `, ${L.sampling.excludedSeen} skipped as already tested` : ", repeats allowed"}${L.sampling.contentSeen ? `, ${L.sampling.contentSeen} skipped because their content was already tested under another key` : ""}, ${L.sampling.duplicates} duplicates dropped${L.sampling.stratify ? `, balanced over ${esc(L.sampling.stratify)} (${esc(strata)})` : ""}${L.anchor ? `; plus ${L.anchor.cases} anchor cases, scored apart` : ""}</dd>
    ${seedRow}
    <dt>Order</dt><dd>cases shuffled by seed; contender order shuffled per case</dd>
    <dt>Limits</dt><dd>${L.policy ? `${ms(L.policy.timeoutMs)} timeout and ${L.policy.retries} ${L.policy.retries === 1 ? "retry" : "retries"} for every contender` : "–"}${L.budget ? `; budget $${L.budget.capUsd}, spent ${usd(L.budget.spentUsd)}` : ""}</dd>
    <dt>Excluded</dt><dd>${esc(exText)}</dd>
    ${costRow}
    <dt>Versions</dt><dd>${esc(versions)}${L.codingShVersion ? `; coding.sh ${esc(L.codingShVersion)}` : ""}</dd>
    ${L.redacted ? `<dt>Redacted</dt><dd>${L.redacted} case${L.redacted === 1 ? "" : "s"} had secrets removed at freeze</dd>` : ""}
    ${L.snapshots ? `<dt>Snapshots</dt><dd>${L.snapshots.ok} of ${L.snapshots.fetched} pages fetched at freeze; body hashes are part of the case sha256</dd>` : ""}
    <dt>Frozen set</dt><dd>${esc(L.dataset.id)}@${esc(L.dataset.version)}</dd>
    <dt>Case sha256</dt><dd>${esc(L.dataset.sha256)}</dd>
    <dt>Protocol</dt><dd>${esc(L.definition.protocolHash ?? L.definition.hash)}</dd>
    <dt>Graders</dt><dd>${L.graders.length ? L.graders.map((g) => `${esc(g.id)} (${esc(g.kind)})`).join(", ") : "none: a case passes when the contender answers without an error"}</dd>
    <dt>Trials</dt><dd>${L.trials}</dd>
  </dl>
  <p class="notes">${
    r.redactedPrivate
      ? "Case contents are private for this benchmark, so only ids are listed. The sha256 still pins the exact set: the owner can publish the cases later and anyone can check them against it."
      : "To verify: take <code>cases</code> from report.json, sort by id, keep id, input, expected and metadata, and hash the canonical JSON (keys sorted) with sha256."
  }</p>
  ${changes}
  <details><summary>Latest case list (${r.cases.length})</summary><div class="scroll"><table><thead><tr><th>Case</th><th>Key</th>${L.sampling.stratify ? "<th>Stratum</th>" : ""}<th>Input</th></tr></thead><tbody>${caseRows}</tbody></table></div></details>
  <details><summary>Counted runs (${r.runs.length})</summary><div class="scroll"><table>${runHead}<tbody>${runRows}</tbody></table></div></details>
  ${r.otherRuns.length ? `<details><summary>Other runs, not charted (${r.otherRuns.length})</summary><p class="notes">Manual runs (--seed, --cases, --date), same-day reruns, incomplete runs and runs replaced by a regrade.</p><div class="scroll"><table>${runHead}<tbody>${otherRows}</tbody></table></div></details>` : ""}
</section>

<footer>Generated ${esc(r.generatedAt)} by coding.sh bench report.</footer>
</main>
</body>
</html>
`;
}

