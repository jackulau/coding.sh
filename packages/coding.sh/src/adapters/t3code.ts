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
// Both are read in place, read-only, while T3 Code has them open in WAL mode, and otherwise from
// copies (more/_util.ts openSqliteInPlace); a thread's rows are read in one short read transaction.
//
// Sessions: one per provider thread, keyed by the provider's native id, so a
// T3-run Codex rollout or Claude transcript is the same session the codex and
// claude-code adapters import (no duplicates):
//   - Codex/Claude transcript on disk: converted with their own converters, so
//     event ids match whichever adapter imports it first.
//   - OpenCode/Cursor/Pi session in that agent's store: link only (its adapter imports it).
//   - otherwise: built from T3's store (messages, tool items, per-turn usage).
// T3's requests to the user (approvals and questions: runtime requests and their
// approval_request/user_input_request items) are notifications with a requestId in
// every session, open until T3 resolves them (core/waiting.ts host requests).
// Every session also gets a "host-link" notification with payload.via =
// "t3code"; buildSession then sets agent "t3code" and provider = the agent T3 ran.
// A user-role message an agent made (a provider's prompt, an MCP tool, a notification,
// another thread) is not the person's prompt. In a session built from the store it is a
// user.message with from: "agent". A Codex or Claude transcript does not say who made a
// prompt, and the codex and claude-code adapters may store its events first: a transcript
// prompt that is such a message gets a marker notification before it (agentPromptMarks,
// core/waiting.ts HOST_AGENT_PROMPT). The host link of a thread a person started (its first
// prompt is the person's) says launch "interactive", except in a session another adapter
// imports (OpenCode, Cursor, Pi): its prompts are not read here, so an agent's would count as
// the person's.
// A thread's first provider thread is top level; later ones (provider switch)
// and T3 subagent threads are child sessions. Threads that never reached a
// provider are `t3code-<threadId>`.
//
// Live capture: T3's Codex and Claude runs fire the codex/claude-code hooks.
// The hook stamps T3's env marker (spool/host.ts), and T3-originated rollouts
// say so in session_meta.originator (codex.ts).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { userHome } from "../core/paths.ts";
import type { Adapter, BackfillFile, BackfillOpts, NormalizeContext } from "../core/types.ts";
import type { AgentEvent, Usage } from "../schema/index.ts";
import { HOST_AGENT_PROMPT, HOST_MARK_SLACK_MS, HOST_QUESTION, HOST_RESOLVED } from "../core/waiting.ts";
import { T3_AGENT } from "../spool/host.ts";
import { ClaudeTranscriptConverter, Emitter, blobList, childSessionId, clipText, clipValue, emitDerived, hasOurHooks, num, obj, parentLink, readJsonl, str, toMs, usageSnapshotKey, walkFiles } from "./_shared/index.ts";
import { CLAUDE_AGENT, TRANSCRIPT_IDLE_MS, claudeConfigDir } from "./claude-code.ts";
import { ROLLOUT_IDLE_MS, codeModeCellOk, codexHome, convertRollout } from "./codex.ts";
import { cursorConfigDir } from "./cursor.ts";
import { openSqliteCopy, openSqliteInPlace, readSnapshot, sqliteShapeError, type FreeSpace } from "./more/_util.ts";
import { reapSqliteCopies } from "./_shared/sqlite-copies.ts";
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
/** Driver kinds a provider instance id can start with ("claudeHub", "codex-work"), and their agent. */
const DRIVER_PREFIX: [string, string][] = [["claude", CLAUDE_AGENT], ["codex", "codex"], ["cursor", "cursor"], ["opencode", "opencode"], ["pi", "pi"]];

/**
 * The coding.sh agent for a T3 driver or provider instance id: an exact driver kind first, else
 * the agent whose driver kind the id starts with (case-insensitive: a "claudeHub" instance runs
 * Claude Code), else the id as T3 names it.
 */
export function providerAgent(driver: string): string {
  const exact = Object.hasOwn(DRIVER_AGENT, driver) ? DRIVER_AGENT[driver] : undefined;
  if (exact) return exact;
  const lower = driver.toLowerCase();
  return DRIVER_PREFIX.find(([kind]) => lower.startsWith(kind))?.[1] ?? driver;
}

/**
 * The provider's own session id from a T3 native id. ACP instance-scoped ids carry a
 * "provider-instance:<name>:" prefix; Pi's is its session file path (…/<time>_<id>.jsonl).
 */
const unscope = (id: string): string => {
  const bare = id.replace(/^provider-instance:[^:]+:/, "");
  return (/[\\/]/.test(bare) && /_([^_\\/]+)\.jsonl$/.exec(bare)?.[1]) || bare;
};

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
  /** A Workflow-tool run (projection_subagents): the run thread has its runId; each agent thread also has its agentId. */
  workflow?: { runId: string; agentId?: string };
}

interface StoreMessage {
  id: string;
  role: string;
  text: string;
  ts: number;
  /** Provider thread it belongs to, when known. */
  pt?: string;
  /** Who made it, when the store says (v2: createdBy, creationSource and the fields an agent's message carries). */
  by?: "user" | "agent";
}

