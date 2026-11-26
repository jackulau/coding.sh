// Review queues: the sessions a --where query matched, scored by hand one at a time with
// one score config. `coding.sh review` and /api/review (src/viewer/server.ts) both go
// through here; a done item's score is written by the caller's own score path (addScore
// for the CLI, postScore for the API), so it is checked against the config the same way
// a score from `coding.sh score add` or POST /api/scores is.
import { findSessionRef } from "../core/session-ref.ts";
import { isEmptySession } from "../core/sessions.ts";
import type { IndexStore, ReviewItem, ReviewQueue, Score, ScoreConfig, SessionFilter } from "../core/types.ts";
import { findSessions } from "../query/run.ts";
import { parseWhere, scopesSubagents } from "../query/where.ts";
import type { Session } from "../schema/index.ts";
import { listScoreConfigs } from "./scores.ts";

export const QUEUE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const NO_REVIEW = "review queues need the local index (this store has no review queues)";
/** The most items one queue holds: --sample picks from every match, the queue keeps at most this many. */
export const MAX_QUEUE_ITEMS = 5000;

type ReviewReason = "bad_name" | "bad_value" | "no_review" | "unknown_queue" | "unknown_item" | "unknown_config" | "queue_exists" | "no_match" | "not_yours";
const STATUS: Partial<Record<ReviewReason, number>> = { no_review: 501, unknown_queue: 404, unknown_item: 404, unknown_config: 404, queue_exists: 409, not_yours: 403 };

/** Why a queue could not be made, read or changed. `status` is the HTTP status the viewer answers with. */
export class ReviewError extends Error {
  readonly reason: ReviewReason;
  readonly status: number;
  constructor(reason: ReviewReason, message: string) {
    super(message);
    this.name = "ReviewError";
    this.reason = reason;
    this.status = STATUS[reason] ?? 400;
  }
}

type ReviewStore = Required<Pick<IndexStore, "createReviewQueue" | "listReviewQueues" | "listReviewItems" | "putReviewItem">>;

/** The store's review methods, or a ReviewError when it has none (the postgres and clickhouse plugins). */
export function reviewStore(index: IndexStore): ReviewStore {
  const { createReviewQueue, listReviewQueues, listReviewItems, putReviewItem } = index;
  if (!createReviewQueue || !listReviewQueues || !listReviewItems || !putReviewItem) throw new ReviewError("no_review", NO_REVIEW);
  return {
    createReviewQueue: createReviewQueue.bind(index),
    listReviewQueues: listReviewQueues.bind(index),
    listReviewItems: listReviewItems.bind(index),
    putReviewItem: putReviewItem.bind(index),
  };
}

export function checkQueueName(name: unknown): string {
  if (typeof name !== "string" || !QUEUE_NAME_RE.test(name)) throw new ReviewError("bad_name", `queue names are 1 to 64 letters, digits, '-', '_' and '.', got ${JSON.stringify(name)}`);
  return name;
}

function queuesText(queues: readonly ReviewQueue[]): string {
  return queues.length ? `Review queues: ${queues.map((q) => q.name).join(", ")}.` : "No review queues yet.";
}

function configsText(configs: readonly ScoreConfig[]): string {
  return configs.length ? `Score configs: ${configs.map((c) => c.name).join(", ")}.` : "No score configs yet.";
}

export interface CreateQueueOptions {
  name: string;
  where: string;
  /** A score config's name. */
  config: string;
  /** Pick this many of the matches at random. */
  sample?: number;
  /** Every item is for this person or API key name. */
  assign?: string;
  now?: number;
  /** Uniform in [0, 1); for tests. */
  random?: () => number;
}

/**
 * Makes a queue of the sessions the query matches (as `sessions --where` lists them: root
 * sessions unless the query names subagents, empty sessions left out), or `sample` of them
 * at random. The query is checked first (a QueryError), then the config, then the name.
 */
