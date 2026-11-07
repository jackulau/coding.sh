// OpenCode adapter (tier A): a JS plugin forwards events to the hook command,
// SQLite (1.x and 2.x) / JSON storage (older 1.x) backfill, `opencode run --format json`.
//
// Plugin API (verified 2026-11-06, opencode.ai/docs/build/plugins):
// - 2.x: auto-loaded from ~/.config/opencode/plugins/ and .opencode/plugins/;
//   `export default Plugin.define({ id, setup(ctx) })` from "@opencode/plugin",
//   ctx.tool.hook("execute.before"|"execute.after"), ctx.event.subscribe().
//   "V1 plugin implementations do not run in V2."
// - 1.x: ~/.config/opencode/plugin/ and .opencode/plugin/; named async export
//   returning { event, "tool.execute.before", "tool.execute.after" }.
// install() probes `opencode --version` and writes the matching flavour
// (2.x when unknown). The plugin keeps per-process state (tool start times,
// message roles, parent sessions) so each forwarded payload is self-contained
// and normalize() stays stateless. It never blocks OpenCode: each event is a
// fire-and-forget child process.
import { execFile } from "../core/spawn.ts";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, userHome } from "../core/paths.ts";
import type { Adapter, AgentRunOutput, FileChange, HarnessBundle, InstallOpts, NormalizeContext, RunSpec, SpoolLine } from "../core/types.ts";
import type { AgentEvent, Usage } from "../schema/index.ts";
import {
  Emitter,
  addUsage,
  applyChanges,
  blobList,
  clipText,
  clipValue,
  detectAgent,
  emitDerived,
  hasFlag,
  isObj,
  isolatedHome,
  lineRaw,
  num,
  obj,
  outputText,
  parentLink,
  planEdit,
  probeVersion,
  readTextIfExists,
  runEnv,
  runHeadless,
  str,
  toMs,
  usageSnapshotKey,
  which,
  lineKey,
  mcpInstaller,
} from "./_shared/index.ts";
import { isWrapperLine, normalizeWrapperLine } from "./more/wrapper.ts";

export const OPENCODE_AGENT = "opencode";
export const PLUGIN_FILE = "coding-sh.js";
export const PLUGIN_MARKER = "// coding.sh opencode plugin (managed by coding.sh; remove with `coding.sh uninstall`)";

export type PluginApi = 1 | 2;

export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(userHome(env), ".config"), "opencode");
}

export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(userHome(env), ".local", "share"), "opencode");
}

const pluginDirName = (api: PluginApi) => (api === 2 ? "plugins" : "plugin");

export function pluginPath(opts: { scope: "user" | "project"; projectDir?: string }, api: PluginApi, env = process.env): string {
  if (opts.scope === "user") return join(opencodeConfigDir(env), pluginDirName(api), PLUGIN_FILE);
  if (!opts.projectDir) throw new Error("opencode: project scope needs projectDir");
  return join(opts.projectDir, ".opencode", pluginDirName(api), PLUGIN_FILE);
}

/** Major plugin API for an `opencode --version` string (2 when unknown). */
export function apiForVersion(v: string | undefined): PluginApi {
  const major = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(major) && major < 2 ? 1 : 2;
}

// ---------------------------------------------------------------- plugin source

const FORWARD = (hookPath: string) => `import { spawn } from "node:child_process";

const HOOK = ${JSON.stringify(hookPath)};
function forward(event, payload) {
  if (process.env.CODING_SH_DISABLE === "1") return;
  try {
    const p = spawn("node", [HOOK, "opencode", event], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    p.on("error", () => {});
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(payload));
    p.unref();
  } catch {}
}
`;

