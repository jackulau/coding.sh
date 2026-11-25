// Session aggregation and failure-pattern detection. A fold over a session's
// events in time order (SessionState): buildSession folds them all; live
// ingest saves the state and folds only what was appended since (see
// recomputeSession in core/ingest.ts). Both give the same row.
import { GATEWAY_FLAG, gatewayFlagsOf, gatewayOfEvent } from "../integrations/gateway/ids.ts";
import type { GatewayId } from "../integrations/gateway/providers.ts";
import { DERAIL_FLAGS, derailsOf, derailState, detectDerails, foldDerails, type Derail, type DerailState } from "./derail.ts";
import { foldOutline, outlineOf, outlineState, phasesToStore, REOPEN_SLACK_MS, type OutlineState } from "./outline.ts";
import type { AgentEvent, CostByTokenType, DuplicateUsage, LatencyStats, LlmErrors, PullRequestRef, Session, Usage } from "../schema/index.ts";
import { splitOf, tokenCount as count } from "./pricing.ts";
import { DURABLE_FLAGS, durableFlags, durableStats } from "./durable.ts";
import { detectTestTamper, foldTamper, tamperState, type TamperState } from "./intent.ts";
// waste.ts and skills-use.ts import commandOf and FLAGS back from here, inside functions only.
import { cacheBreakState, cacheBreaksOf, cacheUnderused, foldCacheBreaks, type CacheBreakState } from "./cache-breaks.ts";
import { foldSkills, skillFlags, skillState, skillUseOf, type SkillState } from "./skills-use.ts";
import { foldMemoryUse, memoryUseOf, memoryUseState, type MemoryUseState } from "./memory-use.ts";
import { foldHookContext, hookContextFlags, hookContextOf, hookContextState, type HookContextState } from "./hook-context.ts";
import { foldWaiting, waitingOf, waitingState, type WaitingState } from "./waiting.ts";
// wait-stats.ts imports DELEGATED_NOTICE, isSyntheticPrompt and percentile back from here, inside functions only.
import { foldWaitStats, waitStatsOf, waitStatsState, type WaitStatsState } from "./wait-stats.ts";
import { shellCommandsInCode } from "./cells.ts";
import { claimsSuccess, reportsFailure } from "./failure-report.ts";
import { failureState, foldFailure, shellCommandOf, type FailureClass, type FailureState } from "./failures.ts";
import { compactionRefetchStatsOf, foldWaste, wasteState, wasteStatsOf, type WasteState } from "./waste.ts";
import { foldModels, mainModelOf, MODEL_FALLBACK, MODEL_SWITCH, modelFlags, modelState, modelSwitchOf, modelsOf, REFUSAL, type ModelState } from "./models.ts";
import { exposesSecret, foldRedactions, redactionsOf, redactionState, SECRET_EXPOSED, type RedactionState } from "./redaction-stats.ts";
import { foldUnapproved, unapprovedOf, unapprovedState, type UnapprovedState } from "./unapproved.ts";
import { foldWeightEdits, weightEditFlags, weightEditsOf, weightEditState, WEIGHTS_CHECKPOINT, WEIGHTS_EDITED, type WeightEditState } from "./weights.ts";
import { driveOf, onDrive, traceRoot, underTraceRoot } from "./shell-diff.ts";
import { commandField } from "./shell-tools.ts";
import { shellCallFiles } from "./shell-files.ts";
import { foldRetrieval, markRetrievalEdit, retrievalOf, retrievalState, type RetrievalState } from "./retrieval.ts";
import { callStatsOf, foldTurnStats, turnsByModelOf, turnStatsState, type TurnStatsState } from "./turn-stats.ts";

export { REOPEN_SLACK_MS };

export const FLAGS = {
  prematureCompletion: "premature-completion",
  repeatedToolFailure: "repeated-tool-failure",
  noVerification: "no-verification",
  compaction: "compaction",
  /** A test, runner config or CI file was skipped, deleted, or changed so failing tests went green (core/intent.ts). */
  testTamper: "test-tamper",
  /** Durable workflow runs (Session.stats.durable): a step ran again after failing. */
  stepRetried: DURABLE_FLAGS.stepRetried,
  /** Durable workflow runs: the run continued after a crash, a deploy or a worker restart. */
  resumed: DURABLE_FLAGS.resumed,
  /** A tag, not a failure: model calls went through Vercel AI Gateway. Other gateways get "gateway:<id>". */
  gateway: GATEWAY_FLAG,
  /** Three or more read-only calls repeated with an unchanged result in one context (core/waste.ts, Session.stats.waste). */
  duplicateFetch: "duplicate-fetch",
  /** One skill name loaded from two directories, e.g. a project copy and a personal copy (core/skills-use.ts). */
  skillCopyConflict: "skill-copy-conflict",
  /** A tag, not a failure: redaction replaced a vendor token (core/redaction-stats.ts, Session.stats.redactions). Rotate it. */
  secretExposed: SECRET_EXPOSED,
  /** A tag, not a failure: the model changed mid-session (core/models.ts, Session.stats.modelSwitch). */
  modelSwitch: MODEL_SWITCH,
  /** A tag, not a failure: the agent recorded a fallback to another model (Claude Code's model_fallback, model_refusal_fallback). */
  modelFallback: MODEL_FALLBACK,
  /** A model call stopped on a refusal or a content filter (core/models.ts). */
  refusal: REFUSAL,
  /** The model wrote a tool call out as text, so it never ran: the tool was not available to it (writesToolCallAsText). */
  textToolCall: "text-tool-call",
  /** The model API held the session up with rate limits or overload (429, 529): see API_STALL. */
  apiStall: "api-stall",
  /** The session's last failed model call (not a rate limit or overload: see apiStall) was never followed by a call that worked, a reply or a tool call. */
  llmError: "llm-error",
  /** A tag, not a failure: the session's source records model calls only (an SDK call outside trace(), the proxy), so its tool count is unknown, not 0. */
  toolsUnseen: "tools:unseen",
  /** The agent ran a destructive or paid command (rm -rf, git reset --hard, a tool's repair --yes, …) that the user's last turn had not approved (core/unapproved.ts, Session.stats.unapprovedActions). */
  unapprovedAction: "unapproved-action",
  /** A tag, not a failure: the session wrote a prompt cache it barely read back (core/cache-breaks.ts cacheUnderused). */
  cacheLow: "cache:low",
  /** A tag, not a failure: the session recorded a weight edit (core/weights.ts, Session.stats.weightEdits). */
  weightsEdited: WEIGHTS_EDITED,
  /** A tag, not a failure: the session recorded the hash of a weights file it saved (core/weights.ts, Session.stats.weightEdits.checkpoints). */
  weightsCheckpoint: WEIGHTS_CHECKPOINT,
  /** A tag, not a failure: coding.sh could not fold the session's events into its stats (Session.stats.foldError, core/ingest.ts recomputeSession). */
  foldError: "fold:error",
  /** Derails (core/derail.ts): where the session went off the rails. */
  ...DERAIL_FLAGS,
} as const;

/** Flags that name a failure pattern. Namespaced flags ("gateway:vercel") are tags. */
export const failureFlags = (flags: readonly string[]): string[] => flags.filter((f) => !f.includes(":"));

/** Events written by enrichment (`coding.sh gateway enrich`): they never decide a session's shape. */
const isEnrichment = (e: AgentEvent): boolean => e.source === "gateway";

/**
 * The call a gateway companion billed: its parent, when the companion carries a
 * billed cost (`payload.billedCostUsd`, or the correction to the call's cost in
 * its usage). One with neither (a usage record the gateway did not price) bills
 * nothing: the call's estimate stays an estimate.
 */
export function billedCallOf(e: AgentEvent): string | undefined {
  if (!isEnrichment(e) || !e.parentId) return undefined;
  return num(e.payload?.billedCostUsd) !== undefined || num(e.usage?.costUsd) !== undefined ? e.parentId : undefined;
}

/** The gateway generation a billing companion carries (`payload.gateway` and `payload.generationId`), as one key. */
const generationOf = (e: AgentEvent): string | undefined => {
  const id = e.payload?.generationId;
  return billedCallOf(e) && typeof id === "string" && id ? `${String(e.payload?.gateway ?? "")}\u0000${id}` : undefined;
};

/** A model call logged by `coding.sh proxy`. */
const isProxyCall = (e: AgentEvent): boolean => e.kind === "llm.call" && e.source === "proxy";

/** A model call or tool event the agent's OTLP logs carry (`otel-log`): a copy of what its transcript records, when the session has one. */
const isOtelLogCopy = (e: AgentEvent): boolean => e.source === "otel-log" && (e.kind === "llm.call" || e.kind === "tool.start" || e.kind === "tool.end");

export const TITLE_MAX = 280;
/** Cap on Session.traceIds (a long-lived conversation can span many traces). */
export const MAX_TRACE_IDS = 256;

/** Shell commands that verify work: tests, type checks, linters, builds. */
const VERIFY_COMMAND = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|typecheck|lint|build|verify)\b`,
    String.raw`\b(?:pytest|py\.test|tox|nox|jest|vitest|mocha|ava|tap|rspec|phpunit|ctest|tsc|mypy|pyright|ruff|eslint|clippy)\b`,
    String.raw`\b(?:go|cargo|deno|bun|mix|dotnet|swift|zig|gradle|gradlew|mvn|sbt|stack|cabal)\s+(?:\S+\s+)*?test\b`,
    String.raw`\bcargo\s+(?:check|clippy|build)\b`,
    String.raw`\bnode\s+(?:\S+\s+)*?--test\b`,
    String.raw`\bpython3?\s+-m\s+(?:pytest|unittest|mypy)\b`,
    String.raw`\bmake\s+(?:test|check|lint|verify)\b`,
    String.raw`\bnpx\s+(?:tsc|jest|vitest|playwright|eslint)\b`,
  ].join("|"),
  "i",
);

/**
 * Extracts a shell command from common tool input shapes across agents: the
 * first command key (core/shell-tools.ts; Antigravity's `run_command` names it
 * `CommandLine`), an argv array joined with spaces. A REPL cell (`{code}`, no
 * command key) gives the shell commands its code runs (core/cells.ts), joined
 * with " && ", or undefined when it runs none.
 */
export function commandOf(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return undefined;
  const c = commandField(input);
  if (c !== undefined) return typeof c === "string" ? c : c.join(" ");
  const code = (input as Record<string, unknown>).code;
  if (typeof code === "string") {
    const cmds = shellCommandsInCode(code);
    if (cmds.length) return cmds.join(" && ");
  }
  return undefined;
}

export function isVerifyCommand(command: string | undefined): boolean {
  return !!command && VERIFY_COMMAND.test(command);
}

/** True for a tool.start whose input runs a test/check (or was marked so before metadata stripping). */
export function isVerifyToolStart(e: AgentEvent): boolean {
  if (e.kind !== "tool.start") return false;
  if (e.payload.verify === true) return true;
  return isVerifyCommand(commandOf(e.payload.input));
}

/** Events in time order; ties keep their order. */
export const byTime = (events: AgentEvent[]): AgentEvent[] =>
  events.map((e, i) => ({ e, i })).sort((a, b) => a.e.ts - b.e.ts || a.i - b.i).map((x) => x.e);

/** A workflow harness's frame line, and the `Project:` header a frame's task starts with. */
const HARNESS_FRAME = /^[ \t]*\[Workflow harness\b/;
const PROJECT_HEADER = /^[ \t]*Project:/;
/**
 * Lines a title skips: a workflow harness's frame line, and a `Project:` preamble header in a
 * prompt that has a frame line (with no frame, a task that starts with "Project:" is the task).
 * Each is anchored at the start of a line (the harness indents what it wraps), so a prompt that
 * only mentions them keeps them.
 */
export const TITLE_SKIP: readonly RegExp[] = [HARNESS_FRAME, PROJECT_HEADER];
const PASTED = /<pasted_content\b[^>]*>([\s\S]*?)(?:<\/pasted_content>|$)/g;

/** The task of a prompt: outside any pasted block, without skipped lines; else the paste's first line; else undefined. */
function taskText(text: string): string | undefined {
  const pastes: string[] = [];
  const outside = text.replace(PASTED, (_, body: string) => { pastes.push(body); return "\n"; });
  const lines = outside.split("\n");
  const framed = lines.some((l) => HARNESS_FRAME.test(l));
  const kept = lines.filter((l) => !HARNESS_FRAME.test(l) && !(framed && PROJECT_HEADER.test(l))).join("\n");
  if (kept.trim()) return kept;
  for (const p of pastes) {
    const line = p.split("\n").find((l) => l.trim());
    if (line) return line;
  }
  return undefined;
}

/** The task line of a prompt (taskText); a prompt that is only skipped lines keeps its text. */
const titleText = (text: string): string => taskText(text) ?? text;

/** True for a title that is a harness frame (a prompt that was only frame lines). */
const isFrameTitle = (title: string): boolean => HARNESS_FRAME.test(title);

/**
 * A workflow agent (parent.workflowId) whose title would be a harness frame or empty is titled
 * "<phase> · <label>" from its parent link, or whichever of the two it names.
 */
function workflowAgentTitle(title: string | undefined, parent: Session["parent"] | undefined): string | undefined {
  if (!parent?.workflowId || (title?.trim() && !isFrameTitle(title))) return title;
  const named = [parent.phase, parent.label].filter((x): x is string => !!x?.trim()).join(" · ");
  return named ? makeTitle(named) : title;
}

/**
 * A phase's title (core/outline.ts) from one of its user.message texts: the prompt's task, or
 * undefined for a harness notice (isSyntheticPrompt) or a prompt that is only frame lines.
 */
export function phasePromptTitle(text: string): string | undefined {
  if (!text.trim() || isSyntheticPrompt(text)) return undefined;
  const t = taskText(text)?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 120) : undefined;
}

/** A trace tag's flag prefix (tag:prod), and the most tags one session keeps. */
const TAG_FLAG = "tag:";
const TAGS_MAX = 20;

/** Joins a session.start's payload.tags (strings) into the session's tags, keeping the first TAGS_MAX. */
function foldTags(s: SessionState, tags: unknown): void {
  if (!Array.isArray(tags)) return;
  for (const t of tags) {
    if (typeof t !== "string" || !t.trim()) continue;
    const list = (s.tags ??= []);
    if (list.length >= TAGS_MAX) return;
    if (!list.includes(t)) list.push(t);
  }
}

function makeTitle(text: string): string {
  const t = titleText(text).replace(/\s+/g, " ").trim();
  return t.length <= TITLE_MAX ? t : `${t.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Markup an agent harness injects as a "user" message (Claude Code: background
 * task completions, local command echoes, reminders). Not something the user typed.
 */
const SYNTHETIC_PROMPT = /^\s*<(task-notification|local-command-(?:stdout|stderr|caveat)|system-reminder|bash-(?:input|stdout|stderr)|user-prompt-submit-hook)>/;
/**
 * A host's delegated-task result posted back as a "user" message (T3 Code:
 * `Delegated task node:delegated-task:<id> (<name>) [completed]:` then the task's answer).
 */
export const DELEGATED_NOTICE = /^\s*Delegated task node:\S+(?: \([^\n]*?\))? \[[\w -]+\]:/;
/** A slash command echo: `<command-name>/clear</command-name> <command-message>… <command-args>…`. */
const COMMAND_PROMPT = /^\s*<command-(?:name|message|args)>/;

/** True for a user.message text the harness injected rather than the user typed (incl. slash-command echoes). */
export function isSyntheticPrompt(text: string): boolean {
  return SYNTHETIC_PROMPT.test(text) || COMMAND_PROMPT.test(text) || DELEGATED_NOTICE.test(text);
}

/** A prompt the user typed to the main agent: not a harness notice, a slash-command echo or a subagent's prompt. */
export const isRealPrompt = (e: AgentEvent): boolean => e.kind === "user.message" && !e.subagentId && typeof e.payload.text === "string" && !isSyntheticPrompt(e.payload.text);

/** "/model opus" from a slash-command echo, else undefined. */
function commandTitle(text: string): string | undefined {
  if (!COMMAND_PROMPT.test(text)) return undefined;
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(text)?.[1];
  return makeTitle(args ? `${name} ${args}` : name);
}

/** Event kinds stamped at the END of what they describe (ts = end; durationMs looks back). */
const END_KINDS: ReadonlySet<string> = new Set(["turn.end", "tool.end", "subagent.end", "session.end"]);

/** When the thing an event describes finished: ts for *.end kinds, ts + durationMs for spans stamped at their start. */
export function eventEnd(e: AgentEvent): number {
  return END_KINDS.has(e.kind) ? e.ts : e.ts + (num(e.durationMs) ?? 0);
}

/** Capture paths that replay history (a recorded transcript) rather than observe it live. */
export const BACKFILL_SOURCES: readonly string[] = ["transcript", "backfill", "store"];
export const isBackfillEvent = (e: AgentEvent): boolean => e.source !== undefined && BACKFILL_SOURCES.includes(e.source);

const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function addUsage(sum: Usage, u: Usage | undefined): void {
  if (!u) return;
  for (const k of TOKEN_KEYS) {
    const v = count(u[k]);
    if (v !== undefined) sum[k] = (sum[k] ?? 0) + v;
  }
  const cost = num(u.costUsd);
  if (cost !== undefined) sum.costUsd = (sum.costUsd ?? 0) + cost;
}

/** Estimated USD by `payload.priceTier`. */
type Tiers = Record<string, number>;
const addTiers = (into: Tiers, from: Tiers): void => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};

