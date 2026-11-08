// Claude Code Workflow tool runs (docs/design/workflows.md §2.1): journal +
// agent transcripts + meta.json → nodes.
//
// On disk (Claude Code 2.1.3xx):
//   <projects>/<slug>/<hostSessionId>/subagents/workflows/<runId>/journal.jsonl
//   <projects>/<slug>/<hostSessionId>/subagents/workflows/<runId>/agent-<id>.jsonl (+ .meta.json)
//   <projects>/<slug>/<hostSessionId>/workflows/<runId>.json   (persisted run record)
//
// Journal records seen so far: {type:"launched"}, {type:"started", key,
// agentId, label, phase}, {type:"result", key, agentId, result, toolsUsed}.
// The parser also accepts timestamps (ts/timestamp/startedAt/endedAt/
// issuedAt), error and cache-hit records, phase markers and group fields when
// a newer version writes them, and counts every other record as unknown
// instead of failing. A result whose key was never started in this journal is
// treated as a resume cache hit (inferred).
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sha256Hex, hashParts } from "../../core/ids.ts";
import { applyPricing, type Prices } from "../../core/pricing.ts";
import { buildSession } from "../../core/sessions.ts";
import type { BlobStore, NormalizeContext } from "../../core/types.ts";
import type { AgentEvent, Session } from "../../schema/index.ts";
import { ClaudeTranscriptConverter } from "../../adapters/_shared/claude-transcript.ts";
import { readJsonl } from "../../adapters/_shared/jsonl.ts";
import { childSessionId, parentLink } from "../../adapters/_shared/normalize.ts";
import { eventEnd } from "../metrics.ts";
import type { TreeSources, WorkflowNode, WorkflowRun } from "../types.ts";

const CLAUDE_AGENT = "claude-code";
export const WORKFLOW_AGENT_TYPE = "workflow-agent";

// ---------------------------------------------------------------- helpers

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const s = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** ISO string, epoch ms or epoch seconds → ms. */
export function tsOf(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e11 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
    const x = Number(v);
    if (Number.isFinite(x)) return tsOf(x);
  }
  return undefined;
}

