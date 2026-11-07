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
//   restate           the invocation's trace id         run (<name>), else journal events inferred from order
//   dbos              dbos:<workflow id>                operationType step/transaction    "Step attempt N failed" events
//   langgraph         thread_id                         node spans (langgraph_node)       inferred from order
//   workflow          workflow.run.id (any other app)   spans with step.name              step.attempt
//
// One Restate invocation is one trace, so the trace keys its session: the
// user's spans in it can arrive before any server span names the invocation.
// Restate run spans carry only restate.run.name: their run is their trace's,
// filled in by map.ts (run "" here), and so is the Python Temporal client's
// StartWorkflow (it names no run id).
//
// The last row is a convention any engine can follow by hand (Cloudflare
// Workflows exposes no run identity on its spans): set workflow.run.id on the
// spans of a run, step.name (+ step.id, step.attempt) on step spans. A span
// around a sleep with workflow.wait.name (or named "sleep <name>") is a wait in
// any engine's run: Temporal, Inngest and DBOS TS export none of their own.
import { type Attrs, nanosToMs, type OtelScope, type OtelSpan, type OtelValue } from "./model.ts";

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
  /** Failed attempts the engine reported inside this span (DBOS "Step attempt N failed" events): when each ended, why, and the retry delay. */
  failures?: { at: number; error?: string; retryMs?: number }[];
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
  /**
   * "start" or "end" of a wait recorded as two instants (Vercel wait_created /
   * wait_completed, a LangGraph interrupt and the invocation resuming it). A start
   * with no end closes where the run next does something.
   */
  waitEdge?: "start" | "end";
  /** When a wait started inside this span (a Restate sleep journal event); default the span's start. */
  waitAt?: number;
  /** Name of the wait a waitEdge starts ("interrupt", the sleep's name). */
  waitName?: string;
  /** A step this invocation attempt started and never finished before it failed (Restate journal events). */
  inFlight?: { step: string; at: number };
  /**
   * The runs (ctx.run) an invocation attempt journaled, in order (Restate, for
   * SDKs that trace no run span): a new run names its step; a run carried over
   * from the attempt before (re-run after a failure) names none and starts with
   * the attempt; a run still open when the attempt ended has no end.
   */
  journal?: { step?: string; at: number; end?: number }[];
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

const WAIT_SPAN = /^(?:workflow\.)?(?:sleep|wait)\b\s*(.*)$/i;

/**
 * A wait by the generic convention, which a user can add where an engine exports
 * no sleep: workflow.wait.name (or wait.name, workflow.wait.duration) on a span
 * around the sleep, or a span named "sleep <name>". Undefined when it is not one.
 */
function genericWait(span: OtelSpan, a: Attrs): { name?: string } | undefined {
  const named = str(a, "workflow.wait.name", "wait.name");
  const m = WAIT_SPAN.exec(span.name);
  if (!named && !m && str(a, "workflow.wait.duration", "wait.duration") === undefined) return undefined;
  const name = named ?? (m?.[1]?.trim() || undefined);
  return name ? { name } : {};
}

/** Tags a generic wait span; one with no duration (an instant where the sleep began) waits until the run next does something. */
function asWait(t: Partial0, span: OtelSpan, w: { name?: string }): Partial0 {
  t.role = "wait";
  if (w.name) t.step = w.name;
  if (span.startTimeUnixNano === span.endTimeUnixNano) {
    t.waitEdge = "start";
    t.waitName = w.name ?? "sleep";
  }
  return t;
}

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
  const executor = str(a, "dbos.executor.id", "executorID") ?? str(resource, "dbos.executor.id");
  // Every DBOS process is executor "local" unless configured otherwise.
  return executor === "local" ? undefined : executor;
}

/** The deployment or code version that emitted a span. */
function versionOf(resource: Attrs, a: Attrs): string | undefined {
  return (
    str(a, "deployment.id") ??
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
  } else {
    const w = genericWait(span, a);
    if (w) asWait(t, span, w);
  }
  return t;
}

const TEMPORAL_SPAN = /^(StartWorkflow|SignalWithStartWorkflow|UpdateWithStartWorkflow|StartUpdateWithStartWorkflow|RunWorkflow|StartActivity|RunActivity|StartChildWorkflow|ContinueAsNew|HandleSignal|HandleQuery|HandleUpdate|ValidateUpdate|SignalWorkflow|QueryWorkflow|StartWorkflowUpdate|CompleteWorkflow|SignalChildWorkflow|SignalExternalWorkflow|StartNexusOperation|RunStartNexusOperation|RunCancelNexusOperation)(:|$)/;