/** Plugin source for the given API version. Deterministic for a given hook path (idempotent installs). */
export function pluginSource(hookPath: string, api: PluginApi): string {
  if (api === 1) {
    return `${PLUGIN_MARKER}
// api: v1
${FORWARD(hookPath)}
export const CodingSh = async ({ directory }) => {
  const cwd = directory || process.cwd();
  const starts = new Map(), args = new Map(), roles = new Map(), parents = new Map(), sent = new Set();
  const base = (sid) => ({ cwd, api: 1, sessionID: sid, parentSessionID: parents.get(sid) });
  return {
    "tool.execute.before": async (input, output) => {
      starts.set(input.callID, Date.now());
      args.set(input.callID, output && output.args);
      forward("tool.execute.before", { ...base(input.sessionID), tool: input.tool, id: input.callID, input: output && output.args });
    },
    "tool.execute.after": async (input, output) => {
      const t0 = starts.get(input.callID), a = args.get(input.callID);
      starts.delete(input.callID); args.delete(input.callID);
      const o = output || {};
      forward("tool.execute.after", { ...base(input.sessionID), tool: input.tool, id: input.callID, input: a, status: o.metadata && o.metadata.error ? "error" : "completed", result: { output: o.output, title: o.title, metadata: o.metadata }, durationMs: t0 ? Date.now() - t0 : undefined });
    },
    event: async ({ event }) => {
      const p = (event && event.properties) || {};
      switch (event && event.type) {
        case "session.created": {
          const info = p.info || {};
          if (info.parentID) parents.set(info.id, info.parentID);
          forward("session.created", { ...base(info.id), data: { id: info.id, parentID: info.parentID, title: info.title, directory: info.directory, version: info.version, time: info.time } });
          break;
        }
        case "message.updated": {
          const info = p.info || {};
          roles.set(info.id, info.role);
          if (info.role === "assistant" && info.time && info.time.completed && !sent.has(info.id)) {
            sent.add(info.id);
            forward("message.updated", { ...base(info.sessionID), data: { id: info.id, role: info.role, modelID: info.modelID, providerID: info.providerID, time: info.time, tokens: info.tokens, cost: info.cost, error: info.error, finish: info.finish } });
          }
          break;
        }
        case "message.part.updated": {
          const part = p.part || {};
          if (part.type !== "text" || part.synthetic || sent.has(part.id)) break;
          const role = roles.get(part.messageID);
          if (role === "assistant" && !(part.time && part.time.end)) break;
          sent.add(part.id);
          forward("message.part.updated", { ...base(part.sessionID), data: { id: part.id, messageID: part.messageID, role, text: part.text, time: part.time } });
          break;
        }
        case "session.idle":
        case "session.compacted":
        case "session.error":
          forward(event.type, { ...base(p.sessionID), data: p });
          break;
      }
    },
  };
};
`;
  }
  return `${PLUGIN_MARKER}
// api: v2
${FORWARD(hookPath)}
let define = (d) => d;
try {
  const m = await import("@opencode/plugin");
  if (m && m.Plugin && typeof m.Plugin.define === "function") define = m.Plugin.define.bind(m.Plugin);
} catch {}

const TYPES = [
  "session.created",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.ended",
  "session.compaction.ended",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
];

export default define({
  id: "coding-sh",
  async setup(ctx) {
    const cwd = (ctx && ctx.location && ctx.location.directory) || process.cwd();
    const starts = new Map(), steps = new Map(), runs = new Map(), parents = new Map();
    const base = (sid) => ({ cwd, api: 2, sessionID: sid, parentSessionID: parents.get(sid) });
    const at = (ev) => (typeof ev.created === "number" ? ev.created : Date.now());
    try {
      await ctx.tool.hook("execute.before", (e) => {
        starts.set(e.id, Date.now());
        forward("tool.execute.before", { ...base(e.sessionID), tool: e.tool, id: e.id, messageID: e.messageID, agent: e.agent, input: e.input });
      });
      await ctx.tool.hook("execute.after", (e) => {
        const t0 = starts.get(e.id);
        starts.delete(e.id);
        forward("tool.execute.after", { ...base(e.sessionID), tool: e.tool, id: e.id, messageID: e.messageID, agent: e.agent, input: e.input, status: e.status, result: e.result, error: e.error && (e.error.message || String(e.error)), durationMs: t0 ? Date.now() - t0 : undefined });
      });
    } catch {}
    const ac = new AbortController();
    (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ types: TYPES, signal: ac.signal })) {
          const d = ev.data || {};
          const sid = d.sessionID || (d.info && d.info.id) || d.id;
          const parent = d.parentID || d.parent_id || (d.info && d.info.parentID);
          if (ev.type === "session.created" && parent) parents.set(sid, parent);
          if (ev.type === "session.step.started") { steps.set(sid, at(ev)); continue; }
          if (ev.type === "session.execution.started") { runs.set(sid, at(ev)); continue; }
          let durationMs;
          if (ev.type.startsWith("session.step.")) { const t0 = steps.get(sid); steps.delete(sid); if (t0) durationMs = at(ev) - t0; }
          if (ev.type.startsWith("session.execution.")) { const t0 = runs.get(sid); runs.delete(sid); if (t0) durationMs = at(ev) - t0; }
          forward(ev.type, { ...base(sid), id: ev.id, created: ev.created, data: d, durationMs });
        }
      } catch {}
    })();
    return () => ac.abort();
  },
});
`;
}

