// T3 Code adapter (tier B). T3 Code (github.com/pingdotgg/t3code) is a desktop
// GUI that drives other agents: Codex (`codex app-server`), Claude Code (Agent
// SDK), OpenCode, Cursor, Pi, Grok and ACP agents. It installs no hooks of its
// own; coding.sh reads its store.
//
// Store: $T3CODE_HOME (default ~/.t3)/userdata/
//   statev2.sqlite  v2 projections (orchestration_v2_projection_*): threads,
//                   provider threads (native id, driver, model, cost), provider
//                   turns (per-turn token usage), messages, turn items (tools).
//   state.sqlite    v1 projections (projection_threads/_thread_messages/
//                   _thread_activities/_turns). v2 imports v1 threads under the
//                   same id, so v1 is read only for threads v2 lacks.
// Both are opened as copies (more/_util.ts openSqliteCopy); T3's files are never written.
//
// Sessions: one per provider thread, keyed by the provider's native id, so a
// T3-run Codex rollout or Claude transcript is the same session the codex and
// claude-code adapters import (no duplicates):
//   - Codex/Claude transcript on disk: converted with their own converters, so
//     event ids match whichever adapter imports it first.
//   - OpenCode/Cursor/Pi session in that agent's store: link only (its adapter imports it).
//   - otherwise: built from T3's store (messages, tool items, per-turn usage).
// Every session also gets a "host-link" notification with payload.via =
// "t3code"; buildSession then sets agent "t3code" and provider = the agent T3 ran.
// A thread's first provider thread is top level; later ones (provider switch)
// and T3 subagent threads are child sessions. Threads that never reached a
// provider are `t3code-<threadId>`.
//
// Live capture: T3's Codex and Claude runs fire the codex/claude-code hooks.
// The hook stamps T3's env marker (spool/host.ts), and T3-originated rollouts
// say so in session_meta.originator (codex.ts).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { userHome } from "../core/paths.ts";
import type { Adapter, BackfillFile, BackfillOpts, NormalizeContext } from "../core/types.ts";
import type { AgentEvent, Usage } from "../schema/index.ts";
import { T3_AGENT } from "../spool/host.ts";
import { ClaudeTranscriptConverter, Emitter, blobList, clipText, clipValue, emitDerived, hasOurHooks, num, obj, parentLink, readJsonl, str, toMs, usageSnapshotKey, walkFiles } from "./_shared/index.ts";
import { CLAUDE_AGENT, TRANSCRIPT_IDLE_MS, claudeConfigDir } from "./claude-code.ts";
import { ROLLOUT_IDLE_MS, codexHome, convertRollout } from "./codex.ts";
import { cursorConfigDir } from "./cursor.ts";
import { openSqliteCopy } from "./more/_util.ts";
import { piSessionsDir } from "./more/pi.ts";
import { opencodeDataDir } from "./opencode.ts";

export { T3_AGENT };

export function t3Home(env: NodeJS.ProcessEnv = process.env): string {
  return env.T3CODE_HOME || join(userHome(env), ".t3");
}

export function t3UserData(env: NodeJS.ProcessEnv = process.env): string {
  return join(t3Home(env), "userdata");
}

/** T3 driver kind → coding.sh agent with its own adapter. Other drivers stay as named. */
const DRIVER_AGENT: Record<string, string> = { codex: "codex", claudeAgent: CLAUDE_AGENT, claude: CLAUDE_AGENT, claudeCode: CLAUDE_AGENT, cursor: "cursor", opencode: "opencode", pi: "pi" };
export const providerAgent = (driver: string): string => DRIVER_AGENT[driver] ?? driver;

/** ACP provider threads may scope native ids as provider-instance:<instance>:<id>. */
const unscope = (id: string): string => id.replace(/^provider-instance:[^:]+:/, "");

type Row = Record<string, unknown>;

const parse = (v: unknown): Row => {
  if (typeof v !== "string") return {};
  try {
    return obj(JSON.parse(v));
  } catch {
    return {};
  }
};

const ms = (v: unknown): number | undefined => {
  const t = toMs(v, NaN);
  return Number.isFinite(t) ? t : undefined;
};

// ---------------------------------------------------------------- model

interface ProviderThread {
  id: string;
  driver: string;
  nativeId?: string;
  model?: string;
  status?: string;
  updated: number;
  /** contextUsage.cost in USD, a running total T3 reports. */
  costUsd?: number;
}

interface Thread {
  id: string;
  title?: string;
  project?: string;
  cwd?: string;
  model?: string;
  driver?: string;
  created: number;
  updated: number;
  parentThreadId?: string;
  relation?: string;
  providerThreads: ProviderThread[];
}

interface StoreMessage {
  id: string;
  role: string;
  text: string;
  ts: number;
  /** Provider thread it belongs to, when known. */
  pt?: string;
}

