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
  // The process a span's children ran in, when they ran in another one than it (payload.instance).
  const childProcess = new Map<string, { instance: string; version?: string }>();
  for (const e of sorted) {
    if (!e.spanId) continue;
    const k = `${e.traceId ?? ""}/${e.spanId}`;
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
    const inst = e.payload.instance;
    const pk = `${e.traceId ?? ""}/${e.parentSpanId}`;
    if (typeof inst === "string" && e.parentSpanId && !childProcess.has(pk)) childProcess.set(pk, e.agentVersion ? { instance: inst, version: e.agentVersion } : { instance: inst });
  }
  const out: Rec[] = [];
  for (const [key, evs] of groups) {
    const tagged = evs.find((e) => isTag(e.payload.durable));
    if (!tagged) continue;
    let tag = tagged.payload.durable as DurableTag;
    // An engine's server span (a Restate invocation attempt) ran where the code it invoked did.
    const child = tag.role === "invocation" && !tag.instance ? childProcess.get(key) : undefined;
    if (child) tag = { ...tag, instance: child.instance, ...(child.version && !tag.version ? { version: child.version } : {}) };
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

/**
 * Restate SDKs that trace no run span (Python): steps from the runs each
 * invocation attempt journaled. A run carried over into the next attempt ran
 * again there; one still open when its attempt failed failed with it, unless the
 * next attempt runs on another process: then it was lost with its process (the
 * inFlight rule in durableStats).
 */
function journalSteps(recs: Rec[]): { steps: Step[]; attempts: Attempt[] } | undefined {
  const inv = recs.filter((r) => r.tag.role === "invocation" && r.tag.journal?.length);
  if (!inv.length || recs.some((r) => r.tag.role === "step")) return undefined;
  const steps: Step[] = [];
  let carried: Step | undefined;
  for (const [i, r] of inv.entries()) {
    const next = inv[i + 1];
    for (const j of r.tag.journal!) {
      let s = j.step ? undefined : carried;
      carried = undefined;
      if (j.step) steps.push((s = { name: j.step, attempts: [], ok: false, first: j.at }));
      if (!s) continue;
      const a: Attempt = { n: s.attempts.length + 1, startedAt: j.at, endedAt: j.end ?? r.end, ok: j.end !== undefined, rec: r, spanId: r.spanId };
      if (j.end === undefined) {
        carried = s;
        const moved = !!r.tag.instance && !!next?.tag.instance && next.tag.instance !== r.tag.instance;
        if (r.ok || moved) continue;
        if (r.error) a.error = r.error;
      }
      if (r.tag.instance) a.instance = r.tag.instance;
      if (r.tag.version) a.version = r.tag.version;
      s.attempts.push(a);
    }
  }
  const kept = steps.filter((s) => s.attempts.length);
  for (const s of kept) s.ok = s.attempts[s.attempts.length - 1]!.ok;
  return { steps: kept, attempts: kept.flatMap((s) => s.attempts).sort((a, b) => a.startedAt - b.startedAt) };
}

/** Step attempt records grouped into steps, attempts numbered, unreported attempts inferred. */
function buildSteps(recs: Rec[], byKey: Map<string, Rec>): { steps: Step[]; attempts: Attempt[] } {
  const journal = journalSteps(recs);
  if (journal) return journal;
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
  const nth = new Map<string, number>();
  let anon = 0;
  for (const r of stepRecs) {
    if (ownerOf(r)) continue;
    const name = r.tag.step ?? "step";
    let key: string;
    if (r.tag.stepId) key = `id:${r.tag.stepId}`;
    else if (scheduleOf(r)) key = `sched:${scheduleOf(r)!.key}`;
    else if (r.tag.engine === "dbos") {
      // One DBOS span holds all of a step's attempts, and a recovery replays the
      // workflow from the top: the k-th same-named step of each execution is one step.
      const k = `${r.parentKey ?? ""}/${name}`;
      const i = nth.get(k) ?? 0;
      nth.set(k, i + 1);
      key = `nth:${name}#${i}`;
    } else {
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
      const prev = step.attempts[step.attempts.length - 1];
      // Spans of one reported attempt (Inngest tags each span a step runs) are that one attempt.
      if (reported && prev && prev.n === r.tag.attempt) {
        prev.startedAt = Math.min(prev.startedAt, r.start);
        prev.endedAt = Math.max(prev.endedAt, r.end);
        if (!r.ok) {
          prev.ok = false;
          if (r.error) prev.error ??= r.error;
        }
        continue;
      }
      // Failed attempts reported inside one span (DBOS span events), each ending at its event.
      let start = r.start;
      const failures = r.tag.failures ?? [];
      failures.forEach((f, i) => {
        // A span that failed for good ends with its last attempt.
        const end = !r.ok && i === failures.length - 1 ? r.end : Math.max(start, f.at);
        // They share the span: each is a part of it (work, a lane bar, a tree node).
        const a: Attempt = { n: ++n, startedAt: start, endedAt: end, ok: false, rec: r, spanId: r.spanId };
        if (f.error) a.error = f.error;
        if (r.tag.instance) a.instance = r.tag.instance;
        if (r.tag.version) a.version = r.tag.version;
        step.attempts.push(a);
        start = Math.min(r.end, end + (f.retryMs ?? 0));
      });
      if (failures.length && !r.ok) continue;
      // DBOS Python marks no replay: a step that succeeded is never run again, so a
      // later span of it (a recovery re-running the workflow) reads its result back.
      const replay = r.tag.replay || (r.tag.engine === "dbos" && !failures.length && r.ok && step.attempts.some((x) => x.ok));
      // A replay reads the recorded result back: the same attempt, not a new one.
      n = reported ? r.tag.attempt! : replay && n > 0 ? n : n + 1;
      const a: Attempt = { n, startedAt: start, endedAt: r.end, ok: r.ok, rec: r, spanId: r.spanId };
      if (r.error) a.error = r.error;
      if (replay) a.replay = true;
      if (r.tag.instance) a.instance = r.tag.instance;
      if (r.tag.version) a.version = r.tag.version;
      step.attempts.push(a);
    }
    if (reported) {
      const seen = new Set(step.attempts.map((a) => a.n));
      const missing = Math.max(...seen) - seen.size;
      if (missing > 0) step.unreported = missing;
      // The engine only runs a step again after an attempt failed or was lost
      // (Inngest leaves a failed attempt's spans UNSET).
      for (const a of step.attempts) if (a.ok && step.attempts.some((b) => b.n > a.n)) a.ok = false;
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
  const head = recs.find((r) => r.tag.role !== "other" && r.tag.run) ?? recs.find((r) => r.tag.run) ?? recs[0]!;
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

  const prevWork = (w: Work): Work | undefined => {
    let best: Work | undefined;
    for (const x of work) if (x !== w && x.end <= w.start && x.instance && (!best || x.end > best.end)) best = x;
    return best;
  };
  /** When a process was last seen before `t`: the end of its last span. */
  const lastSeen = (instance: string, t: number): number | undefined => {
    let seen: number | undefined;
    for (const r of recs) if (r.tag.instance === instance && r.end <= t && (seen === undefined || r.end > seen)) seen = r.end;
    return seen;
  };
  /**
   * One attempt of `s` was lost before `next`: it began at `from` and was seen
   * working for `ranMs`; the rest, up to `next`, its process was down. The time
   * is kept when the lost attempt is the step's first (it sits right before it).
   */
  const lose = (s: Step, next: Attempt, from: number, ranMs: number, renumber: boolean) => {
    s.unreported = (s.unreported ?? 0) + 1;
    if (renumber) for (const a of s.attempts) if (a.startedAt >= next.startedAt) a.n += 1;
    if (next !== s.attempts[0] || s.unreportedMs !== undefined || !(next.startedAt > from)) return;
    s.unreportedMs = Math.round(next.startedAt - from);
    s.unreportedRanMs = Math.round(Math.max(0, Math.min(ranMs, next.startedAt - from)));
  };
  const firstIn = (w: Work): Attempt | undefined => w.attempt ?? attempts.find((a) => a.spanId && a.startedAt >= w.start && a.startedAt <= w.end);
  /** The first attempt that really ran from `w` on (a recovery replays the steps before it first). */
  const realIn = (w: Work): Attempt | undefined => {
    const a = firstIn(w);
    return a?.replay ? attempts.find((x) => x.spanId && !x.replay && x.startedAt >= w.start) : a;
  };
  const stepOf = (a: Attempt | undefined) => (a ? steps.find((x) => x.attempts.includes(a)) : undefined);

  // Temporal: a step first reported long after it was scheduled, on a new process:
  // an attempt was lost. It ran at most until its process was last seen (its last
  // export); after that it was down until the engine's timeout retried it.
  const scheduleOf = (r: Rec): Rec | undefined => {
    const p = r.parentKey ? byKey.get(r.parentKey) : undefined;
    return p?.tag.role === "schedule" ? p : undefined;
  };
  for (const s of steps) {
    const first = s.attempts[0];
    const sched = first && scheduleOf(first.rec);
    const w = first && work.find((x) => x.attempt === first);
    const prev = w && prevWork(w);
    if (!first || !sched || !w?.instance || !prev?.instance || prev.instance === w.instance) continue;
    if (s.unreported !== undefined || s.attempts.some((a) => a.rec.tag.attempt !== undefined)) continue;
    if (first.startedAt - sched.start < UNREPORTED_MIN_MS) continue;
    lose(s, first, sched.start, (lastSeen(prev.instance, first.startedAt) ?? sched.start) - sched.start, true);
  }
  // A gap before the first reported attempt number (Inngest, the hand-rolled
  // convention), on a new process: lost with the old one, after it was last seen.
  for (const s of steps) {
    const first = s.attempts[0];
    const w = first && work.find((x) => x.attempt === first);
    const prev = w && prevWork(w);
    if (!first || !s.unreported || s.unreportedMs !== undefined || first.n <= 1 || !w?.instance || !prev?.instance || prev.instance === w.instance) continue;
    s.unreported -= 1;
    lose(s, first, lastSeen(prev.instance, first.startedAt) ?? prev.end, 0, false);
  }
  // Vercel: the recovery released a step whose process exited mid-attempt. The
  // next step attempt to start is its retry; the released attempt was never reported.
  for (const o of recs) {
    if (!o.tag.orphan) continue;
    const next = attempts.find((a) => a.spanId && a.startedAt >= o.start);
    const s = stepOf(next);
    if (!next || !s) continue;
    const old = work.filter((x) => x.end <= o.start && x.instance && x.instance !== o.tag.instance).pop();
    lose(s, next, (old?.instance && lastSeen(old.instance, o.start)) || o.start, 0, true);
  }
  // Restate: an invocation attempt failed inside a step that reported no attempt
  // in it: the attempt ran from the step's start until the attempt broke off.
  for (const r of recs) {
    const f = r.tag.inFlight;
    if (!f || r.ok) continue;
    const s = steps.find((x) => x.name === f.step);
    if (!s || s.attempts.some((a) => a.startedAt >= f.at - 1 && a.startedAt <= r.end)) continue;
    const next = s.attempts.find((a) => a.startedAt >= r.end);
    if (next) lose(s, next, f.at, r.end - f.at, true);
  }
  // LangGraph: an invoke that continues from the checkpoint (input None) on a new
  // process whose own invoke never reported: the process died, and the node the
  // new invoke runs first was in flight there.
  for (const w of work) {
    if (!w.rec.tag.recovered || w.attempt || !w.instance) continue;
    const prev = prevWork(w);
    if (!prev?.instance || prev.instance === w.instance) continue;
    if (recs.some((o) => (o.tag.role === "invocation" && o.tag.instance === prev.instance) || o.tag.orphan)) continue;
    const next = firstIn(w);
    const s = stepOf(next);
    if (next && s && s.unreported === undefined && next === s.attempts[0]) lose(s, next, lastSeen(prev.instance, w.start) ?? prev.end, 0, true);
  }
  // DBOS: a recovery replays the steps that finished, then runs the one in flight
  // when the old process went away, unless that process was last seen entering a
  // sleep. Only DBOS Python says where a process stopped in a sleep (its "sleep"
  // span); without it a stop during a sleep would read as a lost attempt of the
  // step after it.
  if (engine === "dbos" && recs.some((r) => r.tag.waitEdge === "start")) {
    for (const s of steps) {
      const first = s.attempts.find((a) => !a.replay);
      if (!first || first !== s.attempts[0] || s.unreported !== undefined) continue;
      const w = work.find((x) => x.attempt === first);
      if (!w?.instance) continue;
      // Only the first step that really ran on this process.
      if (work.some((x) => x !== w && x.instance === w.instance && x.attempt && !x.attempt.replay && x.start < w.start)) continue;
      const old = work.filter((x) => x.end <= w.start && x.instance && x.instance !== w.instance).pop();
      if (!old?.instance) continue;
      const lastOld = recs.filter((r) => r.tag.instance === old.instance && r.end <= w.start).sort((a, b) => a.end - b.end).pop();
      if (!lastOld || lastOld.tag.role === "wait") continue;
      lose(s, first, lastSeen(old.instance, w.start) ?? old.end, 0, true);
    }
  }

  // Waits: spans that cover the wait, or start and end instants paired in order;
  // a start with no end closes where the run next does something.
  const waits: DurableWait[] = [];
  const open: { at: number; name: string; rec: Rec }[] = [];
  for (const r of recs) {
    if (r.tag.waitEdge === "start") open.push({ at: r.tag.waitAt ?? r.start, name: r.tag.waitName ?? "wait", rec: r });
    else if (r.tag.waitEdge === "end") {
      const s = open.shift();
      waits.push({ startedAt: s ? s.at : r.start, endedAt: r.start, name: s?.name ?? "wait" });
    } else if (r.tag.role === "wait") waits.push({ startedAt: r.start, endedAt: r.end, name: r.tag.step ?? "sleep" });
  }
  // A start inside a wait span is that wait (the engine's sleep instant inside a
  // user's span around it). A recovery replays up to the wait and enters it again
  // (DBOS re-runs DBOS.sleep): replays and re-entries are not the run doing something.
  const covered = waits.slice();
  let until = -Infinity;
  let lastName = "";
  for (const s of open.sort((a, b) => a.at - b.at)) {
    if (covered.some((w) => s.at >= w.startedAt - 1 && s.at <= (w.endedAt ?? Infinity))) continue;
    if (s.name === lastName && s.at < until) continue;
    const next = work.find((x) => x.start > s.at && x.rec !== s.rec && !x.attempt?.replay && !x.rec.tag.replay && x.rec.tag.role !== "orchestrate");
    waits.push(next ? { startedAt: s.at, endedAt: next.start, name: s.name } : { startedAt: s.at, name: s.name });
    until = next ? next.start : Infinity;
    lastName = s.name;
  }
  waits.sort((a, b) => a.startedAt - b.startedAt);

  // Resume points, each named by the first step attempt that ran from there.
  const resumes: DurableResume[] = [];
  const resumedAt = (r: DurableResume, w: Work) => {
    // The first attempt that really ran from there (a recovery replays the steps before it first).
    const after = attempts.filter((x) => x.spanId && x.startedAt >= w.start);
    const a = (w.attempt?.replay ? undefined : w.attempt) ?? after.find((x) => !x.replay) ?? w.attempt ?? after[0];
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
      // The first attempt here (or in this invocation) follows a lost one: its process died.
      else if (moved && stepOf(realIn(w))?.unreported !== undefined && realIn(w) === stepOf(realIn(w))!.attempts.find((a) => a.spanId && !a.replay)) reason = "crash";
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
  const replayed = new Set(attempts.filter((a) => a.replay).map((a) => a.rec));
  for (const r of recs) if (BUSY_ROLES.has(r.tag.role) && !r.tag.replay && !replayed.has(r)) busy.push([r.start, r.end]);
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
