// Spend budgets: a USD limit per local day, ISO week or calendar month, for every
// session, for one agent or repo, or for the sessions a --where query matches.
// Budgets live in <CODING_SH_HOME>/budgets.json.
// Spend is the sum of the sessions' costUsd that started in the period: the same
// numbers `coding.sh usage --since <period start>` totals, so it is an estimate
// wherever the agent reported no cost (tokens times list price).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import type { IndexStore, Session } from "../core/types.ts";
import { paths } from "../core/paths.ts";
import { matchesPlace, pathKey, pathPlace, scanSessions, TOTALS_SCAN_CAP, type Place, type ScanQuery } from "../mcp/data.ts";
import { matchesSession } from "../query/match.ts";
import { needsEvents, parseWhere, type Node } from "../query/where.ts";

export const PERIODS = ["day", "week", "month"] as const;
export type Period = (typeof PERIODS)[number];

export interface Budget {
  /** Short, stable name: the period, then the agent and the repo's name (`day`, `week-codex`). */
  id: string;
  period: Period;
  limitUsd: number;
  /** Only this agent's sessions. */
  agent?: string;
  /**
   * Only sessions in this repo: an absolute path (the root or a folder under it) or a bare repo
   * name, matched as `sessions --repo` matches it (repoPlace).
   */
  repo?: string;
  /**
   * Only the sessions this --where query matches (`user:u1`, `model:claude-opus-*`), as typed;
   * each one's subagents count with it.
   */
  where?: string;
  /** Epoch ms. */
  createdAt: number;
}

export interface BudgetStatus {
  budget: Budget;
  /** Epoch ms the period started (local time). */
  since: number;
  /** Epoch ms the period ends and the spend starts again from 0. */
  resetsAt: number;
  spendUsd: number;
  /** spendUsd / limitUsd × 100. */
  percent: number;
  /** The spend reached or passed the limit. */
  over: boolean;
  /** Sessions counted. */
  sessions: number;
  /** The scan stopped at TOTALS_SCAN_CAP sessions: the spend is a lower bound. */
  truncated?: boolean;
  /**
   * Why the spend could not be read (a stored --where query that no longer parses, say).
   * Such a status counts nothing: spendUsd, percent and sessions are 0, and over is false.
   */
  error?: string;
}

export const isPeriod = (v: unknown): v is Period => typeof v === "string" && (PERIODS as readonly string[]).includes(v);

/** Local midnight that starts the period holding `now`: the day, the week from Monday, or the 1st of the month. */
export function periodStart(period: Period, now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (period === "month") d.setDate(1);
  return d.getTime();
}