function temporal(span: OtelSpan, scope: OtelScope, a: Attrs): Partial0 | undefined {
  const own = scope.name.startsWith("@temporalio/") || scope.name.startsWith("temporalio") || TEMPORAL_SPAN.test(span.name);
  // Temporal exports no timer span: a span the workflow wraps around its sleep is
  // the wait, whatever tracer made it, when it names the run with Temporal's keys.
  const wait = own ? undefined : str(a, "temporalWorkflowId", "temporalWorkflowID", "workflowId") && str(a, "temporalRunID", "temporalRunId", "runId") ? genericWait(span, a) : undefined;
  if (!own && !wait) return undefined;
  const wfId = str(a, "temporalWorkflowId", "temporalWorkflowID", "workflowId");
  if (!wfId) return undefined;
  const runId = str(a, "run_id", "temporalRunID", "temporalRunId", "runId");
  // The Python client's StartWorkflow names no run: unkeyed, it takes its trace's (map.ts).
  const t: Partial0 = { engine: "temporal", run: runId ? `${wfId}:${runId}` : "", role: "other" };
  if (wait) return asWait(t, span, wait);
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Inngest: the SDK exports one inngest.execution root per request and copies
 * the step id and attempt onto the user's spans inside a step. No step, sleep
 * or retry span leaves the server, and every span is status UNSET.
 */
function inngest(span: OtelSpan, a: Attrs): Partial0 | undefined {
  const run = str(a, "sdk.run.id");
  if (!run) return undefined;
  const t: Partial0 = { engine: "inngest", run, role: span.name === "inngest.execution" ? "invocation" : "other" };
  // sys.function.id is an internal UUID in Inngest 4 (the function's slug never reaches spans).
  const fn = str(a, "sys.function.id");
  if (fn && !UUID.test(fn)) t.workflow = fn;
  // A span the user wraps around step.sleep (Inngest exports no sleep), even inside the step that ends it.
  const wait = span.name === "inngest.execution" ? undefined : genericWait(span, a);
  if (wait) return asWait(t, span, wait);
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

const RESTATE_EVENT = "restate.invocation.lifecycle.";

/**
 * Restate: the server traces each invocation (ingress, invocation-start, one
 * invocation-attempt per attempt with journal events) and the SDK hook adds an
 * "attempt" span per attempt and a "run (<name>)" span per ctx.run that really
 * ran (replayed runs emit nothing). There is no attempt number and no sleep span:
 * the server's journal events say where a sleep started and which step an
 * attempt was in when it failed.
 */
function restate(span: OtelSpan, a: Attrs): Partial0 | undefined {
  const run = str(a, "restate.invocation.id");
  const runName = str(a, "restate.run.name");
  if (!run && !runName) return undefined;
  const t: Partial0 = { engine: "restate", run: run ?? "", role: "other" };
  // "researchAgent/research-durable-agents/run" (service/key/handler): the service.
  const target = str(a, "restate.invocation.target");
  if (target) t.workflow = target.split("/")[0] || target;
  const name = span.name;
  if (name.startsWith("ingress") || name.startsWith("invocation-start")) t.role = "start";
  else if (name.startsWith("invocation-attempt")) {
    t.role = "invocation";
    let open: { step: string; at: number } | undefined;
    const journal: { step?: string; at: number; end?: number }[] = [];
    for (const e of span.events) {
      if (!e.name.startsWith(RESTATE_EVENT)) continue;
      const what = e.name.slice(RESTATE_EVENT.length);
      const type = str(e.attributes, "restate.journal.command.type");
      const cmd = str(e.attributes, "restate.journal.command.name");
      const at = nanosToMs(e.timeUnixNano);
      if (what === "new_command" && type === "Command/Run") {
        open = { step: cmd ?? "run", at };
        journal.push({ ...open });
      } else if (what === "run_ended") {
        const last = journal[journal.length - 1];
        if (open && last && last.end === undefined) last.end = at;
        else journal.push({ at: nanosToMs(span.startTimeUnixNano), end: at });
        open = undefined;
      } else if (what === "new_command" && type === "Command/Sleep") {
        t.waitEdge = "start";
        t.waitAt = at;
        t.waitName = cmd ?? "sleep";
      }
    }
    if (open && span.status.code === 2) t.inFlight = open;
    if (journal.length) t.journal = journal;
  } else if (name.startsWith("attempt ")) t.role = "invocation";
  else if (runName || name.startsWith("run")) {
    t.role = "step";
    const step = runName ?? /^run \((.*)\)$/.exec(name)?.[1];
    if (step) {
      t.step = step;
      t.stepId = step;
    }
  }
  return t;
}

const DBOS_FAILED_ATTEMPT = /^Step (attempt \d+ failed|retry predicate failed)/;

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
    // One span covers every attempt; each failed one is an event at its end (its "N" counts from 2).
    const failures = span.events
      .filter((e) => DBOS_FAILED_ATTEMPT.test(e.name))
      .map((e) => {
        const f: { at: number; error?: string; retryMs?: number } = { at: nanosToMs(e.timeUnixNano) };
        const err = str(e.attributes, "error");
        if (err) f.error = err;
        const retry = Number(e.attributes.retryIntervalSeconds);
        if (Number.isFinite(retry) && retry >= 0) f.retryMs = Math.round(retry * 1000);
        return f;
      });
    if (failures.length) t.failures = failures;
  } else if (span.name === "sleep" && str(a, "workflow.wait.name", "wait.name") === undefined) {
    // DBOS Python's own sleep span is the checkpoint write as DBOS.sleep begins: the wait starts there.
    t.role = "wait";
    t.waitEdge = "start";
    t.waitName = "sleep";
  } else {
    const w = genericWait(span, a);
    if (w) asWait(t, span, w);
  }
  if (a.cached === true) t.replay = true;
  return t;
}

