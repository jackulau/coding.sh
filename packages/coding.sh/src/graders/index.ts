// Grader registry: build any grader from a serializable spec (e.g. a CLI
// config file), so the same spec always yields the same grader version.
import type { CalibrationStatus, Grader, Split } from "../datasets/types.ts";
import type { JudgeCache } from "../judge/cache.ts";
import type { FetchLike, RetryOpts } from "../judge/http.ts";
import { CHECKLIST_KIND, checklistGrader, createChecklistJudge, type ChecklistItem, type ChecklistMode } from "../judge/checklist.ts";
import { createJudge, judgeGrader } from "../judge/judge.ts";
import { anthropicProvider, openAICompatibleProvider, type ChatProvider } from "../judge/providers.ts";
import {
  containsGrader,
  exactGrader,
  jsonPathGrader,
  jsonSchemaGrader,
  numericGrader,
  regexGrader,
  similarityGrader,
  type ContainsSpec,
  type ExactSpec,
  type JsonPathSpec,
  type JsonSchemaSpec,
  type NumericSpec,
  type RegexSpec,
  type SimilaritySpec,
} from "./builtin.ts";
import { commandGrader, moduleGrader, type CommandGraderSpec, type ModuleGraderSpec } from "./external.ts";
import { mockProvider, type MockAnswer } from "./mock.ts";
import { DEFAULT_KEY_ENV } from "../integrations/gateway/config.ts";
import { GATEWAY_API_BASE } from "../integrations/gateway/ids.ts";

/** Which model answers an LLM grader. Shared by "llm" and "llm-checklist" specs. */
export interface LlmProviderSpec {
  /** "mock": deterministic offline verdicts, no network, no key, no cache (dry runs).
   *  "gateway": Vercel AI Gateway's OpenAI-compatible API (any `<creator>/<model>`, key in AI_GATEWAY_API_KEY). */
  provider?: "anthropic" | "openai" | "gateway" | "mock";
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
  /** Weighted yes-fraction at or above which a case without a critical "no" passes. Default 0.5. */
  passThreshold?: number;
  system?: string;
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
  | SimilaritySpec
  | CommandGraderSpec
  | ModuleGraderSpec
  | LlmGraderSpec
  | LlmChecklistGraderSpec;

export interface GraderDeps {
  /** Resolve relative module paths against this directory. */
  baseDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  retry?: RetryOpts;
  judgeCache?: JudgeCache;
  /** Override provider construction entirely (tests, custom gateways). */
  provider?: ChatProvider;
}

const PROVIDERS = ["anthropic", "openai", "gateway", "mock"];

export function providerFromSpec(spec: LlmProviderSpec, deps: GraderDeps = {}): ChatProvider {
  if (deps.provider) return deps.provider;
  const kind = spec.provider ?? "anthropic";
  if (!PROVIDERS.includes(kind)) throw new Error(`unknown provider ${JSON.stringify(kind)} (expected ${PROVIDERS.map((p) => JSON.stringify(p)).join(", ")})`);
  if (kind === "mock") return mockProvider(spec.mockAnswer ? { answer: spec.mockAnswer } : {});
  const common = {
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.baseURL ? { baseURL: spec.baseURL } : {}),
    ...(spec.apiKeyEnv ? { apiKeyEnv: spec.apiKeyEnv } : {}),
    ...(spec.maxTokens ? { maxTokens: spec.maxTokens } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.retry ? { retry: deps.retry } : {}),
  };
  if (kind === "anthropic") return anthropicProvider({ ...common, ...(spec.effort ? { effort: spec.effort } : {}) });
  const gateway = kind === "gateway" ? { name: "gateway", baseURL: spec.baseURL ?? GATEWAY_API_BASE, apiKeyEnv: spec.apiKeyEnv ?? DEFAULT_KEY_ENV } : {};
  return openAICompatibleProvider({
    ...common,
    ...gateway,
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.requireKey !== undefined ? { requireKey: spec.requireKey } : {}),
  });
}

/** Mock verdicts are free and instant: never write them to the shared on-disk verdict cache. */
function cacheFor(provider: ChatProvider, deps: GraderDeps): { cache?: JudgeCache } {
  return deps.judgeCache && provider.name !== "mock" ? { cache: deps.judgeCache } : {};
}

/** Build a grader from its spec. Async because module graders import code. */
export async function createGrader(spec: GraderSpec, deps: GraderDeps = {}): Promise<Grader> {
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
    case "similarity":
      return similarityGrader(rest as Omit<SimilaritySpec, "kind">);
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
        ...(s.passThreshold !== undefined ? { passThreshold: s.passThreshold } : {}),
        ...(s.system ? { system: s.system } : {}),
        ...(s.tunedOn ? { tunedOn: s.tunedOn } : {}),
        ...(s.concurrency ? { concurrency: s.concurrency } : {}),
        ...(s.calibration ? { calibration: s.calibration } : {}),
        ...(provider ? cacheFor(provider, deps) : {}),
      });
      return checklistGrader(judge);
    }
    default:
      throw new Error(`unknown grader kind ${JSON.stringify(kind)}`);
  }
}

export * from "./builtin.ts";
export * from "./external.ts";
export * from "./json-path.ts";
export * from "./json-schema.ts";
export * from "./mock.ts";
export * from "./proc.ts";