interface StoreTurn {
  id: string;
  pt?: string;
  start: number;
  end?: number;
  done: boolean;
  ok: boolean;
  usage?: Usage;
}

interface StoreItem {
  id: string;
  pt?: string;
  kind: "tool" | "file" | "error" | "compact" | "subagent";
  tool?: string;
  input?: unknown;
  output?: string;
  done: boolean;
  ok: boolean;
  start: number;
  end: number;
  path?: string;
  additions?: number;
  deletions?: number;
  diff?: string;
  text?: string;
  childThreadId?: string;
}

interface StoreRows {
  messages: StoreMessage[];
  turns: StoreTurn[];
  items: StoreItem[];
  /** v1 only: thread totals (no per-turn usage in v1). */
  totals?: Usage;
}

/** Session id for a provider thread (native id when T3 knows it). */
const ptSessionId = (pt: ProviderThread): string => (pt.nativeId ? unscope(pt.nativeId) : `t3code-${pt.id}`);
const primaryOf = (t: Thread): string => (t.providerThreads[0] ? ptSessionId(t.providerThreads[0]) : `t3code-${t.id}`);

/** T3 turn usage counts cache reads and writes inside inputTokens; coding.sh keeps them apart. */
export function turnUsage(u: unknown): Usage | undefined {
  const t = obj(u);
  if (t.usageStatus === "unavailable") return undefined;
  const input = num(t.inputTokens);
  const output = num(t.outputTokens);
  const cacheRead = num(t.cachedInputTokens) ?? 0;
  const cacheWrite = num(t.cacheCreationTokens) ?? 0;
  if (input === undefined && output === undefined) return undefined;
  const usage: Usage = {};
  if (input !== undefined) usage.inputTokens = Math.max(0, input - cacheRead - cacheWrite);
  if (output !== undefined) usage.outputTokens = output;
  if (cacheRead) usage.cacheReadTokens = cacheRead;
  if (cacheWrite) usage.cacheWriteTokens = cacheWrite;
  return usage;
}

const ITEM_DONE = new Set(["completed", "failed", "interrupted", "cancelled", "declined", "error"]);

// ---------------------------------------------------------------- native transcripts

/** Where each provider keeps the session T3 started, by native id (built lazily, once per backfill). */
class NativeIndex {
  private readonly maps = new Map<string, Promise<Map<string, string>>>();
  private readonly env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv) {
    this.env = env;
  }

  find(agent: string, id: string): Promise<string | undefined> {
    let m = this.maps.get(agent);
    if (!m) this.maps.set(agent, (m = this.build(agent)));
    return m.then((map) => map.get(id));
  }

  private async build(agent: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walk = async (root: string, match: (name: string, path: string) => string | undefined, maxDepth: number) => {
      for await (const f of walkFiles(root, { match: (n, p) => match(n, p) !== undefined, maxDepth })) {
        const id = match(f.path.split(/[\\/]/).pop()!, f.path);
        if (id && !out.has(id)) out.set(id, f.path);
      }
    };
    const env = this.env;
    if (agent === "codex") {
      const rollout = (n: string) => /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(n)?.[1];
      await walk(join(codexHome(env), "sessions"), rollout, 4);
      await walk(join(codexHome(env), "archived_sessions"), rollout, 4);
    } else if (agent === CLAUDE_AGENT) {
      const root = join(claudeConfigDir(env), "projects");
      let dirs: string[] = [];
      try {
        dirs = readdirSync(root);
      } catch {
        // no Claude projects
      }
      for (const d of dirs) {
        let names: string[] = [];
        try {
          names = readdirSync(join(root, d));
        } catch {
          continue;
        }
        for (const n of names) if (n.endsWith(".jsonl")) out.set(n.slice(0, -6), join(root, d, n));
      }
    } else if (agent === "cursor") {
      await walk(join(cursorConfigDir(env), "projects"), (n, p) => (n.endsWith(".jsonl") && /[\\/]agent-transcripts[\\/]/.test(p) ? n.slice(0, -6) : undefined), 4);
    } else if (agent === "pi") {
      await walk(piSessionsDir(env), (n) => /_([^_]+)\.jsonl$/.exec(n)?.[1], 3);
    } else if (agent === "opencode") {
      const db = join(opencodeDataDir(env), "opencode.db");
      const h = await openSqliteCopy(db);
      if (h) {
        try {
          for (const r of h.db.prepare("SELECT id FROM session_v2").all() as Row[]) if (str(r.id)) out.set(r.id as string, db);
        } catch {
          // older OpenCode schema: treat as not found
        } finally {
          h.close();
        }
      }
    }
    return out;
  }
}

const statOf = (path: string | undefined): { size: number; mtimeMs: number } => {
  if (!path) return { size: 0, mtimeMs: 0 };
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
};

