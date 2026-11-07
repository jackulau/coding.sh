// Span attribute names eve (https://github.com/vercel/eve) puts on its
// OpenTelemetry spans, trace schema version 4 (eve 1.0.0-rc.6).
//
// Verified against real `eve dev` output (OTLP/JSON export and the local
// `.eve/traces/v1` store), see test/integrations/eve/fixtures. Every span
// eve's tracer ("eve.agent" scope) creates carries agent.run.id,
// agent.trace.schema.version and gen_ai.conversation.id.
//
// Trace topology for one turn (each root turn is a new trace; a local
// subagent's first turn joins the caller's trace under the dispatch span):
//
//   invoke_agent <agent>                 activation  (agent.run.type=session|subagent)
//     agent.step                         one model step (agent.usage.* totals)
//       chat <model>                     provider call (gen_ai.usage.*)
//       execute_tool <tool>              tool / skill / subagent call
//         invoke_agent <subagent>        child session's turn (own agent.run.id)
//         agent.approval                 human-in-the-loop wait
//
// Eve's Workflow runtime also exports infrastructure spans under the
// "workflow" scope (workflow.run, workflow.step.*, workflow.stream.*, ...).
import type { Attrs, OtelScope, OtelSpan } from "../../otel/model.ts";

export const EVE_SCOPE = "eve.agent";
export const WORKFLOW_SCOPE = "workflow";
export const EVE_TRACE_SCHEMA_VERSION = 4;

export const A = {
  /** One eve session (the HTTP API's sessionId, e.g. "wrun_01…"). Not the whole conversation. */
  runId: "agent.run.id",
  schemaVersion: "agent.trace.schema.version",
  /** Root session id, shared by the root session and every child session. */
  conversationId: "gen_ai.conversation.id",
  frameworkName: "agent.framework.name",
  frameworkVersion: "agent.framework.version",
  agentName: "agent.name",
  genAiAgentName: "gen_ai.agent.name",
  operation: "gen_ai.operation.name",
  // activation (invoke_agent)
  runType: "agent.run.type",
  parentRunId: "agent.parent_run.id",
  parentCallId: "agent.parent_call.id",
  subagentName: "agent.subagent.name",
  turnId: "agent.turn.id",
  turnSequence: "agent.turn.sequence",
  turnOutcome: "agent.turn.outcome",
  sessionTitle: "agent.session.title",
  sessionOrigin: "agent.session.origin",
  channelKind: "agent.channel.kind",
  channelName: "agent.channel.name",
  channelAudience: "agent.channel.audience",
  deliveryId: "agent.channel.delivery.id",
  /** JSON of what the channel delivered, e.g. {"message":"..."}: this turn's input only (gen_ai.input.messages holds the whole history). */
  deliveryInput: "agent.channel.delivery.input",
  // step
  stepIndex: "agent.step.index",
  stepAttempt: "agent.step.attempt",
  modelId: "agent.model.id",
  // execute_tool
  toolCallId: "gen_ai.tool.call.id",
  toolName: "gen_ai.tool.name",
  actionKind: "agent.action.kind",
  actionName: "agent.action.name",
  actionOutcome: "agent.action.outcome",
  isFrameworkTool: "agent.tool.is_framework",
  errorType: "error.type",
  // approval
  approvalKind: "agent.approval.kind",
  approvalOutcome: "agent.approval.outcome",
  approvalRequestId: "agent.approval.request_id",
  connectionName: "agent.connection.name",
  // usage on step / tool spans (model + activation spans use gen_ai.usage.*)
  usageInput: "agent.usage.input_tokens",
  usageOutput: "agent.usage.output_tokens",
  usageCacheRead: "agent.usage.cache_read_tokens",
  usageCacheWrite: "agent.usage.cache_write_tokens",
  usageCost: "agent.usage.cost_usd",
} as const;

/** agent.action.kind values that dispatch another agent. */
export const AGENT_CALL_KINDS = new Set(["subagent-call", "remote-agent-call"]);

export function str(a: Attrs, key: string): string | undefined {
  const v = a[key];
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

export function num(a: Attrs, key: string): number | undefined {
  const v = a[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function bool(a: Attrs, key: string): boolean | undefined {
  const v = a[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/** A span eve's own tracer produced (agent turns, steps, model and tool calls). */
export function isEveSpan(span: OtelSpan, scope?: Pick<OtelScope, "name">): boolean {
  if (scope?.name === EVE_SCOPE) return true;
  const a = span.attributes;
  if (str(a, A.frameworkName) === "eve") return true;
  return a[A.schemaVersion] !== undefined && str(a, A.runId) !== undefined;
}

/**
 * Workflow SDK infrastructure span (route init, replay, queue, stream reads).
 * These have no agent semantics: as root spans they would each become a junk
 * coding.sh session, so enrichFromEve drops them by default.
 */
export function isWorkflowInfraSpan(span: OtelSpan, scope?: Pick<OtelScope, "name">): boolean {
  if (isEveSpan(span, scope)) return false;
  if (scope) return scope.name === WORKFLOW_SCOPE;
  return span.name.startsWith("workflow.");
}
