// The viewer's Work page data (#/work): the queue `coding.sh work` prints, read by the
// same functions (core/work.ts readWorkQueue, workJson) so the items match
// `work --json` for the same store and filters. Ack and snooze write the same
// work.json overlay the CLI writes (core/work-overlay.ts), with the CLI's rules.
import { parseAge, parseSinceWhen, UsageError } from "../cli/args.ts";
import { parsePlace } from "../mcp/data.ts";
import type { IndexStore } from "../core/types.ts";
import { addAck, addSnooze, readOverlay, writeOverlay } from "../core/work-overlay.ts";
import { BUCKET_LABELS, buildWorkQueue, readWorkQueue, workItemJson, workJson, type HiddenReason, type WorkItem } from "../core/work.ts";

/** Where acks and snoozes live: <CODING_SH_HOME>/work.json (`paths(env).work`). `now` is for tests. */
export interface WorkSource {
  overlay: string;
  /** Folder `--repo ~/x` and relative paths resolve against. Default: the server's home and cwd. */
  home?: string;
  cwd?: string;
  now?: () => number;
}

/** The window read when the request names none: `work`'s default (cli/commands/work.ts WORK_SINCE). */
export const WORK_PAGE_SINCE = "7d";
/** Items in one response when the request names no limit: `work`'s default. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;
/** Member session ids listed per item, for the page's links. */
const MEMBERS_MAX = 50;

export class WorkApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Filters {
  since: number;
  sinceText: string;
  agents: string[];
  place?: ReturnType<typeof parsePlace>;
}

function filtersOf(src: WorkSource, q: URLSearchParams, now: number): Filters {
  const sinceText = q.get("since")?.trim() || WORK_PAGE_SINCE;
  let since: number;
  try {
    since = parseSinceWhen(sinceText, now).ms;
  } catch (e) {
    if (e instanceof UsageError) throw new WorkApiError(400, e.message);
    throw e;
  }
  // `agent=a,b` or `agent=a&agent=b`, each once, as `--agent` takes them.
  const agents = [...new Set(q.getAll("agent").flatMap((a) => a.split(",")).map((a) => a.trim()).filter(Boolean))];
  const repo = q.get("repo")?.trim();
  const home = src.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "/";
  const place = repo ? parsePlace(repo, src.cwd ?? process.cwd(), home) : undefined;
  return { since, sinceText, agents, place };
}

function limitOf(q: URLSearchParams): number {
  const raw = q.get("limit");
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new WorkApiError(400, "limit must be a positive integer");
  return Math.min(n, MAX_LIMIT);
}

/**
 * GET /api/work?since=7d&agent=a,b&repo=x&all=1&limit=20: `work --json`'s document, plus three
 * fields for the page: `members` (item id → its member session ids, the primary first) for the
 * session links, `hiddenBy` (hidden reason → count; {} when nothing is hidden), and `now` (ISO),
 * the moment the reasons' ages were worked out.
 */
export async function workList(index: IndexStore, src: WorkSource, q: URLSearchParams): Promise<Record<string, unknown>> {
  const now = src.now?.() ?? Date.now();
  const f = filtersOf(src, q, now);
  const limit = limitOf(q);
  const all = q.get("all") === "1" || q.get("all") === "true";
  const overlay = readOverlay(src.overlay);
  const read = { since: f.since, agents: f.agents, place: f.place, overlay, now };
  const { queue, sessions, truncated } = await readWorkQueue(index, { ...read, all });
  // Without `all` the queue holds no hidden items; the page still says why each one is hidden.
  const every = all ? queue : buildWorkQueue(sessions, { ...read, all: true });
  const hiddenBy: Partial<Record<HiddenReason, number>> = {};
  for (const i of every.items) if (i.hidden) hiddenBy[i.hidden] = (hiddenBy[i.hidden] ?? 0) + 1;
  return {
    ...workJson(queue, { since: f.since, limit, truncated }),
    members: Object.fromEntries(queue.items.slice(0, limit).map((i) => [i.id, i.sessionIds.slice(0, MEMBERS_MAX)])),
    hiddenBy,
  };
}

/** The JSON body's fields; anything but an object reads as {}. */
const fieldsOf = (body: unknown): Record<string, unknown> => (body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {});

async function findItem(index: IndexStore, src: WorkSource, id: unknown, q: URLSearchParams, now: number): Promise<WorkItem> {
  if (typeof id !== "string" || !/^w[0-9a-f]{6}$/.test(id)) throw new WorkApiError(400, 'id must be a work item id such as "w1a2b3c"');
  const f = filtersOf(src, q, now);
  const { queue } = await readWorkQueue(index, { since: f.since, all: true, overlay: readOverlay(src.overlay), now });
  const item = queue.items.find((i) => i.id === id);
  if (!item) throw new WorkApiError(404, `no work item ${id} since ${f.sinceText}`);
  return item;
}

/** POST /api/work/ack {"id":"w…"}: acknowledges the item's current cause, as `coding.sh work ack <id>` does. */
export async function workAck(index: IndexStore, src: WorkSource, q: URLSearchParams, body: unknown): Promise<Record<string, unknown>> {
  const now = src.now?.() ?? Date.now();
  const item = await findItem(index, src, fieldsOf(body).id, q, now);
  const cause = item.bucket ? item.cause : undefined;
  if (!cause) return { id: item.id, acked: false, hidden: item.hidden ?? null };
  const overlay = readOverlay(src.overlay);
  addAck(overlay, cause.sessionId, cause.fingerprint);
  writeOverlay(src.overlay, overlay, now);
  const after = await findItem(index, src, item.id, q, now);
  return { id: item.id, acked: true, bucket: cause.bucket, label: BUCKET_LABELS[cause.bucket], now: workItemJson(after) };
}

/** POST /api/work/snooze {"id":"w…","duration":"1h"}: hides the item for that long, as `coding.sh work snooze <id> 1h` does. */
export async function workSnooze(index: IndexStore, src: WorkSource, q: URLSearchParams, body: unknown): Promise<Record<string, unknown>> {
  const raw = fieldsOf(body).duration;
  if (typeof raw !== "string") throw new WorkApiError(400, 'duration must be a string such as "1h"');
  let ms: number;
  try {
    ms = parseAge(raw, "duration");
  } catch (e) {
    if (e instanceof UsageError) throw new WorkApiError(400, e.message);
    throw e;
  }
  const now = src.now?.() ?? Date.now();
  const item = await findItem(index, src, fieldsOf(body).id, q, now);
  const until = now + ms;
  const bucket = item.bucket ?? item.cause?.bucket ?? "review";
  const overlay = readOverlay(src.overlay);
  addSnooze(overlay, [...new Set([item.primaryId, item.cause?.sessionId ?? item.primaryId])], { until, bucket });
  writeOverlay(src.overlay, overlay, now);
  return { id: item.id, snoozedUntil: new Date(until).toISOString(), bucket };
}
