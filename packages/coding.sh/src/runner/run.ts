// One attempt of one task under one harness:
//   materialize start → setup → overlay → (commit as new start) → agent →
//   diff → tamper check → hidden files → verifier → [repair rounds] → RunResult.
// Never throws for anything the agent, setup or verifier does; those become
// `error` on the result. The work dir is removed unless `keep`.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentAnswerText } from "../core/answer.ts";
import { removeOnExit, withAbortSignal } from "../core/children.ts";
import { sortableId } from "../core/ids.ts";
import { paths } from "../core/paths.ts";
import type { Adapter, AgentRunOutput, BlobStore, EvalTask, HarnessBundle, IndexStore, RepairReport, RepairRound, RunResult, TamperReport } from "../core/types.ts";
import { applyBundle } from "./bundle.ts";
import { commandEnv, sh, type ExecResult } from "./exec.ts";
import { writeHiddenFiles } from "./fsutil.ts";
import { rebaseStart, rmrf, snapshotOps, type SnapshotOps, type WorkdirDiff } from "./git.ts";
import { falseAlarmFires, failingTestNames, repairMessage, restoreFiles, saveFiles, type RepairOpts, type SavedFiles } from "./repair.ts";
import { detectTamper, tamperOptsFor } from "./tamper.ts";

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
const SETUP_TIMEOUT_MS = 15 * 60_000;

export interface RunTaskOpts {
  task: EvalTask;
  bundle: HarnessBundle;
  adapter: Adapter;
  blobs: BlobStore;
  index: IndexStore;
  attempt?: number;
  experimentId?: string;
  /** Agent wall-clock limit (default 30 min). The verifier uses task.verifier.timeoutMs. */
  timeoutMs?: number;
  /** Keep runs/<id>/ on disk for inspection. */
  keep?: boolean;
  /** Extra env for setup, agent and verifier. */
  env?: Record<string, string>;
  git?: SnapshotOps;
  /** Override paths().runs (tests). */
  runsDir?: string;
  runId?: string;
  /** Stamped on the result (runner/cells.ts), so a later `compare --reuse` can find it. */
  cellKey?: string;
  /** The agent release this run starts on (runner/release.ts), stamped on the result. */
  agentVersion?: string;
  /** Extra test globs for the tamper check (on top of the defaults and task.meta.testGlobs). */
  testGlobs?: string[];
  /** Agent-only routing (e.g. through AI Gateway): env and flags applied after the overlay, and a model override. Setup and verifier don't see it. */
  route?: AgentRoute;
  /**
   * Interrupts the run: setup, agent (through the ambient signal its adapter's
   * spawn picks up) and verifier are killed, no further step starts, and the
   * result is marked `cancelled`. The work dir is still removed unless `keep`.
   */
  signal?: AbortSignal;
  /**
   * Ingests the spool before runs/<id>/ is removed. The agent's Stop hook names
   * its transcript under the run's HOME; read after the removal, only the final
   * reply survives, and what the agent said mid-turn (why it changed a test) is lost.
   */
  ingest?: () => Promise<unknown>;
  /**
   * Repair rounds (`compare --repair N`): after a failed verifier, tell the agent
   * and let it try again in its own session, up to `rounds` times. The result's
   * `pass` stays the first attempt's; `repair` holds the rounds.
   */
  repair?: RepairOpts;
}

export type AgentRoute = (bundle: HarnessBundle) => { env: Record<string, string>; flags: string[]; model?: string } | undefined;

export interface RunLayout {
  root: string;
  work: string;
  home: string;
  /** The agent's stdout and final answer, outside the work tree so the agent can't edit what the verifier reads. */
  agent: string;
}

export function runLayout(runId: string, runsDir = paths().runs): RunLayout {
  const root = join(runsDir, runId);
  return { root, work: join(root, "work"), home: join(root, "home"), agent: join(root, "agent") };
}

