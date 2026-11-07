// Model prices and cost estimates. Prices are USD per 1M tokens. `estimateCost`
// is exact-match (toolevals passes its own `[prices]` table); `resolvePrice`
// adds the fuzzy lookup ingest and serve use (provider prefix, dated and
// variant suffixes, then a same-family fallback) over the built-in table merged
// with `[prices."<model>"]` (or the older `[pricing."<model>"]`) from config.
// `priceEvent` prices each model call at the rates it ran at: its service tier
// (`callTier`: batch, flex, priority, fast, ultrafast) and, when its own prompt is
// over the model's threshold, long-context rates (`callRates`); its 1-hour cache
// writes (`payload.cacheWrite1hTokens`) at their own rate; and the model's
// data-residency multiplier for `payload.inferenceGeo` (Claude 4.6+ US-only, 1.1x).
import type { AgentEvent, Usage } from "../schema/index.ts";

/** Per-million-token rates. */
export interface Rates {
  input: number;
  output: number;
  /** Defaults to `input` when unset. */
  cacheRead?: number;
  /** Defaults to `input` when unset. The default write: Anthropic's 5-minute cache, OpenAI's cache write. */
  cacheWrite?: number;
  /** Anthropic 1-hour cache writes. Defaults to `cacheWrite` when unset. */
  cacheWrite1h?: number;
}

/**
 * Service tiers a model call can run at besides standard. `batch`: a batch API
 * job. `flex`: OpenAI and Gemini Flex. `priority`: OpenAI Fast (Priority until
 * July 2026; responses still say `priority`) and Gemini Priority. `fast`:
 * Anthropic fast mode (`usage.speed: "fast"`); OpenAI's `fast` uses the
 * `priority` rates where a row has no `fast` ones. `ultrafast`: OpenAI Ultrafast.
 */
export const PRICE_TIERS = ["batch", "flex", "priority", "fast", "ultrafast"] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

/** Rates for a model call whose prompt (input + cache reads + cache writes) is over `above` tokens. */
export interface LongContextRates extends Rates {
  above: number;
}

/** One service tier's rates. Its long-context threshold defaults to the row's `longContext.above`. */
export interface TierRates extends Rates {
  longContext?: Rates & { above?: number };
}

export interface Price extends Rates {
  /** Standard-tier rates for long prompts, when the model bills them higher. */
  longContext?: LongContextRates;
  /** Rates per service tier. A call at a tier with no row here is billed at the standard rates. */
  tiers?: Partial<Record<PriceTier, TierRates>>;
  /**
   * Multiplier on every rate (any tier, long context included) by the call's inference
   * geography (`payload.inferenceGeo`): `{ us: 1.1 }` for Claude 4.6+ US-only inference.
   */
  geo?: Record<string, number>;
}

/** Prices in USD per million tokens, keyed by model id. */
export type Prices = Record<string, Price>;

/** USD from token counts and per-million prices (standard rates); undefined when the model has no exact price entry. */
export function estimateCost(u: Usage, model: string | undefined, prices: Prices | undefined): number | undefined {
  if (!model || !prices) return undefined;
  const p = prices[model];
  return p ? costFrom(u, p) : undefined;
}

/**
 * USD for one usage record at one set of rates. `inputTokens` counts uncached input.
 * `cacheWrite1h` is the part of `cacheWriteTokens` written to a 1-hour cache.
 */
