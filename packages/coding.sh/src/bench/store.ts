// Benchmark run records: one JSON file per run under
// <data>/benchmarks/<name>/runs/<run-id>.json, written atomically. History,
// freshness and reports are all computed from these records alone, so the
// directory can be cached or copied (CI) and still rebuild everything.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../datasets/store.ts";
import { benchHome, checkName } from "./define.ts";
import type { BenchRun, ContenderSummary, Metric, PairComparison, SeriesPoint } from "./types.ts";

const RUN_ID = /^bench_[0-9A-Za-z]{10,40}$/;

export function runsDir(name: string, env?: NodeJS.ProcessEnv): string {
  return join(benchHome(env), checkName(name), "runs");
}

export async function putRun(run: BenchRun, env?: NodeJS.ProcessEnv): Promise<string> {
  if (!RUN_ID.test(run.id)) throw new Error(`invalid run id ${JSON.stringify(run.id)}`);
  const dir = runsDir(run.bench, env);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${run.id}.json`);
  await writeFileAtomic(file, JSON.stringify(run) + "\n");
  return file;
}

/** Oldest first, by run date then start time. Unreadable files are skipped. */
export async function listRuns(name: string, env?: NodeJS.ProcessEnv): Promise<BenchRun[]> {
  let files: string[];
  try {
    files = (await readdir(runsDir(name, env))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: BenchRun[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await readFile(join(runsDir(name, env), f), "utf8")) as BenchRun;
      if (r && r.v === 1 && r.bench === name) out.push(r);
    } catch {
      // a torn or foreign file never breaks history
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startedAt - b.startedAt));
}

export async function getRun(name: string, ref: string, env?: NodeJS.ProcessEnv): Promise<BenchRun | undefined> {
  const runs = await listRuns(name, env);
  if (ref === "latest") return runs.at(-1);
  return runs.find((r) => r.id === ref) ?? runs.filter((r) => r.date === ref).at(-1);
}

const SHA = /^[0-9a-f]{64}$/;

export function blobsDir(name: string, env?: NodeJS.ProcessEnv): string {
  return join(benchHome(env), checkName(name), "blobs");
}

/** Content-addressed file next to the run records (full outputs, page snapshots). Returns its sha256. */
export async function putBlob(name: string, data: string | Uint8Array, env?: NodeJS.ProcessEnv): Promise<string> {
  const sha = createHash("sha256").update(data).digest("hex");
  const dir = blobsDir(name, env);
  const file = join(dir, sha);
  if (!existsSync(file)) {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }
  return sha;
}

export async function getBlob(name: string, sha: string, env?: NodeJS.ProcessEnv): Promise<Buffer | undefined> {
  if (!SHA.test(sha)) return undefined;
  try {
    return await readFile(join(blobsDir(name, env), sha));
  } catch {
    return undefined;
  }
}

const isScheduled = (r: BenchRun) => (r.mode ?? "scheduled") === "scheduled" && (r.status ?? "complete") === "complete";

/**
 * The runs history counts: per date, the first complete scheduled run (or
 * the newest regrade of it). Adhoc runs, same-day reruns and incomplete runs
 * stay out, so nobody can rerun until the numbers look good.
 */
export function historyRuns(runs: readonly BenchRun[]): BenchRun[] {
  const byDate = new Map<string, BenchRun>();
  for (const r of runs) if (isScheduled(r) && !r.regradeOf && !byDate.has(r.date)) byDate.set(r.date, r);
  return [...byDate.values()]
    .map((orig) => runs.filter((r) => r.regradeOf === orig.id && isScheduled(r)).sort((a, b) => a.startedAt - b.startedAt).at(-1) ?? orig)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Everything else: adhoc runs, reruns, incomplete runs and superseded originals. */
export function otherRuns(runs: readonly BenchRun[]): BenchRun[] {
  const counted = new Set(historyRuns(runs).map((r) => r.id));
  return runs.filter((r) => !counted.has(r.id));
}

/**
 * Freshness ledger: dedupe keys tested by counted runs. Adhoc and incomplete
 * runs don't consume cases, so a manual run can't steer which cases the
 * scheduled ones get. Anchor cases repeat by design and never enter it.
 */
export function seenKeys(runs: readonly BenchRun[]): Set<string> {
  return ledger(runs).keys;
}

/** The ledger's two columns: keys, and the content hashes recorded at freeze (same content under a new key isn't fresh). */
export function ledger(runs: readonly BenchRun[]): { keys: Set<string>; content: Set<string> } {
  const keys = new Set<string>();
  const content = new Set<string>();
  for (const r of historyRuns(runs)) {
    for (const c of r.cases) {
      if (c.anchor) continue;
      keys.add(c.key);
      if (c.contentSha256) content.add(c.contentSha256);
    }
  }
  return { keys, content };
}

export interface ContentChange {
  key: string;
  anchor: boolean;
  from: { run: string; date: string; sha256: string };
  to: { run: string; date: string; sha256: string };
}

/**
 * Cases whose key came back with different content: a page that changed, an
 * issue that was edited, an anchor case that was rebuilt. Scores for such a
 * key on either side of the change measure different things.
 */
export function contentChanges(runs: readonly BenchRun[]): ContentChange[] {
  const first = new Map<string, { run: string; date: string; sha256: string }>();
  const out: ContentChange[] = [];
  for (const r of runs) {
    for (const c of r.cases) {
      if (!c.contentSha256) continue;
      const id = `${c.anchor ? "a" : "f"}:${c.key}`;
      const was = first.get(id);
      const now = { run: r.id, date: r.date, sha256: c.contentSha256 };
      if (!was) first.set(id, now);
      else if (was.sha256 !== c.contentSha256) {
        out.push({ key: c.key, anchor: !!c.anchor, from: was, to: now });
        first.set(id, now);
      }
    }
  }
  return out;
}

export interface SeriesOpts {
  /** Read the anchor set's numbers instead of the fresh sample's. */
  anchor?: boolean;
}

const summariesOf = (r: BenchRun, o: SeriesOpts): readonly ContenderSummary[] | undefined => (o.anchor ? r.anchor?.summaries : r.summaries);
const comparisonsOf = (r: BenchRun, o: SeriesOpts): readonly PairComparison[] | undefined => (o.anchor ? r.anchor?.comparisons : r.comparisons);

/** One metric's value for one contender in one run. */
export function metricOf(r: BenchRun, contender: string, metric: Metric, o: SeriesOpts = {}): Omit<SeriesPoint, "date" | "run"> | undefined {
  const s = summariesOf(r, o)?.find((x) => x.contender === contender);
  if (!s) return undefined;
  const v = (x: number) => (Number.isFinite(x) ? x : null);
  switch (metric) {
    case "pass":
      return { value: v(s.passRate.p), lo: s.passRate.lo, hi: s.passRate.hi, n: s.n };
    case "score":
      return { value: v(s.meanScore), n: s.n };
    case "latency":
      return { value: v(s.latencyMs.p50), n: s.latencyMs.n };
    case "p95":
      return { value: v(s.latencyMs.p95), n: s.latencyMs.n };
    case "cost":
      return { value: s.costUsd.known ? v(s.costUsd.perRun) : null, n: s.costUsd.known };
    case "tokens":
      return { value: s.tokens.known ? v(s.tokens.mean) : null, n: s.tokens.known };
    case "tokens-in":
      return { value: s.tokensIn?.known ? v(s.tokensIn.mean) : null, n: s.tokensIn?.known ?? 0 };
    case "tokens-out":
      return { value: s.tokensOut?.known ? v(s.tokensOut.mean) : null, n: s.tokensOut?.known ?? 0 };
    case "errors":
      return { value: s.n ? s.errors / s.n : null, n: s.n };
  }
}

/** Segment numbers per run for one contender: a new segment when the protocol or the contender's own definition changes (or, for the anchor, a new anchor set). */
function segments(runs: readonly BenchRun[], name: string, o: SeriesOpts = {}): number[] {
  let seg = 0;
  let proto: string | undefined;
  let mine: string | undefined;
  let set: string | undefined;
  return runs.map((r, i) => {
    const p = r.definition.protocolHash;
    const h = r.contenders.find((c) => c.name === name)?.hash;
    const a = o.anchor ? r.anchor?.sha256 : undefined;
    if (i > 0 && ((p && proto && p !== proto) || (h && mine && h !== mine) || (a && set && a !== set))) seg++;
    if (p) proto = p;
    if (h) mine = h;
    if (a) set = a;
    return seg;
  });
}

/** Runs where the protocol changed from the run before (chart markers). */
export function protocolBreaks(runs: readonly BenchRun[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1]!.definition.protocolHash;
    const b = runs[i]!.definition.protocolHash;
    if (a && b && a !== b) out.push(i);
  }
  return out;
}

/** Contender → time series. Gaps (a contender missing from a run) stay gaps; lines break at protocol changes. */
export function series(runs: readonly BenchRun[], metric: Metric, o: SeriesOpts = {}): Record<string, SeriesPoint[]> {
  const names = [...new Set(runs.flatMap((r) => r.contenders.map((c) => c.name)))];
  const out: Record<string, SeriesPoint[]> = {};
  for (const name of names) {
    const seg = segments(runs, name, o);
    out[name] = runs.map((r, i) => {
      const m = metricOf(r, name, metric, o);
      return { date: r.date, run: r.id, ...(m ?? { value: null, n: 0 }), segment: seg[i]! };
    });
  }
  return out;
}

/**
 * Paired history against a reference contender: per run, each other
 * contender's pass-rate gap (contender − reference) on the cases both ran,
 * with the run's paired bootstrap CI. Day-to-day drift in case difficulty
 * cancels out here, which raw pass rates can't do.
 */
export function vsSeries(runs: readonly BenchRun[], reference: string, o: SeriesOpts = {}): Record<string, SeriesPoint[]> {
  const names = [...new Set(runs.flatMap((r) => r.contenders.map((c) => c.name)))].filter((n) => n !== reference);
  const out: Record<string, SeriesPoint[]> = {};
  for (const name of names) {
    const seg = segments(runs, name, o);
    out[name] = runs.map((r, i) => {
      const p = comparisonsOf(r, o)?.find((x) => (x.a === name && x.b === reference) || (x.a === reference && x.b === name));
      if (!p) return { date: r.date, run: r.id, value: null, n: 0, segment: seg[i]! };
      const flip = p.a === reference;
      return { date: r.date, run: r.id, value: flip ? -p.diff.mean : p.diff.mean, lo: flip ? -p.diff.hi : p.diff.lo, hi: flip ? -p.diff.lo : p.diff.hi, n: p.paired, segment: seg[i]! };
    });
  }
  return out;
}