/** The stored run keeps this many characters of the final answer; CODING_SH_AGENT_OUTPUT has all of it. */
export const FINAL_TEXT_MAX = 16 * 1024;

/**
 * What the verifier gets to read besides the work tree: CODING_SH_AGENT (adapter id),
 * CODING_SH_AGENT_OUTPUT (the final answer, a file), CODING_SH_AGENT_STDOUT (the whole
 * stdout, e.g. Claude's stream-json with every tool call), CODING_SH_AGENT_DIFF (the
 * agent's work-tree diff, taken before hidden files land) and CODING_SH_SESSION_ID.
 * A task whose answer is what the agent says (asked for scope, declined a request)
 * can only be graded from these.
 */
export function verifierEnv(adapterId: string, layout: RunLayout, agent: AgentRunOutput): Record<string, string> {
  const env: Record<string, string> = { CODING_SH_AGENT: adapterId };
  const stdout = join(layout.agent, "stdout");
  if (existsSync(stdout)) env.CODING_SH_AGENT_STDOUT = stdout;
  const output = join(layout.agent, "output.txt");
  if (agent.finalText !== undefined && existsSync(output)) env.CODING_SH_AGENT_OUTPUT = output;
  const diff = join(layout.agent, "diff.patch");
  if (existsSync(diff)) env.CODING_SH_AGENT_DIFF = diff;
  if (agent.sessionId) env.CODING_SH_SESSION_ID = agent.sessionId;
  return env;
}

class RunCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "RunCancelled";
  }
}

function emptyAgent(note = ""): AgentRunOutput {
  return { exitCode: null, timedOut: false, durationMs: 0, stdoutTail: "", stderrTail: note };
}

/** Sum of the JSONL rows `judge grade` appended ({costUsd?, inputTokens?, outputTokens?} per model call). */
export async function readGraderUsage(file: string): Promise<RunResult["graderUsage"]> {
  const text = await readFile(file, "utf8").catch(() => "");
  const u = { calls: 0, costUsd: 0, unpriced: 0, inputTokens: 0, outputTokens: 0 };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    u.calls++;
    const cost = n(row.costUsd);
    if (cost === undefined) u.unpriced++;
    else u.costUsd += cost;
    u.inputTokens += n(row.inputTokens) ?? 0;
    u.outputTokens += n(row.outputTokens) ?? 0;
  }
  return u.calls ? u : undefined;
}

export async function runTask(opts: RunTaskOpts): Promise<RunResult> {
  // Every child spawned below (git, setup, the adapter's agent, the verifier) is killed on abort.
  return withAbortSignal(opts.signal, () => runTaskInner(opts));
}

