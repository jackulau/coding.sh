// MCP tools for typed scores: score_list reads, score_add writes one score
// through the same checks as the CLI and /api/scores.
import type { Context } from "../core/context.ts";
import type { ScoreFilter, Session } from "../core/types.ts";
import { parseSince } from "../cli/args.ts";
import type { ToolCtx } from "../mcp/tools.ts";
import { ToolError, type ToolDef } from "../mcp/protocol.ts";
import { addScore, listScores, SCORE_SOURCES, SCORE_TARGETS, ScoreError, whoami } from "./scores.ts";

type Obj = Record<string, unknown>;

const S = { type: "string" };
const B = { type: "boolean" };
// Outputs name the fields worth knowing; scores carry the rest (comment, by, ts, ...).
const SCORE_OUT = { type: "object", properties: { id: S, target: S, targetId: S, name: S, value: {}, source: S }, required: ["id", "name", "value"] };
const TARGET = { type: "string", enum: SCORE_TARGETS, description: "Default session." };
const SOURCE = { type: "string", enum: SCORE_SOURCES, description: "Who scored." };

const toolError = (e: unknown): unknown => (e instanceof ScoreError ? new ToolError(e.message) : e);

/** A session id, "latest", or undefined. */
async function sessionId(ctx: Context, raw: unknown): Promise<string | undefined> {
  if (typeof raw !== "string" || !raw) return undefined;
  if (raw !== "latest") return raw;
  const [s] = await ctx.index.listSessions({ limit: 1, parentSessionId: null });
  if (!s) throw new ToolError("No sessions captured yet.");
  return (s as Session).id;
}

export function scoreTools(): ToolDef<ToolCtx>[] {
  return [
    {
      name: "score_list",
      title: "List scores",
      description: "Typed scores (numeric, boolean, categorical, text) on sessions, events, cases and runs, newest first. Human pass/fail scores are the labels judge calibration reads.",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET,
          targetId: { type: "string", description: "Target id." },
          sessionId: { type: "string", description: 'Session (and its events), or "latest".' },
          name: { type: "string", description: "Score name." },
          source: SOURCE,
          since: { type: "string", description: "30m, 12h, 7d or a date." },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Max rows." },
        },
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { items: { type: "array", items: SCORE_OUT } }, required: ["items"] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(a: Obj, c: ToolCtx) {
        const ctx = await c.store();
        const f: ScoreFilter = { limit: typeof a.limit === "number" ? Math.min(200, Math.max(1, Math.floor(a.limit))) : 50 };
        if (typeof a.target === "string") f.target = a.target as ScoreFilter["target"];
        if (typeof a.targetId === "string" && a.targetId) f.targetId = a.targetId;
        const sid = await sessionId(ctx, a.sessionId);
        if (sid) f.sessionId = sid;
        if (typeof a.name === "string" && a.name) f.name = a.name;
        if (typeof a.source === "string") f.source = a.source as ScoreFilter["source"];
        if (typeof a.since === "string" && a.since) {
          try {
            f.since = parseSince(a.since, c.now());
          } catch (e) {
            throw new ToolError(e instanceof Error ? e.message : String(e));
          }
        }
        return { items: await listScores(ctx.index, f).catch((e) => Promise.reject(toolError(e))) };
      },
    },
    {
      name: "score_add",
      title: "Score a session, event, case or run",
      description: "Store one typed score. The value is checked against the name's config (range or categories). Re-adding the same id with the same content changes nothing.",
      inputSchema: {
        type: "object",
        properties: {
          target: TARGET,
          targetId: { type: "string", minLength: 1, description: 'Scored id; "latest" for a session.' },
          name: { type: "string", description: "e.g. outcome, helpfulness." },
          value: { type: ["number", "boolean", "string"], description: "Number, boolean or string." },
          dataType: { type: "string", enum: ["numeric", "boolean", "categorical", "text"], description: "Default: from config or value." },
          comment: { type: "string", description: "Why." },
          source: { ...SOURCE, description: "Who scored. Default api." },
          sessionId: { type: "string", description: "Session of an event, case or run." },
          id: { type: "string", description: "Same id replaces." },
        },
        required: ["targetId", "name", "value"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { score: SCORE_OUT, created: B, changed: B }, required: ["score"] },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(a: Obj, c: ToolCtx) {
        const ctx = await c.store();
        const body: Obj = { ...a };
        if ((a.target ?? "session") === "session" && a.targetId === "latest") body.targetId = await sessionId(ctx, "latest");
        else if (a.sessionId === "latest") body.sessionId = await sessionId(ctx, "latest");
        const r = await addScore(ctx.index, body, { by: whoami(), source: "api", now: c.now() }).catch((e) => Promise.reject(toolError(e)));
        return { score: r.score, created: r.created, changed: r.changed };
      },
    },
  ];
}
