// A forked step as an eval case: the stored request of the step's model call
// saved in a suite (evals/<suite>/requests/<case>.json), run by `eval run`
// with the project's context files as they are at run time, and graded on its
// next action (graders/next-action.ts). The recorded failing action goes under
// mustNot, so the case fails until the harness keeps the agent off it.
//
// The "request" task kind: input `{ "request": "requests/<case>.json" }`
// (relative to the suite dir), output the reply's first action, text and tool
// calls, with the tool calls as the trace for `calls` graders.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pricesFor, type Prices } from "../core/pricing.ts";
import type { TraceEvent } from "../datasets/types.ts";
import type { FetchLike } from "../judge/http.ts";
import type { StoredRequest } from "../proxy/calls.ts";
import { proxySettings } from "../proxy/state.ts";
import type { FirstAction } from "../proxy/wire.ts";
import type { CallsSpec } from "../toolevals/calls.ts";
import { loadContextFiles, type ContextFile } from "./continuation.ts";
import { rewriteHarness, type ForkResult } from "./fork.ts";
import { hasReplayAuth, REPLAY_KEY_ENV, REPLAY_OAUTH_ENV, sendReplay, type ReplayCase } from "./replay.ts";
import { withTrace } from "./run.ts";
import { TaskError, type ResolvedTask } from "./task.ts";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface RequestTask {
  kind: "request";
  /** Context files laid into each stored request, read at run time relative to `cwd`. */
  context?: { files: (string | ContextFile)[] };
  /** Send with this model instead of the recorded one. */
  model?: string;
  system?: string;
  systemFile?: string;
  /** Where case request files resolve (eval run sets the suite dir). Default `cwd`. */
  dir?: string;
  /** Project root. Default process.cwd(). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  prices?: Prices;
  upstreams?: { anthropic: string; openai: string };
  timeoutMs?: number;
}

/** A stored request as saved in a suite: the proxy's request document plus the session's directory (for matching context paths). */
export interface SavedRequest extends StoredRequest {
  cwd?: string;
}

function readSaved(file: string): SavedRequest {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new TaskError(`request task: can't read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObj(v) || !isObj(v.body) || typeof v.api !== "string") throw new TaskError(`request task: ${file} is not a stored request (needs api and body)`);
  return v as unknown as SavedRequest;
}

export function requestTask(spec: RequestTask): ResolvedTask {
  const cwd = spec.cwd ?? process.cwd();
  const dir = spec.dir ?? cwd;
  const env = spec.env ?? process.env;
  const files = loadContextFiles(spec.context?.files ?? [], cwd);
  const set: Record<string, unknown> = {};
  if (spec.model) set.model = spec.model;
  if (spec.systemFile) set.system = readFileSync(resolve(cwd, spec.systemFile), "utf8");
  else if (spec.system !== undefined) set.system = spec.system;
  const prices = spec.prices ?? pricesFor();
  const upstreams = spec.upstreams ?? proxySettings(env).upstreams;
  return {
    info: { kind: "request", ref: `request:${files.map((f) => f.path).join(",") || "recorded"}${spec.model ? `@${spec.model}` : ""}` },
    async run(input, ctx) {
      const rel = isObj(input) && typeof input.request === "string" ? input.request : undefined;
      if (!rel) throw new TaskError('request task: each case input needs "request": the path of a stored request');
      const saved = readSaved(resolve(dir, rel));
      const provider = saved.provider === "anthropic" ? "anthropic" : "openai";
      if (!hasReplayAuth(provider, env)) throw new TaskError(`request task: set ${REPLAY_KEY_ENV[provider]}${provider === "anthropic" ? ` or ${REPLAY_OAUTH_ENV}` : ""} to call the model`);
      const { body } = rewriteHarness(saved.api, saved.body, { files, remove: [] }, saved.cwd);
      const rc: ReplayCase = { provider, api: saved.api, call: { event: { id: ctx.caseId, v: 0, sessionId: "", ts: 0, agent: "proxy", kind: "llm.call", payload: {} }, request: { ...saved, body } } };
      const out = await sendReplay(rc, set, { upstreams, env, prices, ...(spec.fetch ? { fetch: spec.fetch } : {}), ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) });
      const now = Date.now();
      const trace: TraceEvent[] = out.toolCalls.map((c, i) => ({ id: `t${i}`, kind: "tool.start", ts: now + i, payload: { tool: c.name, input: c.input } }));
      return withTrace(out, trace);
    },
  };
}

// ---------------------------------------------------------------- saving

/**
 * Arguments that say how or why, not what: the same action sampled again carries
 * another `description` ("Run the tests" vs "Run the test suite") or timeout, so a
 * case that matched them would miss the very action it forbids.
 */
const INCIDENTAL = new Set(["description", "explanation", "justification", "reason", "timeout", "timeout_ms", "run_in_background", "sandbox_permissions", "with_escalated_permissions"]);

/** The recorded call's arguments as a match: incidental ones dropped, a shell command matched anywhere in the command line (`npm test 2>&1` is still npm test). */
function actionArgs(input: unknown): Record<string, unknown> | undefined {
  if (!isObj(input)) return undefined;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (INCIDENTAL.has(k)) continue;
    args[k] = (k === "command" || k === "cmd") && typeof v === "string" && v.trim() ? `~${v.trim()}` : v;
  }
  return Object.keys(args).length ? args : undefined;
}

/** What a forked step's case expects of the next turn: never the recorded action; the forked tool when the fork agreed on one. */
export function caseExpectation(recorded: FirstAction | undefined, fork: ForkResult | undefined): CallsSpec | undefined {
  if (recorded?.type === "tool" && recorded.name) {
    const args = actionArgs(recorded.input);
    return { mustNot: [{ tool: recorded.name, ...(args ? { args } : {}) }] };
  }
  // A text reply the agent should not have stopped at: the fork's tool, when every trial called it first.
  const tools = new Set((fork?.trials ?? []).map((t) => (t.action?.type === "tool" ? t.action.name : undefined)));
  const [only] = [...tools];
  if (tools.size === 1 && only) return { must: [{ tool: only }] };
  return undefined;
}

export interface SaveForkCase {
  /** The suite dir (evals/<suite>). */
  dir: string;
  suite: string;
  caseId: string;
  request: SavedRequest;
  expected: CallsSpec;
  /** Context files the suite lays in at run time (project-relative). */
  contextFiles: string[];
  metadata: Record<string, unknown>;
}

/**
 * Writes the case: the request file, a line in cases.jsonl (replacing one with
 * the same id), and suite.json when the suite is new (a regression suite of
 * request cases graded by next-action). Returns whether the suite was created.
 */
export async function saveForkCase(o: SaveForkCase): Promise<{ created: boolean; requestFile: string }> {
  const suiteFile = join(o.dir, "suite.json");
  let created = false;
  let spec: Record<string, unknown>;
  if (existsSync(suiteFile)) {
    spec = JSON.parse(await readFile(suiteFile, "utf8")) as Record<string, unknown>;
    const task = isObj(spec.task) ? spec.task : undefined;
    if (typeof spec.cases !== "string" || task?.kind !== "request") throw new TaskError(`${suiteFile} is not a suite of forked steps (it needs "cases" and a "request" task); pick another --save-case name`);
    const ctxFiles = isObj(task.context) && Array.isArray(task.context.files) ? (task.context.files as unknown[]).filter((f): f is string => typeof f === "string") : [];
    const merged = [...new Set([...ctxFiles, ...o.contextFiles])];
    if (merged.length !== ctxFiles.length) {
      spec.task = { ...task, context: { files: merged } };
      await writeFile(suiteFile, `${JSON.stringify(spec, null, 2)}\n`);
    }
  } else {
    created = true;
    spec = {
      name: o.suite,
      purpose: "regression",
      description: "Steps where the agent went wrong, forked from captured sessions (coding.sh replay --fork --save-case). Each case sends the step's stored request with the project's context files as they are now.",
      cases: "cases.jsonl",
      trials: 3,
      task: { kind: "request", context: { files: o.contextFiles } },
      graders: [{ kind: "next-action" }],
    };
    await mkdir(o.dir, { recursive: true });
    await writeFile(suiteFile, `${JSON.stringify(spec, null, 2)}\n`);
  }
  const requestRel = `requests/${o.caseId}.json`;
  await mkdir(join(o.dir, "requests"), { recursive: true });
  await writeFile(join(o.dir, requestRel), `${JSON.stringify(o.request)}\n`);
  const casesFile = join(o.dir, String(spec.cases));
  const lines = existsSync(casesFile) ? (await readFile(casesFile, "utf8")).split("\n").filter((l) => l.trim()) : [];
  const kept = lines.filter((l) => {
    try {
      return (JSON.parse(l) as { id?: unknown }).id !== o.caseId;
    } catch {
      return true;
    }
  });
  kept.push(JSON.stringify({ id: o.caseId, input: { request: requestRel }, expected: o.expected, metadata: o.metadata, tags: ["fork"] }));
  await writeFile(casesFile, `${kept.join("\n")}\n`);
  return { created, requestFile: join(o.dir, requestRel) };
}
