// Verifier validation: a task is only trustworthy if its verifier
//   (a) fails when the agent does nothing,
//   (b) passes the reference solution k/k (flaky tests fail this),
//   (c) fails plausible-but-incomplete solutions (near-misses),
//   (d) nothing leaks the answer to the agent,
//   (e) fails the reference on an impossible variant (tests flipped to contradict
//       the instruction); passing it means the verifier is gameable,
//   (f) the reference keeps the repo's pre-existing tests passing (pass-to-pass),
//   (g) and no hidden test names an identifier or file only the reference introduces
//       (gold-only coupling, src/eval/coupling.ts); non-blocking unless strictCoupling.
// Every step runs in its own freshly materialized dir; hidden verifier files
// are copied in only right before the verifier runs.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeOnExit, withAbortSignal } from "../core/children.ts";
import { sha256Hex } from "../core/ids.ts";
import type { BlobRef, BlobStore, EvalTask, IndexStore, ValidationReport } from "../core/types.ts";
import { commandEnv, sh, type ExecResult } from "../runner/exec.ts";
import { safeJoin, safeWrite, writeHiddenFiles } from "../runner/fsutil.ts";
import { applyPatch, git, rmrf, snapshotOps, type SnapshotOps } from "../runner/git.ts";
import { couplingNote, goldCandidates, goldOnlyCoupling, startTreeLookup, type Coupling, type StartTree } from "./coupling.ts";
import { impossibleMutations, isTestPath, readTextFiles, verifierReferencedFiles, type ImpossibleMutation, type TestFileText } from "./impossible.ts";
import { blockOverlap } from "./leakage.ts";
import { addedBlocks, addedLines, nearMissMutations, patchPaths } from "./patch.ts";
import { nearMissRuns, referenceRun, type RecordedRun } from "./task.ts";
import { comparePassToPass, detectSuiteCommand } from "./suite.ts";

export type StepKind = "noop" | "reference" | "near-miss" | "impossible" | "pass-to-pass";

export interface StepResult {
  kind: StepKind;
  label: string;
  attempt?: number;
  /** Patch applied cleanly (always true for noop). */
  applied: boolean;
  setupOk: boolean;
  /** Verifier ran and exited 0. */
  pass: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
  error?: string;
}

export interface NearMissInput {
  label: string;
  patch: string;
  /** A recorded run: its answer and stdout go to the verifier. */
  run?: RecordedRun;
}

export interface ValidateOpts {
  task: EvalTask;
  blobs: BlobStore;
  /** Parent dir for per-step temp dirs. */
  workRoot: string;
  /** Reference must pass k out of k. Default 5. */
  k?: number;
  /** Explicit near-miss patches (text). Added to task.nearMissPatches; when neither exists, mutations are generated. */
  nearMisses?: (string | NearMissInput)[];
  /** Cap on auto-generated near-misses (default 10). */
  maxNearMisses?: number;
  /**
   * Impossible-variant check (default on). `max` caps the variants tried (default 3): the
   * verifier is flagged gameable only when the reference passes every one of them.
   */
  impossible?: boolean | { max?: number };
  /**
   * Pass-to-pass check. Default: the command in `task.meta.suiteCommand`, else one detected
   * from the start tree (package.json test script, pytest, go, cargo). `false` disables it;
   * a string (or `{command}`) names the suite command.
   */
  passToPass?: boolean | string | { command: string; timeoutMs?: number };
  /** n-gram size and overlap fraction for the instruction-vs-patch leakage check. */
  leakage?: { ngram?: number; threshold?: number };
  /** Gold-only coupling blocks validation (default: reported as notes only). */
  strictCoupling?: boolean;
  setupTimeoutMs?: number;
  /** Extra env for setup + verifier. */
  env?: Record<string, string>;
  git?: SnapshotOps;
  /** When given, the updated task is written back. */
  index?: IndexStore;
  keep?: boolean;
  onStep?: (s: StepResult) => void;
  /**
   * Interrupts validation: running setup/verifier/suite commands are killed,
   * no further step starts, step dirs are still cleaned up, and validateTask
   * rejects with the abort reason without writing the task back.
   */
  signal?: AbortSignal;
}

