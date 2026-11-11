// A trace for `judge grade --trace <file>`: the agent's headless stdout or a
// transcript, turned into the events checklist checks and judges read.
//
// Understood, as JSONL or one JSON array (or a request body with `messages` /
// `input`):
//   - Claude Code stream-json (`claude -p --output-format stream-json`) and
//     Claude transcripts: assistant tool_use blocks become tool.start, user
//     tool_result blocks tool.end, assistant text assistant.message.
//   - Codex `codex exec --json`: command_execution, mcp_tool_call, file_change
//     and web_search items become one tool.start and one tool.end each;
//     agent_message becomes assistant.message.
//   - Cursor `-p --output-format stream-json`: `type: "tool_call"` records
//     (started / completed, keyed by call_id), plus Claude-shaped messages.
//   - OpenAI chat messages (assistant tool_calls, role "tool" results) and
//     Responses items (function_call / function_call_output on call_id).
//   - coding.sh events ({"kind": …, "payload": …}), e.g. from `sessions show --json`.
// Anything else yields no events. traceCoverage() says whether every tool call
// in the source reached the events, every line parsed and every record was
// read, so a judge never grades a trace with holes (arXiv 2611.02676: blank
// steps that still matched their hashes).
import type { TraceEvent } from "../datasets/types.ts";
import { eventText } from "./prompt.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

interface Source {
  /** One record per JSON object; a request body's `messages` / `input` array is flattened into its items. */
  rows: Obj[];
  /** Lines that begin or end like a JSON record but do not parse: a cut line or a partial write. */
  unparsedLines: number;
  /** Array items that are not objects. */
  strays: number;
}

function source(text: string): Source {
  const src: Source = { rows: [], unparsedLines: 0, strays: 0 };
  const t = text.trim();
  if (!t) return src;
  const objects = (items: unknown[]): Obj[] => {
    const objs = items.filter(isObj);
    src.strays += items.length - objs.length;
    return objs;
  };
  const flat = (v: unknown): Obj[] => {
    if (Array.isArray(v)) return objects(v);
    if (!isObj(v)) return [];
    if (typeof v.kind !== "string" && typeof v.type !== "string" && typeof v.role !== "string") {
      if (Array.isArray(v.messages)) return objects(v.messages);
      if (Array.isArray(v.input)) return objects(v.input);
    }
    return [v];
  };
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      src.rows = flat(JSON.parse(t) as unknown);
      return src;
    } catch {
      // not one document: read it as JSONL
    }
  }
  for (const line of t.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("{")) {
      // The tail of a record whose head was cut off; any other text is a log line.
      if (l.endsWith("}")) src.unparsedLines++;
      continue;
    }
    try {
      src.rows.push(...flat(JSON.parse(l) as unknown));
    } catch {
      src.unparsedLines++;
    }
  }
  return src;
}

/** tool_result content: a string, or text blocks joined. */
function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (isObj(b) ? (str(b.text) ?? "") : typeof b === "string" ? b : "")).filter(Boolean).join("\n");
  return "";
}

/** Any value as text: strings as is, text blocks joined, else JSON. */
function anyText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  const t = resultText(v);
  if (t) return t;
  if (isObj(v) && Array.isArray(v.content)) {
    const c = resultText(v.content);
    if (c) return c;
  }
  return JSON.stringify(v);
}