/** A JSON-looking attribute parsed, else undefined. */
function json(v: OtelValue | undefined): unknown {
  if (typeof v !== "string" || !/^[[{n]/.test(v)) return undefined;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return undefined;
  }
}

const INTERRUPT = /(^|\.)(Graph|Node)Interrupt$/;

/**
 * LangGraph through OpenInference (metadata as a JSON string) or LangSmith's
 * OTel exporter (flat langsmith.metadata.* attributes). The thread is the run:
 * it outlives processes through its checkpointer. Each invoke is a root span
 * (the invocation); node spans are step attempts, with no attempt number, and a
 * node that calls interrupt() ends in a GraphInterrupt exception: the thread
 * waits there until an invoke resumes it with a Command.
 */
function langgraph(span: OtelSpan, a: Attrs): Partial0 | undefined {
  const m = json(a.metadata);
  const md: Attrs = isObj(a.metadata) ? a.metadata : isObj(m) ? m : {};
  const node = str(a, "langgraph_node", "langgraph.node", "metadata.langgraph_node", "langsmith.metadata.langgraph_node") ?? str(md, "langgraph_node");
  const thread = str(a, "langsmith.metadata.thread_id", "metadata.thread_id", "thread_id") ?? str(md, "thread_id") ?? str(a, "session.id");
  if (!thread || node === "__start__" || node === "__end__") return undefined;
  const graph = str(a, "langsmith.metadata.graph_id", "graph_id") ?? str(md, "graph_id");
  if (!node) {
    // The graph's own root span: one invoke of the thread.
    const integration = str(a, "langsmith.metadata.ls_integration") ?? str(md, "ls_integration");
    if (integration !== "langgraph" || span.parentSpanId) return undefined;
    const t: Partial0 = { engine: "langgraph", run: thread, role: "invocation", workflow: graph ?? span.name };
    // invoke(None) continues from the checkpoint (after a crash); invoke(Command(resume=…)) answers an interrupt.
    let input = json(str(a, "input.value") ?? str(a, "gen_ai.prompt"));
    if (isObj(input) && Object.keys(input).length === 1 && "input" in input) input = input.input;
    if (input === null) t.recovered = true;
    else if (isObj(input) && input.resume !== undefined) t.waitEdge = "end";
    return t;
  }
  const step = int(a, "langgraph_step", "langgraph.step", "metadata.langgraph_step", "langsmith.metadata.langgraph_step") ?? int(md, "langgraph_step");
  const ns = str(a, "langgraph_checkpoint_ns", "langsmith.metadata.langgraph_checkpoint_ns") ?? str(md, "langgraph_checkpoint_ns");
  const t: Partial0 = { engine: "langgraph", run: thread, role: "step", step: node, stepId: `${step ?? ""}:${node}:${ns ?? ""}` };
  if (graph) t.workflow = graph;
  // LangSmith leaves a failed node's span OK (and an interrupted one ERROR): the exception event says which.
  for (const e of span.events) {
    if (e.name !== "exception") continue;
    const type = str(e.attributes, "exception.type") ?? "";
    const msg = str(e.attributes, "exception.message") ?? "";
    if (INTERRUPT.test(type) || /^(Graph|Node)Interrupt\(/.test(msg)) return { ...t, role: "wait", step: "interrupt", waitEdge: "start", waitName: "interrupt" };
    // LangSmith writes repr(exc) + the traceback: SearchError('search API returned 503')Traceback…
    t.error ??= msg.split("Traceback")[0]!.trim().replace(/^\w+\((["'])(.*)\1\)$/s, "$2") || type || "failed";
  }
  return t;
}

/** Durable-run tag for one span, or undefined when no engine claims it. */
export function durableOf(span: OtelSpan, resource: Attrs, scope: OtelScope): DurableTag | undefined {
  const a = span.attributes;
  const t = temporal(span, scope, a) ?? vercel(span, scope, a) ?? inngest(span, a) ?? restate(span, a) ?? dbos(span, scope, a) ?? langgraph(span, a);
  if (!t) return undefined;
  const out: DurableTag = t;
  // The engine's own server (Restate) is not the process running the run's code.
  if (str(resource, "service.namespace") === "Restate") return out;
  const instance = instanceOf(resource, a) ?? (t.engine === "dbos" && span.traceId ? `trace:${span.traceId}` : undefined);
  if (instance) out.instance = instance;
  const version = versionOf(resource, a);
  if (version) out.version = version;
  return out;
}
