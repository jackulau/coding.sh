// What an experiment evaluates. Four adapters so ANY agent can be measured:
//  - a JS function `(input, ctx) => output`
//  - a command (any language): case input JSON on stdin, output on stdout,
//    CODING_SH_RUN_ID / CODING_SH_CASE_ID / CODING_SH_TRIAL in the env
//  - an HTTP endpoint: POST JSON, response JSON (or text) is the output
//  - a next-turn continuation (continuation.ts): the case input is a frozen
//    session prefix, the output is one model turn under a harness variant
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { extractJson } from "../judge/extract.ts";
import { queryJsonPath } from "../graders/json-path.ts";
import { describeFailure, formatArgv, runProcess, type CommandSpec } from "../graders/proc.ts";
import type { TaskInfo } from "../datasets/types.ts";
import type { FetchLike } from "../judge/http.ts";
import { continuationTask, type ContinuationTask } from "./continuation.ts";
import { requestTask, type RequestTask } from "./fork-case.ts";

export interface TaskContext {
  runId: string;
  caseId: string;
  trial: number;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export type TaskFn = (input: unknown, ctx: TaskContext) => unknown;

export interface CommandTask extends CommandSpec {
  kind: "command";
  /** How to read stdout: "json" (must parse), "text" (trimmed string), "auto" (JSON if it parses). Default "auto". */
  output?: "json" | "text" | "auto";
  /** Send `{input, caseId, trial, metadata}` instead of the bare input. Default false. */
  envelope?: boolean;
}

export interface HttpTask {
  kind: "http";
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  /** Header name → env var holding its value (secrets stay out of config files). */
  headerEnv?: Record<string, string>;
  /** Send `{input, caseId, trial, runId, metadata}` instead of the bare input. Default false. */
  envelope?: boolean;
  /** JSON path selecting the output from the response, e.g. "$.output". */
  responsePath?: string;
  /** "json" (default; falls back to text when the body is not JSON) or "text". */
  response?: "json" | "text";
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

export interface FunctionTask {
  kind: "function";
  fn: TaskFn;
  name?: string;
}

export type TaskSpec = TaskFn | FunctionTask | CommandTask | HttpTask | ContinuationTask | RequestTask;

export interface ResolvedTask {
  info: TaskInfo;
  run(input: unknown, ctx: TaskContext): Promise<unknown>;
}

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

/** URL for display: no credentials, no query string (it may carry tokens). */
export function safeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "(invalid url)";
  }
}

/**
 * Split a command line into argv the way a POSIX shell would for words:
 * whitespace separates, '…' is literal, "…" and bare text honor backslash
 * escapes. No expansion, globbing, pipes or redirects: there is no shell.
 */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else cur += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) cur += line[++i];
      else cur += ch;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      inWord = true;
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "\\" && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    }
  }
  if (quote) throw new TaskError(`unterminated ${quote} quote in command ${JSON.stringify(line)}; pass the program as "command" and its arguments as "args": [...]`);
  if (inWord) out.push(cur);
  return out;
}

/**
 * `{"command": "python3 agent.py"}` with no `args` means a command line, not
 * a program literally named "python3 agent.py" (unless a file by that exact
 * path exists): split it into command + args.
 */
function normalizeCommand(spec: CommandTask): CommandTask {
  if (spec.args?.length || !/\s/.test(spec.command.trim())) return spec;
  if (existsSync(resolve(spec.cwd ?? process.cwd(), spec.command))) return spec;
  const [command, ...args] = splitCommandLine(spec.command);
  if (!command) throw new TaskError(`command task: "command" is empty`);
  return { ...spec, command, args };
}

