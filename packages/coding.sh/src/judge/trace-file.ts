// A trace for `judge grade --trace <file>`: the agent's headless stdout or a
// transcript, turned into the events checklist checks and judges read.
//
// Two inputs are understood, as JSONL or one JSON array:
//   - Claude Code stream-json (`claude -p --output-format stream-json`) and
//     Claude transcripts: assistant tool_use blocks become tool.start, user
//     tool_result blocks tool.end, assistant text assistant.message.
//   - coding.sh events ({"kind": …, "payload": …}), e.g. from `sessions show --json`.
// Anything else yields no events, so trace checks answer N/A instead of guessing.
import type { TraceEvent } from "../datasets/types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function records(text: string): Obj[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return v.filter(isObj);
    } catch {
      // not one array: read it as JSONL
    }
  }
  const out: Obj[] = [];
  for (const line of t.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try {
      const v = JSON.parse(l) as unknown;
      if (isObj(v)) out.push(v);
    } catch {
      // a log line or a partial write
    }
  }
  return out;
}

/** tool_result content: a string, or text blocks joined. */
function resultText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (isObj(b) ? (str(b.text) ?? "") : "")).filter(Boolean).join("\n");
  return "";
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

export function traceFromText(text: string): TraceEvent[] {
  const rows = records(text);
  const out: TraceEvent[] = [];
  const toolNames = new Map<string, string>();
  const push = (kind: string, payload: Obj, ts?: number) => out.push({ id: `e${out.length + 1}`, kind, ...(ts !== undefined ? { ts } : {}), payload });
  for (const r of rows) {
    if (typeof r.kind === "string") {
      out.push({ id: str(r.id) ?? `e${out.length + 1}`, kind: r.kind, ...(tsOf(r) !== undefined ? { ts: tsOf(r) } : {}), payload: isObj(r.payload) ? r.payload : {} });
      continue;
    }
    const type = str(r.type);
    if (type !== "assistant" && type !== "user") continue;
    const msg = isObj(r.message) ? r.message : {};
    const content = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : [];
    const ts = tsOf(r);
    for (const b of content) {
      if (!isObj(b)) continue;
      if (type === "assistant" && b.type === "text" && str(b.text)?.trim()) push("assistant.message", { text: b.text }, ts);
      else if (type === "assistant" && b.type === "tool_use") {
        const tool = str(b.name) ?? "unknown";
        const id = str(b.id);
        if (id) toolNames.set(id, tool);
        push("tool.start", { tool, ...(id ? { toolUseId: id } : {}), input: b.input ?? {} }, ts);
      } else if (type === "user" && b.type === "tool_result") {
        const id = str(b.tool_use_id);
        push("tool.end", { tool: (id && toolNames.get(id)) ?? "unknown", ...(id ? { toolUseId: id } : {}), ok: b.is_error !== true, output: resultText(b.content) }, ts);
      } else if (type === "user" && b.type === "text" && str(b.text)?.trim()) push("user.message", { text: b.text }, ts);
    }
  }
  return out;
}