/** Hook path embedded in an installed plugin (to tell "ours, up to date" from "ours, stale"). */
export function isOurPlugin(text: string | undefined): boolean {
  return !!text && text.startsWith(PLUGIN_MARKER);
}

// ---------------------------------------------------------------- normalize

function tokensUsage(t: unknown, cost: unknown): Usage | undefined {
  if (!isObj(t) && num(cost) === undefined) return undefined;
  const o = obj(t);
  const cache = obj(o.cache);
  const u: Usage = {};
  if (num(o.input) !== undefined) u.inputTokens = o.input as number;
  const out = (num(o.output) ?? 0) + (num(o.reasoning) ?? 0);
  if (num(o.output) !== undefined || num(o.reasoning) !== undefined) u.outputTokens = out;
  if (num(cache.read) !== undefined) u.cacheReadTokens = cache.read as number;
  if (num(cache.write) !== undefined) u.cacheWriteTokens = cache.write as number;
  if (num(cost) !== undefined) u.costUsd = cost as number;
  return Object.keys(u).length ? u : undefined;
}

export async function normalizeOpencodeLine(line: SpoolLine, ctx: NormalizeContext): Promise<AgentEvent[]> {
  // `coding.sh run --agent <id> -- …` spools its session.start/file.change/session.end under this agent id.
  if (isWrapperLine(line)) return normalizeWrapperLine(line, ctx);
  const raw = obj(lineRaw(line));
  const event = line.event;
  const data = obj(raw.data);
  const sessionId = str(raw.sessionID) ?? str(data.sessionID) ?? `ppid-${line.ppid ?? line.pid}`;
  const parentSid = str(raw.parentSessionID);
  const em = new Emitter(ctx, { agent: OPENCODE_AGENT, sessionId, ts: line.ts, cwd: str(raw.cwd) ?? line.cwd, runId: line.runId, subagentId: parentSid ? sessionId : undefined }, ["hook", ...lineKey(line, ctx), event]);
  const durationMs = num(raw.durationMs);
  const subagentEnd = (ok: boolean, status?: string) => {
    if (!parentSid) return;
    em.emit("subagent.end", { subagentId: sessionId, ok, status, childSessionId: sessionId }, { sessionId: parentSid, subagentId: undefined, key: [sessionId] });
  };

  switch (event) {
    case "tool.execute.before": {
      const id = str(raw.id) ?? ctx.id(sessionId, "tool", ...lineKey(line, ctx));
      const tool = str(raw.tool) ?? "unknown";
      const inp = await clipValue(ctx, raw.input);
      em.emit("tool.start", { tool, toolUseId: id, input: inp.value, agentName: str(raw.agent) }, { key: [id], blobs: blobList(inp.blob) });
      break;
    }
    case "tool.execute.after": {
      const id = str(raw.id) ?? ctx.id(sessionId, "tool", ...lineKey(line, ctx));
      const tool = str(raw.tool) ?? "unknown";
      const ok = raw.status !== "error";
      const result = obj(raw.result);
      const text = ok ? (outputText(result.output) ?? outputText(result.content) ?? "") : (str(raw.error) ?? outputText(result.output) ?? "");
      const o = await clipText(ctx, text);
      em.emit("tool.end", { tool, toolUseId: id, ok, durationMs, output: o.value, title: str(result.title) }, { key: [id], durationMs, blobs: blobList(o.blob) });
      await emitDerived(em, { tool, toolUseId: id, input: raw.input, output: text, ok, cwd: em.base.cwd });
      break;
    }
    case "session.created": {
      const sid = str(data.id) ?? str(obj(data.info).id) ?? sessionId;
      const parent = str(data.parentID) ?? str(data.parent_id) ?? str(obj(data.info).parentID) ?? parentSid;
      const model = obj(data.model);
      const modelId = str(model.id) ?? str(model.modelID);
      const payload: Record<string, unknown> = { source: "hook", title: str(data.title)?.slice(0, 280) };
      if (parent) Object.assign(payload, parentLink(ctx, OPENCODE_AGENT, parent, sid, str(data.agent)));
      em.emit("session.start", payload, { sessionId: sid, key: ["start"], model: modelId, agentVersion: str(data.version), subagentId: parent ? sid : undefined });
      if (parent) em.emit("subagent.start", { subagentId: sid, type: str(data.agent), childSessionId: sid }, { sessionId: parent, subagentId: undefined, key: [sid] });
      break;
    }
    case "message.updated": {
      const created = toMs(obj(data.time).created, line.ts);
      const completed = toMs(obj(data.time).completed, line.ts);
      const usage = tokensUsage(data.tokens, data.cost);
      const d = Math.max(0, completed - created);
      em.emit(
        "llm.call",
        { provider: str(data.providerID), responseModel: str(data.modelID), stopReason: str(data.finish), ok: data.error === undefined, error: data.error !== undefined ? JSON.stringify(data.error).slice(0, 500) : undefined, tokensPerSec: usage?.outputTokens && d > 0 ? Math.round((usage.outputTokens / (d / 1000)) * 10) / 10 : undefined, messageId: str(data.id) },
        { key: [str(data.id) ?? line.ts], ts: created, durationMs: d, usage, model: str(data.modelID) },
      );
      break;
    }
    case "session.step.ended":
    case "session.step.failed": {
      const usage = tokensUsage(data.tokens, data.cost);
      const ok = event === "session.step.ended";
      const end = num(raw.created) ?? line.ts;
      em.emit(
        "llm.call",
        { ok, stopReason: str(data.finish) ?? str(obj(data.finish).reason), error: ok ? undefined : (str(data.error) ?? str(obj(data.error).message))?.slice(0, 500), messageId: str(data.assistantMessageID), tokensPerSec: usage?.outputTokens && durationMs ? Math.round((usage.outputTokens / (durationMs / 1000)) * 10) / 10 : undefined },
        { key: [str(raw.id) ?? end], ts: durationMs !== undefined ? end - durationMs : end, durationMs, usage },
      );
      break;
    }
    case "message.part.updated":
    case "session.text.ended": {
      const role = event === "session.text.ended" ? "assistant" : str(data.role);
      const t = await clipText(ctx, str(data.text) ?? "");
      if (!t.value) break;
      em.emit(role === "user" ? "user.message" : "assistant.message", { text: t.value, truncated: t.truncated || undefined }, { key: [str(data.id) ?? str(raw.id) ?? line.ts], blobs: blobList(t.blob) });
      break;
    }
    case "session.idle":
      em.emit("turn.end", { ok: true });
      subagentEnd(true);
      break;
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted": {
      const status = event.slice("session.execution.".length);
      em.emit("turn.end", { ok: status === "succeeded", status }, { durationMs });
      subagentEnd(status === "succeeded", status);
      break;
    }
    case "session.compacted":
    case "session.compaction.ended":
      em.emit("context.compact", { trigger: "auto" });
      break;
    case "session.error":
      em.emit("error", { message: JSON.stringify(data.error ?? data).slice(0, 1000) });
      break;
    default:
      em.emit("notification", { hookEvent: event });
  }
  await em.attachRaw(lineRaw(line));
  return em.events;
}