export function costFrom(u: Usage, p: Rates, cacheWrite1h = 0): number {
  const write = u.cacheWriteTokens ?? 0;
  const long = Math.min(Math.max(cacheWrite1h, 0), write);
  const writeRate = p.cacheWrite ?? p.input;
  return ((u.inputTokens ?? 0) * p.input + (u.outputTokens ?? 0) * p.output + (u.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input) + (write - long) * writeRate + long * (p.cacheWrite1h ?? writeRate)) / 1e6;
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
 * 3: per-call long-context and service-tier rates (`payload.priceTier`).
 * 4: 1-hour cache writes at their own rate, and the US-only data-residency multiplier.
 */
export const PRICING_RULES_VERSION = 4;

/** `r` times `k`, field by field. */
const scale = (r: Rates, k: number): Rates => ({
  input: r.input * k,
  output: r.output * k,
  ...(r.cacheRead !== undefined ? { cacheRead: r.cacheRead * k } : {}),
  ...(r.cacheWrite !== undefined ? { cacheWrite: r.cacheWrite * k } : {}),
  ...(r.cacheWrite1h !== undefined ? { cacheWrite1h: r.cacheWrite1h * k } : {}),
});
/** `p` plus tier rows: a number is that multiple of the row (its long-context rates scaled too), rates are taken as given. */
function tiers(p: Price, t: Partial<Record<PriceTier, number | TierRates>>): Price {
  const out: Partial<Record<PriceTier, TierRates>> = { ...p.tiers };
  for (const [k, v] of Object.entries(t) as [PriceTier, number | TierRates][]) {
    out[k] = typeof v !== "number" ? v : { ...scale(p, v), ...(p.longContext ? { longContext: scale(p.longContext, v) } : {}) };
  }
  return { ...p, tiers: out };
}

// Anthropic (PRICE_SOURCES.anthropic, "Prompt caching"): a 5-minute cache write is 1.25x base
// input, a 1-hour cache write 2x; cache read 0.1x input unless the model's row says otherwise.
// "These multipliers stack with other pricing modifiers, including the Batch API discount and
// data residency", and with fast mode and long-context rates, so every row carries both writes.
const anthropicRates = (input: number, output: number, cacheRead = input / 10): Rates => ({ input, output, cacheRead, cacheWrite: input * 1.25, cacheWrite1h: input * 2 });
// Every Claude model: the Batch API is 50% off each token type, and the cache multipliers apply on
// top (PRICE_SOURCES.anthropic, "Batch processing" and "Prompt caching"). Priority Tier is billed
// by capacity commitment, not per token, so a `service_tier: "priority"` call keeps standard rates.
const anthropic = (input: number, output: number, cacheRead?: number, more: { longContext?: LongContextRates; fast?: Rates } = {}): Price =>
  tiers({ ...anthropicRates(input, output, cacheRead), ...(more.longContext ? { longContext: more.longContext } : {}) }, { batch: 0.5, ...(more.fast ? { fast: more.fast } : {}) });
// Claude 4.6 and later (PRICE_SOURCES.anthropic, "Data residency pricing"): `inference_geo: "us"`
// "incurs a 1.1x multiplier on all token pricing categories, including input tokens, output tokens,
// cache writes, and cache reads", on Haiku 5.5's long-context prices and on fast mode too. Global
// routing (the default) is standard. Older models have no US-only option.
const usOnly = (p: Price): Price => ({ ...p, geo: { us: 1.1 } });
const anthropic46 = (...a: Parameters<typeof anthropic>): Price => usOnly(anthropic(...a));
// OpenAI gpt-6.x and gpt-5.6: a cache-write column at 1.25x input (the 30-minute write).
const cached125 = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 });
// OpenAI up to gpt-5.5, Google, Z.ai and MiniMax bill no separate cache write: writes cost plain input.
const plain = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheRead, cacheWrite: input });
// Gateway rows list input and output only: cached tokens are priced as input (an upper bound).
const flat = (input: number, output: number): Price => ({ input, output });
// OpenAI long context, > 272K input tokens (PRICE_SOURCES.openai, "Short context: ≤272K input
// tokens. Long context: >272K input tokens."): 2x input, cached input and cache writes, 1.5x output.
const openaiLong = (p: Price): Price => ({
  ...p,
  longContext: { above: 272_000, input: p.input * 2, output: p.output * 1.5, ...(p.cacheRead !== undefined ? { cacheRead: p.cacheRead * 2 } : {}), ...(p.cacheWrite !== undefined ? { cacheWrite: p.cacheWrite * 2 } : {}) },
});
// gpt-6.x and gpt-5.6 at every tier: Batch and Flex 0.5x, Fast (priority) 2x, Ultrafast 6x, each with its long-context rates.
const gpt6 = (input: number, output: number, cacheRead: number, more: Partial<Record<PriceTier, number>> = {}): Price =>
  tiers(openaiLong(cached125(input, output, cacheRead)), { batch: 0.5, flex: 0.5, priority: 2, ...more });
