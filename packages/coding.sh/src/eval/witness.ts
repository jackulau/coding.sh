// Witness tests and replay audits of passing runs (TestJack, arXiv 2610.10619 §3.2-3.3).
//
// A witness is a test for one requirement of the instruction that the verifier does not
// check. It must pass on the reference patch k/k (confirmWitness); it is then replayed on
// every stored passing run of the task, one fresh dir per run: start → setup → the run's
// diff → the original verifier (must still pass, or the replay is not faithful) → each
// witness. A run a confirmed witness fails is refuted: it passed the verifier without
// doing what the instruction asked. No model calls.
//
// Two guards the paper leaves out: a failing witness is re-run and counts only after
// `confirmRuns` consecutive fails (a fail then a pass is flaky, not a refutation), and a
// witness refuting more than half the passing runs across all arms is `ambiguous`: the
// instruction probably doesn't state the requirement clearly (TestJack §A.2), so its
// refutations are listed but not counted unless asked.
import { withAbortSignal } from "../core/children.ts";
import { sha256Hex } from "../core/ids.ts";
import type { BlobRef, BlobStore, EvalTask, RunResult } from "../core/types.ts";
import { mapPool } from "../judge/limit.ts";
import { commandEnv, sh } from "../runner/exec.ts";
import { safeWrite, writeHiddenFiles } from "../runner/fsutil.ts";
import { snapshotOps, type SnapshotOps } from "../runner/git.ts";
import { execTail, runVerifier, taskWorlds, type TaskWorlds } from "./validate.ts";

export type WitnessSource = "manual" | "task-analysis" | "trial-audit";

export interface Witness {
  /** sha256 over path, content and command. */
  id: string;
  /** Repo-relative path the test file is written to. */
  path: string;
  blob: BlobRef;
  /** Runs the witness from the repo root; exit 0 = the requirement holds. */
  command: string;
  /** The requirement it checks, in the instruction's words. */
  requirement: string;
  /** The instruction text it comes from. */
  quote?: string;
  source: WitnessSource;
  /** The run it was written against (trial audits). */
  fromRunId?: string;
  /** Only confirmed witnesses refute runs. */
  status: "confirmed" | "questionable";
  createdAt: number;
}

export function witnessId(path: string, content: Uint8Array | string, command: string): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return sha256Hex(`${path}\0${sha256Hex(bytes)}\0${command}`);
}

const isWitness = (x: unknown): x is Witness =>
  !!x && typeof x === "object" && typeof (x as Witness).id === "string" && typeof (x as Witness).path === "string" && typeof (x as Witness).blob === "string" && typeof (x as Witness).command === "string";

/** The task's stored witnesses (`meta.witnesses`), malformed entries skipped. */
export function taskWitnesses(task: EvalTask): Witness[] {
  const ws = task.meta?.witnesses;
  return Array.isArray(ws) ? ws.filter(isWitness) : [];
}

/** The task with `ws` added to `meta.witnesses` (same id: replaced). */
export function withWitnesses(task: EvalTask, ws: Witness[]): EvalTask {
  const ids = new Set(ws.map((w) => w.id));
  return { ...task, meta: { ...(task.meta ?? {}), witnesses: [...taskWitnesses(task).filter((w) => !ids.has(w.id)), ...ws] } };
}

interface WorldOpts {
  task: EvalTask;
  blobs: BlobStore;
  /** Parent dir for per-step temp dirs. */
  workRoot: string;
  git?: SnapshotOps;
  /** Extra env for setup, verifier and witness commands. */
  env?: Record<string, string>;
  setupTimeoutMs?: number;
  keep?: boolean;
  signal?: AbortSignal;
}

async function worlds(o: WorldOpts): Promise<{ w: TaskWorlds; env: Record<string, string | undefined> }> {
  const env = commandEnv(o.env);
  const w = taskWorlds({ task: o.task, workRoot: o.workRoot, ops: await snapshotOps(o.git), env, setupTimeoutMs: o.setupTimeoutMs, keep: o.keep, signal: o.signal });
  return { w, env };
}

/** Hidden verifier files, then the witness file, then its command. */
async function runWitness(dir: string, task: EvalTask, witness: Witness, blobs: BlobStore, env: Record<string, string | undefined>) {
  const data = await blobs.get(witness.blob);
  if (!data) throw new Error(`witness ${witness.path}: blob ${witness.blob} not found`);
  await writeHiddenFiles(dir, task.verifier.hiddenFiles, blobs);
  await safeWrite(dir, witness.path, data);
  const r = await sh(witness.command, { cwd: dir, env, timeoutMs: task.verifier.timeoutMs });
  return { pass: r.exitCode === 0 && !r.timedOut, tail: execTail(r, 1000) };
}

