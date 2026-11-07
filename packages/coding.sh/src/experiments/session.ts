// Experiment sessions (X-12): runs in one working directory join one timeline,
// and each run is compared with the previous run on the same dataset as it
// finishes, so the delta is printed without an `exp compare`. Notes record the
// hypothesis before a run and the reading after it.
//
//   <dir>/.coding-sh/session.json          {id, name, createdAt}; found by walking up from cwd
//   <dir>/.coding-sh/.gitignore            "*"
//   <store root>/exp-sessions/<id>.jsonl   the timeline: experiment, note and command blocks
//
// CODING_SH_EXP_SESSION=<id> picks a session without a session.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sortableId } from "../core/ids.ts";
import type { ExperimentResult } from "../datasets/types.ts";
import { compareExperiments } from "./compare.ts";

export const SESSION_ENV = "CODING_SH_EXP_SESSION";
export const SESSION_DIR = ".coding-sh";
/** Flips listed each way in a delta. */
export const DELTA_FLIPS = 5;

export interface ExpSession {
  id: string;
  name?: string;
  createdAt?: number;
  /** The session.json it came from (absent when picked by CODING_SH_EXP_SESSION). */
  file?: string;
}

/** A run compared with the previous run on the same dataset in the session. */
export interface SessionDelta {
  /** The previous experiment. */
  vs: string;
  /** False when the two ran on different dataset versions (or the previous one is gone). */
  paired: boolean;
  reason?: string;
  before?: number;
  after?: number;
  /** B − A pass rate with the 95% paired bootstrap CI, as `exp compare` prints it. */
  diff?: { mean: number; lo: number; hi: number };
  pairedCases?: number;
  /** Exact McNemar p on per-case outcomes. */
  p?: number;
  verdict?: "better" | "worse" | "inconclusive";
  /** Mean score difference per grader, with its CI. */
  graders?: { id: string; diff: { mean: number; lo: number; hi: number } }[];
  /** Cases that went from fail to pass (first DELTA_FLIPS) and how many in all. */
  fixed?: string[];
  fixedCount?: number;
  broke?: string[];
  brokeCount?: number;
}

export interface ExperimentBlock {
  kind: "experiment";
  at: number;
  expId: string;
  name: string;
  mode: "run" | "regrade";
  regradeOf?: string;
  dataset: { id: string; version: string };
  /** Hash of the spec the run used (task, graders, dataset, split, trials). */
  specHash?: string;
  /** Watched file → content hash. */
  files?: Record<string, string>;
  /** Files whose content differs from the previous experiment block's. */
  changed?: string[];
  passRate: { p: number; lo: number; hi: number };
  passed: number;
  n: number;
  ungraded: number;
  delta?: SessionDelta;
}

export interface NoteBlock {
  kind: "note";
  at: number;
  text: string;
}

export interface CommandBlock {
  kind: "command";
  at: number;
  command: string;
}

export type SessionBlock = ExperimentBlock | NoteBlock | CommandBlock;

