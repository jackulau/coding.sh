// Session references: what a person or an agent may pass where coding.sh takes a session id, and the
// shortest id coding.sh prints for one. The CLI (cli/common.ts resolveSession), the MCP tools
// (mcp/tools.ts) and `work show` resolve through findSessionRef, so a short id one of them prints
// opens in the others. An id whose shortest prefix is long or needs quoting in a shell (a T3 Code
// thread id can run past 200 characters, with percent-encoding) prints as an alias instead.
import { hash } from "node:crypto";
import { isEmptySession } from "./sessions.ts";
import type { IndexStore, Session, SessionFilter } from "./types.ts";

/** Shortest prefix that may stand for a session id (git's minimum for short hashes). */
export const MIN_ID_PREFIX = 4;
/** Shortest id coding.sh prints: a longer prefix than MIN_ID_PREFIX, so a printed id stays unique as the store grows. */
export const SHORT_ID_MIN = 8;
/** Candidates an ambiguous reference lists. */
export const MAX_CANDIDATES = 10;

const SUB = ":sub:";

/** Longest prefix coding.sh prints: a longer shortest prefix prints as an alias. */
const MAX_REF = 40;
/**
 * A reference bash, PowerShell and cmd all pass on as typed, with no quotes: a letter, digit or `_`
 * first, then those and `. : / -`. One with any other character (`%`, a space, `&`, `$`…) prints as an alias.
 */
const PLAIN_REF = /^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/;
/**
 * An alias is `x_` and the first 8 to 14 digits of the id's SHA-256 in Crockford's base32, lowercase
 * (no i, l, o or u): x_d52r41f3. `x` is not a hex digit, so an alias is not the start of a UUID or a
 * hex id, and a letter first never reads as a number in PowerShell.
 */
const ALIAS = "x_";
const ALIAS_MIN = 8;
const ALIAS_MAX = 14;
const ALIAS_DIGITS = "0123456789abcdefghjkmnpqrstvwxyz";
const ALIAS_RE = /^x_([0-9a-hjkmnp-tv-z]{8,14})$/;

/** The 14 alias digits of `id`: the first 70 bits of its SHA-256, 5 bits a digit. The same on every machine. */
function aliasDigits(id: string): string {
  const hex = hash("sha256", id);
  let out = "";
  // 5 hex digits are 20 bits, 4 alias digits.
  for (let i = 0; out.length < ALIAS_MAX; i += 5) {
    const n = Number.parseInt(hex.slice(i, i + 5), 16);
    for (let shift = 15; shift >= 0; shift -= 5) out += ALIAS_DIGITS[(n >> shift) & 31];
  }
  return out.slice(0, ALIAS_MAX);
}

/**
 * True when `id` may print as an alias, so an alias may name it: an id longer than MAX_REF, one with
 * a character outside PLAIN_REF, or a subagent whose own id starts with `.`, `:`, `/` or `-`. Only
 * these ids are hashed.
 */
function aliasable(id: string): boolean {
  return id.length > MAX_REF || !PLAIN_REF.test(id) || /:sub:[.:/-]/.test(id);
}

/** What a reference names: one id, or several it cannot choose between. */
export type RefMatch = { id: string } | { ambiguous: string[] };