export interface ConfirmWitnessOpts extends WorldOpts {
  witness: Witness;
  /** The reference must pass the witness k/k. Default 3. */
  k?: number;
}

export interface ConfirmWitnessResult {
  ok: boolean;
  refPassed: number;
  k: number;
  /** The witness fails the untouched start (info: a witness the no-op passes checks nothing new). */
  noopFails: boolean;
  /** Why it was rejected. */
  error?: string;
  /** Output of the last failing reference run. */
  tail: string;
}

/**
 * Reference world: start → reference patch → setup → hidden files + witness → its command
 * k times; all must pass. Then the no-op world once, for information.
 */
export async function confirmWitness(opts: ConfirmWitnessOpts): Promise<ConfirmWitnessResult> {
  return withAbortSignal(opts.signal, async () => {
    const { task, witness, blobs } = opts;
    const k = Math.max(1, opts.k ?? 3);
    const res: ConfirmWitnessResult = { ok: false, refPassed: 0, k, noopFails: false, tail: "" };
    if (witness.path in task.verifier.hiddenFiles) return { ...res, error: `${witness.path} is a hidden verifier file; give the witness its own path` };
    if (!task.referencePatch) return { ...res, error: "task has no reference patch to confirm the witness against" };
    const refPatch = await blobs.getText(task.referencePatch);
    if (refPatch === undefined) return { ...res, error: `reference patch: blob ${task.referencePatch} not found` };
    const { w, env } = await worlds(opts);
    const p = await w.prepare("witness-reference", refPatch);
    try {
      if (!p.applied || !p.setup.ok) return { ...res, error: `reference: ${p.setup.error ?? "setup failed"}`, tail: p.setup.out };
      for (let i = 0; i < k; i++) {
        const r = await runWitness(p.dir, task, witness, blobs, env);
        if (r.pass) res.refPassed++;
        else res.tail = r.tail;
      }
    } finally {
      await w.cleanup(p.dir);
    }
    if (res.refPassed < k) {
      return { ...res, error: `fails on the reference (${res.refPassed}/${k}): it asserts something the reference does not do` };
    }
    const q = await w.prepare("witness-noop");
    try {
      res.noopFails = !q.setup.ok || !(await runWitness(q.dir, task, witness, blobs, env)).pass;
    } finally {
      await w.cleanup(q.dir);
    }
    return { ...res, ok: true };
  });
}

export type AuditRunStatus = "clean" | "refuted" | "unreplayable" | "replay-mismatch";

export interface AuditRun {
  runId: string;
  bundleId: string;
  status: AuditRunStatus;
  /** The first witness that refuted it. */
  witnessId?: string;
  /** Every witness that refuted it. */
  refutedBy?: string[];
  /** False when only ambiguous witnesses refuted it (and countAmbiguous is off). */
  countsAsRefuted?: boolean;
  /** Witness failure, patch error or verifier output. */
  tail?: string;
  /** e.g. 'flaky witness <id>: failed, then passed'. */
  notes?: string[];
}

export interface AuditReport {
  taskId: string;
  experimentId?: string;
  method: "manual";
  /** Ids of the witnesses replayed (the witness set). */
  witnesses: string[];
  /** One per replayed passing run. */
  runs: AuditRun[];
  /** Witnesses refuting more than half the replayed passing runs. */
  ambiguous: { witnessId: string; refuted: number; of: number; note: string }[];
  countAmbiguous?: boolean;
  ts: number;
}

export interface ReplayWitnessesOpts extends WorldOpts {
  runs: readonly RunResult[];
  witnesses: readonly Witness[];
  experimentId?: string;
  /** Runs replayed at once. Default 2. */
  concurrency?: number;
  /** Consecutive witness fails before a run counts as refuted. Default 2. */
  confirmRuns?: number;
  /** Count refutations by ambiguous witnesses too. */
  countAmbiguous?: boolean;
  onRun?: (r: AuditRun) => void;
}

/** Runs worth replaying: passing, finished, the attempt that counts, with a diff. */
export function replayable(r: RunResult): boolean {
  return r.pass && !r.cancelled && !r.superseded && !r.infra && !!r.diffBlob;
}

