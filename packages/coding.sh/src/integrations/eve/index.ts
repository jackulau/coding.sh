// eve (https://github.com/vercel/eve) integration: OTel span enrichment,
// a read-only importer for eve's local traces, a session-stream mapper,
// an experiment task that drives a local eve agent over HTTP, and an eval
// reporter that stores `eve eval` runs as datasets and experiments.
export { A as EVE_ATTRS, EVE_SCOPE, EVE_TRACE_SCHEMA_VERSION, isEveSpan, isWorkflowInfraSpan, WORKFLOW_SCOPE } from "./attrs.ts";
export { enrichFromEve, EVE_AGENT_ID, EVE_SLOTS, eveSessionId, type EveEnrichInfo, type EveEnrichOptions } from "./map.ts";
export { eveJsonToResourceSpans, importEveRuns, resolveEveTraceStore, type ImportEveOptions } from "./import.ts";
export { EveStreamMapper, isTransportRecord, mapEveStream, parseEveStream, type EveFact, type EveStreamLine, type EveStreamOptions } from "./stream.ts";
export { EVE_DEV_URL, eveTask, type EveTaskOptions, type EveTaskOutput, type EveToolCall } from "./task.ts";
export { createEveEvalsHandler, DEFAULT_EVE_DATASET, eveEvalsToExperiment, EveEvalsError, eveGraderId, eveRunKey, parseEveEvalsUpload, storeEveEvals, type EveEvalsHandlerOptions } from "./evals.ts";
export { compactEveResult, EVE_EVALS_PATH, EVE_EVALS_UPLOAD_VERSION, type EveAssertion, type EveEvalInfo, type EveEvalResultLike, type EveEvalResultUpload, type EveEvalsUpload, type EveVerdict, type StoredEveRun } from "./upload.ts";
export { codingShReporter, defaultEveDataset, DEFAULT_CODING_SH_URL, type CodingShReporter, type CodingShReporterOptions } from "./reporter.ts";
