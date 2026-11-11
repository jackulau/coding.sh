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

/**
 * What the `error` key of `--where` matches: payload.error when it is text. The SQLite
 * index keeps it in events.error (written with the event, and again by anything that
 * rewrites a payload), so a query reads the events_error index, not the payloads.
 */
/**
 * IndexStore.putDataset was given a parent version (`opts.parent`) and "latest" is
 * another one: someone else stored a version in between. Read again, merge, retry.
 * Matched by name, so a store plugin's bundled copy of this class still counts.
 */
export class DatasetConflict extends Error {
  readonly reason = "dataset_conflict";
  constructor(id: string, parent: string | null, latest: string | undefined) {
    super(`dataset ${id}: latest is ${latest ?? "unset"}, not ${parent ?? "unset"}`);
    this.name = "DatasetConflict";
  }
  static override [Symbol.hasInstance](x: unknown): boolean {
    return x instanceof Error && x.name === "DatasetConflict";
  }
}

export function errorText(payload: Record<string, unknown> | undefined): string | null {
  return typeof payload?.error === "string" ? payload.error : null;
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
 * Builds a safe FTS5 MATCH expression: every term must appear as a word, and the
 * last one as a word prefix, since it is the one still being typed ("refactor
 * tokeni" finds "refactor the tokenizer", not "refactored the tokenizer"). A
 * prefix on every term made "the fix" expand "the" to every word starting with it.
 * Terms are quoted, so user input can never inject FTS syntax.
 */
export function ftsQuery(text: string): string | undefined {
  const terms = searchTerms(text);
  if (!terms.length) return undefined;
  return terms.map((t, i) => `"${t.replace(/"/g, '""')}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
}

/** Whether a folded word matches term `i` of `terms` (the ftsQuery rule: the last term is a prefix). */
export function termMatches(word: string, terms: readonly string[], i: number): boolean {
  return i === terms.length - 1 ? word.startsWith(terms[i]!) : word === terms[i];
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

/** Where a stored eval document keeps blob refs. `shape`: one ref, an array of refs, or a name → ref map. */
export interface BlobRefField {
  table: "tasks" | "bundles" | "runs";
  path: readonly string[];
  shape: "ref" | "list" | "map";
}

/**
 * Every blob ref a task, bundle or run document holds. gc keeps exactly these
 * (plus event blobs), so a new field that stores a ref must be listed here:
 * the memory store walks this list in JS, SQLite and Postgres build their
 * referencedBlobs SQL from it.
 */
export const BLOB_REF_FIELDS: readonly BlobRefField[] = [
  { table: "tasks", path: ["referencePatch"], shape: "ref" },
  { table: "tasks", path: ["nearMissPatches"], shape: "list" },
  { table: "tasks", path: ["verifier", "hiddenFiles"], shape: "map" },
  { table: "tasks", path: ["validation", "impossible", "variant", "hiddenFiles"], shape: "map" },
  { table: "bundles", path: ["files"], shape: "map" },
  { table: "runs", path: ["diffBlob"], shape: "ref" },
  { table: "runs", path: ["tapBlob"], shape: "ref" },
];

/** The refs at one field of a document; anything not of the field's shape yields none. */
export function refsAt(doc: unknown, f: BlobRefField): BlobRef[] {
  let v: unknown = doc;
  for (const k of f.path) v = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
  const strings = (xs: unknown[]) => xs.filter((x): x is string => typeof x === "string");
  if (f.shape === "ref") return typeof v === "string" ? [v] : [];
  if (f.shape === "list") return Array.isArray(v) ? strings(v) : [];
  return v && typeof v === "object" && !Array.isArray(v) ? strings(Object.values(v)) : [];
}

const blobsOf = (table: BlobRefField["table"], doc: unknown): BlobRef[] =>
  BLOB_REF_FIELDS.filter((f) => f.table === table).flatMap((f) => refsAt(doc, f));

/** Blob refs held by a task (patches, hidden verifier files, impossible-variant hidden files). */
export function taskBlobs(t: EvalTask): BlobRef[] {
  return blobsOf("tasks", t);
}

export function bundleBlobs(b: HarnessBundle): BlobRef[] {
  return blobsOf("bundles", b);
}

/** Blob refs held by a run (its diff and, for toolevals trials, the tap log). */
export function runBlobs(r: RunResult): BlobRef[] {
  return blobsOf("runs", r);
}

/**
 * Plain-text snippet around the first matching word, matches wrapped in «».
 * `terms` are folded search terms (searchTerms). Stores without a native
 * snippet function (memory, postgres) use this so snippets look the same.
 */
/**
 * A query with no word for the tokenizer (emoji, arrows, other symbols): the trimmed
 * text itself, to find as a substring of event text. Undefined when it has words
 * (FTS answers it) or nothing at all.
 */
export function symbolQuery(text: string): string | undefined {
  let needle = text.trim();
  // A quoted phrase ('"🚀"') searches for what is inside the quotes, as a quoted word does.
  const quoted = /^"(.*)"$/s.exec(needle);
  if (quoted) needle = quoted[1]!.trim();
  return needle && !searchTerms(needle).length ? needle : undefined;
}

/** Up to SYMBOL_SNIPPET_CHARS of text on each side of the first `needle`, the match marked. */
export function symbolSnippet(text: string, needle: string): string {
  const at = text.indexOf(needle);
  if (at < 0) return text.slice(0, 2 * SYMBOL_SNIPPET_CHARS);
  // Never cut a surrogate pair (an emoji) in half.
  const low = (i: number) => i > 0 && i < text.length && (text.charCodeAt(i) & 0xfc00) === 0xdc00;
  let from = Math.max(0, at - SYMBOL_SNIPPET_CHARS);
  let to = Math.min(text.length, at + needle.length + SYMBOL_SNIPPET_CHARS);
  if (low(from)) from--;
  if (low(to)) to++;
  return `${from > 0 ? SNIPPET_ELLIPSIS : ""}${text.slice(from, at)}${SNIPPET_OPEN}${needle}${SNIPPET_CLOSE}${text.slice(at + needle.length, to)}${to < text.length ? SNIPPET_ELLIPSIS : ""}`;
}
const SYMBOL_SNIPPET_CHARS = 60;

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
