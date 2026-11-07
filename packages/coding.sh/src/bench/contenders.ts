// Contenders: what a benchmark compares. Command and HTTP contenders reuse the
// experiment task adapters (src/experiments/task.ts); agent contenders run a
// coding agent headless through its adapter in a throwaway work dir with an
// isolated config home, the same way toolevals' agent driver does.
//
// Any contender may answer with an envelope to report cost, tokens, a session
// id or its own failure reason:
//   {"output": …, "usage": {"costUsd": 0.002, "inputTokens": 900, "outputTokens": 120}, "sessionId": "…", "failure": "blocked"}
// Token counts may also include cacheReadTokens and cacheWriteTokens. With
// tokens and a model but no cost, the runner prices the call from the price table.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Adapter, BlobStore, HarnessBundle, Usage } from "../core/types.ts";
import { resolveTask, safeUrl, type ResolvedTask, type TaskSpec } from "../experiments/task.ts";
import type { AgentContender, ContenderSpec, TokenUsage } from "./types.ts";

export interface Answer {
  output: unknown;
  costUsd?: number;
  tokens?: number;
  /** Token counts by kind, when the contender reported them. */
  usage?: TokenUsage;
  sessionId?: string;
  /** Contender-reported failure reason (blocked, login-wall, quota, …). */
  failure?: string;
  /** Model the contender says it used. */
  model?: string;
}

export interface ContenderRunCtx {
  runId: string;
  caseId: string;
  trial: number;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ResolvedContender {
  name: string;
  kind: string;
  ref: string;
  /** Agent CLI version (detected) or the configured label. */
  version(): Promise<string | undefined>;
  run(input: unknown, ctx: ContenderRunCtx): Promise<Answer>;
}

export interface ContenderDeps {
  /** Definition directory: command contenders run here. */
  baseDir: string;
  /** The benchmark's one time limit, applied to every contender. */
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  /** Agent contenders. */
  getAdapter?: (id: string) => Adapter | undefined;
  getBundle?: (ref: string) => Promise<HarnessBundle | undefined>;
  blobs?: BlobStore;
  /** Scratch root for agent work dirs (default: os tmpdir). */
  scratch?: string;
}

const ENVELOPE_KEYS = new Set(["output", "usage", "costUsd", "tokens", "sessionId", "failure", "metadata", "model"]);

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function usageTokens(u: Usage | Record<string, unknown> | undefined): number | undefined {
  if (!u) return undefined;
  const r = u as Record<string, unknown>;
  const total = num(r.totalTokens);
  if (total !== undefined) return total;
  const parts = [num(r.inputTokens), num(r.outputTokens)].filter((x): x is number => x !== undefined);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : undefined;
}

const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

/** Token counts by kind; undefined when none are reported. */
export function tokenUsage(u: Usage | Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!u) return undefined;
  const r = u as Record<string, unknown>;
  const out: TokenUsage = {};
  for (const k of USAGE_KEYS) {
    const v = num(r[k]);
    if (v !== undefined && v >= 0) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Unwrap {"output", "usage", …}; anything else is the output as is. */
export function unwrapAnswer(raw: unknown): Answer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { output: raw };
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (!("output" in o) || !keys.every((k) => ENVELOPE_KEYS.has(k)) || keys.length < 2) return { output: raw };
  const a: Answer = { output: o.output };
  const usage = o.usage && typeof o.usage === "object" ? (o.usage as Record<string, unknown>) : undefined;
  const cost = num(o.costUsd) ?? num(usage?.costUsd);
  if (cost !== undefined) a.costUsd = cost;
  const tokens = num(o.tokens) ?? usageTokens(usage);
  if (tokens !== undefined) a.tokens = tokens;
  const tu = tokenUsage(usage);
  if (tu) a.usage = tu;
  if (typeof o.sessionId === "string" && o.sessionId) a.sessionId = o.sessionId;
  if (typeof o.failure === "string" && o.failure.trim()) a.failure = o.failure.trim().slice(0, 40);
  const meta = o.metadata && typeof o.metadata === "object" ? (o.metadata as Record<string, unknown>) : undefined;
  const model = o.model ?? meta?.model;
  if (typeof model === "string" && model.trim()) a.model = model.trim().slice(0, 120);
  return a;
}

/** {{input}} and {{metadata.key}} / {{input.key}} placeholders. */
export function renderPrompt(template: string, input: unknown, metadata?: Record<string, unknown>): string {
  const text = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2));
  return template.replace(/\{\{\s*(input|metadata)((?:\.[\w-]+)*)\s*\}\}/g, (_m, root: string, path: string) => {
    let v: unknown = root === "input" ? input : metadata;
    for (const k of path.split(".").filter(Boolean)) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    return text(v);
  });
}

