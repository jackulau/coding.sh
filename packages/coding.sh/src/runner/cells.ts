// Content-keyed cells for `compare` (X-16): one (task, bundle, attempt) run is
// a cell, keyed by everything that changes what it measures. A finished run of
// the same cell from an earlier comparison can be copied into a new one
// instead of paying for the agent again (`compare --reuse baseline`).
//
// The key hashes contents, never paths: the task's start snapshot, setup,
// instruction and verifier (its hidden files are content-addressed blob refs),
// the bundle (its id is a hash of its manifest and files), the agent's
// version, the attempt number, the agent timeout, the extra env and the
// gateway route. Editing a hidden test, a CLAUDE.md or upgrading the agent
// changes the key, so a stale run is never reused.
import { sha256Hex } from "../core/ids.ts";
import type { EvalTask, HarnessBundle, RunResult } from "../core/types.ts";
import { canonicalJson } from "../datasets/hash.ts";
import { DEFAULT_RUN_TIMEOUT_MS, type AgentRoute } from "./run.ts";

/** Reused runs older than this are not reused by default. */
export const DEFAULT_REUSE_MAX_AGE_MS = 7 * 86_400_000;

/** sha256 of what a task asks and checks: start snapshot, setup, instruction and verifier. */
export function evalTaskFingerprint(task: EvalTask): string {
  return sha256Hex(
    canonicalJson({
      start: { snapshot: task.start.snapshot, head: task.start.head },
      setup: task.setup,
      instruction: task.instruction,
      verifier: { command: task.verifier.command, hiddenFiles: task.verifier.hiddenFiles, timeoutMs: task.verifier.timeoutMs },
    }),
  );
}

export interface CellKeyParts {
  task: EvalTask;
  bundle: HarnessBundle;
  /** The adapter that runs the bundle. */
  adapter: string;
  /** `detect().version`; undefined when the adapter can't tell. */
  agentVersion: string | undefined;
  attempt: number;
  /** Agent timeout; undefined means the default. */
  timeoutMs?: number;
  env?: Record<string, string>;
  route?: AgentRoute;
}

/** The content key of one run. Two runs with the same key measured the same thing. */
export function cellKey(p: CellKeyParts): string {
  const routed = p.route?.(p.bundle);
  return sha256Hex(
    canonicalJson({
      v: 1,
      // The id too: two tasks with the same content are still two cases, never one run counted twice.
      taskId: p.task.id,
      task: evalTaskFingerprint(p.task),
      bundle: p.bundle.id,
      adapter: p.adapter,
      agentVersion: p.agentVersion ?? null,
      attempt: p.attempt,
      timeoutMs: p.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      env: p.env ?? {},
      route: routed ? { env: routed.env, flags: routed.flags, model: routed.model ?? null } : null,
    }),
  );
}

export interface ReuseOpts {
  /** Bundles whose finished runs may be reused (`--reuse baseline`: A only). */
  bundleIds: readonly string[];
  /** Only runs that ended this recently. Default 7 days. */
  maxAgeMs?: number;
  /** Clock for the age check (tests). */
  now?: () => number;
}

/**
 * Whether a stored run may stand in for a new one: an original (not itself a
 * copy) that finished with a known outcome (no error, not cancelled,
 * superseded or failed on infrastructure) inside the age limit.
 */
export function reusable(r: RunResult, notBefore: number): boolean {
  return !!r.cellKey && !r.reusedFrom && !r.error && !r.cancelled && !r.superseded && !r.infra && r.endedAt >= notBefore;
}

/** The newest reusable run per cell key, from the stored runs of the reusable bundles. */
export function newestByCell(runs: readonly RunResult[], notBefore: number, excludeExperiment?: string): Map<string, RunResult> {
  const out = new Map<string, RunResult>();
  for (const r of runs) {
    if (!reusable(r, notBefore) || (excludeExperiment && r.experimentId === excludeExperiment)) continue;
    const have = out.get(r.cellKey!);
    if (!have || r.endedAt > have.endedAt) out.set(r.cellKey!, r);
  }
  return out;
}