/**
 * An estimate in parts by token type (its call's `payload.costByTokenType`), and
 * the estimate whose call has no split that adds up to it (`unsplit`).
 */
interface Split {
  parts: CostByTokenType;
  unsplit: number;
}
const noParts = (): CostByTokenType => ({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 });
const NO_SPLIT: Readonly<Split> = Object.freeze({ parts: Object.freeze(noParts()), unsplit: 0 });
const addSplit = (into: Split, from: Split): void => {
  into.parts.cacheRead += from.parts.cacheRead;
  into.parts.cacheWrite += from.parts.cacheWrite;
  into.parts.input += from.parts.input;
  into.parts.output += from.parts.output;
  into.unsplit += from.unsplit;
};
/** The split of `est`, the estimate counted for `e`. */
const splitEstimate = (e: AgentEvent, est: number): Split => {
  if (!(est > 0)) return NO_SPLIT;
  const parts = splitOf(e.payload?.costByTokenType, est);
  return parts ? { parts, unsplit: 0 } : { parts: noParts(), unsplit: est };
};

const carriesUsage = (e: AgentEvent): boolean =>
  e.kind === "llm.call" && !!e.usage && [...TOKEN_KEYS, "costUsd" as const].some((k) => (num(e.usage![k]) ?? 0) > 0);

/** A counted call with its nested calls folded in (rollupUsage): what it adds to the session totals. */
interface Folded {
  u: Usage;
  est: number;
  tiers: Tiers;
  split: Split;
}

/** How a call in a tree of nested calls takes its cost, from the calls nested in it (rollupUsage). */
interface Nested {
  /** Its token counts: per field its own, else the sum over the calls nested in it. */
  u: Usage;
  /** billed: it counts at its bill. own: it keeps its own cost, which covers the calls nested in it. kids: it takes theirs. */
  mode: "billed" | "own" | "kids";
  /** The cost it counts holds one the agent reported or a gateway billed, so it beats an estimate above it. */
  reported: boolean;
  /** It counts a cost: its own, its bill, or one of a call nested in it. */
  priced: boolean;
}

export interface UsageRollup {
  usage: Usage;
  duplicate?: DuplicateUsage;
}

/**
 * Session usage totals from its events (sorted by time). Plain sums, except:
 * - a token count below 0 or not a finite number is skipped;
 * - only the latest usage snapshot counts (they are running totals);
 * - a model call nested inside another usage-carrying model call of the same
 *   trace (a wrapper span over a provider span) is not counted again: the
 *   outermost call takes, per field, its own value, else the sum over its
 *   nearest nested calls. A reported nested cost, even 0, beats the wrapper's estimate, even 0,
 *   and so does a billed one: the gateway companion of a nested call whose cost the wrapper takes
 *   counts with it. A call a gateway billed takes part in this with no usage of its own too, as the
 *   nested call or as the wrapper, and then has no token counts of its own, not even zeros. A billed
 *   call counts at its bill, $0 included, without its nested calls' cost, but adds the bills of the
 *   calls nested in it that are not its own generation, unless a call between them kept a cost it
 *   reported. When a call nested in it carries its generation id, as a response id or a bill's, the
 *   bill is that call's: it covers that call and the calls nested in it, and the others keep their
 *   costs. This holds at any depth; calls nested in each other in a loop count under the first of them;
 * - a gateway generation is billed once: when two companions carry one (`payload.gateway` and
 *   `payload.generationId`), as when the proxy's copy of a call and the agent's own record of it
 *   were both linked to it, the companion of a counted call holds the bill, else the first;
 * - a model call repeating the `payload.responseId` of a call counted before it, or replaying one
 *   (`payload.replay`), counts once, with the calls nested in it. A billed call with no usage of its own
 *   is checked only for a replay, when calls are nested in it: its response id can be its last step's.
 *   The calls nested in it are checked, since it counts their tokens: a repeat is left out. A nested call
 *   is checked after the call it is nested in, whatever their times. Calls nested in each other share a
 *   response id without repeating it, but a call beside any of them repeats it;
 * - `estimatedCostUsd` is the part of `costUsd` computed from the price table
 *   (`payload.costEstimated`), unless a gateway companion billed that call
 *   (its `payload.billedCostUsd`). `estimatedCostByTokenType` splits that same
 *   part, from the counted calls' `payload.costByTokenType`; reported and billed
 *   costs have no split.
 * What was left out is returned as `duplicate`. Events without trace ids sum as before.
 */
export function rollupUsage(sorted: readonly AgentEvent[]): UsageRollup {
  const billed = new Set<string>();
  // The gateway generations each billed call was billed for, and the calls billed with no generation id.
  const generations = new Map<string, Set<string>>();
  const plain = new Set<string>();
  for (const e of sorted) {
    const call = billedCallOf(e);
    if (!call) continue;
    billed.add(call);
    const g = generationOf(e);
    if (g) generations.set(call, (generations.get(call) ?? new Set<string>()).add(g));
    else plain.add(call);
  }
  const bySpan = new Map<string, AgentEvent>();
  for (const e of sorted) {
    const k = e.traceId && e.spanId ? `${e.traceId}\u0000${e.spanId}` : undefined;
    if (k && !bySpan.has(k)) bySpan.set(k, e);
  }
  const spanAbove = (e: AgentEvent): AgentEvent | undefined => (e.traceId && e.parentSpanId ? bySpan.get(`${e.traceId}\u0000${e.parentSpanId}`) : undefined);
  // A model call that carries usage, or that a gateway billed: its bill is its cost, even with no usage of its own.
  const takesPart = (e: AgentEvent): boolean => carriesUsage(e) || (e.kind === "llm.call" && billed.has(e.id));
  // The nearest such call at or above each span, within its trace, or null. A walk stops at a span a walk passed before,
  // so each span is walked once, however deep the trace.
  const nearest = new Map<AgentEvent, AgentEvent | null>();
  const callAt = (s: AgentEvent): AgentEvent | null => {
    const path: AgentEvent[] = [];
    const onPath = new Set<AgentEvent>();
    let found: AgentEvent | null = null;
    for (let cur: AgentEvent | undefined = s; cur; cur = spanAbove(cur)) {
      if (takesPart(cur)) {
        found = cur;
        break;
      }
      const known = nearest.get(cur);
      if (known !== undefined) {
        found = known;
        break;
      }
      // Spans above each other in a loop, with no such call in it.
      if (onPath.has(cur)) break;
      onPath.add(cur);
      path.push(cur);
    }
    for (const p of path) nearest.set(p, found);
    return found;
  };
  // Nearest such model call above each one, within its trace.
  const parentOf = new Map<AgentEvent, AgentEvent>();
  for (const e of sorted) {
    if (!takesPart(e)) continue;
    const s = spanAbove(e);
    const p = s && s !== e ? callAt(s) : null;
    if (p && p !== e) parentOf.set(e, p);
  }
  // Calls nested in each other in a loop (a malformed trace) would leave no outer call to count them: the first is the
  // outer one. A walk up stops at a call a walk reached before, so each call is walked once.
  const index = new Map<AgentEvent, number>();
  for (const e of parentOf.keys()) index.set(e, index.size);
  // true while the call is on the current walk.
  const walked = new Map<AgentEvent, boolean>();
  for (const e of index.keys()) {
    const path: AgentEvent[] = [];
    let p: AgentEvent | undefined = e;
    while (p && !walked.has(p)) {
      walked.set(p, true);
      path.push(p);
      p = parentOf.get(p);
    }
    if (p && walked.get(p)) {
      let first = p;
      for (let i = path.indexOf(p) + 1; i < path.length; i++) if (index.get(path[i]!)! < index.get(first)!) first = path[i]!;
      parentOf.delete(first);
    }
    for (const c of path) walked.set(c, false);
  }
  const children = new Map<AgentEvent, AgentEvent[]>();
  for (const [e, p] of parentOf) {
    const kids = children.get(p);
    if (kids) kids.push(e);
    else children.set(p, [e]);
  }
  // The trees of nested calls in one walk: `pre` lists each call before the calls nested in it, and a call's tree is the
  // `size` calls from its place `at` on.
  const pre: AgentEvent[] = [];
  const at = new Map<AgentEvent, number>();
  for (const r of children.keys()) {
    if (parentOf.has(r)) continue;
    const todo = [r];
    while (todo.length) {
      const c = todo.pop()!;
      at.set(c, pre.length);
      pre.push(c);
      const kids = children.get(c);
      if (kids) for (let i = kids.length - 1; i >= 0; i--) todo.push(kids[i]!);
    }
  }
  const size = new Map<AgentEvent, number>();
  for (let i = pre.length - 1; i >= 0; i--) {
    const c = pre[i]!;
    const n = (size.get(c) ?? 0) + 1;
    size.set(c, n);
    const p = parentOf.get(c);
    if (p) size.set(p, (size.get(p) ?? 0) + n);
  }
  // Whether `a` is a call `e` is nested in, at any depth.
  const isAbove = (a: AgentEvent, e: AgentEvent): boolean => {
    const i = at.get(a);
    const j = at.get(e);
    return i !== undefined && j !== undefined && i < j && j < i + size.get(a)!;
  };
  // The calls whose cost a bill above them covers, and the billed calls billed for a generation a call above them was.
  // A billed call covers the calls nested in it, unless one of them carries its generation id, as its response id or a
  // bill's: then the bill is that call's, and covers it and the calls nested in it, while the others keep their costs.
  const covered = new Set<AgentEvent>();
  const shared = new Set<AgentEvent>();
  if (billed.size) {
    const idOf = (g: string): string => g.slice(g.indexOf("\u0000") + 1);
    // The generation ids a call carries: its response id, when it carries usage (a wrapper's can be its last step's), and
    // those of its bills.
    const carried = (c: AgentEvent): string[] => {
      const ids = [...(generations.get(c.id) ?? [])].map(idOf);
      const rid = c.payload?.responseId;
      if (carriesUsage(c) && typeof rid === "string" && rid && !ids.includes(rid)) ids.push(rid);
      return ids;
    };
    // The places in the walk of the calls that carry each id, in order.
    const carriedAt = new Map<string, number[]>();
    for (let i = 0; i < pre.length; i++) {
      for (const id of carried(pre[i]!)) {
        const places = carriedAt.get(id);
        if (places) places.push(i);
        else carriedAt.set(id, [i]);
      }
    }
    // Whether a call nested in `c` carries `id`: the first place after c's is within its tree.
    const carriedBelow = (c: AgentEvent, id: string): boolean => {
      const places = carriedAt.get(id);
      if (!places) return false;
      const i = at.get(c)!;
      let lo = 0;
      let hi = places.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (places[mid]! <= i) lo = mid + 1;
        else hi = mid;
      }
      return lo < places.length && places[lo]! < i + size.get(c)!;
    };
    // Down each tree: how many calls above cover the ones below, and the generations of the billed calls above, as keys
    // and as ids. A call that changes them is undone at the end of its tree.
    const above: { end: number; covers: boolean; gens: string[] }[] = [];
    let cover = 0;
    const gensAbove = new Map<string, number>();
    const idsAbove = new Map<string, number>();
    const mark = (gens: string[], by: number): void => {
      for (const g of gens) {
        gensAbove.set(g, (gensAbove.get(g) ?? 0) + by);
        idsAbove.set(idOf(g), (idsAbove.get(idOf(g)) ?? 0) + by);
      }
    };
    for (let i = 0; i < pre.length; i++) {
      while (above.length && above[above.length - 1]!.end <= i) {
        const done = above.pop()!;
        if (done.covers) cover--;
        mark(done.gens, -1);
      }
      const c = pre[i]!;
      const gens = [...(generations.get(c.id) ?? [])];
      // It carries the generation of a billed call above it: that bill is its own.
      const mine = carried(c).some((id) => (idsAbove.get(id) ?? 0) > 0);
      if (cover > 0 || mine) covered.add(c);
      if (gens.some((g) => (gensAbove.get(g) ?? 0) > 0)) shared.add(c);
      const covers = mine || (billed.has(c.id) && (plain.has(c.id) || !gens.some((g) => carriedBelow(c, idOf(g)))));
      const n = size.get(c)!;
      if (n > 1 && (covers || gens.length)) {
        above.push({ end: i + n, covers, gens });
        if (covers) cover++;
        mark(gens, 1);
      }
    }
  }
  // Calls left out as repeats: one that repeats a counted call's response id or replays one, and the calls nested in it.
  const repeats = new Set<AgentEvent>();
  const estimatedOf = (e: AgentEvent): number => (e.payload?.costEstimated === true && !billed.has(e.id) ? (num(e.usage?.costUsd) ?? 0) : 0);
  // The estimate of a call priced at tier or long-context rates, under its `payload.priceTier`.
  const tiersOf = (e: AgentEvent): Tiers => {
    const est = estimatedOf(e);
    const t = e.payload?.priceTier;
    return est > 0 && typeof t === "string" && t ? { [t]: est } : {};
  };
  // The estimate of a call by token type, from its `payload.costByTokenType`.
  const splitOfEvent = (e: AgentEvent): Split => splitEstimate(e, estimatedOf(e));

  const usage: Usage = {};
  let estimated = 0;
  const byTier: Tiers = {};
  const split: Split = { parts: noParts(), unsplit: 0 };
  let snapshot: AgentEvent | undefined;
  // The calls counted so far that carry each response id.
  const responses = new Map<string, AgentEvent[]>();
  const dropped = new Set<string>();
  const usageCalls = new Set<string>();
  let raw = 0;
  let rawCost = 0;
  let counted = 0;
  let countedCost = 0;
  let calls = 0;
  const tokens = (u: Usage) => TOKEN_KEYS.reduce((s, k) => s + (count(u[k]) ?? 0), 0);
  // Decides whether a call is a repeat, after the call it is nested in: a call nested in a repeat goes with it, and the
  // response id of a call that does not count must not make a later call a repeat.
  const decide = (e: AgentEvent): void => {
    const p = parentOf.get(e);
    if (p && repeats.has(p)) {
      repeats.add(e);
      return;
    }
    // One nested in a call that carries usage is not checked: that call keeps its own counts.
    if (p && carriesUsage(p)) return;
    // A billed call with neither usage nor nested calls has no tokens to check: a copy of its bill is found by its generation.
    if (!carriesUsage(e) && !children.has(e)) return;
    // A billed call with no usage is checked by replay only. Its response id is often one of its nested calls' (a gateway's
    // generation id on a wrapper and on its last step), so a call beside it that repeats only that step would take all of
    // its tokens with it.
    const rid = carriesUsage(e) && typeof e.payload?.responseId === "string" && e.payload.responseId ? e.payload.responseId : undefined;
    const others = rid ? responses.get(rid) : undefined;
    // A call nested in a counted call with its response id is that response seen at two levels, as when a gateway's
    // generation id is on a wrapper and on its last step: not a repeat. A call beside one repeats it, also when both are
    // nested in one with the id. None is nested in this call, which is decided before the calls nested in it. A durable
    // engine replaying recorded history re-emits calls it already made (payload.replay).
    if (others?.some((r) => !isAbove(r, e)) || e.payload?.replay === true) {
      repeats.add(e);
      if (!p) {
        calls++;
        dropped.add(e.id);
      }
      return;
    }
    if (rid) responses.set(rid, [...(others ?? []), e]);
  };
  // The calls decided so far, and the nested calls that came before the call they are nested in was decided.
  const decided = new Set<AgentEvent>();
  const waiting = new Map<AgentEvent, AgentEvent[]>();
  for (const e of sorted) {
    if (isUsageSnapshot(e)) {
      // Latest snapshot wins; equal times keep the larger (running totals only grow).
      if (!snapshot || e.ts > snapshot.ts || (e.ts === snapshot.ts && tokenTotal(e.usage) >= tokenTotal(snapshot.usage))) snapshot = e;
      continue;
    }
    if (!takesPart(e)) continue;
    if (carriesUsage(e)) {
      usageCalls.add(e.id);
      raw += tokens(e.usage!);
      rawCost += num(e.usage!.costUsd) ?? 0;
    }
    const p = parentOf.get(e);
    if (p) {
      // A nested call, with a bill or without: its wrapper's fold decides what it counts.
      calls++;
      dropped.add(e.id);
      if (!decided.has(p)) {
        const kids = waiting.get(p);
        if (kids) kids.push(e);
        else waiting.set(p, [e]);
        continue;
      }
    }
    // Decide it, then the calls that waited for it, at any depth, in time order under each call.
    const todo = [e];
    while (todo.length) {
      const c = todo.pop()!;
      decide(c);
      decided.add(c);
      const kids = waiting.get(c) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) todo.push(kids[i]!);
    }
  }
  // Each call in the trees that is not a repeat, after the calls nested in it: its token counts, own value per field, else
  // the nested sum, and how it takes its cost.
  const nested = new Map<AgentEvent, Nested>();
  for (let i = pre.length - 1; i >= 0; i--) {
    const c = pre[i]!;
    if (repeats.has(c)) continue;
    const kids: Nested[] = [];
    for (const k of children.get(c) ?? []) if (!repeats.has(k)) kids.push(nested.get(k)!);
    const u: Usage = {};
    // A billed call with no usage has no token counts of its own, even zeros: it takes its nested calls'.
    const counts = carriesUsage(c);
    for (const k of TOKEN_KEYS) {
      const own = counts ? count(c.usage?.[k]) : undefined;
      if (own !== undefined) u[k] = own;
      else if (kids.some((x) => x.u[k] !== undefined)) u[k] = kids.reduce((s, x) => s + (x.u[k] ?? 0), 0);
    }
    // Whether a nested call reported, not how much: a reported 0 (a free model) counts, and so does a part too small to show beside the estimates.
    const kidsReported = kids.some((x) => x.reported);
    const estimate = c.payload?.costEstimated === true;
    // A billed call counts at its bill, even $0, not its nested calls' cost: its gateway companion holds the bill minus its
    // own cost. A call keeps its own cost when it reported it, or when no nested call reported one: its estimate, even 0,
    // loses to theirs.
    if (billed.has(c.id)) nested.set(c, { u, mode: "billed", reported: true, priced: true });
    else if (num(c.usage?.costUsd) !== undefined && (!estimate || !kidsReported)) nested.set(c, { u, mode: "own", reported: !estimate, priced: true });
    else nested.set(c, { u, mode: "kids", reported: kidsReported, priced: kids.some((x) => x.priced) });
  }
  // The counted calls with nested calls, folded first, so a companion knows whether the call it billed is in a count. Down
  // each tree, a call that keeps its own cost counts it unless a bill covers it, and covers the calls nested in it. A
  // billed call counts its bill unless a billed call above it has its generation; a nested call billed for another
  // generation adds its bill: its own cost here, the rest in its companion.
  const folds = new Map<AgentEvent, Folded>();
  const costed = new Set<string>();
  for (const r of sorted) {
    if (!children.has(r) || dropped.has(r.id)) continue;
    const top = nested.get(r)!;
    const f: Folded = { u: { ...top.u }, est: 0, tiers: {}, split: { parts: noParts(), unsplit: 0 } };
    let cost = 0;
    const todo = [r];
    while (todo.length) {
      const c = todo.pop()!;
      const n = nested.get(c)!;
      const counts = n.mode === "own" ? !covered.has(c) : n.mode === "billed" && !shared.has(c);
      if (counts) {
        costed.add(c.id);
        cost += num(c.usage?.costUsd) ?? 0;
        f.est += estimatedOf(c);
        addTiers(f.tiers, tiersOf(c));
        addSplit(f.split, splitOfEvent(c));
      }
      if (n.mode === "own") continue;
      const kids = children.get(c) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) if (!repeats.has(kids[i]!)) todo.push(kids[i]!);
    }
    if (top.priced) f.u.costUsd = cost;
    folds.set(r, f);
  }
  // The companion that holds each generation's bill: the first whose call is counted, then the first whose call is in
  // the events with no usage (its companion holds the whole bill), else the first.
  const isCounted = (id: string): boolean => usageCalls.has(id) && (!dropped.has(id) || costed.has(id));
  const billOf = new Map<string, AgentEvent>();
  if (billed.size) {
    const present = new Set<string>();
    for (const e of sorted) if (e.kind === "llm.call") present.add(e.id);
    // 2: a counted call. 1: a call with no usage. 0: a call left out, such as a proxy's copy of a call the agent's own
    // capture recorded, whose companion holds only the bill minus the copy's own cost.
    const rank = (id: string): number => (isCounted(id) ? 2 : present.has(id) && !usageCalls.has(id) ? 1 : 0);
    for (const e of sorted) {
      const g = generationOf(e);
      if (!g || (dropped.has(e.parentId!) && !costed.has(e.parentId!))) continue;
      const held = billOf.get(g);
      if (!held || rank(e.parentId!) > rank(held.parentId!)) billOf.set(g, e);
    }
  }
  for (const e of sorted) {
    if (isUsageSnapshot(e) || dropped.has(e.id)) continue;
    // A billed call with no usage and nested calls counts their tokens, at its bill.
    if (carriesUsage(e) || folds.has(e)) {
      const f = folds.get(e) ?? { u: e.usage!, est: estimatedOf(e), tiers: tiersOf(e), split: splitOfEvent(e) };
      addUsage(usage, f.u);
      estimated += f.est;
      addTiers(byTier, f.tiers);
      addSplit(split, f.split);
      counted += tokens(f.u);
      countedCost += num(f.u.costUsd) ?? 0;
      continue;
    }
    // A gateway companion of a call that was not counted goes with it, unless the call that took its cost was counted.
    // A second companion of one generation is a copy of its bill.
    const g = generationOf(e);
    if (isEnrichment(e) && e.parentId && ((dropped.has(e.parentId) && !costed.has(e.parentId)) || (g !== undefined && billOf.get(g) !== e))) {
      rawCost += num(e.usage?.costUsd) ?? 0;
      continue;
    }
    addUsage(usage, e.usage);
    estimated += estimatedOf(e);
    addTiers(byTier, tiersOf(e));
    addSplit(split, splitOfEvent(e));
  }
  return usageResult({ usage, estimated, byTier, split, ...(snapshot ? { snapshot: { usage: snapshot.usage ?? {}, est: estimatedOf(snapshot), split: splitOfEvent(snapshot) } } : {}), calls, raw, rawCost, counted, countedCost });
}