/** The agent's final answer from its headless stdout (stream-json result lines, else the raw tail). */
export function agentAnswerText(stdoutTail: string): string {
  const lines = stdoutTail.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l.startsWith("{")) continue;
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      for (const k of ["result", "text", "message", "content"]) if (typeof o[k] === "string") return o[k] as string;
      const item = o.item as Record<string, unknown> | undefined;
      if (item && typeof item.text === "string") return item.text;
    } catch {
      // not JSON: keep looking
    }
  }
  return stdoutTail.trim();
}

function agentContender(spec: AgentContender & { name: string }, deps: ContenderDeps): ResolvedContender {
  const ref = `${spec.agent}${spec.model ? `:${spec.model}` : ""}${spec.harness ? ` +${spec.harness}` : ""}`;
  let detected: Promise<string | undefined> | undefined;
  return {
    name: spec.name,
    kind: "agent",
    ref,
    version() {
      detected ??= (async () => {
        try {
          return (await deps.getAdapter?.(spec.agent)?.detect())?.version;
        } catch {
          return undefined;
        }
      })();
      return detected;
    },
    async run(input, ctx) {
      const adapter = deps.getAdapter?.(spec.agent);
      if (!adapter) throw new Error(`unknown agent ${JSON.stringify(spec.agent)}`);
      if (!adapter.run) throw new Error(`${spec.agent} has no headless mode`);
      let bundle: HarnessBundle | undefined;
      if (spec.harness) {
        bundle = await deps.getBundle?.(spec.harness);
        if (!bundle) throw new Error(`harness ${JSON.stringify(spec.harness)} not found (coding.sh harness list)`);
      }
      const { tmpdir } = await import("node:os");
      const scratch = deps.scratch ?? tmpdir();
      await mkdir(scratch, { recursive: true });
      const root = await mkdtemp(join(scratch, "bench-"));
      const work = join(root, "work");
      const home = join(root, "home");
      await mkdir(work, { recursive: true });
      await mkdir(home, { recursive: true });
      try {
        const b: HarnessBundle = bundle ?? { id: "bench-empty", name: "bench-empty", agent: spec.agent, flags: [], env: {}, files: {}, remove: [], createdAt: 0 };
        if (bundle && deps.blobs) {
          const { applyBundle } = await import("../runner/bundle.ts");
          await applyBundle(bundle, work, deps.blobs, { home });
        }
        const overlay = adapter.overlay ? await adapter.overlay(b, work, { workDir: work, runRoot: root, home }) : { env: {}, flags: [] };
        const instruction = renderPrompt(spec.prompt ?? "{{input}}", input, ctx.metadata);
        const model = spec.model ?? b.model;
        const out = await adapter.run({
          cwd: work,
          instruction,
          ...(model ? { model } : {}),
          env: { ...b.env, ...overlay.env, CODING_SH_RUN_ID: `${ctx.runId}:${ctx.caseId}:${ctx.trial}` },
          timeoutMs: deps.timeoutMs,
          flags: [...b.flags, ...overlay.flags, ...(spec.flags ?? [])],
          runId: ctx.runId,
        });
        if (out.timedOut) throw new Error(`timed out after ${deps.timeoutMs} ms`);
        if (out.exitCode !== 0) throw new Error(`exited ${out.exitCode}: ${out.stderrTail.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
        const a: Answer = { output: agentAnswerText(out.stdoutTail) };
        if (out.usage?.costUsd !== undefined) a.costUsd = out.usage.costUsd;
        const t = usageTokens(out.usage);
        if (t !== undefined) a.tokens = t;
        const tu = tokenUsage(out.usage);
        if (tu) a.usage = tu;
        if (out.sessionId) a.sessionId = out.sessionId;
        if (model) a.model = model;
        return a;
      } finally {
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

export function resolveContender(spec: ContenderSpec, deps: ContenderDeps): ResolvedContender {
  if (spec.kind === "agent") return agentContender(spec, deps);
  const { name: _n, costPerRun: _c, version: label, ...rest } = spec as ContenderSpec & Record<string, unknown>;
  let task: ResolvedTask;
  if (spec.kind === "command") {
    task = resolveTask({ ...(rest as object), kind: "command", timeoutMs: deps.timeoutMs, cwd: resolve(deps.baseDir, (rest as { cwd?: string }).cwd ?? ".") } as TaskSpec);
  } else {
    task = resolveTask({ ...(rest as object), kind: "http", timeoutMs: deps.timeoutMs, env: deps.env } as TaskSpec);
  }
  return {
    name: spec.name,
    kind: spec.kind,
    ref: spec.kind === "http" ? `${spec.method ?? "POST"} ${safeUrl(spec.url)}` : task.info.ref,
    version: async () => (typeof label === "string" ? label : undefined),
    async run(input, ctx) {
      return unwrapAnswer(await task.run(input, ctx));
    },
  };
}
