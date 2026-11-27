// Grader registry: build any grader from a serializable spec (e.g. a CLI
// config file), so the same spec always yields the same grader version.
import type { CalibrationStatus, Grader, Split } from "../datasets/types.ts";
import type { JudgeCache } from "../judge/cache.ts";
import type { FetchLike, RetryOpts } from "../judge/http.ts";
import { CHECKLIST_KIND, checklistGrader, createChecklistJudge, type ChecklistItem, type ChecklistMode } from "../judge/checklist.ts";
import { createJudge, judgeGrader } from "../judge/judge.ts";
import { nextActionGrader, type NextActionGraderSpec } from "./next-action.ts";
import { createPairwiseJudge, PAIRWISE_KIND, type PairwiseJudge } from "../judge/pairwise.ts";
import { createPanel, PANEL_KIND, panelGrader } from "../judge/panel.ts";
import { anthropicProvider, openAICompatibleProvider, withCallTimeout, type ChatProvider } from "../judge/providers.ts";
import { claudeCodeProvider, codexProvider } from "../judge/subscription.ts";
import {
  agentSlopGrader,
  callsGrader,
  containsGrader,
  exactGrader,
  executabilityGrader,
  jsonPathGrader,
  jsonSchemaGrader,
  numericGrader,
  objectiveGrader,
  progressGrader,
  regexGrader,
  similarityGrader,
  type AgentSlopSpec,
  type CallsGraderSpec,
  type ContainsSpec,
  type ExactSpec,
  type ExecutabilitySpec,
  type JsonPathSpec,
  type JsonSchemaSpec,
  type NumericSpec,
  type ObjectiveSpec,
  type ProgressSpec,
  type RegexSpec,
  type SimilaritySpec,
} from "./builtin.ts";
import { commandGrader, moduleGrader, type CommandGraderSpec, type ModuleGraderSpec } from "./external.ts";
import { mockProvider, type MockAnswer } from "./mock.ts";
import { DEFAULT_KEY_ENV } from "../integrations/gateway/config.ts";
import { GATEWAY_API_BASE } from "../integrations/gateway/ids.ts";
import { suggest } from "../cli/args.ts";
import { DEFAULT_MODELS } from "../core/pricing.ts";

/** Google's OpenAI-compatible endpoint for Gemini models. */
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
/** The judge model for provider "gemini" when the spec names none. */
export const DEFAULT_GEMINI_MODEL = DEFAULT_MODELS.google;

/** Which model answers an LLM grader. Shared by "llm" and "llm-checklist" specs. */
export interface LlmProviderSpec {
  /** "mock": deterministic offline verdicts, no network, no key, no cache (dry runs).
   *  "gateway": Vercel AI Gateway's OpenAI-compatible API (any `<creator>/<model>`, key in AI_GATEWAY_API_KEY).
   *  "gemini": Google's OpenAI-compatible Gemini API (key in GEMINI_API_KEY, default model DEFAULT_GEMINI_MODEL).
   *  "claude-code": the Claude Code CLI (`claude -p`), on a Claude subscription or whatever auth the CLI has.
   *  "codex": the Codex CLI (`codex exec`), on a ChatGPT subscription. */
  provider?: "anthropic" | "openai" | "gateway" | "gemini" | "claude-code" | "codex" | "mock";
  model?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  /** Anthropic output_config.effort. */
  effort?: string;
  /** OpenAI-compatible only (Anthropic rejects sampling params). Default 0. */
  temperature?: number;
  /** OpenAI-compatible: false for keyless local servers (Ollama, LM Studio). */
  requireKey?: boolean;
  maxTokens?: number;
  /** provider "mock" only: every verdict / checklist answer. Default "yes". */
  mockAnswer?: MockAnswer;
}

export interface LlmGraderSpec extends LlmProviderSpec {
  kind: "llm";
  name: string;
  rubric: string;
  criterion?: string;
  passThreshold?: number;
  template?: string;
  system?: string;
  tunedOn?: Split[];
  concurrency?: number;
  calibration?: CalibrationStatus;
}

/** Checklist judge (src/judge/checklist.ts): frozen atomic yes/no questions, optional critical gates and predicates. */
export interface LlmChecklistGraderSpec extends LlmProviderSpec {
  kind: typeof CHECKLIST_KIND;
  name: string;
  items: readonly ChecklistItem[];
  criterion?: string;
  /** "per-item" (default): one call per question; "batched": one call for all. */
  mode?: ChecklistMode;
  /** Let the model answer "cannot_decide" and name what is missing, instead of "no". A critical abstention makes the case undecided. */
  abstain?: boolean;
  /** Weighted yes-fraction at or above which a case without a critical "no" passes. Default 0.5. */
  passThreshold?: number;
  system?: string;
  tunedOn?: Split[];
  concurrency?: number;
  calibration?: CalibrationStatus;
}