/** Totals of a usage rollup before the snapshot is added (see rollupUsage). */
interface UsageTotals {
  usage: Usage;
  estimated: number;
  byTier: Tiers;
  /** `estimated` by token type. */
  split: Split;
  snapshot?: { usage: Usage; est: number; split: Split };
  calls: number;
  raw: number;
  rawCost: number;
  counted: number;
  countedCost: number;
}

function usageResult(t: UsageTotals): UsageRollup {
  const usage: Usage = { ...t.usage };
  const byTier: Tiers = { ...t.byTier };
  const split: Split = { parts: { ...t.split.parts }, unsplit: t.split.unsplit };
  let estimated = t.estimated;
  if (t.snapshot) {
    addUsage(usage, t.snapshot.usage);
    estimated += t.snapshot.est;
    addSplit(split, t.snapshot.split);
  }
  if (estimated > 0 && usage.costUsd !== undefined) {
    usage.estimatedCostUsd = Math.min(estimated, usage.costUsd);
    if (Object.keys(byTier).length) usage.estimatedCostByTier = byTier;
    // A split of all of the estimate, or none: its parts add up to estimatedCostUsd.
    if (split.unsplit === 0 && estimated <= usage.costUsd + 1e-9 * Math.max(1, usage.costUsd)) usage.estimatedCostByTokenType = split.parts;
  }
  if (!t.calls) return { usage };
  const dupCost = Math.round((t.rawCost - t.countedCost) * 1e9) / 1e9;
  return { usage, duplicate: { calls: t.calls, tokens: Math.max(0, t.raw - t.counted), ...(dupCost > 0 ? { costUsd: dupCost } : {}) } };
}

/**
 * rollupUsage as a fold, for sessions with no spans and no enrichment events
 * (SessionState.simple): no call nests in another and none is billed by a
 * companion, so each event is counted, or dropped as a repeat, as it comes.
 */
interface UsageState extends UsageTotals {
  /** Latest snapshot so far, and its token total (equal times keep the larger). */
  snapshotTs?: number;
  snapshotTokens: number;
  responses: Set<string>;
}

const usageState = (): UsageState => ({ usage: {}, estimated: 0, byTier: {}, split: { parts: noParts(), unsplit: 0 }, calls: 0, raw: 0, rawCost: 0, counted: 0, countedCost: 0, snapshotTokens: 0, responses: new Set() });

const simpleEstimate = (e: AgentEvent): number => (e.payload?.costEstimated === true ? (num(e.usage?.costUsd) ?? 0) : 0);
const simpleTiers = (e: AgentEvent): Tiers => {
  const est = simpleEstimate(e);
  const t = e.payload?.priceTier;
  return est > 0 && typeof t === "string" && t ? { [t]: est } : {};
};
const simpleSplit = (e: AgentEvent): Split => splitEstimate(e, simpleEstimate(e));
const usageTokens = (u: Usage) => TOKEN_KEYS.reduce((s, k) => s + (count(u[k]) ?? 0), 0);

function foldUsage(s: UsageState, e: AgentEvent): void {
  if (isUsageSnapshot(e)) {
    const total = tokenTotal(e.usage);
    if (s.snapshotTs === undefined || e.ts > s.snapshotTs || (e.ts === s.snapshotTs && total >= s.snapshotTokens)) {
      s.snapshotTs = e.ts;
      s.snapshotTokens = total;
      s.snapshot = { usage: { ...e.usage }, est: simpleEstimate(e), split: simpleSplit(e) };
    }
    return;
  }
  if (carriesUsage(e)) {
    s.raw += usageTokens(e.usage!);
    s.rawCost += num(e.usage!.costUsd) ?? 0;
    const rid = typeof e.payload?.responseId === "string" && e.payload.responseId ? e.payload.responseId : undefined;
    if ((rid && s.responses.has(rid)) || e.payload?.replay === true) {
      s.calls++;
      return;
    }
    if (rid) s.responses.add(rid);
    s.counted += usageTokens(e.usage!);
    s.countedCost += num(e.usage!.costUsd) ?? 0;
  }
  addUsage(s.usage, e.usage);
  s.estimated += simpleEstimate(e);
  addTiers(s.byTier, simpleTiers(e));
  addSplit(s.split, simpleSplit(e));
}

const usageOf = (s: UsageState): UsageRollup => usageResult(s);

/**
 * A usage snapshot: running session totals (T3 Code v1 threads, OpenCode
 * sessions without per-message tokens), re-emitted as the totals grow. Only
 * the latest one counts; summing them would count the same tokens again.
 */
export const isUsageSnapshot = (e: AgentEvent): boolean => e.kind === "notification" && e.payload.type === "usage-summary";

const tokenTotal = (u: Usage | undefined): number => TOKEN_KEYS.reduce((s, k) => s + (count(u?.[k]) ?? 0), 0);


/**
 * Turns from turn.end rows. One capture path: every row is a turn. Both paths,
 * each with keyed rows: rows with a turnId count once per turn (both paths key
 * them alike and the store keeps one copy, so either may hold a given turn);
 * rows without one are each path's own count of the turns it could not key.
 * Otherwise a path that keys none of its turns (an older agent version, a
 * transcript that does not record what the hook keys by) counted the same turns
 * its own way, so the larger count wins (a hook installed mid-session saw fewer).
 */
function turnCount(t: { live: number; backfill: number; liveIdless: number; backfillIdless: number }, turnIds: Set<string>): number {
  if (t.live === 0 || t.backfill === 0) return t.live + t.backfill;
  if (t.live > t.liveIdless && t.backfill > t.backfillIdless) return turnIds.size + Math.max(t.liveIdless, t.backfillIdless);
  return Math.max(t.live, t.backfill);
}

/**
 * Bumped whenever SessionState (or anything folded into it) changes meaning,
 * or sessionOf derives other stats, flags or titles from it. Saved folds and
 * the refold cursor carry foldStamp(), this integer plus a hash of a fresh
 * state's shape: a saved fold with another stamp is dropped and the session
 * rebuilt from all its events, and every stored session is folded again once
 * in the background (core/reparse.ts, REFOLD_CURSOR), so old sessions get the
 * new derivation. A new or retyped sub-state changes the stamp by itself; a
 * new optional field or a change of meaning still needs the bump.
 */
