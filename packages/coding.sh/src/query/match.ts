// The scan fallback for `--where`: evaluates a parsed query on rows in memory,
// with exactly the semantics src/query/compile.ts gives SQLite (a test runs both
// on the same fixtures and compares ids).
//
// Session level: an event clause means "the session has an event that matches";
// positive event clauses ANDed together must hold for the same event, and a
// negated one means "no such event". Text means one event holds every word.
import type { AgentEvent, Session } from "../schema/index.ts";
import { searchableText, searchTerms, termMatches } from "../store/common.ts";
import { globParts, HAS, IS, KEYS, levelOf, type Cmp, type KeyDef, type Leaf, type Node, type Query, type Value } from "./where.ts";

/** ASCII-only lower case, as SQLite's LIKE folds case. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A LIKE-style pattern as a regex over ASCII-lowered text: `parts` are the literal pieces between wildcards. */
function likeRegex(parts: string[], contains: boolean): RegExp {
  const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = parts.map((p) => esc(asciiLower(p))).join("[\\s\\S]*");
  return new RegExp(contains ? body : `^${body}$`);
}

function textValueMatches(def: KeyDef, v: Value, x: unknown): boolean {
  if (typeof x !== "string") return false;
  const parts = v.kind === "glob" ? globParts(v) : [v.raw];
  const p = def.multi?.prefix ?? "";
  if (def.match === "contains") return likeRegex(parts, true).test(asciiLower(x));
  if (v.kind === "glob") return likeRegex([p + parts[0]!, ...parts.slice(1)], false).test(asciiLower(x));
  return x === p + v.raw;
}

function numberMatches(c: Cmp, v: Value, x: unknown): boolean {
  if (typeof x !== "number" || !Number.isFinite(x)) return false;
  if (v.kind === "range") return x >= v.lo! && x <= v.hi!;
  const n = v.n!;
  switch (c.op) {
    case ">":
      return x > n;
    case ">=":
      return x >= n;
    case "<":
      return x < n;
    case "<=":
      return x <= n;
    default:
      return x === n;
  }
}

/** One clause on one row (a session for session keys, an event for event keys). */
export function leafMatches(n: Leaf, row: Session | AgentEvent): boolean {
  if (n.t === "has" || n.t === "is") return (n.t === "has" ? HAS : IS)[n.name]!.get(row as Session);
  if (n.t === "text") return textMatches(n.words, row as AgentEvent);
  const def = KEYS.get(n.key)!;
  const xs = def.get(row as Session & AgentEvent);
  return n.values.some((v) => {
    if (def.type === "text") return xs.some((x) => textValueMatches(def, v, x));
    if (def.type === "bool") return xs.some((x) => typeof x === "boolean" && (x ? 1 : 0) === v.n);
    if (def.type === "time") return xs.some((x) => typeof x === "number" && (def.bound === "since" ? x >= v.n! : x < v.n!));
    return xs.some((x) => numberMatches(n, v, x));
  });
}

/** Every word is a word in the event's searchable text, the last a word prefix (the FTS query, ftsQuery). */
export function textMatches(words: string[], e: AgentEvent): boolean {
  const terms = words.flatMap((w) => searchTerms(w));
  if (!terms.length) return false;
  const body = searchableText(e);
  if (!body) return false;
  const have = searchTerms(body);
  return terms.every((_, i) => have.some((w) => termMatches(w, terms, i)));
}

/** The query on one event and its session (event level: `search --where`). */
export function matchesEvent(n: Node | undefined, e: AgentEvent, s: Session | undefined): boolean {
  if (!n) return true;
  switch (n.t) {
    case "and":
      return n.items.every((x) => matchesEvent(x, e, s));
    case "or":
      return n.items.some((x) => matchesEvent(x, e, s));
    case "not":
      return !matchesEvent(n.item, e, s);
    case "text":
      return textMatches(n.words, e);
    case "cmp":
      if (KEYS.get(n.key)!.level === "event") return leafMatches(n, e);
      return s !== undefined && leafMatches(n, s);
    default:
      return s !== undefined && leafMatches(n, s);
  }
}

/**
 * The query on one session. `events` is called only when a clause needs them
 * (and at most once per session by the caller's cache).
 */
export function matchesSession(n: Node | undefined, s: Session, events: () => AgentEvent[]): boolean {
  if (!n) return true;
  const anyEvent = (node: Node) => events().some((e) => matchesEvent(node, e, undefined));
  switch (n.t) {
    case "text":
      return events().some((e) => textMatches(n.words, e));
    case "cmp":
      return KEYS.get(n.key)!.level === "event" ? anyEvent(n) : leafMatches(n, s);
    case "has":
    case "is":
      return leafMatches(n, s);
    case "not":
      return levelOf(n.item) === "event" ? !anyEvent(n.item) : !matchesSession(n.item, s, events);
    case "or":
      return levelOf(n) === "event" ? anyEvent(n) : n.items.some((x) => matchesSession(x, s, events));
    case "and": {
      // Positive event clauses hold for one event together; the rest one by one.
      const together = n.items.filter((x) => x.t !== "not" && levelOf(x) === "event");
      const rest = n.items.filter((x) => !together.includes(x));
      if (together.length && !anyEvent(together.length === 1 ? together[0]! : { t: "and", items: together })) return false;
      return rest.every((x) => matchesSession(x, s, events));
    }
  }
}

/** Sort value of a session for `sort:` (undefined sorts last). */
export function sortValue(s: Session, key: string): number | undefined {
  if (key === "started") return s.startedAt;
  const v = KEYS.get(key)!.get(s as Session & AgentEvent)[0];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Orders sessions as the SQLite path does: by the sort key (missing last), then newest first, then id. */
export function sortSessions(list: Session[], q: Query): Session[] {
  const sort = q.sort ?? { key: "started", desc: true };
  return list.sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === undefined || y === undefined) {
      if (x !== y) return x === undefined ? 1 : -1;
    } else if (x !== y) return sort.desc ? y - x : x - y;
    return b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}
