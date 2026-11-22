// `coding.sh proxy --enforce-budget`: a model call that a spend budget over its
// limit applies to is answered 429 before anything goes upstream. Spend is read
// from the store at most every 30 s (and again once a period has reset).
//
// The proxy knows a call's agent from its headers (Claude Code, Codex, else
// "proxy", as linkCall records it) but not its repo or the session a --where
// query would match, so a budget with a repo or a where never blocks a call;
// budgets for every session or for an agent do, and only their spend is read.
import type { IncomingHttpHeaders } from "node:http";
import type { Budget, BudgetStatus } from "../budget/index.ts";
import { detectClient } from "./link.ts";
import type { Route } from "./wire.ts";

/** How long the proxy reuses the spend it read. */
export const BUDGET_REFRESH_MS = 30_000;

export interface BudgetBlock {
  status: BudgetStatus;
  /** Whole seconds until the period resets (Retry-After). */
  retryAfter: number;
}

export interface BudgetGuard {
  /** The budget over its limit that applies to this call, if any. */
  check(route: Route, headers: IncomingHttpHeaders): Promise<BudgetBlock | undefined>;
}

/** The agent a call is recorded under: Claude Code and Codex by their headers, every other client "proxy". */
export function callAgent(headers: IncomingHttpHeaders): string {
  const id = detectClient(headers).id;
  return id === "claude-code" || id === "codex" ? id : "proxy";
}

/** A budget the proxy can match a call to: one for every session or for one agent, not one with a repo or a where. */
export const enforceable = (b: Budget): boolean => !b.repo && !b.where;

/** Only calls that bill tokens are blocked; count_tokens and other paths go through. */
export const billed = (route: Route): boolean => route.api === "messages" || route.api === "chat" || route.api === "responses";

export function budgetGuard(o: {
  /** The status now of each budget the proxy enforces (budgets.json read again each time, so a change applies within 30 s). */
  load: (now: number) => Promise<BudgetStatus[]>;
  /**
   * Why a read stops nothing: a budget whose spend could not be read (its status has an
   * error), or a read that failed as a whole. Called once a read, not once a call.
   */
  onError?: (err: Error) => void;
  refreshMs?: number;
  now?: () => number;
}): BudgetGuard {
  const refreshMs = o.refreshMs ?? BUDGET_REFRESH_MS;
  const now = o.now ?? Date.now;
  let statuses: BudgetStatus[] = [];
  let readAt = -Infinity;
  let reading: Promise<void> | undefined;
  const fresh = (t: number) => t - readAt < refreshMs && !statuses.some((s) => s.resetsAt <= t);
  const report = (message: string) => {
    try {
      o.onError?.(new Error(message));
    } catch {
      // a failing listener never changes the answer
    }
  };
  const refresh = (t: number): Promise<void> =>
    // The executor turns a load that throws before it returns a promise into a failed read.
    (reading ??= new Promise<BudgetStatus[]>((resolve) => resolve(o.load(t)))
      .then(
        (s) => {
          statuses = s;
          readAt = t;
          for (const x of s) if (x.error !== undefined) report(`budget ${x.budget.id} can't be read, so it stops no call: ${x.error}`);
        },
        (err: unknown) => {
          // Budgets that can't be read stop no call, and are read again 30 s on: the calls
          // in between neither wait for the read nor report it again.
          statuses = [];
          readAt = t;
          report(`budgets can't be read, so none stops a call for ${Math.round(refreshMs / 1000)} s: ${err instanceof Error ? err.message : String(err)}`);
        },
      )
      .finally(() => {
        reading = undefined;
      }));
  return {
    async check(route, headers) {
      if (!billed(route)) return undefined;
      const t = now();
      if (!fresh(t)) await refresh(t);
      const agent = callAgent(headers);
      let worst: BudgetStatus | undefined;
      for (const s of statuses) {
        const b = s.budget;
        if (!s.over || s.resetsAt <= t || !enforceable(b) || (b.agent && b.agent !== agent)) continue;
        // Of several budgets over their limit, name the one that resets last: the call waits for it.
        if (!worst || s.resetsAt > worst.resetsAt) worst = s;
      }
      return worst ? { status: worst, retryAfter: Math.max(1, Math.ceil((worst.resetsAt - t) / 1000)) } : undefined;
    },
  };
}

/** The 429 the client gets: its vendor's error shape, naming the budget, its limit and its reset. */
export function budgetResponse(route: Route, block: BudgetBlock): { status: 429; headers: Record<string, string>; body: string } {
  const s = block.status;
  const b = s.budget;
  const scope = b.agent ? ` for ${b.agent}` : "";
  const resets = new Date(s.resetsAt).toISOString();
  const message = `coding.sh budget "${b.id}" (${b.period}${scope}) is over its limit: $${s.spendUsd.toFixed(2)} spent of $${b.limitUsd.toFixed(2)} (estimated). It resets at ${resets}. See coding.sh budget status.`;
  // JSON.stringify leaves out an agent that is undefined.
  const budget = { id: b.id, period: b.period, agent: b.agent || undefined, limitUsd: b.limitUsd, spendUsd: s.spendUsd, resetsAt: resets };
  const body =
    route.provider === "anthropic"
      ? { type: "error", error: { type: "rate_limit_error", message, budget } }
      : { error: { message, type: "insufficient_quota", param: null, code: "spend_limit_exceeded", budget } };
  return { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(block.retryAfter) }, body: JSON.stringify(body) };
}
