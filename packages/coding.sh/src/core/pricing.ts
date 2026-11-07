// Model prices and cost estimates. Prices are USD per 1M tokens. `estimateCost`
// is exact-match (toolevals passes its own `[prices]` table); `lookupPrice`
// adds the fuzzy lookup serve uses (provider prefix, dated variants) over the
// built-in table merged with `[pricing."<model>"]` from config.
import type { AgentEvent, Usage } from "../schema/index.ts";

export interface Price {
  input: number;
  output: number;
  /** Defaults to `input` when unset. */
  cacheRead?: number;
  /** Defaults to `input` when unset. */
  cacheWrite?: number;
}

/** Prices in USD per million tokens, keyed by model id. */
export type Prices = Record<string, Price>;

/** USD from token counts and per-million prices; undefined when the model has no exact price entry. */
export function estimateCost(u: Usage, model: string | undefined, prices: Prices | undefined): number | undefined {
  if (!model || !prices) return undefined;
  const p = prices[model];
  return p ? costFrom(u, p) : undefined;
}

/** USD for one usage record at one price. `inputTokens` counts uncached input. */
export function costFrom(u: Usage, p: Price): number {
  return ((u.inputTokens ?? 0) * p.input + (u.outputTokens ?? 0) * p.output + (u.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input) + (u.cacheWriteTokens ?? 0) * (p.cacheWrite ?? p.input)) / 1e6;
}

/** Where each provider's numbers come from and when they were last checked. */
export const PRICE_SOURCES: Record<"openai" | "anthropic" | "google", { url: string; updated: string }> = {
  openai: { url: "https://developers.openai.com/api/docs/pricing", updated: "2026-11-06" },
  anthropic: { url: "https://platform.claude.com/docs/en/about-claude/pricing", updated: "2026-11-06" },
  google: { url: "https://ai.google.dev/gemini-api/docs/pricing", updated: "2026-06-01" },
};

// Anthropic: cache write = 5-minute TTL (1.25x input); cache read 0.1x input
// unless the model's page says otherwise.
const anthropic = (input: number, output: number, cacheRead = input / 10): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 });
// OpenAI and Google bill no separate cache write: writes cost plain input.
const plain = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: input });

/** Built-in list prices (standard tier, short context). `[pricing."<model>"]` overrides any entry. */
export const BUILTIN_PRICES: Prices = {
  // OpenAI (PRICE_SOURCES.openai, Standard tier). GPT-5.5 and 5.4 bill more
  // past 272K prompt tokens; these are the short-context prices.
  "gpt-5.5": plain(5, 30, 0.5),
  "gpt-5.4": plain(2.5, 15, 0.25),
  "gpt-5.4-mini": plain(0.75, 4.5, 0.075),
  "gpt-5.4-nano": plain(0.2, 1.25, 0.02),
  "gpt-5.3-codex": plain(1.75, 14, 0.175),
  "gpt-5.2": plain(1.75, 14, 0.175),
  "gpt-5.1": plain(1.25, 10, 0.125),
  // Earlier Codex models, no longer on the page: they launched at their base model's price.
  "gpt-5.2-codex": plain(1.75, 14, 0.175),
  "gpt-5.1-codex-max": plain(1.25, 10, 0.125),
  "gpt-5.1-codex": plain(1.25, 10, 0.125),
  "gpt-5.1-codex-mini": plain(0.25, 2, 0.025),
  "gpt-5-codex": plain(1.25, 10, 0.125),
  "gpt-5": plain(1.25, 10, 0.125),
  "gpt-5-mini": plain(0.25, 2, 0.025),
  "gpt-5-nano": plain(0.05, 0.4, 0.005),
  "gpt-4.1": plain(2, 8, 0.5),
  "gpt-4.1-mini": plain(0.4, 1.6, 0.1),
  "gpt-4.1-nano": plain(0.1, 0.4, 0.025),
  "gpt-4o": plain(2.5, 10, 1.25),
  "gpt-4o-mini": plain(0.15, 0.6, 0.075),
  o3: plain(2, 8, 0.5),
  "o4-mini": plain(1.1, 4.4, 0.275),
  // Anthropic (PRICE_SOURCES.anthropic)
  "claude-fable-5-1": anthropic(10, 50, 0.25),
  "claude-fable-5": anthropic(10, 50, 1),
  "claude-opus-5-5": anthropic(4, 20, 0.2),
  "claude-opus-5": anthropic(5, 25),
  "claude-opus-4-8": anthropic(5, 25),
  "claude-opus-4-7": anthropic(5, 25),
  "claude-opus-4-6": anthropic(5, 25),
  "claude-opus-4-5": anthropic(5, 25),
  "claude-opus-4-1": anthropic(15, 75),
  "claude-sonnet-5-5": anthropic(2, 10, 0.2),
  "claude-sonnet-5": anthropic(2, 10),
  "claude-sonnet-4-6": anthropic(3, 15),
  "claude-sonnet-4-5": anthropic(3, 15),
  "claude-sonnet-4": anthropic(3, 15),
  "claude-haiku-5-5": anthropic(0.1, 0.5),
  "claude-haiku-4-5": anthropic(1, 5),
  // Google (PRICE_SOURCES.google), prompts up to 200K tokens
  "gemini-2.5-pro": plain(1.25, 10, 0.125),
  "gemini-2.5-flash": plain(0.3, 2.5, 0.03),
  "gemini-2.5-flash-lite": plain(0.1, 0.4, 0.01),
};