// ---------------------------------------------------------------- backfill

interface StoredMessage {
  id: string;
  sessionId: string;
  role?: string;
  data: Record<string, unknown>;
  ts: number;
  parts: Record<string, unknown>[];
}

/** Convert one stored session (JSON storage or SQLite rows) — shared 1.x-style part shapes. */
async function convertStoredSession(ctx: NormalizeContext, s: { id: string; parentId?: string; title?: string; directory?: string; version?: string; created: number; updated?: number; agent?: string }, messages: StoredMessage[], totals?: Usage): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  const base = { agent: OPENCODE_AGENT, sessionId: s.id, ts: s.created, cwd: s.directory, agentVersion: s.version, subagentId: s.parentId ? s.id : undefined };
  const head = new Emitter(ctx, base, ["store", s.id]);
  const payload: Record<string, unknown> = { source: "store", title: s.title?.slice(0, 280) };
  if (s.parentId) Object.assign(payload, parentLink(ctx, OPENCODE_AGENT, s.parentId, s.id, s.agent));
  head.emit("session.start", payload, { key: ["start"] });
  if (s.parentId) head.emit("subagent.start", { subagentId: s.id, type: s.agent, childSessionId: s.id }, { sessionId: s.parentId, subagentId: undefined, key: [s.id] });
  out.push(...head.events);
  let sawUsage = false;
  let lastTs = s.created;
  for (const m of messages) {
    const em = new Emitter(ctx, { ...base, ts: m.ts, model: str(m.data.modelID) }, ["store", s.id, m.id]);
    for (const p of m.parts) {
      const pt = toMs(obj(p.time).start, m.ts);
      if (p.type === "text" && str(p.text) && p.synthetic !== true) {
        const t = await clipText(ctx, p.text as string);
        em.emit(m.role === "user" ? "user.message" : "assistant.message", { text: t.value, truncated: t.truncated || undefined }, { key: [str(p.id) ?? `${m.id}:${pt}`], ts: pt, blobs: blobList(t.blob) });
      } else if (p.type === "tool") {
        const st = obj(p.state);
        const id = str(p.callID) ?? str(p.call_id) ?? str(p.id) ?? `${m.id}:${pt}`;
        const tool = str(p.tool) ?? "unknown";
        const t0 = toMs(obj(st.time).start, m.ts);
        const t1 = toMs(obj(st.time).end, t0);
        const inp = await clipValue(ctx, st.input);
        em.emit("tool.start", { tool, toolUseId: id, input: inp.value }, { key: [id], ts: t0, blobs: blobList(inp.blob) });
        if (st.status === "completed" || st.status === "error") {
          const ok = st.status === "completed";
          const text = ok ? (outputText(st.output) ?? "") : (str(st.error) ?? "");
          const o = await clipText(ctx, text);
          em.emit("tool.end", { tool, toolUseId: id, ok, durationMs: t1 - t0, output: o.value, title: str(st.title) }, { key: [id], ts: t1, durationMs: t1 - t0, blobs: blobList(o.blob) });
          await emitDerived(em, { tool, toolUseId: id, input: st.input, output: text, ok, cwd: s.directory, extra: { ts: t1 } });
        }
      }
    }
    if (m.role === "assistant" && (m.data.tokens !== undefined || m.data.cost !== undefined)) {
      const created = toMs(obj(m.data.time).created, m.ts);
      const completed = toMs(obj(m.data.time).completed, created);
      const usage = tokensUsage(m.data.tokens, m.data.cost);
      if (usage) sawUsage = true;
      em.emit("llm.call", { provider: str(m.data.providerID), responseModel: str(m.data.modelID), stopReason: str(m.data.finish), ok: m.data.error === undefined, messageId: m.id }, { key: [m.id], ts: created, durationMs: Math.max(0, completed - created), usage });
    }
    lastTs = Math.max(lastTs, m.ts);
    out.push(...em.events);
  }
  if (!sawUsage && totals) {
    // Session-level totals only (no per-call rows): attach to a summary so session usage is still right.
    const em = new Emitter(ctx, { ...base, ts: lastTs }, ["store", s.id, "totals"]);
    // Running totals: a later backfill with larger totals adds a new snapshot (buildSession counts the latest).
    em.emit("notification", { type: "usage-summary" }, { key: usageSnapshotKey(totals), usage: totals });
    out.push(...em.events);
  }
  if (s.parentId) {
    // Same natural key as the live subagent.end, so the two dedupe.
    const em = new Emitter(ctx, { ...base, ts: Math.max(lastTs, s.updated ?? 0) }, ["store", s.id, "end"]);
    em.emit("subagent.end", { subagentId: s.id, childSessionId: s.id }, { sessionId: s.parentId, subagentId: undefined, key: [s.id] });
    out.push(...em.events);
  }
  return out;
}

