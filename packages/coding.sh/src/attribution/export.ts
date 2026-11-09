// Agent Trace export (agent-trace.dev, RFC 0.1.0): one trace record per
// commit that has agent lines. `vcs.revision` is the commit, line numbers are
// the commit's own (so `git blame` then the record answers who wrote a line),
// and each captured session is one conversation with an `ai` contributor.
//
// The record's `version` is "0.1": the RFC's schema requires major.minor
// (`^[0-9]+\.[0-9]+$`), though its prose example says "0.1.0". `id` is derived
// from the commit, so exporting again gives the same records. `timestamp` is
// the commit time. coding.sh's own fields go under metadata["sh.coding"].
// validateAgentTrace checks a record against the schema; export runs it on
// every record it writes.
import { createHash } from "node:crypto";
import type { AttributionReport } from "./index.ts";
import type { CommitAttribution } from "./match.ts";

export const AGENT_TRACE_VERSION = "0.1";
export const METADATA_KEY = "sh.coding";
export const DEFAULT_VIEWER_URL = "http://127.0.0.1:4319";

export interface AgentTraceContributor {
  type: "human" | "ai" | "mixed" | "unknown";
  model_id?: string;
}

export interface AgentTraceRange {
  start_line: number;
  end_line: number;
  content_hash?: string;
  contributor?: AgentTraceContributor;
}

export interface AgentTraceConversation {
  url?: string;
  contributor?: AgentTraceContributor;
  ranges: AgentTraceRange[];
  related?: { type: string; url: string }[];
}

export interface AgentTraceRecord {
  version: string;
  id: string;
  timestamp: string;
  vcs?: { type: "git" | "jj" | "hg" | "svn"; revision: string };
  tool?: { name?: string; version?: string };
  files: { path: string; conversations: AgentTraceConversation[] }[];
  metadata?: Record<string, unknown>;
}

const PROVIDERS: [RegExp, string][] = [
  [/^claude|^anthropic/, "anthropic"],
  [/^(gpt|o\d|codex|chatgpt|davinci)/, "openai"],
  [/^(gemini|gemma)/, "google"],
  [/^grok/, "xai"],
  [/^deepseek/, "deepseek"],
  [/^(mistral|codestral|devstral|magistral)/, "mistral"],
  [/^(llama|meta-llama)/, "meta"],
  [/^qwen/, "alibaba"],
  [/^kimi/, "moonshotai"],
  [/^glm/, "zhipuai"],
];

/** A session model as models.dev `provider/model`; undefined when the provider is unknown. */
export function modelId(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = model.trim();
  if (!m) return undefined;
  if (m.includes("/")) return m.slice(0, 250);
  const lower = m.toLowerCase();
  const p = PROVIDERS.find(([re]) => re.test(lower));
  return p ? `${p[1]}/${m}`.slice(0, 250) : undefined;
}

