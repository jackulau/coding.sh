// Durable workflow engines: which run, step and attempt an OTLP span belongs to
// (docs/research/durable-workflows.md has the sources for every key below).
//
// A durable run outlives the process that started it: it sleeps for days,
// survives crashes and deploys, and each step can be retried. Its spans
// arrive as many traces (Vercel Workflow starts a new trace per invocation by
// default) or one trace spread over many processes (Temporal carries the trace
// in workflow history). Either way the run id on the spans is the one stable
// key, so the mapper keys the session on it (see map.ts) and tags each span
// with what it is in the run (payload.durable). core/durable.ts then folds the
// tags into steps, attempts, waits and resume points.
//
//   engine            run key (session id)              step attempt span                 attempt
//   vercel-workflow   workflow.run.id                   step.execute <name>               step.attempt
//   temporal          temporal:<workflowId>:<runId>     RunActivity:<type>                inferred from order
//   inngest           inngest:<sdk.run.id>              spans with inngest.step.id        inngest.step.attempt
//   restate           restate:<restate.invocation.id>   run (<name>)                      inferred from order
//   dbos              dbos:<workflow id>                operationType step/transaction    "Step attempt N failed" events
//   langgraph         thread_id                         node spans (langgraph_node)       inferred from order
//   workflow          workflow.run.id (any other app)   spans with step.name              step.attempt
//
// The last row is a convention any engine can follow by hand (Cloudflare
// Workflows exposes no run identity on its spans): set workflow.run.id on the
// spans of a run, step.name (+ step.id, step.attempt) on step spans.
import type { Attrs, OtelScope, OtelSpan, OtelValue } from "./model.ts";

export type DurableEngine = "vercel-workflow" | "temporal" | "inngest" | "restate" | "dbos" | "langgraph" | "workflow";

/**
 * What a span is in its run:
 * - start: a client starting the run (Temporal StartWorkflow, Vercel workflow.start)
 * - run: one logical span over the whole run (Temporal RunWorkflow); not busy time
 * - invocation: one process handling the run once (Vercel workflow.execute, Restate invocation-attempt)
 * - orchestrate: the workflow function running once in an invocation (Vercel workflow.run)
 * - schedule: a step from scheduled to done, around its attempts (Temporal StartActivity); not busy time
 * - step: one attempt of a step
 * - wait: a durable sleep or wait for an event; not busy time
 * - other: anything else carrying the run id (storage calls, signals, queries)
 */
export type DurableRole = "start" | "run" | "invocation" | "orchestrate" | "schedule" | "step" | "wait" | "other";

/** payload.durable on the first event of a recognized span. */
export interface DurableTag {
  engine: DurableEngine;
  /** The engine's own run id (Temporal: "<workflowId>:<runId>"). */
  run: string;
  role: DurableRole;
  workflow?: string;
  /** Step name. */
  step?: string;
  /** Stable across a step's attempts (step id, activity id). */
  stepId?: string;
  /** Attempt number the engine reported (1-based). */
  attempt?: number;
  /** Failed attempts the engine reported inside this span (DBOS "Step attempt N failed"). */
  failedAttempts?: number;
  /** Queue redelivery number of an invocation (Vercel workflow.delivery.attempt). */
  delivery?: number;
  /** Why the attempt failed, when the engine says so on a span it leaves OK (Vercel step.error.message). */
  error?: string;
  /** An invocation that recovered the run after its process went away (Vercel: trace not propagated). */
  recovered?: true;
  /** The engine released a step whose process exited mid-attempt (Vercel step_retrying at startup). */
  orphan?: true;
  /** The span re-ran history (replay); work under it was done before and is not counted again. */
  replay?: true;
  /** "start" or "end" of a wait recorded as two instants (Vercel wait_created / wait_completed). */
  waitEdge?: "start" | "end";
  /** Process that emitted the span. */
  instance?: string;
  /** Deployment or code version that emitted the span. */
  version?: string;
}

const isObj = (v: unknown): v is Record<string, OtelValue> => typeof v === "object" && v !== null && !Array.isArray(v);