async function convertNative(ctx: NormalizeContext, agent: string, path: string, sessionId: string): Promise<AgentEvent[]> {
  if (agent === "codex") return convertRollout(ctx, path, { mode: "full", endIfIdleMs: ROLLOUT_IDLE_MS });
  const conv = new ClaudeTranscriptConverter(ctx, { agent: CLAUDE_AGENT, mode: "full", sessionId, source: path.split(/[\\/]/).pop()!, endIfIdleMs: TRANSCRIPT_IDLE_MS });
  try {
    for await (const r of readJsonl(path)) await conv.add(r.value, r.lineNo);
  } catch {
    // truncated transcript: keep what converted
  }
  return conv.finish();
}

// ---------------------------------------------------------------- events

interface SessionPlan {
  thread: Thread;
  sessionId: string;
  pt?: ProviderThread;
  provider: string;
  parent?: { sessionId: string; type: string };
  start: number;
}

/** Events for one session built from T3's own store. */
async function storeEvents(ctx: NormalizeContext, p: SessionPlan, rows: StoreRows, primary: Map<string, string>): Promise<AgentEvent[]> {
  const t = p.thread;
  const model = p.pt?.model ?? t.model;
  const base = { agent: T3_AGENT, sessionId: p.sessionId, ts: p.start, cwd: t.cwd, model };
  const head = new Emitter(ctx, base, ["t3", p.sessionId]);
  const startPayload: Record<string, unknown> = { source: "store", via: T3_AGENT, provider: p.provider, title: t.title?.slice(0, 280), project: t.project, t3ThreadId: t.id };
  if (p.parent) Object.assign(startPayload, parentLink(ctx, T3_AGENT, p.parent.sessionId, p.sessionId, p.parent.type));
  head.emit("session.start", startPayload, { key: ["start"] });
  const out = [...head.events];
  let last = p.start;
  const em = new Emitter(ctx, base, ["t3", p.sessionId, "rows"]);
  for (const m of rows.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const c = await clipText(ctx, m.text);
    em.emit(m.role === "user" ? "user.message" : "assistant.message", { text: c.value, truncated: c.truncated || undefined }, { key: [m.id], ts: m.ts, blobs: blobList(c.blob) });
    last = Math.max(last, m.ts);
  }
  for (const tu of rows.turns) {
    if (tu.done || tu.usage) {
      em.emit("llm.call", { provider: p.provider, responseModel: model, ok: tu.ok, providerTurnId: tu.id }, { key: [tu.id], ts: tu.start, durationMs: tu.end !== undefined ? Math.max(0, tu.end - tu.start) : undefined, usage: tu.usage });
    }
    if (tu.done) em.emit("turn.end", { ok: tu.ok }, { key: [tu.id], ts: tu.end ?? tu.start });
    last = Math.max(last, tu.end ?? tu.start);
  }
  for (const it of rows.items) {
    last = Math.max(last, it.end);
    if (it.kind === "error") {
      em.emit("error", { message: it.text?.slice(0, 2000) ?? "error" }, { key: [it.id], ts: it.end });
    } else if (it.kind === "compact") {
      em.emit("context.compact", { trigger: "auto" }, { key: [it.id], ts: it.end });
    } else if (it.kind === "subagent") {
      const child = it.childThreadId ? primary.get(it.childThreadId) : undefined;
      em.emit("subagent.start", { subagentId: it.id, description: it.text?.slice(0, 280), childSessionId: child }, { key: [it.id], ts: it.start });
      if (it.done) em.emit("subagent.end", { subagentId: it.id, ok: it.ok, childSessionId: child }, { key: [it.id], ts: it.end });
    } else {
      const tool = it.kind === "file" ? "edit" : (it.tool ?? "tool");
      const input = it.kind === "file" ? { path: it.path } : it.input;
      const inp = await clipValue(ctx, input);
      em.emit("tool.start", { tool, toolUseId: it.id, input: inp.value }, { key: [it.id], ts: it.start, blobs: blobList(inp.blob) });
      if (!it.done) continue;
      const o = await clipText(ctx, it.output ?? "");
      em.emit("tool.end", { tool, toolUseId: it.id, ok: it.ok, durationMs: it.end - it.start, output: o.value || undefined }, { key: [it.id], ts: it.end, durationMs: it.end - it.start, blobs: blobList(o.blob) });
      if (it.kind === "file" && it.path && it.ok) {
        const d = it.diff ? await clipText(ctx, it.diff, 2560) : undefined;
        em.emit("file.change", { path: it.path, op: "modify", additions: it.additions, deletions: it.deletions, tool, toolUseId: it.id, diff: d?.value, diffTruncated: d?.truncated || undefined }, { key: [it.id, it.path], ts: it.end, blobs: blobList(d?.blob) });
      } else if (it.kind === "tool") {
        await emitDerived(em, { tool, toolUseId: it.id, input: it.input, output: it.output, ok: it.ok, cwd: t.cwd, extra: { ts: it.end } });
      }
    }
  }
  out.push(...em.events);
  const tail = new Emitter(ctx, { ...base, ts: last }, ["t3", p.sessionId, "tail"]);
  if (rows.totals) tail.emit("notification", { type: "usage-summary", via: T3_AGENT }, { key: usageSnapshotKey(rows.totals), usage: rows.totals });
  if (Date.now() - last > ROLLOUT_IDLE_MS) tail.emit("session.end", { reason: "idle" }, { key: ["idle", last] });
  out.push(...tail.events);
  return out;
}

