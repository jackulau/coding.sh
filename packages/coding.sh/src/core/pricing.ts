// Model prices and cost estimates. Prices are USD per 1M tokens. `estimateCost`
// is exact-match (toolevals passes its own `[prices]` table); `resolvePrice`
// adds the fuzzy lookup ingest and serve use (provider prefix, dated and
// variant suffixes, then a same-family fallback) over the built-in table merged
// with `[prices."<model>"]` (or the older `[pricing."<model>"]`) from config.
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

/** Where each group of rows comes from and when it was last checked against that page. */
export const PRICE_SOURCES: Record<string, { url: string; updated: string }> = {
  openai: { url: "https://developers.openai.com/api/docs/pricing", updated: "2026-11-07" },
  anthropic: { url: "https://platform.claude.com/docs/en/about-claude/pricing", updated: "2026-11-07" },
  google: { url: "https://aistudio.google.com/docs/pricing", updated: "2026-11-07" },
  zai: { url: "https://docs.z.ai/guides/overview/pricing", updated: "2026-11-07" },
  minimax: { url: "https://platform.minimax.io/docs/guides/pricing", updated: "2026-11-07" },
  gateway: { url: "https://vercel.com/ai-gateway/models", updated: "2026-11-07" },
};

/**
 * Bumped when the lookup rules change (not the table), so stored estimates are
 * recomputed once: reprice.ts hashes it into its stamp with the table.
 */
export const PRICING_RULES_VERSION = 2;

// Anthropic: cache write = 5-minute TTL (1.25x input); cache read 0.1x input
// unless the model's row says otherwise.
const anthropic = (input: number, output: number, cacheRead = input / 10): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 });
// OpenAI gpt-6.x and gpt-5.6: a cache-write column at 1.25x input (the 30-minute write).
const cached125 = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 });
// OpenAI up to gpt-5.5, Google, Z.ai and MiniMax bill no separate cache write: writes cost plain input.
const plain = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: input });
// Gateway rows list input and output only: cached tokens are priced as input (an upper bound).
const flat = (input: number, output: number): Price => ({ input, output });

