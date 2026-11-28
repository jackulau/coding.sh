// The filter language behind `--where` (CLI), `where` (MCP) and `?where=` (viewer API):
// `agent:codex model:claude-* cost>0.5 duration>10m -flag:compaction (tool:Bash OR tool:Edit) "migration"`.
//
// parseWhere turns a string into an AST; printWhere turns it back (normalized). The
// key table is the one allowlist: src/query/compile.ts turns the AST into
// parameterized SQL for the SQLite store and src/query/match.ts evaluates it on rows
// for every other store. Both read the same table, so a key behaves the same on
// every surface. This file imports no store, so the CLI registry can load the
// key docs for help without one.
import { CONTEXT_FLAGS, isFailureFlag } from "../core/failure-flags.ts";
import type { AgentEvent, ProofLang, Session, SupervisionRisk } from "../schema/index.ts";
import { parseWhen } from "./time.ts";

export type Op = ":" | ">" | ">=" | "<" | "<=";

/** One value of a `key:value` clause, resolved for the key's type. */
export interface Value {
  /** As typed, without surrounding quotes. */
  raw: string;
  quoted: boolean;
  /** eq: equals; glob: `*` wildcards (text keys); range: `a..b` inclusive (number keys). */
  kind: "eq" | "glob" | "range";
  /**
   * glob only, set when the value also holds a literal star (`\*` inside quotes): the text
   * between the wildcards. Without it, every `*` in raw is a wildcard (see globParts).
   */
  parts?: string[];
  /** Number keys: the value (eq) or the bounds (range); time keys: epoch ms. */
  n?: number;
  lo?: number;
  hi?: number;
}

export interface Cmp {
  t: "cmp";
  key: string;
  op: Op;
  /** More than one (`agent:codex,claude-code`) means any of them. */
  values: Value[];
  at: number;
}
/** `has:tests`, `is:root`. */
export type Has = { t: "has"; name: string; at: number } | { t: "is"; name: string; at: number };
/** Bare words: every word must appear in one event's text (full-text index). */
export interface Text {
  t: "text";
  words: string[];
  /** Quoted phrases keep their quotes when printed. */
  quoted: boolean[];
  at: number;
}
export interface And {
  t: "and";
  items: Node[];
}
export interface Or {
  t: "or";
  items: Node[];
}
export interface Not {
  t: "not";
  item: Node;
}
export type Node = Cmp | Has | Text | And | Or | Not;
export type Leaf = Cmp | Has | Text;

export interface Query {
  /** Undefined when the string held only directives (or nothing). */
  root?: Node;
  /** `sort:-cost`: a numeric session key or `started`. */
  sort?: { key: string; desc: boolean };
  /** `limit:50`. */
  limit?: number;
}

/** A query string that does not parse. `offset` is where in the string it went wrong. */
export class QueryError extends Error {
  readonly offset: number;
  readonly reason: string;
  readonly next: string[];
  constructor(message: string, offset: number, opts: { reason?: string; next?: string[] } = {}) {
    super(message);
    this.name = "QueryError";
    this.offset = offset;
    this.reason = opts.reason ?? "bad_query";
    this.next = opts.next ?? [];
  }
  /** By name, so one thrown by a store plugin's bundled copy of this module matches too. */
  static override [Symbol.hasInstance](x: unknown): boolean {
    return x instanceof Error && x.name === "QueryError";
  }
}

/** A query this store cannot answer (event keys or text on a store without a query path). */
export class QueryUnsupported extends Error {
  readonly reason = "unsupported_store";
  constructor(message: string) {
    super(message);
    this.name = "QueryUnsupported";
  }
  static override [Symbol.hasInstance](x: unknown): boolean {
    return x instanceof Error && x.name === "QueryUnsupported";
  }
}

// ------------------------------------------------------------ keys

export type KeyType = "text" | "number" | "bool" | "time";
/** How a number key reads its value: plain counts (k/M suffixes), durations (needs a unit), USD. */
export type Unit = "count" | "ms" | "usd";

export interface KeyDef {
  name: string;
  level: "session" | "event";
  type: KeyType;
  unit?: Unit;
  /** Text keys: equals (default) or contains (case-insensitive substring). */
  match?: "exact" | "contains";
  /** Text keys with a fixed enum of allowed values (normalized to lowercase). */
  choices?: readonly string[];
  /** Text keys: the one spelling stored values have, applied to each typed value (repo: windowsSpelling). */
  spell?: (raw: string) => string;
  /** Time keys: since = at or after, until = before. */
  bound?: "since" | "until";
  doc: string;
  example: string;
  /**
   * SQL expressions over `s` (sessions) or `e` (events); a clause matches when any
   * of them does. Multi keys (flags, weights.checkpoint) use `j.value` from `multi.from` instead.
   */
  sql: string[];
  /** Columns that are never NULL (no COALESCE needed under negation). */
  notNull?: boolean;
  /**
   * SQL that is true exactly when the value is set, put before the comparison. For a key
   * whose index holds only the rows with a value (`WHERE error IS NOT NULL`): SQLite takes
   * such an index only when the query says so, and LIKE alone does not. A list gives one
   * guard per `sql` expression, so each branch of the OR can start from its own index.
   */
  present?: string | string[];
  /** A list-valued field: one EXISTS over json_each of `from` (a JSON array, or NULL for none), values compared after `prefix`. */
  multi?: { from: string; prefix: string };
  /** The values the scan fallback compares (one per `sql` expression, or every list item for multi). */
  get(row: Session & AgentEvent): unknown[];
  /**
   * Counted by facets: which value expression (default sql[0]). `group`, for a costly `sql` that
   * reads only a few columns: those columns, and the same value over them as g.c0, g.c1, … (SQLite
   * counts the sessions per distinct set of columns first, then works the value out once per set).
   */
  facet?: { sql?: string; get?(row: Session & AgentEvent): unknown[]; group?: { cols: string[]; sql: string } };
  /**
   * An event key that says something about the whole session (user:, read from its session.start):
   * in a group with other event keys it matches its own event, not the same one (levelOf: "mixed").
   */
  alone?: true;
}

/**
 * A repo's name for SQLite: the text after the last / or \ (empty after a trailing slash),
 * except "tmp" for the macOS temp dir (/var/folders/xx/yyy/T, where `claude -p` from a script
 * often runs), which would otherwise be "T".
 */
const sqlRepoName = (x: string): string => {
  const n = `replace(${x}, '\\', '/')`;
  return `CASE WHEN ${n} GLOB '*/var/folders/*/T' THEN 'tmp' ELSE replace(${n}, rtrim(${n}, replace(${n}, '/', '')), '') END`;
};
/** The same in JS, so the scan fallback agrees with SQL byte for byte. */
export const repoName = (p: string | undefined): string | undefined => {
  if (p === undefined) return undefined;
  const n = p.replace(/\\/g, "/");
  return /\/var\/folders\/[\s\S]*\/T$/.test(n) ? "tmp" : n.slice(n.lastIndexOf("/") + 1);
};

