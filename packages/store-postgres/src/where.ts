// `--where` (coding.sh's filter language) compiled to Postgres SQL, so
// querySessions and queryFacets run in the database instead of the core's
// in-memory scan. It follows coding.sh's SQLite compiler (src/query/compile.ts)
// clause for clause, with the semantics of its scan (src/query/match.ts): a
// NULL never matches, even under negation; `*` globs and `contains` keys fold
// ASCII case; positive event clauses in one AND group hold for the same event.
//
// Key names map to fixed SQL below. Every user value is a bound $n parameter,
// so no input changes the statement's shape. A key this plugin does not know
// (a newer coding.sh) throws QueryUnsupported instead of guessing.
import { HAS, IS, KEYS, levelOf, QueryError, QueryUnsupported, searchTerms, type Cmp, type KeyDef, type Node, type Value } from "coding.sh/store";

/** Binds a value and returns its placeholder ($n). */
export type Bind = (v: unknown) => string;

/**
 * to_tsquery input: every term is a word prefix, ANDed. Terms are letters and
 * digits only (anything else splits them), so user input can never form
 * tsquery operators; the string is still bound as a parameter.
 */
export function tsQuery(text: string): { query: string; terms: string[] } | undefined {
  const terms = searchTerms(text).flatMap((t) => t.match(/[\p{L}\p{N}]+/gu) ?? []);
  if (!terms.length) return undefined;
  return { query: terms.map((t) => `${t}:*`).join(" & "), terms };
}

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** ASCII-only lower case in SQL, as SQLite's LIKE folds (lower() would fold by locale). */
export const lowerSql = (x: string): string => `translate(${x}, '${UPPER}', '${UPPER.toLowerCase()}')`;
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** LIKE pattern from a value: `*` → %, and %, _ and \ escaped (\ is Postgres's default LIKE escape). */
function likePattern(raw: string, wildcard: boolean): string {
  const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  return wildcard ? raw.split("*").map(esc).join("%") : esc(raw);
}

/** A JSON number at `path` of a JSON text column, else NULL. */
const jnum = (col: string, path: string) => `(CASE WHEN json_typeof(${col}::json #> '{${path}}') = 'number' THEN (${col}::json #>> '{${path}}')::float8 END)`;
/** A JSON string at `path` of a JSON text column, else NULL. */
const jstr = (col: string, path: string) => `(CASE WHEN json_typeof(${col}::json #> '{${path}}') = 'string' THEN ${col}::json #>> '{${path}}' END)`;
const stat = (path: string) => jnum("s.stats", path);
/** A repo's name as coding.sh's repoName: the text after the last / or \ (empty after a trailing slash), "tmp" for the macOS temp dir. */
const base = (x: string) => `(CASE WHEN replace(${x}, chr(92), '/') ~ '/var/folders/.*/T$' THEN 'tmp' ELSE regexp_replace(replace(${x}, chr(92), '/'), '^.*/', '') END)`;
const tokens = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].map((k) => `coalesce(${stat(`usage,${k}`)}, 0)`).join(" + ");

/** SQL over `s` (sessions) or `e` (events) per key; a clause matches when any expression does. Flags use `f.v`. */
export const KEY_SQL: Record<string, string[]> = {
  agent: ["s.agent"],
  model: ["s.model"],
  provider: [jstr("s.stats", "provider")],
  launch: [jstr("s.stats", "launch")],
  repo: ["s.repo_root", base("coalesce(s.repo_root, s.cwd)")],
  branch: [jstr("s.repo", "branch")],
  dir: ["s.cwd"],
  title: ["s.title"],
  id: ["s.id"],
  run: ["s.run_id"],
  parent: ["s.parent_session_id"],
  flag: ["f.v"],
  skill: ["f.v"],
  hook: ["f.v"],
  "hook.tokens": [stat("hookContext,tokens")],
  since: ["s.started_at"],
  until: ["s.started_at"],
  duration: ["(s.ended_at - s.started_at)"],
  turns: [stat("turns")],
  tools: [stat("toolCalls")],
  "tool.errors": [stat("toolErrors")],
  "llm.errors": [stat("llmErrors,count")],
  files: [stat("filesChanged")],
  events: [stat("events")],
  "tests.passed": [stat("testsPassed")],
  "tests.failed": [stat("testsFailed")],
  tokens: [`(CASE WHEN json_typeof(s.stats::json -> 'usage') = 'object' THEN ${tokens} END)`],
  "tokens.in": [stat("usage,inputTokens")],
  "tokens.out": [stat("usage,outputTokens")],
  cost: [stat("usage,costUsd")],
  "cache.breaks": [stat("cacheBreaks,count")],
  "cache.lost": [stat("cacheBreaks,lostTokens")],
  "cache.cost": [stat("cacheBreaks,extraUsd")],
  unapproved: [stat("unapprovedActions,count")],
  kind: ["e.kind"],
  tool: ["e.tool"],
  ok: ["e.ok"],
  mcp: [jstr("e.payload", "server")],
  error: [jstr("e.payload", "error")],
  "event.duration": ["e.duration_ms"],
};
/** Facet value when it differs from the key's first expression. */
const FACET_SQL: Record<string, string> = { repo: base("coalesce(s.repo_root, s.cwd)") };

