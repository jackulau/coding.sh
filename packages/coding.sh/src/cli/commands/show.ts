// coding.sh show <session>: header, latency, the event timeline, and the
// subagent tree (child sessions linked by parent.sessionId). A session too
// long to list (more events than --limit) shows as phases (core/outline.ts)
// with its derails; --all lists every event, --follow tails a running one.
// An id that names no session but a model call (`<call id>`, `<session>#3`)
// shows that call: system prompt, tools, cache and usage (diff-calls.ts).
import { setTimeout as sleep } from "node:timers/promises";
import { callCopies } from "../../core/call-copies.ts";
import { sessionOutline, phaseLabel, storedOutline, type Outline, type Phase } from "../../core/outline.ts";
import { costNote } from "../../core/pricing.ts";
import { failureFlags } from "../../core/sessions.ts";
import { SKILL_EVENT_KINDS, SKILL_TAG_PREFIX, skillUse, type SkillUseReport } from "../../core/skills-use.ts";
import { pageTree, subagentsOf, type TreeNode } from "../../core/tree.ts";
import { checkpointRunsText, weightsEventText, weightsSummaryText } from "../../core/weights.ts";
import type { AgentEvent, Session } from "../../core/types.ts";
import type { CheckpointExperiment } from "../../experiments/checkpoints.ts";
import type { DurableStats } from "../../schema/index.ts";
import { positiveInt } from "../args.ts";
import { CallRefError, loadCall, resolveCall } from "../../proxy/calls.ts";
import { autoIngest, fieldsFlag, oneLine, pickFields, resolveSession, sessionJson, withContext, notFoundWithBacklog, pendingField, readIngest } from "../common.ts";
import { ago, clean, CliError, duration, localTime, plural, tokens, usd, type Output } from "../output.ts";
import { printCall } from "./diff-calls.ts";
import type { CommandContext } from "../types.ts";
import type { BlobStore, IndexStore } from "../../core/types.ts";
import type { SessionDerail } from "../../schema/index.ts";
import type { FileDiff } from "../../core/snapshot.ts";

/** Subagent sessions `show` lists, the first in tree order (as `tree` prints them); `tree` has them all. */
const SUBAGENT_JSON_LIMIT = 50;
const SUBAGENT_TEXT_LIMIT = 500;

const countTree = (t: readonly TreeNode[]): number => t.reduce((n, x) => n + 1 + countTree(x.children), 0);

function treeJson(t: readonly TreeNode[]): unknown[] {
  return t.map((x) => ({ session: sessionJson(x.session), subagents: treeJson(x.children) }));
}

/** An event for --json without what `session` already says for every one of them: the session id, the agent and the cwd. */
function eventJson(e: AgentEvent, s: Session): Record<string, unknown> {
  const { sessionId: _id, agent, cwd, ...rest } = e;
  const out: Record<string, unknown> = rest;
  if (agent !== s.agent) out.agent = agent;
  if (cwd !== undefined && cwd !== s.cwd) out.cwd = cwd;
  return out;
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

/** The last lines of a failed tool's output, indented under its line: what went wrong, not just that it did. */
export function failedTail(output: unknown): string {
  if (typeof output !== "string") return "";
  const lines = clean(output).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  return lines.slice(-3).map((l) => `\n${"".padStart(18)}${oneLine(l.trim(), 150)}`).join("");
}

/**
 * Failed tool calls whose stored output was cut, with the full output read back
 * from its blob: the tail shown under the line is then the real end of the
 * output, not the end of the stored preview. A blob counts only when it starts
 * with the preview, so a raw payload blob is never shown as the output.
 */
export async function withFullFailedOutputs(events: AgentEvent[], blobs: BlobStore): Promise<AgentEvent[]> {
  return Promise.all(
    events.map(async (e) => {
      const p = e.payload;
      if (e.kind !== "tool.end" || p.ok !== false || typeof p.output !== "string") return e;
      const own = str(p.outputBlob);
      if (!own && !p.truncated && !p.output.endsWith("…")) return e;
      const preview = p.output.endsWith("…") ? p.output.slice(0, -1) : p.output;
      const refs = [...(e.blobs ?? [])].reverse();
      if (own) refs.unshift(own);
      for (const ref of refs) {
        const full = await blobs.getText(ref).catch(() => undefined);
        if (full !== undefined && full.length > preview.length && full.startsWith(preview)) return { ...e, payload: { ...p, output: full } };
      }
      return e;
    }),
  );
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
      return `tool        ${str(p.tool) ?? str(start?.payload.tool) ?? "?"} ${oneLine(clean(toolArg(input)), 70)}  ${status} ${duration(e.durationMs)}${p.ok === false ? failedTail(p.output) : ""}`;
    }
    case "llm.call": {
      // Proxy calls: cache use, and the id that `show`, `diff-calls` and `exp replay` take.
      const u = e.usage;
      const proxied = e.source === "proxy" ? `${u?.cacheReadTokens || u?.cacheWriteTokens ? ` cache r${tokens(u.cacheReadTokens ?? 0)}/w${tokens(u.cacheWriteTokens ?? 0)}` : ""}  ${e.id.slice(0, 12)}` : "";
      return `llm         ${e.model ?? str(p.model) ?? ""} ${duration(e.durationMs)} in ${tokens(e.usage?.inputTokens)} out ${tokens(e.usage?.outputTokens)}${callCost(e)}${proxied}`;
    }
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
    case "notification": {
      if (p.kind === "harness.loaded") return `harness     ${oneLine(clean(harnessText(p)), 90)}`;
      // A weight edit or a checkpoint: one line from core/weights.ts.
      const weights = weightsEventText(p);
      if (weights !== undefined) return `weights     ${oneLine(clean(weights), 140)}`;
      if (p.kind === "hook.context") return `hook        ${str(p.hookEvent) ?? ""} ${str(p.hookSource) ?? "unknown"} ~${tokens(typeof p.tokens === "number" ? p.tokens : undefined)} tok  ${oneLine(clean(str(p.text) ?? ""), 70)}`;
      return `${`${e.kind} `.padEnd(12)}${oneLine(clean(str(p.text) ?? str(p.message) ?? str(p.reason) ?? ""), 80)}`;
    }
    default:
      return `${`${e.kind} `.padEnd(12)}${oneLine(clean(str(p.name) ?? ""), 80)}`;
  }
}