/** The repo a worktree an agent made belongs to, read from the worktree's path (worktreeRepo). */
export interface WorktreeRepo {
  /** The repo's folder name. */
  name: string;
  /** The repo's root, when the path holds it (Claude Code's layout). */
  path?: string;
}

const CLAUDE_WT = "/.claude/worktrees/";
const T3_WT = "/.t3/worktrees/";
const CODEX_WT = "/.codex/worktrees/";

/**
 * The repo a worktree an agent made for a task belongs to, from the folder's path alone (a
 * folder inside the worktree counts too; / or \ separators). It names the repo when git cannot:
 * the worktree was removed, or the session was stored before RepoState.main.
 * - Claude Code: <repo>/.claude/worktrees/<name>: the repo's path and name.
 * - T3 Code: ~/.t3/worktrees/<repo>/<name>: the repo's name.
 * - Codex: ~/.codex/worktrees/<id>/<repo>: the repo's name.
 * sqlWorktree* below is the same rule in SQL; the two must agree.
 */
export function worktreeRepo(p: string | undefined): WorktreeRepo | undefined {
  if (p === undefined) return undefined;
  const n = p.replace(/\\/g, "/");
  if (/.\/\.claude\/worktrees\/./s.test(n)) {
    const path = p.slice(0, n.indexOf(CLAUDE_WT));
    return { name: repoName(path)!, path };
  }
  if (/\/\.t3\/worktrees\/.+\/./s.test(n)) {
    const rest = n.slice(n.indexOf(T3_WT) + T3_WT.length);
    return { name: rest.slice(0, rest.indexOf("/")) };
  }
  if (/\/\.codex\/worktrees\/.+\/./s.test(n)) {
    const rest = n.slice(n.indexOf(CODEX_WT) + CODEX_WT.length);
    const tail = rest.slice(rest.indexOf("/") + 1);
    const end = tail.indexOf("/");
    return { name: end >= 0 ? tail.slice(0, end) : tail };
  }
  return undefined;
}

/**
 * A Windows path in the spelling stored repo roots have: an upper-case drive letter and
 * backslashes (c:/w/demo is C:\w\demo). Anything else comes back as is. core/git.ts repoPath
 * adds the long name (it reads the disk; this file reads nothing), so this is the part of the
 * one spelling a typed `repo:` value can get without the disk.
 */