/** The notification that attributes a session to T3 Code, plus the edge to its parent. */
function linkEvents(ctx: NormalizeContext, p: SessionPlan): AgentEvent[] {
  const t = p.thread;
  const em = new Emitter(ctx, { agent: T3_AGENT, sessionId: p.sessionId, ts: p.start, cwd: t.cwd, model: p.pt?.model ?? t.model }, ["t3", p.sessionId, "link"]);
  em.emit("notification", { type: "host-link", via: T3_AGENT, provider: p.provider, t3ThreadId: t.id, t3ProviderThreadId: p.pt?.id, title: t.title?.slice(0, 280), project: t.project }, { key: ["host-link"] });
  // T3's cost is a running total: reported, never summed into usage.
  if (p.pt?.costUsd !== undefined) em.emit("notification", { type: "usage-report", via: T3_AGENT, reportedUsage: { costUsd: p.pt.costUsd } }, { key: ["usage-report", p.pt.updated], ts: Math.max(p.start, p.pt.updated) });
  if (p.parent) em.emit("subagent.start", { subagentId: p.sessionId, type: p.parent.type, childSessionId: p.sessionId }, { sessionId: p.parent.sessionId, key: [p.sessionId], model: undefined });
  return em.events;
}

/** Session plans for a thread: one per provider thread (or one store-only session). */
function plansFor(t: Thread, primary: Map<string, string>, starts: Map<string, number>): SessionPlan[] {
  const parentSid = t.relation === "subagent" && t.parentThreadId ? primary.get(t.parentThreadId) : undefined;
  const top = parentSid ? { sessionId: parentSid, type: "subagent" } : undefined;
  if (!t.providerThreads.length) return [{ thread: t, sessionId: primaryOf(t), provider: t.driver ? providerAgent(t.driver) : "unknown", parent: top, start: t.created }];
  const first = ptSessionId(t.providerThreads[0]!);
  return t.providerThreads.map((pt, i) => ({
    thread: t,
    pt,
    sessionId: ptSessionId(pt),
    provider: providerAgent(pt.driver),
    parent: i === 0 ? top : { sessionId: first, type: "provider-switch" },
    start: starts.get(pt.id) ?? t.created,
  }));
}

async function* threadEvents(ctx: NormalizeContext, t: Thread, rows: StoreRows, native: NativeIndex, primary: Map<string, string>, starts: Map<string, number>, since?: number): AsyncIterable<AgentEvent> {
  const plans = plansFor(t, primary, starts);
  for (const p of plans) {
    let events: AgentEvent[] = [];
    const agent = p.pt ? providerAgent(p.pt.driver) : undefined;
    const path = agent && p.pt?.nativeId ? await native.find(agent, unscope(p.pt.nativeId)) : undefined;
    if (path && (agent === "codex" || agent === CLAUDE_AGENT)) events = await convertNative(ctx, agent, path, p.sessionId);
    else if (!path) {
      const mine = (x: { pt?: string }) => (p.pt ? x.pt === p.pt.id || (x.pt === undefined && p === plans[0]) : true);
      events = await storeEvents(ctx, p, { messages: rows.messages.filter(mine), turns: rows.turns.filter(mine), items: rows.items.filter(mine), totals: p === plans[0] ? rows.totals : undefined }, primary);
    }
    events.push(...linkEvents(ctx, p));
    for (const e of events) if (since === undefined || e.ts >= since) yield e;
  }
}

// ---------------------------------------------------------------- v2 store

