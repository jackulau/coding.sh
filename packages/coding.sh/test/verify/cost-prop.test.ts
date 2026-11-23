// Cost (core/pricing.ts priceEvent and the built-in price table) and how a session adds it up
// (core/sessions.ts rollupUsage and foldUsage, through buildSession). The properties:
//
// - The price table is sound. Every rate is a finite number of 0 or more, and every geography
//   multiplier a finite number above 0. On every row (standard, each tier, and the long-context rates
//   of each): a cache read costs no more than input, and a 1-hour cache write no less than a 5-minute
//   one. A long-context rate is no lower than the rate it replaces, and long-context rates have a
//   threshold, their own or the model's.
// - A call's cost is a finite number of 0 or more, marked as an estimate, and its parts by token type
//   add up to it (splitOf accepts them). It is at most the call's tokens at the highest rate its model
//   has. A cost the agent reported is kept, and a call with no tokens or no price is left as it was.
// - A call's cost never falls when its input, output, cache reads, cache writes or 1-hour cache writes
//   rise, whether or not its prompt crosses a long-context threshold.
// - A token count below 0 or not a finite number bills nothing: the call costs what it would without
//   it, and a call with no other count gets no estimate. The count is kept as it was sent. An estimate
//   that would not be a finite number is not made.
// - A session's token counts and cost are the sums over the calls it counts, plus its latest usage
//   snapshot. A call that repeats an earlier call's responseId, or replays one, counts once. A wrapper
//   span over a call with the same tokens counts once, with its own values, except that a cost the
//   nested call reported beats the wrapper's estimate. The estimated part is the sum of the estimates
//   counted, and its splits by token type and by tier add up to it. What was left out is the duplicate
//   count, tokens and cost.
//
// Calls are drawn over every model in the built-in table, with provider prefixes, dated and variant
// suffixes, family fallbacks and an unknown model; prompts near each long-context threshold; and the
// service tiers, speeds and geographies adapters record. Gateway companions are left out: they carry
// what a gateway billed minus the call's own cost, which can be negative.
//
// The last test shows each check fails on a mutant of the table, the pricer or the fold.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 200 per call, 100 per session);
// CODING_SH_PROP_SEED=s replays one. The last test reads neither.
import assert from "node:assert/strict";
import { test } from "node:test";
import { priceEvent, pricesFor, PRICE_TIERS, resolvePrice, splitOf, TOKEN_TYPES, type Price, type Prices, type Rates } from "../../src/core/pricing.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentEvent, CostByTokenType, Session, Usage } from "../../src/schema/index.ts";
import { forAll, gen, PropertyFailure, type Gen } from "../_prop.ts";

const CALL_RUNS = 200;
const SESSION_RUNS = 100;
const MUTANT_RUNS = 1000;

/** What the properties run against: the real table, pricer and fold, or a mutant of one. */
interface Subject {
  prices: Prices;
  price: (e: AgentEvent, prices: Prices) => AgentEvent;
  fold: (events: AgentEvent[]) => Session;
  /** Table keys calls are drawn from. */
  keys: readonly string[];
}

const REAL: Subject = { prices: pricesFor(), price: priceEvent, fold: (events) => buildSession(events), keys: Object.keys(pricesFor()) };

// ---------------------------------------------------------------- the table

const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;

/** The rates costFrom bills at, each default filled in. */
function billed(r: Rates): Required<Rates> {
  const cacheWrite = r.cacheWrite ?? r.input;
  return { input: r.input, output: r.output, cacheRead: r.cacheRead ?? r.input, cacheWrite, cacheWrite1h: r.cacheWrite1h ?? cacheWrite };
}

/** A row a price bills from: standard or a tier, with the long-context rates that replace it over `above` prompt tokens. */
interface Row {
  name: string;
  rates: Rates;
  long?: Rates;
  above?: number;
}

function rowsOf(p: Price): Row[] {
  const rows: Row[] = [{ name: "standard", rates: p, long: p.longContext, above: p.longContext?.above }];
  for (const t of PRICE_TIERS) {
    const row = p.tiers?.[t];
    if (row) rows.push({ name: t, rates: row, long: row.longContext, above: row.longContext?.above ?? p.longContext?.above });
  }
  return rows;
}