export function windowsSpelling(p: string): string {
  if (!/^[a-zA-Z]:(?:[\\/]|$)/.test(p)) return p;
  return p[0]!.toUpperCase() + p.slice(1).replace(/\//g, "\\");
}

/** What repoGroup reads: a session's repo state and cwd. */
type RepoPlace = { repo?: { root: string; main?: string } | undefined; cwd?: string | undefined };

/**
 * The repo a session counts under: a worktree's main repo (RepoState.main, else worktreeRepo of
 * its root or cwd), else its repo root, else its cwd. `path` is unknown when only the name is
 * (T3 Code's and Codex's layouts). The repo key, the repo facet and usage --by repo read it.
 */
export function repoGroup(s: RepoPlace): { name?: string; path?: string } {
  if (s.repo?.main !== undefined) return { name: repoName(s.repo.main)!, path: s.repo.main };
  const dir = s.repo?.root ?? s.cwd;
  const w = worktreeRepo(dir);
  if (w) return w;
  return dir === undefined ? {} : { name: repoName(dir)!, path: dir };
}

/** The path a repo key compares besides the root: RepoState.main, else the Claude Code worktree's repo. */
const groupPath = (s: RepoPlace): string | undefined => s.repo?.main ?? worktreeRepo(s.repo?.root ?? s.cwd)?.path;

// The same in SQL, over `dir` (the root, else the cwd) and `main` (RepoState.main).
const SQL_DIR = "coalesce(s.repo_root, s.cwd)";
const SQL_MAIN = "json_extract(s.repo, '$.main')";
const slashed = (x: string) => `replace(${x}, '\\', '/')`;
const after = (n: string, marker: string) => `substr(${n}, instr(${n}, '${marker}') + ${marker.length})`;
const beforeSlash = (x: string) => `substr(${x}, 1, instr(${x}, '/') - 1)`;
const sqlClaudeWt = (dir: string) => `${slashed(dir)} GLOB '?*${CLAUDE_WT}?*'`;
const sqlClaudeRepo = (dir: string) => `substr(${dir}, 1, instr(${slashed(dir)}, '${CLAUDE_WT}') - 1)`;
/** worktreeRepo(dir).name and the fallback name, in SQL. */
const sqlGroupName = (dir: string, main: string): string => {
  const n = slashed(dir);
  const t3 = after(n, T3_WT);
  const codex = `substr(${after(n, CODEX_WT)}, instr(${after(n, CODEX_WT)}, '/') + 1)`;
  return [
    `CASE WHEN ${main} IS NOT NULL THEN ${sqlRepoName(main)}`,
    `WHEN ${sqlClaudeWt(dir)} THEN ${sqlRepoName(sqlClaudeRepo(dir))}`,
    `WHEN ${n} GLOB '*${T3_WT}?*/?*' THEN ${beforeSlash(t3)}`,
    `WHEN ${n} GLOB '*${CODEX_WT}?*/?*' THEN (CASE WHEN instr(${codex}, '/') > 0 THEN ${beforeSlash(codex)} ELSE ${codex} END)`,
    `ELSE ${sqlRepoName(dir)} END`,
  ].join(" ");
};
const sqlGroupPath = (dir: string, main: string): string => `coalesce(${main}, CASE WHEN ${sqlClaudeWt(dir)} THEN ${sqlClaudeRepo(dir)} END)`;

const stat = (path: string) => `json_extract(s.stats, '$.${path}')`;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const RISK_LEVELS: readonly SupervisionRisk[] = ["medium", "high"];
const PROOF_LANGS: readonly ProofLang[] = ["lean", "rocq", "dafny", "verus", "isabelle", "tla", "tlc"];
const proofNum = (s: Session, field: "escapeRemaining" | "oscillatingChecks"): number | undefined => {
  const p = s.stats?.verification?.proof;
  if (!p) return undefined;
  return num(p[field]) ?? 0;
};
const tokensTotal = (s: Session): number | undefined => {
  const u = s.stats?.usage;
  if (!u) return undefined;
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
};

/**
 * A text key read from session.start payload fields; it matches when any of them does (`alone`: it
 * matches the start event, whatever else the group asks).
 */
function startKey(name: string, fields: readonly string[], doc: string, example: string): KeyDef {
  return {
    name, level: "event", type: "text", doc, example, alone: true,
    sql: fields.map((f) => `(CASE WHEN e.kind = 'session.start' AND json_type(e.payload, '$.${f}') = 'text' THEN json_extract(e.payload, '$.${f}') END)`),
    present: "e.kind = 'session.start'",
    get: (e) => fields.map((f) => (e.kind === "session.start" && typeof e.payload?.[f] === "string" ? e.payload[f] : undefined)),
  };
}

const KEY_LIST: KeyDef[] = [
  // ---- session keys
  // A host app's id (t3code) matches the sessions it drove too; facets count the agent that ran.
  { name: "agent", level: "session", type: "text", doc: "Agent id: the agent that ran, or the host app that drove it (agent:t3code)", example: "agent:codex", sql: ["s.agent", `coalesce(${stat("host")}, '')`], notNull: true, get: (s) => [s.agent, s.host], facet: { sql: "s.agent", get: (s) => [s.agent] } },
  { name: "model", level: "session", type: "text", doc: "Main model", example: "model:claude-sonnet-*", sql: ["s.model"], get: (s) => [s.model], facet: {} },
  { name: "provider", level: "session", type: "text", doc: "Model provider", example: "provider:anthropic", sql: [stat("provider")], get: (s) => [s.provider], facet: {} },
  {
    name: "repo",
    level: "session",
    type: "text",
    doc: "Repo root path, or its name (else the working directory's name; tmp for the macOS temp dir). A worktree's sessions match its main repo's path and name too",
    example: "repo:coding-sh",
    spell: windowsSpelling,
    sql: ["s.repo_root", sqlGroupPath(SQL_DIR, SQL_MAIN), sqlRepoName(SQL_DIR), sqlGroupName(SQL_DIR, SQL_MAIN)],
    get: (s) => [s.repo?.root, groupPath(s), repoName(s.repo?.root ?? s.cwd), repoGroup(s).name],
    // Far fewer folders than sessions: the name is worked out once per folder.
    facet: { sql: sqlGroupName(SQL_DIR, SQL_MAIN), group: { cols: [SQL_DIR, SQL_MAIN], sql: sqlGroupName("g.c0", "g.c1") }, get: (s) => [repoGroup(s).name] },
  },
  { name: "launch", level: "session", type: "text", doc: "How the agent was launched: headless (claude -p, an SDK, codex exec) or interactive", example: "launch:headless", sql: [stat("launch")], get: (s) => [s.stats?.launch], facet: {} },
  { name: "branch", level: "session", type: "text", doc: "Git branch", example: "branch:main", sql: ["json_extract(s.repo, '$.branch')"], get: (s) => [s.repo?.branch], facet: {} },
  { name: "dir", level: "session", type: "text", doc: "Working directory", example: "dir:/work/*", sql: ["s.cwd"], get: (s) => [s.cwd] },
  { name: "title", level: "session", type: "text", match: "contains", doc: "Title contains (case-insensitive)", example: "title:deploy", sql: ["s.title"], get: (s) => [s.title] },
  { name: "id", level: "session", type: "text", doc: "Session id", example: "id:01H*", sql: ["s.id"], notNull: true, get: (s) => [s.id] },
  { name: "run", level: "session", type: "text", doc: "Eval run id", example: "run:run_*", sql: ["s.run_id"], get: (s) => [s.runId] },
  { name: "parent", level: "session", type: "text", doc: "Parent session id (subagent sessions)", example: "parent:abc123", sql: ["s.parent_session_id"], get: (s) => [s.parent?.sessionId] },
  { name: "flag", level: "session", type: "text", doc: "Any flag or tag", example: "flag:no-verification", sql: ["j.value"], multi: { from: "s.flags", prefix: "" }, get: (s) => s.flags ?? [], facet: {} },
  { name: "skill", level: "session", type: "text", doc: "Skill tag (flag skill:<name>)", example: "skill:pdf", sql: ["j.value"], multi: { from: "s.flags", prefix: "skill:" }, get: (s) => s.flags ?? [], facet: {} },
  {
    name: "hook",
    level: "session",
    type: "text",
    doc: "Whose hooks added text to the context (flag hook:<source>): plugin:<name>, plugin, settings or unknown",
    example: "hook:plugin:terse",
    sql: ["j.value"],
    multi: { from: "s.flags", prefix: "hook:" },
    get: (s) => s.flags ?? [],
    facet: {},
  },
  { name: "hook.tokens", level: "session", type: "number", unit: "count", doc: "Tokens hooks added to the context (characters / 4)", example: "hook.tokens>500", sql: [stat("hookContext.tokens")], get: (s) => [num(s.stats?.hookContext?.tokens)] },
  { name: "weights.edits", level: "session", type: "number", unit: "count", doc: "Weight edits the session recorded", example: "weights.edits>0", sql: [stat("weightEdits.events")], get: (s) => [num(s.stats?.weightEdits?.events)] },
  { name: "weights.changed", level: "session", type: "number", unit: "count", doc: "Weights those edits changed, added up", example: "weights.changed>1000", sql: [stat("weightEdits.weightsChanged")], get: (s) => [num(s.stats?.weightEdits?.weightsChanged)] },
  {
    name: "weights.checkpoint",
    level: "session",
    type: "text",
    doc: "SHA-256 of a weights file the session recorded as a checkpoint (the value exp run --weights takes): 64 lowercase hex characters, or a prefix with *",
    example: "weights.checkpoint:58899f90572c*",
    sql: ["j.value"],
    multi: { from: stat("weightEdits.checkpoints"), prefix: "" },
    get: (s) => s.stats?.weightEdits?.checkpoints ?? [],
  },
  { name: "since", level: "session", type: "time", bound: "since", doc: "Started at or after: 7d, 12h, today, yesterday or a date. A date without a zone is local time: 2026-11-09 is local midnight", example: "since:7d", sql: ["s.started_at"], notNull: true, get: (s) => [s.startedAt] },
  { name: "until", level: "session", type: "time", bound: "until", doc: "Started before (exclusive): 7d, 12h, today or a date in local time. until:2026-11-01 leaves that day out", example: "until:2026-11-01", sql: ["s.started_at"], notNull: true, get: (s) => [s.startedAt] },
  { name: "duration", level: "session", type: "number", unit: "ms", doc: "Wall time of an ended session (30s, 10m, 2h)", example: "duration>10m", sql: ["(s.ended_at - s.started_at)"], get: (s) => [s.endedAt !== undefined ? s.endedAt - s.startedAt : undefined] },
  { name: "turns", level: "session", type: "number", unit: "count", doc: "User turns", example: "turns>=20", sql: [stat("turns")], get: (s) => [num(s.stats?.turns)] },
  { name: "tools", level: "session", type: "number", unit: "count", doc: "Tool calls", example: "tools>100", sql: [stat("toolCalls")], get: (s) => [num(s.stats?.toolCalls)] },
  { name: "tool.errors", level: "session", type: "number", unit: "count", doc: "Failed tool calls", example: "tool.errors>0", sql: [stat("toolErrors")], get: (s) => [num(s.stats?.toolErrors)] },
  { name: "llm.errors", level: "session", type: "number", unit: "count", doc: "Failed model calls", example: "llm.errors>0", sql: [stat("llmErrors.count")], get: (s) => [num(s.stats?.llmErrors?.count)] },
  { name: "files", level: "session", type: "number", unit: "count", doc: "Files changed", example: "files>=1", sql: [stat("filesChanged")], get: (s) => [num(s.stats?.filesChanged)] },
  { name: "events", level: "session", type: "number", unit: "count", doc: "Events captured", example: "events<10", sql: [stat("events")], get: (s) => [num(s.stats?.events)] },
  { name: "tests.passed", level: "session", type: "number", unit: "count", doc: "Passing tests seen", example: "tests.passed>0", sql: [stat("testsPassed")], get: (s) => [num(s.stats?.testsPassed)] },
  { name: "tests.failed", level: "session", type: "number", unit: "count", doc: "Failing tests seen", example: "tests.failed>0", sql: [stat("testsFailed")], get: (s) => [num(s.stats?.testsFailed)] },
  {
    name: "risk",
    level: "session",
    type: "text",
    choices: RISK_LEVELS,
    doc: "Supervision risk level: medium or high",
    example: "risk:high",
    sql: [stat("contextHygiene.supervisionRisk")],
    get: (s) => [s.stats?.contextHygiene?.supervisionRisk],
    facet: {},
  },
  {
    name: "risk.reason",
    level: "session",
    type: "text",
    doc: "Supervision risk reason (unverified-edits, tactic-oscillation, post-compaction-repeats, dead-end-loop, compaction-churn)",
    example: "risk.reason:tactic-oscillation",
    sql: ["j.value"],
    multi: { from: stat("contextHygiene.riskReasons"), prefix: "" },
    get: (s) => s.stats?.contextHygiene?.riskReasons ?? [],
    facet: {},
  },
  {
    name: "proof.lang",
    level: "session",
    type: "text",
    choices: PROOF_LANGS,
    doc: "Formal proof language (lean, rocq, dafny, verus, isabelle, tla, tlc)",
    example: "proof.lang:lean",
    sql: ["j.value"],
    multi: { from: stat("verification.proof.langs"), prefix: "" },
    get: (s) => s.stats?.verification?.proof?.langs ?? [],
    facet: {},
  },
  {
    name: "proof.escapes",
    level: "session",
    type: "number",
    unit: "count",
    doc: "Remaining proof escape hatches (sorry, Admitted, ...) in proof sessions",
    example: "proof.escapes>0",
    sql: [`CASE WHEN json_type(s.stats, '$.verification.proof') = 'object' THEN coalesce(${stat("verification.proof.escapeRemaining")}, 0) END`],
    get: (s) => [proofNum(s, "escapeRemaining")],
  },
  {
    name: "proof.oscillating",
    level: "session",
    type: "number",
    unit: "count",
    doc: "Consecutive repeated failing proof checks in proof sessions",
    example: "proof.oscillating>=2",
    sql: [`CASE WHEN json_type(s.stats, '$.verification.proof') = 'object' THEN coalesce(${stat("verification.proof.oscillatingChecks")}, 0) END`],
    get: (s) => [proofNum(s, "oscillatingChecks")],
  },
  {
    name: "unverified.edits",
    level: "session",
    type: "number",
    unit: "count",
    doc: "Longest consecutive streak of file edits with no mechanical check in between",
    example: "unverified.edits>=5",
    sql: [stat("verification.maxUnverifiedEdits")],
    get: (s) => [num(s.stats?.verification?.maxUnverifiedEdits)],
  },
  {
    name: "tokens",
    level: "session",
    type: "number",
    unit: "count",
    doc: "All tokens: input, output, cache read and write (k, M suffixes)",
    example: "tokens>1M",
    sql: [`CASE WHEN json_type(s.stats, '$.usage') = 'object' THEN coalesce(${stat("usage.inputTokens")}, 0) + coalesce(${stat("usage.outputTokens")}, 0) + coalesce(${stat("usage.cacheReadTokens")}, 0) + coalesce(${stat("usage.cacheWriteTokens")}, 0) END`],
    get: (s) => [tokensTotal(s)],
  },
  { name: "tokens.in", level: "session", type: "number", unit: "count", doc: "Input tokens", example: "tokens.in>100k", sql: [stat("usage.inputTokens")], get: (s) => [num(s.stats?.usage?.inputTokens)] },
  { name: "tokens.out", level: "session", type: "number", unit: "count", doc: "Output tokens", example: "tokens.out>10k", sql: [stat("usage.outputTokens")], get: (s) => [num(s.stats?.usage?.outputTokens)] },
  { name: "cost", level: "session", type: "number", unit: "usd", doc: "Cost in USD, reported or estimated", example: "cost>0.5", sql: [stat("usage.costUsd")], get: (s) => [num(s.stats?.usage?.costUsd)] },
  { name: "cache.breaks", level: "session", type: "number", unit: "count", doc: "Prompt-cache breaks: calls whose cached prefix was gone, so the prompt was billed again (core/cache-breaks.ts)", example: "cache.breaks>0", sql: [stat("cacheBreaks.count")], get: (s) => [num(s.stats?.cacheBreaks?.count)] },
  { name: "cache.lost", level: "session", type: "number", unit: "count", doc: "Prompt tokens billed again after a cache break", example: "cache.lost>10k", sql: [stat("cacheBreaks.lostTokens")], get: (s) => [num(s.stats?.cacheBreaks?.lostTokens)] },
  { name: "cache.cost", level: "session", type: "number", unit: "usd", doc: "Extra USD the cache breaks cost over cache-read prices", example: "cache.cost>0.1", sql: [stat("cacheBreaks.extraUsd")], get: (s) => [num(s.stats?.cacheBreaks?.extraUsd)] },
  { name: "unapproved", level: "session", type: "number", unit: "count", doc: "Destructive or paid commands the agent ran without the user approving them (flag unapproved-action, core/unapproved.ts)", example: "unapproved>0", sql: [stat("unapprovedActions.count")], get: (s) => [num(s.stats?.unapprovedActions?.count)] },
  // ---- event keys: in a session query they mean "has an event that…"
  { name: "kind", level: "event", type: "text", doc: "Event kind", example: "kind:tool.end", sql: ["e.kind"], notNull: true, get: (e) => [e.kind], facet: {} },
  { name: "tool", level: "event", type: "text", doc: "Tool name", example: "tool:Bash", sql: ["e.tool"], get: (e) => [typeof e.payload?.tool === "string" ? e.payload.tool : undefined], facet: {} },
  { name: "ok", level: "event", type: "bool", doc: "Tool call or model call succeeded", example: "ok:false", sql: ["e.ok"], get: (e) => [typeof e.payload?.ok === "boolean" ? e.payload.ok : undefined] },
  // events.mcp holds payload.server of tool calls (written at insert, indexed).
  { name: "mcp", level: "event", type: "text", doc: "MCP server of a tool call", example: "mcp:github", sql: ["e.mcp"], get: (e) => [typeof e.payload?.tool === "string" && typeof e.payload.server === "string" ? e.payload.server : undefined], facet: {} },
  // events.error holds payload.error when it is text (written at insert; events_error indexes the rows that have one).
  // An error event (kind error) carries its text in payload.message instead, read from the payload.
  {
    name: "error", level: "event", type: "text", match: "contains", doc: "Error text of a failed call, or an error event's message, contains (case-insensitive)", example: "error:ENOENT",
    sql: ["e.error", "(CASE WHEN e.kind = 'error' AND json_type(e.payload, '$.message') = 'text' THEN json_extract(e.payload, '$.message') END)"], present: ["e.error IS NOT NULL", "e.kind = 'error'"],
    get: (e) => [typeof e.payload?.error === "string" ? e.payload.error : undefined, e.kind === "error" && typeof e.payload?.message === "string" ? e.payload.message : undefined],
  },
  { name: "event.duration", level: "event", type: "number", unit: "ms", doc: "Event duration (30s, 2m)", example: "event.duration>30s", sql: ["e.duration_ms"], get: (e) => [num(e.durationMs)] },
  // Read from the session's start event (payload.user, .environment, .release: OTel and Langfuse trace
  // attributes; payload.userId: the user id given to the SDKs' trace()).
  startKey("user", ["user", "userId"], "User the app named (the SDKs' trace() user id, langfuse.user.id, user.id or enduser.id)", "user:alice"),
  startKey("env", ["environment"], "Deployment environment (langfuse.environment or deployment.environment.name)", "env:production"),
  startKey("release", ["release"], "Release or app version (langfuse.release or service.version)", "release:v1.4.*"),
];

export const KEYS: ReadonlyMap<string, KeyDef> = new Map(KEY_LIST.map((k) => [k.name, k]));

export interface HasDef {
  doc: string;
  /** SQL over `s`; never NULL. */
  sql: string;
  get(s: Session): boolean;
}

/** SQL for "the flag in `v` is a failure" (core/failure-flags.ts): no colon, and not a context flag. */
const sqlFailureFlag = (v: string): string =>
  `instr(${v}, ':') = 0${CONTEXT_FLAGS.length ? ` AND ${v} NOT IN (${CONTEXT_FLAGS.map((f) => `'${f.replaceAll("'", "''")}'`).join(", ")})` : ""}`;

export const HAS: Record<string, HasDef> = {
  tests: { doc: "test results seen", sql: "(json_type(s.stats, '$.testsPassed') IS NOT NULL OR json_type(s.stats, '$.testsFailed') IS NOT NULL)", get: (s) => s.stats?.testsPassed !== undefined || s.stats?.testsFailed !== undefined },
  cost: { doc: "a cost", sql: "(coalesce(json_type(s.stats, '$.usage.costUsd'), '') IN ('integer', 'real'))", get: (s) => num(s.stats?.usage?.costUsd) !== undefined },
  repo: { doc: "a git repo", sql: "(s.repo_root IS NOT NULL)", get: (s) => s.repo?.root !== undefined },
  error: { doc: "a failed tool or model call", sql: `(coalesce(${stat("toolErrors")}, 0) > 0 OR coalesce(${stat("llmErrors.count")}, 0) > 0)`, get: (s) => (s.stats?.toolErrors ?? 0) > 0 || (s.stats?.llmErrors?.count ?? 0) > 0 },
  title: { doc: "a title", sql: "(s.title IS NOT NULL AND s.title <> '')", get: (s) => !!s.title },
};

export const IS: Record<string, HasDef> = {
  root: { doc: "a top-level session", sql: "(s.parent_session_id IS NULL)", get: (s) => s.parent?.sessionId === undefined },
  child: { doc: "a subagent session", sql: "(s.parent_session_id IS NOT NULL)", get: (s) => s.parent?.sessionId !== undefined },
  flagged: { doc: "has a failure flag: not a tag with a colon, and not compaction, step-retried or resumed", sql: `EXISTS (SELECT 1 FROM json_each(s.flags) WHERE ${sqlFailureFlag("value")})`, get: (s) => (s.flags ?? []).some(isFailureFlag) },
  run: { doc: "from an eval run", sql: "(s.run_id IS NOT NULL)", get: (s) => s.runId !== undefined },
  ended: { doc: "has an end", sql: "(s.ended_at IS NOT NULL)", get: (s) => s.endedAt !== undefined },
};

/** Sort keys: started, or any number session key. */
export const SORT_KEYS: readonly string[] = ["started", ...KEY_LIST.filter((k) => k.level === "session" && k.type === "number").map((k) => k.name)];
/** Keys facets can count. */
export const FACET_KEYS: readonly string[] = KEY_LIST.filter((k) => k.facet).map((k) => k.name);
export const ALL_KEYS: readonly string[] = [...KEYS.keys(), "has", "is", "sort", "limit"];

/** One-line key docs for help text, MCP descriptions and the docs. */
export function keyDocs(): { name: string; level: string; doc: string; example: string }[] {
  return [
    ...KEY_LIST.map((k) => ({ name: k.name, level: k.level, doc: k.doc, example: k.example })),
    { name: "has", level: "session", doc: `Has ${Object.entries(HAS).map(([k, v]) => `${k} (${v.doc})`).join(", ")}`, example: "has:tests" },
    { name: "is", level: "session", doc: `Is ${Object.entries(IS).map(([k, v]) => `${k} (${v.doc})`).join(", ")}`, example: "is:root" },
    { name: "sort", level: "query", doc: `Order by ${SORT_KEYS.join(", ")}; - for descending`, example: "sort:-cost" },
    { name: "limit", level: "query", doc: "Maximum rows", example: "limit:50" },
  ];
}

/** What the viewer's query bar completes: each key, its type, and the values it can list without a lookup. */
export interface KeyGuide {
  name: string;
  level: "session" | "event" | "query";
  type: KeyType | "enum";
  doc: string;
  example: string;
  /** Values come from /api/facets. */
  facet?: true;
  /** Values the key takes, when there are few. */
  values?: { value: string; doc?: string }[];
}

export function keyGuide(): KeyGuide[] {
  const enumOf = (r: Record<string, HasDef>) => Object.entries(r).map(([value, d]) => ({ value, doc: d.doc }));
  return [
    ...KEY_LIST.map((k): KeyGuide => {
      const g: KeyGuide = {
        name: k.name, level: k.level, type: k.type, doc: k.doc, example: k.example,
        ...(k.facet ? { facet: true as const } : {}),
        ...(k.type === "bool" ? { values: [{ value: "true" }, { value: "false" }] } : {}),
        ...(k.type === "time" ? { values: ["1h", "24h", "7d", "30d"].map((value) => ({ value })) } : {}),
      };
      if (k.choices) g.values = k.choices.map((value) => ({ value }));
      return g;
    }),
    { name: "is", level: "session", type: "enum", doc: "Is a kind of session", example: "is:root", values: enumOf(IS) },
    { name: "has", level: "session", type: "enum", doc: "Has a field", example: "has:tests", values: enumOf(HAS) },
    { name: "sort", level: "query", type: "enum", doc: "Order by; - for descending", example: "sort:-cost", values: SORT_KEYS.flatMap((k) => [{ value: `-${k}` }, { value: k }]) },
  ];
}

// ------------------------------------------------------------ values

const MS_UNITS: Record<string, number> = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };
const COUNT_SUFFIX: Record<string, number> = { "": 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 };