// Gemini long context, prompts > 200K tokens (PRICE_SOURCES.google): the model's own rates.
const geminiLong = (p: Price, lc: Rates): Price => ({ ...p, longContext: { above: 200_000, ...lc } });

/**
 * The model coding.sh calls when nothing names one (judges, next-turn replays): each provider's
 * current general model, as of the price table below. The one place to bump when a new model
 * ships; a test checks every entry has a price row.
 */
export const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-6-sol",
  google: "gemini-4-argon",
} as const;

/**
 * Built-in list prices: standard short-context rates on each row, plus `longContext` and `tiers`
 * where the provider's page lists them. `[prices."<model>"]` replaces a whole row.
 */
export const BUILTIN_PRICES: Prices = {
  // OpenAI (PRICE_SOURCES.openai, as of 2026-11-07): Standard, Batch, Flex, Fast (`priority`) and
  // Ultrafast tables, short and long context. Flex matches Batch wherever both are listed. Fast was
  // called Priority until 2026-07-30 (https://developers.openai.com/api/docs/guides/priority-processing).
  // Batch "-" for cached input (gpt-4.x, o3) bills cached tokens as input. gpt-5.6-sol is a
  // promotional price that the page says runs until 2026-11-30.
  "gpt-6-astra": gpt6(10, 50, 1, { ultrafast: 6 }),
  "gpt-6.1-sol": gpt6(2, 10, 0.1, { ultrafast: 6 }),
  "gpt-6.1-terra": gpt6(1, 5, 0.05),
  "gpt-6-sol": gpt6(2, 10, 0.2),
  "gpt-6-luna": gpt6(0.1, 0.5, 0.01),
  "gpt-6-cyber": cached125(20, 100, 2),
  "gpt-6-rosalind": openaiLong(cached125(15, 75, 1.5)),
  "gpt-5.6-sol": gpt6(4, 20, 0.4),
  "gpt-5.6-terra": gpt6(2, 12, 0.2),
  "gpt-5.6-luna": gpt6(0.2, 1.2, 0.02),
  "gpt-5.6-cyber": cached125(12.5, 75, 1.25),
  "gpt-5.5": tiers(openaiLong(plain(5, 30, 0.5)), { batch: 0.5, flex: 0.5, priority: plain(12.5, 75, 1.25) }),
  "gpt-5.5-cyber": plain(12.5, 75, 1.25),
  "gpt-5.4": tiers(openaiLong(plain(2.5, 15, 0.25)), {
    batch: { ...plain(1.25, 7.5, 0.13), longContext: plain(2.5, 11.25, 0.25) },
    flex: { ...plain(1.25, 7.5, 0.13), longContext: plain(2.5, 11.25, 0.25) },
    priority: plain(5, 30, 0.5),
  }),
  "gpt-5.4-mini": tiers(plain(0.75, 4.5, 0.075), { batch: 0.5, flex: 0.5, priority: 2 }),
  "gpt-5.4-nano": tiers(plain(0.2, 1.25, 0.02), { batch: 0.5, flex: 0.5 }),
  "gpt-5.3-codex": tiers(plain(1.75, 14, 0.175), { priority: 2 }),
  "gpt-5.2": tiers(plain(1.75, 14, 0.175), { batch: 0.5, flex: 0.5, priority: 2 }),
  "gpt-5.1": tiers(plain(1.25, 10, 0.125), { batch: 0.5, flex: 0.5, priority: 2 }),
  "gpt-5": tiers(plain(1.25, 10, 0.125), { batch: 0.5, flex: 0.5, priority: 2 }),
  "gpt-5-mini": tiers(plain(0.25, 2, 0.025), { batch: 0.5, flex: 0.5, priority: plain(0.45, 3.6, 0.045) }),
  "gpt-5-nano": tiers(plain(0.05, 0.4, 0.005), { batch: 0.5, flex: 0.5 }),
  "gpt-4.1": tiers(plain(2, 8, 0.5), { batch: flat(1, 4), priority: plain(3.5, 14, 0.875) }),
  "gpt-4.1-mini": tiers(plain(0.4, 1.6, 0.1), { batch: flat(0.2, 0.8), priority: plain(0.7, 2.8, 0.175) }),
  "gpt-4o": tiers(plain(2.5, 10, 1.25), { batch: flat(1.25, 5), priority: plain(4.25, 17, 2.125) }),
  "gpt-4o-mini": tiers(plain(0.15, 0.6, 0.075), { batch: flat(0.075, 0.3), priority: plain(0.25, 1, 0.125) }),
  o3: tiers(plain(2, 8, 0.5), { batch: flat(1, 4), flex: plain(1, 4, 0.25), priority: plain(3.5, 14, 0.875) }),
  // Pro models have no cached-input price. gpt-5.5-pro lists no long-context Batch or Flex rate.
  "gpt-5.5-pro": tiers(openaiLong(flat(30, 180)), { batch: flat(15, 90), flex: flat(15, 90) }),
  "gpt-5.4-pro": tiers(openaiLong(flat(30, 180)), { batch: 0.5, flex: 0.5 }),
  "gpt-5.2-pro": tiers(flat(21, 168), { batch: 0.5 }),
  "gpt-5-pro": tiers(flat(15, 120), { batch: 0.5 }),
  "o3-pro": tiers(flat(20, 80), { batch: 0.5 }),
  // No longer on the page: the last listed price (Codex models launched at their base model's price).
  "gpt-5.2-codex": plain(1.75, 14, 0.175),
  "gpt-5.1-codex-max": plain(1.25, 10, 0.125),
  "gpt-5.1-codex": plain(1.25, 10, 0.125),
  "gpt-5.1-codex-mini": plain(0.25, 2, 0.025),
  "gpt-5-codex": plain(1.25, 10, 0.125),
  "gpt-4.1-nano": plain(0.1, 0.4, 0.025),
  "o4-mini": plain(1.1, 4.4, 0.275),

  // Anthropic (PRICE_SOURCES.anthropic, as of 2026-11-07). Cache reads are 0.1x input, except
  // Fable/Mythos 5.1 (0.025x) and Opus/Sonnet 5.5 (0.05x). Every row has Batch at 0.5x. Fast mode
  // ("Fast mode pricing"): Opus 5.5 $8/$40, Opus 5 and 4.8 $10/$50, cache multipliers on top, the
  // same rate at any prompt length. Long context: Claude 4.6+ bills the whole 1M window at standard
  // rates, except Haiku 5.5, whose prompts over 100,000 tokens (cache reads and writes included,
  // per request) pay $0.50/$2.50.
  "claude-fable-5-1": anthropic46(10, 50, 0.25),
  "claude-mythos-5-1": anthropic46(10, 50, 0.25),
  "claude-fable-5": anthropic46(10, 50),
  "claude-mythos-5": anthropic46(10, 50),
  "claude-opus-5-5": anthropic46(4, 20, 0.2, { fast: anthropicRates(8, 40, 0.4) }),
  "claude-opus-5": anthropic46(5, 25, undefined, { fast: anthropicRates(10, 50) }),
  "claude-opus-4-8": anthropic46(5, 25, undefined, { fast: anthropicRates(10, 50) }),
  "claude-opus-4-7": anthropic46(5, 25),
  "claude-opus-4-6": anthropic46(5, 25),
  "claude-opus-4-5": anthropic(5, 25),
  "claude-opus-4-1": anthropic(15, 75),
  "claude-opus-4": anthropic(15, 75),
  "claude-sonnet-5-5": anthropic46(2, 10, 0.1),
  "claude-sonnet-5": anthropic46(2, 10),
  "claude-sonnet-4-6": anthropic46(3, 15),
  // Sonnet 4.5 and 4 reached past 200K only with the 1M-context beta, which billed prompts over
  // 200K tokens at $6/$22.50, cache multipliers on top, batch 50% off: Sonnet 4 per
  // https://claude.com/blog/1m-context, Sonnet 4.5 per https://vercel.com/ai-gateway/models/claude-sonnet-4.5
  // (2x input, 1.5x output when input plus cache reads and writes exceed 200K). The current page
  // lists Sonnet 4.5 with a 200K window.
  "claude-sonnet-4-5": anthropic(3, 15, undefined, { longContext: { above: 200_000, ...anthropicRates(6, 22.5) } }),
  "claude-sonnet-4": anthropic(3, 15, undefined, { longContext: { above: 200_000, ...anthropicRates(6, 22.5) } }),
  "claude-haiku-5-5": anthropic46(0.1, 0.5, undefined, { longContext: { above: 100_000, ...anthropicRates(0.5, 2.5) } }),
  "claude-haiku-4-5": anthropic(1, 5),

  // Google Gemini (PRICE_SOURCES.google, paid tier, as of 2026-11-07): Standard, Batch, Flex and
  // Priority tabs; 3.1 Pro and 2.5 Pro bill prompts over 200K tokens higher. Writes cost plain input;
  // cache storage is billed per hour and not counted here. Where Batch and Flex caching says "Same
  // as Standard" the standard cache rate is kept. Scheduled changes: gemini-4-argon goes to 4/20
  // (read 0.2) on 2026-12-01, gemini-3.8-flash and 3.6-flash to 1.5/7.5 (read 0.15) on 2027-01-01.
  // Antigravity runs these models (and Claude, gpt-oss) by display name; its ids resolve here
  // through the suffix and family rules below.
  "gemini-4-argon": tiers(plain(2, 10, 0.1), { batch: 0.5, flex: 0.5, priority: 1.8 }),
  "gemini-3.8-flash": tiers(plain(0.75, 3.75, 0.075), { batch: 0.5, flex: 0.5, priority: 1.8 }),
  "gemini-3.6-flash": tiers(plain(0.75, 3.75, 0.075), { batch: 0.5, flex: 0.5, priority: 1.8 }),
  "gemini-3.5-flash-lite": tiers(plain(0.3, 2.5, 0.03), { batch: 0.5, flex: plain(0.15, 1.25, 0.02), priority: plain(0.54, 4.5, 0.05) }),
  "gemini-3.1-pro": tiers(geminiLong(plain(2, 12, 0.2), plain(4, 18, 0.4)), {
    batch: { ...plain(1, 6, 0.2), longContext: plain(2, 9, 0.4) },
    flex: { ...plain(1, 6, 0.2), longContext: plain(2, 9, 0.4) },
    priority: 1.8,
  }),
  "gemini-3.1-flash-lite": tiers(plain(0.25, 1.5, 0.025), { batch: 0.5, flex: 0.5, priority: 1.8 }),
  "gemini-3-flash": tiers(plain(0.5, 3, 0.05), { batch: plain(0.25, 1.5, 0.05), flex: plain(0.25, 1.5, 0.05), priority: 1.8 }),
  "gemini-2.5-pro": tiers(geminiLong(plain(1.25, 10, 0.125), plain(2.5, 15, 0.25)), {
    batch: { ...plain(0.625, 5, 0.125), longContext: plain(1.25, 7.5, 0.25) },
    flex: { ...plain(0.625, 5, 0.125), longContext: plain(1.25, 7.5, 0.25) },
    priority: 1.8,
  }),
  "gemini-2.5-flash": tiers(plain(0.3, 2.5, 0.03), { batch: plain(0.15, 1.25, 0.03), flex: plain(0.15, 1.25, 0.03), priority: 1.8 }),
  "gemini-2.5-flash-lite": tiers(plain(0.1, 0.4, 0.01), { batch: plain(0.05, 0.2, 0.01), flex: plain(0.05, 0.2, 0.01), priority: 1.8 }),

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

const STANDARD_TIERS = new Set(["standard", "standard_only", "default", "auto", "normal", "on_demand"]);
/**
 * A service tier or speed as adapters keep it on a model call (`payload.serviceTier`,
 * `payload.speed`): lowercased, undefined for the standard values every call
 * carries (`standard`, `default`, `auto`, `normal`).
 */
export function tierValue(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s && !STANDARD_TIERS.has(s) ? s : undefined;
}

const DEFAULT_GEOS = new Set(["global", "not_available", "unknown", "none", "default"]);
/**
 * An inference geography as adapters keep it on a model call (`payload.inferenceGeo`,
 * from Anthropic's `usage.inference_geo`): lowercased, undefined for global routing
 * (the default) and for "not_available".
 */
export function geoValue(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s && !DEFAULT_GEOS.has(s) ? s : undefined;
}

/** `payload.cacheWrite1hTokens`: the part of a call's cache writes that went to a 1-hour cache. */
export const cacheWrite1h = (payload: Record<string, unknown> | undefined): number => {
  const v = payload?.cacheWrite1hTokens;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
};

const isTier = (v: unknown): v is PriceTier => typeof v === "string" && (PRICE_TIERS as readonly string[]).includes(v);
const tierName = (v: unknown): PriceTier | undefined => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : undefined;
  return isTier(s) ? s : undefined;
};