/** JSON-string arguments parsed; anything else as given. */
function args(v: unknown): unknown {
  if (typeof v !== "string") return v ?? {};
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

function tsOf(r: Obj): number | undefined {
  const t = r.timestamp ?? r.ts;
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/** Codex's exec_command header line; it comes before the command's own output. */
const CODEX_EXIT = /^Process exited with code (-?\d+)[ \t]*\r?$/m;
/** A line that only states an exit code: "exit code 1", "Exit code: 0", "[Process exited with code 1]". */
const EXIT_LINE = /^[ \t[(]*(?:(?:process|command|shell)[ \t]+)?exit(?:ed with)?[ _]code[ \t]*[:=]?[ \t]*(-?\d+)[ \t\]).]*\r?$/gim;

/**
 * ok for a tool result that has no status field (OpenAI chat and Responses),
 * from the exit code its text states: false for non-zero, true for 0.
 * undefined when the text states none, or states both: a mention inside a
 * longer line is the command's own output and decides nothing.
 */
function statedOk(output: unknown, text: string): boolean | undefined {
  // Codex before exec_command: {"output": "…", "metadata": {"exit_code": 1}}.
  const doc = isObj(output) ? output : text.trimStart().startsWith("{") ? args(text) : undefined;
  const code = isObj(doc) && isObj(doc.metadata) ? doc.metadata.exit_code : undefined;
  if (typeof code === "number") return code === 0;
  const header = CODEX_EXIT.exec(text);
  if (header) return Number(header[1]) === 0;
  let ok: boolean | undefined;
  for (const m of text.matchAll(EXIT_LINE)) {
    const zero = Number(m[1]) === 0;
    if (ok !== undefined && ok !== zero) return undefined;
    ok = zero;
  }
  return ok;
}

/** tool.end fields for a result with no status field. */
function statelessResult(output: unknown): { ok?: boolean; output: string } {
  const text = anyText(output);
  const r: { ok?: boolean; output: string } = { output: text };
  const ok = statedOk(output, text);
  if (ok !== undefined) r.ok = ok;
  return r;
}

const CODEX_TOOL_ITEMS = new Set(["command_execution", "mcp_tool_call", "file_change", "web_search"]);
const RESPONSES_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const RESPONSES_RESULTS = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);

/** Codex exec item → tool.start input / tool.end fields. */
function codexItem(item: Obj): { tool: string; input: unknown; ok?: boolean; output?: string } {
  switch (item.type) {
    case "command_execution": {
      const code = item.exit_code;
      const r: { tool: string; input: unknown; ok?: boolean; output?: string } = { tool: "shell", input: { command: str(item.command) ?? "" }, output: str(item.aggregated_output) ?? "" };
      if (typeof code === "number") r.ok = code === 0;
      else if (item.status === "failed" || item.status === "declined") r.ok = false;
      return r;
    }
    case "mcp_tool_call": {
      const err = item.error;
      const ok = !(item.status === "failed" || (err !== undefined && err !== null));
      return { tool: `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "unknown"}`, input: args(item.arguments), ok, output: ok ? anyText(item.result) : anyText(isObj(err) ? (err.message ?? err) : err) };
    }
    case "file_change":
      return { tool: "apply_patch", input: { changes: item.changes ?? [] }, ok: item.status !== "failed", output: str(item.status) ?? "" };
    default:
      return { tool: "web_search", input: { query: str(item.query) ?? "" }, ok: item.status !== "failed", output: str(item.status) ?? "" };
  }
}

/** Cursor tool_call payload: `{ shellToolCall: { args, result } }` or `{ function: { name, arguments } }`. */
function cursorCall(tc: unknown): { tool: string; input: unknown; result: unknown } {
  if (!isObj(tc)) return { tool: "unknown", input: {}, result: undefined };
  const key = Object.keys(tc)[0] ?? "unknown";
  const body = isObj(tc[key]) ? (tc[key] as Obj) : {};
  if (key === "function") return { tool: str(body.name) ?? "unknown", input: args(body.arguments), result: body.result };
  return { tool: key.replace(/ToolCall$/, "") || key, input: body.args ?? {}, result: body.result };
}

function cursorResult(result: unknown): { ok: boolean; output: string } {
  if (!isObj(result)) return { ok: result !== undefined, output: anyText(result) };
  const success = result.success;
  if (isObj(success)) {
    const code = success.exitCode;
    const output = [str(success.stdout), str(success.stderr)].filter(Boolean).join("\n") || str(success.content) || anyText(success);
    return { ok: typeof code !== "number" || code === 0, output };
  }
  const bad = result.failure ?? result.error ?? result.rejected;
  if (bad !== undefined) {
    const output = isObj(bad) ? ([str(bad.stdout), str(bad.stderr), str(bad.message), str(bad.error)].filter(Boolean).join("\n") || anyText(bad)) : anyText(bad);
    return { ok: false, output };
  }
  return { ok: true, output: anyText(result) };
}

export function traceFromText(text: string): TraceEvent[] {
  const { rows } = source(text);
  const out: TraceEvent[] = [];
  const toolNames = new Map<string, string>();
  /** Codex items and Cursor calls whose tool.start was already emitted. */
  const started = new Set<string>();
  const push = (kind: string, payload: Obj, ts?: number) => out.push({ id: `e${out.length + 1}`, kind, ...(ts !== undefined ? { ts } : {}), payload });
  const start = (tool: string, id: string | undefined, input: unknown, ts?: number) => {
    if (id) toolNames.set(id, tool);
    push("tool.start", { tool, ...(id ? { toolUseId: id } : {}), input: input ?? {} }, ts);
  };
  const end = (id: string | undefined, fields: { tool?: string; ok?: boolean; output: string }, ts?: number) => {
    const tool = fields.tool ?? (id && toolNames.get(id)) ?? "unknown";
    push("tool.end", { tool, ...(id ? { toolUseId: id } : {}), ...(fields.ok !== undefined ? { ok: fields.ok } : {}), output: fields.output }, ts);
  };
  for (const r of rows) {
    if (typeof r.kind === "string") {
      out.push({ id: str(r.id) ?? `e${out.length + 1}`, kind: r.kind, ...(tsOf(r) !== undefined ? { ts: tsOf(r) } : {}), payload: isObj(r.payload) ? r.payload : {} });
      continue;
    }
    const type = str(r.type);
    const ts = tsOf(r);

    // Codex exec --json
    if ((type === "item.started" || type === "item.completed") && isObj(r.item)) {
      const item = r.item;
      const id = str(item.id);
      if (item.type === "agent_message") {
        if (type === "item.completed" && str(item.text)?.trim()) push("assistant.message", { text: item.text }, ts);
      } else if (item.type === "error") {
        if (type === "item.completed") push("error", { message: str(item.message) ?? "" }, ts);
      } else if (typeof item.type === "string" && CODEX_TOOL_ITEMS.has(item.type)) {
        const f = codexItem(item);
        if (!id || !started.has(id)) {
          start(f.tool, id, f.input, ts);
          if (id) started.add(id);
        }
        if (type === "item.completed") end(id, { tool: f.tool, ...(f.ok !== undefined ? { ok: f.ok } : {}), output: f.output ?? "" }, ts);
      }
      continue;
    }

    // Cursor stream-json tool calls
    if (type === "tool_call") {
      const id = str(r.call_id);
      const c = cursorCall(r.tool_call);
      if (!id || !started.has(id)) {
        start(c.tool, id, c.input, ts);
        if (id) started.add(id);
      }
      if (r.subtype === "completed") end(id, { tool: c.tool, ...cursorResult(c.result) }, ts);
      continue;
    }

    // OpenAI Responses items
    if (type && RESPONSES_CALLS.has(type)) {
      const id = str(r.call_id) ?? str(r.id);
      const input = type === "custom_tool_call" ? (r.input ?? "") : type === "local_shell_call" ? (r.action ?? {}) : args(r.arguments);
      start(str(r.name) ?? (type === "local_shell_call" ? "shell" : "unknown"), id, input, ts);
      continue;
    }
    if (type && RESPONSES_RESULTS.has(type)) {
      end(str(r.call_id), statelessResult(r.output), ts);
      continue;
    }

    // OpenAI chat messages (and Responses `message` items)
    if (typeof r.role === "string" && type !== "assistant" && type !== "user") {
      const role = r.role;
      const text = resultText(r.content).trim() ? resultText(r.content) : "";
      if (role === "assistant") {
        if (text) push("assistant.message", { text }, ts);
        for (const tc of Array.isArray(r.tool_calls) ? r.tool_calls : []) {
          if (!isObj(tc)) continue;
          const fn = isObj(tc.function) ? tc.function : {};
          start(str(fn.name) ?? str(tc.name) ?? "unknown", str(tc.id), args(fn.arguments ?? tc.arguments), ts);
        }
      } else if (role === "tool") end(str(r.tool_call_id), statelessResult(r.content), ts);
      else if (role === "user" && text) push("user.message", { text }, ts);
      continue;
    }

    // Claude stream-json and transcripts (Cursor's messages have the same shape)
    if (type !== "assistant" && type !== "user") continue;
    const msg = isObj(r.message) ? r.message : {};
    const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
    for (const b of content) {
      if (!isObj(b)) continue;
      if (type === "assistant" && b.type === "text" && str(b.text)?.trim()) push("assistant.message", { text: b.text }, ts);
      else if (type === "assistant" && b.type === "tool_use") start(str(b.name) ?? "unknown", str(b.id), b.input ?? {}, ts);
      else if (type === "user" && b.type === "tool_result") {
        const id = str(b.tool_use_id);
        end(id, { ok: b.is_error !== true, output: resultText(b.content) }, ts);
      } else if (type === "user" && b.type === "text" && str(b.text)?.trim()) push("user.message", { text: b.text }, ts);
    }
  }
  return out;
}

// ---------------------------------------------------------------- coverage

export type TraceFormat = "claude" | "codex-exec" | "cursor" | "openai-chat" | "openai-responses" | "coding.sh" | "mixed" | "unknown";

export interface TraceCoverage {
  format: TraceFormat;
  /** JSON records in the source. 0 for plain text. */
  records: number;
  /** Lines that begin or end like a JSON record but do not parse: the file was cut, or a write was partial. */
  unparsedLines: number;
  /** Records no format accounts for: every record of an unknown format, a record with no type, role or kind, an array item that is not an object. */
  unreadRecords: number;
  /** Tool calls in the source, counted by a structural scan of the records (not by the parser). */
  sourceCalls: number;
  /** Tool results in the source, counted the same way. */
  sourceResults: number;
  /** tool.start / tool.end events that reached the trace. */
  toolStarts: number;
  toolEnds: number;
  /** tool.start toolUseIds with no tool.end. */
  unmatchedCalls: string[];
  /** tool.end toolUseIds with no tool.start. */
  unmatchedResults: string[];
  /** Events that render as an empty line for the judge. */
  blankEvents: string[];
  /** False when calls or results were dropped, an event is blank, a line did not parse, a record was not read, or non-empty text has no JSON record. */
  ok: boolean;
}

type Family = Exclude<TraceFormat, "mixed" | "unknown">;

/** The format family of one record, or undefined when it says nothing about the format. */
function familyOf(r: Obj): Family | "claude-like" | "claude-meta" | undefined {
  if (typeof r.kind === "string") return "coding.sh";
  const type = str(r.type);
  if (type && /^(item|thread|turn)\./.test(type)) return "codex-exec";
  if (type === "tool_call") return "cursor";
  if (type && (RESPONSES_CALLS.has(type) || RESPONSES_RESULTS.has(type) || type === "message" || type === "reasoning")) return "openai-responses";
  if ((type === "assistant" || type === "user") && isObj(r.message)) return "claude-like";
  if (typeof r.role === "string") return "openai-chat";
  if (type === "system" || type === "result") return "claude-meta";
  return undefined;
}

/** Calls and results by id, found anywhere in a record (bounded depth), independent of traceFromText. */
function scan(r: Obj, calls: Set<string>, results: Set<string>, anon: { n: number }): void {
  const key = (v: unknown) => (typeof v === "string" && v ? v : `#${++anon.n}`);
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6) return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    const type = str(node.type);
    if (typeof node.kind === "string" && depth === 0) {
      const p = isObj(node.payload) ? node.payload : {};
      if (node.kind === "tool.start") calls.add(key(p.toolUseId ?? node.id));
      else if (node.kind === "tool.end") results.add(key(p.toolUseId ?? node.id));
      return;
    }
    if ((type === "item.started" || type === "item.completed" || type === "item.updated") && isObj(node.item)) {
      const it = node.item;
      if (typeof it.type === "string" && CODEX_TOOL_ITEMS.has(it.type)) {
        const id = key(it.id);
        calls.add(id);
        if (type === "item.completed") results.add(id);
      }
      return;
    }
    if (type === "tool_call" && (node.call_id !== undefined || node.tool_call !== undefined || node.subtype !== undefined)) {
      const id = key(node.call_id);
      calls.add(id);
      if (node.subtype === "completed") results.add(id);
      return;
    }
    if (type === "tool_use" || (type && RESPONSES_CALLS.has(type))) calls.add(key(node.id ?? node.call_id));
    else if (type === "tool_result" || (type && RESPONSES_RESULTS.has(type))) results.add(key(node.tool_use_id ?? node.call_id));
    else if (type && /tool[_-]?call|function[_-]?call|tool[_-]?use/i.test(type)) {
      if (/output|result|response/i.test(type)) results.add(key(node.call_id ?? node.tool_call_id ?? node.tool_use_id ?? node.id));
      else calls.add(key(node.id ?? node.call_id));
    }
    if (node.role === "tool" && node.tool_call_id !== undefined) results.add(key(node.tool_call_id));
    if (Array.isArray(node.tool_calls)) for (const tc of node.tool_calls) if (isObj(tc)) calls.add(key(tc.id));
    for (const [k, v] of Object.entries(node)) if (k !== "tool_calls" && (isObj(v) || Array.isArray(v))) visit(v, depth + 1);
  };
  visit(r, 0);
}