/** A stable UUID (version 8, RFC 9562) from a name. */
export function stableUuid(name: string): string {
  const h = createHash("sha256").update(name).digest();
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export interface ExportOptions {
  /** coding.sh version for `tool.version`. */
  toolVersion?: string;
  /** Viewer base URL for conversation links (`<url>/#/s/<id>`). */
  viewerUrl?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function commitRecord(c: CommitAttribution, opts: ExportOptions = {}): AgentTraceRecord | undefined {
  if (!c.attributions.length) return undefined;
  const base = (opts.viewerUrl ?? DEFAULT_VIEWER_URL).replace(/\/+$/, "");
  const files = new Map<string, AgentTraceConversation[]>();
  for (const a of c.attributions) {
    const convs = files.get(a.path) ?? [];
    files.set(a.path, convs);
    const model = modelId(a.model);
    const conv: AgentTraceConversation = {
      contributor: { type: "ai", ...(model ? { model_id: model } : {}) },
      ranges: a.ranges.map((r) => ({ start_line: r.start, end_line: r.end, content_hash: r.contentHash })),
    };
    if (a.source === "coding.sh") {
      const url = `${base}/#/s/${encodeURIComponent(a.sessionId)}`;
      conv.url = url;
      conv.related = [{ type: "session", url }];
    }
    convs.push(conv);
  }
  const sessions = new Map<string, { id: string; agent: string; model?: string; lines: number; confidence: number; method: string; source: string }>();
  let weighted = 0;
  for (const a of c.attributions) {
    weighted += a.confidence * a.lines;
    const s = sessions.get(a.sessionId);
    if (s) {
      s.confidence = round2((s.confidence * s.lines + a.confidence * a.lines) / (s.lines + a.lines));
      s.lines += a.lines;
    } else sessions.set(a.sessionId, { id: a.sessionId, agent: a.agent, ...(a.model ? { model: a.model } : {}), lines: a.lines, confidence: a.confidence, method: a.method, source: a.source });
  }
  return {
    version: AGENT_TRACE_VERSION,
    id: stableUuid(`agent-trace:${c.commit}`),
    timestamp: new Date(c.committedAt).toISOString().replace(/\.000Z$/, "Z"),
    vcs: { type: "git", revision: c.commit },
    tool: { name: "coding.sh", ...(opts.toolVersion ? { version: opts.toolVersion } : {}) },
    files: [...files].map(([path, conversations]) => ({ path, conversations })),
    metadata: {
      confidence: c.attributed ? round2(weighted / c.attributed) : 0,
      [METADATA_KEY]: { subject: c.subject, linesAdded: c.added, linesAttributed: c.attributed, sessions: [...sessions.values()] },
    },
  };
}

/** One record per commit with agent lines, oldest first. Throws when a record fails the schema (a bug). */
export function agentTraceRecords(report: AttributionReport, opts: ExportOptions = {}): AgentTraceRecord[] {
  const out: AgentTraceRecord[] = [];
  for (const c of report.commits) {
    const r = commitRecord(c, opts);
    if (!r) continue;
    const errors = validateAgentTrace(r);
    if (errors.length) throw new Error(`agent-trace record for ${c.commit} is invalid: ${errors.join("; ")}`);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- validation

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const URI = /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/;
const CONTRIBUTOR_TYPES = new Set(["human", "ai", "mixed", "unknown"]);
const VCS_TYPES = new Set(["git", "jj", "hg", "svn"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function contributorErrors(v: unknown, at: string): string[] {
  if (!isObj(v)) return [`${at}: must be an object`];
  const e: string[] = [];
  if (typeof v.type !== "string" || !CONTRIBUTOR_TYPES.has(v.type)) e.push(`${at}.type: must be one of human, ai, mixed, unknown`);
  if (v.model_id !== undefined && (typeof v.model_id !== "string" || v.model_id.length > 250)) e.push(`${at}.model_id: must be a string of at most 250 characters`);
  return e;
}

/** Schema errors of an Agent Trace record (RFC 0.1.0 trace-record schema); [] when valid. */
export function validateAgentTrace(rec: unknown): string[] {
  if (!isObj(rec)) return ["record: must be an object"];
  const e: string[] = [];
  for (const k of ["version", "id", "timestamp", "files"]) if (rec[k] === undefined) e.push(`${k}: required`);
  if (rec.version !== undefined && (typeof rec.version !== "string" || !/^[0-9]+\.[0-9]+$/.test(rec.version))) e.push("version: must match ^[0-9]+\\.[0-9]+$");
  if (rec.id !== undefined && (typeof rec.id !== "string" || !UUID.test(rec.id))) e.push("id: must be a UUID");
  if (rec.timestamp !== undefined && (typeof rec.timestamp !== "string" || !DATE_TIME.test(rec.timestamp))) e.push("timestamp: must be an RFC 3339 date-time");
  if (rec.vcs !== undefined) {
    if (!isObj(rec.vcs)) e.push("vcs: must be an object");
    else {
      if (typeof rec.vcs.type !== "string" || !VCS_TYPES.has(rec.vcs.type)) e.push("vcs.type: must be one of git, jj, hg, svn");
      if (typeof rec.vcs.revision !== "string") e.push("vcs.revision: required string");
    }
  }
  if (rec.tool !== undefined) {
    if (!isObj(rec.tool)) e.push("tool: must be an object");
    else for (const k of ["name", "version"]) if (rec.tool[k] !== undefined && typeof rec.tool[k] !== "string") e.push(`tool.${k}: must be a string`);
  }
  if (rec.metadata !== undefined && !isObj(rec.metadata)) e.push("metadata: must be an object");
  if (rec.files !== undefined) {
    if (!Array.isArray(rec.files)) e.push("files: must be an array");
    else
      rec.files.forEach((f, i) => {
        const at = `files[${i}]`;
        if (!isObj(f)) return void e.push(`${at}: must be an object`);
        if (typeof f.path !== "string") e.push(`${at}.path: required string`);
        if (!Array.isArray(f.conversations)) return void e.push(`${at}.conversations: required array`);
        f.conversations.forEach((c, j) => {
          const cat = `${at}.conversations[${j}]`;
          if (!isObj(c)) return void e.push(`${cat}: must be an object`);
          if (c.url !== undefined && (typeof c.url !== "string" || !URI.test(c.url))) e.push(`${cat}.url: must be a URI`);
          if (c.contributor !== undefined) e.push(...contributorErrors(c.contributor, `${cat}.contributor`));
          if (!Array.isArray(c.ranges)) e.push(`${cat}.ranges: required array`);
          else
            c.ranges.forEach((r, k) => {
              const rat = `${cat}.ranges[${k}]`;
              if (!isObj(r)) return void e.push(`${rat}: must be an object`);
              for (const key of ["start_line", "end_line"]) if (!isInt(r[key]) || (r[key] as number) < 1) e.push(`${rat}.${key}: required integer >= 1`);
              if (r.content_hash !== undefined && typeof r.content_hash !== "string") e.push(`${rat}.content_hash: must be a string`);
              if (r.contributor !== undefined) e.push(...contributorErrors(r.contributor, `${rat}.contributor`));
            });
          if (c.related !== undefined) {
            if (!Array.isArray(c.related)) e.push(`${cat}.related: must be an array`);
            else
              c.related.forEach((x, k) => {
                if (!isObj(x) || typeof x.type !== "string" || typeof x.url !== "string" || !URI.test(x.url)) e.push(`${cat}.related[${k}]: needs type and a URI url`);
              });
          }
        });
      });
  }
  return e;
}