export interface ValidationOutcome {
  report: ValidationReport;
  /** The task with `validation` set and status "validated" iff report.ok. */
  task: EvalTask;
  steps: StepResult[];
  nearMisses: { label: string; applied: boolean; passed?: boolean }[];
  /** Problems that prevented a full validation (no verifier, patch did not apply, setup failed…). */
  errors: string[];
  /** Non-fatal observations. */
  notes: string[];
}

const DEFAULT_SETUP_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SUITE_TIMEOUT_MS = 15 * 60_000;
const SUITE_OUTPUT_BYTES = 16 * 1024 * 1024;

/** The last `max` chars of a command's stdout + stderr. */
export function execTail(r: ExecResult, max = 2000): string {
  const s = `${r.stdoutTail}${r.stderrTail ? `\n${r.stderrTail}` : ""}`.trim();
  return s.length > max ? s.slice(s.length - max) : s;
}

async function runSetup(dir: string, task: EvalTask, env: Record<string, string | undefined>, timeoutMs: number): Promise<{ ok: boolean; error?: string; out: string }> {
  for (const cmd of task.setup) {
    const r = await sh(cmd, { cwd: dir, env, timeoutMs });
    if (r.exitCode !== 0) {
      return { ok: false, error: `setup \`${cmd}\` ${r.timedOut ? "timed out" : `exited ${r.exitCode}`}`, out: execTail(r) };
    }
  }
  return { ok: true, out: "" };
}

/** Copy hidden files, run the verifier. Exit 0 within the timeout = pass. */
export async function runVerifier(dir: string, task: EvalTask, blobs: BlobStore, env: Record<string, string | undefined>): Promise<ExecResult> {
  await writeHiddenFiles(dir, task.verifier.hiddenFiles, blobs);
  return sh(task.verifier.command, { cwd: dir, env, timeoutMs: task.verifier.timeoutMs });
}

/** runVerifier with one test file swapped for `override`; `restore` files are reset to their original text first. */
async function runVerifierWith(
  dir: string,
  task: EvalTask,
  blobs: BlobStore,
  env: Record<string, string | undefined>,
  override: TestFileText,
  restore: TestFileText[],
): Promise<ExecResult> {
  for (const f of restore) await safeWrite(dir, f.path, f.text);
  await writeHiddenFiles(dir, task.verifier.hiddenFiles, blobs);
  await safeWrite(dir, override.path, override.text);
  return sh(task.verifier.command, { cwd: dir, env, timeoutMs: task.verifier.timeoutMs });
}

/** Hidden verifier files as text (binary or missing blobs skipped). */
async function hiddenTexts(task: EvalTask, blobs: BlobStore): Promise<TestFileText[]> {
  const out: TestFileText[] = [];
  for (const [rel, ref] of Object.entries(task.verifier.hiddenFiles)) {
    const data = await blobs.get(ref);
    if (!data || data.length > 1024 * 1024 || data.includes(0)) continue;
    out.push({ path: rel, text: new TextDecoder().decode(data) });
  }
  return out;
}

/** Make suite output comparable across step dirs: absolute step paths become ".". */
async function relativizeOutput(text: string, dir: string): Promise<string> {
  const real = await realpath(dir).catch(() => dir);
  return [real, dir].reduce((t, d) => t.split(d).join("."), text);
}

async function textBlob(blobs: BlobStore, ref: BlobRef, what: string): Promise<string> {
  const t = await blobs.getText(ref);
  if (t === undefined) throw new Error(`${what}: blob ${ref} not found`);
  return t;
}

/** Pick a few long, distinctive added lines to search history for. */
function distinctiveLines(patch: string, max = 3): string[] {
  const seen = new Set<string>();
  return addedLines(patch)
    .map((l) => l.trim())
    // Long enough to be specific, and with real identifiers (not "});").
    .filter((l) => l.length >= 10 && /[A-Za-z_]\w*.*[A-Za-z0-9_]/.test(l) && !seen.has(l) && (seen.add(l), true))
    .sort((a, b) => b.length - a.length)
    .slice(0, max);
}