export const SESSION_FOLD_VERSION = 50; // 3: TamperState tracks shell calls, own lines and source edits since the last green run. 4: skip markers inside string literals are not skips. 5: proxy calls (sansProxy, otherCalls). 6: hook context (stats.hookContext, hook: tags). 7: stats.launch. 8: premature-completion reads what the agent said as it stopped (PrematureState.said, reported). 9: models and proxyModels (stats.models, stats.modelSwitch, model:switch, refusal; model = the main thread's most used). 10: text-tool-call (FlagState.textToolCall). 11: cache:low tag (core/cache-breaks.ts cacheUnderused). 12: model switches per scope (recorded fallbacks, subagents; ModelSwitch count, switchedCalls, extraUsd; model:fallback). 13: idle cache breaks split by where the wait was (CacheBreak.idle, CacheBreakStats.byIdle). 14: unapproved-action (FlagState.unapproved, stats.unapprovedActions). 15: stats.inheritedTokens (a fork subagent's inherited context). 16: tool failures classified (core/failures.ts): toolErrors counts real ones, stats.benignToolErrors and stats.interruptedToolCalls the rest, repeated-tool-failure and phase toolErrors skip them; a REPL cell's bash()/subprocess commands count as verification (core/cells.ts). 17: a session.start an older ingest stamped with a harness marker names no parent (isSpawnMarker), so a ghost harness parent goes; a gateway record with no cost bills nothing (billedCallOf), so the call's cost stays in usage.estimatedCostUsd. 18: stats.memoryUse, the memory and instruction files a session's events name (core/memory-use.ts, SessionState.memory). 19: a session with transcript model calls counts them, not the copies its OTLP logs carry (sansOtel, transcriptCalls). 20: weight edits (stats.weightEdits, the weights:edited tag, SessionState.weightEdits). 21: weight checkpoints (stats.weightEdits.checkpoints, the weights:checkpoint tag), and stats.weightEdits on a session with a checkpoint and no edit. 22: a `<parent>:sub:<agentId>` session with no session.start takes its parent from the id. 23: an API error event (source api, or status 400 or more) counts in stats.llmErrors. 24: api-stall (FlagState.apiStall); filesChanged counts files a shell call writes (shellCallFiles, SessionState.shellFiles), and keys file.change paths relative to the cwd. 25: a session with no prompt is titled by its session.start's name (SessionState.startName), so an SDK trace() of weight edits is not untitled. 26: stats.compactionRefetches (core/waste.ts WasteState.preCompact), reads that fetched again what a compaction dropped. 27: stats.waiting (core/waiting.ts). 28: stats.endInferred, an endedAt that is the last activity seen rather than a session.end. 29: a session with a tool call still open and no real end (no session.end, or only a transcript's quiet marker) has no endedAt (SessionState.endIdle). 30: a host's thread title (a host-link notification's `title`, T3 Code) titles the session before its prompt (SessionState.hostTitle). 31: stats.usage.estimatedCostByTokenType, the estimate split by token type from the calls' payload.costByTokenType (UsageState.split). 32: an `exec` call with a command line (Devin CLI) is a shell call (isShellCall), so filesChanged and waste count it; Devin's `run_subagent` starts a subagent (waiting, unapproved); a permission wait picks an open call of the tool its prompt names, and on a call with no id ends with that tool's end only (WaitingState.wait.tool). 33: a host app store request (T3 Code approvals and questions: a notification with a requestId) sets stats.waiting in a backfill too, until its resolved notification (WaitingState.wait.request); waiting and unapproved share SPAWN_TOOL, so a prompt never names an open invoke_agent call. 34: a host notification before the session.start (T3 Code host-link) opens no phase of its own, so the session.start after it is no resume (OutlineState.begun). 35: titles skip a workflow-harness frame line, a `Project:` header and pasted blocks (TITLE_SKIP); a session.start's payload.tags (Langfuse trace tags from the OTel receiver) become tag:<name> flags (SessionState.tags); also refolds the other changes of improvement round 7. 36: a workflow agent's parent link names its run, phase and label (parent.workflowId, workflowName, phase, label); filesChanged keys a path by the session's cwd after resolving it against the event's (changeKey), so a file edited from two folders counts once; titles skip frame lines before a subagent's prompt is cut to one line, skip a `Project:` line only in a framed prompt, a frame-only workflow agent is titled "<phase> · <label>", and a phase is titled by its first prompt that is not a harness notice or frame (phasePromptTitle), and a T3 Code delegated-task result is a harness notice, not a prompt (isSyntheticPrompt). 37: changeKey keys an absolute path that is outside the event's folder but inside the session's cwd relative to the cwd, so a file a shell call edited after `cd <repo>` from a subfolder counts once. 38: a session a host app drove (payload.via, T3 Code) is the agent that ran, with the host as Session.host (hostedAgent); a host thread that started no agent (SessionState.hostBare) stays the host's; stats.prs, the pull requests a session opened, merged, closed or linked (SessionState.prs, foldPrs); llm-error, a last failed model call the session never got past (FlagState.llmError); the tools:unseen tag, a session whose source records model calls only (FlagState.sight). 39: stats.prs links a PR URL in a call's output only for a push or a gh pr command whose own PR it is, not every URL a compound command printed (release notes), and a view's --repo is not the session's repo. 40: stats.prs caps only the PRs a session linked at PRS_MAX; the ones it opened, merged or closed stay (up to PRS_ALL_MAX), so an orchestrator's early merges are kept. 41: stats.prs.own, a PR the session pushed to or linked to its own thread (HOST_PR_LINK), so an item whose PR another session merged leaves review (core/work.ts prsOfItem). 42: stats.retrieval, the reads, searches and web calls of a session's tool calls and the files it read and then edited (core/retrieval.ts, SessionState.retrieval). 43: stats.waits, how often and how long the session waited on the person and how often the person steered (core/wait-stats.ts, SessionState.waits); a host link's launch (T3 Code: a thread a person started is interactive) is the session's launch (SessionState.hostLaunch); a host's marker makes the transcript prompt it names an agent's (HOST_AGENT_PROMPT, WaitStatsState.marks), opens no outline phase (core/outline.ts) and moves no stall gap (core/derail.ts); a hook's permission prompt joins a host request asked up to 5 s before it, and a request joins an open prompt, only when the request's kind fits the call's tool (OpenWait.requestKind). 44: shell writes through Antigravity's run_command and Droid's Execute (an exec or execute call with a command line) count in filesChanged and stats.retrieval, and the waste stats see both as shell calls; a shell call's reads and writes resolve against its Cwd (run_command) or dir_path (Gemini), and a Git Bash /c/x path is C:/x (onDrive); view_file_outline and view_code_item are reads, a file list piped into xargs rm is not; a search that printed only grep's warnings, counts of zero from a pipeline whose last command counts (RetrievalCall.count) or the lines a literal echo prints (RetrievalCall.echoed) is empty; commandOf, derail.ts and failures.ts read CommandLine (run_command), so the waste stats, the derail checks, failure classes, stats.memoryUse and flag details see the command. 45: every reader of a shell command uses one list of shell tools and command keys (core/shell-tools.ts): test-tamper and unapproved-action read run_command's CommandLine, a shell diff's origin (core/shell-diff.ts) is traced to the command of Execute, Devin's exec or run_command as of Bash, and test-tamper keeps only shell calls' commands for it; failure classes and stats.prs read a bare command string from shell_command, local_shell_call, command_execution and powershell too, and no longer from exec, which is a Codex code-mode cell. 46: a failed shell line drops a file from stats.retrieval only when an error line names its base name whole, not inside a longer name such as data.ts for a.ts (retrieval.ts namedIn). 47: a nested call that reported a cost, even 0, beats its wrapper's estimate, even 0 (rollupUsage tracks whether a nested call reported, and whether the wrapper's cost is an estimate, not the amounts); stats.usage, stats.duplicateUsage and phase tokens skip a token count below 0 or not a finite number; a gateway companion of a nested call whose cost its wrapper takes counts with it, and a billed call keeps its own cost, or none (Folded.costFrom); a gateway generation two companions carry is billed once, by the companion of a counted call. 48: a token count below 0 or not a finite number is skipped in cache breaks (a call's prompt, cache reads and writes, and whether it has a cache field), in the context size the no-progress check reads (derail.ts contextOf), and in stats.inheritedTokens (a count of 0 too), as in stats.usage (pricing.ts tokenCount); a call with such a count does not set the size a no-progress stretch starts from, nor lower the size it reached (derail.ts Ev.partial). 49: stats.turnsByModel, the person's turns by the model that ran them, with the pushback, cancels and durations of each (core/turn-stats.ts, SessionState.turns), and stats.edits and stats.shells, file-edit and shell calls with their real failures; foldWaitStats returns who sent a prompt, so both folds read it the same way. 50: a model call a gateway billed takes part in span nesting with no usage of its own (rollupUsage takesPart): under an estimated wrapper its bill replaces the estimate, under a reported one the bill is left out with the call, and a billed wrapper with no usage counts its nested calls' tokens at its bill. A billed call also adds the bills of the calls nested in it that are not its own generation (Folded.bills), counts at $0 when billed $0, and has no token counts of its own when it carries no usage, not even zeros; a billed call with no usage and nested calls is checked for a replay (payload.replay), not by its response id, and the calls nested in it are checked for repeats; calls nested in each other in a loop count under the first, and nested calls fold at any depth (rollupUsage parentOf, Nested); a cost a call reported covers the bills nested in it, also under a billed call, and a call and one nested in it at any depth that share a response id are not repeats of each other (rollupUsage isAbove).

/**
 * A session's events folded so far: everything buildSession needs from them,
 * as plain data (maps, sets, arrays), so live ingest can save it after one
 * append and fold only the next append's events into it (core/ingest.ts)
 * instead of reading and rebuilding a long session every time.
 */
export interface SessionState {
  v: number;
  /** Events folded (the next one's index in the session's sorted events). */
  n: number;
  first?: { ts: number; sessionId: string; agent: string };
  /** Agent of the first event that is not a durable engine span. */
  agent?: string;
  /** ts of the last event folded: a later append must not sort before it. */
  lastTs?: number;
  /** ts of the last prompt the user typed (isRealPrompt). */
  lastPromptTs?: number;
  /**
   * No spans and no enrichment events: every part streams. Span nesting
   * (rollupUsage), durable runs (durableStats) and gateway companions need the
   * whole event list, so sessionOf() is then given it. So does a test-tamper
   * call only the whole list can settle (TamperState.needsEvents).
   */
  simple: boolean;
  via?: string;
  /** A host-link that names no agent run (a T3 Code thread with no provider thread): the host never started an agent. */
  hostBare?: boolean;
  /** Distinct agents of captured events, in order (the agent a host ran), and the first payload.provider. */
  agents: string[];
  provider?: string;
  /** Distinct trace ids in order, up to twice MAX_TRACE_IDS (enough to fill up whatever the previous row kept). */
  traceIds: Set<string>;
  lastEnd?: number;
  lastActivity?: number;
  captured: number;
  allLive: boolean;
  allTranscript: boolean;
  /** Any event captured live (not replayed from a transcript), and the first session.start's git facts (repo state at the start). */
  live: boolean;
  gitStart?: Record<string, unknown>;
  model?: string;
  agentVersion?: string;
  cwd?: string;
  runId?: string;
  /** Earliest repo state from the events (see sessionOf for how it meets the previous row's). */
  repo?: Session["repo"];
  endedAt?: number;
  /** The last session.end was a transcript's quiet marker (reason "idle"), not a real end. */
  endIdle?: boolean;
  endSnapshot?: Session["endSnapshot"];
  parent?: Session["parent"];
  /** `parent` came from a proxied call's parentSessionId; a session.start replaces it. */
  parentByProxy?: boolean;
  project?: string;
  /** Files changed, relative to the cwd: file.change paths, and files a finished shell call wrote. */
  files: Set<string>;
  /** Files a started shell call writes (shellCallFiles), by toolUseId: they count once the call ends and was not stopped. */
  shellFiles: Map<string, string[]>;
  turnEnds: { live: number; backfill: number; liveIdless: number; backfillIdless: number };
  turnIds: Set<string>;
  userMessages: number;
  toolIds: Set<string>;
  idlessStarts: number;
  idlessEnds: number;
  /** Failed tool calls that are real failures (core/failures.ts). */
  toolErrors: number;
  /** Failed tool calls whose exit 1 is an answer (no match, a probe, files differ). */
  benignToolErrors: number;
  /** Tool calls the user or the harness stopped. */
  interruptedToolCalls: number;
  /** Started shell commands, to classify their failed ends. */
  failures: FailureState;
  llmErrors?: LlmErrors;
  lastTest?: { passed: number; failed: number };
  title?: string;
  fallbackTitle?: string;
  /** The first session.start's `name` (an SDK trace(), an OTel root span, a Goose session): the title when nothing else gives one. */
  startName?: string;
  /** The thread title a host (T3 Code) names in its host-link notification: the title, before the first prompt. */
  hostTitle?: string;
  /** Trace tags the session.start events name (payload.tags, Langfuse's langfuse.trace.tags), in order, at most TAGS_MAX: the tag:<name> flags. */
  tags?: string[];
  usage: UsageState;
  latency: LatencyState;
  flags: FlagState;
  derails: DerailState;
  outline: OutlineState;
  waste: WasteState;
  cacheBreaks: CacheBreakState;
  /**
   * Proxy model calls (source "proxy") that another capture path also recorded
   * are detail only: when the session has model calls from its agent's own
   * capture (a transcript, an OTel span), those count, and usage, latency,
   * phases and cache breaks come from this copy of their folds, which skips the
   * proxy's calls. Made at the first proxy call. A session with no other model
   * calls counts the proxy's. Failed calls count either way (only the proxy sees retries).
   */
  sansProxy?: { usage: UsageState; latency: LatencyState; outline: OutlineState; cacheBreaks: CacheBreakState };
  /** A model call from a capture path other than the proxy. */
  otherCalls?: boolean;
  /**
   * An agent's OTLP logs (source "otel-log") repeat the model calls and tool
   * events its transcript records. When the session has transcript model
   * calls, those count, and usage, latency, phases, cache breaks and models
   * come from this copy of their folds, which skips the logs' copies (and the
   * proxy's calls). Made at the first log copy, whichever source came first.
   */
  sansOtel?: { usage: UsageState; latency: LatencyState; outline: OutlineState; cacheBreaks: CacheBreakState; models: ModelState };
  /** A model call from a transcript (or another recorded history). */
  transcriptCalls?: boolean;
  skills: SkillState;
  /** Memory and instruction files the events name (stats.memoryUse, core/memory-use.ts). */
  memory: MemoryUseState;
  redactions: RedactionState;
  hookContext: HookContextState;
  weightEdits: WeightEditState;
  /** What the session waits on from the user (core/waiting.ts). */
  waiting: WaitingState;
  /** How often and how long it waited on the person (stats.waits, core/wait-stats.ts). */
  waits: WaitStatsState;
  /** Pull requests the session's tool calls opened, merged, closed or linked (stats.prs, foldPrs). */
  prs: PrFoldState;
  /** Reads, searches and web calls, and the files read and then edited (stats.retrieval, core/retrieval.ts). */
  retrieval: RetrievalState;
  /** The person's turns by model, and edit and shell calls (stats.turnsByModel, edits, shells; core/turn-stats.ts). */
  turns: TurnStatsState;
  /**
   * Models of the agent's own model calls (core/models.ts), and of the
   * proxy's: the proxy's count only in a session with no other model calls.
   */
  models: ModelState;
  proxyModels: ModelState;
  /** How the agent was launched, from the first session.start that says (launchOf). */
  launch?: "headless" | "interactive";
  /** How a host app says the session was launched (a host-link notification's `launch`, T3 Code): it wins over `launch`. */
  hostLaunch?: "headless" | "interactive";
  /** A fork subagent: tokens of the parent's context it started with, from its `fork` notification. */
  inheritedTokens?: number;
}

/** A fresh fold: no events seen. */
export function sessionState(): SessionState {
  return {
    v: SESSION_FOLD_VERSION,
    n: 0,
    simple: true,
    agents: [],
    traceIds: new Set(),
    captured: 0,
    allLive: true,
    allTranscript: true,
    live: false,
    files: new Set(),
    shellFiles: new Map(),
    turnEnds: { live: 0, backfill: 0, liveIdless: 0, backfillIdless: 0 },
    turnIds: new Set(),
    userMessages: 0,
    toolIds: new Set(),
    idlessStarts: 0,
    idlessEnds: 0,
    toolErrors: 0,
    benignToolErrors: 0,
    interruptedToolCalls: 0,
    failures: failureState(),
    usage: usageState(),
    latency: latencyState(),
    flags: flagState(),
    derails: derailState(),
    outline: outlineState({ days: false }),
    waste: wasteState(),
    cacheBreaks: cacheBreakState(),
    skills: skillState(),
    memory: memoryUseState(),
    redactions: redactionState(),
    hookContext: hookContextState(),
    weightEdits: weightEditState(),
    waiting: waitingState(),
    waits: waitStatsState(),
    prs: prFoldState(),
    retrieval: retrievalState(),
    turns: turnStatsState(),
    models: modelState(),
    proxyModels: modelState(),
  };
}

/** A value's kind in a fold: map, set, array, object, null, or its typeof. */
function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (typeof v !== "object") return typeof v;
  return v instanceof Map ? "map" : v instanceof Set ? "set" : Array.isArray(v) ? "array" : "object";
}

