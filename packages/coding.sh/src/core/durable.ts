// Durable workflow runs: a session's payload.durable span tags (src/otel/durable.ts)
// folded into steps with their attempts, waits, resume points and honest timing.
// Pure over the session's events, like the rest of buildSession.
//
// Timing: wallMs runs from the first to the last activity, so a run that slept
// for three days has a three-day wall. activeMs is the union of the time
// something ran (step attempts, invocations, model and tool calls); waits,
// retry backoff, queueing and downtime are wallMs − activeMs (idleMs), and the
// explicit waits among them are waitMs.
//
// Attempts: as the engine reports them (step.attempt), else by start order.
// An attempt can go unreported: a process killed mid-step never exports its
// span. Two signs of that are a gap in reported attempt numbers, and (Temporal)
// a step whose first reported attempt starts long after it was scheduled, on
// another process than the run's previous work. Either counts as a retry, and
// the second marks the resume there as a crash.
import type { AgentEvent, DurableAttempt, DurableResume, DurableStats, DurableStep, DurableWait } from "../schema/index.ts";
import type { DurableTag } from "../otel/durable.ts";

/** Flags a durable run can raise. */
export const DURABLE_FLAGS = {
  /** A step failed at least once and ran again (or an attempt went unreported). */
  stepRetried: "step-retried",
  /** The run continued after a crash, a deploy or a worker restart. */
  resumed: "resumed",
} as const;

/** A first reported attempt this long after scheduling, on a new process, means an earlier one was lost. */
export const UNREPORTED_MIN_MS = 2_000;
/** Steps kept on Session.stats (retried, failed and unreported ones first). */
export const MAX_DURABLE_STEPS = 300;
/** Engines whose workers are long-lived processes: a worker that stops and never comes back was restarted. */
const LONG_LIVED = new Set(["temporal", "restate", "dbos"]);
const BUSY_ROLES = new Set(["step", "invocation", "orchestrate", "start"]);
const END_KINDS = new Set(["turn.end", "tool.end", "subagent.end", "session.end"]);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const startOf = (e: AgentEvent): number => (END_KINDS.has(e.kind) ? e.ts - (num(e.durationMs) ?? 0) : e.ts);
const endOf = (e: AgentEvent): number => (END_KINDS.has(e.kind) ? e.ts : e.ts + (num(e.durationMs) ?? 0));

const isTag = (v: unknown): v is DurableTag =>
  typeof v === "object" && v !== null && typeof (v as DurableTag).engine === "string" && typeof (v as DurableTag).run === "string" && typeof (v as DurableTag).role === "string";

interface Rec {
  key: string;
  traceId: string;
  spanId: string;
  parentKey?: string;
  tag: DurableTag;
  start: number;
  end: number;
  ok: boolean;
  error?: string;
}

type Step = Omit<DurableStep, "attempts"> & { attempts: Attempt[]; first: number };

interface Attempt extends DurableAttempt {
  rec: Rec;
}