/** Stable JSON (sorted keys) for hashing. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** `phase('…')` calls in script order (static scan). */
export function scanPhases(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/\bphase\(\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
    const name = m[2]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------- journal

export interface JournalCall {
  /** 0-based agent() call order. */
  ordinal: number;
  key?: string;
  agentId?: string;
  label?: string;
  phase?: string;
  status: "returned" | "null" | "error" | "running";
  cached: boolean;
  /** Cache hit inferred from a result with no matching start. */
  cacheInferred?: boolean;
  hasResult: boolean;
  result?: unknown;
  error?: string;
  toolsUsed?: string[];
  startedAt?: number;
  endedAt?: number;
  issuedAt?: number;
  groupId?: string;
  groupKind?: "parallel" | "pipeline";
  stage?: number;
  item?: number;
  model?: string;
  effort?: string;
  schema?: boolean;
  opts?: Record<string, unknown>;
}

export interface ParsedJournal {
  runId?: string;
  resumeFromRunId?: string;
  scriptPath?: string;
  args?: unknown;
  hasArgs: boolean;
  launchedAt?: number;
  finishedAt?: number;
  status?: string;
  calls: JournalCall[];
  records: number;
  unknown: number;
}

const RESULT_TYPES = new Set(["result", "returned", "done", "completed", "finished"]);
const ERROR_TYPES = new Set(["error", "failed", "failure"]);
const CACHE_TYPES = new Set(["cached", "cache_hit", "cache-hit", "replayed", "resumed"]);
const START_TYPES = new Set(["started", "start", "spawned"]);
const ISSUE_TYPES = new Set(["queued", "issued", "scheduled"]);

function timeOf(r: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const t = tsOf(r[k]);
    if (t !== undefined) return t;
  }
  return undefined;
}

function applyCommon(c: JournalCall, r: Record<string, unknown>): void {
  c.key ??= s(r.key);
  c.agentId ??= s(r.agentId) ?? s(r.agent_id);
  c.label ??= s(r.label) ?? (isObj(r.opts) ? s(r.opts.label) : undefined);
  c.phase ??= s(r.phase) ?? (isObj(r.opts) ? s(r.opts.phase) : undefined);
  c.model ??= s(r.model) ?? (isObj(r.opts) ? s(r.opts.model) : undefined);
  c.effort ??= s(r.effort) ?? (isObj(r.opts) ? s(r.opts.effort) : undefined);
  if (c.schema === undefined) {
    const sc = r.schema ?? (isObj(r.opts) ? r.opts.schema : undefined);
    if (sc !== undefined) c.schema = sc !== null && sc !== false;
  }
  if (isObj(r.opts)) c.opts ??= r.opts;
  const g = isObj(r.group) ? r.group : r;
  c.groupId ??= s(g.groupId) ?? s(g.group_id) ?? (isObj(r.group) ? s(r.group.id) : undefined);
  const gk = s(g.groupKind) ?? s(g.group_kind) ?? (isObj(r.group) ? s(r.group.kind) : undefined);
  if (gk === "parallel" || gk === "pipeline") c.groupKind ??= gk;
  c.stage ??= n(g.stage);
  c.item ??= n(g.item) ?? n(g.index);
  c.issuedAt ??= timeOf(r, "issuedAt", "queuedAt");
}

export function parseJournal(text: string): ParsedJournal {
  const out: ParsedJournal = { calls: [], records: 0, unknown: 0, hasArgs: false };
  const open = new Map<string, JournalCall[]>(); // key → unresolved calls, oldest first
  let currentPhase: string | undefined;
  const byAgent = new Map<string, JournalCall>();

  const newCall = (r: Record<string, unknown>): JournalCall => {
    const c: JournalCall = { ordinal: out.calls.length, status: "running", cached: false, hasResult: false };
    if (currentPhase) c.phase = currentPhase;
    applyCommon(c, r);
    out.calls.push(c);
    if (c.key) open.set(c.key, [...(open.get(c.key) ?? []), c]);
    if (c.agentId) byAgent.set(c.agentId, c);
    return c;
  };
  const findOpen = (r: Record<string, unknown>): JournalCall | undefined => {
    const key = s(r.key);
    if (key) {
      const q = open.get(key);
      if (q?.length) return q[0];
    }
    const agentId = s(r.agentId) ?? s(r.agent_id);
    if (agentId) {
      const c = byAgent.get(agentId);
      if (c && !c.hasResult) return c;
    }
    const ord = n(r.ordinal) ?? n(r.index);
    if (ord !== undefined) {
      const c = out.calls[ord];
      if (c && !c.hasResult) return c;
    }
    return undefined;
  };
  const resolve = (c: JournalCall) => {
    if (!c.key) return;
    const q = open.get(c.key);
    if (!q) return;
    const i = q.indexOf(c);
    if (i >= 0) q.splice(i, 1);
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      out.unknown++;
      continue;
    }
    if (!isObj(r)) {
      out.unknown++;
      continue;
    }
    out.records++;
    const type = (s(r.type) ?? "").toLowerCase();
    if (type === "launched" || type === "launch" || type === "run_started") {
      out.runId ??= s(r.runId) ?? s(r.run_id);
      out.resumeFromRunId ??= s(r.resumeFromRunId) ?? s(r.resumedFrom);
      out.scriptPath ??= s(r.scriptPath) ?? s(r.script);
      if ("args" in r) {
        out.args = r.args;
        out.hasArgs = true;
      }
      out.launchedAt ??= timeOf(r, "ts", "timestamp", "time", "at");
      continue;
    }
    if (type === "phase" || type === "phase_started") {
      currentPhase = s(r.name) ?? s(r.phase) ?? s(r.title) ?? currentPhase;
      continue;
    }
    if (type === "finished" && !r.key && !r.agentId) {
      out.finishedAt = timeOf(r, "ts", "timestamp", "time", "at");
      out.status = s(r.status);
      continue;
    }
    if (ISSUE_TYPES.has(type)) {
      const c = newCall(r);
      c.issuedAt ??= timeOf(r, "ts", "timestamp", "time", "at");
      continue;
    }
    if (START_TYPES.has(type)) {
      // A start for an issued-but-not-started call reuses it.
      let c = findOpen(r);
      if (c && c.startedAt === undefined && c.issuedAt !== undefined && !c.hasResult) applyCommon(c, r);
      else c = newCall(r);
      if (c.agentId) byAgent.set(c.agentId, c);
      c.startedAt ??= timeOf(r, "startedAt", "ts", "timestamp", "time", "at");
      continue;
    }
    if (RESULT_TYPES.has(type) || ERROR_TYPES.has(type) || CACHE_TYPES.has(type)) {
      let c = findOpen(r);
      if (!c) {
        c = newCall(r);
        // A result with no start in this journal: replayed from the resumed run.
        if (!CACHE_TYPES.has(type)) c.cacheInferred = true;
        c.cached = true;
      }
      applyCommon(c, r);
      c.hasResult = true;
      resolve(c);
      if (CACHE_TYPES.has(type) || r.cached === true || r.fromCache === true || r.cacheHit === true) c.cached = true;
      c.endedAt ??= timeOf(r, "endedAt", "ts", "timestamp", "time", "at");
      if (Array.isArray(r.toolsUsed)) c.toolsUsed = r.toolsUsed.filter((t): t is string => typeof t === "string");
      const err = s(r.error) ?? (isObj(r.error) ? s(r.error.message) : undefined);
      if (ERROR_TYPES.has(type) || err !== undefined) {
        c.status = "error";
        c.error = err ?? "error";
      } else if ("result" in r) {
        c.result = r.result;
        c.status = r.result === null || r.result === undefined ? "null" : "returned";
      } else if ("value" in r) {
        c.result = r.value;
        c.status = r.value === null || r.value === undefined ? "null" : "returned";
      } else {
        c.status = "null";
      }
      continue;
    }
    out.unknown++;
  }
  return out;
}

