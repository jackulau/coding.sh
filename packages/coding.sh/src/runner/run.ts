// One attempt of one task under one harness:
//   materialize start → setup → overlay → (commit as new start) → agent →
//   diff → tamper check → hidden files → verifier → RunResult.
// Never throws for anything the agent, setup or verifier does; those become
// `error` on the result. The work dir is removed unless `keep`.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sortableId } from "../core/ids.ts";
import { paths } from "../core/paths.ts";
import type { Adapter, AgentRunOutput, BlobStore, EvalTask, HarnessBundle, IndexStore, RunResult } from "../core/types.ts";
import { applyBundle } from "./bundle.ts";
import { commandEnv, sh } from "./exec.ts";
import { writeHiddenFiles } from "./fsutil.ts";
import { rebaseStart, rmrf, snapshotOps, type SnapshotOps, type WorkdirDiff } from "./git.ts";
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
  /** Extra test globs for the tamper check (on top of the defaults and task.meta.testGlobs). */
  testGlobs?: string[];
  /** Agent-only routing (e.g. through AI Gateway): env and flags applied after the overlay, and a model override. Setup and verifier don't see it. */
  route?: AgentRoute;
}

export type AgentRoute = (bundle: HarnessBundle) => { env: Record<string, string>; flags: string[]; model?: string } | undefined;

export interface RunLayout {
  root: string;
  work: string;
  home: string;
}

export function runLayout(runId: string, runsDir = paths().runs): RunLayout {
  const root = join(runsDir, runId);
  return { root, work: join(root, "work"), home: join(root, "home") };
}

function emptyAgent(note = ""): AgentRunOutput {
  return { exitCode: null, timedOut: false, durationMs: 0, stdoutTail: "", stderrTail: note };
}

export async function runTask(opts: RunTaskOpts): Promise<RunResult> {
  const { task, bundle, adapter, blobs, index } = opts;
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
  };
  const baseEnv = commandEnv({ ...(opts.env ?? {}), CODING_SH_RUN_ID: runId });

  try {
    await mkdir(layout.root, { recursive: true });
    const ops = await snapshotOps(opts.git);
    await ops.materialize({ root: task.start.repoRoot, head: task.start.head, snapshot: task.start.snapshot }, layout.work);

    for (const cmd of task.setup) {
      const r = await sh(cmd, { cwd: layout.work, env: baseEnv, timeoutMs: SETUP_TIMEOUT_MS });
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
    const route = opts.route?.(bundle);
    const env: Record<string, string> = { ...bundle.env, ...(opts.env ?? {}), ...overlay.env, ...(route?.env ?? {}), CODING_SH_RUN_ID: runId };
    if (applied.usesHome && !overlay.env.HOME) {
      await mkdir(layout.home, { recursive: true });
      env.HOME = layout.home;
    }
    try {
      result.agent = await adapter.run({
        cwd: layout.work,
        instruction: task.instruction,
        model: route?.model ?? bundle.model,
        env,
        timeoutMs: opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        flags: [...bundle.flags, ...overlay.flags, ...(route?.flags ?? [])],
        runId,
      });
    } catch (e) {
      result.agent = emptyAgent(e instanceof Error ? e.message : String(e));
      result.error = `agent failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    result.sessionId = result.agent.sessionId;
    if (result.agent.timedOut) result.error ??= "agent timed out";

    // Diff before hidden files land, so the diff is the agent's work only.
    let diff: WorkdirDiff | undefined;
    try {
      diff = await ops.diffWorkdir(layout.work);
      if (diff.patch.trim() !== "") result.diffBlob = await blobs.put(diff.patch, { contentType: "text/x-diff" });
    } catch (e) {
      result.error ??= `diff failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    // Test tamper (edits, deletions, skip markers) is judged on the agent's diff alone.
    if (diff) result.tamper = detectTamper(diff, tamperOptsFor(task, opts.testGlobs));

    // The verifier runs even when the agent errored or timed out: partial work can still pass.
    await writeHiddenFiles(layout.work, task.verifier.hiddenFiles, blobs);
    if (!task.verifier.command.trim()) {
      result.error ??= "task has no verifier command";
    } else {
      const v = await sh(task.verifier.command, { cwd: layout.work, env: baseEnv, timeoutMs: task.verifier.timeoutMs });
      result.verifierExit = v.exitCode;
      result.pass = v.exitCode === 0 && !v.timedOut;
      if (v.timedOut) result.error ??= "verifier timed out";
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.pass = false;
  } finally {
    result.endedAt = Date.now();
    if (!opts.keep) await rmrf(layout.root).catch(() => {});
    try {
      await index.putRun(result);
    } catch (e) {
      result.error ??= `could not store run: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return result;
}