/** Fails on the first rate in `prices` that breaks the table's rules, naming it. Returns the rate sets checked. */
function checkTable(prices: Prices): number {
  let checked = 0;
  for (const [key, p] of Object.entries(prices)) {
    for (const [geo, k] of Object.entries(p.geo ?? {})) assert.ok(Number.isFinite(k) && k > 0, `${key}: the ${geo} multiplier is ${k}, not a finite number above 0`);
    for (const row of rowsOf(p)) {
      for (const [where, r] of [[`${key} ${row.name}`, row.rates], [`${key} ${row.name} long-context`, row.long]] as const) {
        if (!r) continue;
        checked++;
        for (const f of RATE_FIELDS) {
          const v = r[f];
          assert.ok(v === undefined || (Number.isFinite(v) && v >= 0), `${where}: ${f} is ${v}, not a finite rate of 0 or more`);
        }
        const b = billed(r);
        assert.ok(b.cacheRead <= b.input, `${where}: a cache read (${b.cacheRead}) costs more than input (${b.input})`);
        assert.ok(b.cacheWrite1h >= b.cacheWrite, `${where}: a 1-hour cache write (${b.cacheWrite1h}) costs less than a 5-minute one (${b.cacheWrite})`);
      }
      if (!row.long) continue;
      assert.ok(row.above !== undefined && Number.isFinite(row.above) && row.above >= 0, `${key} ${row.name}: long-context rates with no threshold are never billed`);
      const short = billed(row.rates);
      const long = billed(row.long);
      for (const f of RATE_FIELDS) assert.ok(long[f] >= short[f], `${key} ${row.name}: the long-context ${f} rate (${long[f]}) is below the rate it replaces (${short[f]})`);
    }
  }
  return checked;
}

/** Every long-context threshold in a table, ascending. */
function thresholdsOf(prices: Prices): number[] {
  const all = Object.values(prices).flatMap((p) => [p.longContext?.above, ...PRICE_TIERS.map((t) => p.tiers?.[t]?.longContext?.above)]);
  return [...new Set(all.filter((a): a is number => typeof a === "number"))].sort((a, b) => a - b);
}

/** The highest rate `p` bills a token at: any tier, long context and geography included. */
function maxRate(p: Price): number {
  const geo = Math.max(1, ...Object.values(p.geo ?? {}));
  const rates = rowsOf(p).flatMap((r) => [r.rates, r.long]).filter((r): r is Rates => r !== undefined);
  return geo * Math.max(...rates.flatMap((r) => Object.values(billed(r))));
}

// ---------------------------------------------------------------- calls

/** A model call as the properties draw it. Token counts are absent or whole numbers of 0 or more. */
interface Call {
  model: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** payload.cacheWrite1hTokens, which may be over the cache writes or negative. */
  cacheWrite1h?: number;
  serviceTier?: string;
  speed?: string;
  geo?: string;
  /** A cost the agent reported. */
  reported?: number;
}

/** Names with no row of their own: family fallbacks, an alias, a Bedrock id, an unknown model. */
const ODD_MODELS = ["gpt-6.3-sol", "claude-opus-5-6", "gemini-pro-orchestrator-neon", "us.anthropic.claude-sonnet-5-5-v1:0", "no-such-model"];
const TIERS = [undefined, "batch", "flex", "priority", "fast", "ultrafast", "standard", "default", "auto", "scale", "BATCH", " Priority "];
const SPEEDS = [undefined, "fast", "standard"];
const GEOS = [undefined, "us", "global", "eu", "US"];
/** A reported cost: $0.000001 to $5. */
const COST: Gen<number> = gen.map(gen.int(1, 5_000_000), (n) => n / 1e6);

function modelGen(keys: readonly string[]): Gen<string> {
  return gen.frequency(
    [8, gen.pick(keys)],
    [1, gen.map(gen.pick(keys), (k) => `openai/${k}`)],
    [1, gen.map(gen.pick(keys), (k) => `${k}-20260101`)],
    [1, gen.map(gen.pick(keys), (k) => `${k.toUpperCase()}-thinking`)],
    [1, gen.pick(ODD_MODELS)],
  );
}