function str(a: Attrs, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function int(a: Attrs, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = a[k];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return undefined;
}

/** Text after the first "<sep>" of a span name ("RunActivity:plan" → "plan"). */
const suffix = (name: string, sep: string): string | undefined => {
  const i = name.indexOf(sep);
  const s = i >= 0 ? name.slice(i + sep.length).trim() : "";
  return s || undefined;
};

/** "workflow//./workflows/research//researchAgent" → "researchAgent"; other names as they are. */
const shortName = (s: string | undefined): string | undefined => (s?.includes("//") ? s.slice(s.lastIndexOf("//") + 2) || s : s);

/** Session id of a durable run. Vercel run ids are already unique ("wrun_…"); other engines get a prefix. */
export function durableSessionId(t: Pick<DurableTag, "engine" | "run">): string {
  if (t.engine === "vercel-workflow" || t.engine === "workflow" || t.engine === "langgraph") return t.run;
  return `${t.engine}:${t.run}`;
}

/** The process that emitted a span, from what its resource (or the span) says. */
function instanceOf(resource: Attrs, a: Attrs): string | undefined {
  const id = str(resource, "service.instance.id") ?? str(a, "faas.instance") ?? str(resource, "faas.instance");
  if (id) return id;
  const host = str(resource, "host.name", "host.id");
  const pid = str(resource, "process.pid");
  if (pid) return host ? `${host}:${pid}` : `pid:${pid}`;
  return str(a, "dbos.executor.id", "executorID") ?? str(resource, "dbos.executor.id");
}

/** The deployment or code version that emitted a span. */
function versionOf(resource: Attrs, a: Attrs): string | undefined {
  return (
    str(a, "deployment.id", "restate.deployment.id") ??
    str(resource, "deployment.id", "vercel.deployment_id", "service.version", "cloudflare.script_version.id") ??
    str(a, "dbos.application.version", "applicationVersion", "cloudflare.script_version.id")
  );
}

// ---------------------------------------------------------------- engines

type Partial0 = Omit<DurableTag, "instance" | "version">;

const VERCEL_SPAN = /^(workflow\.(start|execute|run)|step\.execute)\s/;

function vercel(span: OtelSpan, scope: OtelScope, a: Attrs): Partial0 | undefined {
  const run = str(a, "workflow.run.id");
  const vercelScope = scope.name === "workflow" || scope.name.startsWith("@workflow/");
  const named = VERCEL_SPAN.test(span.name);
  if (!run) return undefined;
  const engine: DurableEngine = vercelScope || named || str(a, "workflow.execution.mode", "workflow.operation") ? "vercel-workflow" : "workflow";
  const t: Partial0 = { engine, run, role: "other" };
  // Vercel names functions by module path ("workflow//./workflows/research//researchAgent"): keep the function.
  const wf = shortName(str(a, "workflow.name"));
  if (wf) t.workflow = wf;
  const name = span.name;
  if (name.startsWith("workflow.start ")) t.role = "start";
  else if (name.startsWith("workflow.execute ")) {
    t.role = "invocation";
    const d = int(a, "workflow.delivery.attempt");
    if (d !== undefined) t.delivery = d;
    // A queue message with no trace carrier: the run was recovered after its process went away.
    if (a["workflow.trace.propagated"] === false) t.recovered = true;
  } else if (name.startsWith("workflow.run ")) {
    t.role = "orchestrate";
    if (str(a, "workflow.execution.mode") === "replay") t.replay = true;
  } else if (name.startsWith("step.execute ") || str(a, "step.name", "workflow.step.name") !== undefined) {
    t.role = "step";
    const step = shortName(str(a, "step.name", "workflow.step.name")) ?? suffix(name, " ");
    if (step) t.step = step;
    const id = str(a, "step.id", "workflow.step.id");
    if (id) t.stepId = id;
    // step.attempt is only set on failed attempts (workflow 5.x): numbers are inferred from order otherwise.
    const attempt = int(a, "step.attempt", "workflow.step.attempt");
    if (attempt !== undefined && attempt > 0) t.attempt = attempt;
    if (a["step.skipped"] === true) t.replay = true;
    // A failed attempt leaves the outer span OK and records the error as attributes.
    const err = str(a, "step.error.message");
    if (err || a["step.retry.will_retry"] === true) t.error = err ?? "failed";
  } else if (/\bstep_retrying$/.test(name) && !span.parentSpanId) {
    // Written at startup by the recovery that releases a step whose process exited mid-attempt.
    t.orphan = true;
  } else if (/\bwait_created$/.test(name)) {
    t.role = "wait";
    t.waitEdge = "start";
  } else if (/\bwait_completed$/.test(name)) {
    t.role = "wait";
    t.waitEdge = "end";
  } else if (str(a, "workflow.wait.duration", "wait.duration") !== undefined || /^(workflow\.)?(sleep|wait)\b/i.test(name)) {
    t.role = "wait";
  }
  return t;
}

const TEMPORAL_SPAN = /^(StartWorkflow|SignalWithStartWorkflow|UpdateWithStartWorkflow|StartUpdateWithStartWorkflow|RunWorkflow|StartActivity|RunActivity|StartChildWorkflow|ContinueAsNew|HandleSignal|HandleQuery|HandleUpdate|ValidateUpdate|SignalWorkflow|QueryWorkflow|StartWorkflowUpdate|CompleteWorkflow|SignalChildWorkflow|SignalExternalWorkflow|StartNexusOperation|RunStartNexusOperation|RunCancelNexusOperation)(:|$)/;

function temporal(span: OtelSpan, scope: OtelScope, a: Attrs): Partial0 | undefined {
  if (!scope.name.startsWith("@temporalio/") && !scope.name.startsWith("temporalio") && !TEMPORAL_SPAN.test(span.name)) return undefined;
  const wfId = str(a, "temporalWorkflowId", "temporalWorkflowID", "workflowId");
  if (!wfId) return undefined;
  const runId = str(a, "run_id", "temporalRunID", "temporalRunId", "runId");
  const t: Partial0 = { engine: "temporal", run: runId ? `${wfId}:${runId}` : wfId, role: "other" };
  const kind = /^([A-Za-z]+)/.exec(span.name)?.[1] ?? "";
  const type = suffix(span.name, ":");
  const wfType = str(a, "workflowType");
  if (wfType) t.workflow = wfType;
  switch (kind) {
    case "StartWorkflow":
    case "SignalWithStartWorkflow":
    case "UpdateWithStartWorkflow":
    case "StartUpdateWithStartWorkflow":
      t.role = "start";
      if (type) t.workflow ??= type;
      break;
    case "RunWorkflow":
      t.role = "run";
      if (type) t.workflow ??= type;
      break;
    case "StartActivity":
    case "StartChildWorkflow":
      t.role = "schedule";
      if (type) t.step = type;
      break;
    case "RunActivity": {
      t.role = "step";
      const step = type ?? str(a, "temporalActivityType");
      if (step) t.step = step;
      const id = str(a, "temporalActivityId", "temporalActivityID");
      if (id) t.stepId = id;
      break;
    }
  }
  // The worker copies WorkflowInfo onto workflow spans; unsafe.isReplaying says a replay emitted it.
  const unsafe = a.unsafe;
  if (isObj(unsafe) && unsafe.isReplaying === true) t.replay = true;
  return t;
}

function inngest(span: OtelSpan, a: Attrs): Partial0 | undefined {
  const run = str(a, "sdk.run.id");
  if (!run) return undefined;
  const t: Partial0 = { engine: "inngest", run, role: span.name === "inngest.execution" ? "invocation" : "other" };
  const fn = str(a, "sys.function.id");
  if (fn) t.workflow = fn;
  const stepId = str(a, "inngest.step.id");
  if (stepId) {
    t.role = "step";
    t.stepId = stepId;
    t.step = stepId;
    const attempt = int(a, "inngest.step.attempt");
    // Inngest counts attempts from 0.
    if (attempt !== undefined) t.attempt = attempt + 1;
  }
  return t;
}

function restate(span: OtelSpan, a: Attrs): Partial0 | undefined {
  const run = str(a, "restate.invocation.id");
  if (!run) return undefined;
  const t: Partial0 = { engine: "restate", run, role: "other" };
  const target = str(a, "restate.invocation.target");
  if (target) t.workflow = target;
  if (span.name.startsWith("ingress")) t.role = "start";
  else if (span.name.startsWith("invocation-attempt") || span.name.startsWith("attempt ")) t.role = "invocation";
  else if (span.name.startsWith("run")) {
    t.role = "step";
    const step = str(a, "restate.run.name") ?? /^run \((.*)\)$/.exec(span.name)?.[1];
    if (step) {
      t.step = step;
      t.stepId = step;
    }
  }
  return t;
}

const DBOS_FAILED_ATTEMPT = /^Step attempt \d+ failed/;

function dbos(span: OtelSpan, scope: OtelScope, a: Attrs): Partial0 | undefined {
  const run = str(a, "dbos.operation.workflow_id", "operationUUID");
  if (!run || (scope.name !== "dbos-tracer" && str(a, "dbos.operation.workflow_id") === undefined && str(a, "operationType") === undefined)) return undefined;
  const t: Partial0 = { engine: "dbos", run, role: "other" };
  const type = (str(a, "dbos.operation.type", "operationType") ?? "").toLowerCase();
  const name = str(a, "dbos.operation.name", "operationName") ?? span.name;
  if (type === "workflow") {
    t.role = "orchestrate";
    t.workflow = name;
  } else if (type === "step" || type === "transaction" || type === "procedure") {
    t.role = "step";
    t.step = name;
    const failed = span.events.filter((e) => DBOS_FAILED_ATTEMPT.test(e.name)).length;
    if (failed) {
      t.failedAttempts = failed;
      t.attempt = failed + 1;
    }
  } else if (span.name === "sleep") t.role = "wait";
  if (a.cached === true) t.replay = true;
  return t;
}

/** LangGraph node spans: the thread is the run (it outlives processes through its checkpointer). */
function langgraph(span: OtelSpan, a: Attrs): Partial0 | undefined {
  let md: Attrs = {};
  const m = a.metadata;
  if (isObj(m)) md = m;
  else if (typeof m === "string" && m.startsWith("{")) {
    try {
      const v = JSON.parse(m) as unknown;
      if (isObj(v)) md = v;
    } catch {
      // not JSON
    }
  }
  const node = str(a, "langgraph_node", "langgraph.node", "metadata.langgraph_node", "langsmith.metadata.langgraph_node") ?? str(md, "langgraph_node");
  const thread = str(a, "langsmith.metadata.thread_id", "metadata.thread_id", "thread_id") ?? str(md, "thread_id") ?? str(a, "session.id");
  if (!node || !thread || node === "__start__" || node === "__end__") return undefined;
  const step = int(a, "langgraph_step", "langgraph.step", "metadata.langgraph_step", "langsmith.metadata.langgraph_step") ?? int(md, "langgraph_step");
  const ns = str(a, "langgraph_checkpoint_ns", "langsmith.metadata.langgraph_checkpoint_ns") ?? str(md, "langgraph_checkpoint_ns");
  const t: Partial0 = { engine: "langgraph", run: thread, role: "step", step: node, stepId: `${step ?? ""}:${node}:${ns ?? ""}` };
  const graph = str(a, "langsmith.metadata.graph_id", "graph_id") ?? str(md, "graph_id");
  if (graph) t.workflow = graph;
  return t;
}

/** Durable-run tag for one span, or undefined when no engine claims it. */
export function durableOf(span: OtelSpan, resource: Attrs, scope: OtelScope): DurableTag | undefined {
  const a = span.attributes;
  const t = temporal(span, scope, a) ?? vercel(span, scope, a) ?? inngest(span, a) ?? restate(span, a) ?? dbos(span, scope, a) ?? langgraph(span, a);
  if (!t) return undefined;
  const out: DurableTag = t;
  const instance = instanceOf(resource, a);
  if (instance) out.instance = instance;
  const version = versionOf(resource, a);
  if (version) out.version = version;
  return out;
}
