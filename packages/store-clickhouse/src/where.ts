// `--where` (coding.sh's filter language) compiled to ClickHouse SQL, so
// querySessions and queryFacets run in the database instead of the core's
// in-memory scan. It follows coding.sh's SQLite compiler (src/query/compile.ts)
// clause for clause, with the semantics of its scan (src/query/match.ts): a
// NULL never matches, even under negation; `*` globs and `contains` keys fold
// ASCII case; positive event clauses in one AND group hold for the same event.
//
// ClickHouse has no correlated subqueries, so "the session has an event that…"
// is `id IN (SELECT session_id FROM events FINAL WHERE …)`. Key names map to
// fixed SQL below; every user value is a typed {pN:Type} parameter, so no input
// changes the statement's text. A key this plugin does not know (a newer
// coding.sh) throws QueryUnsupported instead of guessing.
import { HAS, IS, KEYS, levelOf, QueryError, QueryUnsupported, searchTerms, type Cmp, type KeyDef, type Node, type Value } from "coding.sh/store";
import type { ParamValue } from "./client.ts";

/** Binds a value as a typed parameter and returns its placeholder ({pN:Type}). */
export type Bind = (type: string, v: ParamValue) => string;

/**
 * Query terms: folded letters and digits only, so a term can hold no LIKE
 * wildcard (% _ \). Each still travels as a bound parameter.
 */
export function likeTerms(text: string): string[] {
  return searchTerms(text).flatMap((t) => t.match(/[\p{L}\p{N}]+/gu) ?? []);
}

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** LIKE pattern from a value: `*` → %, and %, _ and \ escaped with \. */
function likePattern(raw: string, wildcard: boolean): string {
  const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  return wildcard ? raw.split("*").map(esc).join("%") : esc(raw);
}

const path = (keys: string) => keys.split(".").map((k) => `'${k}'`).join(", ");
/** A JSON number at `keys` (dotted) of a JSON String column, else NULL. */
const jnum = (col: string, keys: string) => `if(JSONType(${col}, ${path(keys)}) IN ('Int64', 'UInt64', 'Double'), JSONExtractFloat(${col}, ${path(keys)}), NULL)`;
/** A JSON string at `keys` of a JSON String column, else NULL. */
const jstr = (col: string, keys: string) => `if(JSONType(${col}, ${path(keys)}) = 'String', JSONExtractString(${col}, ${path(keys)}), NULL)`;
const stat = (keys: string) => jnum("stats", keys);
/** A repo's name as coding.sh's repoName: the text after the last / or \ (empty after a trailing slash), "tmp" for the macOS temp dir. */
const base = (x: string) => `if(match(replaceAll(${x}, '\\\\', '/'), '(?s)/var/folders/.*/T$'), 'tmp', replaceRegexpOne(replaceAll(${x}, '\\\\', '/'), '(?s)^.*/', ''))`;
const tokens = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].map((k) => `ifNull(${stat(`usage.${k}`)}, 0)`).join(" + ");

/**
 * SQL over the sessions row, or (event keys) over an events row; a clause
 * matches when any expression does. Flags use the lambda argument `f`.
 */
export const KEY_SQL: Record<string, string[]> = {
  agent: ["agent"],
  model: ["model"],
  provider: [jstr("stats", "provider")],
  launch: [jstr("stats", "launch")],
  repo: ["repo_root", base("coalesce(repo_root, cwd)")],
  branch: [jstr("ifNull(repo, '{}')", "branch")],
  dir: ["cwd"],
  title: ["title"],
  id: ["id"],
  run: ["run_id"],
  parent: ["parent_session_id"],
  flag: ["f"],
  skill: ["f"],
  hook: ["f"],
  "hook.tokens": [stat("hookContext.tokens")],
  since: ["started_at"],
  until: ["started_at"],
  duration: ["(ended_at - started_at)"],
  turns: [stat("turns")],
  tools: [stat("toolCalls")],
  "tool.errors": [stat("toolErrors")],
  "llm.errors": [stat("llmErrors.count")],
  files: [stat("filesChanged")],
  events: [stat("events")],
  "tests.passed": [stat("testsPassed")],
  "tests.failed": [stat("testsFailed")],
  tokens: [`if(JSONType(stats, 'usage') = 'Object', ${tokens}, NULL)`],
  "tokens.in": [stat("usage.inputTokens")],
  "tokens.out": [stat("usage.outputTokens")],
  cost: [stat("usage.costUsd")],
  "cache.breaks": [stat("cacheBreaks.count")],
  "cache.lost": [stat("cacheBreaks.lostTokens")],
  "cache.cost": [stat("cacheBreaks.extraUsd")],
  unapproved: [stat("unapprovedActions.count")],
  kind: ["kind"],
  tool: ["tool"],
  ok: ["ok"],
  mcp: [jstr("payload", "server")],
  error: [jstr("payload", "error")],
  "event.duration": ["duration_ms"],
};
/** Facet value when it differs from the key's first expression. */
const FACET_SQL: Record<string, string> = { repo: base("coalesce(repo_root, cwd)") };