/** Every key of a fresh state, at every depth of its plain objects, with its value's kind, in key order. */
function shapeOf(o: object, at: string[] = [], out: { path: string[]; kind: string }[] = []): { path: string[]; kind: string }[] {
  for (const k of Object.keys(o).sort()) {
    const v = (o as Record<string, unknown>)[k];
    const kind = kindOf(v);
    out.push({ path: [...at, k], kind });
    if (kind === "object") shapeOf(v as object, [...at, k], out);
  }
  return out;
}

let freshShape: { path: string[]; kind: string }[] | undefined;
let stamp: number | undefined;

/**
 * The stamp of saved folds and of the refold cursor: SESSION_FOLD_VERSION
 * times 1e9 plus an FNV-1a hash, modulo 1e9, of a fresh state's shape (its
 * keys at every depth, and their kinds), so it reads as the integer and nine
 * more digits. Two builds that bump the integer to the same value for
 * differently shaped states get different stamps, with nothing to keep by
 * hand: the hash follows the code. A build id would refold every store on every
 * release, and a run from source has none. The shape's hash changes only when
 * the state does, is the same in every process of a build, and a cursor keeps
 * it exactly (an integer in SQLite, a float64 in Postgres and ClickHouse).
 * Computed once per process, on first use; the hook never calls it.
 */
export function foldStamp(): number {
  if (stamp === undefined) {
    freshShape ??= shapeOf(sessionState());
    let h = 0x811c9dc5;
    for (const ch of freshShape.map((p) => `${p.path.join(".")}:${p.kind}`).join(",")) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
    stamp = SESSION_FOLD_VERSION * 1e9 + ((h >>> 0) % 1e9);
  }
  return stamp;
}

/**
 * A decoded saved fold has every sub-state a fresh state has (each object,
 * Map, Set and array, at every depth), of the same kind. A fold another build
 * saved can lack one (core/ingest.ts readFold then drops it), and folding the
 * next event into it would throw.
 */
export function isFoldState(x: unknown): x is SessionState {
  if (kindOf(x) !== "object" || (x as SessionState).v !== SESSION_FOLD_VERSION) return false;
  freshShape ??= shapeOf(sessionState());
  for (const { path, kind } of freshShape) {
    if (kind !== "object" && kind !== "map" && kind !== "set" && kind !== "array") continue;
    let v: unknown = x;
    for (const k of path) v = (v as Record<string, unknown>)[k];
    if (kindOf(v) !== kind) return false;
  }
  return true;
}

/**
 * How the agent was launched, from a session.start payload; undefined when it does not say.
 * - Claude Code `entrypoint` (the transcript's, or the hook's CLAUDE_CODE_ENTRYPOINT):
 *   `sdk-cli` (`claude -p`), `sdk-ts`, `sdk-py` are headless; `cli` and the IDE and
 *   desktop apps (`claude-vscode`, …) are interactive.
 * - Codex `launch` (session_meta.source) and `originator`: `exec` and `mcp` launches,
 *   and `codex_exec` or `codex_sdk_*` originators, are headless; `cli` and `vscode`
 *   launches, and `codex_cli_rs` or `codex_vscode`, are interactive.
 */
export function launchOf(p: Record<string, unknown>): "headless" | "interactive" | undefined {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const entry = s(p.entrypoint);
  if (/^sdk-/.test(entry)) return "headless";
  if (entry === "cli" || /^claude-/.test(entry)) return "interactive";
  const launch = s(p.launch);
  const origin = s(p.originator);
  if (launch === "exec" || launch === "mcp" || /^codex_(exec|sdk)/.test(origin)) return "headless";
  if (launch === "cli" || launch === "vscode" || /^codex_(cli|vscode)/.test(origin)) return "interactive";
  return undefined;
}

/**
 * The agent a host app (s.via) ran: the first event from another agent, else what the host's own
 * events name (payload.provider). Undefined for a host thread that started no agent (hostBare) or
 * names none it knows ("unknown"): that session stays the host's.
 */
function hostedAgent(s: SessionState, prev: Session | undefined): string | undefined {
  const other = s.agents.find((a) => a !== s.via);
  if (other) return other;
  if (s.hostBare) return undefined;
  const named = s.provider ?? (prev?.host ? prev.agent : prev?.provider);
  return named && named !== "unknown" && named !== s.via ? named : undefined;
}

/** Folds the session's next event (in time order) into the state. */
export function foldSession(s: SessionState, e: AgentEvent): void {
  const index = s.n++;
  s.first ??= { ts: e.ts, sessionId: e.sessionId, agent: e.agent };
  if (s.agent === undefined && e.payload.durable === undefined) s.agent = e.agent;
  s.lastTs = e.ts;
  if (isRealPrompt(e)) s.lastPromptTs = e.ts;
  if (e.spanId || e.parentSpanId || isEnrichment(e)) s.simple = false;
  if (s.provider === undefined && typeof e.payload.provider === "string" && e.payload.provider) s.provider = e.payload.provider;
  if (s.project === undefined && e.project) s.project = e.project;
  if (e.kind === "session.start" && typeof e.payload.parentSessionId === "string" && !isSpawnMarker(e.payload) && (!s.parent || s.parentByProxy)) {
    s.parent = parentOf([e]);
    delete s.parentByProxy;
  } else if (!s.parent && isProxyCall(e) && typeof e.payload.parentSessionId === "string" && e.payload.parentSessionId !== e.sessionId) {
    // A session seen only through the proxy (no hooks): its calls name the parent. A session.start wins.
    s.parent = { sessionId: e.payload.parentSessionId };
    const sub = e.subagentId ?? (typeof e.payload.agentId === "string" ? e.payload.agentId : undefined);
    if (sub) s.parent.subagentId = sub;
    if (typeof e.payload.agentType === "string") s.parent.type = e.payload.agentType;
    s.parentByProxy = true;
  }
  if (!s.parent) {
    // A subagent stored as `<parent>:sub:<agentId>` with no session.start: the id names the parent. A session.start replaces it.
    const m = /^(.+):sub:([^:]+)$/.exec(e.sessionId);
    if (m) {
      s.parent = { sessionId: m[1]!, subagentId: m[2]!, type: "subagent" };
      s.parentByProxy = true;
    }
  }
  if (!isBackfillEvent(e)) s.live = true;
  if (!s.gitStart && e.kind === "session.start") {
    const { gitBranch, gitCommit, git } = e.payload;
    s.gitStart = { gitBranch, gitCommit, git };
  }
  const failure = foldFailure(s.failures, e);
  const proxyCall = isProxyCall(e);
  if (proxyCall) s.sansProxy ??= structuredClone({ usage: s.usage, latency: s.latency, outline: s.outline, cacheBreaks: s.cacheBreaks });
  else if (e.kind === "llm.call" && !isEnrichment(e)) s.otherCalls = true;
  const otelCopy = isOtelLogCopy(e);
  if (e.kind === "llm.call" && !isEnrichment(e) && isBackfillEvent(e)) s.transcriptCalls = true;
  if (otelCopy) s.sansOtel ??= { ...structuredClone({ usage: (s.sansProxy ?? s).usage, latency: (s.sansProxy ?? s).latency, outline: (s.sansProxy ?? s).outline, cacheBreaks: (s.sansProxy ?? s).cacheBreaks }), models: structuredClone(s.models) };
  const sans = proxyCall ? undefined : s.sansProxy;
  if (sans) {
    foldUsage(sans.usage, e);
    foldLatency(sans.latency, e);
    foldOutline(sans.outline, e, index, failure);
    foldCacheBreaks(sans.cacheBreaks, e);
  }
  const sansOtel = proxyCall || otelCopy ? undefined : s.sansOtel;
  if (sansOtel) {
    foldUsage(sansOtel.usage, e);
    foldLatency(sansOtel.latency, e);
    foldOutline(sansOtel.outline, e, index, failure);
    foldCacheBreaks(sansOtel.cacheBreaks, e);
    foldModels(sansOtel.models, e);
  }
  foldUsage(s.usage, e);
  foldLatency(s.latency, e);
  foldFlags(s.flags, e, failure?.cls);
  if (s.flags.tamper.needsEvents) s.simple = false;
  foldDerails(s.derails, e, index);
  foldOutline(s.outline, e, index, failure);
  foldWaste(s.waste, e);
  foldCacheBreaks(s.cacheBreaks, e);
  foldSkills(s.skills, e);
  foldMemoryUse(s.memory, e, s.cwd);
  foldRedactions(s.redactions, e);
  foldHookContext(s.hookContext, e);
  foldWeightEdits(s.weightEdits, e);
  if (isEnrichment(e)) return;
  // Before foldWaiting: it reads the calls and requests open before this event.
  const by = foldWaitStats(s.waits, s.waiting, e, isBackfillEvent(e));
  foldWaiting(s.waiting, e, isBackfillEvent(e));
  foldPrs(s.prs, e, failure?.cls);
  const end = eventEnd(e);
  // Before the tool case below adds this event's id to toolIds: a call seen live and from its transcript counts once.
  foldRetrieval(s.retrieval, e, { cwd: s.cwd ?? e.cwd, seen: s.toolIds, failure });
  foldTurnStats(s.turns, e, { by, proxyCall, otelCopy, failure, seen: s.toolIds, end });

  s.captured++;
  if (!s.agents.includes(e.agent)) s.agents.push(e.agent);
  // Host app that drove the agent (T3 Code): set on events by the host's adapter
  // or the hook's env marker. The session is the agent that ran; the host is Session.host.
  if (typeof e.payload.via === "string" && e.payload.via) {
    s.via ??= e.payload.via;
    if (e.payload.type === "host-link" && e.payload.t3ProviderThreadId === undefined) s.hostBare = true;
  }
  if (e.traceId && s.traceIds.size < 2 * MAX_TRACE_IDS) s.traceIds.add(e.traceId);
  if (s.lastEnd === undefined || end > s.lastEnd) s.lastEnd = end;
  // When it was stamped, not when it ended: a span that began before the end is not a resume.
  if (e.kind !== "session.end" && (s.lastActivity === undefined || e.ts > s.lastActivity)) s.lastActivity = e.ts;
  // Live-ingested (OTel or the SDKs' native batches): no adapter emits a session.end.
  if (!e.source?.startsWith("otel") && e.source !== "sdk" && e.source !== "proxy") s.allLive = false;
  if (!isBackfillEvent(e)) s.allTranscript = false;
  if (e.model) s.model = e.model;
  if (e.agentVersion) s.agentVersion = e.agentVersion;
  s.cwd ??= e.cwd;
  s.runId ??= e.runId;
  // Keep the earliest repo state (the pre-agent snapshot evals replay from).
  // session.end carries the end snapshot, which must not become the start state.
  if (e.repo && e.kind !== "session.end" && (!s.repo || !s.repo.snapshot)) s.repo = { ...e.repo };
  if (!proxyCall) foldModels(s.models, e);
  if (proxyCall || e.kind !== "llm.call") foldModels(s.proxyModels, e);
  switch (e.kind) {
    case "user.message": {
      const text = typeof e.payload.text === "string" ? e.payload.text : undefined;
      // Harness-injected notices (task completions, command output) are not user turns.
      if (text !== undefined && SYNTHETIC_PROMPT.test(text)) break;
      s.userMessages++;
      if (s.title !== undefined || !text?.trim()) break;
      if (COMMAND_PROMPT.test(text)) s.fallbackTitle ??= commandTitle(text);
      // A subagent's prompt is a brief: its first line names the task, once harness frame lines are skipped.
      else s.title = makeTitle(e.subagentId ? titleText(text).trim().split("\n", 1)[0]! : text);
      break;
    }
    case "session.start":
      s.launch ??= launchOf(e.payload);
      if (typeof e.payload.name === "string" && e.payload.name.trim()) s.startName ??= makeTitle(e.payload.name);
      foldTags(s, e.payload.tags);
      // A subagent's task description (the Agent tool's `description`) titles it, before its prompt.
      if (e.payload.source === "subagent" && typeof e.payload.description === "string" && e.payload.description.trim()) s.title = makeTitle(e.payload.description);
      break;
    case "turn.end":
      // A Stop that fired because a Stop hook blocked the previous one continues the same turn.
      // Turn ends per capture path: a session seen live (hooks) and from its
      // transcript (backfill) has two turn.end rows per turn wherever the two paths
      // share no natural key (most hook payloads name no turn the transcript knows).
      if (e.payload.stopHookActive === true) break;
      if (isBackfillEvent(e)) s.turnEnds.backfill++;
      else s.turnEnds.live++;
      if (e.turnId) s.turnIds.add(e.turnId);
      else if (isBackfillEvent(e)) s.turnEnds.backfillIdless++;
      else s.turnEnds.liveIdless++;
      break;
    case "tool.start":
    case "tool.end": {
      // A wrapper (Codex code-mode cell) runs other tool calls; those are the ones counted.
      // Tool calls by toolUseId (a call seen only by its start or only by its end
      // still counts once); calls without an id are counted by start/end events.
      if (e.payload.wrapper === true) break;
      const id = e.payload.toolUseId;
      if (typeof id === "string" && id) s.toolIds.add(id);
      else if (e.kind === "tool.start") s.idlessStarts++;
      else s.idlessEnds++;
      // A shell call that writes files (sed -i, `>`, tee, Set-Content, …): they count when it ends, unless it was stopped
      // or turned down (it never ran). A call with no id counts as it starts.
      if (e.kind === "tool.start") {
        const written = shellCallFiles(e.payload.tool, e.payload.input, e.cwd ?? s.cwd).map((f) => changeKey(f, e.cwd, s.cwd));
        if (written.length && typeof id === "string" && id) s.shellFiles.set(id, written);
        else for (const f of written) changed(s, f);
      } else if (typeof id === "string" && s.shellFiles.has(id)) {
        if (failure?.cls !== "interrupted") for (const f of s.shellFiles.get(id)!) changed(s, f);
        s.shellFiles.delete(id);
      }
      if (e.kind === "tool.end" && e.payload.ok === false) {
        if (!failure || failure.cls === "real") s.toolErrors++;
        else if (failure.cls === "benign") s.benignToolErrors++;
        else s.interruptedToolCalls++;
      }
      break;
    }
    case "error":
      // An API error (a 429, a 5xx, a network drop) is a failed model call.
      if (apiErrorEvent(e.payload)) s.llmErrors = addLlmError(s.llmErrors, e.payload);
      break;
    case "llm.call":
      if (llmCallFailed(e.payload)) s.llmErrors = addLlmError(s.llmErrors, e.payload);
      // A proxy-only session has no user.message events: the call's last prompt names it.
      if (proxyCall && typeof e.payload.prompt === "string" && e.payload.prompt.trim() && !SYNTHETIC_PROMPT.test(e.payload.prompt)) s.fallbackTitle ??= makeTitle(e.payload.prompt);
      break;
    case "file.change":
      // Keyed like a shell call's writes (relative to the cwd), so a file edited both ways counts once.
      if (typeof e.payload.path === "string" && e.payload.path) changed(s, changeKey(e.payload.path, e.cwd, s.cwd));
      break;
    case "test.result":
      s.lastTest = { passed: num(e.payload.passed) ?? 0, failed: num(e.payload.failed) ?? 0 };
      break;
    case "session.end":
      s.endedAt = e.ts;
      s.endIdle = isBackfillEvent(e) && e.payload.reason === "idle";
      if (e.repo?.snapshot) s.endSnapshot = e.repo.snapshot;
      break;
    case "notification":
      // A fork subagent (Claude Code): how much of the parent's context it started with. A count of 0, below 0 or not finite is skipped.
      if (e.payload.kind === "fork") {
        const n = count(e.payload.inheritedTokens);
        if (n) s.inheritedTokens ??= n;
      }
      // A host that names the thread (T3 Code): its title reads better than a handoff or delegation preamble.
      if (e.payload.type === "host-link" && typeof e.payload.title === "string" && e.payload.title.trim()) s.hostTitle ??= makeTitle(e.payload.title);
      // A host that knows who started the thread (T3 Code): a person's thread is interactive, whatever the agent's SDK says.
      if (e.payload.type === "host-link" && (e.payload.launch === "interactive" || e.payload.launch === "headless")) s.hostLaunch ??= e.payload.launch;
      break;
  }
}