interface StoreTurn {
  id: string;
  pt?: string;
  start: number;
  end?: number;
  done: boolean;
  ok: boolean;
  usage?: Usage;
  /** The model the turn ran on (provider_turns payload.model). */
  model?: string;
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

/** A request T3 put to the user: an approval (command, file change, permission) or a question. */
interface StoreRequest {
  id: string;
  pt?: string;
  kind: "permission" | "question";
  /** T3's kind: command, file-change, file-read, permission, mcp-elicitation or user_input. */
  requestKind: string;
  tool?: string;
  text?: string;
  start: number;
  /** When it was answered, refused or dropped. */
  end?: number;
  open: boolean;
}

interface StoreRows {
  messages: StoreMessage[];
  turns: StoreTurn[];
  items: StoreItem[];
  /** v2 only: requests to the user. */
  requests?: StoreRequest[];
  /** v1 only: thread totals (no per-turn usage in v1). */
  totals?: Usage;
}

/** A thread's title, unless it is T3's placeholder for a thread it has not named yet. */
const threadTitle = (v: unknown): string | undefined => {
  const t = str(v)?.trim();
  return t && !/^new thread$/i.test(t) ? t : undefined;
};

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

  /**
   * The transcript of a native session. `cwd` is a hint: Claude Code keeps a transcript under
   * projects/<cwd slug>/, so it is looked for there first. Listing every project dir (tens of
   * thousands on a long-used machine) is the fallback, and blocks for seconds.
   */
  find(agent: string, id: string, cwd?: string): Promise<string | undefined> {
    if (agent === CLAUDE_AGENT && cwd) {
      const direct = join(claudeConfigDir(this.env), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
      if (existsSync(direct)) return Promise.resolve(direct);
    }
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
          // 2.x keeps sessions in session_v2, 1.x in session.
          const table = hasTable(h.db, "session_v2") ? "session_v2" : hasTable(h.db, "session") ? "session" : undefined;
          if (table) for (const r of h.db.prepare(`SELECT id FROM ${table}`).all() as Row[]) if (str(r.id)) out.set(r.id as string, db);
        } catch {
          // unreadable OpenCode schema: treat as not found
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

// ---------------------------------------------------------------- covered subagents

/** Last segment of a T3 thread id: the Claude agent id of a subagent thread (ids are percent-encoded, so ":" may be "%3A"). */
const threadTail = (id: string): string => id.split(/%3A|:/i).pop() ?? id;

/** An id that is safe as one path segment (a workflow run id, a Claude agent id), else undefined. */
const safeId = (v: unknown): string | undefined => (typeof v === "string" && /^[\w.-]+$/.test(v) && !/^\.+$/.test(v) ? v : undefined);

/** A covered thread: the claude-code session that is its run (when it has one), and the session a stale copy of it belongs to. */
interface Coverage {
  sessionId?: string;
  owner: string;
}

/**
 * Subagent threads of a Claude session whose run the claude-code adapter already stores as
 * `<root>:sub:<agentId>` (from <root>/subagents/agent-<id>.jsonl, or
 * <root>/subagents/workflows/<runId>/agent-<id>.jsonl for a Workflow-tool agent). Storing them again
 * as t3code sessions doubles the tree. A root is any Claude provider thread of the parent (of the
 * run's parent, for a workflow agent): a resumed conversation gets a new provider thread, and the
 * subagent's file sits under the transcript that ran it. Covered:
 *   - a direct subagent whose agent file is under a root;
 *   - a workflow run thread whose run directory is under a root;
 *   - a workflow agent whose agent file is in that run directory (its run is that file's session) or,
 *     failing that, a numbered child of a subagent thread whose root has a workflows directory.
 */
async function coveredThreads(all: Thread[], native: NativeIndex): Promise<Map<string, Coverage>> {
  const byId = new Map(all.map((t) => [t.id, t]));
  const out = new Map<string, Coverage>();
  const roots = new Map<string, { dir: string; sid: string }[]>();
  const rootDirs = async (t: Thread): Promise<{ dir: string; sid: string }[]> => {
    let list = roots.get(t.id);
    if (list) return list;
    list = [];
    for (const pt of t.providerThreads) {
      if (!pt.nativeId || providerAgent(pt.driver) !== CLAUDE_AGENT) continue;
      const sid = unscope(pt.nativeId);
      const path = await native.find(CLAUDE_AGENT, sid, t.cwd);
      if (path) list.push({ dir: join(dirname(path), sid, "subagents"), sid });
    }
    roots.set(t.id, list);
    return list;
  };
  const under = async (t: Thread, ...rel: string[]) => (await rootDirs(t)).find((r) => existsSync(join(r.dir, ...rel)));
  const child = (sid: string, agentId: string): Coverage => ({ sessionId: childSessionId(sid, agentId), owner: childSessionId(sid, agentId) });
  for (const t of all) {
    if (t.relation !== "subagent" || !t.parentThreadId || t.providerThreads.length) continue;
    const parent = byId.get(t.parentThreadId);
    if (!parent) continue;
    const tail = safeId(threadTail(t.id));
    if (parent.relation !== "subagent") {
      if (t.workflow && !t.workflow.agentId) {
        const r = await under(parent, "workflows", t.workflow.runId);
        if (r) out.set(t.id, { owner: r.sid });
      } else if (tail) {
        const r = await under(parent, `agent-${tail}.jsonl`);
        if (r) out.set(t.id, child(r.sid, tail));
      }
      continue;
    }
    const grand = parent.parentThreadId ? byId.get(parent.parentThreadId) : undefined;
    if (!grand || grand.relation === "subagent") continue;
    const wf = t.workflow;
    const file = wf?.agentId ? await under(grand, "workflows", wf.runId, `agent-${wf.agentId}.jsonl`) : undefined;
    if (file) out.set(t.id, child(file.sid, wf!.agentId!));
    else if (tail && /^\d+$/.test(tail)) {
      const r = await under(grand, "workflows");
      if (r) out.set(t.id, { owner: r.sid });
    }
  }
  return out;
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

/** Codex's Code Mode cell tool, alone or under a namespace. */
const CODEX_EXEC = /^(?:.+\.)?exec$/;
/** A tool request that reached its provider after the turn it belonged to had ended: stopped, not failed. */
const STALE_REQUEST = /has no active turn for this tool request/;

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
    // A user-role message an agent made is not the person's prompt (core/wait-stats.ts).
    const from = m.role === "user" && m.by === "agent" ? "agent" : undefined;
    em.emit(m.role === "user" ? "user.message" : "assistant.message", { text: c.value, truncated: c.truncated || undefined, from }, { key: [m.id], ts: m.ts, blobs: blobList(c.blob) });
    last = Math.max(last, m.ts);
  }
  for (const tu of rows.turns) {
    if (tu.done || tu.usage) {
      // T3 leaves the provider thread's model empty for many runs; each turn names the model it ran on.
      const m = tu.model ?? model;
      em.emit("llm.call", { provider: p.provider, responseModel: m, ok: tu.ok, providerTurnId: tu.id }, { key: [tu.id], ts: tu.start, model: m, durationMs: tu.end !== undefined ? Math.max(0, tu.end - tu.start) : undefined, usage: tu.usage });
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
      // A Codex exec cell is judged as the codex adapter judges it, not by T3's status; a stale tool request was stopped.
      const interrupted = it.kind === "tool" && STALE_REQUEST.test(it.output ?? "");
      const ok = interrupted ? false : it.kind === "tool" && p.provider === "codex" && CODEX_EXEC.test(it.tool ?? "") ? (codeModeCellOk(it.output) ?? it.ok) : it.ok;
      const o = await clipText(ctx, it.output ?? "");
      em.emit("tool.end", { tool, toolUseId: it.id, ok, durationMs: it.end - it.start, output: o.value || undefined, interrupted: interrupted || undefined }, { key: [it.id], ts: it.end, durationMs: it.end - it.start, blobs: blobList(o.blob) });
      if (it.kind === "file" && it.path && it.ok) {
        const d = it.diff ? await clipText(ctx, it.diff, 2560) : undefined;
        em.emit("file.change", { path: it.path, op: "modify", additions: it.additions, deletions: it.deletions, tool, toolUseId: it.id, diff: d?.value, diffTruncated: d?.truncated || undefined }, { key: [it.id, it.path], ts: it.end, blobs: blobList(d?.blob) });
      } else if (it.kind === "tool") {
        await emitDerived(em, { tool, toolUseId: it.id, input: it.input, output: it.output, ok, cwd: t.cwd, extra: { ts: it.end } });
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

/** What a request with no prompt of its own asks for, by T3's request kind. */
const REQUEST_WORDS: Record<string, string> = {
  command: "approve a command",
  "file-change": "approve a file change",
  "file-read": "approve a file read",
  permission: "grant a permission",
  "mcp-elicitation": "answer an MCP server's request",
  user_input: "answer a question",
};

/**
 * T3's requests to the user as host-request notifications (core/waiting.ts): one when it was put,
 * and one when it was resolved. A request still open blocks the session on the user.
 */
function requestEvents(ctx: NormalizeContext, p: SessionPlan, requests: StoreRequest[]): AgentEvent[] {
  if (!requests.length) return [];
  const t = p.thread;
  const em = new Emitter(ctx, { agent: T3_AGENT, sessionId: p.sessionId, ts: p.start, cwd: t.cwd, model: p.pt?.model ?? t.model }, ["t3", p.sessionId, "request"]);
  for (const r of requests) {
    const text = (r.text ?? REQUEST_WORDS[r.requestKind] ?? `answer a ${r.requestKind} request`).slice(0, 2000);
    em.emit("notification", { type: r.kind === "question" ? HOST_QUESTION : "permission_prompt", via: T3_AGENT, requestId: r.id, requestKind: r.requestKind, tool: r.tool, text }, { key: [r.id], ts: r.start });
    if (!r.open) em.emit("notification", { type: HOST_RESOLVED, via: T3_AGENT, requestId: r.id, requestKind: r.requestKind }, { key: [r.id, "resolved"], ts: Math.max(r.start, r.end ?? r.start) });
  }
  return em.events;
}

/**
 * The notification that attributes a session to T3 Code, plus the edge to its parent. `launch` is
 * "interactive" for a thread a person started (personStarted) whose prompts are read here, from the
 * store or a Codex or Claude transcript; the session's launch is then the host's, not the one its
 * agent's start names (T3 drives Claude Code through the Agent SDK).
 */
function linkEvents(ctx: NormalizeContext, p: SessionPlan, launch?: "interactive"): AgentEvent[] {
  const t = p.thread;
  const em = new Emitter(ctx, { agent: T3_AGENT, sessionId: p.sessionId, ts: p.start, cwd: t.cwd, model: p.pt?.model ?? t.model }, ["t3", p.sessionId, "link"]);
  // The thread title titles the session (core/sessions.ts) and names the thread in show.
  const title = t.title?.slice(0, 280);
  const message = title ? `T3 Code thread: ${title}` : "T3 Code thread";
  em.emit("notification", { type: "host-link", via: T3_AGENT, provider: p.provider, t3ThreadId: t.id, t3ProviderThreadId: p.pt?.id, title, project: t.project, message, launch }, { key: ["host-link"] });
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

/**
 * A thread a person started: its first user-role message is the person's (v2 createdBy "user"), and it is
 * not a subagent's thread. A v1 store, or a v2 message that does not say who made it, does not tell.
 */
function personStarted(t: Thread, rows: StoreRows): boolean {
  return t.relation !== "subagent" && rows.messages.find((m) => m.role === "user")?.by === "user";
}

/** Whitespace-folded text: a store message and the transcript prompt it became compare in this form. */
const foldText = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Markers (HOST_AGENT_PROMPT) for the prompts of a Codex or Claude transcript that T3's store says an agent made:
 * the transcript does not say who made a prompt. Each main-thread prompt, in time order, is the store message with
 * its text (a clipped prompt: a text that starts with the kept part) that was sent at or before it, the latest such
 * (T3 sends a queued message when the turn before ends), else the first sent up to HOST_MARK_SLACK_MS after it. A
 * message is matched once. A marker is stamped more than HOST_MARK_SLACK_MS before its prompt, so it comes before a
 * live copy of the prompt too, and only after the session's start (its host link): a first prompt ends no wait.
 */
function agentPromptMarks(ctx: NormalizeContext, p: SessionPlan, events: AgentEvent[], messages: StoreMessage[]): AgentEvent[] {
  if (!messages.some((m) => m.role === "user" && m.by === "agent")) return [];
  const pool = messages.filter((m) => m.role === "user").map((m) => ({ m, text: foldText(m.text) }));
  const prompts = events.filter((e) => e.kind === "user.message" && e.sessionId === p.sessionId && !e.subagentId && typeof e.payload.text === "string").sort((a, b) => a.ts - b.ts);
  const em = new Emitter(ctx, { agent: T3_AGENT, sessionId: p.sessionId, ts: p.start, cwd: p.thread.cwd }, ["t3", p.sessionId, "by"]);
  for (const e of prompts) {
    const raw = e.payload.text as string;
    const clipped = e.payload.truncated === true;
    const text = foldText(clipped && raw.endsWith("…") ? raw.slice(0, -1) : raw);
    if (!text) continue;
    const same = (c: { text: string }) => (clipped ? c.text.startsWith(text) : c.text === text);
    let pick: number | undefined;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      if (c.m.ts <= e.ts && same(c) && (pick === undefined || c.m.ts >= pool[pick]!.m.ts)) pick = i;
    }
    for (let i = 0; pick === undefined && i < pool.length; i++) {
      const c = pool[i]!;
      if (c.m.ts > e.ts && c.m.ts <= e.ts + HOST_MARK_SLACK_MS && same(c)) pick = i;
    }
    if (pick === undefined) continue;
    const { m } = pool.splice(pick, 1)[0]!;
    const ts = e.ts - HOST_MARK_SLACK_MS - 1;
    if (m.by !== "agent" || ts <= p.start) continue;
    em.emit("notification", { type: HOST_AGENT_PROMPT, via: T3_AGENT, promptId: e.id, at: e.ts, message: "T3 Code: an agent sent the next prompt" }, { key: ["by", m.id], ts });
  }
  return em.events;
}

/** `whole` is called once every session of the thread was yielded, none left out by the window. */
async function* threadEvents(ctx: NormalizeContext, t: Thread, rows: StoreRows, native: NativeIndex, primary: Map<string, string>, starts: Map<string, number>, since?: number, whole?: () => void): AsyncIterable<AgentEvent> {
  const plans = plansFor(t, primary, starts);
  const person = personStarted(t, rows);
  let cut = false;
  for (const p of plans) {
    let events: AgentEvent[] = [];
    const agent = p.pt ? providerAgent(p.pt.driver) : undefined;
    const path = agent && p.pt?.nativeId ? await native.find(agent, unscope(p.pt.nativeId), t.cwd) : undefined;
    const mine = (x: { pt?: string }) => (p.pt ? x.pt === p.pt.id || (x.pt === undefined && p === plans[0]) : true);
    // Whether an agent's prompts are told from the person's here: in a session another adapter imports they are not.
    let told = true;
    if (path && (agent === "codex" || agent === CLAUDE_AGENT)) {
      events = await convertNative(ctx, agent, path, p.sessionId);
      // Every message of the thread: a transcript can hold prompts sent under an earlier provider thread (a fork).
      events.push(...agentPromptMarks(ctx, p, events, rows.messages));
    } else if (!path) {
      events = await storeEvents(ctx, p, { messages: rows.messages.filter(mine), turns: rows.turns.filter(mine), items: rows.items.filter(mine), totals: p === plans[0] ? rows.totals : undefined }, primary);
    } else told = false;
    events.push(...linkEvents(ctx, p, person && told ? "interactive" : undefined), ...requestEvents(ctx, p, rows.requests?.filter(mine) ?? []));
    // A session with activity inside the window is imported whole, as the codex and claude-code backfills do:
    // cutting it at `since` dropped the host-link (stamped at the thread's start), so a session begun before the
    // cutoff lost its T3 attribution and thread title.
    if (since === undefined || events.some((e) => e.ts >= since)) yield* events;
    else if (events.length) cut = true;
  }
  if (!cut) whole?.();
}

// ---------------------------------------------------------------- v2 store

const hasTable = (db: DatabaseSync, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/**
 * What a v2 thread's change check reads besides its row: each query gives a thread a number `n` (a row count, or its
 * newest event's sequence) and, for rows that change in place, their newest time `t`. The check (`threadFile`) adds
 * up the numbers, the thread's provider threads and the sizes of its transcripts. T3 Code deletes no messages or turn
 * items, and a thread's newest event sequence grows with each write to the thread, so a write changes the sum unless
 * another part falls by exactly as much before the next check: for example, a transcript's size drops to 0 when its
 * file is deleted, or a provider thread moves to another thread.
 */
export const V2_ACTIVITY = {
  // Counts only, which an index on thread_id answers. T3 Code sets a thread's updated_at with each message or turn
  // item it writes, so an edit in place changes the thread row, unless a command then writes back an updated_at it
  // read before the edit: `events` catches that. A row's own updated_at sits beside its payload: reading it read the
  // whole turn items table on every pass.
  messages: "SELECT thread_id, COUNT(*) n FROM orchestration_v2_projection_messages GROUP BY thread_id",
  turnItems: "SELECT thread_id, COUNT(*) n FROM orchestration_v2_projection_turn_items GROUP BY thread_id",
  providerTurns: "SELECT thread_id, COUNT(*) n, MAX(COALESCE(completed_at, started_at)) t FROM orchestration_v2_projection_provider_turns GROUP BY thread_id",
  // A request that resolves changes its row, not the row count: it counts twice once it is no longer pending.
  runtimeRequests: "SELECT thread_id, COUNT(*) + SUM(status <> 'pending') n, MAX(COALESCE(resolved_at, created_at)) t FROM orchestration_v2_projection_runtime_requests GROUP BY thread_id",
  // A thread's newest event, one index seek a thread. T3 Code appends an event in the same transaction as each write
  // to a thread's rows, and its pruning keeps each thread's newest event, so the sequence only grows.
  events: "SELECT t.thread_id, (SELECT MAX(e.sequence) FROM orchestration_events e WHERE e.aggregate_kind = 'thread' AND e.stream_id = t.thread_id) n FROM orchestration_v2_projection_threads t",
};

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
      title: threadTitle(r.title) ?? threadTitle(pl.title),
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
  const workflows = readV2Workflows(db);
  for (const t of out) t.workflow = workflows.get(t.id);
  return out;
}

/** Workflow-tool runs from projection_subagents: run thread id to {runId}, agent thread id to {runId, agentId}. */
function readV2Workflows(db: DatabaseSync): Map<string, { runId: string; agentId?: string }> {
  const out = new Map<string, { runId: string; agentId?: string }>();
  if (!hasTable(db, "orchestration_v2_projection_subagents")) return out;
  try {
    // Parsed here rather than with json_extract: one malformed payload fails a JSON query.
    for (const r of db.prepare(`SELECT child_thread_id, payload_json FROM orchestration_v2_projection_subagents WHERE child_thread_id IS NOT NULL AND payload_json LIKE '%"workflow"%'`).all() as Row[]) {
      const wf = obj(parse(r.payload_json).workflow);
      const handles = obj(wf.runHandles);
      const runId = safeId(handles.runId) ?? safeId(str(handles.transcriptDir)?.split(/[\\/]/).filter(Boolean).pop());
      if (!runId) continue;
      out.set(String(r.child_thread_id), { runId });
      for (const a of Array.isArray(wf.agents) ? wf.agents : []) {
        const agent = obj(a);
        const thread = str(agent.childThreadId);
        const agentId = safeId(agent.agentId);
        if (thread && agentId) out.set(thread, { runId, agentId });
      }
    }
  } catch {
    // columns differ in this store version
  }
  return out;
}

/** creationSource values of a message an agent made: a provider's own prompt (a subagent's task), an MCP tool, T3's server. */
const AGENT_SOURCES = new Set(["provider", "mcp", "server"]);
/** Payload fields only an agent's message carries: another thread sent it, a notification, a delegated result, a workflow step. */
const AGENT_FIELDS = ["senderThreadId", "notification", "delegatedCompletion", "workflowScript"];

/** Who made a v2 message, from its payload: "agent" when any field says an agent did, "user" when createdBy says so, else unknown. */
function messageBy(pl: Row): "user" | "agent" | undefined {
  if (pl.createdBy === "agent" || AGENT_SOURCES.has(str(pl.creationSource) ?? "") || AGENT_FIELDS.some((k) => pl[k] !== undefined && pl[k] !== null)) return "agent";
  return pl.createdBy === "user" ? "user" : undefined;
}

function readV2Rows(db: DatabaseSync, threadId: string, runPt: Map<string, string>): StoreRows {
  const messages: StoreMessage[] = [];
  for (const r of db.prepare("SELECT * FROM orchestration_v2_projection_messages WHERE thread_id = ? AND streaming = 0 ORDER BY created_at, message_id").all(threadId) as Row[]) {
    const pl = parse(r.payload_json);
    const text = str(pl.text);
    if (!text) continue;
    messages.push({ id: String(r.message_id), role: String(r.role), text, ts: ms(r.created_at) ?? 0, pt: r.run_id ? runPt.get(String(r.run_id)) : undefined, by: messageBy(pl) });
  }
  const turns: StoreTurn[] = [];
  if (hasTable(db, "orchestration_v2_projection_provider_turns")) {
    for (const r of db.prepare("SELECT * FROM orchestration_v2_projection_provider_turns WHERE thread_id = ? ORDER BY provider_thread_id, ordinal").all(threadId) as Row[]) {
      const pl = parse(r.payload_json);
      const status = str(r.status) ?? str(pl.status) ?? "";
      const start = ms(r.started_at) ?? ms(pl.startedAt) ?? 0;
      const done = ITEM_DONE.has(status);
      turns.push({ id: String(r.provider_turn_id), pt: str(r.provider_thread_id), start, end: ms(r.completed_at) ?? ms(pl.completedAt), done, ok: status === "completed", usage: done ? turnUsage(pl.turnTokenUsage) : undefined, model: str(pl.model) });
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
  return { messages, turns, items, requests: readV2Requests(db, threadId, turns) };
}

/** T3 request kinds that ask a question; the others ask for approval. */
const QUESTION_KINDS = new Set(["user_input", "mcp-elicitation"]);
/** Request kinds that are not put to the user: a provider's own tool call, a sign-in refresh. */
const NOT_ASKED = new Set(["dynamic_tool_call", "auth_refresh"]);
const REQUEST_TOOL: Record<string, string> = { command: "shell", "file-change": "edit" };
/** A request item's status while it waits on the user. */
const ITEM_WAITING = new Set(["waiting", "pending", "running"]);

/**
 * A thread's requests to the user: runtime requests (status pending until resolved, expired or
 * cancelled) merged with their approval_request and user_input_request items, which carry the
 * prompt or the question. Either one ending ends the request.
 */
function readV2Requests(db: DatabaseSync, threadId: string, turns: StoreTurn[]): StoreRequest[] {
  const byId = new Map<string, StoreRequest>();
  const turnPt = new Map(turns.map((t) => [t.id, t.pt]));
  const make = (id: string, requestKind: string, start: number, open: boolean, end: number | undefined, pt: string | undefined): StoreRequest => ({ id, pt, kind: QUESTION_KINDS.has(requestKind) ? "question" : "permission", requestKind, tool: REQUEST_TOOL[requestKind], start, end: open ? undefined : Math.max(start, end ?? start), open });
  if (hasTable(db, "orchestration_v2_projection_runtime_requests")) {
    for (const r of db.prepare("SELECT runtime_request_id, provider_turn_id, kind, status, created_at, resolved_at FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ? ORDER BY created_at").all(threadId) as Row[]) {
      const kind = str(r.kind) ?? "permission";
      if (NOT_ASKED.has(kind)) continue;
      const id = String(r.runtime_request_id);
      byId.set(id, make(id, kind, ms(r.created_at) ?? 0, r.status === "pending", ms(r.resolved_at), r.provider_turn_id ? turnPt.get(String(r.provider_turn_id)) : undefined));
    }
  }
  if (hasTable(db, "orchestration_v2_projection_turn_items")) {
    for (const r of db.prepare("SELECT * FROM orchestration_v2_projection_turn_items WHERE thread_id = ? AND type IN ('approval_request','user_input_request') ORDER BY ordinal").all(threadId) as Row[]) {
      const pl = parse(r.payload_json);
      const id = str(pl.requestId);
      if (!id) continue;
      const question = r.type === "user_input_request";
      const kind = question ? "user_input" : (str(pl.requestKind) ?? "permission");
      if (NOT_ASKED.has(kind)) continue;
      const q = Array.isArray(pl.questions) ? obj(pl.questions[0]) : {};
      const text = question ? (str(q.question) ?? str(q.header)) : (str(pl.prompt) ?? str(pl.reason));
      const open = ITEM_WAITING.has(str(r.status) ?? str(pl.status) ?? "");
      const end = ms(pl.completedAt) ?? ms(r.updated_at);
      const known = byId.get(id);
      if (!known) {
        byId.set(id, { ...make(id, kind, ms(pl.startedAt) ?? ms(r.updated_at) ?? 0, open, end, str(r.provider_thread_id)), text });
        continue;
      }
      known.text ??= text;
      known.pt ??= str(r.provider_thread_id);
      if (known.open && !open) Object.assign(known, { open: false, end: Math.max(known.start, end ?? known.start) });
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------- v1 store

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
    const driver = providerName ? providerAgent(providerName) : undefined;
    const cursor = parse(rt?.resume_cursor_json);
    const nativeId = str(s?.provider_thread_id) ?? str(cursor.threadId) ?? str(cursor.resume) ?? str(cursor.sessionId);
    const project = projects.get(String(r.project_id));
    const created = ms(r.created_at) ?? 0;
    const updated = ms(r.updated_at) ?? created;
    const thread: Thread = { id, title: threadTitle(r.title), project: str(project?.title), cwd: str(r.worktree_path) ?? str(project?.workspace_root), model: str(sel.model), driver, created, updated, providerThreads: [] };
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

/** Size/mtime summary over the store files, for the whole-store unchanged check: saved once a walk has read every changed thread. */
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
  return { path: join(dir, "#store"), size, mtimeMs, covers: true };
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
    const s = statOf(await native.find(agent, unscope(pt.nativeId), t.cwd));
    size += s.size;
    mtimeMs = Math.max(mtimeMs, s.mtimeMs);
  }
  return { path: `${dbPath}#${t.id}`, size, mtimeMs: Math.floor(mtimeMs) };
}

/**
 * Run id to provider thread, and each provider thread's first request time, read once a pass. A
 * thread's rows are read later, in a snapshot of their own: a run this lacks (begun since, or given its
 * provider thread since) is looked up in that snapshot, so a message is attributed by its run as the
 * snapshot that holds the message has it, not as an older read had it.
 */
class RunThreads extends Map<string, string> {
  readonly starts = new Map<string, number>();
  /** The store get looks a missing run up in; unset when it has no runs table. */
  db: DatabaseSync | undefined;
  readonly #looked = new Set<string>();

  add(r: Row): void {
    const pt = String(r.provider_thread_id);
    this.set(String(r.run_id), pt);
    const at = ms(r.requested_at);
    if (at !== undefined && !this.starts.has(pt)) this.starts.set(pt, at);
  }

  override get(runId: string): string | undefined {
    const pt = super.get(runId);
    if (pt !== undefined || !this.db || this.#looked.has(runId)) return pt;
    this.#looked.add(runId);
    try {
      const r = this.db.prepare("SELECT run_id, provider_thread_id, requested_at FROM orchestration_v2_projection_runs WHERE run_id = ? AND provider_thread_id IS NOT NULL").get(runId) as Row | undefined;
      if (r) this.add(r);
    } catch {
      // columns differ in this store version
    }
    return super.get(runId);
  }
}

/** `room` measures the free space in the temp directory before a copy of the store (replaced in tests). */
export async function* backfillT3(ctx: NormalizeContext, opts: BackfillOpts = {}, env: NodeJS.ProcessEnv = process.env, room?: FreeSpace): AsyncIterable<AgentEvent> {
  const dir = t3UserData(env);
  const v2Path = join(dir, "statev2.sqlite");
  const v1Path = join(dir, "state.sqlite");
  if (!existsSync(v2Path) && !existsSync(v1Path)) return;
  if (opts.changed && !(await opts.changed(storeFingerprint(dir, [v2Path, v1Path])))) {
    // Copies a killed import left (a read's tail child, killed at its deadline mid-copy) go even when
    // the store is unchanged; opening the store removes them otherwise.
    reapSqliteCopies();
    return;
  }
  const native = new NativeIndex(env);
  // The store is this adapter's only source: a copy that fails or is refused (no room in the temp dir
  // for a 1.7 GB store) is a backfill error, not an import of nothing.
  const open = async (path: string) => {
    try {
      // In place while T3 Code has the store open in WAL mode: a store of several GB is not copied on every read.
      return await openSqliteInPlace(path, { throwOnError: true, room });
    } catch (e) {
      throw new Error(`T3 Code's store was not read: ${(e as Error).message}. When it can't be read in place, it is read from a copy in the temp directory (TMPDIR, or TEMP on Windows), which needs room for it`, { cause: e });
    }
  };
  const v2 = await open(v2Path);
  let v1: Awaited<ReturnType<typeof open>>;
  try {
    v1 = await open(v1Path);
  } catch (e) {
    v2?.close();
    throw e;
  }
  try {
    // Threads from both stores first, so subagent and provider-switch edges resolve across them.
    const all: { thread: Thread; db: DatabaseSync; path: string; v1: boolean }[] = [];
    const runPt = new RunThreads();
    const starts = runPt.starts;
    const acts: Map<string, { n: number; t: number }>[] = [];
    // A store's threads, provider threads and runs come from one snapshot, so they agree with each other. The
    // activity counts are read after it, each on its own: they only pick the threads to read, and a thread's
    // rows are read later still, so a count newer than the thread list at worst reads a thread again next pass.
    if (v2 && hasTable(v2.db, "orchestration_v2_projection_threads")) {
      const db = v2.db;
      readSnapshot(db, () => {
        for (const t of readV2Threads(db)) all.push({ thread: t, db, path: v2Path, v1: false });
        if (hasTable(db, "orchestration_v2_projection_runs")) {
          for (const r of db.prepare("SELECT run_id, provider_thread_id, requested_at FROM orchestration_v2_projection_runs WHERE provider_thread_id IS NOT NULL ORDER BY ordinal").all() as Row[]) runPt.add(r);
          runPt.db = db;
        }
      });
      acts.push(...Object.values(V2_ACTIVITY).map((sql) => activity(v2.db, sql)));
    }
    if (v1) {
      const db = v1.db;
      const known = new Set(all.map((x) => x.thread.id));
      for (const { thread } of readSnapshot(db, () => readV1Threads(db, known))) all.push({ thread, db, path: v1Path, v1: true });
      acts.push(
        activity(v1.db, "SELECT thread_id, COUNT(*) n, MAX(updated_at) t FROM projection_thread_messages GROUP BY thread_id"),
        activity(v1.db, "SELECT thread_id, COUNT(*) n, MAX(created_at) t FROM projection_thread_activities GROUP BY thread_id"),
      );
    }
    const covered = await coveredThreads(all.map((x) => x.thread), native);
    const primary = new Map(all.map((x) => [x.thread.id, covered.get(x.thread.id)?.sessionId ?? primaryOf(x.thread)]));
    for (const { thread, db, path, v1: old } of all) {
      const cover = covered.get(thread.id);
      if (cover) {
        // A store parsed before parseVersion 9 may hold this thread as a session: re-parse deletes it, its owner has the run.
        opts.copied?.(primaryOf(thread), cover.owner);
        continue;
      }
      let whole: (() => void) | undefined;
      if (opts.changed) {
        const act = acts.map((m) => m.get(thread.id)).filter((a): a is { n: number; t: number } => a !== undefined);
        const file = await threadFile(native, path, thread, act);
        if (!(await opts.changed(file))) continue;
        // Read whole although a window was given: a wider window later finds nothing more in it.
        whole = () => opts.whole?.(file);
      }
      let rows: StoreRows;
      try {
        // One short read transaction a thread: its rows come from one snapshot, never half of a write.
        rows = readSnapshot(db, () => (old ? readV1Rows(db, thread.id) : readV2Rows(db, thread.id, runPt)));
      } catch (e) {
        // Locked for longer than the busy timeout (another connection recovering the WAL after a crash, say),
        // or failing (an I/O error, a corrupt page): fail the pass, so this thread and the rest are not marked
        // read. The store's fingerprint is not saved either, so the next pass looks at them again.
        if (!sqliteShapeError(e)) throw new Error(`T3 Code's store was not read: ${(e as Error).message}`, { cause: e });
        continue; // schema drift in one thread's rows: skip it, keep the rest
      }
      yield* threadEvents(ctx, thread, rows, native, primary, starts, opts.since, whole);
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
  // 2 (0.1.2): Pi's native id links to the Pi session.
  // 3 (0.1.2): Claude transcripts keep Claude Code's reported cost (cost-state) on session.end.
  // 4 (0.1.2): Claude transcripts' API errors keep their HTTP status, error class, rate-limit type and retry wait.
  // 5 (0.1.2): tool.end records a tool output the agent cut before the model saw it (cut).
  // 6 (0.1.3): Claude transcripts' model fallbacks (system/model_fallback, model_refusal_fallback) are model.fallback notifications.
  // 7 (0.1.5): a tool call that loads a skill names it (payload.skill).
  // 8 (0.1.8): a subagent thread of a Claude session whose transcript holds its run is not stored again as a t3code session.
  // 9 (0.1.8): that also holds when the run sits under a later provider thread's transcript, and for Workflow-tool run
  //    threads and agents T3 records in projection_subagents; a store-built llm.call names the turn's model.
  // 10 (0.1.8): the host-link notification names the thread in its message, and T3's "New thread" placeholder is no title.
  // 11 (0.1.8): a shell call's test.result reads the last jest, vitest, node:test or mocha summary in its output, not the first.
  // 12 (0.1.8): T3's requests to the user (pending approvals and questions) are host-request notifications, resolved
  //    when T3 resolves them, so a thread waiting on one is blocked on you (core/waiting.ts). A thread with activity
  //    inside the --since window is imported whole, with its host link.
  // 13 (0.1.8): a transcript line holding a raw U+2028 or U+2029 inside a string is read whole, not split and dropped.
  // 14: a Codex exec cell built from the store is ok by the codex adapter's rule (codeModeCellOk), and a tool
  //    request with "no active turn" ends interrupted, not failed.
  // 15 (0.1.8): a test.result comes only from a command that runs tests (runsTests): a command that prints a log holding a summary (tail, grep, cat, Get-Content) gives none. A provider instance id (claudeHub, codex-work) maps to the agent its driver kind names.
  // 16 (0.1.8): a test.result reads the summary of the runner the command names first (node --test: node's own pass and fail lines), and a pytest or cargo summary only at the start of a line, not inside an assertion message, a diff or a printed fixture. A heredoc's body and a log file's name (ci-tsc.log) run no tests. A Bash call's dirty-tree diff keeps only its own edits: no files a git checkout, switch, merge or rebase brought in, and none from a command that writes nothing or runs in another directory.
  // 17 (0.1.8): a user-role message an agent made (a provider's, MCP or server prompt, a notification, a delegated result, another thread's message) is a user.message with from: "agent" in a session built from the store, and a notification (HOST_AGENT_PROMPT) names it before its prompt in a Codex or Claude transcript. A thread a person started has an interactive launch (host-link launch), except one another adapter imports (OpenCode, Cursor, Pi).
  // 18 (0.1.8): in a Claude transcript, a user entry with the promptId of the turn it is in, other than a stop prompt,
  //    adds to that turn, which ends once: one turn.end, with the turn's own duration.
  parseVersion: 18,

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