/** A number in a key's unit, or undefined when it does not read as one. */
export function parseNumber(raw: string, unit: Unit): number | undefined {
  const t = raw.trim();
  if (unit === "ms") {
    const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(t);
    return m ? Number(m[1]) * MS_UNITS[m[2]!]! : undefined;
  }
  if (unit === "usd") {
    const m = /^\$?(\d+(?:\.\d+)?|\.\d+)$/.exec(t);
    return m ? Number(m[1]) : undefined;
  }
  const m = /^(-?\d+(?:\.\d+)?)([kKmMbB]?)$/.exec(t);
  return m ? Number(m[1]) * COUNT_SUFFIX[m[2]!]! : undefined;
}

/**
 * `7d` (ago), `today`, `yesterday`, a date or epoch ms → epoch ms (./time.ts, the reader --since uses too).
 * A date without a zone is read in `tzOffsetMin` (Date#getTimezoneOffset minutes), by default this process's zone.
 */
export function parseTime(raw: string, now: number, tzOffsetMin?: number): number | undefined {
  return parseWhen(raw, tzOffsetMin !== undefined ? { now, tzOffsetMin } : { now })?.ms;
}

const BOOL: Record<string, boolean> = { true: true, false: false, yes: true, no: false, "1": true, "0": false };
export const parseBool = (raw: string): boolean | undefined => BOOL[raw.toLowerCase()];

