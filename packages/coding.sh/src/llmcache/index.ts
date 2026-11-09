// coding.sh llm cache: record a task's model calls and replay them, keyed by
// the normalized request, so a replay reuses responses up to the first
// changed call (exp run --record / --replay). See docs/how-to/replay-llm-calls.md.
export { apiOf, CACHED_PATHS, canonicalRequest, keyView, llmCallKey, type KeyOptions, type LlmApi } from "./key.ts";
export { DEFAULT_LLM_UPSTREAMS, startLlmCache, usageOf, type LlmCache, type LlmCacheMode, type LlmJob, type LlmJobOptions, type LlmStats, type LlmUpstreams, type StartLlmCacheOptions } from "./proxy.ts";
export { DEFAULT_LLM_CACHE_MAX_BYTES, gcLlmCache, hasRecordings, llmCacheDir, readRecording, recordingPath, writeRecording, type LlmCacheGcResult, type LlmEntry } from "./store.ts";
export { caseLlm, llmMetadata, openLlmCache, taskLlm, trialNormalize, withLlmJob, type CaseLlm, type LlmRunOpts, type TaskLlm } from "./run.ts";
export { controlNoise, llmLine, llmMeta, llmReplayNote, llmTotals, renderLlmReplay, type ComparisonLlmReplay, type LlmReplayNoise } from "./report.ts";