/** A file the session changed (filesChanged), and an edit for stats.retrieval. */
function changed(s: SessionState, key: string): void {
  s.files.add(key);
  markRetrievalEdit(s.retrieval, key, s.cwd);
}

/**
 * The Session row for the events folded so far. Fields the events can't
 * provide (e.g. endSnapshot set by the snapshotter) are carried over from
 * `prev`. A state that is not `simple` needs `sorted`, the same events in time
 * order. Leaves the state as it was.
 */
export function sessionOf(s: SessionState, prev?: Session, sorted?: readonly AgentEvent[]): Session {
  const first = s.first;
  if (!first && !prev) throw new Error("buildSession needs at least one event or an existing session");
  if (!s.simple && !sorted) throw new Error("sessionOf needs the events of a session with spans or enrichment");
  const id = first?.sessionId ?? prev!.id;
  // The folds that count: without the proxy's copies when another capture path recorded the calls.
  const sansOtel = s.sansOtel && s.transcriptCalls ? s.sansOtel : undefined;
  const counted = sansOtel ?? (s.sansProxy && s.otherCalls ? s.sansProxy : s);
  const { usage, duplicate } = s.simple ? usageOf(counted.usage) : rollupUsage(counted === s ? sorted! : sorted!.filter((e) => !isProxyCall(e) && !(sansOtel && isOtelLogCopy(e))));
  const derails = derailsOf(s.derails);
  // A session.end followed by later captured activity was reopened (resumed
  // under the same id): it is not ended, whatever an earlier build stored.
  let endedAt = s.endedAt;
  const reopened = endedAt !== undefined && s.lastActivity !== undefined && s.lastActivity > endedAt + REOPEN_SLACK_MS;
  if (reopened) endedAt = undefined;
  let fallbackTitle = s.fallbackTitle;

  const durable = s.simple ? undefined : durableStats(sorted!);
  const ran = s.via ? hostedAgent(s, prev) : undefined;
  const session: Session = {
    id,
    // A host app's session is the agent it ran (Session.host names the host); a host thread that started none is the host's.
    // Durable engine spans (workflow.start, steps) can precede the agent's own events; they don't name it.
    // Nor does the client that started a durable run (a Restate ingress call): the code making model calls does.
    agent: ran ?? s.via ?? (durable ? sorted!.find((e) => e.kind === "llm.call") : undefined)?.agent ?? s.agent ?? first?.agent ?? prev!.agent,
    startedAt: first?.ts ?? prev!.startedAt,
    stats: {
      events: s.n,
      // Agents without a turn-end hook still have one turn per prompt.
      turns: turnCount(s.turnEnds, s.turnIds) || s.userMessages,
      // A crashed tool has a start without an end, a lost hook line an end without a start.
      toolCalls: s.toolIds.size + Math.max(s.idlessStarts, s.idlessEnds),
      toolErrors: s.toolErrors,
      filesChanged: s.files.size,
    },
    flags: flagsOf(s.flags, derails, sorted),
  };
  if (s.benignToolErrors) session.stats.benignToolErrors = s.benignToolErrors;
  if (s.interruptedToolCalls) session.stats.interruptedToolCalls = s.interruptedToolCalls;
  if (durable) {
    session.stats.durable = durable;
    session.flags.push(...durableFlags(durable));
    fallbackTitle ??= durable.workflow ?? `${durable.engine} run ${durable.runId}`;
  }
  if (derails.length) session.stats.derails = derails;
  const phases = phasesToStore(outlineOf(counted.outline));
  if (phases) session.stats.phases = phases;
  const waste = wasteStatsOf(s.waste);
  if (waste) {
    session.stats.waste = waste.stats;
    session.flags.push(...waste.flags);
  }
  const compactionRefetches = compactionRefetchStatsOf(s.waste);
  if (compactionRefetches) session.stats.compactionRefetches = compactionRefetches;
  const retrieval = retrievalOf(s.retrieval);
  if (retrieval) session.stats.retrieval = retrieval;
  const cacheBreaks = cacheBreaksOf(counted.cacheBreaks);
  if (cacheBreaks) session.stats.cacheBreaks = cacheBreaks;
  if (cacheUnderused(usage, session.stats.turns)) session.flags.push(FLAGS.cacheLow);
  session.flags.push(...skillFlags(skillUseOf(s.skills, s.cwd ?? prev?.cwd)));
  for (const t of s.tags ?? []) session.flags.push(`${TAG_FLAG}${t}`);
  const hookContext = hookContextOf(s.hookContext);
  if (hookContext) session.stats.hookContext = hookContext;
  const launch = s.hostLaunch ?? s.launch;
  if (launch) session.stats.launch = launch;
  const waiting = waitingOf(s.waiting, launch);
  if (waiting) session.stats.waiting = waiting;
  const parent = s.parent ?? prev?.parent;
  const subagent = !!parent && parent.type !== "provider-switch";
  const waits = waitStatsOf(s.waits, { launch, subagent });
  if (waits) session.stats.waits = waits;
  const prs = prsOf(s.prs);
  if (prs) session.stats.prs = prs;
  if (s.inheritedTokens) session.stats.inheritedTokens = s.inheritedTokens;
  const memoryUse = memoryUseOf(s.memory, s.cwd ?? prev?.cwd);
  if (memoryUse) session.stats.memoryUse = memoryUse;
  session.flags.push(...hookContextFlags(s.hookContext));
  const weightEdits = weightEditsOf(s.weightEdits);
  if (weightEdits) session.stats.weightEdits = weightEdits;
  session.flags.push(...weightEditFlags(s.weightEdits));
  const redactions = redactionsOf(s.redactions);
  if (redactions) session.stats.redactions = redactions;
  if (exposesSecret(redactions)) session.flags.push(FLAGS.secretExposed);
  const unapproved = unapprovedOf(s.flags.unapproved);
  if (unapproved) session.stats.unapprovedActions = unapproved;
  if (s.lastTest) {
    session.stats.testsPassed = s.lastTest.passed;
    session.stats.testsFailed = s.lastTest.failed;
  }
  if (Object.keys(usage).length) session.stats.usage = usage;
  if (duplicate) session.stats.duplicateUsage = duplicate;
  if (s.llmErrors) session.stats.llmErrors = { ...s.llmErrors };
  const modelFold = sansOtel ? sansOtel.models : s.otherCalls ? s.models : s.proxyModels;
  const models = modelsOf(modelFold);
  if (models) session.stats.models = models;
  const modelSwitch = modelSwitchOf(modelFold);
  if (modelSwitch) session.stats.modelSwitch = modelSwitch;
  session.flags.push(...modelFlags(modelFold, modelSwitch));
  const latency = latencyOf(counted.latency, endedAt);
  if (Object.keys(latency).length) session.stats.latency = latency;
  const set = <K extends keyof Session>(k: K, v: Session[K] | undefined) => {
    if (v !== undefined) session[k] = v;
  };
  set("agentVersion", s.agentVersion ?? prev?.agentVersion);
  // The agent a host ran (also `agent`), kept as provider for older readers; the host app as host.
  if (s.via) set("provider", ran ?? s.provider ?? prev?.provider);
  if (ran) set("host", s.via);
  // The model most main-thread calls ran on, not the last one seen: a silent fallback
  // (stats.modelSwitch) or a helper model's call (a title) must not relabel the session.
  set("model", mainModelOf(modelFold) ?? s.model ?? prev?.model);
  // The person's turns, as turn waits count them: in a session launched interactively that is not a subagent.
  if (launch === "interactive" && !subagent) {
    const turnsByModel = turnsByModelOf(s.turns, session.model);
    if (turnsByModel) session.stats.turnsByModel = turnsByModel;
  }
  const { edits, shells } = callStatsOf(s.turns);
  if (edits) session.stats.edits = edits;
  if (shells) session.stats.shells = shells;
  set("cwd", s.cwd ?? prev?.cwd);
  // The earliest repo state wins; one with a snapshot is never replaced (see foldSession).
  set("repo", prev?.repo?.snapshot ? prev.repo : (s.repo ?? prev?.repo));
  set("title", workflowAgentTitle(s.hostTitle ?? s.title ?? fallbackTitle ?? s.startName ?? prev?.title, s.parent ?? prev?.parent));
  const traceIds = new Set<string>(prev?.traceIds ?? []);
  for (const t of s.traceIds) {
    if (traceIds.size >= MAX_TRACE_IDS) break;
    traceIds.add(t);
  }
  // Sessions that never get a session.end end at their last activity seen so far
  // (see Session.endedAt), a value that moves forward as more events arrive:
  // - conversation-keyed OTel sessions (id is a conversation id, not one of its
  //   traces) and log-keyed ones (OTel logs carry no traceId at all);
  // - SDK sessions (source "sdk", alone or mixed with OTel spans): apps send
  //   events per conversation and rarely a session.end;
  // - sessions known only from a recorded transcript (backfill): a transcript
  //   is history, and it has no end marker.
  // Trace-keyed OTel sessions end with the root span's session.end.
  const allLive = s.captured > 0 && s.allLive;
  const allTranscript = s.captured > 0 && s.allTranscript;
  const endsAtLastActivity = (allLive && !traceIds.has(id)) || allTranscript;
  // A tool call still open with no real end (a transcript that stops mid-call, then
  // only its quiet marker): the session did not finish, so it has no end. A real
  // session.end closes every open call (core/waiting.ts).
  const midCall = s.waiting.open.length > 0 && (endedAt === undefined || s.endIdle === true);
  if (midCall) endedAt = undefined;
  const inferredEnd = endsAtLastActivity && !midCall ? s.lastEnd : undefined;
  // An inferred end is worked out again from the events on every fold: the previous
  // row's is kept only by a fold with no events of its own, so the row stays what
  // a fold from scratch gives (a hook line that joins a transcript session drops it).
  const prevInferred = prev?.stats?.endInferred === true && s.captured === 0;
  const dropPrev = reopened || midCall || (prev?.stats?.endInferred === true && !prevInferred);
  set("endedAt", endedAt ?? inferredEnd ?? (dropPrev ? undefined : prev?.endedAt));
  // No session.end: the end above is only the last activity seen (stats.endInferred).
  if (endedAt === undefined && session.endedAt !== undefined && (inferredEnd !== undefined || prevInferred)) session.stats.endInferred = true;
  if (traceIds.size) session.traceIds = [...traceIds];
  set("runId", s.runId ?? prev?.runId);
  set("endSnapshot", s.endSnapshot ?? prev?.endSnapshot);
  set("parent", s.parent ?? prev?.parent);
  const project = s.project ?? prev?.project;
  if (project && project !== "default") session.project = project;
  set("parseVersion", prev?.parseVersion);
  return session;
}

/**
 * Folds a session's events into a Session row. Fields the events can't
 * provide (e.g. endSnapshot set by the snapshotter) are carried over from `prev`.
 */
export function buildSession(events: AgentEvent[], prev?: Session): Session {
  const sorted = byTime(events);
  const s = sessionState();
  for (const e of sorted) foldSession(s, e);
  return sessionOf(s, prev, sorted);
}

/** A model call that failed: `ok: false`, or an HTTP status of 400 or more. */
export function llmCallFailed(payload: Record<string, unknown>): boolean {
  return payload.ok === false || (typeof payload.statusCode === "number" && payload.statusCode >= 400);
}

/** An error event that reports a failed model call: source "api", or an HTTP status of 400 or more. */
export function apiErrorEvent(payload: Record<string, unknown>): boolean {
  return payload.source === "api" || (typeof payload.statusCode === "number" && payload.statusCode >= 400);
}

/** Counts one failed call (sessions are built in time order, so the first one keeps its status and message). */
export function addLlmError(prev: LlmErrors | undefined, payload: Record<string, unknown>): LlmErrors {
  if (prev) return { ...prev, count: prev.count + 1 };
  const out: LlmErrors = { count: 1 };
  if (typeof payload.statusCode === "number") out.statusCode = payload.statusCode;
  const msg = typeof payload.error === "string" && payload.error ? payload.error : typeof payload.message === "string" && payload.message ? payload.message : undefined;
  if (msg) out.error = msg.slice(0, 300);
  return out;
}

/**
 * The key a changed file counts under in stats.filesChanged (and `coding.sh work show`, `show`):
 * the path resolved against the folder the event ran in, then relative to the session's cwd, so
 * one file edited while the agent's folder changed counts once. A path outside the session's cwd
 * stays absolute. On a Windows drive, `C:\x`, `c:/x` and Git Bash's `/c/x` are one key (onDrive).
 */
export function changeKey(path: string, eventCwd: string | undefined, sessionCwd: string | undefined): string {
  return changeKeyer(eventCwd, sessionCwd)(path);
}