/** Local midnight that starts the next period: when the spend counts from 0 again. */
export function periodEnd(period: Period, now = Date.now()): number {
  const d = new Date(periodStart(period, now));
  if (period === "day") d.setDate(d.getDate() + 1);
  else if (period === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

function validBudget(v: unknown): v is Budget {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return typeof b.id === "string" && isPeriod(b.period) && typeof b.limitUsd === "number" && Number.isFinite(b.limitUsd) && b.limitUsd > 0 && (b.agent === undefined || typeof b.agent === "string") && (b.repo === undefined || typeof b.repo === "string") && (b.where === undefined || typeof b.where === "string");
}

/** The budgets in budgets.json; none when the file is missing. A file that is not a budget list throws. */
export function readBudgets(env: NodeJS.ProcessEnv = process.env): Budget[] {
  const file = paths(env).budgets;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const doc = JSON.parse(text) as unknown;
  const list = doc && typeof doc === "object" ? (doc as { budgets?: unknown }).budgets : undefined;
  if (!Array.isArray(list)) throw new Error(`${file} has no "budgets" list`);
  return list.filter(validBudget);
}

/** Writes `text` beside `file`, then renames it over: a reader never sees half a file. */
export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function writeBudgets(budgets: readonly Budget[], env: NodeJS.ProcessEnv = process.env): void {
  writeFileAtomic(paths(env).budgets, JSON.stringify({ budgets }, null, 2) + "\n");
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** The id part of a --where budget: `w` and the first 6 hex of the query's SHA-256. */
export const whereSlug = (where: string): string => `w${createHash("sha256").update(where).digest("hex").slice(0, 6)}`;

/**
 * Adds a budget, or sets the limit of the one with the same period, agent, repo and where (it keeps its id).
 * Repos compare as sessions match them (pathKey): on Windows, C:\Web and c:\web are one folder.
 * Returns the budget stored and whether it replaced one.
 */
export function upsertBudget(list: readonly Budget[], b: Omit<Budget, "id" | "createdAt">, now = Date.now(), platform: string = process.platform): { budgets: Budget[]; budget: Budget; replaced: boolean } {
  const sameRepo = (r: string | undefined) => r === b.repo || (r !== undefined && b.repo !== undefined && pathKey(r, platform) === pathKey(b.repo, platform));
  const same = list.find((x) => x.period === b.period && x.agent === b.agent && sameRepo(x.repo) && x.where === b.where);
  if (same) {
    const budget = { ...same, limitUsd: b.limitUsd };
    return { budgets: list.map((x) => (x === same ? budget : x)), budget, replaced: true };
  }
  const { basename } = platform === "win32" ? win32 : posix;
  const base = [b.period, b.agent ? slug(b.agent) : "", b.repo ? slug(basename(b.repo)) : "", b.where ? whereSlug(b.where) : ""].filter(Boolean).join("-");
  let id = base;
  for (let n = 2; list.some((x) => x.id === id); n++) id = `${base}-${n}`;
  const budget: Budget = { id, period: b.period, limitUsd: b.limitUsd, createdAt: now };
  if (b.agent) budget.agent = b.agent;
  if (b.repo) budget.repo = b.repo;
  if (b.where) budget.where = b.where;
  return { budgets: [...list, budget], budget, replaced: false };
}

/**
 * A stored repo as a place, read as `sessions --repo` reads it: anything but an absolute path is
 * a repo name; a path matches at or under it, and a checkout's root or a folder inside a linked
 * worktree takes in every worktree of its repo. The path stays as stored. Finding its repo reads
 * the .git files there, so a budget resolves its place once per read, not once per session.
 */
export function repoPlace(repo: string): Place {
  if (!isAbsolute(repo)) return { name: repo };
  const main = pathPlace(repo).repo;
  return main ? { path: repo, repo: main } : { path: repo };
}

/** The budget's repo as a place (repoPlace), or undefined when it counts every repo. */
const placeOf = (b: Budget): Place | undefined => (b.repo ? repoPlace(b.repo) : undefined);

/** Whether a session counts toward a budget (its period aside); `place` is the budget's placeOf. */
export function sessionInScope(s: Session, b: Budget, place: Place | undefined): boolean {
  if (b.agent && s.agent !== b.agent) return false;
  if (place && !matchesPlace(s, place)) return false;
  return true;
}

/** The finished status of a budget from its spend. */
export function statusOf(b: Budget, spendUsd: number, sessions: number, now = Date.now(), truncated = false): BudgetStatus {
  const spend = Math.round(spendUsd * 10_000) / 10_000;
  const status: BudgetStatus = {
    budget: b,
    since: periodStart(b.period, now),
    resetsAt: periodEnd(b.period, now),
    spendUsd: spend,
    percent: Math.round((spend / b.limitUsd) * 1000) / 10,
    over: spend >= b.limitUsd,
    sessions,
  };
  if (truncated) status.truncated = true;
  return status;
}

/** Sums costUsd over sessions already read (each counted once per budget it falls in). */
export function spendOf(sessions: readonly Session[], b: Budget, now = Date.now()): { spendUsd: number; sessions: number } {
  const since = periodStart(b.period, now);
  const place = placeOf(b);
  let spendUsd = 0;
  let n = 0;
  for (const s of sessions) {
    if (s.startedAt < since || !sessionInScope(s, b, place)) continue;
    n++;
    const c = s.stats.usage?.costUsd;
    if (typeof c === "number" && Number.isFinite(c)) spendUsd += c;
  }
  return { spendUsd, sessions: n };
}

/** A session as a --where budget's spend needs it. */
export interface SpendRow {
  id: string;
  parent?: string;
  costUsd: number;
}

const spendRow = (s: Session): SpendRow => {
  const c = s.stats.usage?.costUsd;
  const r: SpendRow = { id: s.id, costUsd: typeof c === "number" && Number.isFinite(c) ? c : 0 };
  if (s.parent?.sessionId) r.parent = s.parent.sessionId;
  return r;
};

/**
 * A --where budget's spend over the period's sessions: each session the query matches, plus
 * the subagents under it (its parent chain reaches a match among these rows). `sessions`
 * counts the matches with no match above them, as stats counts top-level sessions.
 */
export function rolledSpend(rows: readonly SpendRow[], matched: (id: string) => boolean): { spendUsd: number; sessions: number } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const memo = new Map<string, boolean>();
  const counts = (r: SpendRow): boolean => {
    const known = memo.get(r.id);
    if (known !== undefined) return known;
    memo.set(r.id, false); // a loop of parents ends here
    const parent = r.parent !== undefined ? byId.get(r.parent) : undefined;
    const yes = matched(r.id) || (parent !== undefined && counts(parent));
    memo.set(r.id, yes);
    return yes;
  };
  /** A match above r in its parent chain (a loop of parents stops at r). */
  const matchAbove = (r: SpendRow): boolean => {
    const seen = new Set([r.id]);
    for (let p = r.parent !== undefined ? byId.get(r.parent) : undefined; p && !seen.has(p.id); p = p.parent !== undefined ? byId.get(p.parent) : undefined) {
      if (matched(p.id)) return true;
      seen.add(p.id);
    }
    return false;
  };
  let spendUsd = 0;
  let sessions = 0;
  for (const r of rows) {
    if (!counts(r)) continue;
    spendUsd += r.costUsd;
    if (matched(r.id) && !matchAbove(r)) sessions++;
  }
  return { spendUsd, sessions };
}

/** The budget's --where query; undefined without one. Throws on a query that no longer parses. */
export function whereRoot(b: Budget): Node | undefined {
  if (!b.where) return undefined;
  try {
    return parseWhere(b.where).root ?? { t: "and", items: [] };
  } catch (e) {
    throw new Error(`--where does not parse (${(e as Error).message})`);
  }
}

/** A --where budget's status: the period's sessions, those in scope that match, and their subagents. */
async function whereStatus(index: IndexStore, b: Budget, root: Node, now: number): Promise<BudgetStatus> {
  const since = periodStart(b.period, now);
  const place = placeOf(b);
  const rows: SpendRow[] = [];
  const hits = new Set<string>();
  // Session keys are answered on the rows the scan reads; event keys and text ask the store's query path.
  const inMemory = !needsEvents(root);
  const all = scanSessions(index, { since, topLevel: false }, TOTALS_SCAN_CAP);
  let truncated = false;
  for (;;) {
    const next = await all.next();
    if (next.done) {
      truncated = next.value.truncated;
      break;
    }
    const s = next.value;
    rows.push(spendRow(s));
    if (inMemory && sessionInScope(s, b, place) && matchesSession(root, s, () => [])) hits.add(s.id);
  }
  if (!inMemory) {
    const q: ScanQuery = { since, topLevel: false, query: { root } };
    if (b.agent) q.agent = b.agent;
    if (place) q.place = place;
    const found = scanSessions(index, q, TOTALS_SCAN_CAP);
    for (;;) {
      const next = await found.next();
      if (next.done) {
        if (next.value.truncated) truncated = true;
        break;
      }
      hits.add(next.value.id);
    }
  }
  const r = rolledSpend(rows, (id) => hits.has(id));
  return statusOf(b, r.spendUsd, r.sessions, now, truncated);
}

/** One budget's spend in its current period, read from the store (subagents' sessions count, as in usage). */
export async function budgetStatus(index: IndexStore, b: Budget, now = Date.now()): Promise<BudgetStatus> {
  const root = whereRoot(b);
  if (root) return whereStatus(index, b, root, now);
  const since = periodStart(b.period, now);
  const q: ScanQuery = { since, topLevel: false };
  if (b.agent) q.agent = b.agent;
  if (b.repo) q.place = repoPlace(b.repo);
  const it = scanSessions(index, q, TOTALS_SCAN_CAP);
  let spendUsd = 0;
  let sessions = 0;
  for (;;) {
    const next = await it.next();
    if (next.done) return statusOf(b, spendUsd, sessions, now, next.value.truncated);
    sessions++;
    const c = next.value.stats.usage?.costUsd;
    if (typeof c === "number" && Number.isFinite(c)) spendUsd += c;
  }
}

/**
 * Every budget's status, in the order they were set. A budget whose spend can't be read
 * (a stored --where query that no longer parses, say) gets a status with an error, and
 * the others still report.
 */
export async function budgetStatuses(index: IndexStore, budgets: readonly Budget[], now = Date.now()): Promise<BudgetStatus[]> {
  const out: BudgetStatus[] = [];
  for (const b of budgets) {
    try {
      out.push(await budgetStatus(index, b, now));
    } catch (e) {
      out.push({ ...statusOf(b, 0, 0, now), error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** The status with the highest percent, if any. */
export function highest(statuses: readonly BudgetStatus[]): BudgetStatus | undefined {
  let top: BudgetStatus | undefined;
  for (const s of statuses) if (!top || s.percent > top.percent) top = s;
  return top;
}

/** The status line shows the highest budget once it passes this percent. */
export const STATUSLINE_BUDGET_PERCENT = 80;
/** How old a week or month total the status line may reuse. */
export const STATUSLINE_CACHE_MS = 60_000;

/** `budget 82%`, or undefined while every budget is at or under 80%. */
export function budgetPart(statuses: readonly BudgetStatus[]): string | undefined {
  const top = highest(statuses);
  return top && top.percent > STATUSLINE_BUDGET_PERCENT ? `budget ${Math.floor(top.percent)}%` : undefined;
}

interface CacheEntry {
  at: number;
  since: number;
  spendUsd: number;
  sessions: number;
}

const cacheKey = (b: Budget): string => JSON.stringify([b.id, b.period, b.agent ?? null, b.repo ?? null]);

/**
 * A --where day budget's status from `today` alone, when its query names session keys only;
 * undefined for any other --where budget (week or month, an event key such as user:, or a
 * query that no longer parses), which the status line leaves out rather than read the store.
 */
export function statuslineWhereStatus(b: Budget, today: readonly Session[], now = Date.now()): BudgetStatus | undefined {
  let root: Node | undefined;
  try {
    root = whereRoot(b);
  } catch {
    return undefined;
  }
  if (!root || b.period !== "day" || needsEvents(root)) return undefined;
  const since = periodStart(b.period, now);
  const inPeriod = today.filter((s) => s.startedAt >= since);
  const place = placeOf(b);
  const hits = new Set(inPeriod.filter((s) => sessionInScope(s, b, place) && matchesSession(root, s, () => [])).map((s) => s.id));
  const r = rolledSpend(inPeriod.map(spendRow), (id) => hits.has(id));
  return statusOf(b, r.spendUsd, r.sessions, now);
}

/**
 * Statuses for the status line, which runs on every turn. Day budgets are summed from
 * `today` (every session that started today, subagents too); week and month budgets reuse
 * a total from budget-spend.json no older than 60 s, or read the store and write it back.
 * A --where budget counts only as a day budget whose query has session keys only, matched
 * on `today` in memory (statuslineWhereStatus); every other --where budget is left out.
 */
export async function statuslineStatuses(index: IndexStore, budgets: readonly Budget[], today: readonly Session[], env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<BudgetStatus[]> {
  const file = paths(env).budgetSpend;
  let cache: Record<string, CacheEntry> = {};
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (doc && typeof doc === "object" && !Array.isArray(doc)) cache = doc as Record<string, CacheEntry>;
  } catch {
    // no cache yet, or a broken one: read the store
  }
  let wrote = false;
  const out: BudgetStatus[] = [];
  for (const b of budgets) {
    if (b.where) {
      const st = statuslineWhereStatus(b, today, now);
      if (st) out.push(st);
      continue;
    }
    if (b.period === "day") {
      const s = spendOf(today, b, now);
      out.push(statusOf(b, s.spendUsd, s.sessions, now));
      continue;
    }
    const key = cacheKey(b);
    const hit = cache[key];
    const since = periodStart(b.period, now);
    if (hit && typeof hit.spendUsd === "number" && hit.since === since && now - hit.at >= 0 && now - hit.at <= STATUSLINE_CACHE_MS) {
      out.push(statusOf(b, hit.spendUsd, hit.sessions ?? 0, now));
      continue;
    }
    const st = await budgetStatus(index, b, now);
    cache[key] = { at: now, since, spendUsd: st.spendUsd, sessions: st.sessions };
    wrote = true;
    out.push(st);
  }
  if (wrote) {
    try {
      const keep = new Set(budgets.map(cacheKey));
      writeFileAtomic(file, JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([k]) => keep.has(k)))));
    } catch {
      // a cache that can't be written is read from the store next time
    }
  }
  return out;
}

/** A status as JSON for `budget status --json`. */
export function statusJson(s: BudgetStatus): Record<string, unknown> {
  const b = s.budget;
  const out: Record<string, unknown> = { id: b.id, period: b.period };
  if (b.agent) out.agent = b.agent;
  if (b.repo) out.repo = b.repo;
  if (b.where) out.where = b.where;
  if (s.error !== undefined) {
    // A spend that could not be read has no numbers, only the reason.
    Object.assign(out, { limitUsd: b.limitUsd, since: new Date(s.since).toISOString(), resetsAt: new Date(s.resetsAt).toISOString(), error: s.error });
    return out;
  }
  Object.assign(out, {
    limitUsd: b.limitUsd,
    spendUsd: s.spendUsd,
    percent: s.percent,
    over: s.over,
    since: new Date(s.since).toISOString(),
    resetsAt: new Date(s.resetsAt).toISOString(),
    sessions: s.sessions,
  });
  if (s.truncated) out.truncated = true;
  return out;
}

/** What every budget output says about the numbers. */
export const ESTIMATED_NOTE = "Spend is estimated: the cost of the sessions coding.sh captured that started in the period, as coding.sh usage totals it (reported cost where the agent gave one, else tokens × list price).";

/**
 * The status line's budget part: the highest budget once it passes 80%, else undefined.
 * Reads nothing beyond budgets.json when no budget is set. Day budgets sum every session
 * that started since `dayStart` (one listing); week and month budgets use the 60 s cache.
 */
export async function statuslineBudget(index: IndexStore, env: NodeJS.ProcessEnv, dayStart: number, now = Date.now()): Promise<{ part: string; status: BudgetStatus } | undefined> {
  const budgets = readBudgets(env);
  if (!budgets.length) return undefined;
  const today = budgets.some((b) => b.period === "day") ? await index.listSessions({ since: dayStart }) : [];
  const statuses = await statuslineStatuses(index, budgets, today, env, now);
  const part = budgetPart(statuses);
  return part ? { part, status: highest(statuses)! } : undefined;
}