export async function replayWitnesses(opts: ReplayWitnessesOpts): Promise<AuditReport> {
  return withAbortSignal(opts.signal, async () => {
    const { task, blobs } = opts;
    const witnesses = opts.witnesses.filter((x) => x.status === "confirmed");
    const confirmRuns = Math.max(1, opts.confirmRuns ?? 2);
    const { w, env } = await worlds(opts);
    const replayOne = async (run: RunResult): Promise<AuditRun> => {
      const base = { runId: run.id, bundleId: run.bundleId };
      const patch = await blobs.getText(run.diffBlob as BlobRef);
      if (patch === undefined) return { ...base, status: "unreplayable", tail: `diff blob ${run.diffBlob} not found` };
      const p = await w.prepare("replay", patch, { afterSetup: true });
      try {
        if (!p.setup.ok) return { ...base, status: "unreplayable", tail: p.setup.error ?? "setup failed" };
        if (!p.applied) return { ...base, status: "unreplayable", tail: p.setup.error ?? "the run's diff did not apply" };
        const v = await runVerifier(p.dir, task, blobs, env);
        if (v.exitCode !== 0 || v.timedOut) return { ...base, status: "replay-mismatch", tail: `the verifier fails on replay, so the replay is not the run: ${execTail(v, 1000)}` };
        const refutedBy: string[] = [];
        const notes: string[] = [];
        let tail: string | undefined;
        for (const wit of witnesses) {
          let fails = 0;
          let last = "";
          while (fails < confirmRuns) {
            const r = await runWitness(p.dir, task, wit, blobs, env);
            if (r.pass) break;
            fails++;
            last = r.tail;
          }
          if (fails >= confirmRuns) {
            refutedBy.push(wit.id);
            tail ??= last;
          } else if (fails > 0) notes.push(`flaky witness ${wit.path}: failed, then passed`);
        }
        return {
          ...base,
          status: refutedBy.length ? "refuted" : "clean",
          ...(refutedBy.length ? { witnessId: refutedBy[0], refutedBy, tail } : {}),
          ...(notes.length ? { notes } : {}),
        };
      } finally {
        await w.cleanup(p.dir);
      }
    };
    const runs = await mapPool(opts.runs.filter(replayable), Math.max(1, opts.concurrency ?? 2), async (r) => {
      const out = await replayOne(r);
      opts.onRun?.(out);
      return out;
    });
    // Underspecification guard: over half the replayed passes refuted by one witness.
    const replayed = runs.filter((r) => r.status === "clean" || r.status === "refuted");
    const ambiguous: AuditReport["ambiguous"] = [];
    for (const wit of witnesses) {
      const refuted = replayed.filter((r) => r.refutedBy?.includes(wit.id)).length;
      if (refuted * 2 > replayed.length) {
        ambiguous.push({ witnessId: wit.id, refuted, of: replayed.length, note: `refutes ${refuted} of ${replayed.length} passing runs: check the instruction actually states this` });
      }
    }
    const amb = new Set(ambiguous.map((a) => a.witnessId));
    for (const r of runs) if (r.refutedBy) r.countsAsRefuted = !!opts.countAmbiguous || r.refutedBy.some((id) => !amb.has(id));
    return {
      taskId: task.id,
      ...(opts.experimentId ? { experimentId: opts.experimentId } : {}),
      method: "manual",
      witnesses: witnesses.map((x) => x.id),
      runs,
      ambiguous,
      ...(opts.countAmbiguous ? { countAmbiguous: true } : {}),
      ts: Date.now(),
    };
  });
}

/** A run's audit outcome: refuted only when a counted witness refuted it. */
export function auditOutcome(r: AuditRun): AuditRunStatus {
  return r.status === "refuted" && r.countsAsRefuted === false ? "clean" : r.status;
}

/** Each audited run's outcome across reports (ambiguous-only refutations count as clean), for compare. */
export function auditStatuses(reports: readonly AuditReport[]): Map<string, AuditRunStatus> {
  return new Map(reports.flatMap((rep) => rep.runs.map((r) => [r.runId, auditOutcome(r)] as const)));
}

/** `task.meta.audits[experimentId]`, when it is a report. */
export function taskAudit(task: EvalTask, experimentId: string): AuditReport | undefined {
  const a = (task.meta?.audits as Record<string, unknown> | undefined)?.[experimentId] as AuditReport | undefined;
  return a && typeof a === "object" && Array.isArray(a.runs) && Array.isArray(a.witnesses) ? a : undefined;
}

/** The task with `report` stored under `meta.audits[experimentId]`. */
export function withAudit(task: EvalTask, experimentId: string, report: AuditReport): EvalTask {
  const audits = (task.meta?.audits as Record<string, unknown> | undefined) ?? {};
  return { ...task, meta: { ...(task.meta ?? {}), audits: { ...audits, [experimentId]: report } } };
}

/**
 * Make witnesses part of the verifier: their files become hidden files and their commands
 * run after the verifier's. The task needs validating again, and runs before this used
 * the old verifier.
 */
