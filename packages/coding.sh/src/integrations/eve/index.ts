// eve (https://github.com/vercel/eve) integration: OTel span enrichment,
// a read-only importer for eve's local traces, a session-stream mapper, and
// an experiment task that drives a local eve agent over HTTP.
export { A as EVE_ATTRS, EVE_SCOPE, EVE_TRACE_SCHEMA_VERSION, isEveSpan, isWorkflowInfraSpan, WORKFLOW_SCOPE } from "./attrs.ts";
export { enrichFromEve, EVE_AGENT_ID, EVE_SLOTS, eveSessionId, type EveEnrichInfo, type EveEnrichOptions } from "./map.ts";
export { eveJsonToResourceSpans, importEveRuns, resolveEveTraceStore, type ImportEveOptions } from "./import.ts";
export { EveStreamMapper, isTransportRecord, mapEveStream, parseEveStream, type EveFact, type EveStreamLine, type EveStreamOptions } from "./stream.ts";
export { EVE_DEV_URL, eveTask, type EveTaskOptions, type EveTaskOutput, type EveToolCall } from "./task.ts";