async function runTaskInner(opts: RunTaskOpts): Promise<RunResult> {
  const { task, bundle, adapter, blobs, index } = opts;
  const signal = opts.signal;
  const runId = opts.runId ?? sortableId("run_");
  const layout = runLayout(runId, opts.runsDir);
  const startedAt = Date.now();
  const result: RunResult = {
    id: runId,
    experimentId: opts.experimentId,
    taskId: task.id,
    bundleId: bundle.id,
    attempt: opts.attempt ?? 1,
    pass: false,
    verifierExit: null,
    agent: emptyAgent(),
    startedAt,
    endedAt: startedAt,
    ...(opts.cellKey ? { cellKey: opts.cellKey } : {}),
    ...(opts.agentVersion ? { agentVersion: opts.agentVersion } : {}),
  };
  const baseEnv = commandEnv({ ...(opts.env ?? {}), CODING_SH_RUN_ID: runId });

  /** Stop here when interrupted; the catch below records it. */
  const checkpoint = () => {
    if (signal?.aborted) throw new RunCancelled();
  };

  // A hard exit (second Ctrl-C) skips the finally below; the exit hook removes the dir then.
  const forgetDir = opts.keep ? () => {} : removeOnExit(layout.root);
  try {
    checkpoint();
    await mkdir(layout.root, { recursive: true });
    const ops = await snapshotOps(opts.git);
    await ops.materialize({ root: task.start.repoRoot, head: task.start.head, snapshot: task.start.snapshot }, layout.work);

    for (const cmd of task.setup) {
      const r = await sh(cmd, { cwd: layout.work, env: baseEnv, timeoutMs: SETUP_TIMEOUT_MS });
      checkpoint();
      if (r.exitCode !== 0) {
        result.error = `setup \`${cmd}\` ${r.timedOut ? "timed out" : `exited ${r.exitCode}`}: ${r.stderrTail.slice(-500)}`;
        return result;
      }
    }

    const applied = await applyBundle(bundle, layout.work, blobs, { home: layout.home });
    const overlay = adapter.overlay ? await adapter.overlay(bundle, layout.work) : { env: {}, flags: [] };
    // Setup output + harness are part of the start, not the agent's diff.
    await rebaseStart(layout.work, `coding.sh: setup + harness ${bundle.name}`);

    if (!adapter.run) {
      result.error = `adapter ${adapter.id} has no headless run()`;
      return result;
    }
    const run = adapter.run.bind(adapter);
    checkpoint();
    const route = opts.route?.(bundle);
    const env: Record<string, string> = { ...bundle.env, ...(opts.env ?? {}), ...overlay.env, ...(route?.env ?? {}), CODING_SH_RUN_ID: runId };
    if (applied.usesHome && !overlay.env.HOME) {
      await mkdir(layout.home, { recursive: true });
      env.HOME = layout.home;
    }
    await mkdir(layout.agent, { recursive: true });
    const stdoutFile = join(layout.agent, "stdout");
    /** One agent session (or a resumed one); its final answer goes where the verifier reads it. */
    const callAgent = async (instruction: string, resumeSessionId?: string): Promise<AgentCall> => {
      let out: AgentRunOutput;
      let error: string | undefined;
      try {
        out = await run({
          cwd: layout.work,
          instruction,
          model: route?.model ?? bundle.model,
          env,
          timeoutMs: opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
          flags: [...bundle.flags, ...overlay.flags, ...(route?.flags ?? [])],
          runId,
          stdoutFile,
          ...(resumeSessionId ? { resumeSessionId } : {}),
        });
      } catch (e) {
        out = emptyAgent(e instanceof Error ? e.message : String(e));
        error = `agent failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      // The final answer, from the whole stdout when the adapter wrote it (else the tail).
      const stdout = existsSync(stdoutFile) ? await readFile(stdoutFile, "utf8").catch(() => out.stdoutTail) : out.stdoutTail;
      if (stdout.trim()) {
        const answer = agentAnswerText(stdout);
        await writeFile(join(layout.agent, "output.txt"), answer);
        out.finalText = answer.slice(0, FINAL_TEXT_MAX);
      }
      return error ? { out, error } : { out };
    };
    /** The agent's work-tree diff since the start, taken before hidden files land, stored and handed to the verifier. */
    const takeDiff = async (): Promise<TakenDiff> => {
      try {
        const diff = await ops.diffWorkdir(layout.work);
        const blob = diff.patch.trim() !== "" ? await blobs.put(diff.patch, { contentType: "text/x-diff" }) : undefined;
        await writeFile(join(layout.agent, "diff.patch"), diff.patch);
        return blob ? { diff, blob } : { diff };
      } catch (e) {
        return { error: `diff failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    };
    const hiddenPaths = Object.keys(task.verifier.hiddenFiles);
    /** Hidden files in, then the verifier. With repair, what the hidden files replace is saved so they can come out again. */
    const grade = async (agent: AgentRunOutput): Promise<Graded> => {
      const saved = opts.repair ? await saveFiles(layout.work, hiddenPaths) : undefined;
      await writeHiddenFiles(layout.work, task.verifier.hiddenFiles, blobs);
      if (!task.verifier.command.trim()) return { saved };
      checkpoint();
      const usageFile = join(layout.agent, "grader-usage.jsonl");
      const v = await sh(task.verifier.command, {
        cwd: layout.work,
        env: { ...baseEnv, ...verifierEnv(adapter.id, layout, agent), CODING_SH_GRADER_USAGE: usageFile },
        timeoutMs: task.verifier.timeoutMs,
        // Repair reads failing test names from the output's end.
        ...(opts.repair ? { tailBytes: 64 * 1024 } : {}),
      });
      // The file collects every round's judge calls.
      const graderUsage = await readGraderUsage(usageFile);
      if (graderUsage) result.graderUsage = graderUsage;
      checkpoint();
      return { saved, v };
    };

    const first = await callAgent(task.instruction);
    result.agent = first.out;
    if (first.error) result.error = first.error;
    checkpoint();
    result.sessionId = result.agent.sessionId;
    if (result.agent.timedOut) result.error ??= "agent timed out";

    // Diff before hidden files land, so the diff is the agent's work only.
    const d = await takeDiff();
    if (d.blob) result.diffBlob = d.blob;
    if (d.error) result.error ??= d.error;
    // Test tamper (edits, deletions, skip markers) is judged on the agent's diff alone.
    if (d.diff) result.tamper = detectTamper(d.diff, tamperOptsFor(task, opts.testGlobs));

    // The verifier runs even when the agent errored or timed out: partial work can still pass.
    const g = await grade(result.agent);
    if (!g.v) {
      result.error ??= "task has no verifier command";
    } else {
      result.verifierExit = g.v.exitCode;
      result.pass = g.v.exitCode === 0 && !g.v.timedOut;
      if (g.v.timedOut) result.error ??= "verifier timed out";
    }
    if (opts.repair) {
      result.repair = await repairRounds({
        repair: opts.repair,
        runId,
        canResume: !!adapter.canResume,
        result,
        graded: g,
        ...(d.diff ? { firstPatch: d.diff.patch } : {}),
        instruction: task.instruction,
        checkpoint,
        restore: (saved) => restoreFiles(layout.work, saved),
        // Each round's stdout starts empty; the earlier ones stay beside it as stdout.<n>.
        rotateStdout: async (n) => {
          if (existsSync(stdoutFile)) await rename(stdoutFile, `${stdoutFile}.${n}`);
        },
        callAgent,
        takeDiff,
        tamperOf: (diff) => detectTamper(diff, tamperOptsFor(task, opts.testGlobs)),
        grade,
      });
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.pass = false;
  } finally {
    // Interrupted at any step (or a step failed because the abort killed it): the outcome is not a result.
    if (signal?.aborted) {
      result.cancelled = true;
      result.pass = false;
      result.error = "cancelled";
    }
    result.endedAt = Date.now();
    if (!opts.keep && !signal?.aborted && opts.ingest) await opts.ingest().catch(() => {});
    if (!opts.keep) await rmrf(layout.root).catch(() => {});
    forgetDir();
    try {
      await index.putRun(result);
    } catch (e) {
      result.error ??= `could not store run: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return result;
}

interface AgentCall {
  out: AgentRunOutput;
  error?: string;
}

interface TakenDiff {
  diff?: WorkdirDiff;
  blob?: string;
  error?: string;
}

interface Graded {
  /** What the hidden files replaced (repair only). */
  saved?: SavedFiles;
  /** Absent when the task has no verifier command. */
  v?: ExecResult;
}

interface RepairCtx {
  repair: RepairOpts;
  runId: string;
  canResume: boolean;
  result: RunResult;
  graded: Graded;
  /** The first attempt's diff, to tell a round that changed nothing. */
  firstPatch?: string;
  instruction: string;
  checkpoint: () => void;
  restore: (saved: SavedFiles) => Promise<void>;
  rotateStdout: (n: number) => Promise<void>;
  callAgent: (instruction: string, resumeSessionId?: string) => Promise<AgentCall>;
  takeDiff: () => Promise<TakenDiff>;
  tamperOf: (diff: WorkdirDiff) => TamperReport;
  grade: (agent: AgentRunOutput) => Promise<Graded>;
}

const outputOf = (v: ExecResult | undefined) => (v ? `${v.stdoutTail}\n${v.stderrTail}` : "");

/**
 * Repair rounds after the first verifier: while it fails (or once, when the
 * seeded false alarm fires on a pass) and rounds remain, take the hidden files
 * out, tell the agent "Verification failed." in its own session (a fresh one
 * with the instruction first when the adapter can't resume), put the hidden
 * files back and verify again. A round whose whole diff tampers with tests
 * ends the loop, and the repair does not count.
 */
async function repairRounds(c: RepairCtx): Promise<RepairReport> {
  const { repair, result } = c;
  let sid = result.agent.sessionId;
  const mode: RepairReport["mode"] = c.canResume && sid ? "resume" : "fresh";
  const rep: RepairReport = {
    signal: repair.signal,
    mode,
    limit: repair.rounds,
    ...(repair.falseAlarm ? { falseAlarm: repair.falseAlarm } : {}),
    rounds: [],
    pass: result.pass,
  };
  // Nothing measured to repair: the agent timed out, errored, or the verifier never ran.
  if (result.agent.timedOut) return { ...rep, skipped: "timeout" };
  if (result.error || result.verifierExit === null) return { ...rep, skipped: "error" };
  let pass = result.pass;
  const alarm = pass && falseAlarmFires(repair.falseAlarm, repair.seed, c.runId);
  if (alarm) rep.falseAlarmFired = true;
  let graded = c.graded;
  let prevPatch = c.firstPatch;
  for (let n = 1; n <= repair.rounds && (!pass || (n === 1 && alarm)); n++) {
    c.checkpoint();
    // The agent never sees the hidden tests: back to its own tree.
    if (graded.saved) await c.restore(graded.saved);
    // A false alarm has no failing test to name: it gets the bare bit.
    const names = repair.signal === "names" && !pass ? failingTestNames(outputOf(graded.v)) : [];
    const message = repairMessage(names);
    await c.rotateStdout(n - 1);
    const resume = mode === "resume" ? sid : undefined;
    const a = await c.callAgent(resume ? message : `${c.instruction}\n\n${message}`, resume);
    c.checkpoint();
    if (a.out.sessionId) sid = a.out.sessionId;
    const round: RepairRound = {
      n,
      ...(a.out.sessionId ? { sessionId: a.out.sessionId } : {}),
      pass: false,
      verifierExit: null,
      durationMs: a.out.durationMs,
      ...(a.out.usage ? { usage: a.out.usage } : {}),
      ...(repair.signal === "names" ? { namesParsed: names.length > 0 } : {}),
    };
    let error = a.error ?? (a.out.timedOut ? "agent timed out" : undefined);
    const d = await c.takeDiff();
    if (d.blob) round.diffBlob = d.blob;
    error ??= d.error;
    // The tree's diff since the start is what it was before the round: the agent changed nothing.
    if (d.diff && prevPatch !== undefined && d.diff.patch === prevPatch) round.unchanged = true;
    prevPatch = d.diff?.patch;
    // Judged on the whole diff since the start: a repair that edits the tests is no repair.
    const t = d.diff ? c.tamperOf(d.diff) : undefined;
    if (t?.flagged) round.tamper = t;
    graded = await c.grade(a.out);
    if (graded.v) {
      round.verifierExit = graded.v.exitCode;
      round.pass = graded.v.exitCode === 0 && !graded.v.timedOut;
      if (graded.v.timedOut) error ??= "verifier timed out";
    }
    if (error) round.error = error;
    rep.rounds.push(round);
    pass = round.pass;
    if (round.tamper || a.out.timedOut) break;
  }
  rep.pass = pass && !rep.rounds.at(-1)?.tamper;
  return rep;
}
