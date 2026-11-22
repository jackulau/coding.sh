// MCP tools for typed scores: score_list reads, score_add writes one score
// through the same checks as the CLI and /api/scores, and score_add_batch
// writes up to 100 with those checks, all or none.
import type { Context } from "../core/context.ts";
import { AmbiguousRef, findSessionRef } from "../core/session-ref.ts";
import type { IndexStore, Score, ScoreFilter, Session } from "../core/types.ts";
import { parseSince } from "../cli/args.ts";
import { noSessionsHint } from "../cli/first-session.ts";
import { clip, iso } from "../mcp/data.ts";
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

const SCORE_ADD_IN = {
  type: "object",
  properties: {
    target: TARGET,
    targetId: { type: "string", minLength: 1, description: 'Scored id; "latest" for a session.' },
    name: { type: "string", description: "e.g. outcome, helpfulness." },
    value: { type: ["number", "boolean", "string"], description: "Number, boolean or string." },
    dataType: { type: "string", enum: ["numeric", "boolean", "categorical", "text"], description: "Default: from config or value." },
    comment: { type: "string", description: "Why." },
    source: { ...SOURCE, description: "Who scored. Default api." },
    sessionId: { type: "string", description: "Session of a case or run." },
    id: { type: "string", description: "Same id replaces." },
  },
  required: ["targetId", "name", "value"],
  additionalProperties: false,
};
const SCORE_ADD_OUT = { type: "object", properties: { score: SCORE_OUT, created: B, changed: B }, required: ["score"] };
const MAX_BATCH = 100;

const toolError = (e: unknown): unknown => (e instanceof ScoreError ? new ToolError(e.message) : e);

/**
 * A session reference as the CLI and the other MCP tools read it (core/session-ref.ts): an id, a
 * unique prefix of one, or "latest". An id no session has comes back as given, so score_add says the
 * session is not found and score_list finds nothing. `seen` remembers the answers over a batch.
 */
async function sessionId(ctx: Context, raw: unknown, seen?: Map<string, string>): Promise<string | undefined> {
  if (typeof raw !== "string" || !raw) return undefined;
  const known = seen?.get(raw);
  if (known !== undefined) return known;
  let s: Session | undefined;
  try {
    s = await findSessionRef(ctx.index, raw);
  } catch (e) {
    if (!(e instanceof AmbiguousRef)) throw e;
    const list = e.candidates.map((x) => `${x.shortId} (${x.agent}, ${iso(x.startedAt)}${x.title ? `, ${JSON.stringify(clip(x.title, 60))}` : ""})`);
    const candidates = e.candidates.map((x) => ({ sessionId: x.id, shortId: x.shortId, agent: x.agent, startedAt: iso(x.startedAt), ...(x.title ? { title: clip(x.title, 120) } : {}) }));
    throw new ToolError(`Session id prefix ${JSON.stringify(raw)} matches more than one session: ${list.join("; ")}${e.more ? "; and more" : ""}. Pass one of these ids, or more of the id.`, { reason: "ambiguous", candidates, ...(e.more ? { more: true } : {}) });
  }
  if (!s && (raw === "latest" || raw === "last")) throw new ToolError(noSessionsHint(ctx.env));
  const id = s?.id ?? raw;
  seen?.set(raw, id);
  return id;
}