function commandTask(raw: CommandTask): ResolvedTask {
  const spec = normalizeCommand(raw);
  const mode = spec.output ?? "auto";
  return {
    info: { kind: "command", ref: formatArgv(spec) },
    async run(input, ctx) {
      const stdin = JSON.stringify(spec.envelope ? { input, caseId: ctx.caseId, trial: ctx.trial, metadata: ctx.metadata } : input) ?? "null";
      const r = await runProcess({
        ...spec,
        env: { ...(spec.env ?? {}), CODING_SH_RUN_ID: ctx.runId, CODING_SH_CASE_ID: ctx.caseId, CODING_SH_TRIAL: String(ctx.trial) },
        stdin,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (r.spawnError || r.timedOut || r.exitCode !== 0) throw new TaskError(`${formatArgv(spec)}: ${describeFailure(r, spec.timeoutMs)}`);
      const out = r.stdout.trim();
      if (mode === "text") return out;
      try {
        return JSON.parse(out) as unknown;
      } catch {
        if (mode === "json") {
          const found = extractJson(out);
          if (found === undefined) throw new TaskError(`${formatArgv(spec)}: stdout is not JSON: ${out.slice(0, 200)}`);
          return found;
        }
        return out;
      }
    },
  };
}

function httpTask(spec: HttpTask): ResolvedTask {
  const doFetch: FetchLike = spec.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const env = spec.env ?? process.env;
  return {
    info: { kind: "http", ref: `${spec.method ?? "POST"} ${safeUrl(spec.url)}` },
    async run(input, ctx) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        "x-coding-sh-run-id": ctx.runId,
        "x-coding-sh-case-id": ctx.caseId,
        ...(spec.headers ?? {}),
      };
      for (const [h, name] of Object.entries(spec.headerEnv ?? {})) {
        const v = env[name];
        if (!v) throw new TaskError(`http task: env ${name} (for header ${h}) is not set`);
        headers[h] = v;
      }
      const body = spec.envelope ? { input, caseId: ctx.caseId, trial: ctx.trial, runId: ctx.runId, metadata: ctx.metadata } : input;
      const ctrl = new AbortController();
      const timeoutMs = spec.timeoutMs ?? 120_000;
      const timer = setTimeout(() => ctrl.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      const onAbort = () => ctrl.abort(ctx.signal?.reason);
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      let text: string;
      try {
        res = await doFetch(spec.url, { method: spec.method ?? "POST", headers, body: JSON.stringify(body) ?? "null", signal: ctrl.signal });
        text = await res.text();
      } catch (e) {
        const why = ctrl.signal.aborted && ctrl.signal.reason instanceof Error ? ctrl.signal.reason.message : (e as Error).message;
        throw new TaskError(`${safeUrl(spec.url)}: ${why}`);
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
      }
      if (!res.ok) throw new TaskError(`${safeUrl(spec.url)}: HTTP ${res.status}: ${text.slice(0, 300)}`);
      if (spec.response === "text") return text;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return text;
      }
      if (spec.responsePath) {
        const hits = queryJsonPath(value, spec.responsePath);
        if (hits.length === 0) throw new TaskError(`${safeUrl(spec.url)}: ${spec.responsePath} not found in response`);
        return hits.length === 1 ? hits[0] : hits;
      }
      return value;
    },
  };
}

export function resolveTask(spec: TaskSpec): ResolvedTask {
  if (typeof spec === "function") {
    return { info: { kind: "function", ref: spec.name || "(anonymous)" }, run: async (input, ctx) => spec(input, ctx) };
  }
  if (spec.kind === "function") {
    const fn = spec.fn;
    return { info: { kind: "function", ref: spec.name ?? (fn.name || "(anonymous)") }, run: async (input, ctx) => fn(input, ctx) };
  }
  if (spec.kind === "command") return commandTask(spec);
  if (spec.kind === "http") return httpTask(spec);
  if (spec.kind === "continuation") return continuationTask(spec);
  if (spec.kind === "request") return requestTask(spec);
  throw new TaskError(`unknown task kind ${JSON.stringify((spec as { kind?: unknown }).kind)}`);
}