async function readJsonDir(dir: string): Promise<Record<string, unknown>[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const n of names) {
    try {
      out.push(obj(JSON.parse(await readFile(join(dir, n), "utf8"))));
    } catch {
      // skip corrupt file
    }
  }
  return out;
}

/** 1.x: storage/session/<project>/<id>.json, message/<sid>/<mid>.json, part/<mid>/<pid>.json. */
async function* backfillJsonStorage(ctx: NormalizeContext, storage: string, since?: number): AsyncIterable<AgentEvent> {
  let projects: string[];
  try {
    projects = (await readdir(join(storage, "session"))).sort();
  } catch {
    return;
  }
  for (const proj of projects) {
    for (const s of await readJsonDir(join(storage, "session", proj))) {
      const id = str(s.id);
      if (!id) continue;
      const updated = toMs(obj(s.time).updated, toMs(obj(s.time).created, 0));
      if (since !== undefined && updated < since) continue;
      const msgs: StoredMessage[] = [];
      for (const m of await readJsonDir(join(storage, "message", id))) {
        const mid = str(m.id);
        if (!mid) continue;
        const parts = await readJsonDir(join(storage, "part", mid));
        msgs.push({ id: mid, sessionId: id, role: str(m.role), data: m, ts: toMs(obj(m.time).created, 0), parts });
      }
      msgs.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
      const events = await convertStoredSession(ctx, { id, parentId: str(s.parentID), title: str(s.title), directory: str(s.directory), version: str(s.version), created: toMs(obj(s.time).created, 0), updated }, msgs);
      for (const e of events) if (since === undefined || e.ts >= since) yield e;
    }
  }
}