export function promoteWitnesses(task: EvalTask, ids: readonly string[]): { task: EvalTask; notes: string[] } {
  const ws = taskWitnesses(task).filter((x) => ids.includes(x.id) && x.status === "confirmed" && !(x.path in task.verifier.hiddenFiles));
  if (!ws.length) return { task, notes: ["no confirmed witness to promote"] };
  const command = [task.verifier.command, ...ws.map((x) => x.command)].filter((c) => c.trim()).join(" && ");
  const hiddenFiles = { ...task.verifier.hiddenFiles, ...Object.fromEntries(ws.map((x) => [x.path, x.blob])) };
  const { validation: _old, ...rest } = task;
  const promoted: EvalTask = { ...rest, verifier: { ...task.verifier, command, hiddenFiles }, status: task.status === "archived" ? "archived" : "draft" };
  return {
    task: promoted,
    notes: [`added ${ws.map((x) => x.path).join(", ")} to the verifier; validate the task again (runs before this used the old verifier)`],
  };
}

export interface AuditArm {
  bundleId: string;
  /** Finished runs that count (not cancelled, superseded or lost to infrastructure). */
  runs: number;
  passes: number;
  /** Passing runs replayed: clean or refuted. */
  replayed: number;
  refuted: number;
  unreplayable: number;
  replayMismatch: number;
  /** passes − refuted. */
  auditedPasses: number;
}

/** Per bundle counts for a report over the experiment's runs, in first-seen order. */
export function auditArms(report: AuditReport, runs: readonly RunResult[]): AuditArm[] {
  const byRun = new Map(report.runs.map((r) => [r.runId, r]));
  const arms = new Map<string, AuditArm>();
  for (const r of runs) {
    if (r.cancelled || r.superseded || r.infra || r.taskId !== report.taskId) continue;
    let a = arms.get(r.bundleId);
    if (!a) arms.set(r.bundleId, (a = { bundleId: r.bundleId, runs: 0, passes: 0, replayed: 0, refuted: 0, unreplayable: 0, replayMismatch: 0, auditedPasses: 0 }));
    a.runs++;
    if (!r.pass) continue;
    a.passes++;
    const x = byRun.get(r.id);
    const s = x ? auditOutcome(x) : undefined;
    if (s === "clean" || s === "refuted") a.replayed++;
    if (s === "refuted") a.refuted++;
    if (s === "unreplayable") a.unreplayable++;
    if (s === "replay-mismatch") a.replayMismatch++;
  }
  for (const a of arms.values()) a.auditedPasses = a.passes - a.refuted;
  return [...arms.values()];
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

/** Text report: per arm counts, then each refutation with its requirement and failure. */
export function formatAudit(report: AuditReport, runs: readonly RunResult[], witnesses: readonly Witness[], names: (bundleId: string) => string = (b) => b.slice(0, 8)): string {
  const byId = new Map(witnesses.map((x) => [x.id, x]));
  const out: string[] = [];
  for (const a of auditArms(report, runs)) {
    const extra = [a.unreplayable ? `unreplayable ${a.unreplayable}` : "", a.replayMismatch ? `replay mismatch ${a.replayMismatch}` : ""].filter(Boolean).join(", ");
    out.push(
      `${names(a.bundleId)}: passes ${a.passes}/${a.runs}, refuted ${a.refuted}${extra ? `, ${extra}` : ""}, audited pass rate ${pct(a.auditedPasses, a.runs)} (${a.auditedPasses}/${a.runs}), replayed ${a.replayed}/${a.passes}`,
    );
  }
  for (const r of report.runs) {
    if (r.status === "refuted") {
      const wit = byId.get(r.witnessId ?? "");
      const last = (r.tail ?? "").split("\n").filter(Boolean).slice(-3).join(" | ");
      const why = r.countsAsRefuted === false ? " (ambiguous witness, not counted)" : "";
      out.push(`refuted ${r.runId} (${names(r.bundleId)}) by ${wit?.path ?? r.witnessId}${why}: ${wit?.requirement ?? ""}${last ? `\n  ${last}` : ""}`);
    } else if (r.status !== "clean") out.push(`${r.status} ${r.runId} (${names(r.bundleId)}): ${(r.tail ?? "").split("\n")[0]}`);
    for (const n of r.notes ?? []) out.push(`note: ${r.runId}: ${n}`);
  }
  for (const a of report.ambiguous) out.push(`ambiguous: ${byId.get(a.witnessId)?.path ?? a.witnessId} ${a.note}${!report.countAmbiguous ? " (not counted; --count-ambiguous counts it)" : ""}`);
  return out.join("\n");
}
