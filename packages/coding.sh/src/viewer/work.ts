// The viewer's Work page data (#/work, #/w/<id>): the queue `coding.sh work` prints and the
// item `work show` prints, read by the same functions (core/work.ts readWorkQueue, workJson,
// workFiles) so the items match `work --json` for the same store and filters. Ack and snooze
// write the same work.json overlay the CLI writes (core/work-overlay.ts), with the CLI's rules.
import { parseAge, parseSinceWhen, UsageError } from "../cli/args.ts";
import { bucketsFlag, kindsFlag, mainFilesChanged, risksFlag, stagesFlag } from "../cli/commands/work.ts";
import { parsePlace } from "../mcp/data.ts";
import { dateMs, isoMs } from "../core/dates.ts";
import type { IndexStore } from "../core/types.ts";
import type { Session } from "../schema/index.ts";
import { shortener } from "../core/session-ref.ts";
import { indexAge, indexAgeField, indexAgeText, staleIndexText, type IndexAge } from "../core/ingest-health.ts";
import { addAck, readOverlay, snoozeItem, writeOverlay, type WorkOverlay } from "../core/work-overlay.ts";
import {
  BUCKET_LABELS,
  BUCKETS,
  buildWorkQueue,
  itemWorkflowAgents,
  readWorkQueue,
  selectBatchAckTargets,
  settleWorkFiles,
  workFiles,
  workItemJson,
  workJson,
  type Bucket,
  type HiddenReason,
  type Stage,
  type SupervisionRisk,
  type WorkItem,
  type WorkKind,
} from "../core/work.ts";

/** Where acks and snoozes live: <CODING_SH_HOME>/work.json (`paths(env).work`). `now` is for tests. */
export interface WorkSource {
  overlay: string;
  /**
   * The coding.sh home whose ingest record (core/ingest-health.ts) says how old the index is. Unset:
   * the answer has no `index`, and the queue is judged as of now (a store filled elsewhere).
   */
  root?: string;
  /** Folder `--repo ~/x` and relative paths resolve against. Default: the server's home and cwd. */
  home?: string;
  cwd?: string;
  now?: () => number;
}

/** The window read when the request names none: `work`'s default (cli/commands/work.ts WORK_SINCE). */
export const WORK_PAGE_SINCE = "7d";
/** Items in one response when the request names no limit: `work`'s default. */
const DEFAULT_LIMIT = 20;
/** A bigger limit is cut to this; the page's "Show all" asks for up to this many. */
const MAX_LIMIT = 1000;
/** Member session ids listed per item, for the page's links. */
const MEMBERS_MAX = 50;
/** Paths an item's answer lists, as `work show --json` lists them. */
const FILES_MAX = 200;
/** A work item id: "w" and six hex digits (core/work.ts workItemId). */
export const WORK_ITEM_ID = /^w[0-9a-f]{6}$/;

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
  stages: Stage[];
  kinds: WorkKind[];
  buckets: Bucket[];
  risks: SupervisionRisk[];
  q?: string;
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
  // `stage`, `kind`, `bucket` and `risk` accept repeated or comma-separated values, parsed as the CLI flags parse them.
  let stages: Stage[];
  let kinds: WorkKind[];
  let buckets: Bucket[];
  let risks: SupervisionRisk[];
  try {
    stages = stagesFlag({ flags: { stage: q.getAll("stage") } });
    kinds = kindsFlag({ flags: { kind: q.getAll("kind") } });
    buckets = bucketsFlag({ flags: { bucket: q.getAll("bucket") } });
    risks = risksFlag({ flags: { risk: q.getAll("risk") } });
  } catch (e) {
    if (e instanceof UsageError) throw new WorkApiError(400, e.message);
    throw e;
  }
  const search = q.get("q")?.trim() || undefined;
  return { since, sinceText, agents, place, stages, kinds, buckets, risks, q: search };
}