// ------------------------------------------------------------ tokens

type Tok =
  | { k: "("; at: number }
  | { k: ")"; at: number }
  | { k: "or"; at: number }
  | { k: "-"; at: number }
  | { k: "word"; at: number; text: string; quoted: boolean };

/** Reads a quoted string starting at q[i] === '"'; returns the unescaped text and the index after the closing quote. */
/** A quoted part: `\"` is a quote, `\\` a backslash, `\*` a literal star; `wild` holds where the other stars (wildcards) are in `text`. */
function readQuoted(q: string, i: number): { text: string; end: number; wild: number[] } {
  let out = "";
  const wild: number[] = [];
  for (let j = i + 1; j < q.length; j++) {
    const c = q[j]!;
    if (c === "\\" && (q[j + 1] === '"' || q[j + 1] === "\\" || q[j + 1] === "*")) {
      out += q[++j];
      continue;
    }
    if (c === '"') return { text: out, end: j + 1, wild };
    if (c === "*") wild.push(out.length);
    out += c;
  }
  throw new QueryError("unterminated quote", i, { reason: "unterminated_quote", next: ['close it with " (or escape a literal quote as \\")'] });
}

function tokenize(q: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      toks.push({ k: c, at: i });
      i++;
      continue;
    }
    if (c === "-" && i + 1 < q.length && !/[\s)]/.test(q[i + 1]!)) {
      toks.push({ k: "-", at: i });
      i++;
      continue;
    }
    if (c === '"') {
      const r = readQuoted(q, i);
      toks.push({ k: "word", at: i, text: r.text, quoted: true });
      i = r.end;
      continue;
    }
    // A word runs to whitespace or a paren; quoted parts inside it (title:"a b") are kept raw.
    const start = i;
    while (i < q.length && !/[\s()]/.test(q[i]!)) i = q[i] === '"' ? readQuoted(q, i).end : i + 1;
    const text = q.slice(start, i);
    toks.push(text === "OR" ? { k: "or", at: start } : { k: "word", at: start, text, quoted: false });
  }
  return toks;
}