// What may follow a base model id in a dated or pinned variant:
// `-2024-07-18`, `-20250929`, `@20251101`, `-0613`, `-latest`, optionally followed by more.
const DATED_SUFFIX = /^[-@](?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|latest)(?:[-:@.].*)?$/;

/**
 * Price for a model name: exact match, then without a `provider/` prefix, then the
 * longest key the name is a dated variant of. Undefined for unknown models.
 */
export function lookupPrice(model: string | undefined, prices: Prices): Price | undefined {
  if (!model) return undefined;
  const exact = prices[model];
  if (exact) return exact;
  const bare = model.slice(model.lastIndexOf("/") + 1);
  if (prices[bare]) return prices[bare];
  let best: string | undefined;
  for (const key of Object.keys(prices)) {
    if (bare.length > key.length && bare.startsWith(key) && DATED_SUFFIX.test(bare.slice(key.length)) && (!best || key.length > best.length)) best = key;
  }
  return best ? prices[best] : undefined;
}

/** Built-in table with config overrides on top. */
export function priceTable(overrides?: Prices): Prices {
  return { ...BUILTIN_PRICES, ...(overrides ?? {}) };
}

const tables = new WeakMap<Prices, Prices>();
const builtin = priceTable();
/** priceTable(overrides), built once per overrides object (a config's `pricing`). */
export function pricesFor(overrides?: Prices): Prices {
  if (!overrides) return builtin;
  let t = tables.get(overrides);
  if (!t) tables.set(overrides, (t = priceTable(overrides)));
  return t;
}

const hasTokens = (u: Usage | undefined): u is Usage =>
  !!u && [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens].some((v) => typeof v === "number" && v > 0);

/** Events whose usage is billed tokens: model calls, and session usage snapshots (T3 Code v1, OpenCode totals). */
const priceable = (e: AgentEvent): boolean => e.kind === "llm.call" || (e.kind === "notification" && e.payload?.type === "usage-summary");

/**
 * Fills `usage.costUsd` on a model call (or usage snapshot) that carries tokens
 * but no cost, from its model's price, and marks it `payload.costEstimated = true`.
 * A cost the agent reported always wins. Returns `e` itself when unchanged, else a copy.
 */
export function priceEvent(e: AgentEvent, prices: Prices): AgentEvent {
  if (!priceable(e) || !hasTokens(e.usage) || typeof e.usage.costUsd === "number") return e;
  const pl = e.payload ?? {};
  const names = [pl.responseModel, e.model, pl.requestModel].filter((m): m is string => typeof m === "string" && m !== "");
  const p = names.map((m) => lookupPrice(m, prices)).find(Boolean);
  if (!p) return e;
  return { ...e, usage: { ...e.usage, costUsd: costFrom(e.usage, p) }, payload: { ...e.payload, costEstimated: true } };
}

/** priceEvent over a batch. Returns a new array; events it changes are copies. */
export function applyPricing(events: AgentEvent[], prices: Prices): AgentEvent[] {
  return events.map((e) => priceEvent(e, prices));
}