const hasTable = (db: DatabaseSync, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** Per-thread activity summary (row counts and latest timestamp) for change detection. */
function activity(db: DatabaseSync, sql: string): Map<string, { n: number; t: number }> {
  const out = new Map<string, { n: number; t: number }>();
  try {
    for (const r of db.prepare(sql).all() as Row[]) out.set(String(r.thread_id), { n: num(r.n) ?? 0, t: ms(r.t) ?? 0 });
  } catch {
    // table missing in this schema version
  }
  return out;
}

function readV2Threads(db: DatabaseSync): Thread[] {
  const projects = new Map<string, Row>();
  if (hasTable(db, "projection_projects")) for (const r of db.prepare("SELECT project_id, title, workspace_root FROM projection_projects").all() as Row[]) projects.set(String(r.project_id), r);
  const pts = new Map<string, ProviderThread[]>();
  if (hasTable(db, "orchestration_v2_projection_provider_threads")) {
    for (const r of db.prepare("SELECT * FROM orchestration_v2_projection_provider_threads WHERE thread_id IS NOT NULL ORDER BY COALESCE(first_run_ordinal, 1e9), updated_at").all() as Row[]) {
      const pl = parse(r.payload_json);
      const ref = obj(pl.nativeThreadRef);
      const cost = obj(obj(pl.contextUsage).cost);
      const pt: ProviderThread = {
        id: String(r.provider_thread_id),
        driver: str(r.driver) ?? str(ref.driver) ?? str(pl.driver) ?? str(r.provider) ?? "unknown",
        nativeId: str(ref.nativeId),
        model: str(obj(obj(pl.nativeMetadata).modelSelection).model),
        status: str(r.status),
        updated: ms(r.updated_at) ?? 0,
        costUsd: num(cost.amount) !== undefined && (str(cost.currency) ?? "USD").toUpperCase() === "USD" ? num(cost.amount) : undefined,
      };
      const list = pts.get(String(r.thread_id)) ?? [];
      list.push(pt);
      pts.set(String(r.thread_id), list);
    }
  }
  const out: Thread[] = [];
  for (const r of db.prepare("SELECT * FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL ORDER BY created_at").all() as Row[]) {
    const pl = parse(r.payload_json);
    if (str(pl.deletedAt)) continue;
    const lineage = obj(pl.lineage);
    const project = projects.get(String(r.project_id));
    const created = ms(r.created_at) ?? ms(pl.createdAt) ?? 0;
    out.push({
      id: String(r.thread_id),
      title: str(r.title) ?? str(pl.title),
      project: str(project?.title),
      cwd: str(pl.worktreePath) ?? str(project?.workspace_root),
      model: str(obj(pl.modelSelection).model),
      driver: str(r.default_provider),
      created,
      updated: ms(r.updated_at) ?? created,
      parentThreadId: str(lineage.parentThreadId),
      relation: str(lineage.relationshipToParent),
      providerThreads: pts.get(String(r.thread_id)) ?? [],
    });
  }
  return out;
}

function readV2Rows(db: DatabaseSync, threadId: string, runPt: Map<string, string>): StoreRows {
  const messages: StoreMessage[] = [];
  for (const r of db.prepare("SELECT * FROM orchestration_v2_projection_messages WHERE thread_id = ? AND streaming = 0 ORDER BY created_at, message_id").all(threadId) as Row[]) {
    const pl = parse(r.payload_json);
    const text = str(pl.text);
    if (!text) continue;
    messages.push({ id: String(r.message_id), role: String(r.role), text, ts: ms(r.created_at) ?? 0, pt: r.run_id ? runPt.get(String(r.run_id)) : undefined });
  }
  const turns: StoreTurn[] = [];
  if (hasTable(db, "orchestration_v2_projection_provider_turns")) {
    for (const r of db.prepare("SELECT * FROM orchestration_v2_projection_provider_turns WHERE thread_id = ? ORDER BY provider_thread_id, ordinal").all(threadId) as Row[]) {
      const pl = parse(r.payload_json);
      const status = str(r.status) ?? str(pl.status) ?? "";
      const start = ms(r.started_at) ?? ms(pl.startedAt) ?? 0;
      const done = ITEM_DONE.has(status);
      turns.push({ id: String(r.provider_turn_id), pt: str(r.provider_thread_id), start, end: ms(r.completed_at) ?? ms(pl.completedAt), done, ok: status === "completed", usage: done ? turnUsage(pl.turnTokenUsage) : undefined });
    }
  }
  const items: StoreItem[] = [];
  if (hasTable(db, "orchestration_v2_projection_turn_items")) {
    for (const r of db.prepare("SELECT * FROM orchestration_v2_projection_turn_items WHERE thread_id = ? AND type IN ('command_execution','file_change','dynamic_tool','web_search','file_search','error','compaction','subagent') ORDER BY ordinal").all(threadId) as Row[]) {
      const pl = parse(r.payload_json);
      const status = str(r.status) ?? str(pl.status) ?? "";
      const updated = ms(r.updated_at) ?? 0;
      const start = ms(pl.startedAt) ?? updated;
      const end = ms(pl.completedAt) ?? updated;
      const done = ITEM_DONE.has(status);
      const base = { id: String(r.turn_item_id), pt: str(r.provider_thread_id), start, end: Math.max(start, end), done, ok: status === "completed" };
      const out = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? undefined : JSON.stringify(v));
      switch (r.type) {
        case "command_execution": {
          const failed = (num(pl.exitCode) ?? 0) !== 0 || pl.outputIndicatesFailure === true;
          const cmd = pl.input ?? pl.command;
          items.push({ ...base, kind: "tool", tool: "shell", input: typeof cmd === "string" ? { command: cmd } : cmd, output: out(pl.output), ok: base.ok && !failed });
          break;
        }
        case "file_change":
          items.push({ ...base, kind: "file", path: str(pl.fileName) ?? str(pl.path) ?? str(pl.title), additions: num(pl.additions), deletions: num(pl.deletions), diff: str(pl.diffStr) });
          break;
        case "dynamic_tool":
          items.push({ ...base, kind: "tool", tool: str(pl.toolName) ?? str(pl.title) ?? "tool", input: pl.input, output: out(pl.output) });
          break;
        case "web_search":
        case "file_search":
          items.push({ ...base, kind: "tool", tool: r.type, input: pl.query !== undefined ? { query: pl.query } : (pl.input ?? (str(pl.title) ? { query: pl.title } : undefined)), output: out(pl.output ?? pl.result) });
          break;
        case "error":
          items.push({ ...base, kind: "error", text: str(pl.message) ?? str(pl.text) ?? str(pl.title) });
          break;
        case "compaction":
          items.push({ ...base, kind: "compact" });
          break;
        case "subagent":
          items.push({ ...base, kind: "subagent", text: str(pl.prompt) ?? str(pl.title), childThreadId: str(pl.childThreadId) });
          break;
      }
    }
  }
  return { messages, turns, items };
}