/** changeKey for the paths of one event: the two folders are read once, not once per path. */
export function changeKeyer(eventCwd: string | undefined, sessionCwd: string | undefined): (path: string) => string {
  const root = traceRoot(eventCwd ?? sessionCwd);
  const drive = driveOf(root);
  if (!eventCwd || !sessionCwd) return (path) => underTraceRoot(onDrive(path, drive), root);
  const sessionRoot = traceRoot(sessionCwd);
  const sessionDrive = driveOf(sessionRoot);
  const base = eventCwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return (path) => {
    const k = underTraceRoot(onDrive(path, drive), root);
    // An absolute path outside the event's folder (a shell call that ran `cd <repo> && sed -i …` from a
    // subfolder) can still be inside the session's: key it relative to that, or the file counts twice.
    return underTraceRoot(onDrive(/^(?:[A-Za-z]:)?\//.test(k) ? k : `${base}/${k}`, sessionDrive), sessionRoot);
  };
}

/**
 * A session.start an older build's ingest stamped with the session its hook's
 * env named (spool/spawned.ts): `{ parentSessionId, parentAgent, subagentType:
 * "harness" }`. That id can be stale (a session that ended, or was never
 * captured), so it is not the parent: ingest links a harness child once it has
 * checked the named session (core/ingest.ts childLinker).
 */
const isSpawnMarker = (p: AgentEvent["payload"]): boolean => p.subagentType === "harness" && typeof p.parentAgent === "string";

/**
 * Parent link for a subagent session, from its session.start payload
 * ({ parentSessionId, parentEventId?, subagentId?, subagentType? }, and for a
 * workflow agent workflowId, workflowName?, workflowPhase?, workflowLabel?).
 * Ingest also links children named by a parent's subagent.* childSessionId.
 */
export function parentOf(sorted: AgentEvent[]): Session["parent"] | undefined {
  const start = sorted.find((e) => e.kind === "session.start" && typeof e.payload.parentSessionId === "string");
  if (!start) return undefined;
  const p = start.payload;
  const parent: NonNullable<Session["parent"]> = { sessionId: p.parentSessionId as string };
  if (typeof p.parentEventId === "string") parent.eventId = p.parentEventId;
  const subagentId = typeof p.subagentId === "string" ? p.subagentId : start.subagentId;
  if (subagentId) parent.subagentId = subagentId;
  if (typeof p.subagentType === "string") parent.type = p.subagentType;
  // A workflow agent: the run it belongs to, and its phase and label in that run.
  const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const workflowId = text(p.workflowId);
  if (workflowId) {
    parent.workflowId = workflowId;
    const name = text(p.workflowName);
    const phase = text(p.workflowPhase);
    const label = text(p.workflowLabel);
    if (name) parent.workflowName = name;
    if (phase) parent.phase = phase;
    if (label) parent.label = label;
  }
  return parent;
}

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Latency inputs folded so far (see latencyStats). */
interface LatencyState {
  firstTs?: number;
  lastTs?: number;
  /** Latest end of any event (eventEnd). */
  maxEnd?: number;
  llmCalls: number;
  llm: number[];
  ttft: number[];
  toolStartTs: Map<string, number>;
  tools: number[];
  subagents: Set<string>;
  anonymousSubagents: number;
}

const latencyState = (): LatencyState => ({ llmCalls: 0, llm: [], ttft: [], toolStartTs: new Map(), tools: [], subagents: new Set(), anonymousSubagents: 0 });

function foldLatency(s: LatencyState, e: AgentEvent): void {
  s.firstTs ??= e.ts;
  s.lastTs = e.ts;
  const end = eventEnd(e);
  s.maxEnd = s.maxEnd === undefined ? end : Math.max(s.maxEnd, end);
  if (e.kind === "llm.call") {
    s.llmCalls++;
    const d = num(e.durationMs);
    if (d !== undefined) s.llm.push(d);
    const t = num(e.payload.ttftMs);
    if (t !== undefined) s.ttft.push(t);
  } else if (e.kind === "tool.start") {
    if (typeof e.payload.toolUseId === "string") s.toolStartTs.set(e.payload.toolUseId, e.ts);
  } else if (e.kind === "tool.end" && e.payload.wrapper !== true) {
    let d = num(e.durationMs) ?? num(e.payload.durationMs);
    if (d === undefined && typeof e.payload.toolUseId === "string") {
      const startTs = s.toolStartTs.get(e.payload.toolUseId);
      if (startTs !== undefined && e.ts >= startTs) d = e.ts - startTs;
    }
    if (d !== undefined) s.tools.push(d);
  } else if (e.kind === "subagent.start") {
    const id = typeof e.payload.subagentId === "string" ? e.payload.subagentId : e.subagentId;
    if (id) s.subagents.add(id);
    else s.anonymousSubagents++;
  }
}

function latencyOf(s: LatencyState, endedAt?: number): LatencyStats {
  const out: LatencyStats = {};
  if (s.firstTs !== undefined && s.lastTs !== undefined) out.wallMs = Math.max(0, Math.max(endedAt ?? s.lastTs, s.maxEnd!) - s.firstTs);
  if (s.llmCalls) {
    out.llmCalls = s.llmCalls;
    if (s.llm.length) {
      out.llmMs = round(s.llm.reduce((a, b) => a + b, 0));
      out.llmP50Ms = percentile(s.llm, 50);
      out.llmP95Ms = percentile(s.llm, 95);
    }
    if (s.ttft.length) out.ttftP50Ms = percentile(s.ttft, 50);
  }
  if (s.tools.length) {
    out.toolMs = round(s.tools.reduce((a, b) => a + b, 0));
    out.toolP95Ms = percentile(s.tools, 95);
  }
  const subagentCount = s.subagents.size + s.anonymousSubagents;
  if (subagentCount) out.subagents = subagentCount;
  return out;
}

/**
 * Latency aggregates. Tool durations come from tool.end (event.durationMs,
 * then payload.durationMs, then end − matching tool.start ts).
 */
export function latencyStats(sorted: AgentEvent[], endedAt?: number): LatencyStats {
  const s = latencyState();
  for (const e of sorted) foldLatency(s, e);
  return latencyOf(s, endedAt);
}

// ---------------------------------------------------------------- detectors

/** What the failure-pattern detectors carry from one event to the next. */
interface FlagState {
  premature: PrematureState;
  repeated: RepeatedFailureState;
  fileChange: boolean;
  verified: boolean;
  compaction: boolean;
  textToolCall: boolean;
  gateways: Set<GatewayId>;
  tamper: TamperState;
  unapproved: UnapprovedState;
  apiStall: ApiStallState;
  llmError: LlmErrorState;
  sight: SightState;
}

const flagState = (): FlagState => ({
  apiStall: { errors: 0, waitMs: 0, exhausted: false, open: false, at: 0 },
  llmError: { open: false, at: 0 },
  sight: { llmCalls: false, blind: true, tools: false },
  premature: prematureState(),
  repeated: repeatedFailureState(),
  fileChange: false,
  verified: false,
  compaction: false,
  textToolCall: false,
  gateways: new Set(),
  tamper: tamperState(),
  unapproved: unapprovedState(),
});

/** Anthropic's tool-use markup opening a call on a line of its own: `<invoke name="Read">`, then a parameter or the close. */
const TEXT_TOOL_CALL = /^[ \t]*<invoke name="[\w.:-]+">\s*(?:<parameter name="|<\/invoke>)/m;
/** A fenced code block: markup inside one is quoted, not called. */
const CODE_BLOCK = /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1/gm;

/**
 * The model wrote a tool call out as text instead of calling the tool, so it
 * never ran. A model does this when the tool it reaches for was not given to it,
 * such as a Claude Code subagent whose `tools:` frontmatter is a map
 * (`edit: false`) rather than a list of names. Markup inside a fenced code
 * block or mid-line (prose about tool calls) does not count.
 */
export function writesToolCallAsText(text: string): boolean {
  return text.includes("<invoke name=") && TEXT_TOOL_CALL.test(text.replace(CODE_BLOCK, ""));
}

/** api-stall thresholds. Documented in docs/concepts.md; change both together. */
export const API_STALL = {
  /** This many rate-limit or overload errors in one session… */
  errors: 3,
  /** …or retry waits the API asked for (retryAfterMs) adding up to this long. */
  waitMs: 60_000,
} as const;

/** Rate-limit and overload errors the model API returned, and whether the session got past the last one. */
interface ApiStallState {
  errors: number;
  waitMs: number;
  /** A retry was the last one allowed (retryAttempt ≥ maxRetries): the request gave up. */
  exhausted: boolean;
  /** No model call or tool call has followed the last such error yet. */
  open: boolean;
  /** ts of the last such error. */
  at: number;
}

/** What a rate limit or an overloaded provider says in an error message or type. */
const CAPACITY_TEXT = /\b(?:429|529)\b|rate[ _-]?limit|overloaded|too many requests|usage limit/i;

/** A failed model call that ran into a rate limit or an overloaded provider (HTTP 429 or 529), not a bad request or an outage. */
export function capacityError(p: Record<string, unknown>): boolean {
  if (p.statusCode === 429 || p.statusCode === 529 || p.errorClass === "rate_limit" || p.errorClass === "overloaded") return true;
  return [p.errorType, p.error, p.message].some((v) => typeof v === "string" && CAPACITY_TEXT.test(v));
}

function foldApiStall(s: ApiStallState, e: AgentEvent): void {
  if (isEnrichment(e)) return;
  const failed = (e.kind === "error" && apiErrorEvent(e.payload)) || (e.kind === "llm.call" && llmCallFailed(e.payload));
  if (failed) {
    if (!capacityError(e.payload)) return;
    s.errors++;
    s.waitMs += Math.max(0, num(e.payload.retryAfterMs) ?? 0);
    const attempt = num(e.payload.retryAttempt);
    const max = num(e.payload.maxRetries);
    if (attempt !== undefined && max !== undefined && attempt >= max) s.exhausted = true;
    s.open = true;
    s.at = e.ts;
    return;
  }
  // The agent got going again: a model call that worked, a reply or a tool call, after the error (not the error's own message).
  if (s.open && e.ts > s.at && (e.kind === "llm.call" || e.kind === "assistant.message" || e.kind === "tool.start")) s.open = false;
}

/** The last failed model call that was not a capacity error, and whether the session got past it. */
interface LlmErrorState {
  /** No model call that worked, reply or tool call has followed it yet. */
  open: boolean;
  /** ts of the failed call. */
  at: number;
}

function foldLlmError(s: LlmErrorState, e: AgentEvent): void {
  if (isEnrichment(e)) return;
  const failed = (e.kind === "error" && apiErrorEvent(e.payload)) || (e.kind === "llm.call" && llmCallFailed(e.payload));
  if (failed) {
    // A rate limit or overload is api-stall's to judge.
    if (capacityError(e.payload)) return;
    s.open = true;
    s.at = e.ts;
    return;
  }
  if (s.open && e.ts > s.at && (e.kind === "llm.call" || e.kind === "assistant.message" || e.kind === "tool.start")) s.open = false;
}

/** Whether the session's source can see tool calls: tools:unseen when it records model calls only. */
interface SightState {
  llmCalls: boolean;
  /** Every event so far came from the proxy, or from the SDK outside a trace() (no parentId). */
  blind: boolean;
  tools: boolean;
}

function foldSight(s: SightState, e: AgentEvent): void {
  if (isEnrichment(e)) return;
  if (e.kind === "llm.call") s.llmCalls = true;
  if (e.kind === "tool.start" || e.kind === "tool.end") s.tools = true;
  if (s.blind && !(e.source === "proxy" || (e.source === "sdk" && e.parentId === undefined))) s.blind = false;
}

/**
 * The model API held the session up: API_STALL.errors or more rate-limit or
 * overload errors, retry waits of API_STALL.waitMs or more in all, a request
 * that ran out of retries, or a last such error the session never got past. A
 * single 429 that a retry got past is not a stall.
 */
const apiStalled = (s: ApiStallState): boolean => s.errors >= API_STALL.errors || s.waitMs >= API_STALL.waitMs || s.exhausted || s.open;

/** `failure`: how a failed tool.end failed (core/failures.ts); undefined counts it as real. */
function foldFlags(s: FlagState, e: AgentEvent, failure?: FailureClass): void {
  foldPremature(s.premature, e);
  foldRepeatedFailure(s.repeated, e, 3, failure);
  foldTamper(s.tamper, e);
  foldUnapproved(s.unapproved, e);
  if (e.kind === "file.change") s.fileChange = true;
  if (e.kind === "test.result" || isVerifyToolStart(e)) s.verified = true;
  if (e.kind === "context.compact") s.compaction = true;
  foldApiStall(s.apiStall, e);
  foldLlmError(s.llmError, e);
  foldSight(s.sight, e);
  if (e.kind === "assistant.message" && !s.textToolCall && typeof e.payload.text === "string" && writesToolCallAsText(e.payload.text)) s.textToolCall = true;
  const g = gatewayOfEvent(e);
  if (g) s.gateways.add(g);
}

/** `sorted` (the events folded, in time order) is needed only when the tamper fold can't settle on its own. */
function flagsOf(s: FlagState, derails: readonly Derail[], sorted?: readonly AgentEvent[]): string[] {
  const flags: string[] = [];
  if (s.premature.endedWhileFailing) flags.push(FLAGS.prematureCompletion);
  if (s.repeated.found) flags.push(FLAGS.repeatedToolFailure);
  if (s.fileChange && !s.verified) flags.push(FLAGS.noVerification);
  if (s.compaction) flags.push(FLAGS.compaction);
  if (s.textToolCall) flags.push(FLAGS.textToolCall);
  if (apiStalled(s.apiStall)) flags.push(FLAGS.apiStall);
  if (s.llmError.open) flags.push(FLAGS.llmError);
  if (s.sight.llmCalls && s.sight.blind && !s.sight.tools) flags.push(FLAGS.toolsUnseen);
  for (const d of derails) if (!flags.includes(d.flag)) flags.push(d.flag);
  if (s.tamper.high || (s.tamper.needsEvents && detectTestTamper(sorted!))) flags.push(FLAGS.testTamper);
  if (s.unapproved.hits.length) flags.push(FLAGS.unapprovedAction);
  flags.push(...gatewayFlagsOf(s.gateways));
  return flags;
}

/**
 * A session with nothing to look at: no turn, no tool call and no model call
 * (a hook that fired with no agent work behind it, such as a wrapper process
 * or a subagent that never ran). A changed file, a start snapshot (what
 * `coding.sh run` takes) or a recorded weight edit or checkpoint is something to look at. `coding.sh sessions` hides
 * the empty ones unless --empty. Applied when listing, not when folding.
 */
export function isEmptySession(s: Pick<Session, "stats"> & Partial<Pick<Session, "repo">>): boolean {
  const { turns, toolCalls, usage, latency, filesChanged, weightEdits } = s.stats;
  if (filesChanged > 0 || s.repo?.snapshot || weightEdits) return false;
  return !turns && !toolCalls && !latency?.llmCalls && !usage?.inputTokens && !usage?.outputTokens && !usage?.costUsd;
}

/** Failure flags for a session. `derails` (already detected on the same events) saves detecting them again. */
export function detectFlags(events: AgentEvent[], derails?: readonly Derail[]): string[] {
  const sorted = byTime(events);
  const s = flagState();
  const failures = failureState();
  for (const e of sorted) foldFlags(s, e, foldFailure(failures, e)?.cls);
  return flagsOf(s, derails ?? detectDerails(sorted), sorted);
}

interface PrematureState {
  failing: boolean;
  endedWhileFailing: boolean;
  /** The agent's text since its last tool call, test result or prompt: what it says as the turn ends. */
  said: string;
  /** The agent already said that the latest test run fails. */
  reported: boolean;
}

const prematureState = (): PrematureState => ({ failing: false, endedWhileFailing: false, said: "", reported: false });

/** Enough of the closing text to judge it (core/failure-report.ts), kept small in a saved fold. */
const SAID_MAX = 4000;

function foldPremature(s: PrematureState, e: AgentEvent): void {
  switch (e.kind) {
    case "test.result":
      s.failing = (num(e.payload.failed) ?? 0) > 0;
      s.reported = false;
      s.said = "";
      // A later green run means the work was eventually finished.
      if (!s.failing) s.endedWhileFailing = false;
      return;
    case "assistant.message": {
      const t = e.payload.text;
      if (typeof t === "string" && t.trim()) s.said = (s.said ? `${s.said}\n${t}` : t).slice(-SAID_MAX);
      return;
    }
    case "tool.start":
    case "user.message":
      s.said = "";
      return;
    case "turn.end":
    case "session.end":
      if (s.failing) {
        // Saying plainly that tests still fail is an honest stop, not a premature one. Once it is said,
        // a later end (session.end after turn.end, "You're welcome.") is premature only if it claims success.
        if (reportsFailure(s.said)) s.reported = true;
        else if (!s.reported || claimsSuccess(s.said)) s.endedWhileFailing = true;
      }
      s.said = "";
  }
}

/**
 * The agent ended a turn/session while the latest test run was failing without
 * saying so (it said it was done, or said nothing about the failure), and tests
 * never went green afterwards.
 */
export function detectPrematureCompletion(sorted: AgentEvent[]): boolean {
  const s = prematureState();
  for (const e of sorted) foldPremature(s, e);
  return s.endedWhileFailing;
}

function signature(tool: string, input: unknown): string {
  const cmd = commandOf(input);
  if (cmd !== undefined) return cmd;
  if (input === undefined) return tool;
  return typeof input === "string" ? input : JSON.stringify(input);
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9_./-]+/).filter(Boolean));
}

/** Jaccard similarity of token sets ≥ 0.6, or exact match after whitespace normalization. */
export function similarInputs(a: string, b: string): boolean {
  if (a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim()) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.6;
}

interface RepeatedFailureState {
  /** Signature of each started call's input, by toolUseId (a tool.end often leaves its input out). */
  inputs: Map<string, string>;
  streaks: Map<string, { count: number; sig: string }>;
  found: boolean;
}

const repeatedFailureState = (): RepeatedFailureState => ({ inputs: new Map(), streaks: new Map(), found: false });