/**
 * The service tier a model call ran at, from what its adapter recorded:
 * `payload.serviceTier` (Anthropic and OpenAI `service_tier`, OTel
 * `openai.response.service_tier`, ...) and `payload.speed` (Anthropic fast mode).
 * Undefined for standard and for values with no per-token price of their own
 * (`default`, `auto`, `standard`, `scale`). Batch wins: fast mode has no batch.
 */
export function callTier(payload: Record<string, unknown> | undefined): PriceTier | undefined {
  const service = tierName(payload?.serviceTier);
  if (service === "batch") return service;
  return tierName(payload?.speed) === "fast" ? "fast" : service;
}

/** Tokens in a call's prompt: uncached input, cache reads and cache writes. */
export const promptTokens = (u: Usage | undefined): number => (u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0);

/** The rates one call pays, and which non-standard ones they are (`payload.priceTier`). */
export interface CallRates {
  rates: Rates;
  /** `batch`, `long-context`, `us-only`, `batch+long-context`, ...; undefined at standard short-context rates. */
  tier?: string;
}

/**
 * Rates for one model call: the tier's row when the price has one (`fast` falls
 * back to `priority`; a tier with no row keeps standard rates), then that row's
 * long-context rates when `prompt` (this call's prompt tokens) is over the threshold,
 * then the price's multiplier for `geo` (the call's inference geography), if it has one.
 */