type SqlRow = Record<string, unknown>;

const parseJson = (v: unknown): Record<string, unknown> => {
  if (typeof v !== "string") return obj(v);
  try {
    return obj(JSON.parse(v));
  } catch {
    return {};
  }
};

const SESSION_TOTALS = [["tokens_input", "inputTokens"], ["tokens_output", "outputTokens"], ["tokens_cache_read", "cacheReadTokens"], ["tokens_cache_write", "cacheWriteTokens"], ["cost", "costUsd"]] as const;

function sessionTotals(s: SqlRow): Usage | undefined {
  const totals: Usage = {};
  for (const [col, k] of SESSION_TOTALS) {
    const v = num(s[col]);
    if (v !== undefined) totals[k] = v;
  }
  if (num(s.tokens_reasoning)) totals.outputTokens = (totals.outputTokens ?? 0) + (s.tokens_reasoning as number);
  return Object.keys(totals).length ? totals : undefined;
}

/**
 * Table names per schema. 1.x (verified on 1.19.5): session / message / part, with message and
 * part bodies in a `data` JSON column and the part id in its own column. 2.x: session_v2 /
 * session_message / session_part.
 */
const SQL_SCHEMAS = [
  { session: "session_v2", messages: "SELECT * FROM session_message WHERE session_id = ? ORDER BY seq, time_created", parts: "SELECT * FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal", v2: true },
  { session: "session", messages: "SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id", parts: "SELECT * FROM part WHERE session_id = ? ORDER BY message_id, id", v2: false },
] as const;

