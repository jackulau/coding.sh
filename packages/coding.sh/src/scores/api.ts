// HTTP handlers for /api/scores and /api/score-configs, shared by `coding.sh ui`
// and `coding.sh serve` (src/viewer/server.ts routes to them). They return a
// status and a JSON body, and throw ScoreError for 4xx answers.
//
//   GET  /api/scores?target=&targetId=&sessionId=&name=&source=&since=&until=&limit=
//   POST /api/scores          one score (see parseScore); 201 when stored, 200 when the same id already held it
//   GET  /api/score-configs
//   POST /api/score-configs   one config; 201 created, 200 updated or unchanged; 409 when another id has the name
import type { IndexStore, Score } from "../core/types.ts";
import { DEFAULT_PROJECT, sdkEventId } from "../server/project.ts";
import { addScore, addScoreConfig, listScoreConfigs, listScores, ScoreError, scoreFilter } from "./scores.ts";

export interface ScoresApiCtx {
  index: IndexStore;
  /** Who is calling: recorded as the score's `by`. */
  by: string;
  /** Scoped caller: only scores on this project's sessions are visible, and only those may be written. */
  project?: string;
  /** Whether a session exists and the caller may see it. */
  sessionVisible(id: string): Promise<boolean>;
  now?: () => number;
}

export interface ApiReply {
  status: number;
  body: unknown;
}

const MAX_LIMIT = 1000;

function limitParam(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 100;
  if (!/^\d+$/.test(raw)) throw new ScoreError(400, "limit must be a non-negative integer");
  const n = Number(raw);
  if (n < 1 || n > MAX_LIMIT) throw new ScoreError(400, `limit must be between 1 and ${MAX_LIMIT}`);
  return n;
}

export async function getScores(ctx: ScoresApiCtx, q: URLSearchParams): Promise<ApiReply> {
  const get = (k: string) => q.get(k) || undefined;
  const filter = scoreFilter(get);
  const limit = limitParam(get("limit"));
  if (filter.sessionId !== undefined && !(await ctx.sessionVisible(filter.sessionId))) throw new ScoreError(404, "session not found");
  if (ctx.project === undefined || filter.sessionId !== undefined) return { status: 200, body: { items: await listScores(ctx.index, { ...filter, limit }) } };
  // A scoped caller sees scores on its project's sessions only.
  const seen = new Map<string, boolean>();
  const items: Score[] = [];
  for (const s of await listScores(ctx.index, filter)) {
    if (s.sessionId === undefined) continue;
    if (!seen.has(s.sessionId)) seen.set(s.sessionId, await ctx.sessionVisible(s.sessionId));
    if (!seen.get(s.sessionId)) continue;
    items.push(s);
    if (items.length >= limit) break;
  }
  return { status: 200, body: { items } };
}

/**
 * An SDK client knows its own event ids; serve stores them hashed with the
 * project (sdkEventId). An event target that is not a stored id is read as the
 * client's id in the caller's project, else in its sessionId's project.
 */
async function storedEventTarget(ctx: ScoresApiCtx, body: unknown): Promise<unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = body as Record<string, unknown>;
  const id = b.targetId;
  if (b.target !== "event" || typeof id !== "string" || !id || !ctx.index.eventsByIdPrefix) return body;
  const exists = async (x: string) => (await ctx.index.eventsByIdPrefix!(x, 2)).some((e) => e.id === x);
  if (await exists(id)) return body;
  let project = ctx.project;
  if (project === undefined && typeof b.sessionId === "string" && b.sessionId) project = (await ctx.index.getSession(b.sessionId))?.project ?? DEFAULT_PROJECT;
  if (project === undefined) return body;
  const hashed = sdkEventId(project, id);
  return (await exists(hashed)) ? { ...b, targetId: hashed } : body;
}

export async function postScore(ctx: ScoresApiCtx, body: unknown): Promise<ApiReply> {
  const { score, created } = await addScore(ctx.index, await storedEventTarget(ctx, body), {
    by: ctx.by,
    source: "api",
    now: (ctx.now ?? Date.now)(),
    checkSession: async (sessionId) => {
      if (sessionId === undefined) {
        if (ctx.project !== undefined) throw new ScoreError(400, "sessionId is required: this key only writes scores on its project's sessions");
        return;
      }
      if (!(await ctx.sessionVisible(sessionId))) throw new ScoreError(404, `session not found: ${sessionId}`);
    },
  });
  return { status: created ? 201 : 200, body: score };
}

export async function getScoreConfigs(ctx: ScoresApiCtx): Promise<ApiReply> {
  return { status: 200, body: { items: await listScoreConfigs(ctx.index) } };
}

export async function postScoreConfig(ctx: ScoresApiCtx, body: unknown): Promise<ApiReply> {
  // Configs are shared by every project: a scoped key may read them, not change them.
  if (ctx.project !== undefined) throw new ScoreError(403, "a project-scoped key cannot change score configs");
  const { config, created } = await addScoreConfig(ctx.index, body, (ctx.now ?? Date.now)());
  return { status: created ? 201 : 200, body: config };
}