/** A prompt size: small, near a long-context threshold, or anywhere up to 2M tokens. */
function promptGen(thresholds: readonly number[]): Gen<number> {
  const near = thresholds.length ? [[3, gen.chain(gen.pick(thresholds), (t) => gen.int(Math.max(0, t - 2_000), t + 2_000))] as const] : [];
  return gen.frequency([3, gen.int(0, 5_000)], ...near, [2, gen.int(0, 400_000)], [1, gen.int(0, 2_000_000)]);
}

/** `n`, or absent when it is 0 and `absent` says so. */
const maybe = (n: number, absent: boolean): number | undefined => (n === 0 && absent ? undefined : n);

/** A call whose prompt is split at two cuts into uncached input, cache reads and cache writes. */
function callGen(s: Subject, reported = false): Gen<Call> {
  return gen.chain(promptGen(thresholdsOf(s.prices)), (total) =>
    gen.chain(gen.tuple(gen.int(0, total), gen.int(0, total)), ([x, y]) => {
      const lo = Math.min(x, y);
      const hi = Math.max(x, y);
      const write = total - hi;
      return gen.record<Call>({
        model: modelGen(s.keys),
        input: gen.map(gen.bool, (absent) => maybe(lo, absent)),
        cacheRead: gen.map(gen.bool, (absent) => maybe(hi - lo, absent)),
        cacheWrite: gen.map(gen.bool, (absent) => maybe(write, absent)),
        output: gen.frequency([2, gen.constant<number | undefined>(undefined)], [3, gen.int(0, 2_000)], [3, gen.int(0, 50_000)], [1, gen.int(0, 2_000_000)]),
        cacheWrite1h: gen.frequency([3, gen.constant<number | undefined>(undefined)], [3, gen.int(0, write)], [1, gen.int(write, write + 10_000)], [1, gen.int(-1_000, -1)]),
        serviceTier: gen.pick(TIERS),
        speed: gen.pick(SPEEDS),
        geo: gen.pick(GEOS),
        reported: reported ? gen.frequency([3, gen.constant<number | undefined>(undefined)], [1, gen.constant(0)], [2, COST]) : gen.constant(undefined),
      });
    }),
  );
}

function callEvent(c: Call, id = "c", ts = 1): AgentEvent {
  const usage: Usage = {};
  if (c.input !== undefined) usage.inputTokens = c.input;
  if (c.output !== undefined) usage.outputTokens = c.output;
  if (c.cacheRead !== undefined) usage.cacheReadTokens = c.cacheRead;
  if (c.cacheWrite !== undefined) usage.cacheWriteTokens = c.cacheWrite;
  if (c.reported !== undefined) usage.costUsd = c.reported;
  const payload: Record<string, unknown> = {};
  if (c.cacheWrite1h !== undefined) payload.cacheWrite1hTokens = c.cacheWrite1h;
  if (c.serviceTier !== undefined) payload.serviceTier = c.serviceTier;
  if (c.speed !== undefined) payload.speed = c.speed;
  if (c.geo !== undefined) payload.inferenceGeo = c.geo;
  return { id, v: 0, sessionId: "s", ts, agent: "claude-code", kind: "llm.call", model: c.model, usage, payload };
}

const tokensOfCall = (c: Call): number => (c.input ?? 0) + (c.output ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);

function checkCall(s: Subject, c: Call): void {
  const e = callEvent(c);
  const before = structuredClone(e);
  const priced = s.price(e, s.prices);
  assert.deepEqual(e, before, "pricing changed the event it was given");
  const tokens = tokensOfCall(c);
  const found = resolvePrice(c.model, s.prices);
  if (c.reported !== undefined || tokens === 0 || !found) {
    assert.equal(priced, e, c.reported !== undefined ? "a reported cost was replaced" : "a call with no tokens or no price was priced");
    return;
  }
  const cost = priced.usage?.costUsd;
  assert.ok(typeof cost === "number" && Number.isFinite(cost), `the cost is ${cost}, not a finite number`);
  assert.ok(cost >= 0, `the cost is negative: ${cost}`);
  assert.equal(priced.payload.costEstimated, true, "an estimate not marked as one");
  assert.ok(splitOf(priced.payload.costByTokenType, cost), `the parts by token type ${JSON.stringify(priced.payload.costByTokenType)} do not add up to the cost ${cost}`);
  const bound = (tokens * maxRate(found.price)) / 1e6;
  assert.ok(cost <= bound * (1 + 1e-12), `the cost ${cost} is over the call's tokens at its model's highest rate (${bound})`);
}