// ------------------------------------------------------------ parser

const CLAUSE = /^([A-Za-z][A-Za-z0-9._-]*)(>=|<=|>|<|:)/;

export interface ParseOptions {
  /** For relative times (`since:7d`). */
  now?: number;
  /** The zone `since:2026-11-09` and `since:today` are read in, as Date#getTimezoneOffset minutes. Default: this process's zone; an HTTP caller passes the request's. */
  tzOffsetMin?: number;
}

/** One value as typed: its text, whether any of it was quoted, and where its wildcard stars are. */
interface Part {
  text: string;
  quoted: boolean;
  at: number;
  /** Indices of the wildcard `*`s in text; a star not listed is literal. Absent: every star is a wildcard. */
  wild?: number[];
}

/** Splits a raw value on commas outside quotes; each part keeps whether it was quoted. */
function splitValues(raw: string, at: number): Part[] {
  const parts: Part[] = [];
  let i = 0;
  let cur = "";
  let quoted = false;
  let wild: number[] = [];
  let partAt = at;
  while (i <= raw.length) {
    const c = raw[i];
    if (c === undefined || c === ",") {
      parts.push({ text: cur, quoted, at: partAt, wild });
      cur = "";
      quoted = false;
      wild = [];
      i++;
      partAt = at + i;
      continue;
    }
    if (c === '"') {
      const r = readQuoted(raw, i);
      for (const w of r.wild) wild.push(cur.length + w);
      cur += r.text;
      quoted = true;
      i = r.end;
      continue;
    }
    if (c === "*") wild.push(cur.length);
    cur += c;
    i++;
  }
  return parts;
}

const starsIn = (text: string): number[] => {
  const at: number[] = [];
  for (let i = text.indexOf("*"); i >= 0; i = text.indexOf("*", i + 1)) at.push(i);
  return at;
};

/** A glob value's text between its wildcards (literal stars kept). */
export function globParts(v: Value): string[] {
  return v.parts ?? v.raw.split("*");
}

function closestKey(name: string): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const k of ALL_KEYS) {
    const d = editDistance(name.toLowerCase(), k);
    if (d < bestD) (bestD = d), (best = k);
  }
  return best !== undefined && bestD <= Math.max(1, Math.min(3, Math.floor(name.length / 2))) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