const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "");

/** A mid-session harness load (Claude Code attachments): what reached the agent's context. */
function harnessText(p: Record<string, unknown>): string {
  switch (p.loadedBy) {
    case "nested_memory":
      return `loaded ${list(p.paths)}`;
    case "dynamic_skill":
      return `skills listed: ${list(p.skills)}${str(p.dir) ? ` (${str(p.dir)})` : ""}`;
    case "skill":
      return `skill ${list(p.skills)} loaded${list(p.sources) ? ` from ${list(p.sources)}` : ""}`;
    case "invoked_skills":
      return `skills restored: ${list(p.skills)}`;
    default:
      return `loaded ${list(p.paths) || list(p.skills)}`;
  }
}

const VIA_TEXT = { invoke: "invoked", read: "read", run: "ran" } as const;

/** "pdf (project, invoked, first, before any edit) · pdf-tools (personal, read)". */
export function skillsText(r: SkillUseReport): string {
  return r.used
    .map((u, i) => {
      const parts: string[] = [u.scope, ...u.via.map((v) => VIA_TEXT[v])];
      if (i === 0) parts.push("first");
      if (u.beforeFirstChange) parts.push("before any edit");
      return `${u.name} (${parts.join(", ")})`;
    })
    .join(" · ");
}

/** What redaction replaced in the session, by kind, with the rotate hint when a vendor token was among them. */
export function redactedRow(s: Session): [string, string] | undefined {
  const r = s.stats.redactions;
  if (!r) return undefined;
  const kinds = Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
  return ["Redacted", s.flags.includes("secret:exposed") ? `${kinds}. The agent saw these credentials: rotate them` : kinds];
}

/** Text hooks added to the context: how many, how many tokens, and whose hooks (largest first). */
export function hookContextRow(s: Session): [string, string] | undefined {
  const h = s.stats.hookContext;
  if (!h) return undefined;
  const by = Object.entries(h.bySource)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([k, v]) => `${k} ~${tokens(v.tokens)} (${v.count})`)
    .join(", ");
  return ["Hook context", `${h.count} ${h.count === 1 ? "text" : "texts"}, ~${tokens(h.tokens)} tokens: ${by}`];
}

const TRIGGER_TEXT = { fallback: "after a fallback", refusal: "after a refusal", error: "after a failed call", command: "after /model" } as const;

/** What a switch's calls cost over the model it left: "4 calls on the other model, $0.0123 extra" (or "… less"). */
export function switchCostText(sw: NonNullable<Session["stats"]["modelSwitch"]>): string | undefined {
  if (!sw.switchedCalls) return undefined;
  const calls = `${sw.switchedCalls} ${sw.switchedCalls === 1 ? "call" : "calls"} on the other model`;
  if (sw.extraUsd === undefined) return calls;
  if (sw.extraUsd === 0) return `${calls}, at the same list prices as ${sw.from}`;
  return `${calls}, ${usd(Math.abs(sw.extraUsd))} ${sw.extraUsd < 0 ? "less" : "extra"} than at ${sw.from}'s prices`;
}