/** Built-in list prices (standard tier, short context). `[prices."<model>"]` overrides any entry. */
export const BUILTIN_PRICES: Prices = {
  // OpenAI (PRICE_SOURCES.openai, Standard tier, as of 2026-11-07). Short-context rates: gpt-6.x,
  // gpt-5.6, 5.5 and 5.4 bill about 2x past 272K prompt tokens. gpt-5.6-sol is a promotional
  // price that the page says runs until 2026-11-30.
  "gpt-6-astra": cached125(10, 50, 1),
  "gpt-6.1-sol": cached125(2, 10, 0.1),
  "gpt-6.1-terra": cached125(1, 5, 0.05),
  "gpt-6-sol": cached125(2, 10, 0.2),
  "gpt-6-luna": cached125(0.1, 0.5, 0.01),
  "gpt-6-cyber": cached125(20, 100, 2),
  "gpt-6-rosalind": cached125(15, 75, 1.5),
  "gpt-5.6-sol": cached125(4, 20, 0.4),
  "gpt-5.6-terra": cached125(2, 12, 0.2),
  "gpt-5.6-luna": cached125(0.2, 1.2, 0.02),
  "gpt-5.6-cyber": cached125(12.5, 75, 1.25),
  "gpt-5.5": plain(5, 30, 0.5),
  "gpt-5.5-cyber": plain(12.5, 75, 1.25),
  "gpt-5.4": plain(2.5, 15, 0.25),
  "gpt-5.4-mini": plain(0.75, 4.5, 0.075),
  "gpt-5.4-nano": plain(0.2, 1.25, 0.02),
  "gpt-5.3-codex": plain(1.75, 14, 0.175),
  "gpt-5.2": plain(1.75, 14, 0.175),
  "gpt-5.1": plain(1.25, 10, 0.125),
  "gpt-5": plain(1.25, 10, 0.125),
  "gpt-5-mini": plain(0.25, 2, 0.025),
  "gpt-5-nano": plain(0.05, 0.4, 0.005),
  "gpt-4.1": plain(2, 8, 0.5),
  "gpt-4.1-mini": plain(0.4, 1.6, 0.1),
  "gpt-4o": plain(2.5, 10, 1.25),
  "gpt-4o-mini": plain(0.15, 0.6, 0.075),
  o3: plain(2, 8, 0.5),
  // Pro models have no cached-input price.
  "gpt-5.5-pro": flat(30, 180),
  "gpt-5.4-pro": flat(30, 180),
  "gpt-5.2-pro": flat(21, 168),
  "gpt-5-pro": flat(15, 120),
  "o3-pro": flat(20, 80),
  // No longer on the page: the last listed price (Codex models launched at their base model's price).
  "gpt-5.2-codex": plain(1.75, 14, 0.175),
  "gpt-5.1-codex-max": plain(1.25, 10, 0.125),
  "gpt-5.1-codex": plain(1.25, 10, 0.125),
  "gpt-5.1-codex-mini": plain(0.25, 2, 0.025),
  "gpt-5-codex": plain(1.25, 10, 0.125),
  "gpt-4.1-nano": plain(0.1, 0.4, 0.025),
  "o4-mini": plain(1.1, 4.4, 0.275),

  // Anthropic (PRICE_SOURCES.anthropic, as of 2026-11-07). Cache reads are 0.1x input, except
  // Fable/Mythos 5.1 (0.025x) and Opus/Sonnet 5.5 (0.05x). Haiku 5.5 bills 5x past 100K prompt
  // tokens; this is the short rate. Claude 4.6+ has no long-context surcharge.
  "claude-fable-5-1": anthropic(10, 50, 0.25),
  "claude-mythos-5-1": anthropic(10, 50, 0.25),
  "claude-fable-5": anthropic(10, 50),
  "claude-mythos-5": anthropic(10, 50),
  "claude-opus-5-5": anthropic(4, 20, 0.2),
  "claude-opus-5": anthropic(5, 25),
  "claude-opus-4-8": anthropic(5, 25),
  "claude-opus-4-7": anthropic(5, 25),
  "claude-opus-4-6": anthropic(5, 25),
  "claude-opus-4-5": anthropic(5, 25),
  "claude-opus-4-1": anthropic(15, 75),
  "claude-opus-4": anthropic(15, 75),
  "claude-sonnet-5-5": anthropic(2, 10, 0.1),
  "claude-sonnet-5": anthropic(2, 10),
  "claude-sonnet-4-6": anthropic(3, 15),
  "claude-sonnet-4-5": anthropic(3, 15),
  "claude-sonnet-4": anthropic(3, 15),
  "claude-haiku-5-5": anthropic(0.1, 0.5),
  "claude-haiku-4-5": anthropic(1, 5),

  // Google Gemini (PRICE_SOURCES.google, paid tier, prompts up to 200K, as of 2026-11-07). Writes
  // cost plain input; cache storage is billed per hour and not counted here. Scheduled changes:
  // gemini-4-argon goes to 4/20 (read 0.2) on 2026-12-01, gemini-3.8-flash and 3.6-flash to
  // 1.5/7.5 (read 0.15) on 2027-01-01. Antigravity runs these models (and Claude, gpt-oss) by
  // display name; its ids resolve here through the suffix and family rules below.
  "gemini-4-argon": plain(2, 10, 0.1),
  "gemini-3.8-flash": plain(0.75, 3.75, 0.075),
  "gemini-3.6-flash": plain(0.75, 3.75, 0.075),
  "gemini-3.5-flash-lite": plain(0.3, 2.5, 0.03),
  "gemini-3.1-pro": plain(2, 12, 0.2),
  "gemini-3.1-flash-lite": plain(0.25, 1.5, 0.025),
  "gemini-3-flash": plain(0.5, 3, 0.05),
  "gemini-2.5-pro": plain(1.25, 10, 0.125),
  "gemini-2.5-flash": plain(0.3, 2.5, 0.03),
  "gemini-2.5-flash-lite": plain(0.1, 0.4, 0.01),

  // Open-weight models, first-party APIs (as of 2026-11-07): Z.ai GLM (PRICE_SOURCES.zai) and
  // MiniMax (PRICE_SOURCES.minimax, Standard, input up to 512K).
  "glm-5.3": plain(1.4, 4.4, 0.26),
  "glm-5.2": plain(1.4, 4.4, 0.26),
  "glm-5.1": plain(1.4, 4.4, 0.26),
  "glm-5": plain(1, 3.2, 0.2),
  "glm-4.7": plain(0.6, 2.2, 0.11),
  "glm-4.6": plain(0.6, 2.2, 0.11),
  "minimax-m3": plain(0.3, 1.2, 0.06),
  "minimax-m3.1-flash": plain(0.15, 0.6, 0.015),
  // Open-weight models through Vercel AI Gateway (PRICE_SOURCES.gateway, as of 2026-11-07; the
  // page lists input and output only). Other gateways and hosts charge their own rates: set
  // `[prices."<model>"]` to match your bill.
  "gpt-oss-120b": flat(0.35, 0.75),
  "gpt-oss-20b": flat(0.07, 0.3),
  "kimi-k2.6": flat(0.8, 3.4),
  "minimax-m2.5": flat(0.3, 1.2),
  "deepseek-v4-pro": flat(0.66, 1.98),
  "deepseek-v4.1-flash": flat(0.02, 0.29),
  "qwen3-coder": flat(0.22, 1.8),
  "mistral-large-3": flat(0.5, 1.5),
  "mistral-medium-3.5": flat(1.5, 7.5),
  codestral: flat(0.3, 0.9),
};