// ---------------------------------------------------------------- agent details

export interface AgentDetail {
  usage?: WorkflowNode["usage"];
  latency?: WorkflowNode["latency"];
  turns?: number;
  toolCalls?: number;
  toolErrors?: number;
  apiRetries: number;
  schema: { attempts: number; failures: number; anySuccess: boolean; used: boolean };
  model?: string;
  startedAt?: number;
  endedAt?: number;
  sessionId?: string;
  /** The transcript ends with the operator stopping the agent ("[Request interrupted by user…]"). */
  interrupted: boolean;
}

const STRUCTURED = /^StructuredOutput$/;
/** The line Claude Code writes into an agent's transcript when the operator stops it. */
export const INTERRUPT_TEXT = /^\[Request interrupted by user( for tool use)?\]/;
const ACTIVITY = new Set(["user.message", "assistant.message", "tool.start", "tool.end", "llm.call"]);

/** Folds one agent's transcript events (and session row) into node fields. */
export function agentDetail(events: readonly AgentEvent[] | undefined, session: Session | undefined): AgentDetail {
  const d: AgentDetail = { apiRetries: 0, schema: { attempts: 0, failures: 0, anySuccess: false, used: false }, interrupted: false };
  const evs = [...(events ?? [])].sort((a, b) => a.ts - b.ts);
  let last: AgentEvent | undefined;
  for (const e of evs) {
    if (ACTIVITY.has(e.kind)) last = e;
    if (e.kind === "tool.start" && typeof e.payload.tool === "string" && STRUCTURED.test(e.payload.tool)) d.schema.used = true;
    if (e.kind === "tool.end" && typeof e.payload.tool === "string" && STRUCTURED.test(e.payload.tool)) {
      d.schema.used = true;
      d.schema.attempts++;
      if (e.payload.ok === false) d.schema.failures++;
      else d.schema.anySuccess = true;
    }
    if (e.kind === "error" && e.payload.source === "api") d.apiRetries++;
    if (e.kind === "llm.call" && e.payload.ok === false) d.apiRetries++;
  }
  d.interrupted = last?.kind === "user.message" && typeof last.payload.text === "string" && INTERRUPT_TEXT.test(last.payload.text.trimStart());
  if (session) {
    d.sessionId = session.id;
    d.startedAt = session.startedAt;
    d.endedAt = session.endedAt;
    if (session.stats.usage) d.usage = session.stats.usage;
    if (session.stats.latency) d.latency = session.stats.latency;
    d.turns = session.stats.turns;
    d.toolCalls = session.stats.toolCalls;
    d.toolErrors = session.stats.toolErrors;
    if (session.model) d.model = session.model;
  } else if (evs.length) {
    return agentDetail(evs, buildSession(evs as AgentEvent[]));
  }
  if (evs.length) {
    d.startedAt ??= evs[0]!.ts;
    const last = Math.max(...evs.map(eventEnd));
    d.endedAt = d.endedAt === undefined ? last : Math.max(d.endedAt, last);
  }
  return d;
}

// ---------------------------------------------------------------- run record

export function recordStatus(v: unknown): WorkflowRun["status"] | undefined {
  const t = (s(v) ?? "").toLowerCase();
  if (!t) return undefined;
  if (/^(completed|complete|ok|success|succeeded|done|finished)$/.test(t)) return "ok";
  if (/^(failed|failure|error|errored)$/.test(t)) return "failed";
  if (/^(aborted|cancelled|canceled|killed|stopped|interrupted)$/.test(t)) return "aborted";
  if (/^(running|in_progress|started|pending)$/.test(t)) return "running";
  return undefined;
}

