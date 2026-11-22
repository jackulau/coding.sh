// MCP resources: codingsh://latest and codingsh://session/<id>, each a
// markdown digest of one session. <id> takes the ids the tools take.
import { noSessionsHint } from "../cli/first-session.ts";
import type { Context } from "../core/context.ts";
import { AmbiguousRef, findSessionRef } from "../core/session-ref.ts";
import type { IndexStore } from "../core/types.ts";
import type { Session } from "../schema/index.ts";
import { clip, iso } from "./data.ts";
import { sessionMarkdown } from "./digest.ts";
import { clipText, RPC, RpcFailure, type ResourceDef, type ResourceProvider, type ResourceTemplateDef } from "./protocol.ts";

export const SCHEME = "codingsh:";
export const LATEST_URI = "codingsh://latest";
const SESSION_PREFIX = "codingsh://session/";
const PAGE = 20;

export const sessionUri = (id: string): string => `${SESSION_PREFIX}${encodeURIComponent(id)}`;

/**
 * Opaque keyset cursor over the list order (started_at DESC, id ASC): base64url
 * JSON [startedAt, id] of the last session shown. Unlike an offset, sessions
 * ingested or deleted between two pages neither repeat nor skip entries.
 */
interface Cursor {
  startedAt: number;
  id: string;
}
const encodeCursor = (s: Session): string => Buffer.from(JSON.stringify([s.startedAt, s.id])).toString("base64url");
function decodeCursor(raw: string): Cursor {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && Number.isFinite(v[0]) && typeof v[1] === "string" && v[1]) return { startedAt: v[0], id: v[1] };
  } catch {
    // fall through
  }
  throw new RpcFailure(RPC.INVALID_PARAMS, "Invalid cursor: pass the nextCursor value from the previous resources/list unchanged.");
}
const afterCursor = (s: Session, c: Cursor): boolean => s.startedAt < c.startedAt || (s.startedAt === c.startedAt && s.id > c.id);

/** Up to `limit` top-level sessions after the cursor, using only the portable until filter. */
async function pageAfter(index: IndexStore, c: Cursor, limit: number): Promise<Session[]> {
  const out: Session[] = [];
  const batch = limit + 32;
  // Rows in the cursor's own millisecond sort first; skip past them.
  for (let offset = 0; out.length < limit; offset += batch) {
    const rows = await index.listSessions({ parentSessionId: null, until: c.startedAt + 1, limit: batch, offset });
    for (const s of rows) if (afterCursor(s, c)) out.push(s);
    if (rows.length < batch) break;
  }
  return out.slice(0, limit);
}

/**
 * The session `id` in `uri` names, resolved as the tools resolve a session id (core/session-ref.ts
 * findSessionRef): the exact id, latest, a unique prefix, an SDK id without its default project or
 * a subagent's own id. Undefined when nothing matches, so the URI stays not found. A prefix several
 * sessions share fails with invalid params in both eras, listing them in the tools' words.
 */
async function sessionRef(index: IndexStore, uri: string, id: string): Promise<Session | undefined> {
  try {
    return await findSessionRef(index, id);
  } catch (e) {
    if (!(e instanceof AmbiguousRef)) throw e;
    const list = e.candidates.map((x) => `${x.shortId} (${x.agent}, ${iso(x.startedAt)}${x.title ? `, ${JSON.stringify(clip(x.title, 60))}` : ""})`);
    const candidates = e.candidates.map((x) => {
      const c: Record<string, unknown> = { sessionId: x.id, shortId: x.shortId, uri: sessionUri(x.id), agent: x.agent, startedAt: iso(x.startedAt) };
      if (x.title) c.title = clip(x.title, 120);
      return c;
    });
    const data: Record<string, unknown> = { uri: clipText(uri, 1000), reason: "ambiguous", candidates };
    if (e.more) data.more = true;
    throw new RpcFailure(RPC.INVALID_PARAMS, `Session id prefix ${JSON.stringify(id)} matches more than one session: ${list.join("; ")}${e.more ? "; and more" : ""}. Pass one of these ids, or more of the id.`, data);
  }
}

export function buildResources(store: () => Promise<Context>): ResourceProvider {
  return {
    async list(cursor) {
      const after = cursor ? decodeCursor(cursor) : undefined;
      const ctx = await store();
      const rows = after ? await pageAfter(ctx.index, after, PAGE + 1) : await ctx.index.listSessions({ parentSessionId: null, limit: PAGE + 1 });
      const resources: ResourceDef[] = [];
      if (!after) {
        resources.push({ uri: LATEST_URI, name: "latest", title: "Latest session", description: "Markdown digest of the newest top-level session.", mimeType: "text/markdown" });
      }
      for (const s of rows.slice(0, PAGE)) {
        resources.push({
          uri: sessionUri(s.id),
          name: s.id,
          title: clip(s.title, 80) ?? s.id,
          description: `${s.agent} session started ${iso(s.startedAt)}`,
          mimeType: "text/markdown",
        });
      }
      return { resources, ...(rows.length > PAGE ? { nextCursor: encodeCursor(rows[PAGE - 1]!) } : {}) };
    },
    templates(): ResourceTemplateDef[] {
      return [{ uriTemplate: `${SESSION_PREFIX}{id}`, name: "session", title: "Session digest", description: "Markdown digest of one session by id.", mimeType: "text/markdown" }];
    },
    async read(uri) {
      const ctx = await store();
      let s;
      if (uri === LATEST_URI) [s] = await ctx.index.listSessions({ limit: 1, parentSessionId: null });
      else if (uri.startsWith(SESSION_PREFIX)) {
        let id: string;
        try {
          id = decodeURIComponent(uri.slice(SESSION_PREFIX.length));
        } catch {
          return undefined;
        }
        if (id) s = await sessionRef(ctx.index, uri, id);
      }
      // codingsh://latest is always listed, so an empty store answers with what to do next, not "not found".
      if (!s && uri === LATEST_URI) return { uri, mimeType: "text/markdown", text: `# Latest session

${noSessionsHint(ctx.env ?? process.env)}
` };
      if (!s) return undefined;
      return { uri, mimeType: "text/markdown", text: await sessionMarkdown(ctx.index, s) };
    },
  };
}