/** Total length of the union of intervals. */
function unionMs(intervals: [number, number][]): number {
  const xs = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | undefined;
  for (const [a, b] of xs) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else if (b > cur[1]) cur[1] = b;
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** Spans of a session that carry a durable tag, with their time range and outcome. */
function records(sorted: readonly AgentEvent[]): Rec[] {
  const groups = new Map<string, AgentEvent[]>();
  for (const e of sorted) {
    if (!e.spanId) continue;
    const k = `${e.traceId ?? ""}/${e.spanId}`;
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  const out: Rec[] = [];
  for (const [key, evs] of groups) {
    const tagged = evs.find((e) => isTag(e.payload.durable));
    if (!tagged) continue;
    const tag = tagged.payload.durable as DurableTag;
    const r: Rec = {
      key,
      traceId: tagged.traceId ?? "",
      spanId: tagged.spanId!,
      tag,
      start: Math.round(Math.min(...evs.map(startOf))),
      end: Math.round(Math.max(...evs.map(endOf))),
      ok: !evs.some((e) => e.payload.ok === false) && !tag.error,
    };
    const parent = evs.find((e) => e.parentSpanId)?.parentSpanId;
    if (parent) r.parentKey = `${r.traceId}/${parent}`;
    const err = r.tag.error ?? evs.map((e) => e.payload.error).find((x): x is string => typeof x === "string" && x !== "");
    if (err && !r.ok) r.error = err;
    out.push(r);
  }
  return out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}

/** Step attempt records grouped into steps, attempts numbered, unreported attempts inferred. */
function buildSteps(recs: Rec[], byKey: Map<string, Rec>): { steps: Step[]; attempts: Attempt[] } {
  const stepRecs = recs.filter((r) => r.tag.role === "step");
  // A step span nested in another span of the same step (a LangGraph node's inner chain) is not an attempt.
  const ownerOf = (r: Rec): Rec | undefined => {
    for (let k = r.parentKey, hops = 0; k && hops < 64; hops++) {
      const p = byKey.get(k);
      if (!p) return undefined;
      if (p.tag.role === "step" && p.tag.step === r.tag.step && p.tag.stepId === r.tag.stepId) return p;
      k = p.parentKey;
    }
    return undefined;
  };
  const scheduleOf = (r: Rec): Rec | undefined => {
    const p = r.parentKey ? byKey.get(r.parentKey) : undefined;
    return p?.tag.role === "schedule" ? p : undefined;
  };
  const groups = new Map<string, Rec[]>();
  const lastByName = new Map<string, { key: string; ok: boolean }>();
  let anon = 0;
  for (const r of stepRecs) {
    if (ownerOf(r)) continue;
    const name = r.tag.step ?? "step";
    let key: string;
    if (r.tag.stepId) key = `id:${r.tag.stepId}`;
    else if (scheduleOf(r)) key = `sched:${scheduleOf(r)!.key}`;
    else {
      // No id: a same-name span right after a failed attempt is its retry, anything else a new step.
      const prev = lastByName.get(name);
      key = prev && !prev.ok ? prev.key : `anon:${anon++}:${name}`;
    }
    lastByName.set(name, { key, ok: r.ok });
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const steps: Step[] = [];
  const all: Attempt[] = [];
  for (const rs of groups.values()) {
    rs.sort((a, b) => a.start - b.start);
    const first = rs[0]!;
    const step: Step = { name: first.tag.step ?? "step", attempts: [], ok: rs[rs.length - 1]!.ok, first: first.start };
    if (first.tag.stepId) step.id = first.tag.stepId;
    const reported = rs.every((r) => r.tag.attempt !== undefined);
    let n = 0;
    for (const r of rs) {
      // Failed attempts reported inside one span (DBOS span events) become zero-length attempts at its start.
      for (let i = 0; i < (r.tag.failedAttempts ?? 0); i++) step.attempts.push({ n: ++n, startedAt: r.start, endedAt: r.start, ok: false, rec: r });
      n = reported ? r.tag.attempt! : n + 1;
      const a: Attempt = { n, startedAt: r.start, endedAt: r.end, ok: r.ok, rec: r, spanId: r.spanId };
      if (r.error) a.error = r.error;
      if (r.tag.replay) a.replay = true;
      if (r.tag.instance) a.instance = r.tag.instance;
      if (r.tag.version) a.version = r.tag.version;
      step.attempts.push(a);
    }
    if (reported) {
      const seen = new Set(step.attempts.map((a) => a.n));
      const missing = Math.max(...seen) - seen.size;
      if (missing > 0) step.unreported = missing;
    }
    steps.push(step);
    all.push(...step.attempts);
  }
  steps.sort((a, b) => a.first - b.first);
  return { steps, attempts: all.sort((a, b) => a.startedAt - b.startedAt) };
}

/** Folds a session's durable span tags; undefined when the session is not a durable run. */
export function durableStats(sorted: readonly AgentEvent[]): DurableStats | undefined {
  const recs = records(sorted);
  if (!recs.length) return undefined;
  const byKey = new Map(recs.map((r) => [r.key, r]));
  const head = recs.find((r) => r.tag.role !== "other") ?? recs[0]!;
  const engine = head.tag.engine;
  const { steps, attempts } = buildSteps(recs, byKey);

  // Work in time order: what ran, where. Invocations count with attempts.
  type Work = { start: number; end: number; instance?: string; version?: string; attempt?: Attempt; step?: Step; rec: Rec };
  const work: Work[] = [];
  for (const s of steps) for (const a of s.attempts) if (a.spanId) work.push({ start: a.startedAt, end: a.endedAt, ...(a.instance ? { instance: a.instance } : {}), ...(a.version ? { version: a.version } : {}), attempt: a, step: s, rec: a.rec });
  for (const r of recs) {
    if (r.tag.role !== "invocation" && r.tag.role !== "orchestrate") continue;
    work.push({ start: r.start, end: r.end, ...(r.tag.instance ? { instance: r.tag.instance } : {}), ...(r.tag.version ? { version: r.tag.version } : {}), rec: r });
  }
  work.sort((a, b) => a.start - b.start || a.end - b.end);

  // Temporal: a step first reported long after it was scheduled, on a new process: an attempt was lost.
  const scheduleOf = (r: Rec): Rec | undefined => {
    const p = r.parentKey ? byKey.get(r.parentKey) : undefined;
    return p?.tag.role === "schedule" ? p : undefined;
  };
  const prevWork = (w: Work): Work | undefined => {
    let best: Work | undefined;
    for (const x of work) if (x !== w && x.end <= w.start && x.instance && (!best || x.end > best.end)) best = x;
    return best;
  };
  for (const s of steps) {
    if (s.unreported !== undefined || s.attempts.some((a) => a.rec.tag.attempt !== undefined)) continue;
    const first = s.attempts[0];
    const sched = first && scheduleOf(first.rec);
    if (!first || !sched) continue;
    const lead = first.startedAt - sched.start;
    const w = work.find((x) => x.attempt === first);
    const prev = w && prevWork(w);
    if (lead >= UNREPORTED_MIN_MS && w?.instance && prev?.instance && prev.instance !== w.instance) {
      s.unreported = 1;
      s.unreportedMs = Math.round(lead);
      for (const a of s.attempts) a.n += 1;
    }
  }
  // Vercel: the recovery released a step whose process exited mid-attempt. The
  // next step attempt to start is its retry; the released attempt was never reported.
  for (const o of recs) {
    if (!o.tag.orphan) continue;
    const next = attempts.find((a) => a.spanId && a.startedAt >= o.start);
    const s = next && steps.find((x) => x.attempts.includes(next));
    if (!next || !s) continue;
    s.unreported = (s.unreported ?? 0) + 1;
    for (const a of s.attempts) if (a.startedAt >= o.start) a.n += 1;
  }

  // Waits: spans that cover the wait, or created/completed instants paired in order.
  const waits: DurableWait[] = [];
  const open: Rec[] = [];
  for (const r of recs) {
    if (r.tag.role !== "wait") continue;
    if (r.tag.waitEdge === "start") open.push(r);
    else if (r.tag.waitEdge === "end") {
      const s = open.shift();
      waits.push({ startedAt: s ? s.start : r.start, endedAt: r.start, name: "wait" });
    } else waits.push({ startedAt: r.start, endedAt: r.end, name: r.tag.step ?? "sleep" });
  }
  for (const s of open) waits.push({ startedAt: s.start, name: "wait" });
  waits.sort((a, b) => a.startedAt - b.startedAt);

  // Resume points, each named by the first step attempt that ran from there.
  const resumes: DurableResume[] = [];
  const resumedAt = (r: DurableResume, w: Work) => {
    const a = w.attempt ?? attempts.find((x) => x.spanId && x.startedAt >= w.start);
    const s = a && steps.find((x) => x.attempts.includes(a));
    if (s) r.step = s.name;
    if (a?.spanId) r.spanId = a.spanId;
  };
  let prev: Work | undefined;
  for (let i = 0; i < work.length; i++) {
    const w = work[i]!;
    if (prev) {
      const moved = !!prev.instance && !!w.instance && prev.instance !== w.instance;
      const redeployed = !!prev.version && !!w.version && prev.version !== w.version;
      let reason: DurableResume["reason"] | undefined;
      if (redeployed) reason = "deploy";
      else if (moved && w.step?.unreportedMs !== undefined && w.attempt === w.step.attempts[0]) reason = "crash";
      else if (moved && (w.rec.tag.delivery ?? 1) > 1) reason = "crash";
      // A recovery invocation (Vercel): a crash when it released a step the dead process left mid-attempt.
      else if (moved && w.rec.tag.recovered) reason = recs.some((o) => o.tag.orphan && o.tag.instance === w.instance) ? "crash" : "restart";
      else if (moved && LONG_LIVED.has(engine) && !work.slice(i).some((x) => x.instance === prev!.instance)) reason = "restart";
      if (reason) {
        const r: DurableResume = { at: w.start, reason, afterMs: Math.max(0, Math.round(w.start - prev.end)) };
        // An invocation resumed the run: name the first step that ran after it.
        resumedAt(r, w);
        if (prev.instance) r.fromInstance = prev.instance;
        if (w.instance) r.toInstance = w.instance;
        if (redeployed) {
          r.fromVersion = prev.version!;
          r.toVersion = w.version!;
        }
        resumes.push(r);
      }
    }
    if (w.instance || w.version) prev = w;
  }
  for (const wt of waits) {
    if (wt.endedAt === undefined) continue;
    const next = work.find((x) => x.start >= wt.endedAt! - 1);
    if (!next || resumes.some((r) => r.at === next.start)) continue;
    const r: DurableResume = { at: next.start, reason: "wait", afterMs: Math.max(0, Math.round(next.start - wt.startedAt)) };
    resumedAt(r, next);
    resumes.push(r);
  }
  resumes.sort((a, b) => a.at - b.at);

  // Timing.
  let first = Infinity;
  let last = -Infinity;
  const busy: [number, number][] = [];
  for (const e of sorted) {
    first = Math.min(first, startOf(e));
    last = Math.max(last, endOf(e));
    if ((e.kind === "llm.call" || e.kind === "tool.end") && e.payload.replay !== true) busy.push([startOf(e), endOf(e)]);
  }
  for (const r of recs) if (BUSY_ROLES.has(r.tag.role) && !r.tag.replay) busy.push([r.start, r.end]);
  const wallMs = Number.isFinite(first) && last > first ? Math.round(last - first) : 0;
  const activeMs = Math.min(wallMs, Math.round(unionMs(busy)));
  const waitMs = Math.round(unionMs(waits.map((w) => [w.startedAt, w.endedAt ?? last] as [number, number])));

  const retries = steps.reduce((n, s) => n + Math.max(0, Math.max(0, ...s.attempts.map((a) => a.n)) - 1), 0);
  const instances = new Set(recs.map((r) => r.tag.instance).filter((x): x is string => !!x));
  const replayedCalls = sorted.filter((e) => e.kind === "llm.call" && e.payload.replay === true).length;

  // Keep the interesting steps when there are too many.
  let kept = steps;
  if (steps.length > MAX_DURABLE_STEPS) {
    const interesting = (s: Step) => s.attempts.length > 1 || !s.ok || s.unreported !== undefined;
    kept = [...steps.filter(interesting), ...steps.filter((s) => !interesting(s))].slice(0, MAX_DURABLE_STEPS).sort((a, b) => a.first - b.first);
  }
  const out: DurableStats = {
    engine,
    runId: head.tag.run,
    steps: kept.map(({ attempts: as, first: _f, ...s }) => ({ ...s, attempts: as.map(({ rec: _r, ...a }) => a) })),
    retries,
    failedAttempts: attempts.filter((a) => !a.ok).length,
    replays: attempts.filter((a) => a.replay).length,
    waits,
    resumes,
    instances: instances.size,
    wallMs,
    activeMs,
    waitMs,
    idleMs: Math.max(0, wallMs - activeMs),
  };
  const workflow = recs.map((r) => r.tag.workflow).find((x) => !!x);
  if (workflow) out.workflow = workflow;
  if (replayedCalls) out.replayedCalls = replayedCalls;
  if (steps.length !== kept.length) out.stepCount = steps.length;
  return out;
}

/** Flags for a durable run. */
export function durableFlags(d: DurableStats | undefined): string[] {
  if (!d) return [];
  const out: string[] = [];
  if (d.retries > 0) out.push(DURABLE_FLAGS.stepRetried);
  if (d.resumes.some((r) => r.reason !== "wait")) out.push(DURABLE_FLAGS.resumed);
  return out;
}
