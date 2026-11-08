// Tool-eval experiments (§8): tasks × variants × drivers × k. Jobs are ordered
// per task with attempts interleaved across arms (as in scheduleJobs), so
// provider drift hits every arm equally. Each trial: sandbox → tap → driver →
// collect events + tap → checks → metrics → TrialResult (trials.jsonl) and a
// RunResult through IndexStore.putRun.
import { mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { removeOnExit, withAbortSignal } from "../core/children.ts";
import { sha256Hex, sortableId } from "../core/ids.ts";
import { paths } from "../core/paths.ts";
import type { Adapter, AgentRunOutput, BlobStore, HarnessBundle, IndexStore, RunResult, Session } from "../core/types.ts";
import type { AgentEvent, AgentId } from "../schema/index.ts";
import { defaultConcurrency, pool } from "../runner/experiment.ts";
import { runChecks } from "./checks.ts";
import { runAgentTrial } from "./drivers/agent.ts";
import { runModelTrial } from "./drivers/model.ts";
import { computeMetrics } from "./metrics.ts";
import { openapiPaths, startHttpTap } from "./tap/http-proxy.ts";
import { startMcpProxy } from "./tap/mcp-proxy.ts";
import { prepareSandbox, sandboxDir, suiteDirOf } from "./sandbox.ts";
import { armKey, driverKey, type Driver, type JudgeFn, type Prices, type TapRecord, type Target, type ToolTask, type TrialResult, type Variant } from "./types.ts";

export interface ExperimentDeps {
  adapterFor: (a: AgentId) => Adapter;
  index: IndexStore;
  blobs: BlobStore;
  concurrency?: number;
  keep?: boolean;
  /** Root for experiment dirs (default ~/.coding.sh/toolevals). */
  root?: string;
  fetch?: typeof fetch;
  /** Drains captured agent events (hooks → spool → index) before a trial's session is looked up. */
  ingest?: () => Promise<unknown>;
  judge?: JudgeFn;
  prices?: Prices;
  /** Harness bundles by id or name, for variants that name one. */
  bundleFor?: (ref: string) => Promise<HarnessBundle | undefined>;
  env?: NodeJS.ProcessEnv;
  otelEndpoint?: string;
  /**
   * Interrupts the experiment: no new trial starts; running setup, tap,
   * agent and check processes are killed (through the ambient signal). A trial
   * the abort cut short is stored as a cancelled run but kept out of
   * trials.jsonl and the returned trials.
   */
  signal?: AbortSignal;
}

export interface ExperimentOpts extends ExperimentDeps {
  tasks: ToolTask[];
  target: Target;
  variants: Variant[];
  drivers: Driver[];
  k: number;
  experimentId?: string;
  onProgress?: (done: number, total: number, t: TrialResult) => void;
  /** Recorded in experiment.json (git commit, agent versions, surfaces…). */
  meta?: Record<string, unknown>;
}

export interface ToolJob {
  task: ToolTask;
  variant: Variant;
  driver: Driver;
  attempt: number;
}

export function scheduleToolJobs(tasks: readonly ToolTask[], variants: readonly Variant[], drivers: readonly Driver[], k: number): ToolJob[] {
  const jobs: ToolJob[] = [];
  for (const task of tasks) for (let attempt = 1; attempt <= k; attempt++) for (const variant of variants) for (const driver of drivers) jobs.push({ task, variant, driver, attempt });
  return jobs;
}

export function toolevalsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(paths(env).root, "toolevals");
}

export async function readTap(file: string): Promise<TapRecord[]> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: TapRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TapRecord);
    } catch {
      // partial line from a killed process
    }
  }
  return out;
}

/** The trial's session (by runId) and its children, with all their events. */
export async function loadTrialTrace(index: IndexStore, trialId: string, sessionId?: string): Promise<{ sessions: Session[]; events: AgentEvent[] }> {
  let root = sessionId ? await index.getSession(sessionId) : undefined;
  if (!root) root = (await index.listSessions({ runId: trialId, limit: 1, parentSessionId: null }))[0] ?? (await index.listSessions({ runId: trialId, limit: 1 }))[0];
  if (!root) return { sessions: [], events: [] };
  const sessions: Session[] = [root];
  const queue = [root.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const c of await index.listSessions({ parentSessionId: id })) {
      if (sessions.some((s) => s.id === c.id)) continue;
      sessions.push(c);
      queue.push(c.id);
    }
  }
  const events: AgentEvent[] = [];
  for (const s of sessions) events.push(...(await index.listEvents(s.id)));
  return { sessions, events };
}

function lastAssistantText(events: readonly AgentEvent[], rootId: string | undefined): string {
  const msgs = events.filter((e) => e.kind === "assistant.message" && (!rootId || e.sessionId === rootId) && !e.subagentId && typeof e.payload.text === "string");
  return (msgs[msgs.length - 1]?.payload.text as string | undefined) ?? "";
}

