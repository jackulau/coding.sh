// Which client sent a call, and which session it belongs to.
//
// Agents that name their session on every request land in the session their
// hooks capture, so proxy calls show up inside it:
// - Claude Code: `x-claude-code-session-id` (2.x), else `metadata.user_id`
//   (a JSON string with session_id, or the older `..._session_<uuid>` form).
// - Codex: `session-id` / `thread-id` (also inside `x-codex-turn-metadata`),
//   the thread id its hooks and rollouts use.
// - Any client: `x-coding-sh-session: <id>` picks the session explicitly.
// Otherwise the call goes to a `proxy-<hash>` session keyed by the client, the
// system prompt and the first user message, so each turn of one stateless
// conversation (its messages only grow) lands in the same session. Responses API
// calls that continue a response (`previous_response_id`) join that response's session.
import { isObj, obj, str } from "../adapters/_shared/normalize.ts";
import { hashParts } from "../core/ids.ts";
import type { RequestInfo } from "./wire.ts";

export type Headers = Record<string, string | string[] | undefined>;

export interface Client {
  /** Agent id when the client is an agent coding.sh knows ("claude-code", "codex"), else a product name or undefined. */
  id?: string;
  version?: string;
  /** Codex turn id, when sent. */
  turnId?: string;
}

export interface Link {
  sessionId: string;
  /** Agent the session belongs to: the client's agent id for a session it named, else "proxy". */
  agent: string;
  /** How the session was chosen: "header", "metadata", "previous-response", "conversation". */
  linkedBy: "header" | "metadata" | "previous-response" | "conversation";
}

const one = (h: Headers, k: string): string | undefined => {
  const v = h[k];
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() ? s.trim() : undefined;
};

const parseJson = (s: string | undefined): Record<string, unknown> => {
  if (!s) return {};
  try {
    return obj(JSON.parse(s));
  } catch {
    return {};
  }
};

/** Session ids become store keys and file names elsewhere: keep them plain. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const safe = (id: string | undefined): string | undefined => (id && SAFE_ID.test(id) ? id : undefined);

export function detectClient(h: Headers): Client {
  const ua = one(h, "user-agent") ?? "";
  const originator = one(h, "originator");
  if (one(h, "x-claude-code-session-id") || /^claude-cli\//i.test(ua) || one(h, "x-app") === "cli") {
    const c: Client = { id: "claude-code" };
    const v = /^claude-cli\/([\w.+-]+)/i.exec(ua)?.[1];
    if (v) c.version = v;
    return c;
  }
  if ((originator && /^codex/i.test(originator)) || /^codex[_-]/i.test(ua)) {
    const c: Client = { id: "codex" };
    const v = /^codex[\w-]*\/([\w.+-]+)/i.exec(ua)?.[1];
    if (v) c.version = v;
    const turn = str(parseJson(one(h, "x-codex-turn-metadata")).turn_id);
    if (turn) c.turnId = turn;
    return c;
  }
  // Another client: its product token (`OpenAI/JS 4.x`, `python-httpx/0.27`), for grouping only.
  const m = /^([A-Za-z][\w.-]*)(?:\/([\w.+-]+))?/.exec(ua);
  const c: Client = {};
  if (m) {
    c.id = m[1]!.toLowerCase();
    if (m[2]) c.version = m[2];
  }
  return c;
}

/** Claude Code's metadata.user_id: `{"session_id": …}` (2.x) or `user_<hash>_account_<uuid>_session_<uuid>` (1.x). */
export function claudeSessionFromUserId(userId: unknown): string | undefined {
  if (typeof userId !== "string") return undefined;
  if (userId.startsWith("{")) return safe(str(parseJson(userId).session_id));
  return safe(/_session_([0-9a-f-]{36})$/i.exec(userId)?.[1]);
}

/** The session a request names, if any, and how. */
export function namedSession(h: Headers, client: Client, req: RequestInfo | undefined): { id: string; by: "header" | "metadata" } | undefined {
  const explicit = safe(one(h, "x-coding-sh-session"));
  if (explicit) return { id: explicit, by: "header" };
  if (client.id === "claude-code") {
    const id = safe(one(h, "x-claude-code-session-id"));
    if (id) return { id, by: "header" };
    const fromMeta = claudeSessionFromUserId(req?.metadata?.user_id);
    if (fromMeta) return { id: fromMeta, by: "metadata" };
  }
  if (client.id === "codex") {
    const id = safe(one(h, "session-id") ?? one(h, "session_id") ?? one(h, "thread-id"));
    if (id) return { id, by: "header" };
    const meta = parseJson(one(h, "x-codex-turn-metadata"));
    const fromMeta = safe(str(meta.thread_id) ?? str(meta.session_id));
    if (fromMeta) return { id: fromMeta, by: "metadata" };
  }
  return undefined;
}

/** Stable id of a conversation whose client names no session. */
export function conversationSessionId(client: Client, req: RequestInfo | undefined, systemHash: string | undefined): string {
  const first = req?.firstPrompt ?? (isObj(req?.messages?.[0]) ? JSON.stringify(req!.messages[0]) : "");
  return `proxy-${hashParts("proxy-conversation", client.id ?? "", systemHash ?? "", first).slice(0, 16)}`;
}

/**
 * Remembers which session each Responses API response went to, so a call that
 * continues one (`previous_response_id`) joins it. Bounded (oldest dropped first).
 */
export class ResponseSessions {
  private readonly map = new Map<string, string>();
  private readonly max: number;
  constructor(max = 10_000) {
    this.max = max;
  }
  get(id: string | undefined): string | undefined {
    return id ? this.map.get(id) : undefined;
  }
  set(id: string | undefined, sessionId: string): void {
    if (!id) return;
    this.map.delete(id);
    this.map.set(id, sessionId);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

export function linkCall(h: Headers, client: Client, req: RequestInfo | undefined, systemHash: string | undefined, responses: ResponseSessions): Link {
  const named = namedSession(h, client, req);
  if (named) return { sessionId: named.id, agent: client.id === "claude-code" || client.id === "codex" ? client.id : "proxy", linkedBy: named.by };
  const prev = responses.get(req?.previousResponseId);
  if (prev) return { sessionId: prev, agent: "proxy", linkedBy: "previous-response" };
  return { sessionId: conversationSessionId(client, req, systemHash), agent: "proxy", linkedBy: "conversation" };
}