const RAISE = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;

interface RaiseCase {
  call: Call;
  field: (typeof RAISE)[number];
  by: number;
}

/** A call, a count to raise, and by how much: sometimes just up to or past a long-context threshold. */
function raiseGen(s: Subject): Gen<RaiseCase> {
  const thresholds = thresholdsOf(s.prices);
  return gen.chain(gen.tuple(callGen(s), gen.pick(RAISE)), ([call, field]) => {
    const prompt = (call.input ?? 0) + (call.cacheRead ?? 0) + (call.cacheWrite ?? 0);
    const past = thresholds.filter((t) => t >= prompt).flatMap((t) => [t - prompt, t - prompt + 1]).filter((d) => d > 0);
    const inPrompt = field === "input" || field === "cacheRead" || field === "cacheWrite";
    const by = inPrompt && past.length ? gen.frequency([2, gen.int(1, 1_000)], [2, gen.pick(past)], [1, gen.int(1, 500_000)]) : gen.frequency([2, gen.int(1, 1_000)], [1, gen.int(1, 500_000)]);
    return gen.map(by, (n): RaiseCase => ({ call, field, by: n }));
  });
}

function checkRaise(s: Subject, { call, field, by }: RaiseCase): void {
  const cost = (c: Call): number => s.price(callEvent(c), s.prices).usage?.costUsd ?? 0;
  const before = cost(call);
  const after = cost({ ...call, [field]: (call[field] ?? 0) + by });
  // A 1-hour write moves tokens from one term of the sum to another: allow for rounding.
  const floor = field === "cacheWrite1h" ? before - 1e-12 * Math.max(1, Math.abs(before)) : before;
  assert.ok(after >= floor, `the cost fell from ${before} to ${after} when ${field} rose by ${by}`);
}