/** Pairwise judge (src/judge/pairwise.ts): compares two experiments' outputs, so it runs in `exp compare --pairwise`, not as a per-run grader. */
export interface PairwiseGraderSpec extends LlmProviderSpec {
  kind: typeof PAIRWISE_KIND;
  name: string;
  rubric: string;
  criterion?: string;
  template?: string;
  system?: string;
  tunedOn?: Split[];
  concurrency?: number;
  calibration?: CalibrationStatus;
}

/** Judge panel (src/judge/panel.ts): one judge per provider scores 1-10, and the target never reaches the prompt. */
export interface PanelGraderSpec {
  kind: typeof PANEL_KIND;
  name: string;
  rubric: string;
  /** One per provider. `advisory: true` shows a member's score without counting it. */
  members: readonly (LlmProviderSpec & { id?: string; advisory?: boolean })[];
  criterion?: string;
  /** Panel score (1-10) at or above which a case passes. Default 7. */
  target?: number;
  aggregate?: "median" | "mean";
  /** Re-scored fresh before the first case and every `anchorEvery` cases; drift is reported in the reason. */
  anchors?: readonly { id: string; input?: string; output: string; expected?: string; score?: number }[];
  anchorEvery?: number;
  driftThreshold?: number;
  tunedOn?: Split[];
  concurrency?: number;
  calibration?: CalibrationStatus;
}

export type GraderSpec =
  | ExactSpec
  | ContainsSpec
  | RegexSpec
  | JsonSchemaSpec
  | JsonPathSpec
  | NumericSpec
  | ObjectiveSpec<GraderSpec>
  | ProgressSpec
  | ExecutabilitySpec
  | SimilaritySpec
  | CallsGraderSpec
  | NextActionGraderSpec
  | AgentSlopSpec
  | CommandGraderSpec
  | ModuleGraderSpec
  | LlmGraderSpec
  | LlmChecklistGraderSpec
  | PanelGraderSpec
  | PairwiseGraderSpec;

export interface GraderDeps {
  /** Resolve relative module paths against this directory. */
  baseDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  retry?: RetryOpts;
  /** Per-call timeout in ms (e.g. from --trial-timeout): forwarded to HTTP and CLI providers and enforced per call. */
  timeoutMs?: number;
  judgeCache?: JudgeCache;
  /** Override provider construction entirely (tests, custom gateways). */
  provider?: ChatProvider;
}

const PROVIDERS = ["anthropic", "openai", "gateway", "gemini", "claude-code", "codex", "mock"];