/** opencode.db (2.x tables, else 1.x tables). Copied first: WAL locks. */
async function* backfillSqlite(ctx: NormalizeContext, dbPath: string, since?: number): AsyncIterable<AgentEvent> {
  const tmp = await mkdtemp(join(tmpdir(), "csh-opencode-"));
  try {
    const copy = join(tmp, "opencode.db");
    await copyFile(dbPath, copy);
    for (const ext of ["-wal", "-shm"]) if (existsSync(dbPath + ext)) await copyFile(dbPath + ext, copy + ext);
    const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
    const db = new DatabaseSync(copy);
    try {
      const hasTable = (name: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
      const schema = SQL_SCHEMAS.find((x) => hasTable(x.session));
      if (!schema) return;
      const sessions = db.prepare(`SELECT * FROM ${schema.session} WHERE COALESCE(time_updated, time_created, 0) >= ? ORDER BY time_created`).all(since ?? 0) as SqlRow[];
      const msgStmt = db.prepare(schema.messages);
      const partStmt = db.prepare(schema.parts);
      for (const s of sessions) {
        const id = str(s.id);
        if (!id) continue;
        const partsByMsg = new Map<string, Record<string, unknown>[]>();
        for (const p of partStmt.all(id) as SqlRow[]) {
          const d = schema.v2 ? { type: p.type, call_id: p.call_id, ...parseJson(p.data) } : { id: p.id, ...parseJson(p.data) };
          const mid = String(p.message_id);
          partsByMsg.set(mid, [...(partsByMsg.get(mid) ?? []), d]);
        }
        const msgs: StoredMessage[] = (msgStmt.all(id) as SqlRow[]).map((m) => {
          const data = parseJson(m.data);
          return { id: String(m.id), sessionId: id, role: str(data.role) ?? str(m.type), data, ts: toMs(m.time_created, 0), parts: partsByMsg.get(String(m.id)) ?? [] };
        });
        const events = await convertStoredSession(
          ctx,
          { id, parentId: str(s.parent_id), title: str(s.title), directory: str(s.directory), version: str(s.version), created: toMs(s.time_created, 0), updated: num(s.time_updated), agent: str(s.agent) },
          msgs,
          sessionTotals(s),
        );
        for (const e of events) if (since === undefined || e.ts >= since) yield e;
      }
    } finally {
      db.close();
    }
  } catch {
    // schema drift or unreadable db: nothing to import
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function* backfillOpencode(ctx: NormalizeContext, opts: { since?: number } = {}): AsyncIterable<AgentEvent> {
  const data = opencodeDataDir();
  const db = process.env.OPENCODE_DB && process.env.OPENCODE_DB !== ":memory:" ? process.env.OPENCODE_DB : join(data, "opencode.db");
  if (existsSync(db)) yield* backfillSqlite(ctx, db, opts.since);
  yield* backfillJsonStorage(ctx, join(data, "storage"), opts.since);
}

// ---------------------------------------------------------------- install

async function installedApi(): Promise<PluginApi> {
  const bin = which("opencode");
  return apiForVersion(bin ? await probeVersion(bin) : undefined);
}

function planPlugin(path: string, hookPath: string, api: PluginApi): FileChange | undefined {
  const before = readTextIfExists(path);
  if (before !== undefined && !isOurPlugin(before)) throw new Error(`${path} exists and was not written by coding.sh; refusing to overwrite it`);
  return planEdit(path, before, pluginSource(hookPath, api), `install coding.sh opencode plugin (API v${api})`);
}

function planRemovePlugin(path: string): FileChange | undefined {
  const before = readTextIfExists(path);
  if (!isOurPlugin(before)) return undefined;
  return planEdit(path, before, undefined, "remove coding.sh opencode plugin");
}

// ---------------------------------------------------------------- run

function helpText(bin: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(bin, ["run", "--help"], { timeout: 5000, maxBuffer: 1 << 20 }, (_e, out, err) => resolve(`${out ?? ""}\n${err ?? ""}`));
    } catch {
      resolve("");
    }
  });
}

export async function runOpencode(spec: RunSpec): Promise<AgentRunOutput> {
  const env = runEnv(spec);
  const bin = which("opencode", env as NodeJS.ProcessEnv) ?? "opencode";
  const help = await helpText(bin);
  const args = ["run", "--format", "json"];
  // --standalone: a private server, so this run's env (config dir, run id) applies.
  if (help.includes("--standalone") && !hasFlag(spec.flags, "--standalone")) args.push("--standalone");
  // Without --auto, 2.x rejects permission requests in non-interactive mode.
  if (help.includes("--auto") && !hasFlag(spec.flags, "--auto")) args.push("--auto");
  if (spec.model && !hasFlag(spec.flags, "--model", "-m")) args.push("--model", spec.model);
  args.push(...spec.flags, spec.instruction);
  let sessionId: string | undefined;
  let usage: Usage | undefined;
  const res = await runHeadless({
    stdoutFile: spec.stdoutFile,
    bin,
    args,
    cwd: spec.cwd,
    env,
    timeoutMs: spec.timeoutMs,
    onJson: (v) => {
      const o = obj(v);
      const part = obj(o.part);
      sessionId ??= str(o.sessionID) ?? str(part.sessionID);
      if (o.type === "step_finish") usage = addUsage(usage, tokensUsage(part.tokens, part.cost));
    },
  });
  const out: AgentRunOutput = { ...res };
  if (sessionId) out.sessionId = sessionId;
  if (usage) out.usage = usage;
  return out;
}