/** Token counts no source should send: below 0, or not a finite number. */
const BAD_COUNTS = [-1, -1_000, -1_000_000, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
const COUNT_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const USAGE_KEY = { input: "inputTokens", output: "outputTokens", cacheRead: "cacheReadTokens", cacheWrite: "cacheWriteTokens" } as const;

interface BadCase {
  call: Call;
  /** Counts sent as a bad value. */
  bad: [(typeof COUNT_FIELDS)[number], number][];
}

function badGen(s: Subject): Gen<BadCase> {
  return gen.record<BadCase>({ call: callGen(s), bad: gen.array(gen.tuple(gen.pick(COUNT_FIELDS), gen.pick(BAD_COUNTS)), { minLength: 1, maxLength: 4 }) });
}

function checkBad(s: Subject, { call, bad }: BadCase): void {
  const clean: Call = { ...call };
  const sent: Call = { ...call };
  for (const [f, v] of bad) {
    delete clean[f];
    sent[f] = v;
  }
  const what = bad.map(([f, v]) => `${f} ${v}`).join(", ");
  const e = callEvent(sent);
  const got = s.price(e, s.prices);
  const want = s.price(callEvent(clean), s.prices);
  const cost = want.usage?.costUsd;
  if (cost === undefined) {
    assert.equal(got, e, `a call with no other count was priced at ${got.usage?.costUsd} (${what})`);
    return;
  }
  assert.equal(got.usage?.costUsd, cost, `${what} changed the cost from ${cost} to ${got.usage?.costUsd}`);
  assert.deepEqual(got.payload.costByTokenType, want.payload.costByTokenType, `${what} changed the parts by token type`);
  assert.equal(got.payload.priceTier, want.payload.priceTier, `${what} changed the rates`);
  for (const [f] of bad) assert.ok(Object.is(got.usage?.[USAGE_KEY[f]], sent[f]), `pricing changed the ${f} count it was sent`);
}

// ---------------------------------------------------------------- sessions

/** A call in a session, and how it arrives. */
interface SessionCall {
  call: Call;
  /** Which of four response ids it carries, if any. */
  rid?: number;
  replay: boolean;
  /** A wrapper span over the call with its tokens (a session with spans, a call with no response id that is no replay). */
  wrap: boolean;
  /** The wrapper reports the call's reported cost, else `wrapperCost`. */
  wrapperReports: boolean;
  wrapperCost: number;
}

interface SessionCase {
  calls: SessionCall[];
  /** Usage snapshots, each after the call it names. */
  snapshots: [number, Call][];
  spans: boolean;
  /** The events arrive newest first. */
  reversed: boolean;
}

function sessionGen(s: Subject): Gen<SessionCase> {
  const call = gen.record<SessionCall>({
    call: callGen(s, true),
    rid: gen.frequency([2, gen.constant<number | undefined>(undefined)], [1, gen.int(0, 3)]),
    replay: gen.weighted(0.1),
    wrap: gen.weighted(0.3),
    wrapperReports: gen.weighted(0.3),
    wrapperCost: COST,
  });
  return gen.record<SessionCase>({
    calls: gen.array(call, { minLength: 1, maxLength: 12 }),
    snapshots: gen.array(gen.tuple(gen.int(0, 12), callGen(s, true)), { maxLength: 3 }),
    spans: gen.bool,
    reversed: gen.bool,
  });
}

/** A call as the session counts it: the call, and the wrapper span over it. */
interface Group {
  call: AgentEvent;
  wrapper?: AgentEvent;
}

/** A case's events, priced as ingest prices them: call i at 1000 + 10i, its wrapper 3 ms before it. */
function sessionEvents(s: Subject, c: SessionCase): { events: AgentEvent[]; groups: Group[]; snapshot?: AgentEvent } {
  const events: AgentEvent[] = [];
  const groups: Group[] = [];
  for (const [i, sc] of c.calls.entries()) {
    const call = callEvent(sc.call, `c${i}`, 1000 + 10 * i);
    if (sc.rid !== undefined) call.payload.responseId = `resp_${sc.rid}`;
    if (sc.replay) call.payload.replay = true;
    let wrapper: AgentEvent | undefined;
    if (c.spans) {
      call.traceId = "trace";
      call.spanId = `s${i}`;
      // A reported cost of 0 inside a wrapper is left out.
      if (sc.wrap && sc.rid === undefined && !sc.replay && sc.call.reported !== 0) {
        wrapper = callEvent({ ...sc.call, reported: sc.wrapperReports ? (sc.call.reported ?? sc.wrapperCost) : undefined }, `w${i}`, call.ts - 3);
        wrapper.traceId = "trace";
        wrapper.spanId = `w${i}`;
        call.parentSpanId = wrapper.spanId;
      }
    }
    const group: Group = { call: s.price(call, s.prices) };
    if (wrapper) group.wrapper = s.price(wrapper, s.prices);
    groups.push(group);
    if (group.wrapper) events.push(group.wrapper);
    events.push(group.call);
  }
  const at = new Set<number>();
  let snapshot: AgentEvent | undefined;
  for (const [after, call] of c.snapshots) {
    if (at.has(after)) continue;
    at.add(after);
    const e = s.price({ ...callEvent(call, `u${after}`, 1000 + 10 * after + 5), kind: "notification", payload: { type: "usage-summary" } }, s.prices);
    events.push(e);
    if (!snapshot || e.ts > snapshot.ts) snapshot = e;
  }
  return snapshot ? { events, groups, snapshot } : { events, groups };
}

const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
const tokensOf = (e: AgentEvent): number => TOKEN_KEYS.reduce((a, k) => a + (e.usage?.[k] ?? 0), 0);
const costOf = (e: AgentEvent): number => e.usage?.costUsd ?? 0;
const isEstimate = (e: AgentEvent): boolean => e.payload.costEstimated === true;
const carries = (e: AgentEvent): boolean => tokensOf(e) > 0 || costOf(e) > 0;

/** What a session's usage should be, from its calls in time order and its latest snapshot. */
interface Expected {
  tokens: Record<(typeof TOKEN_KEYS)[number], number>;
  cost: number;
  estimated: number;
  byTier: Record<string, number>;
  leftOut: { calls: number; tokens: number; cost: number };
}

function expected(groups: readonly Group[], snapshot: AgentEvent | undefined): Expected {
  const x: Expected = { tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0, estimated: 0, byTier: {}, leftOut: { calls: 0, tokens: 0, cost: 0 } };
  let all = 0;
  const count = (tokensFrom: AgentEvent, cost: number, estimate: number, tier: unknown): void => {
    for (const k of TOKEN_KEYS) x.tokens[k] += tokensFrom.usage?.[k] ?? 0;
    x.cost += cost;
    x.leftOut.cost -= cost;
    x.estimated += estimate;
    if (estimate > 0 && typeof tier === "string" && tier) x.byTier[tier] = (x.byTier[tier] ?? 0) + estimate;
  };
  const leaveOut = (e: AgentEvent): void => {
    x.leftOut.calls++;
    x.leftOut.tokens += tokensOf(e);
  };
  const seen = new Set<string>();
  for (const { call, wrapper } of groups) {
    if (wrapper && carries(wrapper)) {
      all += costOf(wrapper);
      if (carries(call)) {
        all += costOf(call);
        leaveOut(call);
      }
      const own = wrapper.usage?.costUsd;
      const callReported = carries(call) && !isEstimate(call) && costOf(call) > 0;
      if (own !== undefined && !(isEstimate(wrapper) && callReported)) count(wrapper, own, isEstimate(wrapper) ? own : 0, wrapper.payload.priceTier);
      else count(wrapper, costOf(call), isEstimate(call) ? costOf(call) : 0, call.payload.priceTier);
      continue;
    }
    if (!carries(call)) continue;
    all += costOf(call);
    const rid = typeof call.payload.responseId === "string" && call.payload.responseId ? call.payload.responseId : undefined;
    if (call.payload.replay === true || (rid !== undefined && seen.has(rid))) {
      leaveOut(call);
      continue;
    }
    if (rid !== undefined) seen.add(rid);
    count(call, costOf(call), isEstimate(call) ? costOf(call) : 0, call.payload.priceTier);
  }
  x.leftOut.cost += all;
  if (snapshot) {
    for (const k of TOKEN_KEYS) x.tokens[k] += snapshot.usage?.[k] ?? 0;
    x.cost += costOf(snapshot);
    if (isEstimate(snapshot)) x.estimated += costOf(snapshot);
  }
  return x;
}

function close(got: number, want: number, what: string): void {
  assert.ok(Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want)), `${what}: ${got}, the calls counted add up to ${want}`);
}