export function callRates(p: Price, tier?: PriceTier, prompt?: number, geo?: string): CallRates {
  const key: PriceTier | undefined = tier && p.tiers?.[tier] ? tier : tier === "fast" && p.tiers?.priority ? "priority" : undefined;
  const row: TierRates = key ? p.tiers![key]! : p;
  const lc = row.longContext;
  const above = lc?.above ?? p.longContext?.above;
  const long = lc && above !== undefined && (prompt ?? 0) > above ? lc : undefined;
  const k = geo ? p.geo?.[geo] : undefined;
  const labels = [...(key ? [key] : []), ...(long ? ["long-context"] : []), ...(k !== undefined ? [`${geo}-only`] : [])];
  const rates: Rates = long ?? row;
  return { rates: k !== undefined ? scale(rates, k) : rates, ...(labels.length ? { tier: labels.join("+") } : {}) };
}

/**
 * Fills `usage.costUsd` on a model call (or usage snapshot) that carries tokens
 * but no cost, from its model's price, and marks it `payload.costEstimated = true`
 * (plus `payload.pricedAs = <key>` when a sibling model's price was used, and
 * `payload.priceTier` when tier, long-context or data-residency rates were). A
 * model call is priced on its own: its tier, its own prompt size, its 1-hour cache
 * writes and its inference geography. A usage snapshot holds running session
 * totals, so it is priced at standard short-context rates.
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
  const call = e.kind === "llm.call";
  const { rates, tier } = call ? callRates(r.price, callTier(pl), promptTokens(e.usage), geoValue(pl.inferenceGeo)) : { rates: r.price, tier: undefined };
  const payload: Record<string, unknown> = { ...e.payload, costEstimated: true };
  if (r.fallback) payload.pricedAs = r.key;
  else delete payload.pricedAs;
  if (tier) payload.priceTier = tier;
  else delete payload.priceTier;
  return { ...e, usage: { ...e.usage, costUsd: costFrom(e.usage, rates, call ? cacheWrite1h(pl) : 0) }, payload };
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