/**
 * Calls per model when more than one model made them, and the first switch:
 * "claude-opus-5-5 3, claude-opus-4-8 2; switched from claude-opus-5-5 to claude-opus-4-8 at +12s after a fallback (overloaded); 2 calls on the other model, $0.0123 extra than at claude-opus-5-5's prices".
 */
export function modelsRow(s: Session): [string, string] | undefined {
  const m = s.stats.models;
  const sw = s.stats.modelSwitch;
  if (!m && !sw) return undefined;
  const parts: string[] = [];
  if (m) parts.push(Object.entries(m).map(([k, n]) => `${k} ${n}`).join(", "));
  if (sw) {
    const why = sw.trigger ? ` ${TRIGGER_TEXT[sw.trigger] ?? `after ${sw.trigger}`}${sw.reason ? ` (${sw.reason})` : ""}` : "";
    const where = sw.subagent ? " in a subagent" : "";
    parts.push(`switched from ${sw.from} to ${sw.to}${where} at +${duration(Math.max(0, sw.at - s.startedAt))}${why}${sw.count ? ` (${sw.count} switches)` : ""}`);
    const cost = switchCostText(sw);
    if (cost) parts.push(cost);
  }
  return ["Models", parts.join("; ")];
}

/** Header rows for waste: repeated read-only calls and prompt-cache breaks. */
export function wasteRows(s: Session): [string, string][] {
  const rows: [string, string][] = [];
  const w = s.stats.waste;
  if (w) rows.push(["Re-fetches", `${w.duplicateFetches} of ${w.readOnlyCalls} read-only calls repeated with the same result (~${tokens(w.duplicateFetchTokens)} tokens re-sent)`]);
  const b = s.stats.cacheBreaks;
  if (b) {
    const idle = Object.entries(b.byIdle ?? {}).map(([k, c]) => `${k} ${c!.count}`).join(", ");
    const causes = Object.entries(b.byCause)
      .sort((x, y) => y[1]!.lostTokens - x[1]!.lostTokens)
      .map(([k, c]) => `${k} ${c!.count}${k === "idle" && idle ? ` (${idle})` : ""}`)
      .join(", ");
    const cost = b.extraUsd !== undefined ? `, ${usd(b.extraUsd)} extra` : "";
    rows.push(["Cache breaks", `${b.count}: ${tokens(b.lostTokens)} prompt tokens billed again${cost} (${causes})`]);
  }
  return rows;
}