function resolveValue(def: KeyDef, op: Op, part: Part, now: number, tzOffsetMin?: number): Value {
  const { quoted, at } = part;
  // Same length, so the wildcard offsets in part.wild still hold.
  const text = def.spell ? def.spell(part.text) : part.text;
  const v: Value = { raw: text, quoted, kind: "eq" };
  const bad = (why: string, next: string[] = [`e.g. ${def.example}`]) => new QueryError(`${def.name}: ${why}`, at, { reason: "bad_value", next });
  if (text === "") throw bad("needs a value");
  if (def.type === "text") {
    if (op !== ":") throw bad(`compares text with ':' only, not '${op}'`);
    if (def.choices) {
      const lower = text.toLowerCase();
      if (part.wild?.length || !def.choices.includes(lower)) {
        throw bad(`must be one of ${def.choices.join(", ")}, got ${JSON.stringify(text)}`);
      }
      v.raw = lower;
      return v;
    }
    // `*` is a wildcard, quoted or not; `\*` inside quotes is a literal star.
    const wild = part.wild ?? starsIn(text);
    if (wild.length) {
      v.kind = "glob";
      if (wild.length < text.split("*").length - 1) {
        let from = 0;
        v.parts = [];
        for (const w of wild) v.parts.push(text.slice(from, w)), (from = w + 1);
        v.parts.push(text.slice(from));
      }
    }
    return v;
  }
  if (def.type === "bool") {
    if (op !== ":") throw bad(`takes ':' only, not '${op}'`);
    const b = parseBool(text);
    if (b === undefined) throw bad(`must be true or false, got ${JSON.stringify(text)}`);
    v.n = b ? 1 : 0;
    return v;
  }
  if (def.type === "time") {
    if (op !== ":") throw bad(`takes ':' only, not '${op}'`);
    const t = parseTime(text, now, tzOffsetMin);
    if (t === undefined) throw bad(`must be a duration ago (7d, 12h, 30m), today, yesterday or a date (2026-11-01), got ${JSON.stringify(text)}`);
    v.n = t;
    return v;
  }
  const unit = def.unit ?? "count";
  const unitHint = unit === "ms" ? "needs a unit: 30s, 10m, 2h" : unit === "usd" ? "must be a USD amount like 0.5" : "must be a number (k and M suffixes work)";
  const range = !quoted && op === ":" ? /^(.*?)\.\.(.*)$/.exec(text) : null;
  if (range) {
    const lo = parseNumber(range[1]!, unit);
    const hi = parseNumber(range[2]!, unit);
    if (lo === undefined || hi === undefined) throw bad(`range ${JSON.stringify(text)}: each end ${unitHint}`);
    if (lo > hi) throw bad(`range ${JSON.stringify(text)} runs backwards`);
    return { ...v, kind: "range", lo, hi };
  }
  const n = parseNumber(text, unit);
  if (n === undefined) throw bad(`${unitHint}, got ${JSON.stringify(text)}`);
  v.n = n;
  return v;
}