// ---------------------------------------------------------------- v1 store

const V1_CLAUDE = /^claude/i;

function readV1Threads(db: DatabaseSync, skip: Set<string>): { thread: Thread; v1: true }[] {
  if (!hasTable(db, "projection_threads")) return [];
  const projects = new Map<string, Row>();
  if (hasTable(db, "projection_projects")) for (const r of db.prepare("SELECT project_id, title, workspace_root FROM projection_projects").all() as Row[]) projects.set(String(r.project_id), r);
  const sessions = new Map<string, Row>();
  if (hasTable(db, "projection_thread_sessions")) for (const r of db.prepare("SELECT * FROM projection_thread_sessions").all() as Row[]) sessions.set(String(r.thread_id), r);
  const runtime = new Map<string, Row>();
  if (hasTable(db, "provider_session_runtime")) for (const r of db.prepare("SELECT * FROM provider_session_runtime").all() as Row[]) runtime.set(String(r.thread_id), r);
  const out: { thread: Thread; v1: true }[] = [];
  for (const r of db.prepare("SELECT * FROM projection_threads WHERE deleted_at IS NULL ORDER BY created_at").all() as Row[]) {
    const id = String(r.thread_id);
    if (skip.has(id)) continue;
    const sel = parse(r.model_selection_json);
    const s = sessions.get(id);
    const rt = runtime.get(id);
    const providerName = str(s?.provider_name) ?? str(rt?.provider_name) ?? str(sel.provider) ?? str(sel.instanceId);
    const driver = providerName ? (V1_CLAUDE.test(providerName) ? "claudeAgent" : providerName) : undefined;
    const cursor = parse(rt?.resume_cursor_json);
    const nativeId = str(s?.provider_thread_id) ?? str(cursor.threadId) ?? str(cursor.resume) ?? str(cursor.sessionId);
    const project = projects.get(String(r.project_id));
    const created = ms(r.created_at) ?? 0;
    const updated = ms(r.updated_at) ?? created;
    const thread: Thread = { id, title: str(r.title), project: str(project?.title), cwd: str(r.worktree_path) ?? str(project?.workspace_root), model: str(sel.model), driver, created, updated, providerThreads: [] };
    if (driver && nativeId) thread.providerThreads.push({ id: `v1:${id}`, driver, nativeId, model: str(sel.model), updated });
    out.push({ thread, v1: true });
  }
  return out;
}

