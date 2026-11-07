// coding.sh show <session>: header, latency, the event timeline, and the
// subagent tree (child sessions linked by parent.sessionId). A session too
// long to list (more events than --limit) shows as phases (core/outline.ts)
// with its derails; --all lists every event, --follow tails a running one.
import { setTimeout as sleep } from "node:timers/promises";
import { sessionOutline, phaseLabel, storedOutline, type Outline, type Phase } from "../../core/outline.ts";
import { costNote } from "../../core/pricing.ts";
import type { AgentEvent, Session } from "../../core/types.ts";
import type { DurableStats } from "../../schema/index.ts";
import { positiveInt } from "../args.ts";
import { autoIngest, oneLine, resolveSession, sessionJson, withContext } from "../common.ts";
import { ago, clean, duration, localTime, tokens, usd, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";
import type { IndexStore } from "../../core/types.ts";
import type { SessionDerail } from "../../schema/index.ts";
import type { FileDiff } from "../../core/snapshot.ts";

interface Tree {
  session: Session;
  children: Tree[];
}

async function subagentTree(index: IndexStore, id: string, depth = 0, seen = new Set<string>()): Promise<Tree[]> {
  if (depth > 5 || seen.has(id)) return [];
  seen.add(id);
  const kids = await index.listSessions({ parentSessionId: id, limit: 500 });
  kids.sort((a, b) => a.startedAt - b.startedAt);
  return Promise.all(kids.map(async (k) => ({ session: k, children: await subagentTree(index, k.id, depth + 1, seen) })));
}

function treeJson(t: Tree[]): unknown[] {
  return t.map((x) => ({ session: sessionJson(x.session), subagents: treeJson(x.children) }));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * " $0.0123" for a reported cost, " $0.0123 est" from the price table, " $0.0123 est (as <model>)"
 * from a sibling model's price, " $0.0123 est (batch+long-context)" at tier or long-context rates.
 */
function callCost(e: AgentEvent): string {
  const c = e.usage?.costUsd;
  if (c === undefined) return "";
  if (e.payload.costEstimated !== true) return ` ${usd(c)}`;
  const how = [typeof e.payload.pricedAs === "string" ? `as ${e.payload.pricedAs}` : "", typeof e.payload.priceTier === "string" ? e.payload.priceTier : ""].filter(Boolean);
  return ` ${usd(c)} est${how.length ? ` (${how.join(", ")})` : ""}`;
}

/** Short description of a tool input (command, path, pattern…). */
function toolArg(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt"]) {
    const v = o[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ");
  }
  return "";
}

/** One timeline line per event; tool.start/tool.end pairs collapse into the end line. */
function describe(e: AgentEvent, starts: Map<string, AgentEvent>): string | undefined {
  const p = e.payload;
  switch (e.kind) {
    case "user.message":
      return `user        ${oneLine(clean(str(p.text) ?? ""), 100)}`;
    case "assistant.message":
      return `assistant   ${oneLine(clean(str(p.text) ?? ""), 100)}`;
    case "tool.start": {
      const id = str(p.toolUseId);
      if (id) {
        starts.set(id, e);
        return undefined;
      }
      return `tool        ${str(p.tool) ?? "?"} ${oneLine(clean(toolArg(p.input)), 80)}`;
    }
    case "tool.end": {
      const id = str(p.toolUseId);
      const start = id ? starts.get(id) : undefined;
      const input = start?.payload.input ?? p.input;
      const status = p.ok === false ? "failed" : "ok";
      return `tool        ${str(p.tool) ?? str(start?.payload.tool) ?? "?"} ${oneLine(clean(toolArg(input)), 70)}  ${status} ${duration(e.durationMs)}`;
    }
    case "llm.call":
      return `llm         ${e.model ?? str(p.model) ?? ""} ${duration(e.durationMs)} in ${tokens(e.usage?.inputTokens)} out ${tokens(e.usage?.outputTokens)}${callCost(e)}`;
    case "subagent.start":
      return `subagent    start ${str(p.type) ?? str(p.subagentType) ?? ""} ${oneLine(clean(str(p.description) ?? str(p.prompt) ?? ""), 70)}`;
    case "subagent.end":
      return `subagent    end ${duration(e.durationMs)}`;
    case "file.change":
      return `file        ${str(p.op) ?? "change"} ${str(p.path) ?? ""}`;
    case "test.result":
      return `tests       ${p.passed ?? "?"} passed, ${p.failed ?? "?"} failed`;
    case "error":
      return `error       ${oneLine(clean(str(p.message) ?? str(p.error) ?? ""), 100)}`;
    case "session.start":
    case "session.end":
    case "turn.end":
    case "context.compact":
    case "notification":
      return `${`${e.kind} `.padEnd(12)}${oneLine(clean(str(p.text) ?? str(p.message) ?? str(p.reason) ?? ""), 80)}`;
    default:
      return `${`${e.kind} `.padEnd(12)}${oneLine(clean(str(p.name) ?? ""), 80)}`;
  }
}

const RESUME_TEXT = { crash: "a crash", deploy: "a deploy", restart: "a worker restart", wait: "a wait" } as const;

/** Header rows for a durable workflow run: what ran, and where the time went. */
export function durableRows(d: DurableStats): [string, string][] {
  const steps = d.stepCount ?? d.steps.length;
  const parts = [`${steps} ${steps === 1 ? "step" : "steps"}`, `${d.retries} ${d.retries === 1 ? "retry" : "retries"}`];
  if (d.waits.length) parts.push(`${d.waits.length} ${d.waits.length === 1 ? "wait" : "waits"}`);
  if (d.replays) parts.push(`${d.replays} replayed`);
  if (d.instances > 1) parts.push(`${d.instances} processes`);
  const rows: [string, string][] = [
    ["Workflow", `${d.engine}${d.workflow ? ` ${d.workflow}` : ""} (run ${d.runId}): ${parts.join(", ")}`],
    // idleMs includes the waits; shown apart, the three parts add up to the wall time.
    ["Time", `wall ${duration(d.wallMs)}: busy ${duration(d.activeMs)}, ${d.waitMs ? `waiting ${duration(d.waitMs)}, ` : ""}idle ${duration(Math.max(0, d.idleMs - d.waitMs))}`],
  ];
  const resumes = d.resumes.filter((r) => r.reason !== "wait");
  if (resumes.length) {
    const text = resumes.map((r) => {
      const v = r.fromVersion && r.toVersion ? ` (${r.fromVersion} → ${r.toVersion})` : "";
      return `after ${RESUME_TEXT[r.reason]}${v}${r.step ? ` at ${clean(r.step)}` : ""}${r.afterMs ? `, ${duration(r.afterMs)} later` : ""}`;
    });
    rows.push(["Resumed", text.join("; ")]);
  }
  if (d.replayedCalls) rows.push(["Replayed", `${d.replayedCalls} model ${d.replayedCalls === 1 ? "call" : "calls"} re-run from history, not counted in tokens`]);
  return rows;
}

/** One line per durable step: its attempts in order, failures with their error, lost attempts. */
export function durableSteps(d: DurableStats, t0: number): string[] {
  const width = Math.min(24, Math.max(6, ...d.steps.map((s) => clean(s.name).length)));
  const rel = (t: number) => `+${duration(Math.max(0, t - t0))}`.padStart(8);
  const lines: [number, string][] = d.steps.map((s) => {
    const attempts: string[] = [];
    if (s.unreported) attempts.push(`${s.unreported} lost${s.unreportedMs ? ` ${duration(s.unreportedMs)}` : ""} (never reported: its process stopped)`);
    for (const a of s.attempts) {
      const what = a.replay ? "replayed" : a.ok ? "ok" : "failed";
      const err = !a.ok && a.error ? ` (${oneLine(clean(a.error), 50)})` : "";
      attempts.push(`#${a.n} ${what} ${duration(a.endedAt - a.startedAt)}${err}`);
    }
    const t = (s.attempts[0]?.startedAt ?? t0) - (s.unreportedMs ?? 0);
    return [t, `${rel(t)}  ${oneLine(clean(s.name), width).padEnd(width)}  ${s.ok ? "ok    " : "failed"}  ${attempts.join(" → ")}`];
  });
  for (const w of d.waits) {
    const status = (w.endedAt !== undefined ? "done" : "open").padEnd(6);
    lines.push([w.startedAt, `${rel(w.startedAt)}  ${"(wait)".padEnd(width)}  ${status}  ${clean(w.name ?? "wait")} ${w.endedAt !== undefined ? duration(w.endedAt - w.startedAt) : "still waiting"}`]);
  }
  return lines.sort((a, b) => a[0] - b[0]).map(([, l]) => l);
}

function printTree(out: Output, t: Tree[], depth = 1): void {
  for (const x of t) {
    const s = x.session;
    const d = s.endedAt !== undefined ? duration(s.endedAt - s.startedAt) : "-";
    out.print(`${"  ".repeat(depth)}└ ${s.id}  ${s.parent?.type ?? s.agent}  ${d}  ${s.stats.toolCalls} tools  ${oneLine(clean(s.title ?? ""), 60)}`);
    printTree(out, x.children, depth + 1);
  }
}

export interface SnapshotChanges {
  /** Start state: the pre-agent snapshot, else HEAD at session start. */
  start: string;
  /** "head" when no pre-agent snapshot exists: the diff then also holds edits that predate the session. */
  startKind: "snapshot" | "head";
  end: string;
  files: FileDiff[];
}

/**
 * What the working tree gained between the session's start state and its end
 * snapshot. Hooks only emit file.change for edit tools, so a file written by
 * Bash (or by a subagent's shell) shows up here and nowhere else.
 */
export async function snapshotChanges(s: Session, env: NodeJS.ProcessEnv): Promise<SnapshotChanges | undefined> {
  const root = s.repo?.root;
  const start = s.repo?.snapshot ?? s.repo?.head;
  if (!root || !start || !s.endSnapshot || start === s.endSnapshot) return undefined;
  try {
    const { diffSnapshots } = await import("../../core/snapshot.ts");
    const { files } = await diffSnapshots(root, start, s.endSnapshot, env);
    return { start, startKind: s.repo?.snapshot ? "snapshot" : "head", end: s.endSnapshot, files };
  } catch {
    return undefined; // shadow repo gone or history pruned: the header just omits it
  }
}

/** "Nov 6 14:02 (3m ago)" within a day, else "Nov 6 14:02"; --json keeps the ISO timestamp. */
export function startedText(ts: number, now = Date.now()): string {
  const rel = ago(ts, { now });
  return rel.endsWith("ago") || rel === "just now" ? `${localTime(ts, now)} (${rel})` : localTime(ts, now);
}

/** Sessions with more events than this show as phases unless --all or --limit is given. */
const DEFAULT_LIMIT = 200;

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const explicitLimit = positiveInt(c.flags.limit, "limit");
  const limit = explicitLimit ?? DEFAULT_LIMIT;
  const all = c.flags.all === true;
  return withContext(c, async (ctx) => {
    await autoIngest(ctx);
    const s = await resolveSession(ctx, c.positionals[0]!);
    if (c.flags.follow === true) return follow(c, ctx, s);
    // The phase view reads the phases kept at ingest; only a session stored before they were kept needs every event.
    const phased = !all && explicitLimit === undefined && s.stats.events > limit;
    const derails = s.stats.derails ?? [];
    const stored = all ? undefined : storedOutline(s);
    const full = all || (phased && !stored) ? await ctx.index.listEvents(s.id) : undefined;
    const events = full && !all ? full.slice(0, limit) : (full ?? (await ctx.index.listEvents(s.id, { limit })));
    const outline = stored ?? (full ? sessionOutline(full, derails) : events.length >= s.stats.events ? sessionOutline(events, derails) : undefined);
    const tree = await subagentTree(ctx.index, s.id);
    const changes = await snapshotChanges(s, c.env);
    const changed = new Set(events.filter((e) => e.kind === "file.change" && typeof e.payload.path === "string").map((e) => e.payload.path as string));
    // A HEAD-based diff can include edits from before the session; count it only against a real start snapshot.
    if (changes?.startKind === "snapshot") for (const f of changes.files) changed.add(f.path);
    const filesChanged = Math.max(s.stats.filesChanged, changed.size);
    if (out.json) {
      out.data({ session: sessionJson(s), snapshot: changes ?? null, events: all ? full : events, phases: outline?.phases ?? [], days: outline?.days ?? [], subagents: treeJson(tree) });
      return 0;
    }
    const lat = s.stats.latency;
    const u = s.stats.usage;
    out.print(out.style(oneLine(clean(s.title ?? s.id), 100), "bold"));
    const rows: [string, string][] = [
      ["Session", s.id],
      ["Agent", [s.agent, s.agentVersion, s.model].filter(Boolean).join("  ")],
      ["Repo", s.repo ? `${s.repo.root}${s.repo.branch ? ` (${s.repo.branch})` : ""}` : (s.cwd ?? "-")],
      ["Started", startedText(s.startedAt)],
      ["Duration", s.endedAt !== undefined ? duration(s.endedAt - s.startedAt) : "running or not ended"],
      ["Turns", `${s.stats.turns}, ${s.stats.toolCalls} tool calls${s.stats.toolErrors ? ` (${s.stats.toolErrors} failed)` : ""}, ${filesChanged} files changed`],
    ];
    if (u) rows.push(["Tokens", `in ${tokens(u.inputTokens)}  out ${tokens(u.outputTokens)}  cache ${tokens(u.cacheReadTokens)}  ${usd(u.costUsd)}${costNote(u)}`]);
    if (lat) {
      const parts: string[] = [];
      if (lat.llmCalls) parts.push(`${lat.llmCalls} llm calls, p50 ${duration(lat.llmP50Ms)}, p95 ${duration(lat.llmP95Ms)}`);
      if (lat.ttftP50Ms !== undefined) parts.push(`ttft p50 ${duration(lat.ttftP50Ms)}`);
      if (lat.toolMs !== undefined) parts.push(`tools ${duration(lat.toolMs)} (p95 ${duration(lat.toolP95Ms)})`);
      if (parts.length) rows.push(["Latency", parts.join("; ")]);
    }
    if (changes) {
      const add = changes.files.reduce((n, f) => n + f.additions, 0);
      const del = changes.files.reduce((n, f) => n + f.deletions, 0);
      const names = changes.files.map((f) => f.path);
      const list = names.length ? `: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` +${names.length - 5} more` : ""}` : "";
      const from = `${changes.startKind === "head" ? "HEAD " : ""}${changes.start.slice(0, 7)}`;
      rows.push(["Snapshot", `${from} → ${changes.end.slice(0, 7)}: ${changes.files.length} ${changes.files.length === 1 ? "file" : "files"} (+${add} -${del})${list}`]);
    }
    if (s.parent) rows.push(["Parent", s.parent.sessionId]);
    const d = s.stats.durable;
    if (d) rows.push(...durableRows(d));
    if (outline && outline.phases.length > 1) rows.push(["Phases", phaseCounts(outline)]);
    if (derails.length) rows.push(["Derails", derails.slice(0, 4).map((d) => `${d.flag} at +${duration(Math.max(0, d.ts - s.startedAt))}`).join(", ") + (derails.length > 4 ? ` +${derails.length - 4} more` : "")]);
    for (const [k, v] of rows) out.print(`  ${k.padEnd(14)}${v}`);
    out.print();
    if (d?.steps.length) {
      out.print(out.style("Steps", "bold"));
      for (const l of durableSteps(d, s.startedAt)) out.print(`  ${l}`);
      out.print();
    }
    if (phased) {
      printPhases(out, s, outline!);
      out.note(`${s.stats.events.toLocaleString("en-US")} events in ${outline!.phases.length} ${outline!.phases.length === 1 ? "phase" : "phases"}; --all lists every event, --limit N the first N`);
    } else {
      printEvents(out, s, events, all ? outline : undefined, derails);
      if (!all && events.length >= limit && s.stats.events > limit) out.note(`Showing the first ${limit} events; pass --limit for more or --all for every event`);
    }
    if (tree.length) {
      out.print();
      out.print(out.style("Subagents", "bold"));
      printTree(out, tree);
    }
    return 0;
  });
}

// ---------------------------------------------------------------- long sessions

function phaseCounts(o: Outline): string {
  const n = (k: Phase["kind"]) => o.phases.filter((p) => p.kind === k).length;
  const parts = [[n("resume"), "resume"], [n("compaction"), "compaction"], [n("idle"), "idle gap"]]
    .filter(([c]) => (c as number) > 0)
    .map(([c, w]) => `${c} ${w}${c === 1 ? "" : "s"}`);
  return `${o.phases.length}${parts.length ? ` (${parts.join(", ")})` : ""}${o.days.length ? `, across ${o.days.length + 1} days` : ""}`;
}

/** "+2h38m" from the session start ("+0s" at it). */
const rel = (ms: number) => (ms < 1000 ? "+0s" : `+${duration(ms)}`);
const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
const dayLine = (ts: number) => `── ${new Date(ts).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ──`;
const derailLine = (s: Session, d: SessionDerail) => `⚠ ${d.flag} at +${duration(Math.max(0, d.ts - s.startedAt))}: ${d.detail}`;

/** One line per phase, day lines between them, derails under the phase they started in. */
function printPhases(out: Output, s: Session, o: Outline): void {
  out.print(out.style("Phases", "bold"));
  let day = 0;
  for (const p of o.phases) {
    while (day < o.days.length && o.days[day]!.index <= p.from) out.print(`  ${out.style(dayLine(o.days[day++]!.ts), "faint")}`);
    const stats = [
      `${p.prompts} ${p.prompts === 1 ? "prompt" : "prompts"}`,
      `${p.toolCalls} tools${p.toolErrors ? ` (${p.toolErrors} failed)` : ""}`,
      p.filesChanged ? `${p.filesChanged} files` : "",
      p.tests ? (p.tests.failed ? `${p.tests.failed} tests failing` : `${p.tests.passed} tests passing`) : "",
      p.tokens ? `${tokens(p.tokens)} tok` : "",
      p.costUsd ? usd(p.costUsd) : "",
    ].filter(Boolean);
    out.print(`  ${String(p.n).padStart(3)}  ${clock(p.startTs)}  ${rel(p.startTs - s.startedAt).padStart(8)}  ${phaseLabel(p).padEnd(24)}${duration(p.endTs - p.startTs).padStart(8)}  ${stats.join(", ")}`);
    if (p.title) out.print(`  ${" ".repeat(25)}${out.style(oneLine(clean(p.title), 80), "faint")}`);
    for (const d of p.derails) out.print(`  ${" ".repeat(25)}${out.style(derailLine(s, d), "yellow")}`);
  }
}

/** The event list; with an outline (--all), phase and day lines between events and derail markers at their onset. */
function printEvents(out: Output, s: Session, events: AgentEvent[], o: Outline | undefined, derails: readonly SessionDerail[]): void {
  const starts = new Map<string, AgentEvent>();
  const phaseAt = new Map((o?.phases ?? []).filter((p) => p.n > 1).map((p) => [p.from, p]));
  const dayAt = new Map((o?.days ?? []).map((d) => [d.index, d]));
  const derailAt = new Map<string, SessionDerail[]>();
  for (const d of derails) derailAt.set(d.eventId, [...(derailAt.get(d.eventId) ?? []), d]);
  events.forEach((e, i) => {
    const day = dayAt.get(i);
    if (day) out.print(out.style(dayLine(day.ts), "faint"));
    const p = phaseAt.get(i);
    if (p) out.print(out.style(`── phase ${p.n}: ${phaseLabel(p)} at ${clock(p.startTs)} ──`, "faint"));
    for (const d of derailAt.get(e.id) ?? []) out.print(out.style(`${"".padStart(8)}  ${derailLine(s, d)}`, "yellow"));
    const line = describe(e, starts);
    if (line === undefined) return;
    const rel = `+${duration(Math.max(0, e.ts - s.startedAt))}`.padStart(8);
    out.print(`${rel}  ${line}`);
  });
}

/** How often --follow polls for new events. */
const FOLLOW_POLL_MS = 1500;
/** Events a poll re-reads from the end, to catch rows that arrive out of order. */
const FOLLOW_WINDOW = 400;

/**
 * --follow: the last few events, then new ones as they are ingested, until the
 * session ends (a session.end and a quiet poll after it) or Ctrl-C. New derails
 * print as they are detected.
 */
async function follow(c: CommandContext, ctx: Parameters<Parameters<typeof withContext>[1]>[0], first: Session): Promise<number> {
  const { out, signal } = c;
  const id = first.id;
  let s = first;
  const seen = new Set<string>();
  const starts = new Map<string, AgentEvent>();
  const shown = new Set((s.stats.derails ?? []).map((d) => d.eventId + d.flag));
  const tail = () => ctx.index.listEvents(id, { offset: Math.max(0, s.stats.events - FOLLOW_WINDOW) });
  out.print(out.style(oneLine(clean(s.title ?? s.id), 100), "bold"));
  out.print(`  ${"Session".padEnd(14)}${s.id}`);
  out.print(`  ${"Started".padEnd(14)}${startedText(s.startedAt)}, ${s.stats.events.toLocaleString("en-US")} events so far`);
  for (const d of s.stats.derails ?? []) out.print(out.style(`  ${derailLine(s, d)}`, "yellow"));
  out.print();
  let batch = await tail();
  // Print the last 20; the rest only primes tool starts so a later end shows its input.
  for (const e of batch.slice(0, -20)) {
    seen.add(e.id);
    describe(e, starts);
  }
  let ended = false;
  for (;;) {
    const fresh = batch.filter((e) => !seen.has(e.id));
    for (const e of fresh) {
      seen.add(e.id);
      const line = describe(e, starts);
      if (line !== undefined) out.print(`${`+${duration(Math.max(0, e.ts - s.startedAt))}`.padStart(8)}  ${line}`);
    }
    for (const d of s.stats.derails ?? []) {
      if (shown.has(d.eventId + d.flag)) continue;
      shown.add(d.eventId + d.flag);
      out.print(out.style(`${"".padStart(8)}  ${derailLine(s, d)}`, "yellow"));
    }
    // Done once a session.end has come and a poll after it brought nothing (a resume would).
    if (ended && !fresh.length) break;
    if (fresh.length) ended = fresh.at(-1)!.kind === "session.end";
    try {
      await sleep(FOLLOW_POLL_MS, undefined, { signal });
    } catch {
      break; // Ctrl-C
    }
    await autoIngest(ctx);
    s = (await ctx.index.getSession(id)) ?? s;
    batch = await tail();
  }
  out.note(signal.aborted ? "Stopped following" : "Session ended");
  return 0;
}