/** score_add's session references, read in place: the target id of a session score, and sessionId. */
async function readSessionRefs(ctx: Context, body: Obj, seen?: Map<string, string>): Promise<void> {
  const target = (body.target ?? "session") === "session" ? await sessionId(ctx, body.targetId, seen) : undefined;
  if (target !== undefined) body.targetId = target;
  const session = await sessionId(ctx, body.sessionId, seen);
  if (session !== undefined) body.sessionId = session;
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
        if (typeof a.targetId === "string" && a.targetId) f.targetId = a.target === "session" ? (await sessionId(ctx, a.targetId))! : a.targetId;
        const sid = await sessionId(ctx, a.sessionId);
        if (sid) f.sessionId = sid;
        if (typeof a.name === "string" && a.name) f.name = a.name;
        if (typeof a.source === "string") f.source = a.source as ScoreFilter["source"];
        if (typeof a.since === "string" && a.since) {
          try {
            f.since = parseSince(a.since, c.now());
          } catch {
            throw new ToolError(`Invalid since ${JSON.stringify(a.since)}: use a duration like 30m, 12h, 7d, today, yesterday or a date like 2026-01-31 (local time).`);
          }
        }
        return { items: await listScores(ctx.index, f).catch((e) => Promise.reject(toolError(e))) };
      },
    },
    {
      name: "score_add",
      title: "Score a session, event, case or run",
      description: "Store one typed score. The value is checked against the name's config (range or categories). Re-adding the same id with the same content changes nothing.",
      inputSchema: SCORE_ADD_IN,
      outputSchema: SCORE_ADD_OUT,
      // destructive: a score for the same target, name, source and person replaces the one stored.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async run(a: Obj, c: ToolCtx) {
        const ctx = await c.store();
        const body: Obj = { ...a };
        await readSessionRefs(ctx, body);
        const r = await addScore(ctx.index, body, { by: whoami(), source: "api", now: c.now() }).catch((e) => Promise.reject(toolError(e)));
        return { score: r.score, created: r.created, changed: r.changed };
      },
    },
    {
      name: "score_add_batch",
      title: "Store scores",
      description: `Store 1-${MAX_BATCH} score_add inputs, each checked as score_add checks one; one invalid stores none. Returns score_add's result for each.`,
      inputSchema: { type: "object", properties: { scores: { type: "array", minItems: 1, maxItems: MAX_BATCH, items: { type: "object" }, description: "score_add inputs." } }, required: ["scores"], additionalProperties: false },
      outputSchema: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async run(a: Obj, c: ToolCtx) {
        const list = a.scores;
        if (!Array.isArray(list) || list.length === 0) throw new ToolError("scores: give 1 or more scores");
        if (list.length > MAX_BATCH) throw new ToolError(`scores: at most ${MAX_BATCH} per call, got ${list.length}`);
        const ctx = await c.store();
        // Every score is checked against a view of the store that holds the batch's
        // earlier scores; nothing is written until all of them pass.
        const pending = new Map<string, Score>();
        const view = stagedIndex(ctx.index, pending);
        const now = c.now();
        const by = whoami();
        const items: { score: Score; created: boolean; changed: boolean }[] = [];
        const seen = new Map<string, string>();
        for (const [i, raw] of list.entries()) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError(`scores[${i}]: must be an object`);
          const body: Obj = { ...(raw as Obj) };
          try {
            await readSessionRefs(ctx, body, seen);
            const r = await addScore(view, body, { by, source: "api", now });
            items.push(r);
          } catch (e) {
            const err = toolError(e);
            if (err instanceof ToolError) throw new ToolError(`scores[${i}]: ${err.message}; none of the ${list.length} scores were stored`, err.error);
            throw err;
          }
        }
        const scores = [...pending.values()];
        const write = async () => {
          for (const s of scores) await ctx.index.putScore!(s);
        };
        if (ctx.index.transaction) await ctx.index.transaction(write);
        else await write();
        // A later score in the batch with the same id replaced an earlier one: report what was stored.
        return { items: items.map((r) => ({ ...r, score: pending.get(r.score.id) ?? r.score })) };
      },
    },
  ];
}

/** The index as addScore sees it during a batch: putScore stages, and an id lookup sees what is staged. */
function stagedIndex(index: IndexStore, pending: Map<string, Score>): IndexStore {
  return new Proxy(index, {
    get(target, p) {
      if (p === "putScore") {
        return async (s: Score) => {
          pending.set(s.id, s);
        };
      }
      if (p === "listScores") {
        return async (f: ScoreFilter) => {
          if (f.id !== undefined && pending.has(f.id)) return [pending.get(f.id)];
          return target.listScores!(f);
        };
      }
      const v = Reflect.get(target, p, target) as unknown;
      return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}