function readV1Rows(db: DatabaseSync, threadId: string): StoreRows {
  const messages: StoreMessage[] = [];
  for (const r of db.prepare("SELECT * FROM projection_thread_messages WHERE thread_id = ? AND is_streaming = 0 ORDER BY created_at, message_id").all(threadId) as Row[]) {
    const text = str(r.text);
    if (text) messages.push({ id: String(r.message_id), role: String(r.role), text, ts: ms(r.created_at) ?? 0 });
  }
  const turns: StoreTurn[] = [];
  if (hasTable(db, "projection_turns")) {
    for (const r of db.prepare("SELECT * FROM projection_turns WHERE thread_id = ? AND turn_id IS NOT NULL ORDER BY requested_at").all(threadId) as Row[]) {
      const state = str(r.state) ?? "";
      const end = ms(r.completed_at);
      turns.push({ id: String(r.turn_id), start: ms(r.started_at) ?? ms(r.requested_at) ?? 0, end, done: end !== undefined, ok: state === "completed" });
    }
  }
  const items: StoreItem[] = [];
  const tools = new Map<string, StoreItem>();
  let totals: Usage | undefined;
  if (hasTable(db, "projection_thread_activities")) {
    for (const r of db.prepare("SELECT * FROM projection_thread_activities WHERE thread_id = ? ORDER BY COALESCE(sequence, 0), created_at, activity_id").all(threadId) as Row[]) {
      const kind = String(r.kind);
      const pl = parse(r.payload_json);
      const ts = ms(r.created_at) ?? 0;
      if (kind.startsWith("tool.")) {
        const id = str(pl.toolCallId) ?? String(r.activity_id);
        const data = obj(pl.data);
        let it = tools.get(id);
        if (!it) {
          it = { id, kind: "tool", tool: str(data.toolName) ?? str(pl.itemType) ?? str(pl.title) ?? "tool", input: data.input ?? (str(pl.detail) ? { detail: pl.detail } : undefined), done: false, ok: true, start: ts, end: ts };
          tools.set(id, it);
          items.push(it);
        }
        it.end = ts;
        if (kind === "tool.completed") {
          it.done = true;
          it.ok = str(pl.status) !== "failed" && r.tone !== "error";
          it.output = str(pl.detail);
        }
      } else if (kind === "runtime.error") {
        items.push({ id: String(r.activity_id), kind: "error", text: str(r.summary) ?? str(pl.message), done: true, ok: false, start: ts, end: ts });
      } else if (kind === "context-compaction") {
        items.push({ id: String(r.activity_id), kind: "compact", done: true, ok: true, start: ts, end: ts });
      } else if (kind === "context-window.updated") {
        // Running totals (v1 has no per-turn usage): the latest snapshot wins, here and in buildSession.
        const input = num(pl.inputTokens);
        const cached = num(pl.cachedInputTokens) ?? 0;
        const output = num(pl.outputTokens);
        if (input !== undefined || output !== undefined) {
          totals = {};
          if (input !== undefined) totals.inputTokens = Math.max(0, input - cached);
          if (cached) totals.cacheReadTokens = cached;
          if (output !== undefined) totals.outputTokens = output;
        }
      }
    }
  }
  return { messages, turns, items, totals };
}

// ---------------------------------------------------------------- backfill

/** Size/mtime summary over the store files, for the whole-store unchanged check. */
function storeFingerprint(dir: string, dbs: string[]): BackfillFile {
  let size = 0;
  let mtimeMs = 0;
  for (const db of dbs) {
    for (const f of [db, `${db}-wal`]) {
      const s = statOf(f);
      size += s.size;
      mtimeMs = Math.max(mtimeMs, s.mtimeMs);
    }
  }
  return { path: join(dir, "#store"), size, mtimeMs };
}

async function threadFile(native: NativeIndex, dbPath: string, t: Thread, act: { n: number; t: number }[]): Promise<BackfillFile> {
  let size = t.providerThreads.length;
  let mtimeMs = t.updated;
  for (const a of act) {
    size += a.n;
    mtimeMs = Math.max(mtimeMs, a.t);
  }
  for (const pt of t.providerThreads) {
    mtimeMs = Math.max(mtimeMs, pt.updated);
    const agent = providerAgent(pt.driver);
    // Only transcripts this adapter converts count; linked stores are their adapter's to watch.
    if (!pt.nativeId || (agent !== "codex" && agent !== CLAUDE_AGENT)) continue;
    const s = statOf(await native.find(agent, unscope(pt.nativeId)));
    size += s.size;
    mtimeMs = Math.max(mtimeMs, s.mtimeMs);
  }
  return { path: `${dbPath}#${t.id}`, size, mtimeMs: Math.floor(mtimeMs) };
}