/** First index in sorted `xs` whose key is >= `key`. */
function lowerBound<T>(xs: readonly T[], key: string, at: (x: T) => string): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(xs[mid]!) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const self = (x: string): string => x;
const first = (x: readonly [string, string]): string => x[0];
const byFirst = (a: readonly [string, string], b: readonly [string, string]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/**
 * Every stored session id, sorted, with the agent ids of subagents (`<parent>:sub:<agent>`) for
 * lookup by that part, and the aliases of the ids that may print one.
 */
export class IdSet {
  readonly ids: readonly string[];
  #tails: [string, string][] | undefined;
  #aliases: [string, string][] | undefined;

  constructor(ids: Iterable<string>) {
    this.ids = [...new Set(ids)].sort();
  }

  has(id: string): boolean {
    return this.ids[lowerBound(this.ids, id, self)] === id;
  }

  /** The ids that start with `prefix`. */
  withPrefix(prefix: string): string[] {
    const out: string[] = [];
    for (let i = lowerBound(this.ids, prefix, self); i < this.ids.length && this.ids[i]!.startsWith(prefix); i++) out.push(this.ids[i]!);
    return out;
  }

  /** The subagent ids with a `:sub:` part that starts with `ref` (`<parent>:sub:<ref…>`), sorted. */
  byTail(ref: string): string[] {
    if (!this.#tails) {
      const tails: [string, string][] = [];
      for (const id of this.ids) {
        for (let at = id.indexOf(SUB); at >= 0; at = id.indexOf(SUB, at + 1)) tails.push([id.slice(at + SUB.length), id]);
      }
      this.#tails = tails.sort(byFirst);
    }
    const out = new Set<string>();
    const tails = this.#tails;
    for (let i = lowerBound(tails, ref, first); i < tails.length && tails[i]![0].startsWith(ref); i++) out.add(tails[i]![1]);
    return [...out].sort();
  }

  /** The ids that may print an alias (aliasable) whose alias digits start with `digits`, sorted. They are hashed on the first call. */
  byAlias(digits: string): string[] {
    if (!this.#aliases) {
      const aliases: [string, string][] = [];
      for (const id of this.ids) if (aliasable(id)) aliases.push([aliasDigits(id), id]);
      this.#aliases = aliases.sort(byFirst);
    }
    const out: string[] = [];
    const aliases = this.#aliases;
    for (let i = lowerBound(aliases, digits, first); i < aliases.length && aliases[i]![0].startsWith(digits); i++) out.push(aliases[i]![1]);
    return out.sort();
  }
}

/**
 * The one session `ids` stand for. A session X with its subagents X:sub:* is X, so a prefix of a
 * parent id does not turn ambiguous because its subagents share it.
 */
function pick(ids: readonly string[]): RefMatch | undefined {
  if (ids.length === 0) return undefined;
  if (ids.length === 1) return { id: ids[0]! };
  const head = ids.reduce((a, b) => (b.length < a.length ? b : a));
  if (ids.every((x) => x === head || x.startsWith(`${head}${SUB}`))) return { id: head };
  return { ambiguous: [...ids] };
}

/**
 * What `ref` names among the stored ids, tried in this order: the exact id; an alias (`x_` and 8 to
 * 14 alias digits, shortestRef), whose digits start the alias digits of an id that may print one; a
 * prefix of at least MIN_ID_PREFIX characters; an SDK id without its default project
 * (`tenant-7/conv-123` for `default/tenant-7/conv-123`, see server/project.ts scopeSessionId); a
 * subagent's own id without its parent (`a33e97aa…`); a short subagent id (shortSessionId: each
 * `:sub:` part a prefix of the stored part). The first step that matches decides, even when it is
 * ambiguous: an alias two ids share lists both.
 */
export function matchRef(set: IdSet, ref: string): RefMatch | undefined {
  if (!ref) return undefined;
  if (set.has(ref)) return { id: ref };
  const alias = ALIAS_RE.exec(ref);
  if (alias) {
    const ids = set.byAlias(alias[1]!);
    if (ids.length === 1) return { id: ids[0]! };
    if (ids.length > 1) return { ambiguous: ids };
  }
  if (ref.length >= MIN_ID_PREFIX) {
    const m = pick(set.withPrefix(ref));
    if (m) return m;
  }
  if (ref.includes("/") && !ref.startsWith("default/")) {
    const scoped = `default/${ref}`;
    if (set.has(scoped)) return { id: scoped };
    const m = pick(set.withPrefix(scoped));
    if (m) return m;
  }
  if (ref.length >= MIN_ID_PREFIX && !ref.includes(":")) {
    const m = pick(set.byTail(ref));
    if (m) return m;
  }
  const parts = ref.split(SUB);
  if (parts.length >= 2 && parts[0]!.length >= MIN_ID_PREFIX && parts.every((p) => p)) {
    const m = pick(
      set.ids.filter((x) => {
        const xs = x.split(SUB);
        return xs.length === parts.length && xs.every((p, i) => p.startsWith(parts[i]!));
      }),
    );
    if (m) return m;
  }
  return undefined;
}

/**
 * A session id short enough for a table: its first 8 characters, and for a subagent
 * (`<parent>:sub:<agentId>`) 8 of each part (`a03d2f6b:sub:a7d49789`), so it does not read as
 * its parent. matchRef takes it back.
 */
export function shortSessionId(id: string): string {
  return id.split(SUB).map((part) => part.slice(0, SHORT_ID_MIN)).join(SUB);
}

/** The smallest n in [lo, hi] for which `ok(n)` holds, when ok is false below some n and true from it on; undefined when ok(hi) is false. */
function smallest(lo: number, hi: number, ok: (n: number) => boolean): number | undefined {
  if (lo > hi || !ok(hi)) return undefined;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** True when matchRef takes `ref` to `id` and nothing else. */
function names(set: IdSet, ref: string, id: string): boolean {
  const m = matchRef(set, ref);
  return !!m && "id" in m && m.id === id;
}

/**
 * The shortest reference to `id` that matchRef takes back to it today, at least SHORT_ID_MIN
 * characters: a prefix of a top-level id; for a subagent, a prefix of its own id or the short
 * subagent form. When that is longer than MAX_REF characters or needs quoting in a shell
 * (PLAIN_REF), an alias instead: x_ and the first 8 alias digits, or more when 8 also name another
 * id or start a stored one. An id with no shorter form (or one of SHORT_ID_MIN characters or fewer)
 * comes back whole, and so does one not stored.
 */
export function shortestRef(set: IdSet, id: string): string {
  if (!set.has(id)) return id;
  const best = shortestPrefix(set, id);
  if (best.length <= MAX_REF && PLAIN_REF.test(best)) return best;
  const digits = aliasDigits(id);
  for (let k = ALIAS_MIN; k <= ALIAS_MAX; k++) {
    const ref = `${ALIAS}${digits.slice(0, k)}`;
    // An SDK may name a session x_…: an alias that starts a stored id would read as a prefix of it.
    if (set.withPrefix(ref).length === 0 && names(set, ref, id)) return ref;
  }
  return best;
}

/** The reference shortestRef prints for a stored `id` when it needs no alias. */
function shortestPrefix(set: IdSet, id: string): string {
  if (id.length <= SHORT_ID_MIN) return id;
  let best = id;
  // A subagent's own id: what its transcript calls it, usually unique in 8 characters.
  const cut = id.lastIndexOf(SUB);
  const tail = cut >= 0 ? id.slice(cut + SUB.length) : "";
  if (tail.length >= SHORT_ID_MIN && !tail.includes(":")) {
    const n = smallest(SHORT_ID_MIN, Math.min(tail.length, best.length - 1), (k) => names(set, tail.slice(0, k), id));
    if (n !== undefined) best = tail.slice(0, n);
  }
  if (cut >= 0) {
    // Not a prefix: one that stops in the parent's part names the parent, and one past it reads as a cut-off id.
    const s = shortSessionId(id);
    if (s.length < best.length && names(set, s, id)) best = s;
    return best;
  }
  // A prefix: longer prefixes name fewer ids, so the shortest that names this one is found by bisecting.
  const n = smallest(SHORT_ID_MIN, id.length - 1, (k) => names(set, id.slice(0, k), id));
  return n === undefined ? best : id.slice(0, n);
}

/** Every stored session id, read once: the id column only where the store has a prefix lookup. */
export async function loadIdSet(index: Pick<IndexStore, "listSessions" | "sessionIdsByPrefix">): Promise<IdSet> {
  if (index.sessionIdsByPrefix) return new IdSet(await index.sessionIdsByPrefix("", 2 ** 31 - 1));
  return new IdSet((await index.listSessions()).map((s) => s.id));
}

/** A function from a stored id to its shortest reference (shortestRef), read from the store once and remembered per id. */
export async function shortener(index: Pick<IndexStore, "listSessions" | "sessionIdsByPrefix">): Promise<(id: string) => string> {
  const set = await loadIdSet(index);
  const seen = new Map<string, string>();
  return (id) => {
    let s = seen.get(id);
    if (s === undefined) seen.set(id, (s = shortestRef(set, id)));
    return s;
  };
}

/** One session an ambiguous reference matches, as the CLI's --json and the MCP error list them. */
export interface RefCandidate {
  id: string;
  /** The shortest reference that names this candidate alone. */
  shortId: string;
  agent: string;
  startedAt: number;
  title?: string;
}

/** A reference that matches more than one session: the newest MAX_CANDIDATES of them, and whether there are more. */
export class AmbiguousRef extends Error {
  readonly ref: string;
  readonly candidates: RefCandidate[];
  readonly more: boolean;
  constructor(ref: string, candidates: RefCandidate[], more: boolean) {
    super(`Session id prefix ${JSON.stringify(ref)} is ambiguous`);
    this.name = "AmbiguousRef";
    this.ref = ref;
    this.candidates = candidates;
    this.more = more;
  }
}

/**
 * The session `ref` names: the exact id, `latest` or `last` (latestSession), or what matchRef
 * takes. Undefined when nothing matches; an ambiguous reference throws AmbiguousRef.
 */
export async function findSessionRef(index: IndexStore, ref: string): Promise<Session | undefined> {
  if (ref === "latest" || ref === "last") return latestSession(index);
  const exact = await index.getSession(ref);
  if (exact) return exact;
  const set = await loadIdSet(index);
  const m = matchRef(set, ref);
  if (!m) return undefined;
  if ("id" in m) return index.getSession(m.id);
  const sessions = (await Promise.all(m.ambiguous.slice(0, MAX_CANDIDATES).map((x) => index.getSession(x)))).filter((x): x is Session => x !== undefined);
  sessions.sort((a, b) => b.startedAt - a.startedAt);
  const candidates = sessions.map((s) => {
    const c: RefCandidate = { id: s.id, shortId: shortestRef(set, s.id), agent: s.agent, startedAt: s.startedAt };
    if (s.title) c.title = s.title;
    return c;
  });
  throw new AmbiguousRef(ref, candidates, m.ambiguous.length > MAX_CANDIDATES);
}

/**
 * The newest top-level session worth looking at: the newest one that is not empty (a hook with
 * no work behind it), else the newest of all. When that session is an agent run under
 * `coding.sh run` (no snapshots of its own), the wrapper session around it, the one `run`
 * printed, which holds the start and end snapshots `eval new` needs. Sessions with a run id
 * (eval, compare and experiment trials carry one) count only when there are no others.
 */
export async function latestSession(index: IndexStore): Promise<Session | undefined> {
  return (await newestSession(index, { runId: null })) ?? (await newestSession(index, {}));
}

/** {@link latestSession} among the top-level sessions `filter` keeps. */
async function newestSession(index: IndexStore, filter: SessionFilter): Promise<Session | undefined> {
  const page = 50;
  let newest: Session | undefined;
  for (let offset = 0; offset < page * 4; offset += page) {
    const rows = await index.listSessions({ ...filter, limit: page, offset, parentSessionId: null });
    newest ??= rows[0];
    const hit = rows.find((s) => !isEmptySession(s));
    if (hit) return (await wrapperAround(index, hit)) ?? hit;
    if (rows.length < page) break;
  }
  return newest;
}

/** The `coding.sh run` wrapper session that was running when `s` started, when `s` has no snapshots of its own. */
async function wrapperAround(index: IndexStore, s: Session): Promise<Session | undefined> {
  if (s.agent === "wrapper" || s.repo?.snapshot || s.endSnapshot) return undefined;
  const wrappers = await index.listSessions({ agent: "wrapper", since: s.startedAt - 6 * 3600e3, limit: 20, parentSessionId: null });
  return wrappers.find((w) => w.startedAt <= s.startedAt && (w.endedAt === undefined || w.endedAt >= s.startedAt) && (!w.cwd || !s.cwd || w.cwd === s.cwd));
}