/** Leakage checks that need the start tree on disk. */
async function scanTree(dir: string, task: EvalTask, refPatch: string | undefined, notes: string[]): Promise<string[]> {
  const leaks: string[] = [];
  for (const [rel, ref] of Object.entries(task.verifier.hiddenFiles)) {
    const abs = safeJoin(dir, rel);
    if (!existsSync(abs)) continue;
    if (sha256Hex(await readFile(abs)) === ref) {
      leaks.push(`hidden verifier file ${rel} is visible to the agent: identical copy in the start tree`);
    } else {
      notes.push(`hidden file ${rel} replaces an existing start-tree file at verify time`);
    }
  }
  if (refPatch) {
    const rev = await applyPatch(dir, refPatch, { reverse: true, check: true });
    if (rev.ok) leaks.push("start tree already contains the reference patch (it reverse-applies cleanly)");
  }
  if (existsSync(join(dir, ".git"))) {
    const extra = await git(["rev-list", "--all", "--not", "HEAD"], dir);
    const n = extra.exitCode === 0 ? extra.stdoutTail.split("\n").filter(Boolean).length : 0;
    if (n > 0) leaks.push(`${n} commit(s) reachable from refs but not from HEAD: the agent could read future history (git log --all)`);
    if (refPatch) {
      for (const line of distinctiveLines(refPatch)) {
        const inTree = await git(["grep", "-q", "-F", "-e", line, "HEAD", "--"], dir);
        if (inTree.exitCode === 0) continue; // already in the start tree; history hit would be noise
        const hist = await git(["log", "--all", "--format=%h", `-S${line}`, "--"], dir);
        const commits = hist.exitCode === 0 ? hist.stdoutTail.split("\n").filter(Boolean) : [];
        if (commits.length) {
          leaks.push(`git history contains reference code (${JSON.stringify(line.slice(0, 60))} in ${commits.slice(0, 3).join(", ")})`);
          break;
        }
      }
    }
  }
  return leaks;
}

/** A fresh step dir at the task's start state: patched, set up, or why not. */
export interface StepDir {
  dir: string;
  /** The patch applied (true when there was none). */
  applied: boolean;
  setup: { ok: boolean; error?: string; out: string };
}

export interface TaskWorldsOpts {
  task: EvalTask;
  /** Parent dir for the step dirs. */
  workRoot: string;
  ops: SnapshotOps;
  env: Record<string, string | undefined>;
  setupTimeoutMs?: number;
  keep?: boolean;
  signal?: AbortSignal;
}

export interface TaskWorlds {
  /**
   * Fresh dir at the start state, then the patch and the task's setup. A reference or
   * near-miss patch is written against the start tree, so it goes before setup; a run's
   * diff was taken after setup (runTask commits setup output into its start), so
   * `afterSetup` applies it after.
   */
  prepare(label: string, patch?: string, opts?: { afterSetup?: boolean }): Promise<StepDir>;
  /** Remove a step dir (kept with `keep`). */
  cleanup(dir: string): Promise<void>;
}

/** Step dirs for validation and witness replays; each is removed by an exit hook if a hard exit skips cleanup(). */
export function taskWorlds(o: TaskWorldsOpts): TaskWorlds {
  const { task, ops, env } = o;
  const setupTimeout = o.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  const checkpoint = () => o.signal?.throwIfAborted();
  const forgetOnExit = new Map<string, () => void>();
  const removeDir = async (dir: string) => {
    await rmrf(dir);
    forgetOnExit.get(dir)?.();
    forgetOnExit.delete(dir);
  };
  const setupIn = (dir: string) =>
    runSetup(dir, task, env, setupTimeout).finally(async () => {
      if (o.signal?.aborted && !o.keep) await removeDir(dir);
    });
  return {
    async prepare(label, patch, opts = {}) {
      checkpoint();
      const dir = await mkdtemp(join(o.workRoot, `${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}-`));
      if (!o.keep) forgetOnExit.set(dir, removeOnExit(dir));
      try {
        await ops.materialize({ root: task.start.repoRoot, head: task.start.head, snapshot: task.start.snapshot }, dir);
      } catch (e) {
        await removeDir(dir);
        throw e;
      }
      const apply = async (): Promise<StepDir | undefined> => {
        if (patch === undefined) return undefined;
        const a = await applyPatch(dir, patch);
        return a.ok ? undefined : { dir, applied: false, setup: { ok: false, error: `patch did not apply: ${a.error}`, out: "" } };
      };
      if (!opts.afterSetup) {
        const failed = await apply();
        if (failed) return failed;
      }
      const setup = await setupIn(dir);
      checkpoint();
      if (opts.afterSetup && setup.ok) {
        const failed = await apply();
        if (failed) return failed;
      }
      return { dir, applied: true, setup };
    },
    async cleanup(dir) {
      if (!o.keep) await removeDir(dir);
    },
  };
}