export async function createQueue(index: IndexStore, o: CreateQueueOptions): Promise<{ queue: ReviewQueue; items: ReviewItem[]; matched: number }> {
  const store = reviewStore(index);
  checkQueueName(o.name);
  const now = o.now ?? Date.now();
  const where = o.where.trim();
  if (!where) throw new ReviewError("bad_value", "a review queue needs a query, e.g. --where 'is:flagged agent:codex'");
  const q = parseWhere(where, { now });
  const configs = await listScoreConfigs(index);
  const config = configs.find((c) => c.name === o.config);
  if (!config) throw new ReviewError("unknown_config", `No score config named ${JSON.stringify(o.config)}. ${configsText(configs)}`);
  if ((await store.listReviewQueues()).some((x) => x.name === o.name)) throw new ReviewError("queue_exists", `A review queue named ${JSON.stringify(o.name)} exists already: pick another name`);
  const filter: SessionFilter = scopesSubagents(q.root) ? {} : { parentSessionId: null };
  const findOpts: { filter: SessionFilter; limit?: number } = { filter };
  if (q.limit !== undefined) findOpts.limit = q.limit;
  const found = (await findSessions(index, q, findOpts)).sessions.filter((s) => !isEmptySession(s));
  if (!found.length) throw new ReviewError("no_match", `No sessions match ${JSON.stringify(where)}: there is nothing to review`);
  const picked = o.sample !== undefined ? sample(found, o.sample, o.random ?? Math.random) : found;
  const items: ReviewItem[] = picked.slice(0, MAX_QUEUE_ITEMS).map((s, i) => {
    const it: ReviewItem = { queue: o.name, id: i + 1, target: "session", targetId: s.id, sessionId: s.id, status: "pending" };
    if (o.assign) it.assignee = o.assign;
    return it;
  });
  const queue: ReviewQueue = { name: o.name, where, config: config.name, createdAt: now };
  if (!(await store.createReviewQueue(queue, items))) throw new ReviewError("queue_exists", `A review queue named ${JSON.stringify(o.name)} exists already: pick another name`);
  return { queue, items, matched: found.length };
}

/** `n` of `xs` at random, in the order they were drawn (a partial Fisher-Yates shuffle). */
export function sample<T>(xs: readonly T[], n: number, random: () => number): T[] {
  const a = [...xs];
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(random() * (a.length - i));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, k);
}

/** The queue named `name`; a ReviewError naming the queues that exist when there is none. */
export async function getQueue(index: IndexStore, name: string): Promise<ReviewQueue> {
  const queues = await reviewStore(index).listReviewQueues();
  const q = queues.find((x) => x.name === name);
  if (!q) throw new ReviewError("unknown_queue", `No review queue named ${JSON.stringify(name)}. ${queuesText(queues)}`);
  return q;
}

export interface QueueStatus {
  queue: string;
  config: string;
  done: number;
  skipped: number;
  total: number;
}

function counts(q: ReviewQueue, items: readonly ReviewItem[]): QueueStatus {
  let done = 0;
  let skipped = 0;
  for (const it of items) {
    if (it.status === "done") done++;
    else if (it.status === "skipped") skipped++;
  }
  return { queue: q.name, config: q.config, done, skipped, total: items.length };
}

export async function queueStatus(index: IndexStore, name: string): Promise<QueueStatus> {
  const q = await getQueue(index, name);
  return counts(q, await reviewStore(index).listReviewItems(q.name));
}

/** Every queue with its counts and query, by name. */
export async function listQueues(index: IndexStore): Promise<(QueueStatus & { where: string; createdAt: number })[]> {
  const store = reviewStore(index);
  const out = [];
  for (const q of await store.listReviewQueues()) out.push({ ...counts(q, await store.listReviewItems(q.name)), where: q.where, createdAt: q.createdAt });
  return out;
}

/** What `review next` and GET /api/review/<queue>/next show of an item. */
export interface NextItem {
  queue: string;
  item: number;
  target: ReviewItem["target"];
  targetId: string;
  sessionId?: string;
  assignee?: string;
  title?: string;
  agent?: string;
  flags: string[];
  config: string;
  /** What values fit the config: "true|false", "0..5", "a|b|c" or "text". */
  values: string;
  /** The command that completes it, with a placeholder value. */
  command: string;
  /** Pending items this caller may take, this one included. */
  pending: number;
}

/** "true|false", "0..5", "a|b|c", "number" or "text". */
export function configValues(c: ScoreConfig | undefined): string {
  if (!c) return "value";
  if (c.dataType === "boolean") return "true|false";
  if (c.dataType === "categorical") return (c.categories ?? []).join("|");
  if (c.dataType === "numeric") return c.min === undefined && c.max === undefined ? "number" : `${c.min ?? ""}..${c.max ?? ""}`;
  return "text";
}

export interface NextOptions {
  /** Only items for this person or key, or for no one. Undefined: every item. */
  assignee?: string;
  /** Whether the caller may see this session (a project-scoped key). Default: every session. */
  visible?: (sessionId: string) => Promise<boolean>;
}