function limitOf(q: URLSearchParams): number {
  const raw = q.get("limit");
  if (raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new WorkApiError(400, "limit must be a positive integer");
  return Math.min(n, MAX_LIMIT);
}

/**
 * The index's age for a viewer answer, `{ updatedAt, stale?, text }`, with `text` in the CLI's words
 * (core/ingest-health.ts): "index updated 4m ago". While the index is old, `work` gives the line
 * `coding.sh work` prints; otherwise "; run coding.sh ingest" follows, as `coding.sh status` says it.
 */
export function indexDoc(age: IndexAge | undefined, work = false): { index?: { updatedAt: string; stale?: true; text: string } } {
  const field = indexAgeField(age).index;
  if (!age || !field) return {};
  const text = age.stale && work ? staleIndexText(age) : `${indexAgeText(age)}${age.stale ? "; run coding.sh ingest" : ""}`;
  return { index: { ...field, text } };
}

/** When the queue is judged: as of the last ingest while the index is old (as `coding.sh work` judges it), else now. */
const judgedAt = (src: WorkSource, now: number, age = src.root ? indexAge(src.root, now) : undefined): number => (age?.stale ? age.at : now);

/**
 * GET /api/work?since=7d&agent=a,b&repo=x&stage=review&all=1&limit=20: `work --json`'s document, plus four
 * fields for the page: `members` (item id → its member session ids, the primary first) for the
 * session links, `hiddenBy` (hidden reason → count; {} when nothing is hidden), `totals` (each
 * bucket and "hidden" → how many items of the whole answer, not just the first `limit`, fall in
 * it), and `now` (ISO), the moment the reasons' ages were worked out. With a `root` it carries
 * `index` (indexDoc), and an old index judges the queue as of its last ingest. Left out when empty:
 * `workflowAgents` (a run item's id → its agents, as `work show --json` lists them) and `sessionOf`
 * (the id of an item a shown failure was superseded by → that item's primary session).
 */
export async function workList(index: IndexStore, src: WorkSource, q: URLSearchParams): Promise<Record<string, unknown>> {
  const clock = src.now?.() ?? Date.now();
  const age = src.root ? indexAge(src.root, clock) : undefined;
  const now = judgedAt(src, clock, age);
  const f = filtersOf(src, q, now);
  const limit = limitOf(q);
  // A stage filter lists hidden items too, as `--stage` does.
  const all = q.get("all") === "1" || q.get("all") === "true" || f.stages.length > 0;
  const overlay = readOverlay(src.overlay);
  // Next steps name sessions by the shortest id that resolves, as `work --json` does.
  const read = { since: f.since, agents: f.agents, place: f.place, kinds: f.kinds, risks: f.risks, q: f.q, overlay, now, shortId: await shortener(index) };
  const { queue, sessions, truncated } = await readWorkQueue(index, { ...read, all, stages: f.stages, buckets: f.buckets });
  // Without `all` (or with a stage or bucket filter) the queue lacks hidden items; the page still says why each one is hidden.
  const every = all && !f.stages.length && !f.buckets.length ? queue : buildWorkQueue(sessions, { ...read, all: true });
  const hiddenBy: Partial<Record<HiddenReason, number>> = {};
  for (const i of every.items) if (i.hidden) hiddenBy[i.hidden] = (hiddenBy[i.hidden] ?? 0) + 1;
  const shown = queue.items.slice(0, limit);
  // The shown items count and name their files as `work --json` and `work show` do (core/work.ts settleWorkFiles).
  await settleWorkFiles(index, shown, sessions, now);
  // `counts` counts every stage and leaves hidden items out; the page's headings count what this answer lists.
  const totals: Record<string, number> = Object.fromEntries([...BUCKETS, "hidden"].map((b) => [b, 0]));
  for (const i of queue.items) totals[i.bucket ?? "hidden"] = (totals[i.bucket ?? "hidden"] ?? 0) + 1;
  const workflowAgents: Record<string, unknown[]> = {};
  for (const i of shown) {
    if (i.workflow) workflowAgents[i.id] = itemWorkflowAgents(i, sessions, now).slice(0, MEMBERS_MAX).map(({ startedAt: _, ...a }) => a);
  }
  // The item that superseded a failure ended with no failure, so it is often hidden, or outside the filters.
  const sessionOf: Record<string, string> = {};
  const wanted = new Set(shown.flatMap((i) => (i.supersededBy ? [i.supersededBy] : [])));
  if (wanted.size) {
    let known = [...queue.items, ...every.items];
    if ([...wanted].some((id) => !known.some((i) => i.id === id))) known = buildWorkQueue(sessions, { overlay, now, all: true }).items;
    for (const it of known) if (wanted.has(it.id)) sessionOf[it.id] = it.primaryId;
  }
  const doc: Record<string, unknown> = {
    ...workJson(queue, { since: f.since, limit, truncated }),
    // The moment the reasons' ages ("ended 2h ago") were worked out, so the page's own ages count from it too.
    now: new Date(now).toISOString(),
    members: Object.fromEntries(shown.map((i) => [i.id, i.sessionIds.slice(0, MEMBERS_MAX)])),
    hiddenBy,
    totals,
  };
  if (Object.keys(workflowAgents).length) doc.workflowAgents = workflowAgents;
  if (Object.keys(sessionOf).length) doc.sessionOf = sessionOf;
  return { ...doc, ...indexDoc(age, true) };
}

/** The JSON body's fields; anything but an object reads as {}. */
const fieldsOf = (body: unknown): Record<string, unknown> => (body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {});

interface FindOptions {
  /** Apply the request's agent and repo filters, as the list does. */
  filtered?: boolean;
  /** The moment the queue is judged as of, already worked out (judgedAt). */
  judged?: number;
  shortId?: (id: string) => string;
  overlay?: WorkOverlay;
}

/**
 * The item `id` names, judged as the list was: as of the last ingest while the index is old. Also the
 * queue it was found in (every item, hidden ones too) and the window's sessions.
 */
async function findItem(index: IndexStore, src: WorkSource, id: unknown, q: URLSearchParams, now: number, opts: FindOptions = {}): Promise<{ item: WorkItem; items: WorkItem[]; sessions: Session[] }> {
  if (typeof id !== "string" || !WORK_ITEM_ID.test(id)) throw new WorkApiError(400, 'id must be a work item id such as "w1a2b3c"');
  const f = filtersOf(src, q, now);
  const filters = opts.filtered ? { agents: f.agents, place: f.place } : {};
  const { queue, sessions } = await readWorkQueue(index, { since: f.since, all: true, overlay: opts.overlay ?? readOverlay(src.overlay), now: opts.judged ?? judgedAt(src, now), shortId: opts.shortId, ...filters });
  const item = queue.items.find((i) => i.id === id);
  if (!item) throw new WorkApiError(404, `no work item ${id} since ${f.sinceText}${opts.filtered && (f.agents.length || f.place) ? " that matches the filters" : ""}`);
  return { item, items: queue.items, sessions };
}

/**
 * GET /api/work/<id>?since=7d&agent=a&repo=x: one item as `coding.sh work show <id> --json` gives it, read
 * by the same functions (workFiles, workItemJson, itemWorkflowAgents), plus what the list adds: `now`
 * (ISO), `sessionOf` when a newer item superseded the item's failure, and `index` with a `root`. The
 * agent and repo filters apply as on the list. A malformed id is a 400; an id no item has is a 404.
 */
export async function workShow(index: IndexStore, src: WorkSource, id: string, q: URLSearchParams): Promise<Record<string, unknown>> {
  const clock = src.now?.() ?? Date.now();
  const age = src.root ? indexAge(src.root, clock) : undefined;
  const now = judgedAt(src, clock, age);
  const overlay = readOverlay(src.overlay);
  // The window and the judgment as the list's: from the last ingest while the index is old.
  const { item, items, sessions } = await findItem(index, src, id, q, now, { filtered: true, judged: now, shortId: await shortener(index), overlay });
  const byId = new Map(sessions.map((s) => [s.id, s]));
  // Before workItemJson: when it reads every session, workFiles sets the item's file count and review reason.
  const files = await workFiles(index, item, sessions, now);
  const children = item.sessionIds.filter((sid) => sid !== item.primaryId).map((sid) => byId.get(sid)).filter((s): s is Session => !!s);
  const doc: Record<string, unknown> = {
    ...workItemJson(item),
    now: new Date(now).toISOString(),
    sessionFilesChanged: mainFilesChanged(item, byId),
    workflowAgents: item.workflow ? itemWorkflowAgents(item, sessions, now).map(({ startedAt, ...a }) => ({ ...a, startedAt: isoMs(startedAt) ?? null })) : undefined,
    files: files.slice(0, FILES_MAX),
    sessions: [item.primaryId, ...children.map((s) => s.id)].map((sid) => {
      const s = byId.get(sid);
      if (!s) return { id: sid };
      const row: Record<string, unknown> = { id: s.id, agent: s.agent, title: s.title ?? null, parentSessionId: s.parent?.sessionId ?? null };
      if (s.stats.waiting) row.waiting = s.stats.waiting.kind;
      return row;
    }),
  };
  if (item.supersededBy) {
    // The newer item ended with no failure, so it is often hidden, or outside the filters.
    const later = items.find((i) => i.id === item.supersededBy) ?? buildWorkQueue(sessions, { overlay, now, all: true }).items.find((i) => i.id === item.supersededBy);
    if (later) doc.sessionOf = { [later.id]: later.primaryId };
  }
  for (const k of Object.keys(doc)) if (doc[k] === undefined) delete doc[k];
  return { ...doc, ...indexDoc(age, true) };
}

/** POST /api/work/ack {"id":"w…"}: acknowledges the item's current cause, as `coding.sh work ack <id>` does. */
export async function workAck(index: IndexStore, src: WorkSource, q: URLSearchParams, body: unknown): Promise<Record<string, unknown>> {
  const now = src.now?.() ?? Date.now();
  const { item } = await findItem(index, src, fieldsOf(body).id, q, now);
  const cause = item.bucket ? item.cause : undefined;
  if (!cause) return { id: item.id, acked: false, hidden: item.hidden ?? null };
  const overlay = readOverlay(src.overlay);
  addAck(overlay, cause.sessionId, cause.fingerprint);
  writeOverlay(src.overlay, overlay, now);
  const { item: after } = await findItem(index, src, item.id, q, now, { shortId: await shortener(index) });
  return { id: item.id, acked: true, bucket: cause.bucket, label: BUCKET_LABELS[cause.bucket], now: workItemJson(after) };
}

/**
 * POST /api/work/ack-batch {"probablyClosed"?:true,"group"?:"api 529","bucket"?:"failed","ids"?:["w…"],"dryRun"?:true}:
 * acknowledges all matching active items' current causes in one atomic work.json write.
 */
export async function workAckBatch(index: IndexStore, src: WorkSource, q: URLSearchParams, body: unknown): Promise<Record<string, unknown>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new WorkApiError(400, "body must be a JSON object");
  const fields = body as Record<string, unknown>;
  let probablyClosed: boolean | undefined;
  if (fields.probablyClosed !== undefined) {
    if (typeof fields.probablyClosed !== "boolean") throw new WorkApiError(400, "probablyClosed must be a boolean");
    if (fields.probablyClosed) probablyClosed = true;
  }
  let group: string | undefined;
  if (fields.group !== undefined) {
    if (typeof fields.group !== "string" || !fields.group.trim()) throw new WorkApiError(400, "group must be a non-empty string");
    group = fields.group.trim();
  }
  let bucket: Bucket | undefined;
  if (fields.bucket !== undefined) {
    if (typeof fields.bucket !== "string") throw new WorkApiError(400, `bucket must be one of ${BUCKETS.join(", ")}`);
    const norm = fields.bucket.trim().toLowerCase();
    if (!(BUCKETS as readonly string[]).includes(norm)) throw new WorkApiError(400, `bucket must be one of ${BUCKETS.join(", ")}, got ${JSON.stringify(fields.bucket)}`);
    bucket = norm as Bucket;
  }
  let ids: string[] | undefined;
  if (fields.ids !== undefined) {
    if (!Array.isArray(fields.ids) || !fields.ids.length || fields.ids.length > MAX_LIMIT) {
      throw new WorkApiError(400, `ids must be an array of 1 to ${MAX_LIMIT} work item ids`);
    }
    const clean: string[] = [];
    for (const raw of fields.ids) {
      if (typeof raw !== "string" || !WORK_ITEM_ID.test(raw)) throw new WorkApiError(400, 'each entry in ids must be a work item id such as "w1a2b3c"');
      clean.push(raw);
    }
    ids = clean;
  }
  let dryRun = false;
  if (fields.dryRun !== undefined) {
    if (typeof fields.dryRun !== "boolean") throw new WorkApiError(400, "dryRun must be a boolean");
    dryRun = fields.dryRun;
  }
  if (!probablyClosed && group === undefined && bucket === undefined && ids === undefined) {
    throw new WorkApiError(400, "ack-batch requires at least one of probablyClosed, group, bucket, or ids");
  }
  const clock = src.now?.() ?? Date.now();
  const age = src.root ? indexAge(src.root, clock) : undefined;
  const now = judgedAt(src, clock, age);
  const f = filtersOf(src, q, now);
  const overlay = readOverlay(src.overlay);
  const { queue } = await readWorkQueue(index, {
    since: f.since,
    agents: f.agents,
    place: f.place,
    stages: f.stages,
    kinds: f.kinds,
    buckets: f.buckets,
    risks: f.risks,
    q: f.q,
    overlay,
    now,
  });
  const targets = selectBatchAckTargets(queue.items, { probablyClosed, group, bucket, ids });
  if (!dryRun && targets.length) {
    for (const item of targets) addAck(overlay, item.cause!.sessionId, item.cause!.fingerprint);
    writeOverlay(src.overlay, overlay, clock);
  }
  const out: Record<string, unknown> = { acked: targets.length, ids: targets.map((i) => i.id) };
  if (dryRun) out.dryRun = true;
  return out;
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
  const { item } = await findItem(index, src, fieldsOf(body).id, q, now);
  const until = now + ms;
  if (dateMs(until) === undefined) throw new WorkApiError(400, "duration is outside the supported date range");
  const bucket = item.bucket ?? item.cause?.bucket ?? "review";
  const overlay = readOverlay(src.overlay);
  snoozeItem(overlay, item, { until, bucket });
  writeOverlay(src.overlay, overlay, now);
  return { id: item.id, snoozedUntil: new Date(until).toISOString(), bucket };
}