/** has:/is: over `s`; never NULL. */
export const HAS_SQL: Record<string, string> = {
  tests: "((s.stats::json -> 'testsPassed') IS NOT NULL OR (s.stats::json -> 'testsFailed') IS NOT NULL)",
  cost: "(coalesce(json_typeof(s.stats::json #> '{usage,costUsd}'), '') = 'number')",
  repo: "(s.repo_root IS NOT NULL)",
  error: `(coalesce(${stat("toolErrors")}, 0) > 0 OR coalesce(${stat("llmErrors,count")}, 0) > 0)`,
  title: "(s.title IS NOT NULL AND s.title <> '')",
};
export const IS_SQL: Record<string, string> = {
  root: "(s.parent_session_id IS NULL)",
  child: "(s.parent_session_id IS NOT NULL)",
  flagged: "EXISTS (SELECT 1 FROM json_array_elements_text(s.flags::json) AS f(v) WHERE strpos(f.v, ':') = 0)",
  run: "(s.run_id IS NOT NULL)",
  ended: "(s.ended_at IS NOT NULL)",
};

const OPS: Record<string, string> = { ">": ">", ">=": ">=", "<": "<", "<=": "<=", ":": "=" };

const unknown = (what: string) =>
  new QueryUnsupported(`this coding.sh-store-postgres can't filter on ${what}: upgrade coding.sh-store-postgres to match coding.sh, or drop that clause`);

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
      if (def.match === "contains") return `${lowerSql(expr)} LIKE ${this.bind(asciiLower(`%${likePattern(v.raw, v.kind === "glob")}%`))}`;
      if (v.kind === "glob") return `${lowerSql(expr)} LIKE ${this.bind(asciiLower(likePattern(p, false) + likePattern(v.raw, true)))}`;
      return `${expr} = ${this.bind(p + v.raw)}`;
    }
    if (def.type === "bool") return `${expr} = ${this.bind(v.n === 1)}`;
    if (def.type === "time") return `${expr} ${def.bound === "since" ? ">=" : "<"} ${this.bind(v.n!)}`;
    if (v.kind === "range") return `${expr} BETWEEN ${this.bind(v.lo!)} AND ${this.bind(v.hi!)}`;
    return `${expr} ${OPS[c.op]} ${this.bind(v.n!)}`;
  }

  /** A key clause; `negated` wraps nullable columns so NOT(NULL) reads as true, as in the scan. */
  cmp(c: Cmp, negated: boolean): string {
    const def = KEYS.get(c.key)!;
    if (def.multi) {
      const any = c.values.map((v) => this.valueSql(def, c, v, "f.v")).join(" OR ");
      return `EXISTS (SELECT 1 FROM json_array_elements_text(s.flags::json) AS f(v) WHERE ${any})`;
    }
    const parts = KEY_SQL[c.key]!.flatMap((expr) => c.values.map((v) => this.valueSql(def, c, v, expr)));
    const sql = parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
    return negated && !def.notNull ? `coalesce(${sql}, false)` : sql;
  }

  text(words: string[], at: number): string {
    const tq = tsQuery(words.join(" "));
    if (!tq) throw new QueryError("search text has no letters or digits", at, { reason: "bad_value", next: ['quote it as a key value instead, e.g. title:"#42"'] });
    return `s.id IN (SELECT e.session_id FROM ${this.events} e WHERE e.tsv @@ to_tsquery('simple', ${this.bind(tq.query)}))`;
  }

  /** Condition over `e` (and `s`), inside an EXISTS over the session's events. */
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
      case "has":
        return HAS_SQL[n.name]!;
      case "is":
        return IS_SQL[n.name]!;
      case "text":
        // levelOf() keeps text out of event groups; it is matched per session.
        throw new Error("text inside an event clause");
    }
  }

  private exists(n: Node): string {
    return `EXISTS (SELECT 1 FROM ${this.events} e WHERE e.session_id = s.id AND ${this.event(n)})`;
  }

  /** Condition over `s`. */
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
        return levelOf(n.item) === "event" ? `NOT ${this.exists(n.item)}` : `NOT (${this.session(n.item, !negated)})`;
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

/** The query as a condition over `sessions s`. `events` is the schema-qualified events table. */
export function compileWhere(root: Node, bind: Bind, events: string): string {
  assertSupported(root);
  return new Compiler(bind, events).session(root);
}

/** ORDER BY for `sort:` (missing values last), then newest first, then id. */
export function orderBy(sort: { key: string; desc: boolean } | undefined): string {
  if (!sort || sort.key === "started") return `s.started_at ${sort && !sort.desc ? "ASC" : "DESC"}, s.id`;
  const expr = KEY_SQL[sort.key]?.[0];
  if (!expr) throw unknown(`sort:${sort.key}`);
  return `(${expr}) IS NULL, (${expr}) ${sort.desc ? "DESC" : "ASC"}, s.started_at DESC, s.id`;
}

/**
 * Facet value and FROM clause for a key: one row per value per session (`s.id`
 * names the session). `where` is an extra condition for prefixed flags (skill:).
 */
export function facetSource(key: string, bind: Bind, sessions: string, events: string): { value: string; from: string; where?: string } {
  const def = KEYS.get(key);
  if (!def || !KEY_SQL[key]) throw unknown(key);
  if (def.multi) {
    const from = `${sessions} s CROSS JOIN LATERAL json_array_elements_text(s.flags::json) AS ff(v)`;
    const p = def.multi.prefix;
    if (!p) return { value: "ff.v", from };
    return { value: `substr(ff.v, ${p.length + 1})`, from, where: `${lowerSql("ff.v")} LIKE ${bind(`${likePattern(asciiLower(p), false)}%`)}` };
  }
  const value = FACET_SQL[key] ?? KEY_SQL[key]![0]!;
  return def.level === "event" ? { value, from: `${events} e JOIN ${sessions} s ON s.id = e.session_id` } : { value, from: `${sessions} s` };
}
