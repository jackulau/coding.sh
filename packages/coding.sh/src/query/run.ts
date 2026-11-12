// Runs a parsed `--where` query against any index store: the store's own query
// path when it has one (SQLite compiles to SQL), else a scan of listSessions that
// evaluates the query in memory. The scan answers session keys on every store;
// event keys and text need events, which only a store with a query compiler (SQLite,
// the Postgres and ClickHouse plugins) or the in-memory store (cheap) can afford, so
// other stores get a clear QueryUnsupported error.
import type { EventPage, EventQueryOpts, FacetCount, IndexStore, QueryOpts, SearchHit, SearchOpts } from "../core/types.ts";
import type { AgentEvent, Session } from "../schema/index.ts";
import { matchesEvent, matchesSession, sortSessions } from "./match.ts";
import { FACET_KEYS, KEYS, needsEvents, QueryUnsupported, withoutKey, type Node, type Query } from "./where.ts";

/** Most sessions the scan fallback reads per query. */
export const QUERY_SCAN_CAP = 20_000;
/** Stores whose listEvents is cheap enough to load per scanned session. */
const SCAN_EVENTS = new Set(["memory"]);

export interface FindResult {
  sessions: Session[];
  /** The scan fallback stopped at QUERY_SCAN_CAP before reading every session. */
  truncated?: boolean;
}

function unsupported(index: IndexStore, what: string): QueryUnsupported {
  return new QueryUnsupported(
    `${what} need the event index: this ${index.kind} store answers --where with session keys only (agent, model, repo, flag, cost, duration, …), since it has no query compiler. Drop the event keys (tool, kind, ok, mcp, error, event.duration) and free text, upgrade the store's plugin, or use the SQLite store.`,
  );
}

/** A predicate for one session; loads its events once, only when a clause needs them. */
export function sessionMatcher(index: IndexStore, root: Node | undefined): (s: Session) => Promise<boolean> {
  if (!root) return async () => true;
  if (!needsEvents(root)) return async (s) => matchesSession(root, s, () => []);
  if (!SCAN_EVENTS.has(index.kind)) throw unsupported(index, "Event keys and free text");
  return async (s) => {
    const events = await index.listEvents(s.id);
    return matchesSession(root, s, () => events);
  };
}

/** Sessions newest first (or by q.sort) matching the filter and the query. */
export async function findSessions(index: IndexStore, q: Query, o: QueryOpts = {}): Promise<FindResult> {
  if (index.querySessions) return { sessions: await index.querySessions(q, o) };
  const match = sessionMatcher(index, q.root);
  const sorted = q.sort !== undefined;
  const want = o.limit === undefined ? Infinity : (o.offset ?? 0) + o.limit;
  const hits: Session[] = [];
  const page = 500;
  let truncated = false;
  for (let offset = 0; ; offset += page) {
    if (offset >= QUERY_SCAN_CAP) {
      truncated = true;
      break;
    }
    const rows = await index.listSessions({ ...o.filter, limit: page, offset });
    for (const s of rows) if (await match(s)) hits.push(s);
    // Unsorted: newest first is the store's order, so stop once the page is full.
    if (rows.length < page || (!sorted && hits.length >= want)) break;
  }
  const ordered = sorted ? sortSessions(hits, q) : hits;
  const start = o.offset ?? 0;
  return { sessions: ordered.slice(start, o.limit === undefined ? undefined : start + o.limit), ...(truncated ? { truncated } : {}) };
}

/** The values a session has for a facet key (event keys: across its events). */
function facetValues(key: string, s: Session, events: () => AgentEvent[]): string[] {
  const def = KEYS.get(key)!;
  const get = def.facet?.get ?? def.get;
  const raw = def.level === "event" ? events().flatMap((e) => get(e as Session & AgentEvent)) : get(s as Session & AgentEvent);
  const prefix = def.multi?.prefix ?? "";
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string" || v === "") continue;
    if (prefix) {
      if (v.toLowerCase().startsWith(prefix) && v.length > prefix.length) out.add(v.slice(prefix.length));
    } else out.add(v);
  }
  return [...out];
}

/**
 * Sessions per value for each key, most first. Each key is counted over the
 * query without that key's own top-level clauses, like a facet sidebar.
 */