/** has:/is: over the sessions row; never NULL. */
export const HAS_SQL: Record<string, string> = {
  tests: "(JSONHas(stats, 'testsPassed') OR JSONHas(stats, 'testsFailed'))",
  cost: "(JSONType(stats, 'usage', 'costUsd') IN ('Int64', 'UInt64', 'Double'))",
  repo: "isNotNull(repo_root)",
  error: `(ifNull(${stat("toolErrors")}, 0) > 0 OR ifNull(${stat("llmErrors.count")}, 0) > 0)`,
  title: "(ifNull(title, '') != '')",
};
export const IS_SQL: Record<string, string> = {
  root: "isNull(parent_session_id)",
  child: "isNotNull(parent_session_id)",
  flagged: "arrayExists(f -> position(f, ':') = 0, flags)",
  run: "isNotNull(run_id)",
  ended: "isNotNull(ended_at)",
};

const OPS: Record<string, string> = { ">": ">", ">=": ">=", "<": "<", "<=": "<=", ":": "=" };

const unknown = (what: string) =>
  new QueryUnsupported(`this coding.sh-store-clickhouse can't filter on ${what}: upgrade coding.sh-store-clickhouse to match coding.sh, or drop that clause`);

/** Throws QueryUnsupported when the query names a key or has:/is: value this plugin has no SQL for. */
export function assertSupported(n: Node): void {
  switch (n.t) {
    case "and":
    case "or":
      return n.items.forEach(assertSupported);
    case "not":
      return assertSupported(n.item);
    case "cmp":
      if (!KEYS.has(n.key) || !KEY_SQL[n.key]) throw unknown(n.key);
      return;
    case "has":
    case "is":
      if (!(n.t === "has" ? HAS : IS)[n.name] || !(n.t === "has" ? HAS_SQL : IS_SQL)[n.name]) throw unknown(`${n.t}:${n.name}`);
      return;
  }
}

class Compiler {
  private readonly bind: Bind;
  private readonly events: string;
  constructor(bind: Bind, events: string) {
    this.bind = bind;
    this.events = events;
  }

  private valueSql(def: KeyDef, c: Cmp, v: Value, expr: string): string {
    if (def.type === "text") {
      const p = def.multi?.prefix ?? "";
      // lower() folds ASCII only, as SQLite's LIKE does.
      if (def.match === "contains") return `lower(${expr}) LIKE ${this.bind("String", asciiLower(`%${likePattern(v.raw, v.kind === "glob")}%`))}`;
      if (v.kind === "glob") return `lower(${expr}) LIKE ${this.bind("String", asciiLower(likePattern(p, false) + likePattern(v.raw, true)))}`;
      return `${expr} = ${this.bind("String", p + v.raw)}`;
    }
    if (def.type === "bool") return `${expr} = ${this.bind("Bool", v.n === 1)}`;
    if (def.type === "time") return `${expr} ${def.bound === "since" ? ">=" : "<"} ${this.bind("Float64", v.n!)}`;
    if (v.kind === "range") return `${expr} BETWEEN ${this.bind("Float64", v.lo!)} AND ${this.bind("Float64", v.hi!)}`;
    return `${expr} ${OPS[c.op]} ${this.bind("Float64", v.n!)}`;
  }

  /** A key clause; `negated` wraps nullable columns so NOT(NULL) reads as true, as in the scan. */
  cmp(c: Cmp, negated: boolean): string {
    const def = KEYS.get(c.key)!;
    if (def.multi) return `arrayExists(f -> ${c.values.map((v) => this.valueSql(def, c, v, "f")).join(" OR ")}, flags)`;
    const parts = KEY_SQL[c.key]!.flatMap((expr) => c.values.map((v) => this.valueSql(def, c, v, expr)));
    const sql = parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
    return negated && !def.notNull ? `ifNull(${sql}, 0)` : sql;
  }