// What may follow a base model id in a dated or pinned variant:
// `-2024-07-18`, `-20250929`, `@20251101`, `-0613`, `-latest`, optionally followed by more.
const DATED_SUFFIX = /^[-@](?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|latest)(?:[-:@.].*)?$/;
// Suffixes that name a mode or a release channel of the same model at the same price.
const VARIANT_SUFFIX = /-(?:thinking|preview|customtools|exp|experimental|latest|high|medium|low|codex)$/;
// A dated tail on its own (`gpt-6.2-sol-2026-12-01`), dropped before the suffix and family steps.
const DATED_SUFFIX_TAIL = /[-@](?:\d{4}-\d{2}-\d{2}|\d{8})$/;

/** A resolved price: which table key it came from, and whether that key is a different model of the same family. */
export interface ResolvedPrice {
  price: Price;
  key: string;
  /** True when no row matched and a sibling version in the same family was used (an estimate of an estimate). */
  fallback: boolean;
}

/**
 * The comparable shape of a model id: everything around its first version number.
 * `claude-opus-4-5` → {family: "claude-opus-|", major: 4, minor: 5}; `gpt-6.1-sol` →
 * {family: "gpt-|-sol", major: 6, minor: 1}; `gemini-3-pro` → {family: "gemini-|-pro", major: 3, minor: 0}.
 */
function familyOf(id: string): { family: string; major: number; minor: number } | undefined {
  const m = /^(.*?[a-z-])(\d+)(?:[.-](\d{1,2}))?(?=$|-)(.*)$/.exec(id);
  if (!m) return undefined;
  return { family: `${m[1]}|${m[4]}`, major: Number(m[2]), minor: m[3] === undefined ? 0 : Number(m[3]) };
}

/** Bare, lowercase model id: no `provider/` prefix, no Bedrock region/vendor prefix or version tag, no `[1m]`-style tag. */
function normalize(model: string): string {
  let s = model.trim().toLowerCase();
  s = s.slice(s.lastIndexOf("/") + 1);
  s = s.replace(/\[[^\]]*\]$/, "");
  s = s.replace(/^(?:[a-z]{2,4}\.)?(?:anthropic|openai|google|meta|mistral|deepseek|qwen|moonshotai)\./, "");
  s = s.replace(/-v?\d+:\d+$/, "");
  return s;
}

interface Index {
  keys: string[];
  families: Map<string, { key: string; major: number; minor: number }[]>;
  memo: Map<string, ResolvedPrice | null>;
}
const indexes = new WeakMap<Prices, Index>();
function indexOf(prices: Prices): Index {
  let ix = indexes.get(prices);
  if (ix) return ix;
  ix = { keys: Object.keys(prices), families: new Map(), memo: new Map() };
  for (const key of ix.keys) {
    const f = familyOf(key);
    if (!f) continue;
    const list = ix.families.get(f.family) ?? [];
    list.push({ key, major: f.major, minor: f.minor });
    ix.families.set(f.family, list);
  }
  indexes.set(prices, ix);
  return ix;
}

/** Exact key, else the longest key the id is a dated variant of. */
function direct(id: string, prices: Prices, ix: Index): string | undefined {
  if (prices[id]) return id;
  let best: string | undefined;
  for (const key of ix.keys) {
    if (id.length > key.length && id.startsWith(key) && DATED_SUFFIX.test(id.slice(key.length)) && (!best || key.length > best.length)) best = key;
  }
  return best;
}