function checkSession(s: Subject, c: SessionCase): void {
  const { events, groups, snapshot } = sessionEvents(s, c);
  const stats = s.fold(c.reversed ? [...events].reverse() : events).stats;
  const u = stats.usage ?? {};
  const x = expected(groups, snapshot);
  for (const k of TOKEN_KEYS) assert.equal(u[k] ?? 0, x.tokens[k], `${k}: ${u[k] ?? 0}, the calls counted add up to ${x.tokens[k]}`);
  close(u.costUsd ?? 0, x.cost, "the cost");
  if (x.estimated > 0) {
    const est = Math.min(x.estimated, x.cost);
    close(u.estimatedCostUsd ?? 0, est, "the estimated cost");
    const parts = u.estimatedCostByTokenType;
    assert.ok(parts, "an estimated cost with no split by token type");
    close(TOKEN_TYPES.reduce((a, k) => a + parts[k], 0), est, "the estimate's parts by token type");
  } else assert.equal(u.estimatedCostUsd, undefined, "an estimated cost with no estimate counted");
  const tiers = u.estimatedCostByTier ?? {};
  assert.deepEqual(Object.keys(tiers).sort(), Object.keys(x.byTier).sort(), "the tiers of the estimate");
  for (const [tier, v] of Object.entries(x.byTier)) close(tiers[tier] ?? 0, v, `the estimate at ${tier} rates`);
  const dup = stats.duplicateUsage;
  assert.equal(dup?.calls ?? 0, x.leftOut.calls, "the calls left out");
  assert.equal(dup?.tokens ?? 0, x.leftOut.tokens, "the tokens left out");
  close(dup?.costUsd ?? 0, Math.max(0, x.leftOut.cost), "the cost left out");
}

// ---------------------------------------------------------------- tests

test("every rate in the price table is sound: finite, cache reads at most input, long context at least the rate it replaces", (t) => {
  const checked = checkTable(REAL.prices);
  t.diagnostic(`${REAL.keys.length} models, ${checked} rate sets, thresholds ${thresholdsOf(REAL.prices).join(", ")}`);
});