export interface RecordAgent {
  agentId: string;
  /** The last segment replayed this call's result from the journal. */
  cached: boolean;
  startedAt?: number;
  endedAt?: number;
}

/**
 * Per-agent entries of the persisted run record (`workflowProgress[]`, type "workflow_agent"),
 * keyed by agent id. They describe the record's segment: the last one of a resumed run.
 */
export function recordAgents(record: Record<string, unknown> | undefined): Map<string, RecordAgent> {
  const out = new Map<string, RecordAgent>();
  const list = record && Array.isArray(record.workflowProgress) ? record.workflowProgress : [];
  for (const e of list) {
    if (!isObj(e) || (e.type !== undefined && e.type !== "workflow_agent")) continue;
    const agentId = s(e.agentId);
    if (!agentId) continue;
    const a: RecordAgent = { agentId, cached: e.cached === true };
    const start = tsOf(e.startedAt);
    if (start !== undefined) a.startedAt = start;
    const d = n(e.durationMs);
    if (start !== undefined && d !== undefined) a.endedAt = start + d;
    out.set(agentId, a);
  }
  return out;
}

export const scriptHashOf = (script: string): string => sha256Hex(script);
export const argsHashOf = (args: unknown): string => sha256Hex(stableJson(args));

// ---------------------------------------------------------------- filesystem

