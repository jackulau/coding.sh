// How an experiment run uses the llm cache: one proxy per run, one job per
// case-trial, and the stats a case-trial keeps (CaseRun.llm).
import { homedir, tmpdir } from "node:os";
import { paths } from "../core/paths.ts";
import { createRedactor } from "../core/redact.ts";
import { type LlmCache, type LlmCacheMode, type LlmJob, type LlmStats, type LlmUpstreams, startLlmCache } from "./proxy.ts";

export interface LlmRunOpts {
  mode: LlmCacheMode;
  /** replay: the experiment id whose recordings are served. */
  source?: string;
  /** replay: serve recorded calls up to this ordinal; later calls run live. */
  until?: number;
  /** The llm cache dir (default paths(env).llmCache). */
  dir?: string;
  upstream?: Partial<LlmUpstreams>;
  excludeTools?: boolean;
  excludeModel?: boolean;
  onWarn?: (message: string) => void;
  /** Extra fields for the experiment's `metadata.llm` (the CLI stores the recorded task spec here). */
  meta?: Record<string, unknown>;
}

/** What a case-trial's model calls did (CaseRun.llm). */
export interface CaseLlm {
  calls: number;
  hits: number;
  live: number;
  /** The first call of a replay that ran live (absent when every call was served, and when recording). */
  firstLiveOrdinal?: number;
  /** A replay that could not execute past its boundary: the case-trial is not scored. */
  unscored?: "missing-source" | "upstream-error";
}

/** What a task sees: the base URLs and the env a child process needs. */
export interface TaskLlm {
  env: Record<string, string>;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
}

export async function openLlmCache(o: LlmRunOpts, env: NodeJS.ProcessEnv = process.env): Promise<LlmCache> {
  return startLlmCache({
    mode: o.mode,
    dir: o.dir ?? paths(env).llmCache,
    ...(o.source ? { source: o.source } : {}),
    ...(o.until !== undefined ? { until: o.until } : {}),
    ...(o.upstream ? { upstream: o.upstream } : {}),
    key: { ...(o.excludeTools ? { excludeTools: true } : {}), ...(o.excludeModel ? { excludeModel: true } : {}) },
    ...(o.onWarn ? { onWarn: o.onWarn } : {}),
  });
}

/**
 * The task spec a recording keeps, so `exp run --replay` can run the recorded
 * config as its control arm: command and http tasks only (a function cannot
 * be stored), redacted, and without secret-named env values.
 */
export function recordedTaskSpec(task: unknown): Record<string, unknown> | undefined {
  if (!task || typeof task !== "object" || Array.isArray(task)) return undefined;
  const t = task as Record<string, unknown>;
  if (t.kind !== "command" && t.kind !== "http") return undefined;
  const { env, fetch: _fetch, ...rest } = t;
  let copy: Record<string, unknown>;
  try {
    copy = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const out = createRedactor({ redact: ["secrets"] }).value(copy);
  // A relative command resolves against the cwd it was recorded in.
  if (out.kind === "command" && out.cwd === undefined) out.cwd = process.cwd();
  if (env && typeof env === "object") {
    // Secret-named values are left out; the control arm takes them from its own environment.
    const kept = Object.entries(env as Record<string, unknown>).filter(([k, v]) => typeof v === "string" && !/KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION/i.test(k));
    if (kept.length) out.env = createRedactor({ redact: ["secrets"] }).value(Object.fromEntries(kept));
  }
  return out;
}

/** `metadata.llm` of an experiment that ran with the cache (a recording also keeps its task spec). */
export function llmMetadata(o: LlmRunOpts, task?: unknown): Record<string, unknown> {
  const spec = o.mode === "record" ? recordedTaskSpec(task) : undefined;
  return { mode: o.mode, ...(o.source ? { source: o.source } : {}), ...(o.until !== undefined ? { until: o.until } : {}), ...(spec ? { task: spec } : {}), ...(o.meta ?? {}) };
}

/** Run-specific strings a key ignores: the run id, the cwd, the temp dir and HOME. */
export function trialNormalize(runId: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { RUN: runId, CWD: process.cwd(), TMP: tmpdir(), HOME: env.HOME || homedir() };
}

export const taskLlm = (j: LlmJob): TaskLlm => ({ env: { ...j.env }, anthropicBaseUrl: j.anthropicBaseUrl, openaiBaseUrl: j.openaiBaseUrl });

export function caseLlm(s: LlmStats): CaseLlm {
  const out: CaseLlm = { calls: s.calls, hits: s.hits, live: s.live };
  if (s.firstLiveOrdinal !== undefined) out.firstLiveOrdinal = s.firstLiveOrdinal;
  if (s.missingSource) out.unscored = "missing-source";
  else if (s.upstreamErrors) out.unscored = "upstream-error";
  return out;
}

/**
 * Opens a job for one case-trial, runs `fn` with what the task needs, and
 * returns fn's result with the job's stats. The job is closed (its recording
 * written) even when fn throws.
 */
export async function withLlmJob<T>(cache: LlmCache | undefined, o: { expId: string; caseId: string; trial: number }, fn: (llm: TaskLlm | undefined) => Promise<T>): Promise<{ value: T; llm?: CaseLlm }> {
  if (!cache) return { value: await fn(undefined) };
  const job = await cache.job({ ...o, normalize: trialNormalize(o.expId) });
  let value: T;
  try {
    value = await fn(taskLlm(job));
  } finally {
    await job.close();
  }
  return { value, llm: caseLlm(job.stats()) };
}