test("a call's cost is finite, never negative, at most its tokens at the top rate, and its parts add up to it", async (t) => {
  let priced = 0;
  await forAll(
    callGen(REAL, true),
    (c) => {
      checkCall(REAL, c);
      if (c.reported === undefined && tokensOfCall(c) > 0 && resolvePrice(c.model, REAL.prices)) priced++;
    },
    { runs: CALL_RUNS, label: "call cost" },
  );
  t.diagnostic(`${priced} calls priced`);
});

test("a call's cost never falls when one of its token counts rises, across a long-context threshold too", async (t) => {
  let crossed = 0;
  await forAll(
    raiseGen(REAL),
    (r) => {
      checkRaise(REAL, r);
      const prompt = (r.call.input ?? 0) + (r.call.cacheRead ?? 0) + (r.call.cacheWrite ?? 0);
      if (r.field !== "output" && r.field !== "cacheWrite1h" && thresholdsOf(REAL.prices).some((th) => prompt <= th && prompt + r.by > th)) crossed++;
    },
    { runs: CALL_RUNS, label: "cost rises" },
  );
  t.diagnostic(`${crossed} raises crossed a threshold`);
});

test("a token count below 0 or not a finite number bills nothing", async () => {
  await forAll(badGen(REAL), (b) => checkBad(REAL, b), { runs: CALL_RUNS, label: "bad counts" });
});

test("a call whose estimate would not be a finite number gets none", () => {
  const e = callEvent({ model: "claude-opus-5-5", input: Number.MAX_VALUE, output: Number.MAX_VALUE });
  assert.equal(REAL.price(e, REAL.prices), e);
});

test("a session's tokens and cost are the sums over the calls it counts, and what it left out is the duplicate", async (t) => {
  const seen = { calls: 0, leftOut: 0, wrapped: 0, estimated: 0 };
  await forAll(
    sessionGen(REAL),
    (c) => {
      checkSession(REAL, c);
      const { groups } = sessionEvents(REAL, c);
      seen.calls += groups.length;
      seen.wrapped += groups.filter((g) => g.wrapper && carries(g.wrapper) && carries(g.call)).length;
      seen.estimated += groups.filter((g) => isEstimate(g.call)).length;
      seen.leftOut += expected(groups, undefined).leftOut.calls;
    },
    { runs: SESSION_RUNS, label: "session cost" },
  );
  t.diagnostic(`${seen.calls} calls: ${seen.estimated} estimated, ${seen.wrapped} under a wrapper, ${seen.leftOut} left out`);
});