/** Skill use recomputed from the session's events (only the `skill:` tags are stored); undefined when it has none. */
async function sessionSkills(index: IndexStore, s: Session): Promise<SkillUseReport | undefined> {
  if (!s.flags.some((f) => f.startsWith(SKILL_TAG_PREFIX))) return undefined;
  return skillUse(await index.listEvents(s.id, { kinds: SKILL_EVENT_KINDS }), { cwd: s.cwd });
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
    if (s.unreported) {
      const ms = s.unreportedMs;
      const seen = ms !== undefined && s.unreportedRanMs !== undefined ? `; seen ${duration(s.unreportedRanMs)}, then down ${duration(ms - s.unreportedRanMs)}` : "";
      const time = ms !== undefined && !seen ? ` ${duration(ms)}` : "";
      attempts.push(`${s.unreported} lost${time} (its process stopped${seen})`);
    }
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

function printTree(out: Output, t: readonly TreeNode[], depth = 1): void {
  for (const x of t) {
    const s = x.session;
    const d = s.endedAt !== undefined ? duration(s.endedAt - s.startedAt) : "-";
    out.print(`${"  ".repeat(depth)}└ ${s.id}  ${s.parent?.type === "harness" ? `harness ${s.agent}` : (s.parent?.type ?? s.agent)}  ${d}  ${s.stats.toolCalls} tools  ${oneLine(clean(s.title ?? ""), 60)}`);
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
 * Each checkpoint of the session that an experiment ran, in the order the session recorded them, with those
 * experiments (newest first). Empty for a session with no checkpoint, which reads no experiment.
 */
async function checkpointRuns(index: IndexStore, s: Session, env: NodeJS.ProcessEnv): Promise<{ sha256: string; experiments: CheckpointExperiment[] }[]> {
  const hashes = s.stats.weightEdits?.checkpoints;
  if (!hashes?.length) return [];
  // Loaded here, so showing a session with no checkpoint loads no experiment code.
  const [{ FileEvalStore }, { checkpointExperiments }] = await Promise.all([import("../../datasets/store.ts"), import("../../experiments/checkpoints.ts")]);
  const by = await checkpointExperiments(new FileEvalStore({ env, index }), hashes);
  return hashes.flatMap((sha256) => (by.has(sha256) ? [{ sha256, experiments: by.get(sha256)! }] : []));
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

/** The top-level fields of `show --json` (a session, or a model call), for --fields. */
const SHOW_FIELDS = ["session", "snapshot", "eventCount", "events", "phases", "days", "subagentCount", "subagents", "subagentsTruncated", "subagentsRest", "skills", "pending", "call", "request", "response"];

/** Sessions with more events than this show as phases unless --all or --limit is given. */
const DEFAULT_LIMIT = 200;

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const explicitLimit = positiveInt(c.flags.limit, "limit");
  const limit = explicitLimit ?? DEFAULT_LIMIT;
  const all = c.flags.all === true;
  const fields = fieldsFlag(c, SHOW_FIELDS);
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const ref = c.positionals[0]!;
    let s: Session;
    try {
      s = await resolveSession(ctx, ref);
    } catch (err) {
      // Not a session: maybe a model call.
      if (!(err instanceof CliError) || err.reason !== "not_found" || c.flags.follow === true) throw notFoundWithBacklog(err, backlog);
      let call: AgentEvent | undefined;
      try {
        call = await resolveCall(ctx.index, ref);
      } catch (e) {
        // "Session X has 0 model calls; no #-1" says more than "can't find session". "Can't find" says nothing new.
        if (e instanceof CallRefError && (e.reason === "ambiguous" || !/^Can't find/.test(e.message))) {
          throw new CliError(e.message, { reason: e.reason, next: e.reason === "ambiguous" ? ["Use more of the id, or list sessions:", "coding.sh sessions"] : ["List sessions:", "coding.sh sessions"], data: e.candidates.length ? { candidates: e.candidates } : undefined });
        }
      }
      if (!call) throw notFoundWithBacklog(err, backlog);
      const loaded = await loadCall(ctx.blobs, call);
      if (out.json) {
        const doc = { call: call, request: loaded.request ?? null, response: loaded.response ?? null };
        out.data(fields ? pickFields(doc, fields) : doc);
      }
      else printCall(out, loaded, all);
      return 0;
    }
    if (c.flags.follow === true) return follow(c, ctx, s);
    // The phase view reads the phases kept at ingest; only a session stored before they were kept needs every event.
    const phased = !all && explicitLimit === undefined && s.stats.events > limit;
    const derails = s.stats.derails ?? [];
    const stored = all ? undefined : storedOutline(s);
    const full = all || (phased && !stored) ? await ctx.index.listEvents(s.id) : undefined;
    // --json of a phased session lists no events, so it reads none.
    const events = full && !all ? full.slice(0, limit) : (full ?? (out.json && phased ? [] : await ctx.index.listEvents(s.id, { limit })));
    const outline = stored ?? (full ? sessionOutline(full, derails) : events.length >= s.stats.events ? sessionOutline(events, derails) : undefined);
    // The walk `tree` does, so the count here is the count there.
    const tree = await subagentsOf(ctx.index, s);
    const subagentCount = countTree(tree);
    const changes = await snapshotChanges(s, c.env);
    const changed = new Set(events.filter((e) => e.kind === "file.change" && typeof e.payload.path === "string").map((e) => e.payload.path as string));
    // A HEAD-based diff can include edits from before the session; count it only against a real start snapshot.
    if (changes?.startKind === "snapshot") for (const f of changes.files) changed.add(f.path);
    const filesChanged = Math.max(s.stats.filesChanged, changed.size);
    const skills = await sessionSkills(ctx.index, s);
    // The experiments that ran each weights file the session recorded as a checkpoint (exp run --weights with the same hash).
    const ranIn = await checkpointRuns(ctx.index, s, c.env);
    if (out.json) {
      // A phased session answers with its phases, as the text does; --all or --limit lists the events.
      const listed = phased ? [] : ((all ? full : events) ?? []);
      const subagents = pageTree(tree, 0, SUBAGENT_JSON_LIMIT);
      const doc: Record<string, unknown> = {
        session: sessionJson(s, { derailEvents: true }),
        snapshot: changes ?? null,
        eventCount: s.stats.events,
        events: listed.map((e) => eventJson(e, s)),
        phases: outline?.phases ?? [],
        days: outline?.days ?? [],
        subagentCount,
        subagents: treeJson(subagents.roots),
      };
      // The count alone does not say where the rest are.
      if (subagents.next !== undefined) Object.assign(doc, { subagentsTruncated: true, subagentsRest: `coding.sh tree ${s.id} --json` });
      doc.skills = skills?.used ?? [];
      if (ranIn.length) doc.checkpointExperiments = ranIn;
      Object.assign(doc, pendingField(backlog));
      out.data(fields ? pickFields(doc, fields) : doc);
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
      ["Turns", `${s.stats.turns}, ${plural(s.stats.toolCalls, "tool call")}${s.stats.toolErrors ? ` (${s.stats.toolErrors} failed)` : ""}, ${plural(filesChanged, "file")} changed`],
    ];
    // Tags (a colon in the name) are not failures; what is left is why `sessions --where is:flagged` listed it.
    const flags = failureFlags(s.flags);
    if (flags.length) rows.push(["Flags", flags.join(", ")]);
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
    const models = modelsRow(s);
    if (models) rows.push(models);
    if (s.parent) rows.push(["Parent", s.parent.sessionId]);
    const d = s.stats.durable;
    if (d) rows.push(...durableRows(d));
    if (outline && outline.phases.length > 1) rows.push(["Phases", phaseCounts(outline)]);
    rows.push(...wasteRows(s));
    const red = redactedRow(s);
    if (red) rows.push(red);
    const hooks = hookContextRow(s);
    if (hooks) rows.push(hooks);
    if (s.stats.weightEdits) rows.push(["Weight edits", weightsSummaryText(s.stats.weightEdits)]);
    for (const x of ranIn) rows.push(["Experiments", oneLine(clean(checkpointRunsText(x.sha256, x.experiments)), 140)]);
    if (skills?.used.length) rows.push(["Skills", skillsText(skills)]);
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
      printEvents(out, s, await withFullFailedOutputs(events, ctx.blobs), all ? outline : undefined, derails);
      if (!all && events.length >= limit && s.stats.events > limit) out.note(`Showing the first ${limit} events; pass --limit for more or --all for every event`);
    }
    if (tree.length) {
      out.print();
      out.print(out.style("Subagents", "bold"));
      printTree(out, pageTree(tree, 0, SUBAGENT_TEXT_LIMIT).roots);
      if (subagentCount > SUBAGENT_TEXT_LIMIT) out.note(`Showing the first ${SUBAGENT_TEXT_LIMIT} of ${subagentCount.toLocaleString("en-US")} subagents; coding.sh tree ${s.id} lists them all`);
    }
    return 0;
  }, { create: false });
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
      p.filesChanged ? plural(p.filesChanged, "file") : "",
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
  // A model call the proxy and the agent's own capture both logged: one line, at the proxy's copy.
  const copies = callCopies(events);
  events.forEach((e, i) => {
    const day = dayAt.get(i);
    if (day) out.print(out.style(dayLine(day.ts), "faint"));
    const p = phaseAt.get(i);
    if (p) out.print(out.style(`── phase ${p.n}: ${phaseLabel(p)} at ${clock(p.startTs)} ──`, "faint"));
    for (const d of derailAt.get(e.id) ?? []) out.print(out.style(`${"".padStart(8)}  ${derailLine(s, d)}`, "yellow"));
    if (copies.folded.has(e.id)) return;
    e = copies.merged.get(e.id) ?? e;
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
    const fresh = await withFullFailedOutputs(batch.filter((e) => !seen.has(e.id)), ctx.blobs);
    // One line per model call the proxy and the agent's own capture both logged:
    // the merged copy when both are new, nothing when the other was printed before.
    const copies = callCopies(batch);
    const into = new Map([...copies.folded].map(([other, proxy]) => [proxy, other]));
    const freshIds = new Set(fresh.map((e) => e.id));
    for (const e of fresh) {
      const twin = copies.folded.get(e.id) ?? into.get(e.id);
      const printed = twin !== undefined && (freshIds.has(twin) ? copies.folded.has(e.id) : seen.has(twin));
      seen.add(e.id);
      if (printed) continue;
      const shownAs = copies.merged.get(e.id) ?? e;
      const line = describe(shownAs, starts);
      if (line !== undefined) out.print(`${`+${duration(Math.max(0, shownAs.ts - s.startedAt))}`.padStart(8)}  ${line}`);
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
    await autoIngest(ctx, readIngest(c));
    s = (await ctx.index.getSession(id)) ?? s;
    batch = await tail();
  }
  out.note(signal.aborted ? "Stopped following" : "Session ended");
  return 0;
}