  /** Every word is a word prefix in one event's search text (the store's search()). */
  text(words: string[], at: number): string {
    const terms = likeTerms(words.join(" "));
    if (!terms.length) throw new QueryError("search text has no letters or digits", at, { reason: "bad_value", next: ['quote it as a key value instead, e.g. title:"#42"'] });
    return `id IN (SELECT session_id FROM ${this.events} FINAL WHERE ${terms.map((t) => `search_text LIKE ${this.bind("String", `% ${t}%`)}`).join(" AND ")})`;
  }

  /** Condition over an events row. */
  event(n: Node, negated = false): string {
    switch (n.t) {
      case "and":
        return `(${n.items.map((x) => this.event(x, negated)).join(" AND ")})`;
      case "or":
        return `(${n.items.map((x) => this.event(x, negated)).join(" OR ")})`;
      case "not":
        return `NOT (${this.event(n.item, !negated)})`;
      case "cmp":
        return this.cmp(n, negated);
      default:
        // levelOf() keeps session clauses and text out of event groups.
        throw new Error(`${n.t} inside an event clause`);
    }
  }

  private exists(n: Node): string {
    return `id IN (SELECT session_id FROM ${this.events} FINAL WHERE ${this.event(n)})`;
  }

  /** Condition over the sessions row. */
  session(n: Node, negated = false): string {
    switch (n.t) {
      case "text":
        return this.text(n.words, n.at);
      case "cmp":
        return KEYS.get(n.key)!.level === "event" ? this.exists(n) : this.cmp(n, negated);
      case "has":
        return HAS_SQL[n.name]!;
      case "is":
        return IS_SQL[n.name]!;
      case "not":
        return levelOf(n.item) === "event" ? `NOT (${this.exists(n.item)})` : `NOT (${this.session(n.item, !negated)})`;
      case "or":
        return levelOf(n) === "event" ? this.exists(n) : `(${n.items.map((x) => this.session(x, negated)).join(" OR ")})`;
      case "and": {
        const together = n.items.filter((x) => x.t !== "not" && levelOf(x) === "event");
        const rest = n.items.filter((x) => !together.includes(x));
        const parts = together.length ? [this.exists(together.length === 1 ? together[0]! : { t: "and", items: together })] : [];
        for (const x of rest) parts.push(this.session(x, negated));
        return `(${parts.join(" AND ")})`;
      }
    }
  }
}

/** The query as a condition over `sessions FINAL`. `events` is the database-qualified events table. */
export function compileWhere(root: Node, bind: Bind, events: string): string {
  assertSupported(root);
  return new Compiler(bind, events).session(root);
}

/** ORDER BY for `sort:` (missing values last), then newest first, then id. */
export function orderBy(sort: { key: string; desc: boolean } | undefined): string {
  if (!sort || sort.key === "started") return `started_at ${sort && !sort.desc ? "ASC" : "DESC"}, id`;
  const expr = KEY_SQL[sort.key]?.[0];
  if (!expr) throw unknown(`sort:${sort.key}`);
  return `isNull(${expr}), ${expr} ${sort.desc ? "DESC" : "ASC"}, started_at DESC, id`;
}

/**
 * A SELECT of one row per value per session (`fv` the value, `sid` the session)
 * for a facet key, over the sessions that `where` ("WHERE …" or "") selects.
 */
export function facetRows(key: string, bind: Bind, sessions: string, events: string, where: string): string {
  const def = KEYS.get(key);
  if (!def || !KEY_SQL[key]) throw unknown(key);
  if (def.multi) {
    const p = def.multi.prefix;
    const value = p ? `arrayJoin(arrayMap(f -> substring(f, ${p.length + 1}), arrayFilter(f -> lower(f) LIKE ${bind("String", `${likePattern(asciiLower(p), false)}%`)}, flags)))` : "arrayJoin(flags)";
    return `SELECT ${value} AS fv, id AS sid FROM ${sessions} FINAL ${where}`;
  }
  const value = FACET_SQL[key] ?? KEY_SQL[key]![0]!;
  if (def.level === "session") return `SELECT ${value} AS fv, id AS sid FROM ${sessions} FINAL ${where}`;
  return `SELECT ${value} AS fv, session_id AS sid FROM ${events} FINAL WHERE session_id IN (SELECT id FROM ${sessions} FINAL ${where})`;
}