export async function validateTask(opts: ValidateOpts): Promise<ValidationOutcome> {
  // Every command spawned below is killed on abort.
  return withAbortSignal(opts.signal, () => validateTaskInner(opts));
}

async function validateTaskInner(opts: ValidateOpts): Promise<ValidationOutcome> {
  const { task, blobs } = opts;
  /** A step the abort cut short has no meaning: stop instead of recording it. */
  const checkpoint = () => opts.signal?.throwIfAborted();
  const k = Math.max(1, opts.k ?? 5);
  const ops = await snapshotOps(opts.git);
  const env = commandEnv(opts.env);
  const steps: StepResult[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  const leakage: string[] = [];
  await mkdir(opts.workRoot, { recursive: true });

  const record = (s: StepResult) => {
    steps.push(s);
    opts.onStep?.(s);
  };

  const refPatch = task.referencePatch ? await textBlob(blobs, task.referencePatch, "reference patch") : undefined;
  const refRun = referenceRun(task);
  const nmRuns = nearMissRuns(task);
  // A task graded on the agent's answer or stdout: every step gets them as files, the no-op empty ones.
  const graded = !!refRun || nmRuns.length > 0;
  const hasReference = !!refPatch || !!refRun;
  if (!task.verifier.command.trim()) errors.push("task has no verifier command");
  if (!hasReference) errors.push("task has no reference patch or reference run; cannot check that the verifier can pass");
  let runFilesN = 0;
  /** CODING_SH_AGENT_OUTPUT, _STDOUT and _DIFF for one step, as an agent run would leave them. */
  const runVars = async (run: RecordedRun | undefined, patch: string | undefined): Promise<Record<string, string>> => {
    if (!graded) return {};
    const d = join(opts.workRoot, "run-files", String(++runFilesN));
    await mkdir(d, { recursive: true });
    const vars: Record<string, string> = {};
    const files = [
      ["CODING_SH_AGENT_OUTPUT", "output.txt", run?.output],
      ["CODING_SH_AGENT_STDOUT", "stdout", run?.stdout],
    ] as const;
    for (const [name, file, ref] of files) {
      await writeFile(join(d, file), ref ? await textBlob(blobs, ref, `${run?.label ?? "run"} ${file}`) : "");
      vars[name] = join(d, file);
    }
    await writeFile(join(d, "diff.patch"), patch ?? "");
    vars.CODING_SH_AGENT_DIFF = join(d, "diff.patch");
    return vars;
  };

  const { prepare, cleanup } = taskWorlds({ task, workRoot: opts.workRoot, ops, env, setupTimeoutMs: opts.setupTimeoutMs, keep: opts.keep, signal: opts.signal });
  const verifyStep = async (
    kind: StepKind,
    label: string,
    dir: string,
    attempt?: number,
    run?: () => Promise<ExecResult>,
    vars: Record<string, string> = {},
  ): Promise<StepResult> => {
    const r = await (run ?? (() => runVerifier(dir, task, blobs, { ...env, ...vars })))();
    checkpoint();
    const s: StepResult = {
      kind,
      label,
      attempt,
      applied: true,
      setupOk: true,
      pass: r.exitCode === 0 && !r.timedOut,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      outputTail: execTail(r),
    };
    record(s);
    return s;
  };
  const failedPrep = (kind: StepKind, label: string, applied: boolean, error: string, out: string): StepResult => {
    const s: StepResult = { kind, label, applied, setupOk: false, pass: false, exitCode: null, timedOut: false, durationMs: 0, outputTail: out, error };
    record(s);
    return s;
  };

  const canVerify = task.verifier.command.trim() !== "";

  const p2pOpt = opts.passToPass ?? true;

  // (a) no-op, plus tree-level leakage checks on the untouched start state.
  let noopFails = false;
  let detectedSuite: string | undefined;
  let startTree: StartTree | undefined;
  {
    const p = await prepare("noop");
    try {
      leakage.push(...(await scanTree(p.dir, task, refPatch, notes)));
      if (refPatch) startTree = await startTreeLookup(p.dir, goldCandidates(refPatch).names.keys());
      if (p2pOpt === true) detectedSuite = await detectSuiteCommand(p.dir);
      if (!p.setup.ok) {
        errors.push(`no-op: ${p.setup.error}`);
        failedPrep("noop", "no-op", true, p.setup.error ?? "setup failed", p.setup.out);
      } else if (canVerify) {
        const s = await verifyStep("noop", "no-op", p.dir, undefined, undefined, await runVars(undefined, undefined));
        noopFails = !s.pass;
        if (s.timedOut) notes.push("no-op verifier timed out; counted as a failure, but check the verifier is not hanging");
      }
    } finally {
      await cleanup(p.dir);
    }
  }

  // (b) reference passes k/k (same dir: setup once, verifier k times).
  let refPassed = 0;
  /** Test files the reference adds or changes, as they read after it (for the coupling check). */
  let refTests: TestFileText[] = [];
  if (hasReference && canVerify) {
    const p = await prepare("reference", refPatch);
    try {
      if (p.applied && refPatch) refTests = await readTextFiles(p.dir, patchPaths(refPatch).filter(isTestPath));
      if (!p.applied || !p.setup.ok) {
        errors.push(`reference: ${p.setup.error}`);
        failedPrep("reference", "reference", p.applied, p.setup.error ?? "setup failed", p.setup.out);
      } else {
        const vars = await runVars(refRun, refPatch);
        for (let i = 1; i <= k; i++) if ((await verifyStep("reference", "reference", p.dir, i, undefined, vars)).pass) refPassed++;
        if (refPassed > 0 && refPassed < k) notes.push(`reference passed ${refPassed}/${k}: the verifier is flaky`);
      }
    } finally {
      await cleanup(p.dir);
    }
  }

  // (c) near-misses must fail.
  const candidates: NearMissInput[] = [];
  for (const [i, ref] of (task.nearMissPatches ?? []).entries()) candidates.push({ label: `near-miss #${i + 1}`, patch: await textBlob(blobs, ref, "near-miss patch") });
  for (const [i, nm] of (opts.nearMisses ?? []).entries()) candidates.push(typeof nm === "string" ? { label: `given near-miss #${i + 1}`, patch: nm } : nm);
  for (const run of nmRuns) candidates.push({ label: run.label, patch: run.patch ? await textBlob(blobs, run.patch, `${run.label} diff.patch`) : "", run });
  if (candidates.length === 0 && refPatch) {
    candidates.push(...nearMissMutations(refPatch, { max: opts.maxNearMisses ?? 10 }));
    if (candidates.length === 0) notes.push("reference patch has a single hunk: no near-misses generated; consider adding some by hand");
  }
  const nearMisses: ValidationOutcome["nearMisses"] = [];
  let nmOf = 0;
  let nmFailed = 0;
  if (canVerify) {
    for (const nm of candidates) {
      if (nm.patch.trim() === "" && !nm.run) continue;
      const p = await prepare(`near-miss`, nm.patch.trim() === "" ? undefined : nm.patch);
      try {
        if (!p.applied) {
          nearMisses.push({ label: nm.label, applied: false });
          failedPrep("near-miss", nm.label, false, p.setup.error ?? "did not apply", "");
          notes.push(`near-miss "${nm.label}" did not apply; skipped`);
          continue;
        }
        nmOf++;
        if (!p.setup.ok) {
          // The pipeline (setup → verifier) rejects it: counts as failing, but say so.
          nmFailed++;
          nearMisses.push({ label: nm.label, applied: true, passed: false });
          failedPrep("near-miss", nm.label, true, p.setup.error ?? "setup failed", p.setup.out);
          notes.push(`near-miss "${nm.label}" broke setup (counted as failing)`);
          continue;
        }
        const s = await verifyStep("near-miss", nm.label, p.dir, undefined, undefined, await runVars(nm.run, nm.patch));
        nearMisses.push({ label: nm.label, applied: true, passed: s.pass });
        if (!s.pass) nmFailed++;
      } finally {
        await cleanup(p.dir);
      }
    }
  }
  const passedNearMisses = nearMisses.filter((n) => n.passed);
  if (passedNearMisses.length) {
    notes.push(`verifier accepts incomplete solutions: ${passedNearMisses.map((n) => n.label).join("; ")}`);
  }

  // (e) impossible variants: flip one expected value in a test so no honest solution
  // can pass; the reference must fail it, or the verifier is not checking its tests.
  let impossible: ValidationReport["impossible"];
  const impOpt = opts.impossible ?? true;
  if (impOpt !== false && refPatch && canVerify && refPassed > 0) {
    const max = Math.max(1, (typeof impOpt === "object" ? impOpt.max : undefined) ?? 3);
    const refVars = await runVars(refRun, refPatch);
    const noopVars = await runVars(undefined, undefined);
    const p = await prepare("impossible", refPatch);
    try {
      if (p.applied && p.setup.ok) {
        const hidden = await hiddenTexts(task, blobs);
        const visible = await readTextFiles(p.dir, await verifierReferencedFiles(p.dir, task.verifier.command, new Set(Object.keys(task.verifier.hiddenFiles))));
        const muts = impossibleMutations([...hidden, ...visible], max);
        if (muts.length === 0) {
          notes.push("no impossible variant: no assertion with a literal to flip in the hidden or verifier-referenced test files");
        } else {
          const passedByReference: string[] = [];
          let chosen: ImpossibleMutation | undefined;
          for (const m of muts) {
            const s = await verifyStep("impossible", `impossible (reference): ${m.label}`, p.dir, undefined, () =>
              runVerifierWith(p.dir, task, blobs, { ...env, ...refVars }, { path: m.path, text: m.text }, visible),
            );
            if (!s.pass) {
              chosen = m;
              break;
            }
            passedByReference.push(m.label);
          }
          impossible = { gameable: !chosen, tried: passedByReference.length + (chosen ? 1 : 0), passedByReference };
          if (!chosen) {
            notes.push(`verifier is gameable: the reference passes ${muts.length} impossible variant(s) (${passedByReference.join("; ")}), so it does not check what its tests assert`);
          } else {
            impossible.variant = { label: chosen.label, noopFails: false };
            const q = await prepare("impossible-noop");
            try {
              if (!q.setup.ok) {
                impossible.variant.noopFails = true; // the pipeline rejects it, as for near-misses
                failedPrep("impossible", `impossible (no-op): ${chosen.label}`, true, q.setup.error ?? "setup failed", q.setup.out);
              } else {
                const s = await verifyStep("impossible", `impossible (no-op): ${chosen.label}`, q.dir, undefined, () =>
                  runVerifierWith(q.dir, task, blobs, { ...env, ...noopVars }, { path: chosen.path, text: chosen.text }, []),
                );
                impossible.variant.noopFails = !s.pass;
              }
            } finally {
              await cleanup(q.dir);
            }
            if (impossible.variant.noopFails) {
              impossible.variant.hiddenFiles = { ...task.verifier.hiddenFiles, [chosen.path]: await blobs.put(chosen.text) };
            } else {
              notes.push(`impossible variant ${chosen.label} is passed by the no-op attempt, so it is not impossible; not stored`);
            }
          }
        }
      }
    } finally {
      await cleanup(p.dir);
    }
  }

  // (f) pass-to-pass: every pre-existing test that passed before the reference must pass after it.
  let passToPass: ValidationReport["passToPass"];
  if (p2pOpt !== false && refPatch) {
    const explicit = typeof p2pOpt === "string" ? p2pOpt : typeof p2pOpt === "object" ? p2pOpt.command : undefined;
    const fromMeta = typeof task.meta?.suiteCommand === "string" ? task.meta.suiteCommand : undefined;
    const command = (explicit ?? fromMeta ?? detectedSuite)?.trim();
    const timeoutMs = (typeof p2pOpt === "object" ? p2pOpt.timeoutMs : undefined) ?? DEFAULT_SUITE_TIMEOUT_MS;
    if (!command) {
      notes.push("pass-to-pass skipped: no suite command found (set task.meta.suiteCommand or pass passToPass)");
    } else {
      // A suite run by coding.sh's own tests must not think it is a node:test child, and
      // `npm test` writes (and rotates) debug logs in a throwaway dir, not the user's ~/.npm/_logs.
      // (npm_config_logs_max=0 is not an option: npm then deletes the existing logs.)
      const npmLogs = await mkdtemp(join(opts.workRoot, "npm-logs-"));
      const suiteEnv = {
        ...env,
        NODE_TEST_CONTEXT: undefined,
        npm_config_logs_dir: env.npm_config_logs_dir ?? npmLogs,
        npm_config_update_notifier: env.npm_config_update_notifier ?? "false",
      };
      const runs: { exitCode: number | null; timedOut: boolean; output: string }[] = [];
      try {
        for (const [label, patch] of [["suite before reference", undefined], ["suite after reference", refPatch]] as const) {
          const p = await prepare(label, patch);
          try {
            if (!p.applied || !p.setup.ok) {
              failedPrep("pass-to-pass", label, p.applied, p.setup.error ?? "setup failed", p.setup.out);
              notes.push(`pass-to-pass skipped: ${label}: ${p.setup.error ?? "setup failed"}`);
              break;
            }
            const r = await sh(command, { cwd: p.dir, env: suiteEnv, timeoutMs, tailBytes: SUITE_OUTPUT_BYTES });
            checkpoint();
            record({ kind: "pass-to-pass", label, applied: true, setupOk: true, pass: r.exitCode === 0 && !r.timedOut, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, outputTail: execTail(r) });
            if (r.timedOut) notes.push(`pass-to-pass: ${label} timed out after ${timeoutMs}ms`);
            runs.push({ exitCode: r.exitCode, timedOut: r.timedOut, output: await relativizeOutput(`${r.stdoutTail}\n${r.stderrTail}`, p.dir) });
          } finally {
            await cleanup(p.dir);
          }
        }
      } finally {
        await rmrf(npmLogs);
      }
      const [before, after] = runs;
      if (before && after) {
        const c = comparePassToPass(before, after);
        passToPass = { command, passed: c.passed, of: c.of, broken: c.broken.slice(0, 100), granularity: c.granularity };
        if (c.of === 0) notes.push(`pass-to-pass: \`${command}\` passes nothing before the reference patch; nothing to compare`);
        if (c.broken.length) {
          const shown = c.broken.slice(0, 5).join("; ") + (c.broken.length > 5 ? "; …" : "");
          notes.push(`reference breaks ${c.broken.length} pre-existing test(s)${c.missing.length ? ` (${c.missing.length} no longer run)` : ""}: ${shown}`);
        }
      }
    }
  }

  // (g) gold-only coupling: tests that only a solution reusing the reference's names can pass.
  let coupling: Coupling[] = [];
  if (refPatch && startTree) {
    const hidden = await hiddenTexts(task, blobs);
    const testFiles = [...hidden, ...refTests.filter((t) => !hidden.some((h) => h.path === t.path))];
    coupling = goldOnlyCoupling({ testFiles, refPatch, startTree, instruction: task.instruction });
    for (const c of coupling) notes.push(couplingNote(c));
  }

  // (d) text leakage: the instruction must not contain the answer.
  if (refPatch) {
    const ov = blockOverlap(addedBlocks(refPatch), task.instruction, opts.leakage?.ngram ?? 8);
    const threshold = opts.leakage?.threshold ?? 0.3;
    if (ov.total > 0 && ov.fraction >= threshold) {
      leakage.push(`instruction contains ${(ov.fraction * 100).toFixed(0)}% of the reference patch's added code (${ov.shared}/${ov.total} ${ov.n}-grams)`);
    }
  }

  await rmrf(join(opts.workRoot, "run-files"));
  const report: ValidationReport = {
    noopFails,
    referencePasses: { passed: refPassed, of: hasReference && canVerify ? k : 0 },
    nearMissesFail: { failed: nmFailed, of: nmOf },
    leakage,
    ...(impossible ? { impossible } : {}),
    ...(passToPass ? { passToPass } : {}),
    ...(coupling.length ? { coupling } : {}),
    ok:
      errors.length === 0 &&
      noopFails &&
      refPassed === k &&
      nmFailed === nmOf &&
      leakage.length === 0 &&
      !impossible?.gameable &&
      (!passToPass || passToPass.passed === passToPass.of) &&
      !(opts.strictCoupling && coupling.length),
    ts: Date.now(),
  };
  checkpoint();
  const status: EvalTask["status"] = task.status === "archived" ? "archived" : report.ok ? "validated" : "draft";
  const updated: EvalTask = { ...task, validation: report, status };
  if (opts.index) await opts.index.putTask(updated);
  return { report, task: updated, steps, nearMisses, errors, notes };
}

/** One-paragraph human summary of an outcome, for CLI output. */
export function formatValidation(o: ValidationOutcome): string {
  const r = o.report;
  const mark = (b: boolean) => (b ? "ok  " : "FAIL");
  const lines = [
    `${mark(r.noopFails)} no-op attempt fails`,
    `${mark(r.referencePasses.of > 0 && r.referencePasses.passed === r.referencePasses.of)} reference passes ${r.referencePasses.passed}/${r.referencePasses.of}`,
    `${mark(r.nearMissesFail.failed === r.nearMissesFail.of)} near-misses fail ${r.nearMissesFail.failed}/${r.nearMissesFail.of}`,
    `${mark(r.leakage.length === 0)} no leakage${r.leakage.length ? `: ${r.leakage.join("; ")}` : ""}`,
    ...(r.impossible
      ? [
          r.impossible.gameable
            ? `FAIL impossible variants fail the reference 0/${r.impossible.tried}: the verifier is gameable`
            : `ok   impossible variant fails the reference (${r.impossible.variant?.label ?? "?"})`,
        ]
      : []),
    ...(r.passToPass
      ? [`${mark(r.passToPass.passed === r.passToPass.of)} pass-to-pass ${r.passToPass.passed}/${r.passToPass.of}${r.passToPass.granularity === "exit" ? " (suite exit status)" : ""} \`${r.passToPass.command}\``]
      : []),
    ...(r.coupling ? [`warn ${r.coupling.length} hidden-test reference(s) to names only the reference introduces (gold-only coupling)`] : []),
    ...o.errors.map((e) => `error: ${e}`),
    ...o.notes.map((n) => `note: ${n}`),
    ...surprises(o.steps).flatMap(stepOutput),
    r.ok ? "→ validated" : "→ kept as draft",
  ];
  return lines.join("\n");
}

/** Lines of a step's output shown under the summary. */
export const OUTPUT_LINES = 12;

/** The first step of each kind that went the wrong way: the output to read first. */
function surprises(steps: readonly StepResult[]): StepResult[] {
  const wrong = (s: StepResult) =>
    !s.setupOk || (s.kind === "reference" ? !s.pass : s.kind === "noop" || s.kind === "near-miss" ? s.pass : false);
  const seen = new Set<string>();
  return steps.filter((s) => {
    const key = s.setupOk ? s.kind : "setup";
    if (!wrong(s) || !s.outputTail.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stepOutput(s: StepResult): string[] {
  const how = !s.setupOk ? (s.error ?? "setup failed") : s.timedOut ? "timed out" : `verifier exited ${s.exitCode}`;
  const all = s.outputTail.trimEnd().split("\n");
  const shown = all.slice(-OUTPUT_LINES).map((l) => `    ${l.length > 200 ? `${l.slice(0, 199)}…` : l}`);
  const name = s.label.startsWith(s.kind) || s.label === "no-op" ? s.label : `${s.kind} ${s.label}`;
  return [`output of ${name}${s.attempt !== undefined ? ` #${s.attempt}` : ""} (${how})${all.length > OUTPUT_LINES ? `, last ${OUTPUT_LINES} lines` : ""}:`, ...shown];
}