/** The first pending item the caller may take, or undefined when there is none. */
export async function nextItem(index: IndexStore, name: string, o: NextOptions = {}): Promise<NextItem | undefined> {
  const q = await getQueue(index, name);
  const items = await reviewStore(index).listReviewItems(q.name);
  const pending = items.filter((it) => it.status === "pending" && (o.assignee === undefined || it.assignee === undefined || it.assignee === o.assignee));
  for (const it of pending) {
    if (o.visible && it.sessionId !== undefined && !(await o.visible(it.sessionId))) continue;
    const s: Session | undefined = it.sessionId !== undefined ? await index.getSession(it.sessionId) : undefined;
    const config = (await listScoreConfigs(index)).find((c) => c.name === q.config);
    const values = configValues(config);
    const about: Pick<NextItem, "sessionId" | "assignee" | "title" | "agent"> = {};
    if (it.sessionId !== undefined) about.sessionId = it.sessionId;
    if (it.assignee !== undefined) about.assignee = it.assignee;
    if (s?.title !== undefined) about.title = s.title;
    if (s) about.agent = s.agent;
    return {
      queue: q.name,
      item: it.id,
      target: it.target,
      targetId: it.targetId,
      ...about,
      flags: s?.flags ?? [],
      config: q.config,
      values,
      command: `coding.sh review done ${q.name} ${it.id} <${values}>`,
      pending: pending.length,
    };
  }
  return undefined;
}

/**
 * The item `id` of the queue: a number, or the item's session, by its id or by a reference that opens
 * it (findSessionRef, so the one review next prints). A number no item has is read as a session
 * reference, since a printed one can be all digits. A ReviewError when there is none.
 */
export async function getItem(index: IndexStore, q: ReviewQueue, id: string | number): Promise<ReviewItem> {
  const items = await reviewStore(index).listReviewItems(q.name);
  const raw = String(id);
  const it = (/^\d+$/.test(raw) ? items.find((x) => x.id === Number(raw)) : undefined) ?? items.find((x) => x.targetId === raw) ?? (await itemOfSession(index, items, raw));
  if (!it) throw new ReviewError("unknown_item", `Review queue ${q.name} has no item ${raw}: its items are 1 to ${items.length}`);
  return it;
}

/** The item whose session `ref` opens anywhere a session id is taken (findSessionRef), when the queue holds it. */
async function itemOfSession(index: IndexStore, items: readonly ReviewItem[], ref: string): Promise<ReviewItem | undefined> {
  const s = await findSessionRef(index, ref).catch(() => undefined);
  return s ? items.find((x) => x.targetId === s.id) : undefined;
}

export interface CompleteOptions {
  /** Who is taking the item: refused (403) when it is assigned to someone else. Undefined: anyone may. */
  assignee?: string;
  now?: number;
}

/** The body that scores an item with the queue's config: a human score on the item's target. */
export function itemScoreBody(q: ReviewQueue, config: ScoreConfig, it: ReviewItem, value: unknown, comment?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { target: it.target, targetId: it.targetId };
  if (it.target !== "session" && it.sessionId !== undefined) body.sessionId = it.sessionId;
  body.name = config.name;
  body.configId = config.id;
  body.value = value;
  body.source = "human";
  if (comment !== undefined) body.comment = comment;
  return body;
}

function checkTaker(it: ReviewItem, assignee: string | undefined): void {
  if (assignee !== undefined && it.assignee !== undefined && it.assignee !== assignee) throw new ReviewError("not_yours", `item ${it.id} is assigned to ${it.assignee}`);
}

/**
 * Scores the item with the queue's config through `write` (the caller's score path, which
 * checks the value against the config and throws a ScoreError when it does not fit), then
 * marks it done with the score's id. Doing an item again replaces its score.
 */
export async function completeItem(
  index: IndexStore,
  name: string,
  itemId: string | number,
  value: unknown,
  write: (body: Record<string, unknown>) => Promise<Score>,
  o: CompleteOptions & { comment?: string } = {},
): Promise<{ item: ReviewItem; score: Score }> {
  const q = await getQueue(index, name);
  const it = await getItem(index, q, itemId);
  checkTaker(it, o.assignee);
  const configs = await listScoreConfigs(index);
  const config = configs.find((c) => c.name === q.config);
  if (!config) throw new ReviewError("unknown_config", `Review queue ${q.name} scores with config ${JSON.stringify(q.config)}, which is gone. ${configsText(configs)}`);
  const score = await write(itemScoreBody(q, config, it, value, o.comment));
  const done: ReviewItem = { ...it, status: "done", completedAt: o.now ?? Date.now(), scoreId: score.id };
  await reviewStore(index).putReviewItem(done);
  return { item: done, score };
}

/** Marks a pending or skipped item skipped. A done item keeps its score and stays done. */
export async function skipItem(index: IndexStore, name: string, itemId: string | number, o: CompleteOptions = {}): Promise<ReviewItem> {
  const q = await getQueue(index, name);
  const it = await getItem(index, q, itemId);
  checkTaker(it, o.assignee);
  if (it.status === "done") throw new ReviewError("bad_value", `item ${it.id} is done already (score ${it.scoreId ?? "?"}): review done scores it again`);
  const skipped: ReviewItem = { ...it, status: "skipped", completedAt: o.now ?? Date.now() };
  delete skipped.scoreId;
  await reviewStore(index).putReviewItem(skipped);
  return skipped;
}