/**
 * Did every tool call in `text` reach `events` (the trace parsed from it)?
 * Counts come from a separate structural scan of the raw records, so a parser
 * that drops a format's calls shows up as toolStarts < sourceCalls. A cut line
 * and a record no format accounts for are holes too. Text with no JSON record
 * is an unknown format; only an empty file has nothing to drop.
 */
export function traceCoverage(text: string, events: readonly TraceEvent[]): TraceCoverage {
  const { rows, unparsedLines, strays } = source(text);
  const families = new Set<string>();
  const calls = new Set<string>();
  const results = new Set<string>();
  const anon = { n: 0 };
  /** Records with no type, role or kind: no format says what they are. */
  let shapeless = 0;
  for (const r of rows) {
    const f = familyOf(r);
    if (f) families.add(f);
    else if (typeof r.type !== "string") shapeless++;
    scan(r, calls, results, anon);
  }
  if (families.has("cursor") && families.has("claude-like")) families.delete("claude-like");
  if (families.has("claude-meta") && families.size > 1) families.delete("claude-meta");
  if (families.has("claude-like") || families.has("claude-meta")) {
    families.delete("claude-like");
    families.delete("claude-meta");
    families.add("claude");
  }
  // Codex's Responses input carries `message` items next to its function calls: one family.
  if (families.has("openai-responses") && families.has("openai-chat")) families.delete("openai-chat");
  const format: TraceFormat = families.size === 0 ? "unknown" : families.size === 1 ? ([...families][0] as Family) : "mixed";

  const starts = events.filter((e) => e.kind === "tool.start");
  const ends = events.filter((e) => e.kind === "tool.end");
  const idOf = (e: TraceEvent) => str(e.payload?.toolUseId);
  const startIds = new Set(starts.map(idOf).filter((x): x is string => !!x));
  const endIds = new Set(ends.map(idOf).filter((x): x is string => !!x));
  const unmatchedCalls = [...startIds].filter((id) => !endIds.has(id));
  const unmatchedResults = [...endIds].filter((id) => !startIds.has(id));
  const blankEvents = events.filter((e) => eventText(e).trim() === "").map((e) => e.id);
  // In a known format, a record with a type the judge has no use for is that format's metadata
  // (a Claude transcript has a dozen such types); a tool call inside one still shows up in the scan.
  const unreadRecords = strays + (format === "unknown" ? rows.length : shapeless);
  const noRecords = rows.length === 0 && text.trim() !== "";
  const ok = starts.length >= calls.size && ends.length >= results.size && blankEvents.length === 0 && unparsedLines === 0 && unreadRecords === 0 && !noRecords;
  return {
    format,
    records: rows.length,
    unparsedLines,
    unreadRecords,
    sourceCalls: calls.size,
    sourceResults: results.size,
    toolStarts: starts.length,
    toolEnds: ends.length,
    unmatchedCalls,
    unmatchedResults,
    blankEvents,
    ok,
  };
}

/** One line on why coverage failed, for `judge grade`. */
export function describeCoverage(c: TraceCoverage): string {
  const parts: string[] = [];
  if (c.toolStarts < c.sourceCalls) parts.push(`trace has ${c.sourceCalls} tool call(s) in ${c.format} records but ${c.toolStarts} reached the judge`);
  if (c.toolEnds < c.sourceResults) parts.push(`${c.sourceResults} tool result(s) in the source but ${c.toolEnds} reached the judge`);
  if (c.blankEvents.length) parts.push(`${c.blankEvents.length} event(s) render blank (${c.blankEvents.slice(0, 5).join(", ")}${c.blankEvents.length > 5 ? ", …" : ""})`);
  if (c.format === "unknown" && c.records > 0) parts.push(`${c.records} JSON record(s) in a format the judge does not read`);
  else if (c.records === 0 && !c.ok) parts.push("the file has no JSON records (not a trace format the judge reads)");
  else if (c.unreadRecords > 0) parts.push(`${c.unreadRecords} record(s) with no type, role or kind, which the judge does not read`);
  if (c.unparsedLines > 0) parts.push(`${c.unparsedLines} line(s) are not whole JSON (a cut or partial write)`);
  return parts.join("; ") || "trace complete";
}