export async function facetCounts(index: IndexStore, q: Query, keys: readonly string[], o: QueryOpts = {}): Promise<Record<string, FacetCount[]>> {
  const out: Record<string, FacetCount[]> = {};
  const limit = o.limit ?? 20;
  for (const key of keys) {
    if (!FACET_KEYS.includes(key)) throw new RangeError(`can't count ${key}: facets work on ${FACET_KEYS.join(", ")}`);
    const sub = withoutKey(q, key);
    if (index.queryFacets) {
      out[key] = await index.queryFacets(sub, key, { ...o, limit });
      continue;
    }
    const event = KEYS.get(key)!.level === "event";
    if (event && !SCAN_EVENTS.has(index.kind)) throw unsupported(index, `Facets on ${key}`);
    const match = sessionMatcher(index, sub.root);
    const counts = new Map<string, number>();
    for (let offset = 0; offset < QUERY_SCAN_CAP; offset += 500) {
      const rows = await index.listSessions({ ...o.filter, limit: 500, offset });
      for (const s of rows) {
        if (!(await match(s))) continue;
        const events = event ? await index.listEvents(s.id) : [];
        for (const v of facetValues(key, s, () => events)) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      if (rows.length < 500) break;
    }
    const typed = o.prefix ? asciiLower(o.prefix) : "";
    out[key] = [...counts]
      .filter(([value]) => !typed || asciiLower(value).startsWith(typed))
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      .slice(0, limit);
  }
  return out;
}

/** ASCII-only lower case, as SQLite's LIKE folds case. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Events matching the query (event keys on the event, session keys on its
 * session), newest first, a page at a time. Without a store query path, scans
 * the newest QUERY_SCAN_CAP sessions' events; only the in-memory store can.
 */
export async function findEvents(index: IndexStore, q: Query, o: EventQueryOpts = {}): Promise<EventPage> {
  if (index.queryEvents) return index.queryEvents(q, o);
  if (!SCAN_EVENTS.has(index.kind)) {
    throw new QueryUnsupported(`Event results need the event index: the ${index.kind} store has no event query path. Use the Sessions results, or query the SQLite store.`);
  }
  const hits: AgentEvent[] = [];
  for (let offset = 0; offset < QUERY_SCAN_CAP; offset += 500) {
    const rows = await index.listSessions({ ...o.filter, limit: 500, offset });
    for (const s of rows) for (const e of await index.listEvents(s.id)) if (matchesEvent(q.root, e, s)) hits.push(e);
    if (rows.length < 500) break;
  }
  // Newest first; the same ts falls back to id, so the cursor `<ts>:<id>` is total.
  hits.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  let start = 0;
  if (o.cursor) {
    const i = o.cursor.indexOf(":");
    const ts = Number(o.cursor.slice(0, i));
    const id = o.cursor.slice(i + 1);
    if (i < 0 || !Number.isFinite(ts)) throw new RangeError("bad events cursor");
    start = hits.findIndex((e) => e.ts < ts || (e.ts === ts && e.id < id));
    if (start < 0) start = hits.length;
  }
  const limit = o.limit ?? 50;
  const items = hits.slice(start, start + limit);
  const out: EventPage = { items };
  const last = items[items.length - 1];
  if (start + limit < hits.length && last) out.next = `${last.ts}:${last.id}`;
  if (o.countUpTo !== undefined) {
    out.total = Math.min(hits.length, o.countUpTo);
    if (hits.length > o.countUpTo) out.totalCapped = true;
  }
  return out;
}

/**
 * Full-text hits restricted by the query at event level. Without a store query
 * path, filters the top hits in memory (reads up to 10x the limit, at most 2000).
 */
export async function searchWhere(index: IndexStore, text: string, q: Query, opts: SearchOpts = {}): Promise<SearchHit[]> {
  if (!q.root) return index.search(text, opts);
  if (index.searchWhere) return index.searchWhere(text, q, opts);
  const limit = opts.limit ?? 50;
  const hits = await index.search(text, { ...opts, limit: Math.min(2000, limit * 10) });
  const sessions = new Map<string, Session | undefined>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const id = h.event.sessionId;
    if (!sessions.has(id)) sessions.set(id, await index.getSession(id));
    if (matchesEvent(q.root, h.event, sessions.get(id))) out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
