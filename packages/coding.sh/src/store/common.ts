// Helpers shared by every IndexStore/BlobStore implementation so behaviour
// (search text, snippet markers, blob refs) is identical across backends.
import type { AgentEvent, BlobRef } from "../schema/index.ts";
import type { EvalTask, HarnessBundle, RunResult } from "../core/types.ts";

/** Search snippets wrap matches in these markers (plain text, safe to escape then style). */
export const SNIPPET_OPEN = "«"; // «
export const SNIPPET_CLOSE = "»"; // »
export const SNIPPET_ELLIPSIS = "…";

/** Kinds whose `payload.text` is indexed verbatim (prompts and replies). */
export const MESSAGE_SEARCH_KINDS: readonly string[] = ["user.message", "assistant.message"];

/** Every kind with searchable text: messages plus tool calls, tool output and subagent launches. */
export const SEARCHABLE_KINDS: readonly string[] = [...MESSAGE_SEARCH_KINDS, "tool.start", "tool.end", "subagent.start"];

/** Cap on indexed text for tool/subagent events, so a huge Write or tool output cannot bloat the index. */
export const TOOL_SEARCH_TEXT_CAP = 2000;

/** Input fields that say most about a tool call; indexed first so the cap never drops them. */
const KEY_INPUT_FIELDS = ["command", "cmd", "file_path", "path", "pattern", "query", "url", "description", "prompt", "skill"];

/** String/number leaves of a JSON value, depth-first, in key order. */
function leaves(v: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 200) return;
  if (typeof v === "string") {
    if (v.length) out.push(v);
  } else if (typeof v === "number" || typeof v === "boolean") {
    out.push(String(v));
  } else if (Array.isArray(v)) {
    for (const x of v) leaves(x, out, depth + 1);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) leaves(x, out, depth + 1);
  }
}

function flatten(v: unknown, priority: readonly string[] = []): string[] {
  const out: string[] = [];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of priority) leaves(o[k], out);
    for (const [k, x] of Object.entries(o)) if (!priority.includes(k)) leaves(x, out);
  } else {
    leaves(v, out);
  }
  return out;
}

function joinCapped(parts: unknown[]): string | undefined {
  const text = parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
  if (!text) return undefined;
  if (text.length <= TOOL_SEARCH_TEXT_CAP) return text;
  // Do not split a surrogate pair at the cut.
  let end = TOOL_SEARCH_TEXT_CAP;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return text.slice(0, end);
}

/**
 * The text an event is full-text indexed under, or undefined if it has none.
 * - user/assistant messages: `payload.text`, verbatim.
 * - tool.start: tool name, MCP server and the flattened input (command, file path, query first).
 * - tool.end: tool name and output.
 * - subagent.start: subagent type, description and prompt.
 * Tool and subagent text is capped at TOOL_SEARCH_TEXT_CAP characters.
 */
export function searchableText(e: AgentEvent): string | undefined {
  const p = e.payload ?? {};
  switch (e.kind) {
    case "user.message":
    case "assistant.message":
      return typeof p.text === "string" && p.text.length > 0 ? p.text : undefined;
    case "tool.start":
      return joinCapped([p.tool, p.server, ...flatten(p.input, KEY_INPUT_FIELDS)]);
    case "tool.end":
      return joinCapped([p.tool, ...flatten(p.output)]);
    case "subagent.start":
      return joinCapped([p.type, p.description, p.prompt]);
    default:
      return undefined;
  }
}

/**
 * The part of searchableText the SQLite store keeps in its own column: message
 * text is read straight from the payload, so only tool/subagent text is stored.
 */
export function storedSearchText(e: AgentEvent): string | undefined {
  return MESSAGE_SEARCH_KINDS.includes(e.kind) ? undefined : searchableText(e);
}

/** Lower-case and strip diacritics ("Café" → "cafe"), like FTS5 remove_diacritics. */
export function foldTerm(word: string): string {
  return word.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Splits free text into search terms (letters/digits, unicode-aware). Like the
 * FTS5 unicode61 tokenizer, "_" separates words, so "vision_connector.py" is
 * "vision", "connector", "py".
 */
export function searchTerms(text: string): string[] {
  return (text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).map(foldTerm);
}

/**
 * Builds a safe FTS5 MATCH expression: every term must appear as a word
 * prefix ("refactor tokeni" finds "refactored the tokenizer"). Terms are
 * quoted, so user input can never inject FTS syntax.
 */
export function ftsQuery(text: string): string | undefined {
  const terms = searchTerms(text);
  if (!terms.length) return undefined;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

export function blobPath(ref: BlobRef): [string, string, string] {
  return [ref.slice(0, 2), ref.slice(2, 4), `${ref}.zst`];
}

export function assertBlobRef(ref: unknown): asserts ref is BlobRef {
  if (typeof ref !== "string" || !/^[0-9a-f]{64}$/.test(ref)) {
    throw new Error(`invalid blob ref ${JSON.stringify(ref)}: expected 64 lowercase hex chars (sha256)`);
  }
}

export function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

/** Blob refs held by a task (patches + hidden verifier files). */
export function taskBlobs(t: EvalTask): BlobRef[] {
  const out = Object.values(t.verifier?.hiddenFiles ?? {});
  if (t.referencePatch) out.push(t.referencePatch);
  out.push(...(t.nearMissPatches ?? []));
  return out;
}

export function bundleBlobs(b: HarnessBundle): BlobRef[] {
  return Object.values(b.files ?? {});
}

export function runBlobs(r: RunResult): BlobRef[] {
  return r.diffBlob ? [r.diffBlob] : [];
}

/**
 * Plain-text snippet around the first matching word, matches wrapped in «».
 * `terms` are folded search terms (searchTerms). Stores without a native
 * snippet function (memory, postgres) use this so snippets look the same.
 */
export function snippet(text: string, terms: string[]): string {
  const re = /[\p{L}\p{M}\p{N}_]+/gu;
  const words: { start: number; end: number; hit: boolean }[] = [];
  for (const m of text.matchAll(re)) {
    const w = foldTerm(m[0]);
    words.push({ start: m.index, end: m.index + m[0].length, hit: terms.some((t) => w.startsWith(t)) });
  }
  const first = words.findIndex((w) => w.hit);
  const from = Math.max(0, first - 6);
  const to = Math.min(words.length, from + 16);
  let out = from > 0 ? SNIPPET_ELLIPSIS : "";
  let cursor = words[from]?.start ?? 0;
  for (let i = from; i < to; i++) {
    const w = words[i]!;
    out += text.slice(cursor, w.start);
    out += w.hit ? `${SNIPPET_OPEN}${text.slice(w.start, w.end)}${SNIPPET_CLOSE}` : text.slice(w.start, w.end);
    cursor = w.end;
  }
  if (to < words.length) out += SNIPPET_ELLIPSIS;
  else out += text.slice(cursor);
  return out;
}
