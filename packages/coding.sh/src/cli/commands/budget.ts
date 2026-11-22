// coding.sh budget set <day|week|month> <usd> [--agent a] [--repo r] [--where q] | list | rm <id> | status
//
// Spend budgets over the sessions coding.sh captured. Spend is the estimated cost of
// the sessions that started in the current period (local day, ISO week from Monday,
// calendar month), as `coding.sh usage` totals it. The status line shows the highest
// budget once it passes 80%; `coding.sh proxy --enforce-budget` stops calls over one.
import { budgetStatuses, ESTIMATED_NOTE, isPeriod, PERIODS, readBudgets, repoPlace, statusJson, upsertBudget, writeBudgets, type Budget, type BudgetStatus } from "../../budget/index.ts";
import { userHome } from "../../core/paths.ts";
import { parsePlace } from "../../mcp/data.ts";
import { suggest, UsageError } from "../args.ts";
import { autoIngest, pendingField, readIngest, str, whereFlag, withContext } from "../common.ts";
import { CliError, usd } from "../output.ts";
import type { CommandContext } from "../types.ts";

export async function run(c: CommandContext): Promise<number> {
  if (c.action === "set") return set(c);
  if (c.action === "rm") return rm(c);
  if (c.action === "status") return status(c);
  return list(c);
}

function load(c: CommandContext): Budget[] {
  try {
    return readBudgets(c.env);
  } catch (e) {
    throw new CliError(`Can't read the budgets: ${(e as Error).message}`, { reason: "bad_budgets" });
  }
}

const scopeText = (b: Budget): string => [b.agent ? `agent ${b.agent}` : "", b.repo ? `repo ${b.repo}` : "", b.where ? `where ${b.where}` : ""].filter(Boolean).join(", ") || "every session";

/** `5h 20m`, `2d 4h`, `12m`: how long until `at`. */
export function until(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.ceil((at - now) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function set(c: CommandContext): number {
  const { out } = c;
  const [period, raw] = c.positionals;
  if (!isPeriod(period)) {
    const near = period ? suggest(period, PERIODS) : undefined;
    const scope = (["agent", "repo", "where"] as const).flatMap((f) => (str(c.flags[f]) ? [`--${f} ${f === "where" ? JSON.stringify(str(c.flags[f])) : str(c.flags[f])}`] : []));
    throw new UsageError(`The period must be one of ${PERIODS.join(", ")}, got ${JSON.stringify(period ?? "")}`, {
      reason: "invalid_argument",
      suggestion: near ? ["coding.sh budget set", near, raw ?? "<USD>", ...scope].join(" ") : undefined,
    });
  }
  const amount = /^\$?(\d+(?:\.\d+)?)$/.exec((raw ?? "").trim());
  const usdLimit = amount ? Number(amount[1]) : Number.NaN;
  if (!(usdLimit > 0)) throw new UsageError(`The limit must be a USD amount above 0, like 25 or 2.50, got ${JSON.stringify(raw ?? "")}`, { reason: "invalid_argument" });
  const agent = str(c.flags.agent);
  const repoFlag = str(c.flags.repo);
  // A path is stored absolute, so the budget means the same folder from anywhere; a bare word is a repo name.
  const place = repoFlag !== undefined ? parsePlace(repoFlag, c.cwd, userHome(c.env)) : undefined;
  const repo = place ? (place.path ?? place.name) : undefined;
  if (repoFlag !== undefined && !repo) throw new UsageError("--repo needs a path or a repo name", { reason: "invalid_argument" });
  whereFlag(c); // a bad query fails now (exit 2), not at the first status
  const where = str(c.flags.where)?.trim();
  const r = upsertBudget(load(c), { period, limitUsd: usdLimit, agent: agent || undefined, repo: repo || undefined, where: where || undefined });
  writeBudgets(r.budgets, c.env);
  if (out.json) {
    out.data({ outcome: r.replaced ? "updated" : "added", budget: r.budget });
    return 0;
  }
  out.ok(`${r.replaced ? "Updated" : "Added"} budget ${r.budget.id}: ${usd(r.budget.limitUsd)} per ${period}, ${scopeText(r.budget)}`);
  out.next("See the spend against it", "coding.sh budget status");
  return 0;
}

function list(c: CommandContext): number {
  const { out } = c;
  const budgets = load(c);
  if (out.json) {
    out.data({ budgets });
    return 0;
  }
  if (!budgets.length) {
    out.note("No budgets set");
    out.next("Set one", "coding.sh budget set day 20");
    return 0;
  }
  out.table(
    ["ID", "PERIOD", "LIMIT", "AGENT", "REPO", "WHERE"],
    budgets.map((b) => [b.id, b.period, usd(b.limitUsd), b.agent ?? "-", b.repo ?? "-", b.where ?? "-"]),
  );
  return 0;
}

function rm(c: CommandContext): number {
  const { out } = c;
  const id = c.positionals[0];
  const budgets = load(c);
  const gone = budgets.find((b) => b.id === id);
  if (!gone) {
    throw new CliError(`No budget ${JSON.stringify(id ?? "")}`, { reason: "not_found", next: budgets.length ? ["See the budgets:", "coding.sh budget list"] : [] });
  }
  writeBudgets(budgets.filter((b) => b !== gone), c.env);
  if (out.json) out.data({ outcome: "removed", budget: gone });
  else out.ok(`Removed budget ${gone.id}`);
  return 0;
}

async function status(c: CommandContext): Promise<number> {
  const { out } = c;
  const budgets = load(c);
  if (!budgets.length) {
    if (out.json) out.data({ budgets: [], estimated: true, note: ESTIMATED_NOTE });
    else {
      out.note("No budgets set");
      out.next("Set one", "coding.sh budget set day 20");
    }
    return 0;
  }
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));
    const now = Date.now();
    const statuses: BudgetStatus[] = await budgetStatuses(ctx.index, budgets, now);
    if (out.json) {
      out.data({ budgets: statuses.map(statusJson), estimated: true, note: ESTIMATED_NOTE, ...pendingField(backlog) });
      return 0;
    }
    out.table(
      ["ID", "PERIOD", "SCOPE", "SPEND", "LIMIT", "USED", "RESETS IN"],
      statuses.map((s) => [s.over ? `! ${s.budget.id}` : s.budget.id, s.budget.period, scopeText(s.budget), `~${usd(s.spendUsd)}`, usd(s.budget.limitUsd), `${Math.floor(s.percent)}%`, until(s.resetsAt, now)]),
    );
    out.note(ESTIMATED_NOTE);
    const over = statuses.filter((s) => s.over);
    if (over.length) out.warn(`${over.length === 1 ? `Budget ${over[0]!.budget.id} is` : `${over.length} budgets are`} over the limit (! above)`);
    if (statuses.some((s) => s.truncated)) out.warn("Stopped after 100,000 sessions: the spend of a budget marked truncated in --json is a lower bound");
    // A repo the store has no session in is likely a typo; say so rather than show $0 quietly.
    for (const s of statuses) if (s.budget.repo && s.sessions === 0 && !repoPlace(s.budget.repo).path) out.note(`No session this ${s.budget.period} in a repo named ${s.budget.repo}`);
    return 0;
  }, { create: false });
}
