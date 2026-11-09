// Sequential (continual) comparisons, `compare --sequential` (R2-10). A plain
// comparison runs every (task, arm, attempt) in a fresh overlay, so a harness
// that learns between tasks (Claude Code auto-memory, Letta memory, Prime's
// continual harness) looks the same with learning on or off. Here each arm
// runs the tasks in a fixed order, one stream per attempt, and the harness
// state named by `carry` (paths in the run's HOME) is copied from each run to
// the next in the same arm and stream. The report adds a learning curve: pass
// rate by position, per arm, and the gain from the first third to the last.
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask, RunResult } from "../core/types.ts";
import { mulberry32 } from "../stats/prng.ts";
import { safeJoin } from "./fsutil.ts";
import { rmrf } from "./git.ts";

export interface SequenceOpts {
  /** Paths in the agent's HOME to carry from one task to the next ("~/.prime", ".claude/CLAUDE.md"); "~" carries the whole HOME. */
  carry: string[];
  /** "fixed" (default): every stream runs the tasks in the given order. "seeded": stream s runs a shuffle seeded with seed + s. */
  order?: "fixed" | "seeded";
  seed?: number;
}

/** Where one run's carried state comes from and goes to. */
export interface CarryOpts {
  paths: string[];
  /** The stream's state dir: it mirrors HOME for the carried paths. */
  dir: string;
}

/** A carry path relative to HOME: "" for the whole HOME. Throws on absolute or escaping paths. */
export function carryRel(p: string): string {
  const t = p.trim().replace(/\\/g, "/");
  const rel = t === "~" ? "" : t.startsWith("~/") ? t.slice(2) : t;
  const clean = rel.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (clean === "" || clean === ".") return "";
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.split("/").includes("..")) throw new Error(`carry path ${JSON.stringify(p)} must stay inside HOME`);
  return clean;
}

async function copyRel(fromRoot: string, toRoot: string, rel: string): Promise<void> {
  const from = rel ? safeJoin(fromRoot, rel) : fromRoot;
  if (!existsSync(from)) return;
  const to = rel ? safeJoin(toRoot, rel) : toRoot;
  await mkdir(toRoot, { recursive: true });
  await cp(from, to, { recursive: true, force: true, verbatimSymlinks: true, preserveTimestamps: true });
}

/** Before the agent: the state the previous run left, into this run's HOME. */
export async function carryIn(c: CarryOpts, home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  for (const p of c.paths) await copyRel(c.dir, home, carryRel(p));
}

/** After the agent: this run's state replaces the stream's. */
export async function carryOut(c: CarryOpts, home: string): Promise<void> {
  for (const p of c.paths) {
    const rel = carryRel(p);
    await rmrf(rel ? safeJoin(c.dir, rel) : c.dir);
    await copyRel(home, c.dir, rel);
  }
}

/** The task order of each stream (1-based stream s at index s − 1). */
export function streamOrders(tasks: readonly EvalTask[], streams: number, o: Pick<SequenceOpts, "order" | "seed"> = {}): EvalTask[][] {
  const out: EvalTask[][] = [];
  for (let s = 1; s <= streams; s++) {
    if (o.order !== "seeded") {
      out.push([...tasks]);
      continue;
    }
    const rand = mulberry32((o.seed ?? 0) + s);
    const t = [...tasks];
    for (let i = t.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [t[i], t[j]] = [t[j] as EvalTask, t[i] as EvalTask];
    }
    out.push(t);
  }
  return out;
}

/** The state dir of one arm's stream. */
export function streamDir(root: string, bundleId: string, stream: number): string {
  return join(root, bundleId.slice(0, 16), String(stream));
}

export interface StepRate {
  step: number;
  passes: number;
  runs: number;
  rate: number;
}

export interface ArmLearning {
  /** Pass rate at each position, over the streams. */
  steps: StepRate[];
  /** The first and last third of the positions (at least one position each). */
  first: Omit<StepRate, "step">;
  last: Omit<StepRate, "step">;
  /** last.rate − first.rate. */
  gain: number;
}

export interface LearningReport {
  baseline?: ArmLearning;
  candidate?: ArmLearning;
  /** Positions per third. */
  third: number;
  /** Candidate gain − baseline gain, when both arms ran in sequence. */
  diff?: number;
}

const rate = (passes: number, runs: number) => ({ passes, runs, rate: runs ? passes / runs : NaN });

/** One arm's learning curve from its sequential runs; undefined when none ran in sequence. */
export function armLearning(runs: readonly RunResult[]): ArmLearning | undefined {
  const seq = runs.filter((r) => r.sequence);
  if (!seq.length) return undefined;
  const n = Math.max(...seq.map((r) => r.sequence!.step));
  const steps: StepRate[] = [];
  for (let s = 1; s <= n; s++) {
    const at = seq.filter((r) => r.sequence!.step === s);
    steps.push({ step: s, ...rate(at.filter((r) => r.pass).length, at.length) });
  }
  const third = Math.max(1, Math.floor(n / 3));
  const sum = (xs: StepRate[]) => rate(xs.reduce((a, x) => a + x.passes, 0), xs.reduce((a, x) => a + x.runs, 0));
  const first = sum(steps.slice(0, third));
  const last = sum(steps.slice(n - third));
  return { steps, first, last, gain: last.rate - first.rate };
}

/** The learning section of a comparison; undefined unless some run carries a sequence position. */
export function learningReport(A: readonly RunResult[], B: readonly RunResult[]): LearningReport | undefined {
  const a = armLearning(A);
  const b = armLearning(B);
  if (!a && !b) return undefined;
  const n = Math.max(a?.steps.length ?? 0, b?.steps.length ?? 0);
  return {
    ...(a ? { baseline: a } : {}),
    ...(b ? { candidate: b } : {}),
    third: Math.max(1, Math.floor(n / 3)),
    ...(a && b && Number.isFinite(a.gain) && Number.isFinite(b.gain) ? { diff: b.gain - a.gain } : {}),
  };
}