export async function* backfillT3(ctx: NormalizeContext, opts: BackfillOpts = {}, env: NodeJS.ProcessEnv = process.env): AsyncIterable<AgentEvent> {
  const dir = t3UserData(env);
  const v2Path = join(dir, "statev2.sqlite");
  const v1Path = join(dir, "state.sqlite");
  if (!existsSync(v2Path) && !existsSync(v1Path)) return;
  if (opts.changed && !(await opts.changed(storeFingerprint(dir, [v2Path, v1Path])))) return;
  const native = new NativeIndex(env);
  const v2 = await openSqliteCopy(v2Path);
  const v1 = await openSqliteCopy(v1Path);
  try {
    // Threads from both stores first, so subagent and provider-switch edges resolve across them.
    const all: { thread: Thread; db: DatabaseSync; path: string; v1: boolean }[] = [];
    const runPt = new Map<string, string>();
    const starts = new Map<string, number>();
    const acts: Map<string, { n: number; t: number }>[] = [];
    if (v2 && hasTable(v2.db, "orchestration_v2_projection_threads")) {
      for (const t of readV2Threads(v2.db)) all.push({ thread: t, db: v2.db, path: v2Path, v1: false });
      if (hasTable(v2.db, "orchestration_v2_projection_runs")) {
        for (const r of v2.db.prepare("SELECT run_id, provider_thread_id, requested_at FROM orchestration_v2_projection_runs WHERE provider_thread_id IS NOT NULL ORDER BY ordinal").all() as Row[]) {
          const pt = String(r.provider_thread_id);
          runPt.set(String(r.run_id), pt);
          const at = ms(r.requested_at);
          if (at !== undefined && !starts.has(pt)) starts.set(pt, at);
        }
      }
      acts.push(
        activity(v2.db, "SELECT thread_id, COUNT(*) n, MAX(updated_at) t FROM orchestration_v2_projection_messages GROUP BY thread_id"),
        activity(v2.db, "SELECT thread_id, COUNT(*) n, MAX(updated_at) t FROM orchestration_v2_projection_turn_items GROUP BY thread_id"),
        activity(v2.db, "SELECT thread_id, COUNT(*) n, MAX(COALESCE(completed_at, started_at)) t FROM orchestration_v2_projection_provider_turns GROUP BY thread_id"),
      );
    }
    if (v1) {
      const known = new Set(all.map((x) => x.thread.id));
      for (const { thread } of readV1Threads(v1.db, known)) all.push({ thread, db: v1.db, path: v1Path, v1: true });
      acts.push(
        activity(v1.db, "SELECT thread_id, COUNT(*) n, MAX(updated_at) t FROM projection_thread_messages GROUP BY thread_id"),
        activity(v1.db, "SELECT thread_id, COUNT(*) n, MAX(created_at) t FROM projection_thread_activities GROUP BY thread_id"),
      );
    }
    const primary = new Map(all.map((x) => [x.thread.id, primaryOf(x.thread)]));
    for (const { thread, db, path, v1: old } of all) {
      if (opts.changed) {
        const act = acts.map((m) => m.get(thread.id)).filter((a): a is { n: number; t: number } => a !== undefined);
        if (!(await opts.changed(await threadFile(native, path, thread, act)))) continue;
      }
      let rows: StoreRows;
      try {
        rows = old ? readV1Rows(db, thread.id) : readV2Rows(db, thread.id, runPt);
      } catch {
        continue; // schema drift in one thread's rows: skip it, keep the rest
      }
      yield* threadEvents(ctx, thread, rows, native, primary, starts, opts.since);
    }
  } finally {
    v2?.close();
    v1?.close();
  }
}

// ---------------------------------------------------------------- adapter

function appInstalled(env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== "darwin") return false;
  for (const root of ["/Applications", join(userHome(env), "Applications")]) {
    try {
      if (readdirSync(root).some((n) => /^T3 Code.*\.app$/.test(n))) return true;
    } catch {
      // no such dir
    }
  }
  return false;
}

export const t3code: Adapter = {
  id: T3_AGENT,
  displayName: "T3 Code",
  tier: "B",

  async detect() {
    const env = process.env;
    const dir = t3UserData(env);
    const store = existsSync(join(dir, "statev2.sqlite")) || existsSync(join(dir, "state.sqlite"));
    const installed = existsSync(dir) || appInstalled(env);
    const r: Awaited<ReturnType<Adapter["detect"]>> = { installed, hooked: store };
    if (existsSync(t3Home(env))) r.configDir = t3Home(env);
    try {
      const v = readFileSync(join(dir, "desktop-last-started-version"), "utf8").trim();
      if (/^[\w.+-]{1,40}$/.test(v)) r.version = v;
    } catch {
      // version unknown
    }
    if (installed) {
      const codexHooked = hasOurHooks("codex", join(codexHome(env), "hooks.json"));
      const claudeHooked = hasOurHooks(CLAUDE_AGENT, join(claudeConfigDir(env), "settings.json"));
      if (!codexHooked || !claudeHooked) r.notes = [`history imports from T3's store; live capture of its ${[!codexHooked && "Codex", !claudeHooked && "Claude"].filter(Boolean).join(" and ")} runs needs: coding.sh init --agent ${[!codexHooked && "codex", !claudeHooked && "claude-code"].filter(Boolean).join(" --agent ")}`];
    }
    return r;
  },

  // Nothing to install: T3 runs Codex and Claude Code, whose hooks do the live capture.
  async install() {
    return [];
  },
  async uninstall() {
    return [];
  },

  // T3 writes no hook lines of its own; spool lines it causes arrive as codex/claude-code.
  async normalize() {
    return [];
  },

  backfill: (ctx, opts) => backfillT3(ctx, opts),
  // Codex/Claude runs come in through their hooks, but T3's other providers and
  // the attribution links exist only in its store: keep it imported on every read.
  tail: () => existsSync(join(t3UserData(), "statev2.sqlite")) || existsSync(join(t3UserData(), "state.sqlite")),
};
