// Compiles a parsed `--where` query to a parameterized SQL condition for the
// SQLite index. Key names map to fixed SQL from the key table in where.ts; every
// user value is a bound `?` parameter, so no input changes the statement's shape.
//
// Session level (`sessions s`): event clauses become `s.id IN (SELECT session_id
// FROM events e WHERE …)`; positive event clauses in one AND group share one
// subquery (the same event), a negated one becomes NOT IN. The subquery is not
// correlated, so SQLite runs it once on an event index (events_tool_ok,
// events_ok, events_kind_ts, events_mcp, events_duration, events_error), not once per session. Event level (`events e` joined to
// `sessions s`): every clause applies to the event or its session. Semantics
// match src/query/match.ts, the scan fallback.
import { ftsQuery } from "../store/common.ts";
import { globParts, HAS, IS, KEYS, levelOf, QueryError, type Cmp, type KeyDef, type Node, type Value } from "./where.ts";

export type Param = string | number;
export interface Sql {
  sql: string;
  params: Param[];
}

const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** LIKE pattern from a value: its wildcards → %, and %, _ and \ escaped (ESCAPE '\'). */
function likePattern(v: Value): string {
  return v.kind === "glob" ? globParts(v).map(esc).join("%") : esc(v.raw);
}

const or = (xs: string[]) => (xs.length === 1 ? xs[0]! : `(${xs.join(" OR ")})`);

const OPS: Record<string, string> = { ">": ">", ">=": ">=", "<": "<", "<=": "<=", ":": "=" };

class Compiler {
  readonly params: Param[] = [];

  private bind(v: Param): string {
    this.params.push(v);
    return "?";
  }

  /** One value against one SQL expression. */
  private valueSql(def: KeyDef, c: Cmp, v: Value, expr: string): string {
    if (def.type === "text") {
      const p = def.multi?.prefix ?? "";
      if (def.match === "contains") return `${expr} LIKE ${this.bind(`%${likePattern(v)}%`)} ESCAPE '\\'`;
      if (v.kind === "glob") return `${expr} LIKE ${this.bind(esc(p) + likePattern(v))} ESCAPE '\\'`;
      return `${expr} = ${this.bind(p + v.raw)}`;
    }
    if (def.type === "bool") return `${expr} = ${this.bind(v.n!)}`;
    if (def.type === "time") return `${expr} ${def.bound === "since" ? ">=" : "<"} ${this.bind(v.n!)}`;
    if (v.kind === "range") return `${expr} BETWEEN ${this.bind(v.lo!)} AND ${this.bind(v.hi!)}`;
    return `${expr} ${OPS[c.op]} ${this.bind(v.n!)}`;
  }

  /** A key clause; `negated` wraps nullable columns so NOT(NULL) reads as true, as in the scan. */
  cmp(c: Cmp, negated: boolean): string {
    const def = KEYS.get(c.key)!;
    if (def.multi) {
      const any = c.values.map((v) => this.valueSql(def, c, v, "j.value")).join(" OR ");
      return `EXISTS (SELECT 1 FROM json_each(${def.multi.from}) j WHERE ${any})`;
    }
    const branches = this.branches(c);
    const sql = branches
      ? or(branches)
      : def.present
        ? `(${def.present} AND ${or(def.sql.flatMap((expr) => c.values.map((v) => this.valueSql(def, c, v, expr))))})`
        : or(def.sql.flatMap((expr) => c.values.map((v) => this.valueSql(def, c, v, expr))));
    return negated && !def.notNull ? `coalesce(${sql}, 0)` : sql;
  }

  /** A key with one guard per SQL expression: one condition per expression, each on its own index. */
  private branches(c: Cmp): string[] | undefined {
    const def = KEYS.get(c.key)!;
    const guards = def.present;
    if (!Array.isArray(guards)) return undefined;
    return def.sql.map((expr, i) => `(${guards[i]} AND ${or(c.values.map((v) => this.valueSql(def, c, v, expr)))})`);
  }

  text(words: string[], level: "session" | "event", at: number): string {
    const q = ftsQuery(words.join(" "));
    if (!q) throw new QueryError("search text has no letters or digits", at, { reason: "bad_value", next: ["quote it as a key value instead, e.g. title:\"#42\""] });
    const p = this.bind(q);
    return level === "event"
      ? `e.rowid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ${p})`
      : `s.id IN (SELECT ev.session_id FROM events_fts JOIN events ev ON ev.rowid = events_fts.rowid WHERE events_fts MATCH ${p})`;
  }

  /** Condition over `e` (and `s` for session clauses). */
  event(n: Node, negated = false): string {
    switch (n.t) {
      case "and":
        return `(${n.items.map((x) => this.event(x, negated)).join(" AND ")})`;
      case "or":
        return `(${n.items.map((x) => this.event(x, negated)).join(" OR ")})`;
      case "not":
        return `NOT (${this.event(n.item, !negated)})`;
      case "text":
        return this.text(n.words, "event", n.at);
      case "cmp":
        return this.cmp(n, negated);
      case "has":
        return HAS[n.name]!.sql;
      case "is":
        return IS[n.name]!.sql;
    }
  }

  /** Sessions with an event matching `n` (event keys only, so the subquery never reads `s`). */
  private exists(n: Node, negated = false): string {
    // A key read from several columns (error:) unions one subquery per column, so each reads its own index.
    const branches = n.t === "cmp" ? this.branches(n) : undefined;
    const from = branches ? branches.map((b) => `SELECT e.session_id FROM events e WHERE ${b}`).join(" UNION ALL ") : `SELECT e.session_id FROM events e WHERE ${this.event(n)}`;
    return `s.id ${negated ? "NOT IN" : "IN"} (${from})`;
  }

  /** Condition over `s`. */
  session(n: Node, negated = false): string {
    switch (n.t) {
      case "text":
        return this.text(n.words, "session", n.at);
      case "cmp":
        return KEYS.get(n.key)!.level === "event" ? this.exists(n) : this.cmp(n, negated);
      case "has":
        return HAS[n.name]!.sql;
      case "is":
        return IS[n.name]!.sql;
      case "not":
        return levelOf(n.item) === "event" ? this.exists(n.item, true) : `NOT (${this.session(n.item, !negated)})`;
      case "or":
        return levelOf(n) === "event" ? this.exists(n) : `(${n.items.map((x) => this.session(x, negated)).join(" OR ")})`;
      case "and": {
        const together = n.items.filter((x) => x.t !== "not" && levelOf(x) === "event");
        const rest = n.items.filter((x) => !together.includes(x));
        // Compiled in output order: parameters bind left to right.
        const parts = together.length ? [this.exists(together.length === 1 ? together[0]! : { t: "and", items: together })] : [];
        for (const x of rest) parts.push(this.session(x, negated));
        return `(${parts.join(" AND ")})`;
      }
    }
  }
}

/** The query as a condition over `sessions s`, or over `events e` joined to `sessions s`. */
export function compileWhere(root: Node, level: "session" | "event"): Sql {
  const c = new Compiler();
  const sql = level === "session" ? c.session(root) : c.event(root);
  return { sql, params: c.params };
}

/** ORDER BY for `sort:` (fixed SQL from the key table; missing values last), then newest first. */
export function orderBy(sort: { key: string; desc: boolean } | undefined): string {
  if (!sort || sort.key === "started") return `s.started_at ${sort && !sort.desc ? "ASC" : "DESC"}, s.id`;
  const expr = KEYS.get(sort.key)!.sql[0]!;
  return `(${expr}) IS NULL, (${expr}) ${sort.desc ? "DESC" : "ASC"}, s.started_at DESC, s.id`;
}

/**
 * Facet value expression and FROM clause for a key (one row per value per session).
 * Event keys read session_facets, the distinct values each session's events
 * have, so a count never touches the events table; `facetKey` is then the
 * session_facets key to bind.
 */
export function facetSource(key: string): { value: string; from: string; prefix?: string; facetKey?: string } {
  const def = KEYS.get(key)!;
  if (def.multi) return { value: def.multi.prefix ? `substr(j.value, ${def.multi.prefix.length + 1})` : "j.value", from: `sessions s, json_each(${def.multi.from}) j`, prefix: def.multi.prefix };
  if (def.level === "event") return { value: "f.value", from: "session_facets f JOIN sessions s ON s.id = f.session_id", facetKey: key };
  return { value: def.facet?.sql ?? def.sql[0]!, from: "sessions s" };
}

/** Event keys whose values session_facets keeps (one row per session and value). */
export const SESSION_FACET_KEYS = ["kind", "tool", "mcp"] as const;