/** Parses a query string. Throws QueryError with the offset and a hint when it does not parse. */
export function parseWhere(q: string, opts: ParseOptions = {}): Query {
  if (q.length > 2000) throw new QueryError("query is too long (2000 characters at most)", 2000, { reason: "too_long" });
  const now = opts.now ?? Date.now();
  const toks = tokenize(q);
  let i = 0;
  const out: Query = {};
  const peek = () => toks[i];
  const end = q.length;

  const leaf = (t: Extract<Tok, { k: "word" }>, top: boolean): Node | undefined => {
    const m = t.quoted ? null : CLAUSE.exec(t.text);
    // `quoted` records how the word prints: a word that would not read back as text is quoted.
    if (!m) return { t: "text", words: [t.text], quoted: [t.quoted || needsQuotes(t.text) || CLAUSE.test(t.text)], at: t.at };
    const name = m[1]!;
    const op = m[2] as Op;
    const rawValue = t.text.slice(m[0].length);
    const valueAt = t.at + m[0].length;
    if (name === "sort" || name === "limit") {
      if (!top) throw new QueryError(`${name}: applies to the whole query, so it can't sit inside parentheses, OR or a negation`, t.at, { reason: "bad_directive" });
      if (op !== ":") throw new QueryError(`${name}: takes ':'`, t.at, { reason: "bad_directive" });
      if (name === "limit") {
        // Decimal digits only, as --limit takes: Number() reads 1e3, 0x10 and 5.0 as whole numbers.
        const n = Number(rawValue);
        if (!/^\d+$/.test(rawValue) || !Number.isSafeInteger(n) || n < 1) throw new QueryError(`limit: must be a whole number from 1 to ${Number.MAX_SAFE_INTEGER}, got ${JSON.stringify(rawValue)}`, valueAt, { reason: "bad_value" });
        out.limit = n;
      } else {
        const desc = rawValue.startsWith("-");
        const key = desc ? rawValue.slice(1) : rawValue;
        if (!SORT_KEYS.includes(key)) throw new QueryError(`sort: can't sort by ${JSON.stringify(key)}`, valueAt, { reason: "bad_value", next: [`one of ${SORT_KEYS.join(", ")}`] });
        out.sort = { key, desc };
      }
      return undefined;
    }
    if (name === "has" || name === "is") {
      const table = name === "has" ? HAS : IS;
      if (op !== ":" || !table[rawValue]) throw new QueryError(`${name}: must be one of ${Object.keys(table).join(", ")}, got ${JSON.stringify(rawValue)}`, valueAt, { reason: "bad_value" });
      return { t: name, name: rawValue, at: t.at };
    }
    const def = KEYS.get(name);
    if (!def) {
      const near = closestKey(name);
      throw new QueryError(`unknown key ${JSON.stringify(name)}`, t.at, { reason: "unknown_key", next: near ? [`did you mean ${near}:?`] : ["quote it to search the text: \"" + t.text.replace(/"/g, '\\"') + "\"", `keys: ${ALL_KEYS.join(" ")}`] });
    }
    const parts = op === ":" ? splitValues(rawValue, valueAt) : [{ text: rawValue.startsWith('"') ? readQuoted(rawValue, 0).text : rawValue, quoted: rawValue.startsWith('"'), at: valueAt }];
    return { t: "cmp", key: def.name, op, values: parts.map((p) => resolveValue(def, op, p, now, opts.tzOffsetMin)), at: t.at };
  };

  const parseOr = (top: boolean): Node | undefined => {
    const items: Node[] = [];
    const first = parseAnd(top);
    if (first) items.push(first);
    while (peek()?.k === "or") {
      const at = peek()!.at;
      i++;
      const next = parseAnd(false);
      if (!next || !items.length) throw new QueryError("OR needs a clause on each side", at, { reason: "dangling_or" });
      items.push(next);
    }
    return items.length === 0 ? undefined : items.length === 1 ? items[0] : { t: "or", items };
  };

  const parseAnd = (top: boolean): Node | undefined => {
    const items: Node[] = [];
    for (;;) {
      const t = peek();
      if (!t || t.k === ")" || t.k === "or") break;
      const n = parseUnary(top);
      if (n) items.push(n);
    }
    if (top && peek()?.k === "or" && (out.sort || out.limit)) {
      throw new QueryError("sort: and limit: apply to the whole query; put them outside an OR", peek()!.at, { reason: "bad_directive" });
    }
    return mergeText(items);
  };

  const parseUnary = (top: boolean): Node | undefined => {
    const t = toks[i++]!;
    if (t.k === "-") {
      const nt = peek();
      if (!nt || nt.k === ")" || nt.k === "or") throw new QueryError("'-' needs a clause after it", t.at, { reason: "dangling_not" });
      const item = parseUnary(false);
      return item ? { t: "not", item } : undefined;
    }
    if (t.k === "(") {
      const inner = parseOr(false);
      const close = toks[i++];
      if (!close || close.k !== ")") throw new QueryError("missing ')'", close?.at ?? end, { reason: "unbalanced_parens", next: [`close the '(' at ${t.at}`] });
      if (!inner) throw new QueryError("empty parentheses", t.at, { reason: "empty_group" });
      return inner;
    }
    if (t.k === ")") throw new QueryError("unexpected ')'", t.at, { reason: "unbalanced_parens" });
    if (t.k === "or") throw new QueryError("OR needs a clause on each side", t.at, { reason: "dangling_or" });
    return leaf(t, top);
  };

  const root = parseOr(true);
  if (i < toks.length) {
    const t = toks[i]!;
    throw new QueryError(t.k === ")" ? "unexpected ')'" : "unexpected input", t.at, { reason: t.k === ")" ? "unbalanced_parens" : "bad_query" });
  }
  if (root) out.root = root;
  return out;
}

/** Adjacent bare words in one AND group become one text clause: every word must appear in one event. */
function mergeText(items: Node[]): Node | undefined {
  const merged: Node[] = [];
  for (const n of items) {
    const prev = merged[merged.length - 1];
    if (n.t === "text" && prev?.t === "text") merged[merged.length - 1] = { t: "text", words: [...prev.words, ...n.words], quoted: [...prev.quoted, ...n.quoted], at: prev.at };
    else merged.push(n);
  }
  return merged.length === 0 ? undefined : merged.length === 1 ? merged[0] : { t: "and", items: merged };
}

// ------------------------------------------------------------ printer

const needsQuotes = (s: string): boolean => s === "" || /[\s()",]/.test(s) || s === "OR" || s.startsWith("-");
const quote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * An unquoted value never holds a space, paren, quote or comma (they end or split it), so it
 * prints as typed. A quoted one escapes its literal stars as `\*`.
 */
function printValue(v: Value): string {
  if (!v.quoted) return v.raw;
  const esc = (s: string) => s.replace(/[\\"*]/g, (c) => `\\${c}`);
  return `"${v.kind === "glob" ? globParts(v).map(esc).join("*") : esc(v.raw)}"`;
}

function printNode(n: Node, parent?: Node["t"]): string {
  switch (n.t) {
    case "cmp":
      return `${n.key}${n.op}${n.values.map(printValue).join(",")}`;
    case "has":
    case "is":
      return `${n.t}:${n.name}`;
    case "text":
      return n.words.map((w, i) => (n.quoted[i] ? quote(w) : w)).join(" ");
    case "not":
      return `-${n.item.t === "and" || n.item.t === "or" || (n.item.t === "text" && n.item.words.length > 1) ? `(${printNode(n.item)})` : printNode(n.item, "not")}`;
    case "and": {
      const s = n.items.map((x) => printNode(x, "and")).join(" ");
      return parent === "not" ? `(${s})` : s;
    }
    case "or": {
      const s = n.items.map((x) => printNode(x, "or")).join(" OR ");
      return parent === "and" || parent === "not" ? `(${s})` : s;
    }
  }
}

/** The query in normalized form: parseWhere(printWhere(q)) equals q. */
export function printWhere(q: Query): string {
  const parts: string[] = [];
  if (q.root) parts.push(q.root.t === "or" && (q.sort || q.limit) ? `(${printNode(q.root)})` : printNode(q.root));
  if (q.sort) parts.push(`sort:${q.sort.desc ? "-" : ""}${q.sort.key}`);
  if (q.limit !== undefined) parts.push(`limit:${q.limit}`);
  return parts.join(" ");
}

// ------------------------------------------------------------ shape

/** Which level a node needs: session columns, events (EXISTS at session level), or the full-text index. */
export function levelOf(n: Node): "session" | "event" | "text" | "mixed" {
  switch (n.t) {
    case "cmp": {
      const def = KEYS.get(n.key)!;
      return def.alone ? "mixed" : def.level;
    }
    case "has":
    case "is":
      return "session";
    case "text":
      return "text";
    case "not":
      return levelOf(n.item);
    case "and":
    case "or": {
      const levels = new Set(n.items.map(levelOf));
      return levels.size === 1 ? [...levels][0]! : "mixed";
    }
  }
}

/** True when any clause needs events or the full-text index. */
export function needsEvents(n: Node | undefined): boolean {
  if (!n) return false;
  if (n.t === "and" || n.t === "or") return n.items.some(needsEvents);
  if (n.t === "not") return needsEvents(n.item);
  return n.t === "text" || (n.t === "cmp" && KEYS.get(n.key)!.level === "event");
}

/**
 * The query itself says whether subagent sessions are in: it names sessions by `id:` or
 * `parent:` (not negated), or says `is:root` / `is:child`. A list that shows top-level
 * sessions by default drops that default then, so `id:<a subagent's id>` finds it.
 */
export function scopesSubagents(n: Node | undefined, negated = false): boolean {
  if (!n) return false;
  if (n.t === "and" || n.t === "or") return n.items.some((x) => scopesSubagents(x, negated));
  if (n.t === "not") return scopesSubagents(n.item, !negated);
  if (n.t === "is") return n.name === "root" || n.name === "child";
  return n.t === "cmp" && !negated && (n.key === "id" || n.key === "parent");
}

/**
 * The query without the top-level clauses on `key` (facets count a key over
 * everything else that is selected, so picking one value never hides the others).
 */
export function withoutKey(q: Query, key: string): Query {
  const keep = (n: Node): boolean => !(n.t === "cmp" && n.key === key);
  const root = q.root;
  let next: Node | undefined;
  if (!root || !keep(root)) next = undefined;
  else if (root.t === "and") {
    const items = root.items.filter(keep);
    next = items.length === 0 ? undefined : items.length === 1 ? items[0] : { t: "and", items };
  } else next = root;
  const out: Query = { ...q };
  if (next) out.root = next;
  else delete out.root;
  return out;
}

/** And-joins two queries (the caller's clauses plus a surface's own, e.g. a CLI flag). */
export function andQuery(a: Query, b: Node | undefined): Query {
  if (!b) return a;
  if (!a.root) return { ...a, root: b };
  const items = [...(a.root.t === "and" ? a.root.items : [a.root]), ...(b.t === "and" ? b.items : [b])];
  return { ...a, root: { t: "and", items } };
}

/**
 * The since/until bounds every match must meet (the root, or a clause of the root's AND), for
 * echoing the window a query resolved to. `zoned`: one was written as a day or a clock time
 * without a zone, so the zone decided the instant.
 */
export function timeBounds(q: Query | undefined): { since?: number; until?: number; zoned: boolean } {
  const out: { since?: number; until?: number; zoned: boolean } = { zoned: false };
  const items = !q?.root ? [] : q.root.t === "and" ? q.root.items : [q.root];
  for (const n of items) {
    if (n.t !== "cmp" || (n.key !== "since" && n.key !== "until") || n.values.length !== 1) continue;
    const v = n.values[0]!;
    if (v.n === undefined) continue;
    if (n.key === "since") out.since = Math.max(out.since ?? -Infinity, v.n);
    else out.until = Math.min(out.until ?? Infinity, v.n);
    if (parseWhen(v.raw)?.zoned) out.zoned = true;
  }
  return out;
}

/** For JSON error replies: `{ reason, message, offset, next }`. */
export function queryErrorJson(e: QueryError): { reason: string; message: string; offset: number; next: string[] } {
  return { reason: e.reason, message: e.message, offset: e.offset, next: e.next };
}