export function providerFromSpec(spec: LlmProviderSpec, deps: GraderDeps = {}): ChatProvider {
  if (deps.provider) return deps.provider;
  const kind = spec.provider ?? "anthropic";
  if (!PROVIDERS.includes(kind)) {
    const close = typeof kind === "string" ? suggest(kind, PROVIDERS) : undefined;
    throw new Error(`unknown provider ${JSON.stringify(kind)} (expected ${PROVIDERS.map((p) => JSON.stringify(p)).join(", ")})${close ? `. Did you mean ${JSON.stringify(close)}?` : ""}`);
  }
  if (kind === "mock") return mockProvider(spec.mockAnswer ? { answer: spec.mockAnswer } : {});
  const timeoutMs = deps.timeoutMs;
  if (kind === "claude-code" || kind === "codex") {
    const cliTimeout = timeoutMs ?? deps.retry?.timeoutMs;
    const o: { model?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {};
    if (spec.model) o.model = spec.model;
    if (deps.env) o.env = deps.env;
    if (cliTimeout !== undefined) o.timeoutMs = cliTimeout;
    return withCallTimeout(kind === "codex" ? codexProvider(o) : claudeCodeProvider(o), timeoutMs);
  }
  const retry = timeoutMs !== undefined ? { timeoutMs, ...deps.retry } : deps.retry;
  const common = {
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
    ...(spec.apiKeyEnv ? { apiKeyEnv: spec.apiKeyEnv } : {}),
    ...(spec.maxTokens ? { maxTokens: spec.maxTokens } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(retry ? { retry } : {}),
  };
  if (kind === "anthropic") return withCallTimeout(anthropicProvider({ ...common, ...(spec.effort ? { effort: spec.effort } : {}) }), timeoutMs);
  const named =
    kind === "gateway"
      ? { name: "gateway", baseURL: spec.baseURL ?? GATEWAY_API_BASE, apiKeyEnv: spec.apiKeyEnv ?? DEFAULT_KEY_ENV }
      : kind === "gemini"
        ? { name: "gemini", baseURL: spec.baseURL ?? GEMINI_API_BASE, apiKeyEnv: spec.apiKeyEnv ?? "GEMINI_API_KEY", model: spec.model ?? DEFAULT_GEMINI_MODEL }
        : {};
  return withCallTimeout(
    openAICompatibleProvider({
      ...common,
      ...named,
      ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
      ...(spec.requireKey !== undefined ? { requireKey: spec.requireKey } : {}),
    }),
    timeoutMs,
  );
}

/** Mock verdicts are free and instant: never write them to the shared on-disk verdict cache. */
function cacheFor(provider: ChatProvider, deps: GraderDeps): { cache?: JudgeCache } {
  return deps.judgeCache && provider.name !== "mock" ? { cache: deps.judgeCache } : {};
}

// The keys each spec reads. Any other key is refused: a misspelled "critcal" or "nromalize" would
// otherwise be dropped and change the verdict without a word.
const PROVIDER_KEYS = ["provider", "model", "baseURL", "apiKeyEnv", "effort", "temperature", "requireKey", "maxTokens", "mockAnswer"];
const JUDGE_KEYS = ["name", "criterion", "system", "tunedOn", "concurrency", "calibration"];
const SPEC_KEYS: Record<string, readonly string[]> = {
  exact: ["name", "value", "normalize"],
  contains: ["name", "value", "mode", "normalize", "negate"],
  regex: ["name", "pattern", "flags", "negate"],
  "json-schema": ["name", "schema"],
  "json-path": ["name", "path", "equals", "expectedPath", "normalize"],
  numeric: ["name", "abs", "rel", "value", "path"],
  objective: ["name", "path", "base", "ref", "anchoredAt", "scale", "clip", "gate"],
  progress: ["name", "flags", "maxDerails"],
  executability: ["name", "kinds", "maxInvalid"],
  similarity: ["name", "threshold", "value", "normalize"],
  calls: ["name", "must", "mustNot", "max", "order"],
  "next-action": ["name"],
  "agent-slop": ["name", "rules", "exclude", "maxErrors", "maxWarnings"],
  command: ["name", "command", "args", "cwd", "env", "timeoutMs", "passThreshold"],
  module: ["name", "module", "export", "options", "passThreshold"],
  llm: [...PROVIDER_KEYS, ...JUDGE_KEYS, "rubric", "passThreshold", "template"],
  [CHECKLIST_KIND]: [...PROVIDER_KEYS, ...JUDGE_KEYS, "items", "mode", "abstain", "passThreshold"],
  [PANEL_KIND]: [...JUDGE_KEYS, "rubric", "members", "target", "aggregate", "anchors", "anchorEvery", "driftThreshold"],
  [PAIRWISE_KIND]: [...PROVIDER_KEYS, ...JUDGE_KEYS, "rubric", "template"],
};
const NORMALIZE_KEYS = ["trim", "caseInsensitive", "collapseWhitespace", "stripPunctuation", "unicode"];
const ITEM_KEYS = ["id", "question", "dimension", "violationExample", "critical", "weight", "check"];
const CHECK_KEYS = ["name", "args", "negate"];

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function refuseUnknown(obj: Record<string, unknown>, allowed: readonly string[], where: string, hint: (key: string) => string | undefined = () => undefined): void {
  for (const key of Object.keys(obj)) {
    if (key === "kind" || allowed.includes(key)) continue;
    const close = suggest(key, allowed);
    const extra = hint(key) ?? (close ? `Did you mean ${JSON.stringify(close)}?` : `It reads ${allowed.map((k) => JSON.stringify(k)).join(", ")}.`);
    throw new Error(`unknown key ${JSON.stringify(key)} in ${where}. ${extra}`);
  }
}

/** Throws on a key the spec (or a checklist item, its check, a panel member or a normalize table) does not read. */
export function checkSpecKeys(spec: GraderSpec): void {
  const s: Record<string, unknown> = Object.fromEntries(Object.entries(spec));
  const allowed = SPEC_KEYS[spec.kind];
  if (!allowed) return; // createGrader names the unknown kind
  const where = `the ${spec.kind} grader`;
  refuseUnknown(s, allowed, where);
  if (isTable(s.normalize)) refuseUnknown(s.normalize, NORMALIZE_KEYS, `${where}'s normalize`);
  if (spec.kind === CHECKLIST_KIND && Array.isArray(s.items)) {
    for (const [i, it] of s.items.entries()) {
      if (!isTable(it)) continue;
      const item = `checklist item ${typeof it.id === "string" && it.id ? JSON.stringify(it.id) : i + 1}`;
      refuseUnknown(it, ITEM_KEYS, item, (k) => (k === "negate" && it.check !== undefined ? 'Put "negate" in the item\'s "check": it flips the predicate\'s answer.' : undefined));
      if (isTable(it.check)) refuseUnknown(it.check, CHECK_KEYS, `the check of ${item}`);
    }
  }
  if (spec.kind === PANEL_KIND && Array.isArray(s.members)) {
    for (const [i, m] of s.members.entries()) if (isTable(m)) refuseUnknown(m, [...PROVIDER_KEYS, "id", "advisory"], `panel member ${i + 1}`);
  }
  if (spec.kind === PANEL_KIND && Array.isArray(s.anchors)) {
    for (const [i, a] of s.anchors.entries()) if (isTable(a)) refuseUnknown(a, ["id", "input", "output", "expected", "score"], `panel anchor ${i + 1}`);
  }
}

/** Build a grader from its spec. Async because module graders import code. */
export async function createGrader(spec: GraderSpec, deps: GraderDeps = {}): Promise<Grader> {
  checkSpecKeys(spec);
  const { kind, ...rest } = spec;
  switch (spec.kind) {
    case "exact":
      return exactGrader(rest as Omit<ExactSpec, "kind">);
    case "contains":
      return containsGrader(rest as Omit<ContainsSpec, "kind">);
    case "regex":
      return regexGrader(rest as Omit<RegexSpec, "kind">);
    case "json-schema":
      return jsonSchemaGrader(rest as Omit<JsonSchemaSpec, "kind">);
    case "json-path":
      return jsonPathGrader(rest as Omit<JsonPathSpec, "kind">);
    case "numeric":
      return numericGrader(rest as Omit<NumericSpec, "kind">);
    case "objective": {
      const { gate, ...o } = rest as Omit<ObjectiveSpec<GraderSpec>, "kind">;
      const spec: Parameters<typeof objectiveGrader>[0] = { ...o };
      if (gate) spec.gate = await createGrader(gate, deps);
      return objectiveGrader(spec);
    }
    case "progress":
      return progressGrader(rest as Omit<ProgressSpec, "kind">);
    case "executability":
      return executabilityGrader(rest as Omit<ExecutabilitySpec, "kind">);
    case "similarity":
      return similarityGrader(rest as Omit<SimilaritySpec, "kind">);
    case "calls":
      return callsGrader(rest as Omit<CallsGraderSpec, "kind">);
    case "next-action":
      return nextActionGrader(rest as Omit<NextActionGraderSpec, "kind">);
    case "agent-slop":
      return agentSlopGrader(rest as Omit<AgentSlopSpec, "kind">);
    case "command":
      return commandGrader(rest as Omit<CommandGraderSpec, "kind">);
    case "module":
      return moduleGrader(rest as Omit<ModuleGraderSpec, "kind">, deps.baseDir ? { baseDir: deps.baseDir } : {});
    case "llm": {
      const s = spec;
      const provider = providerFromSpec(s, deps);
      const judge = createJudge({
        name: s.name,
        rubric: s.rubric,
        provider,
        ...(s.criterion ? { criterion: s.criterion } : {}),
        ...(s.passThreshold !== undefined ? { passThreshold: s.passThreshold } : {}),
        ...(s.template ? { template: s.template } : {}),
        ...(s.system ? { system: s.system } : {}),
        ...(s.tunedOn ? { tunedOn: s.tunedOn } : {}),
        ...(s.concurrency ? { concurrency: s.concurrency } : {}),
        ...(s.calibration ? { calibration: s.calibration } : {}),
        ...cacheFor(provider, deps),
      });
      return judgeGrader(judge);
    }
    case CHECKLIST_KIND: {
      const s = spec;
      // An all-predicate checklist is deterministic and needs no model at all.
      const needsModel = !Array.isArray(s.items) || s.items.some((it) => it?.check === undefined);
      const provider = needsModel ? providerFromSpec(s, deps) : undefined;
      const judge = createChecklistJudge({
        name: s.name,
        items: s.items,
        ...(provider ? { provider } : {}),
        ...(s.criterion ? { criterion: s.criterion } : {}),
        ...(s.mode ? { mode: s.mode } : {}),
        ...(s.abstain === true ? { abstain: true } : {}),
        ...(s.passThreshold !== undefined ? { passThreshold: s.passThreshold } : {}),
        ...(s.system ? { system: s.system } : {}),
        ...(s.tunedOn ? { tunedOn: s.tunedOn } : {}),
        ...(s.concurrency ? { concurrency: s.concurrency } : {}),
        ...(s.calibration ? { calibration: s.calibration } : {}),
        ...(provider ? cacheFor(provider, deps) : {}),
      });
      return checklistGrader(judge);
    }
    case PANEL_KIND: {
      const s = spec;
      if (!Array.isArray(s.members)) throw new Error('a panel needs "members": one provider spec per judge');
      // Each member builds its own provider: a single deps.provider override would make every member the same judge.
      const { provider: _one, ...memberDeps } = deps;
      const members = s.members.map((m) => {
        const provider = providerFromSpec(m, memberDeps);
        return { provider, ...(m.id ? { id: m.id } : {}), ...(m.advisory === true ? { advisory: true } : {}) };
      });
      const panel = createPanel({
        name: s.name,
        rubric: s.rubric,
        members,
        ...(s.criterion ? { criterion: s.criterion } : {}),
        ...(s.target !== undefined ? { target: s.target } : {}),
        ...(s.aggregate ? { aggregate: s.aggregate } : {}),
        ...(s.anchors ? { anchors: s.anchors.map((a) => ({ id: a.id, ctx: { input: a.input ?? "", output: a.output, ...(a.expected !== undefined ? { expected: a.expected } : {}) }, ...(a.score !== undefined ? { score: a.score } : {}) })) } : {}),
        ...(s.driftThreshold !== undefined ? { driftThreshold: s.driftThreshold } : {}),
        ...(s.tunedOn ? { tunedOn: s.tunedOn } : {}),
        ...(s.concurrency ? { concurrency: s.concurrency } : {}),
        ...(s.calibration ? { calibration: s.calibration } : {}),
        ...(deps.judgeCache && members.every((m) => m.provider.name !== "mock") ? { cache: deps.judgeCache } : {}),
      });
      return panelGrader(panel, s.anchorEvery !== undefined ? { anchorEvery: s.anchorEvery } : {});
    }
    case PAIRWISE_KIND:
      throw new Error(`a "${PAIRWISE_KIND}" judge compares two experiments; use it with: coding.sh exp compare A B --pairwise <JSON|FILE>`);
    default:
      throw new Error(`unknown grader kind ${JSON.stringify(kind)}`);
  }
}

/** Build a pairwise judge from its spec (same provider options as "llm"). */
export function createPairwiseJudgeFromSpec(spec: PairwiseGraderSpec, deps: GraderDeps = {}): PairwiseJudge {
  if (spec.kind !== PAIRWISE_KIND) throw new Error(`expected kind "${PAIRWISE_KIND}" (got ${JSON.stringify(spec.kind)})`);
  if (typeof spec.name !== "string" || !spec.name.trim()) throw new Error("a pairwise judge needs a name");
  if (typeof spec.rubric !== "string" || !spec.rubric.trim()) throw new Error("a pairwise judge needs a rubric");
  checkSpecKeys(spec);
  const provider = providerFromSpec(spec, deps);
  return createPairwiseJudge({
    name: spec.name,
    rubric: spec.rubric,
    provider,
    ...(spec.criterion ? { criterion: spec.criterion } : {}),
    ...(spec.template ? { template: spec.template } : {}),
    ...(spec.system ? { system: spec.system } : {}),
    ...(spec.tunedOn ? { tunedOn: spec.tunedOn } : {}),
    ...(spec.concurrency ? { concurrency: spec.concurrency } : {}),
    ...(spec.calibration ? { calibration: spec.calibration } : {}),
    ...cacheFor(provider, deps),
  });
}

export * from "./builtin.ts";
export * from "./external.ts";
export * from "./json-path.ts";
export * from "./json-schema.ts";
export * from "./mock.ts";
export * from "./proc.ts";
export * from "./slop.ts";
