// MCP resources: codingsh://latest and codingsh://session/<id>, each a
// markdown digest of one session.
import type { Context } from "../core/context.ts";
import { clip, iso } from "./data.ts";
import { sessionMarkdown } from "./digest.ts";
import type { ResourceDef, ResourceProvider, ResourceTemplateDef } from "./protocol.ts";

export const SCHEME = "codingsh:";
export const LATEST_URI = "codingsh://latest";
const SESSION_PREFIX = "codingsh://session/";
const PAGE = 20;

export const sessionUri = (id: string): string => `${SESSION_PREFIX}${encodeURIComponent(id)}`;

export function buildResources(store: () => Promise<Context>): ResourceProvider {
  return {
    async list(cursor) {
      const offset = cursor && /^\d{1,9}$/.test(cursor) ? Number(cursor) : 0;
      const ctx = await store();
      const rows = await ctx.index.listSessions({ parentSessionId: null, limit: PAGE + 1, offset });
      const resources: ResourceDef[] = [];
      if (offset === 0) {
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
      return { resources, ...(rows.length > PAGE ? { nextCursor: String(offset + PAGE) } : {}) };
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
        if (id) s = await ctx.index.getSession(id);
      }
      if (!s) return undefined;
      return { uri, mimeType: "text/markdown", text: await sessionMarkdown(ctx.index, s) };
    },
  };
}
