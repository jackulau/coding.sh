// Spend budgets: a USD limit per local day, ISO week or calendar month, for every
// session or for one agent or repo. Budgets live in <CODING_SH_HOME>/budgets.json.
// Spend is the sum of the sessions' costUsd that started in the period: the same
// numbers `coding.sh usage --since <period start>` totals, so it is an estimate
// wherever the agent reported no cost (tokens times list price).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import type { IndexStore, Session } from "../core/types.ts";
import { paths } from "../core/paths.ts";
import { matchesPlace, scanSessions, TOTALS_SCAN_CAP, type Place, type ScanQuery } from "../mcp/data.ts";

export const PERIODS = ["day", "week", "month"] as const;
export type Period = (typeof PERIODS)[number];

export interface Budget {
  /** Short, stable name: the period, then the agent and the repo's name (`day`, `week-codex`). */
  id: string;
  period: Period;
  limitUsd: number;
  /** Only this agent's sessions. */
  agent?: string;
  /** Only sessions in this repo: an absolute path (the root or a folder under it) or a bare repo name. */
  repo?: string;
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
  return typeof b.id === "string" && isPeriod(b.period) && typeof b.limitUsd === "number" && Number.isFinite(b.limitUsd) && b.limitUsd > 0 && (b.agent === undefined || typeof b.agent === "string") && (b.repo === undefined || typeof b.repo === "string");
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

/**
 * Adds a budget, or sets the limit of the one with the same period, agent and repo (it keeps its id).
 * Returns the budget stored and whether it replaced one.
 */
export function upsertBudget(list: readonly Budget[], b: Omit<Budget, "id" | "createdAt">, now = Date.now()): { budgets: Budget[]; budget: Budget; replaced: boolean } {
  const same = list.find((x) => x.period === b.period && x.agent === b.agent && x.repo === b.repo);
  if (same) {
    const budget = { ...same, limitUsd: b.limitUsd };
    return { budgets: list.map((x) => (x === same ? budget : x)), budget, replaced: true };
  }
  const base = [b.period, b.agent ? slug(b.agent) : "", b.repo ? slug(basename(b.repo)) : ""].filter(Boolean).join("-");
  let id = base;
  for (let n = 2; list.some((x) => x.id === id); n++) id = `${base}-${n}`;
  const budget: Budget = { id, period: b.period, limitUsd: b.limitUsd, createdAt: now };
  if (b.agent) budget.agent = b.agent;
  if (b.repo) budget.repo = b.repo;
  return { budgets: [...list, budget], budget, replaced: false };
}

/** A stored repo as a place: an absolute path matches at or under it, anything else is a repo name. */
export function repoPlace(repo: string): Place {
  return isAbsolute(repo) ? { path: repo } : { name: repo };
}

/** Whether a session counts toward a budget (its period aside). */
export function sessionInScope(s: Session, b: Budget): boolean {
  if (b.agent && s.agent !== b.agent) return false;
  if (b.repo && !matchesPlace(s, repoPlace(b.repo))) return false;
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
  let spendUsd = 0;
  let n = 0;
  for (const s of sessions) {
    if (s.startedAt < since || !sessionInScope(s, b)) continue;
    n++;
    const c = s.stats.usage?.costUsd;
    if (typeof c === "number" && Number.isFinite(c)) spendUsd += c;
  }
  return { spendUsd, sessions: n };
}

/** One budget's spend in its current period, read from the store (subagents' sessions count, as in usage). */
export async function budgetStatus(index: IndexStore, b: Budget, now = Date.now()): Promise<BudgetStatus> {
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

/** Every budget's status, in the order they were set. */
export async function budgetStatuses(index: IndexStore, budgets: readonly Budget[], now = Date.now()): Promise<BudgetStatus[]> {
  const out: BudgetStatus[] = [];
  for (const b of budgets) out.push(await budgetStatus(index, b, now));
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
 * Statuses for the status line, which runs on every turn. Day budgets are summed from
 * `today` (every session that started today, subagents too); week and month budgets reuse
 * a total from budget-spend.json no older than 60 s, or read the store and write it back.
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