test("each check fails on a mutant of the table, the pricer or the fold", async (t) => {
  const withRow = (key: string, f: (p: Price) => Price): Prices => {
    const p = REAL.prices[key];
    assert.ok(p, `no ${key} row`);
    return { ...REAL.prices, [key]: f(p) };
  };
  const cheapLong = withRow("claude-haiku-5-5", (p) => ({ ...p, longContext: { above: 100_000, input: 0.05, output: 2.5, cacheRead: 0.005, cacheWrite: 0.0625, cacheWrite1h: 0.1 } }));
  const halfHour = withRow("claude-opus-5-5", (p) => ({ ...p, cacheWrite1h: (p.cacheWrite ?? p.input) / 2 }));
  const negative = withRow("gpt-6-luna", (p) => ({ ...p, output: -0.5 }));
  const noThreshold = withRow("gpt-6-sol", (p) => {
    const q = { ...p };
    delete q.longContext;
    return q;
  });
  const tables: [string, Prices, RegExp][] = [
    ["gpt-6-sol cache reads at twice its input rate", withRow("gpt-6-sol", (p) => ({ ...p, cacheRead: p.input * 2 })), /a cache read .* costs more than input/],
    ["claude-haiku-5-5 long-context prompt rates at half the short ones", cheapLong, /long-context input rate .* is below/],
    ["claude-opus-5-5 1-hour writes at half the 5-minute rate", halfHour, /1-hour cache write .* costs less/],
    ["gpt-6-luna output at -0.5", negative, /output is -0.5/],
    ["gpt-6-sol tiers without the model's long-context threshold", noThreshold, /batch: long-context rates with no threshold/],
  ];
  for (const [label, prices, why] of tables) assert.throws(() => checkTable(prices), why, label);

  const only = (key: string, prices: Prices): Subject => ({ ...REAL, prices, keys: [key] });
  const noOutputPart: Subject = {
    ...REAL,
    price: (e, prices) => {
      const out = priceEvent(e, prices);
      const parts = out.payload.costByTokenType as CostByTokenType | undefined;
      return parts && parts.output > 0 ? { ...out, payload: { ...out.payload, costByTokenType: { ...parts, output: 0 } } } : out;
    },
  };
  const sizeOfNegative: Subject = {
    ...REAL,
    price: (e, prices) => {
      const u = e.usage;
      if (!u) return priceEvent(e, prices);
      const abs: Usage = { ...u };
      for (const k of TOKEN_KEYS) {
        const v = u[k];
        if (v !== undefined && Number.isFinite(v)) abs[k] = Math.abs(v);
      }
      const out = priceEvent({ ...e, usage: abs }, prices);
      if (out.usage === abs) return e;
      const usage: Usage = { ...u };
      if (out.usage?.costUsd !== undefined) usage.costUsd = out.usage.costUsd;
      return { ...out, usage };
    },
  };
  const lastCallDropped: Subject = {
    ...REAL,
    fold: (events) => {
      const last = events.filter((e) => e.kind === "llm.call").reduce<AgentEvent | undefined>((a, e) => (!a || e.ts > a.ts ? e : a), undefined);
      return buildSession(events.length > 1 ? events.filter((e) => e !== last) : events);
    },
  };
  const noResponseIds: Subject = {
    ...REAL,
    fold: (events) =>
      buildSession(
        events.map((e) => {
          const payload = { ...e.payload };
          delete payload.responseId;
          return { ...e, payload };
        }),
      ),
  };
  const noParents: Subject = {
    ...REAL,
    fold: (events) =>
      buildSession(
        events.map((e) => {
          const x = { ...e };
          delete x.parentSpanId;
          return x;
        }),
      ),
  };
  const mutants: [string, () => Promise<PropertyFailure>, RegExp][] = [
    ["cost, gpt-6-luna output at -0.5", () => failure(callGen(only("gpt-6-luna", negative)), (c) => checkCall(only("gpt-6-luna", negative), c), "negative"), /the cost is negative/],
    ["parts, a pricer with no output part", () => failure(callGen(noOutputPart), (c) => checkCall(noOutputPart, c), "no output part"), /do not add up to the cost/],
    ["bad counts, a pricer that bills a negative count by its size", () => failure(badGen(sizeOfNegative), (b) => checkBad(sizeOfNegative, b), "size of negative"), /changed the cost|with no other count was priced/],
    ["raise, claude-haiku-5-5 long-context rates below the short ones", () => failure(raiseGen(only("claude-haiku-5-5", cheapLong)), (r) => checkRaise(only("claude-haiku-5-5", cheapLong), r), "cheap long context"), /the cost fell .* when (input|cacheRead|cacheWrite) rose/],
    ["raise, claude-opus-5-5 1-hour writes at half the 5-minute rate", () => failure(raiseGen(only("claude-opus-5-5", halfHour)), (r) => checkRaise(only("claude-opus-5-5", halfHour), r), "cheap 1-hour writes"), /the cost fell .* when cacheWrite1h rose/],
    ["session, a fold that drops the last call", () => failure(sessionGen(lastCallDropped), (c) => checkSession(lastCallDropped, c), "last call dropped"), /add up to|left out/],
    ["session, a fold that ignores response ids", () => failure(sessionGen(noResponseIds), (c) => checkSession(noResponseIds, c), "no response ids"), /add up to/],
    ["session, a fold that ignores parent spans", () => failure(sessionGen(noParents), (c) => checkSession(noParents, c), "no parent spans"), /add up to/],
  ];
  for (const [label, run, why] of mutants) {
    const f = await run();
    assert.match(f.cause instanceof Error ? f.cause.message : String(f.cause), why, label);
    t.diagnostic(`${label}: failed on case ${f.caseIndex + 1}`);
  }
});

/** The PropertyFailure forAll throws; fails when it throws none. */
async function failure<T>(g: Gen<T>, prop: (v: T) => void, label: string): Promise<PropertyFailure> {
  try {
    await forAll(g, prop, { env: {}, runs: MUTANT_RUNS, label });
  } catch (e) {
    if (e instanceof PropertyFailure) return e;
    throw e;
  }
  assert.fail(`${label} passed`);
}