// ---------------------------------------------------------------- overlay

/** Isolated config root with our plugin; 2.x also gets a run-local database. Auth (data dir) is left as is. */
export async function overlayOpencode(_bundle: HarnessBundle, runDir: string): Promise<{ env: Record<string, string>; flags: string[] }> {
  const home = isolatedHome(runDir);
  const configDir = join(home, ".config", "opencode");
  const api = await installedApi();
  await applyChanges([planPlugin(join(configDir, pluginDirName(api), PLUGIN_FILE), paths().hook, api)], { agent: OPENCODE_AGENT, dryRun: false, noBackup: true });
  const env: Record<string, string> = api === 2 ? { OPENCODE_CONFIG_DIR: configDir, OPENCODE_DB: join(home, "opencode.db") } : { XDG_CONFIG_HOME: join(home, ".config") };
  return { env, flags: [] };
}

// ---------------------------------------------------------------- adapter

export const opencode: Adapter = {
  id: OPENCODE_AGENT,
  displayName: "OpenCode",
  tier: "A",
  // 2 (0.1.2): backfill reads the 1.x SQLite tables.
  parseVersion: 2,

  async detect() {
    const r = await detectAgent({
      bins: ["opencode"],
      configDir: opencodeConfigDir(),
      hooked: () => ([1, 2] as const).some((api) => isOurPlugin(readTextIfExists(pluginPath({ scope: "user" }, api)))),
    });
    if (r.installed && r.hooked) {
      const want = apiForVersion(r.version);
      if (!isOurPlugin(readTextIfExists(pluginPath({ scope: "user" }, want)))) {
        return { ...r, notes: [...(r.notes ?? []), `installed plugin targets the wrong OpenCode API for ${r.version}; re-run \`coding.sh init\``] };
      }
    }
    return r;
  },

  async install(opts: InstallOpts) {
    const api = await installedApi();
    const stale = pluginPath(opts, api === 2 ? 1 : 2);
    return applyChanges([planPlugin(pluginPath(opts, api), opts.hookCommand, api), planRemovePlugin(stale)], { agent: OPENCODE_AGENT, dryRun: opts.dryRun });
  },

  async uninstall(opts) {
    return applyChanges([planRemovePlugin(pluginPath(opts, 2)), planRemovePlugin(pluginPath(opts, 1))], { agent: OPENCODE_AGENT, dryRun: opts.dryRun });
  },

  // OpenCode's global opencode.json: { "mcp": { name: { type: "local", command: [...] } } }.
  ...mcpInstaller((env) => ({
    agent: OPENCODE_AGENT,
    file: join(opencodeConfigDir(env), "opencode.json"),
    format: "json",
    key: "mcp",
    entry: (s) => ({ type: "local", command: [s.command, ...s.args], enabled: true }),
  })),

  normalize: normalizeOpencodeLine,
  backfill: backfillOpencode,
  run: runOpencode,
  overlay: overlayOpencode,

  harnessFiles() {
    return {
      project: ["AGENTS.md", "opencode.json", "opencode.jsonc", ".opencode/agent/**", ".opencode/agents/**", ".opencode/command/**", ".opencode/commands/**", ".opencode/plugin/**", ".opencode/plugins/**", ".opencode/skills/**", ".agents/skills/**"],
      user: ["~/.config/opencode/AGENTS.md", "~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc", "~/.config/opencode/agents/**", "~/.config/opencode/commands/**", "~/.config/opencode/plugins/**", "~/.config/opencode/skills/**"],
    };
  },
};