export interface ClaudeWorkflowDir {
  runDir: string;
  runId: string;
  hostSessionId: string;
  /** <projects>/<slug>/<hostSessionId>. */
  sessionDir: string;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function ls(p: string): Promise<string[]> {
  try {
    return (await readdir(p)).sort();
  } catch {
    return [];
  }
}

/** Describes a run dir (…/<sid>/subagents/workflows/<runId>). */
export function describeRunDir(runDir: string): ClaudeWorkflowDir {
  const runId = basename(runDir);
  const sessionDir = dirname(dirname(dirname(runDir)));
  return { runDir, runId, sessionDir, hostSessionId: basename(sessionDir) };
}

/**
 * Every Claude Code workflow run dir under `root`. `root` may be the projects
 * dir, one project (slug) dir, one session dir, or a run dir itself.
 */
export async function findClaudeWorkflowDirs(root: string): Promise<ClaudeWorkflowDir[]> {
  const out: ClaudeWorkflowDir[] = [];
  const tryRun = async (dir: string) => {
    if ((await ls(dir)).includes("journal.jsonl")) out.push(describeRunDir(dir));
  };
  const trySession = async (dir: string) => {
    const wf = join(dir, "subagents", "workflows");
    for (const r of await ls(wf)) if (await isDir(join(wf, r))) await tryRun(join(wf, r));
  };
  if ((await ls(root)).includes("journal.jsonl")) {
    await tryRun(root);
    return out;
  }
  if (await isDir(join(root, "subagents", "workflows"))) {
    await trySession(root);
    return out;
  }
  for (const a of await ls(root)) {
    const pa = join(root, a);
    if (!(await isDir(pa))) continue;
    if (await isDir(join(pa, "subagents", "workflows"))) {
      await trySession(pa);
      continue;
    }
    for (const b of await ls(pa)) {
      const pb = join(pa, b);
      if (await isDir(join(pb, "subagents", "workflows"))) await trySession(pb);
    }
  }
  return out;
}

/** Cheap change detector: journal + record sizes and mtimes. */
export async function runDirSignature(d: ClaudeWorkflowDir): Promise<string> {
  const parts: (string | number)[] = [];
  for (const p of [join(d.runDir, "journal.jsonl"), join(d.sessionDir, "workflows", `${d.runId}.json`)]) {
    try {
      const st = await stat(p);
      parts.push(p, st.size, Math.floor(st.mtimeMs));
    } catch {
      parts.push(p, "-");
    }
  }
  for (const f of await ls(d.runDir)) {
    if (!f.endsWith(".jsonl") || f === "journal.jsonl") continue;
    try {
      const st = await stat(join(d.runDir, f));
      parts.push(f, st.size, Math.floor(st.mtimeMs));
    } catch {
      // vanished mid-scan
    }
  }
  return hashParts(...parts);
}

class MemBlobShim {
  async put(data: string | Uint8Array): Promise<string> {
    return sha256Hex(data);
  }
}

export interface LoadedClaudeWorkflow {
  dir: ClaudeWorkflowDir;
  sources: TreeSources;
  /** Child-session events (for the index; the viewer's session timeline). */
  events: AgentEvent[];
  sessions: Session[];
  signature: string;
}

export interface LoadOpts {
  /** Blob store for large transcript payloads (default: hash only, nothing kept). */
  blobs?: Pick<BlobStore, "put">;
  maxInlineBytes?: number;
  concurrencyCap?: number;
  /**
   * Price each agent's model calls that carry tokens but no reported cost (Claude
   * Code transcripts carry none), so nodes and child sessions get an estimated
   * `usage.costUsd`. Pass the effective prices (`pricesFor(config.pricing)`), as
   * ingest does. Omit to leave calls uncosted (a reported cost always wins).
   */
  prices?: Prices;
}

/** Reads one run dir and its persisted record into TreeSources (plus child sessions). */
export async function loadClaudeWorkflowDir(runDirOrDesc: string | ClaudeWorkflowDir, opts: LoadOpts = {}): Promise<LoadedClaudeWorkflow> {
  const dir = typeof runDirOrDesc === "string" ? describeRunDir(runDirOrDesc) : runDirOrDesc;
  const journal = await readFile(join(dir.runDir, "journal.jsonl"), "utf8");
  let record: Record<string, unknown> | undefined;
  try {
    const v = JSON.parse(await readFile(join(dir.sessionDir, "workflows", `${dir.runId}.json`), "utf8")) as unknown;
    if (isObj(v)) record = v;
  } catch {
    // no persisted record (older version, or run still going)
  }
  const parsed = parseJournal(journal);
  let script = s(record?.script);
  const scriptPath = s(record?.scriptPath) ?? parsed.scriptPath;
  if (script === undefined && scriptPath) {
    try {
      script = await readFile(scriptPath, "utf8");
    } catch {
      // script moved or deleted
    }
  }

  const blobs = opts.blobs ?? new MemBlobShim();
  const ctx: NormalizeContext = { blob: (d) => blobs.put(d), maxInlineBytes: opts.maxInlineBytes ?? 4096, id: (...p) => hashParts(...p) };
  const meta: Record<string, Record<string, unknown>> = {};
  const agentEvents: Record<string, AgentEvent[]> = {};
  const sessions: Session[] = [];
  const events: AgentEvent[] = [];
  const runId = s(record?.runId) ?? parsed.runId ?? dir.runId;
  for (const f of await ls(dir.runDir)) {
    const m = /^agent-(.+)\.jsonl$/.exec(f);
    if (!m) continue;
    const agentId = m[1]!;
    try {
      const v = JSON.parse(await readFile(join(dir.runDir, `agent-${agentId}.meta.json`), "utf8")) as unknown;
      if (isObj(v)) meta[agentId] = v;
    } catch {
      // no sidecar
    }
    const sessionId = childSessionId(dir.hostSessionId, agentId);
    const conv = new ClaudeTranscriptConverter(ctx, { agent: CLAUDE_AGENT, mode: "full", sessionId, subagentId: agentId, source: f, sidechain: true });
    try {
      for await (const r of readJsonl(join(dir.runDir, f))) await conv.add(r.value, r.lineNo);
    } catch {
      continue; // unreadable transcript: the node keeps journal data only
    }
    const raw = await conv.finish();
    if (!raw.length) continue;
    // Claude Code transcripts carry tokens but no per-call cost, so price them
    // here (a reported cost would win); nodes and child sessions then show cost.
    const evs = opts.prices ? applyPricing(raw, opts.prices) : raw;
    const start = evs.find((e) => e.kind === "session.start");
    if (start) start.payload = { ...start.payload, source: "workflow-agent", workflowRunId: runId, ...parentLink(ctx, CLAUDE_AGENT, dir.hostSessionId, agentId, WORKFLOW_AGENT_TYPE) };
    const session = buildSession(evs);
    agentEvents[agentId] = evs;
    sessions.push(session);
    events.push(...evs);
  }
  const sources: TreeSources = {
    journal,
    meta,
    transcripts: sessions,
    agentEvents,
    hostSessionId: dir.hostSessionId,
    framework: "claude-code-workflow",
    runId,
  };
  if (record) sources.record = record;
  if (script !== undefined) sources.script = script;
  if (opts.concurrencyCap !== undefined) sources.concurrencyCap = opts.concurrencyCap;
  return { dir, sources, events, sessions, signature: await runDirSignature(dir) };
}
