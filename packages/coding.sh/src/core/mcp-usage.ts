// `usage --by mcp`'s narrow read. Of all a store's events, the report uses only
// the MCP tool calls (a tool.start whose payload names its server: the indexed
// `mcp` column) and the size of each call's result (its tool.end, paired by
// session and payload.toolUseId). A store can answer with just these fields
// (IndexStore.mcpCalls) instead of whole events. This file is that contract;
// mcpCallsOf is the reference, and a store's query must give the same rows.
//
// The result size is what the agent got back:
// - payload.outputBytes of the tool.end, when the source stored the size;
// - else the cut's deliveredBytes, when the harness cut the output;
// - else the bytes of the stored output (a string as is, anything else as JSON).
//   A stored output clipped to fit the index (it ends in "…" and the rest is in a
//   blob) makes that a lower bound: `clipped`.
// The result tokens are payload.outputTokens when the source stored a count; the
// report estimates the rest from the bytes.
//
// No imports beyond types: the stores load this file.
import type { AgentEvent } from "../schema/index.ts";

/** One MCP tool call as `usage --by mcp` needs it. */
export interface McpCall {
  sessionId: string;
  /** payload.server of the tool.start. */
  server: string;
  /** The model of the call's session. */
  model?: string;
  /** The tool.end's ok; undefined while the call has no end. */
  ok?: boolean;
  /** Bytes of the result (see the file header); undefined without an end. */
  resultBytes?: number;
  /** payload.outputTokens of the tool.end, when the source stored a count. */
  resultTokens?: number;
  /** The stored output was clipped and resultBytes is a lower bound. */
  clipped?: boolean;
}

/** The text clipText (adapters/_shared/normalize.ts) ends a clipped string with. */
export const CLIP_MARK = "…";

const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The result fields of a call from its tool.end. */
export function mcpResultOf(end: Pick<AgentEvent, "payload" | "blobs">): Pick<McpCall, "ok" | "resultBytes" | "resultTokens" | "clipped"> {
  const p = end.payload ?? {};
  const out: Pick<McpCall, "ok" | "resultBytes" | "resultTokens" | "clipped"> = {};
  if (typeof p.ok === "boolean") out.ok = p.ok;
  const cut = p.cut && typeof p.cut === "object" ? (p.cut as Record<string, unknown>) : undefined;
  const o = p.output;
  const stored = o === undefined || o === null ? 0 : Buffer.byteLength(typeof o === "string" ? o : JSON.stringify(o));
  const bytes = count(p.outputBytes) ?? count(cut?.deliveredBytes);
  out.resultBytes = bytes ?? stored;
  if (bytes === undefined && typeof o === "string" && o.endsWith(CLIP_MARK) && (end.blobs?.length ?? 0) > 0) out.clipped = true;
  const tokens = count(p.outputTokens);
  if (tokens !== undefined) out.resultTokens = tokens;
  return out;
}

/** The MCP calls among one session's events (any order), with their results. */
export function mcpCallsOf(events: readonly Pick<AgentEvent, "sessionId" | "kind" | "payload" | "blobs">[], model?: string): McpCall[] {
  const ends = new Map<string, Pick<AgentEvent, "payload" | "blobs">>();
  for (const e of events) {
    const id = e.payload?.toolUseId;
    if (e.kind === "tool.end" && typeof id === "string") ends.set(`${e.sessionId}\u0000${id}`, e);
  }
  const out: McpCall[] = [];
  for (const e of events) {
    const p = e.payload ?? {};
    if (e.kind !== "tool.start" || typeof p.tool !== "string" || typeof p.server !== "string" || !p.server) continue;
    const end = typeof p.toolUseId === "string" ? ends.get(`${e.sessionId}\u0000${p.toolUseId}`) : undefined;
    const call: McpCall = { sessionId: e.sessionId, server: p.server };
    if (model) call.model = model;
    out.push(end ? Object.assign(call, mcpResultOf(end)) : call);
  }
  return out;
}