/**
 * Price for a model name. In order: exact; bare (lowercase, no `provider/` or Bedrock
 * prefix); a dated variant of a key (`-20250929`, `@20251101`); the same with mode and
 * channel suffixes dropped (`-thinking`, `-preview`, `-codex`, ...). Then the family
 * fallback: the same family and major version (`gpt-6.2-sol` → `gpt-6.1-sol`,
 * `claude-opus-5-6` → `claude-opus-5-5`) at the highest minor at or below the one asked
 * for, else the lowest one above it. Never across majors. Only the fallback sets
 * `fallback`. Undefined for unknown models.
 */
export function resolvePrice(model: string | undefined, prices: Prices): ResolvedPrice | undefined {
  if (!model) return undefined;
  if (prices[model]) return { price: prices[model], key: model, fallback: false };
  const ix = indexOf(prices);
  const memo = ix.memo.get(model);
  if (memo !== undefined) return memo ?? undefined;
  const r = resolveUncached(model, prices, ix);
  if (ix.memo.size < 10_000) ix.memo.set(model, r ?? null);
  return r;
}

function resolveUncached(model: string, prices: Prices, ix: Index): ResolvedPrice | undefined {
  let id = normalize(model);
  for (;;) {
    const key = direct(id, prices, ix);
    if (key) return { price: prices[key]!, key, fallback: false };
    const shorter = id.replace(DATED_SUFFIX_TAIL, "").replace(VARIANT_SUFFIX, "");
    if (shorter === id) break;
    id = shorter;
  }
  const f = familyOf(id);
  const siblings = f && ix.families.get(f.family)?.filter((s) => s.major === f.major);
  if (!f || !siblings?.length) return undefined;
  const below = siblings.filter((s) => s.minor <= f.minor).sort((a, b) => b.minor - a.minor)[0];
  const pick = below ?? [...siblings].sort((a, b) => a.minor - b.minor)[0]!;
  return { price: prices[pick.key]!, key: pick.key, fallback: true };
}

/** resolvePrice(...).price: the fuzzy lookup without the provenance. */
export function lookupPrice(model: string | undefined, prices: Prices): Price | undefined {
  return resolvePrice(model, prices)?.price;
}

/** Built-in table with config overrides on top. */
export function priceTable(overrides?: Prices): Prices {
  return { ...BUILTIN_PRICES, ...(overrides ?? {}) };
}

const tables = new WeakMap<Prices, Prices>();
const builtin = priceTable();
/** priceTable(overrides), built once per overrides object (a config's `prices`). */
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
 * but no cost, from its model's price, and marks it `payload.costEstimated = true`
 * (plus `payload.pricedAs = <key>` when a sibling model's price was used).
 * A cost the agent or gateway reported always wins. Returns `e` itself when unchanged, else a copy.
 */
export function priceEvent(e: AgentEvent, prices: Prices): AgentEvent {
  if (!priceable(e) || !hasTokens(e.usage) || typeof e.usage.costUsd === "number") return e;
  const pl = e.payload ?? {};
  const names = [pl.responseModel, e.model, pl.requestModel].filter((m): m is string => typeof m === "string" && m !== "");
  let r: ResolvedPrice | undefined;
  for (const m of names) {
    const got = resolvePrice(m, prices);
    if (got && !got.fallback) {
      r = got;
      break;
    }
    r ??= got;
  }
  if (!r) return e;
  const payload: Record<string, unknown> = { ...e.payload, costEstimated: true };
  if (r.fallback) payload.pricedAs = r.key;
  else delete payload.pricedAs;
  return { ...e, usage: { ...e.usage, costUsd: costFrom(e.usage, r.price) }, payload };
}

/**
 * How to label a session's cost: "" when it was all reported, " (estimated)" when
 * all of it came from the price table, " (incl. $x estimated)" when part did.
 */
export function costNote(u: Usage | undefined): string {
  const est = u?.estimatedCostUsd ?? 0;
  const cost = u?.costUsd;
  if (!(est > 0) || cost === undefined) return "";
  if (est >= cost - 1e-9) return " (estimated)";
  return ` (incl. $${est.toFixed(est < 1 ? 4 : 2)} estimated)`;
}

/** priceEvent over a batch. Returns a new array; events it changes are copies. */
export function applyPricing(events: AgentEvent[], prices: Prices): AgentEvent[] {
  return events.map((e) => priceEvent(e, prices));
}