const emptyRun = (note = ""): AgentRunOutput => ({ exitCode: null, timedOut: false, durationMs: 0, stdoutTail: "", stderrTail: note });

type TrialOpts = ExperimentDeps & { job: ToolJob; target: Target; experimentId: string; expDir: string; trialId?: string };

export async function runTrial(o: TrialOpts): Promise<TrialResult> {
  return withAbortSignal(o.signal, () => runTrialInner(o));
}

async function runTrialInner(o: TrialOpts): Promise<TrialResult> {
  const { job, target } = o;
  const trialId = o.trialId ?? sortableId("trial_");
  const dKey = driverKey(job.driver);
  const startedAt = Date.now();
  const result: TrialResult = {
    id: trialId,
    experimentId: o.experimentId,
    taskId: job.task.id,
    variant: job.variant.name,
    driver: dKey,
    attempt: job.attempt,
    childSessionIds: [],
    pass: false,
    checks: [],
    metrics: undefined as unknown as TrialResult["metrics"],
    startedAt,
    endedAt: startedAt,
  };
  let run: AgentRunOutput = emptyRun();
  let finalText = "";
  let driverBudget: TrialResult["metrics"]["budgetExceeded"];
  // Known before the sandbox exists: prepareSandbox creates it and then may fail (setup command, missing file).
  const sbRoot = sandboxDir(o.expDir, trialId);
  const forgetSandbox = o.keep ? () => {} : removeOnExit(sbRoot);
  let tap: TapRecord[] = [];
  let trace: { sessions: Session[]; events: AgentEvent[] } = { sessions: [], events: [] };
  const closers: (() => Promise<void>)[] = [];
  try {
    const sb = await prepareSandbox(job.task, target, job.variant, trialId, o.expDir);
    let mcpStdio: string[] | undefined;
    let mcpUrl: string | undefined;
    let httpUrl: string | undefined;
    const extraEnv: Record<string, string> = {};
    if (target.kind === "mcp") {
      const p = await startMcpProxy({ target, variant: job.variant, tapLog: sb.tapLog, binDir: sb.bin, env: sb.toolEnv, cwd: sb.work, fetch: o.fetch });
      closers.push(() => p.close());
      mcpStdio = p.stdio;
      mcpUrl = p.url;
    } else if (target.kind === "http") {
      let templates: string[] = [];
      if (target.openapi) {
        try {
          templates = openapiPaths(JSON.parse(await readFile(join(suiteDirOf(job.task), target.openapi), "utf8")) as unknown);
        } catch {
          templates = [];
        }
      }
      const h = await startHttpTap({ target, variant: job.variant, tapLog: sb.tapLog, templates, env: { ...(o.env ?? process.env), ...sb.toolEnv } });
      closers.push(() => h.close());
      httpUrl = h.url;
      extraEnv[target.urlEnv ?? `${target.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_URL`] = h.url;
      Object.assign(sb.env, extraEnv);
    }

    if (job.driver.kind === "model") {
      const out = await runModelTrial({
        driver: job.driver,
        task: job.task,
        target,
        sandbox: sb,
        index: o.index,
        trialId,
        fetch: o.fetch,
        mcp: mcpStdio ? { stdio: mcpStdio } : mcpUrl ? { url: mcpUrl } : undefined,
        httpUrl,
        prices: o.prices,
        env: o.env,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      run = out;
      finalText = out.finalText;
      driverBudget = out.loop.budgetExceeded;
      if (out.loop.error) result.error = out.loop.error;
    } else {
      const adapter = o.adapterFor(job.driver.agent);
      const bundle = job.variant.bundle && o.bundleFor ? await o.bundleFor(job.variant.bundle) : undefined;
      if (job.variant.bundle && !bundle) throw new Error(`variant ${job.variant.name}: harness bundle ${job.variant.bundle} not found`);
      try {
        run = await runAgentTrial({
          adapter,
          driver: job.driver,
          task: job.task,
          sandbox: sb,
          bundle,
          blobs: o.blobs,
          trialId,
          mcp: mcpStdio || mcpUrl ? { name: target.name, stdio: mcpStdio, url: mcpUrl } : undefined,
          extraEnv,
          otelEndpoint: o.otelEndpoint,
        });
      } catch (e) {
        run = emptyRun(e instanceof Error ? e.message : String(e));
        result.error = `agent failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (run.timedOut) result.error ??= "agent timed out";
      if (o.ingest) await o.ingest().catch(() => undefined);
    }
    for (const c of closers.splice(0)) await c().catch(() => {});

    trace = await loadTrialTrace(o.index, trialId, run.sessionId);
    result.sessionId = trace.sessions[0]?.id ?? run.sessionId;
    result.childSessionIds = trace.sessions.slice(1).map((s) => s.id);
    if (job.driver.kind === "agent") finalText = lastAssistantText(trace.events, trace.sessions[0]?.id) || run.stdoutTail.trim();

    tap = await readTap(sb.tapLog);
    result.checks = await runChecks(job.task, sb, finalText, o.judge, tap);
  } catch (e) {
    result.error ??= e instanceof Error ? e.message : String(e);
  } finally {
    for (const c of closers) await c().catch(() => {});
  }

  // Every check must have run and passed; a trial whose setup or driver threw before checks ran fails.
  const checksPass = result.checks.length === job.task.checks.length && result.checks.every((c) => c.pass) && (result.checks.length > 0 || !result.error);
  result.metrics = computeMetrics({ task: job.task, target, tap, events: trace.events, sessions: trace.sessions, run, checksPass, prices: o.prices });
  if (driverBudget && !result.metrics.budgetExceeded) {
    result.metrics.budgetExceeded = driverBudget;
    result.metrics.success = false;
  }
  if (result.error === "schema-rejected-by-provider") result.metrics.success = false;
  result.pass = result.metrics.success;
  if (tap.length) {
    try {
      result.tapBlob = await o.blobs.put(tap.map((r) => JSON.stringify(r)).join("\n") + "\n", { contentType: "application/x-ndjson" });
    } catch {
      // blob store unavailable: trials.jsonl still has the metrics
    }
  }
  if (o.signal?.aborted) {
    result.pass = false;
    result.error = "cancelled";
  }
  result.endedAt = Date.now();
  if (!o.keep) await rm(sbRoot, { recursive: true, force: true }).catch(() => {});
  forgetSandbox();
  const runResult: RunResult = {
    id: trialId,
    experimentId: o.experimentId,
    taskId: job.task.id,
    bundleId: sha256Hex(armKey(job.variant.name, dKey)),
    attempt: job.attempt,
    pass: result.pass,
    verifierExit: result.pass ? 0 : 1,
    agent: run,
    startedAt,
    endedAt: result.endedAt,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(result.error ? { error: result.error } : {}),
    // On the run too, not only in trials.jsonl, so blob gc sees the reference.
    ...(result.tapBlob ? { tapBlob: result.tapBlob } : {}),
    ...(o.signal?.aborted ? { cancelled: true as const } : {}),
  };
  await o.index.putRun(runResult).catch(() => {});
  return result;
}

export async function runToolExperiment(o: ExperimentOpts): Promise<{ experimentId: string; trials: TrialResult[]; dir: string; cancelled: boolean }> {
  const experimentId = o.experimentId ?? sortableId("texp_");
  const dir = join(o.root ?? toolevalsRoot(o.env), experimentId);
  await mkdir(dir, { recursive: true });
  const jobs = scheduleToolJobs(o.tasks, o.variants, o.drivers, Math.max(1, o.k));
  await writeFile(
    join(dir, "experiment.json"),
    JSON.stringify(
      {
        id: experimentId,
        createdAt: Date.now(),
        target: o.target,
        variants: o.variants,
        drivers: o.drivers.map(driverKey),
        arms: o.variants.flatMap((v) => o.drivers.map((d) => armKey(v.name, driverKey(d)))),
        tasks: o.tasks.map((t) => ({ id: t.id, split: t.split, source: t.source })),
        k: o.k,
        ...(o.meta ?? {}),
      },
      null,
      2,
    ),
  );
  const trialsFile = join(dir, "trials.jsonl");
  let done = 0;
  const settled = await pool(jobs, o.concurrency ?? defaultConcurrency(), async (job): Promise<TrialResult | undefined> => {
    if (o.signal?.aborted) return undefined; // never started
    const t = await runTrial({ ...o, job, target: o.target, experimentId, expDir: dir });
    if (o.signal?.aborted) return undefined; // cut short: not a trial result
    await appendFile(trialsFile, JSON.stringify(t) + "\n");
    done++;
    o.onProgress?.(done, jobs.length, t);
    return t;
  });
  const trials = settled.filter((t): t is TrialResult => t !== undefined);
  return { experimentId, trials, dir, cancelled: o.signal?.aborted === true };
}

/** Trials of a stored experiment. */
export async function loadExperiment(id: string, root: string): Promise<{ meta: Record<string, unknown>; trials: TrialResult[] }> {
  const dir = join(root, id);
  const meta = JSON.parse(await readFile(join(dir, "experiment.json"), "utf8")) as Record<string, unknown>;
  const trials: TrialResult[] = [];
  let text = "";
  try {
    text = await readFile(join(dir, "trials.jsonl"), "utf8");
  } catch {
    text = "";
  }
  for (const line of text.split("\n")) if (line.trim()) trials.push(JSON.parse(line) as TrialResult);
  return { meta, trials };
}
