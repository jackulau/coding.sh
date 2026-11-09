// The cache key of one model call: sha256 of the request's canonical JSON
// after dropping what changes between runs without changing the call.
//
// Dropped:
// - the system prompt (Anthropic `system`, OpenAI system/developer messages,
//   Responses `instructions`), so a prompt edit still replays the calls it
//   does not change;
// - stream, stream_options, metadata, user and every `cache_control`, so a
//   moved cache breakpoint is the same call;
// - optionally tools (and tool_choice) or the model.
// Run-specific strings (run id, cwd, tmpdir, HOME) become placeholders, and a
// bare string content equals one text block.
import { sha256Hex } from "../core/ids.ts";

/** Which wire API a cached path speaks. */
export type LlmApi = "anthropic-messages" | "openai-chat" | "openai-responses";

/** The paths whose POSTs are cached (anything else is forwarded uncounted). */
export const CACHED_PATHS: Readonly<Record<string, LlmApi>> = {
  "/v1/messages": "anthropic-messages",
  "/v1/chat/completions": "openai-chat",
  "/v1/responses": "openai-responses",
};

export function apiOf(method: string, path: string): LlmApi | undefined {
  if (method.toUpperCase() !== "POST") return undefined;
  return CACHED_PATHS[path.split("?")[0]!.replace(/\/+$/, "")];
}

export const providerOf = (api: LlmApi): "anthropic" | "openai" => (api === "anthropic-messages" ? "anthropic" : "openai");

export interface KeyOptions {
  /** Leave `tools` and `tool_choice` out of the key. */
  excludeTools?: boolean;
  /** Leave `model` out of the key. */
  excludeModel?: boolean;
  /**
   * Placeholder name → the run's value (e.g. RUN → the run id, CWD → the
   * working dir). Each value in any string becomes `<NAME>`; values shorter
   * than 4 characters are ignored.
   */
  normalize?: Record<string, string | undefined>;
}

const ALWAYS_DROP = new Set(["stream", "stream_options", "metadata", "user"]);
const SYSTEM_ROLES = new Set(["system", "developer"]);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Replacements, longest value first so a cwd inside HOME becomes <CWD>, not <HOME>/…. */
function replacer(normalize: KeyOptions["normalize"]): ((s: string) => string) | undefined {
  const pairs = Object.entries(normalize ?? {})
    .filter((p): p is [string, string] => typeof p[1] === "string" && p[1].length >= 4)
    .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  if (!pairs.length) return undefined;
  return (s) => {
    let out = s;
    for (const [name, value] of pairs) if (out.includes(value)) out = out.split(value).join(`<${name}>`);
    return out;
  };
}

/** Deep copy without cache_control, with sorted keys and replaced strings. */
function canon(v: unknown, rep: ((s: string) => string) | undefined): Json {
  if (typeof v === "string") return rep ? rep(v) : v;
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x) => canon(x, rep));
  if (isObj(v)) {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(v).sort()) {
      if (k === "cache_control" || v[k] === undefined) continue;
      out[k] = canon(v[k], rep);
    }
    return out;
  }
  return null;
}

/** A message's content as blocks: "hi" and [{type:"text",text:"hi"}] are the same call. */
function contentBlocks(content: unknown): unknown {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** The request with everything that does not identify the call removed (before canonicalizing). */
export function keyView(api: LlmApi, body: unknown, opts: KeyOptions = {}): unknown {
  if (!isObj(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (ALWAYS_DROP.has(k)) continue;
    if (opts.excludeModel && k === "model") continue;
    if (opts.excludeTools && (k === "tools" || k === "tool_choice")) continue;
    if (api === "anthropic-messages" && k === "system") continue;
    if (api === "openai-responses" && k === "instructions") continue;
    out[k] = v;
  }
  if (api === "anthropic-messages" || api === "openai-chat") {
    if (Array.isArray(out.messages)) {
      out.messages = out.messages
        .filter((m) => !(api === "openai-chat" && isObj(m) && SYSTEM_ROLES.has(String(m.role))))
        .map((m) => (isObj(m) && "content" in m ? { ...m, content: contentBlocks(m.content) } : m));
    }
  } else if (Array.isArray(out.input)) {
    out.input = out.input.filter((m) => !(isObj(m) && SYSTEM_ROLES.has(String(m.role)))).map((m) => (isObj(m) && typeof m.content === "string" ? { ...m, content: [{ type: "input_text", text: m.content }] } : m));
  } else if (typeof out.input === "string") {
    out.input = [{ role: "user", content: [{ type: "input_text", text: out.input }] }];
  }
  return out;
}

/** Canonical JSON (sorted keys, no cache_control, placeholders) of what identifies the call. */
export function canonicalRequest(api: LlmApi, body: unknown, opts: KeyOptions = {}): string {
  return JSON.stringify(canon(keyView(api, body, opts), replacer(opts.normalize)));
}

/**
 * The cache key of a model call: sha256 hex of the API and the canonical
 * request. `body` is the parsed JSON; a body that is not JSON (a Buffer or a
 * string that does not parse) is keyed by its bytes.
 */
export function llmCallKey(api: LlmApi, body: unknown, opts: KeyOptions = {}): string {
  let parsed = body;
  if (typeof body === "string" || body instanceof Uint8Array) {
    const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return sha256Hex(`${api}\nraw\n${text}`);
    }
  }
  return sha256Hex(`${api}\n${canonicalRequest(api, parsed, opts)}`);
}

/** The model a request names, for the recording line. */
export function modelOf(body: unknown): string | undefined {
  return isObj(body) && typeof body.model === "string" ? body.model : undefined;
}