function foldRepeatedFailure(s: RepeatedFailureState, e: AgentEvent, threshold = 3, failure?: FailureClass): void {
  if (s.found) return;
  const id = typeof e.payload.toolUseId === "string" ? e.payload.toolUseId : undefined;
  if (e.kind === "tool.start" && id) {
    // signature() only names the tool when there is no input at all.
    if (e.payload.input === undefined) s.inputs.delete(id);
    else s.inputs.set(id, signature("", e.payload.input));
  }
  if (e.kind !== "tool.end") return;
  const tool = typeof e.payload.tool === "string" ? e.payload.tool : "?";
  if (e.payload.ok !== false) {
    s.streaks.delete(tool);
    return;
  }
  // No match, a probe, files that differ, a call the user stopped: not a failure to retry, and no success either.
  if (failure !== undefined && failure !== "real") return;
  const input = e.payload.input;
  const sig = input !== undefined && input !== null ? signature(tool, input) : ((id ? s.inputs.get(id) : undefined) ?? signature(tool, input ?? undefined));
  const prev = s.streaks.get(tool);
  const count = prev && similarInputs(prev.sig, sig) ? prev.count + 1 : 1;
  if (count >= threshold) {
    s.found = true;
    s.inputs.clear();
    s.streaks.clear();
    return;
  }
  s.streaks.set(tool, { count, sig });
}

/**
 * ≥3 consecutive real failures of the same tool with similar input (the agent
 * is stuck retrying). Benign failures (`rg` finding nothing) and interrupted
 * calls are skipped (core/failures.ts).
 */
export function detectRepeatedToolFailure(sorted: AgentEvent[], threshold = 3): boolean {
  const s = repeatedFailureState();
  const failures = failureState();
  for (const e of sorted) {
    foldRepeatedFailure(s, e, threshold, foldFailure(failures, e)?.cls);
    if (s.found) return true;
  }
  return false;
}

/** Files were changed but nothing was ever run to check them. */
export function detectNoVerification(sorted: AgentEvent[]): boolean {
  if (!sorted.some((e) => e.kind === "file.change")) return false;
  return !sorted.some((e) => e.kind === "test.result" || isVerifyToolStart(e));
}

// ------------------------------------------------------------ pull requests

/**
 * Session.stats.prs holds at most this many PRs the session only linked (viewed, watched, pushed to);
 * a new one past it drops the linked one seen longest ago. PRs it opened, merged or closed stay.
 */
export const PRS_MAX = 20;
/** Session.stats.prs holds at most this many in all; past it the oldest linked one goes first, else the oldest. */
export const PRS_ALL_MAX = 500;
/** Output read per tool call for PR URLs and gh's merge and close lines. */
const PR_SCAN_CHARS = 64 * 1024;
/** A GitHub (or GitHub Enterprise) pull request's web URL. */
const PR_URL = /https?:\/\/([\w.-]*github[\w.-]*)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/gi;
/** What gh prints after it merged or closed a PR: "Squashed and merged pull request owner/name#12 (title)". */
const PR_DONE_LINE = /\b(merged|closed) pull request (?:([\w.-]+\/[\w.-]+))?#(\d+)/gi;
/** A remote a push names: "To https://github.com/owner/name.git", "To git@github.com:owner/name.git". */ // slop-allow personal-data: an SSH remote's form, not an email
const PUSH_REMOTE = /^To (?:https?:\/\/(?:[^@\s/]+@)?|ssh:\/\/[^@\s/]+@|[^@\s/]+@)([\w.-]*github[\w.-]*)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/m;
/** gh pr verbs that name a PR without changing its state. */
const PR_LINK_VERBS = new Set(["view", "checks", "ready", "edit", "comment", "review", "diff", "checkout"]);
/** gh pr flags that take a value, so the value is not read as the PR. */
const GH_VALUE_FLAGS = new Set(["-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head", "-l", "--label", "-a", "--assignee", "-r", "--reviewer", "-m", "--milestone", "-p", "--project", "-T", "--template", "-A", "--author-email", "--subject", "--match-head-commit", "-c", "--comment", "--add-label", "--remove-label", "--add-reviewer", "--remove-reviewer", "--add-assignee", "--remove-assignee", "--json", "-q", "--jq"]);
/** A host tool that links or watches a PR (T3 Code's link_pull_request, watch_pull_request, link_pull_requests). */
const HOST_PR_TOOL = /(?:^|[_.:/-])(?:link|watch)_pull_requests?$/i;
/** A host tool that links a PR to the calling thread: the thread's own PR (PullRequestRef.own). */
const HOST_PR_LINK = /(?:^|[_.:/-])link_pull_requests?$/i;
/** A GitHub MCP server's PR tools. */
const MCP_PR_CREATE = /(?:^|[_.:/-])create_pull_request$/i;
const MCP_PR_MERGE = /(?:^|[_.:/-])merge_pull_request$/i;

type PrState = PullRequestRef["state"];
interface PrRepo {
  host: string;
  name: string;
}
interface PrRef {
  number?: number;
  repo?: PrRepo;
}
/** One `gh pr <verb>` in a shell command. */
interface GhPr extends PrRef {
  verb: string;
  auto?: boolean;
}
/** What a started call will do to PRs, read from its input: gh pr verbs, a push, a host or MCP PR tool. */
interface PrCall {
  gh: GhPr[];
  push?: boolean;
  /** A host or MCP tool: the state it sets, and the PRs its input names (or its output's first URL). */
  tool?: { state: PrState; refs: PrRef[]; fromOutput?: boolean; own?: boolean };
}
export interface PrFoldState {
  list: PullRequestRef[];
  /** Started calls that touch PRs, by toolUseId ("" for a call with no id). */
  calls: Map<string, PrCall>;
  /** The repo the session's push output, gh output or --repo named first. */
  repo?: PrRepo;
}

export const prFoldState = (): PrFoldState => ({ list: [], calls: new Map() });

/** "owner/name", "host/owner/name" or a repo URL, as gh's --repo takes it. */
function repoArg(v: string | undefined): PrRepo | undefined {
  if (!v) return undefined;
  const m = /^(?:https?:\/\/)?(?:([\w-]+(?:\.[\w-]+)+)\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(v.trim());
  return m ? { host: (m[1] ?? "github.com").toLowerCase(), name: `${m[2]}/${m[3]}` } : undefined;
}

/** A PR URL's number and repo. */
function prUrl(v: string): PrRef | undefined {
  const m = new RegExp(PR_URL.source, "i").exec(v);
  return m ? { number: Number(m[4]), repo: { host: m[1]!.toLowerCase(), name: `${m[2]}/${m[3]}` } } : undefined;
}

/** Words of a shell command segment, with simple quoting. */
function shellWords(seg: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(seg); m; m = re.exec(seg)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

const isGh = (w: string): boolean => /(?:^|[/\\])gh(?:\.exe)?$/.test(w);
const isGit = (w: string): boolean => /(?:^|[/\\])git(?:\.exe)?$/.test(w);

/** The `gh pr` verbs and `git push` of a shell command. */
function prCallOfCommand(cmd: string): PrCall | undefined {
  if (!/\bgh(?:\.exe)?\s+pr\b|\bgit\b[^\n;&|]*\bpush\b/.test(cmd)) return undefined;
  const call: PrCall = { gh: [] };
  for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
    const w = shellWords(seg);
    const gh = w.findIndex(isGh);
    if (gh >= 0 && w[gh + 1] === "pr" && w[gh + 2]) {
      const pr: GhPr = { verb: w[gh + 2]! };
      for (let i = gh + 3; i < w.length; i++) {
        const x = w[i]!;
        const eq = x.startsWith("-") ? x.indexOf("=") : -1;
        const flag = eq > 0 ? x.slice(0, eq) : x;
        const value = eq > 0 ? x.slice(eq + 1) : undefined;
        if (flag === "-R" || flag === "--repo") pr.repo = repoArg(value ?? w[++i]) ?? pr.repo;
        else if (flag === "--auto") pr.auto = true;
        else if (GH_VALUE_FLAGS.has(flag)) {
          if (value === undefined) i++;
        } else if (!x.startsWith("-") && pr.number === undefined) {
          const url = prUrl(x);
          if (url) Object.assign(pr, url);
          else if (/^#?\d+$/.test(x)) pr.number = Number(x.replace("#", ""));
        }
      }
      call.gh.push(pr);
      continue;
    }
    const git = w.findIndex(isGit);
    // `git push`, `git -C dir push`: the first word after git's own options.
    if (git >= 0) {
      let i = git + 1;
      while (i < w.length && w[i]!.startsWith("-")) i += w[i] === "-C" || w[i] === "-c" ? 2 : 1;
      if (w[i] === "push") call.push = true;
    }
  }
  return call.gh.length || call.push ? call : undefined;
}

const intOf = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^#?\d+$/.test(v.trim()) ? Number(v.trim().replace("#", "")) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** The PRs a host or MCP tool's input names: URLs, or a repository (or owner and repo) with a number. */
function prRefsOfInput(input: Record<string, unknown>): PrRef[] {
  const urls = (Array.isArray(input.urls) ? [input.url, ...input.urls] : [input.url]).filter((u): u is string => typeof u === "string");
  const refs = urls.map(prUrl).filter((r): r is PrRef => !!r);
  if (refs.length) return refs;
  const number = intOf(input.number ?? input.pullNumber ?? input.pull_number);
  if (number === undefined) return [];
  const named = typeof input.repository === "string" ? input.repository : typeof input.owner === "string" && typeof input.repo === "string" ? `${input.owner}/${input.repo}` : undefined;
  const host = typeof input.host === "string" && input.host.includes(".") ? input.host : undefined;
  const repo = repoArg(named && host && named.split("/").length === 2 ? `${host}/${named}` : named);
  return [repo ? { number, repo } : { number }];
}

/** What a tool call will do to PRs, from its tool name and input; undefined for a call that touches none. */
function prCallOf(tool: unknown, input: unknown): PrCall | undefined {
  const name = typeof tool === "string" ? tool : "";
  const cmd = shellCommandOf(name, input);
  if (cmd) return prCallOfCommand(cmd);
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  if (HOST_PR_TOOL.test(name)) return { gh: [], tool: { state: "linked", refs: prRefsOfInput(o), own: HOST_PR_LINK.test(name) } };
  if (MCP_PR_MERGE.test(name)) return { gh: [], tool: { state: "merged", refs: prRefsOfInput(o) } };
  if (MCP_PR_CREATE.test(name)) return { gh: [], tool: { state: "opened", refs: [], fromOutput: true } };
  return undefined;
}

/**
 * Notes a state the session saw for a PR. A PR named by number only is in the session's repo, else
 * the one PR of that number it already saw. The later state wins, but `linked` never replaces another.
 * `own` (a push to it, a link to the session's thread) stays once seen.
 */
function notePr(s: PrFoldState, number: number, repo: PrRepo | undefined, state: PrState, at: number, own = false): void {
  const same = s.list.filter((p) => p.number === number);
  const r = repo ?? (same.length === 1 && same[0]!.url ? prUrl(same[0]!.url)?.repo : undefined) ?? s.repo;
  const i = s.list.findIndex((p) => p.number === number && (!r || !p.repo || p.repo === r.name));
  const old = i >= 0 ? s.list[i]! : undefined;
  const entry: PullRequestRef = { number, state, at };
  if (r) {
    entry.url = `https://${r.host}/${r.name}/pull/${number}`;
    entry.repo = r.name;
  }
  if (old) {
    s.list.splice(i, 1);
    if (state === "linked" && old.state !== "linked") {
      entry.state = old.state;
      entry.at = old.at;
    }
  }
  if (own || old?.own) entry.own = true;
  s.list.push(entry);
  // A merge an orchestrator recorded early must outlast the PRs it only viewed later.
  const linked = s.list.reduce((n, p) => n + (p.state === "linked" ? 1 : 0), 0);
  if (linked > PRS_MAX || s.list.length > PRS_ALL_MAX) {
    const drop = s.list.findIndex((p) => p.state === "linked");
    s.list.splice(drop >= 0 ? drop : 0, 1);
  }
}

/** A result's text: a string, a hook's { stdout, stderr }, else its JSON. */
function prOutputOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === undefined || raw === null) return "";
  const o = raw as Record<string, unknown>;
  if (typeof o.stdout === "string" || typeof o.stderr === "string") return [o.stdout, o.stderr].filter((x) => typeof x === "string").join("\n");
  try {
    return JSON.stringify(raw) ?? "";
  } catch {
    return "";
  }
}

/** Folds a tool call's PRs: reads the call's input as it starts and settles them from its result as it ends. */
export function foldPrs(s: PrFoldState, e: AgentEvent, failure?: FailureClass): void {
  if ((e.kind !== "tool.start" && e.kind !== "tool.end") || e.payload.wrapper === true) return;
  const id = typeof e.payload.toolUseId === "string" ? e.payload.toolUseId : "";
  if (e.kind === "tool.start") {
    const call = prCallOf(e.payload.tool, e.payload.input);
    if (call) s.calls.set(id, call);
    else s.calls.delete(id);
    return;
  }
  const call = s.calls.get(id) ?? prCallOf(e.payload.tool, e.payload.input);
  s.calls.delete(id);
  if (!call || failure === "interrupted") return;
  const ok = e.payload.ok !== false;
  const out = prOutputOf(e.payload.output ?? e.payload.error).slice(0, PR_SCAN_CHARS);
  const push = call.push ? PUSH_REMOTE.exec(out) : null;
  const pushed: PrRepo | undefined = push ? { host: push[1]!.toLowerCase(), name: `${push[2]}/${push[3]}` } : undefined;
  if (pushed) s.repo ??= pushed;
  // The session's repo is one it pushed to or changed a PR in: a view's --repo may name anyone's.
  for (const g of call.gh) if (g.repo && !PR_LINK_VERBS.has(g.verb)) s.repo ??= g.repo;
  const urls = [...out.matchAll(PR_URL)].map((m) => prUrl(m[0])!);
  if (urls.length && call.gh.some((g) => g.verb === "create")) s.repo ??= urls[0]!.repo;
  const at = e.ts;
  if (call.tool) {
    if (!ok) return;
    for (const r of call.tool.fromOutput ? urls.slice(0, 1) : call.tool.refs) if (r.number !== undefined) notePr(s, r.number, r.repo, call.tool.state, at, call.tool.own);
    return;
  }
  const done = [...out.matchAll(PR_DONE_LINE)].map((m) => ({ state: m[1]!.toLowerCase() as PrState, number: Number(m[3]), repo: repoArg(m[2]) }));
  const named = new Set<number>();
  for (const g of call.gh) {
    if (g.verb === "create") {
      // A create that failed because the PR exists prints that PR's URL: the session names it.
      for (const u of urls) {
        notePr(s, u.number!, u.repo, ok ? "opened" : "linked", at);
        named.add(u.number!);
      }
      continue;
    }
    if (!ok) continue;
    const said = done.find((d) => g.number === undefined || d.number === g.number);
    const number = g.number ?? said?.number ?? urls[0]?.number;
    if (number === undefined) continue;
    const repo = g.repo ?? said?.repo ?? urls.find((u) => u.number === number)?.repo;
    let state: PrState | undefined;
    // `--auto` only queues the merge, unless gh says it merged.
    if (g.verb === "merge") state = said?.state === "merged" || !g.auto ? "merged" : "linked";
    else if (g.verb === "close") state = "closed";
    else if (g.verb === "reopen") state = "opened";
    else if (PR_LINK_VERBS.has(g.verb)) state = "linked";
    if (!state) continue;
    notePr(s, number, repo, state, at);
    named.add(number);
  }
  // A push that printed a PR's URL (in the repo it pushed to, when its output names that) names that PR.
  // Other URLs in a call's output (a PR body, release notes another command on the line printed) name
  // PRs the session only read.
  const same = (u: PrRef) => !pushed || u.repo?.name.toLowerCase() === pushed.name.toLowerCase();
  if (call.push) for (const u of urls) if (!named.has(u.number!) && same(u)) notePr(s, u.number!, u.repo, "linked", at, true);
}

/** Session.stats.prs: undefined when the session touched no PR. */
export function prsOf(s: PrFoldState): PullRequestRef[] | undefined {
  return s.list.length ? s.list.map((p) => ({ ...p })) : undefined;
}