/** The session for `cwd`: CODING_SH_EXP_SESSION first, then the nearest .coding-sh/session.json above it. */
export function findSession(o: { cwd: string; env?: NodeJS.ProcessEnv }): ExpSession | undefined {
  const fromEnv = o.env?.[SESSION_ENV]?.trim();
  if (fromEnv) return { id: fromEnv };
  for (let dir = resolve(o.cwd); ; dir = dirname(dir)) {
    const file = join(dir, SESSION_DIR, "session.json");
    if (existsSync(file)) {
      try {
        const v = JSON.parse(readFileSync(file, "utf8")) as Partial<ExpSession>;
        if (typeof v.id === "string" && v.id) return { id: v.id, ...(typeof v.name === "string" ? { name: v.name } : {}), ...(typeof v.createdAt === "number" ? { createdAt: v.createdAt } : {}), file };
      } catch {
        // unreadable: keep walking up
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Start a session in `cwd` (replacing one there) and keep its folder out of git. */
export function newSession(o: { cwd: string; name?: string; now?: number }): ExpSession {
  const dir = join(resolve(o.cwd), SESSION_DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  const s: ExpSession = { id: sortableId("xs_"), ...(o.name ? { name: o.name } : {}), createdAt: o.now ?? Date.now() };
  const file = join(dir, "session.json");
  writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
  return { ...s, file };
}

const SAFE_ID = /^[\w.-]{1,128}$/;

export function timelinePath(storeRoot: string, id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`invalid session id ${JSON.stringify(id)}`);
  return join(storeRoot, "exp-sessions", `${id}.jsonl`);
}

export async function appendBlock(storeRoot: string, id: string, block: SessionBlock): Promise<void> {
  const file = timelinePath(storeRoot, id);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(block)}\n`);
}

/** The timeline, oldest first; unreadable lines are skipped. Empty for an unknown session. */
export async function readTimeline(storeRoot: string, id: string): Promise<SessionBlock[]> {
  let text: string;
  try {
    text = await readFile(timelinePath(storeRoot, id), "utf8");
  } catch {
    return [];
  }
  const out: SessionBlock[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const b = JSON.parse(line) as SessionBlock;
      if (b && typeof b === "object" && (b.kind === "experiment" || b.kind === "note" || b.kind === "command")) out.push(b);
    } catch {
      // a torn last line: skip it
    }
  }
  return out;
}

/** The last experiment block on this dataset, if any. */
export function previousOnDataset(blocks: readonly SessionBlock[], datasetId: string): ExperimentBlock | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "experiment" && b.dataset.id === datasetId) return b;
  }
  return undefined;
}

const r4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x);
const ci = (d: { mean: number; lo: number; hi: number }) => ({ mean: r4(d.mean), lo: r4(d.lo), hi: r4(d.hi) });

/**
 * `cur` against the previous run `prev` (or its id when it can't be loaded):
 * the same numbers `exp compare prev cur` prints. Different dataset versions
 * are not paired.
 */
export function sessionDelta(prev: ExperimentResult | string, cur: ExperimentResult): SessionDelta {
  if (typeof prev === "string") return { vs: prev, paired: false, reason: `previous experiment ${prev} is not in the store` };
  if (prev.dataset.version !== cur.dataset.version) {
    return { vs: prev.id, paired: false, reason: `dataset ${cur.dataset.id} changed version (${prev.dataset.version} → ${cur.dataset.version})` };
  }
  const c = compareExperiments(prev, cur, { force: true });
  return {
    vs: prev.id,
    paired: true,
    before: r4(c.a.passRate),
    after: r4(c.b.passRate),
    diff: ci(c.diff),
    pairedCases: c.paired,
    p: r4(c.mcnemar.p),
    verdict: c.verdict,
    graders: c.graders.map((g) => ({ id: g.id, diff: ci(g.diff) })),
    fixed: c.improvements.slice(0, DELTA_FLIPS).map((x) => x.caseId),
    fixedCount: c.improvements.length,
    broke: c.regressions.slice(0, DELTA_FLIPS).map((x) => x.caseId),
    brokeCount: c.regressions.length,
  };
}

/** The block `exp run` appends for a finished experiment. */
export function experimentBlock(
  r: ExperimentResult,
  o: { at?: number; specHash?: string; files?: Record<string, string>; previous?: ExperimentBlock; delta?: SessionDelta },
): ExperimentBlock {
  const regradeOf = typeof r.metadata?.regradeOf === "string" ? r.metadata.regradeOf : undefined;
  const prevFiles = o.previous?.files;
  const changed = o.files && prevFiles ? Object.keys({ ...prevFiles, ...o.files }).filter((k) => prevFiles[k] !== o.files![k]).sort() : undefined;
  return {
    kind: "experiment",
    at: o.at ?? Date.now(),
    expId: r.id,
    name: r.name,
    mode: regradeOf ? "regrade" : "run",
    ...(regradeOf ? { regradeOf } : {}),
    dataset: { id: r.dataset.id, version: r.dataset.version },
    ...(o.specHash ? { specHash: o.specHash } : {}),
    ...(o.files ? { files: o.files } : {}),
    ...(changed ? { changed } : {}),
    passRate: { p: r4(r.summary.passRate.p), lo: r4(r.summary.passRate.lo), hi: r4(r.summary.passRate.hi) },
    passed: r.summary.passed,
    n: r.summary.n,
    ungraded: r.summary.ungraded ?? 0,
    ...(o.delta ? { delta: o.delta } : {}),
  };
}

/**
 * Record a finished experiment in the session: compare it with the previous
 * run on the same dataset (loaded through `load`), append the block and return it.
 */
export async function recordExperiment(
  storeRoot: string,
  session: Pick<ExpSession, "id">,
  r: ExperimentResult,
  o: { load: (id: string) => Promise<ExperimentResult | undefined>; specHash?: string; files?: Record<string, string>; now?: number },
): Promise<ExperimentBlock> {
  const blocks = await readTimeline(storeRoot, session.id);
  const previous = previousOnDataset(blocks, r.dataset.id);
  let delta: SessionDelta | undefined;
  if (previous && previous.expId !== r.id) {
    const prev = await o.load(previous.expId).catch(() => undefined);
    delta = sessionDelta(prev ?? previous.expId, r);
  }
  const block = experimentBlock(r, { ...(o.now !== undefined ? { at: o.now } : {}), ...(o.specHash ? { specHash: o.specHash } : {}), ...(o.files ? { files: o.files } : {}), ...(previous ? { previous } : {}), ...(delta ? { delta } : {}) });
  await appendBlock(storeRoot, session.id, block);
  return block;
}
