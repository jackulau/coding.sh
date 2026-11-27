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
// - A token count that is not a whole number from 0 to 2^53 - 1 bills nothing: one below 0, a
//   fraction, or one too large to read exactly. The call costs what it would without it, and a call
//   with no other count gets no estimate. The count is kept as it was sent. An estimate that would
//   not be a finite number is not made. estimateCost and costParts, which reports and evals price
//   usage with, bill such a count as nothing too, and a tool eval (toolevals computeMetrics), which
//   adds up a model's calls before it prices them, costs what it would without it.
// - A session's token counts and cost are the sums over the calls it counts, plus its latest usage
//   snapshot. A call that repeats an earlier call's responseId, or replays one, counts once. A wrapper
//   span over a call with the same tokens counts once, with its own values, except that a cost the
//   nested call reported, 0 included, beats the wrapper's estimate, $0 included. The estimated part
//   is the sum of the estimates counted, and its splits by token type and by tier add up to it. What
//   was left out is the duplicate count, tokens and cost.
// - A run of responses recorded on several paths counts each response's tokens once and each bill
//   once, whatever order its calls arrive in. A path records some of the run, as top-level calls or
//   as steps nested in a call a gateway billed that has no usage of its own. That wrapper may carry
//   the run's last response id. A response may be recorded again on a path: beside the steps, under
//   another billed call nested in the wrapper, or at the top level. Each of these calls carries an
//   estimate, and a gateway may bill it for its response's generation. Or a path's wrapper carries the
//   last response's tokens and id, with an estimate, a cost it reported or no cost, over one call of
//   that response, and a gateway may bill the wrapper or a call nested in it. The cost is each
//   generation's bill once, each bill with no generation id, and for each response no bill covers, the
//   cost of the first of its records to arrive: its estimate, or the cost a wrapper reported. A bill
//   below a wrapper replaces the wrapper's cost. The tokens and cost not counted are left out, and the
//   two costs add up to every cost the events carry.
//
// Calls are drawn over every model in the built-in table, with provider prefixes, dated and variant
// suffixes, family fallbacks and an unknown model; prompts near each long-context threshold; and the
// service tiers, speeds and geographies adapters record. A session's calls are drawn over a
// `[prices]` row of 0 too, so a wrapper's estimate can be $0. A session draws no gateway companions:
// they carry what a gateway billed minus the call's own cost, which can be negative. A run draws bills
// no lower than its estimates or the costs a wrapper reported, so no companion carries a negative
// cost. A copy that does not count takes the calls nested in it with it, bills included, so a
// wrapper with usage of its own, and the calls nested in it, are billed only for the last
// response's generation. Other shapes of billed calls are covered in test/core/sessions.test.ts.
//
// The last test shows each check fails on a mutant of the table, the pricer, the estimate or the fold.
// CODING_SH_PROP_RUNS=n runs n cases per test (default 200 per call, 100 per session);
// CODING_SH_PROP_SEED=s replays one. The last test reads neither.
import assert from "node:assert/strict";
import { test } from "node:test";
import { costParts, estimateCost, priceEvent, pricesFor, PRICE_TIERS, resolvePrice, splitOf, TOKEN_TYPES, type Price, type Prices, type Rates } from "../../src/core/pricing.ts";
import { buildSession } from "../../src/core/sessions.ts";
import type { AgentRunOutput } from "../../src/core/types.ts";
import type { AgentEvent, CostByTokenType, Session, Usage } from "../../src/schema/index.ts";
import { computeMetrics } from "../../src/toolevals/metrics.ts";
import { forAll, gen, PropertyFailure, type Gen } from "../_prop.ts";
import { cliTarget, task } from "../toolevals/helpers.ts";

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
  /** A key drawn often, whose row prices every call at $0. */
  free?: string;
}

const REAL: Subject = { prices: pricesFor(), price: priceEvent, fold: (events) => buildSession(events), keys: Object.keys(pricesFor()) };
/** The real table plus a `[prices]` row of 0, as a config sets for a free or self-hosted model. */
const SESSION: Subject = { ...REAL, prices: { ...REAL.prices, "free-model": { input: 0, output: 0 } }, keys: [...REAL.keys, "free-model"], free: "free-model" };

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

/** A model name: a table key, the same with a prefix or a suffix, a name with no row of its own, or `free`, drawn often. */
function modelGen(keys: readonly string[], free?: string): Gen<string> {
  const often = free ? [[3, gen.constant(free)] as const] : [];
  return gen.frequency(
    [8, gen.pick(keys)],
    [1, gen.map(gen.pick(keys), (k) => `openai/${k}`)],
    [1, gen.map(gen.pick(keys), (k) => `${k}-20260101`)],
    [1, gen.map(gen.pick(keys), (k) => `${k.toUpperCase()}-thinking`)],
    [1, gen.pick(ODD_MODELS)],
    ...often,
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
        model: modelGen(s.keys, s.free),
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

/**
 * Token counts no source should send: below 0, a fraction, one too large to read exactly (2^53 and
 * up: 2^53 + 1 reads as 2^53), or not a finite number.
 */
const BAD_COUNTS = [-1, -1_000, -1_000_000, -0.5, 0.5, 12.5, 2 ** 53, 2 ** 53 + 2, 1e20, Number.MAX_VALUE, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
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

/** The call as sent, with its bad counts, and as it should bill: without them. */
function sentAndClean({ call, bad }: BadCase): { sent: Call; clean: Call; what: string } {
  const clean: Call = { ...call };
  const sent: Call = { ...call };
  for (const [f, v] of bad) {
    delete clean[f];
    sent[f] = v;
  }
  return { sent, clean, what: bad.map(([f, v]) => `${f} ${v}`).join(", ") };
}

function checkBad(s: Subject, b: BadCase): void {
  const { sent, clean, what } = sentAndClean(b);
  const { bad } = b;
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

/** What reports and evals price a usage record with (estimateCost and costParts), or a mutant of it. */
interface Estimator {
  estimate: (u: Usage, model: string, prices: Prices) => number | undefined;
  parts: (u: Usage, p: Rates, cacheWrite1h?: number) => CostByTokenType;
}

const ESTIMATOR: Estimator = { estimate: estimateCost, parts: costParts };

function checkBadEstimate(x: Estimator, b: BadCase): void {
  const { sent, clean, what } = sentAndClean(b);
  const u = callEvent(sent).usage ?? {};
  const want = callEvent(clean).usage ?? {};
  const cost = x.estimate(u, b.call.model, REAL.prices);
  const wantCost = x.estimate(want, b.call.model, REAL.prices);
  assert.ok(cost === undefined || (Number.isFinite(cost) && cost >= 0), `estimateCost is ${cost} (${what})`);
  assert.equal(cost, wantCost, `${what} changed estimateCost from ${wantCost} to ${cost}`);
  const found = resolvePrice(b.call.model, REAL.prices);
  if (found) assert.deepEqual(x.parts(u, found.price, b.call.cacheWrite1h), x.parts(want, found.price, b.call.cacheWrite1h), `${what} changed costParts`);
}

/** A tool eval's calls, all on one model, so their counts are added up before they are priced. Some have bad counts. */
function evalGen(s: Subject): Gen<BadCase[]> {
  const one = gen.record<BadCase>({ call: callGen(s), bad: gen.array(gen.tuple(gen.pick(COUNT_FIELDS), gen.pick(BAD_COUNTS)), { minLength: 0, maxLength: 3 }) });
  return gen.chain(modelGen(s.keys), (model) => gen.array(gen.map(one, (b): BadCase => ({ ...b, call: { ...b.call, model } })), { minLength: 1, maxLength: 5 }));
}

const RUN: AgentRunOutput = { exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "", stderrTail: "" };

interface EvalCost {
  cost: number | null;
  flat: number | null;
}

/** The cost a tool eval reports for these calls (toolevals computeMetrics), and at flat rates; null when it prices none. */
function evalCost(calls: Call[]): EvalCost {
  const events = calls.map((c, i) => callEvent(c, `c${i}`, i + 1));
  const m = computeMetrics({ task: task(), target: cliTarget(), tap: [], events, sessions: [], run: RUN, checksPass: true, prices: REAL.prices });
  return { cost: m.costUsd, flat: m.flatCostUsd ?? null };
}

function checkBadEval(cost: (calls: Call[]) => EvalCost, cases: BadCase[]): void {
  const split = cases.map(sentAndClean);
  const got = cost(split.map((x) => x.sent));
  const want = cost(split.map((x) => x.clean));
  const what = split.map((x) => x.what).filter(Boolean).join("; ") || "no bad count";
  for (const v of [got.cost, got.flat]) assert.ok(v === null || (Number.isFinite(v) && v >= 0), `the eval's cost is ${v} (${what})`);
  assert.deepEqual(got, want, `${what} changed the eval's cost from ${JSON.stringify(want)} to ${JSON.stringify(got)}`);
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
      if (sc.wrap && sc.rid === undefined && !sc.replay) {
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
      const callReported = carries(call) && call.usage?.costUsd !== undefined && !isEstimate(call);
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

// ---------------------------------------------------------------- a run recorded more than once

/** A response: its tokens, the estimate on each call that records it, and the bill for its generation. */
interface RunResponse {
  input: number;
  output: number;
  /** The estimate, in thousandths of a dollar. */
  estimate: number;
  /** What a gateway billed for the response's generation over the estimate, in thousandths of a dollar. */
  over: number;
}

/** A call that records a response. */
interface RunRecord {
  /** A gateway billed it for its response's generation. */
  billed: boolean;
  /** It has no response id: its bill alone names its response. Only a billed call of a response other than the last has none. */
  bare: boolean;
}

/** A response recorded a second time on a path. */
interface RunCopy extends RunRecord {
  /** The response, modulo the run's length. */
  of: number;
  /** Beside the steps in the wrapper, under another billed call nested in the wrapper, or as a top-level call. */
  at: "beside" | "under" | "top";
  /** The bill of the call the copy is under, in thousandths of a dollar: with no generation id, or for a generation of its own. */
  middle: number;
  middlePlain: boolean;
  /** That call is billed for the last response's generation too: a copy of the wrapper's bill when the wrapper has it. */
  middleLast: boolean;
}

/** A wrapper that carries usage of its own: the last response's tokens and response id. */
interface RunOwn {
  /** Its cost: the response's estimate, one the agent reported, or none. */
  cost: "estimate" | "reported" | "none";
  /** The cost it reported, in thousandths of a dollar, up to the response's bill. */
  reported: number;
  /** A gateway billed it for the last response's generation. */
  billed: boolean;
}

/** How a path records the run. */
interface RunPath {
  /** The responses it misses, as bits: it records the rest, or all of them when that leaves none. */
  missed: number;
  /** As steps nested in a call a gateway billed that has no usage of its own, else as top-level calls. */
  wrapped: boolean;
  /** The wrapper carries the run's last response id, as a gateway's generation id is on a wrapper and on its last step. */
  wrapperId: boolean;
  /** The wrapper's bill with no generation id, in thousandths of a dollar. With none, it is billed for the last response's generation. */
  plain?: number;
  /** The call of each response on the path. */
  steps: RunRecord[];
  copy?: RunCopy;
  /**
   * The wrapper carries usage of its own instead. The path then records the last response alone, as one call nested in
   * the wrapper: its step, or for a copy "under", a copy under another call billed for its generation. A copy "top" is
   * recorded too, and one "beside" is not.
   */
  own?: RunOwn;
}

interface RunCase {
  responses: RunResponse[];
  paths: RunPath[];
  /** A sort key for each event, in the order they are made: the events arrive in key order. */
  keys: number[];
}

/** Up to 4 responses on 3 paths of at most 15 events each. */
const RUN_KEYS = 45;

const runRecord = { billed: gen.weighted(0.4), bare: gen.weighted(0.3) };

const runGen: Gen<RunCase> = gen.record<RunCase>({
  responses: gen.array(gen.record<RunResponse>({ input: gen.int(1, 1000), output: gen.int(0, 1000), estimate: gen.int(1, 100), over: gen.int(0, 3000) }), { minLength: 1, maxLength: 4 }),
  paths: gen.array(
    gen.record<RunPath>({
      missed: gen.frequency([1, gen.constant(0)], [1, gen.int(1, 15)]),
      wrapped: gen.weighted(0.7),
      wrapperId: gen.weighted(0.6),
      plain: gen.frequency([1, gen.constant<number | undefined>(undefined)], [1, gen.int(1, 3000)]),
      steps: gen.array(gen.record<RunRecord>(runRecord), { minLength: 4, maxLength: 4 }),
      copy: gen.frequency(
        [1, gen.constant<RunCopy | undefined>(undefined)],
        [3, gen.record<RunCopy>({ ...runRecord, of: gen.int(0, 3), at: gen.pick(["beside", "under", "top"] as const), middle: gen.int(1, 3000), middlePlain: gen.bool, middleLast: gen.bool })],
      ),
      own: gen.frequency(
        [3, gen.constant<RunOwn | undefined>(undefined)],
        [2, gen.record<RunOwn>({ cost: gen.pick(["estimate", "reported", "none"] as const), reported: gen.int(0, 3000), billed: gen.weighted(0.3) })],
      ),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  keys: gen.array(gen.int(0, 1000), { minLength: RUN_KEYS, maxLength: RUN_KEYS }),
});

/** What a run's calls and bills count. */
interface RunExpected {
  /** How each response's records rank: 2 billed or over a billed call, 1 covered by a bill above them, 0 none of these. */
  ranks: number[][];
  /** Each response's records that rank 0, with the cost each counts when it is the first of them to arrive. */
  unbilled: { call: string; cost: number; estimated: boolean }[][];
  /** Each generation's bill, by id. */
  gens: Map<string, number>;
  /** Each bill with no generation id. */
  plain: number[];
}

/** A run case's events in the order they arrive, 10 ms apart, and what they count. */
function runEvents(c: RunCase): RunExpected & { events: AgentEvent[] } {
  const made: AgentEvent[] = [];
  const event = (id: string, kind: AgentEvent["kind"], o: Partial<AgentEvent>): void => {
    made.push({ id, v: 0, sessionId: "s", ts: 0, agent: "claude-code", kind, payload: {}, ...o });
  };
  const usd = (thousandths: number): number => thousandths / 1000;
  const last = c.responses.length - 1;
  const billFor = (i: number): number => usd(c.responses[i]!.estimate + c.responses[i]!.over);
  const x: RunExpected = { ranks: c.responses.map(() => []), unbilled: c.responses.map(() => []), gens: new Map(), plain: [] };
  // A gateway companion: what it billed a call, for a generation or with no generation id, less the call's own cost.
  const bill = (call: string, own: number, amount: number, generationId?: string): void => {
    const payload: Record<string, unknown> = { gateway: "vercel", billedCostUsd: amount };
    if (generationId) {
      payload.generationId = generationId;
      x.gens.set(generationId, amount);
    } else x.plain.push(amount);
    const companion: Partial<AgentEvent> = { source: "gateway", parentId: call, payload };
    const delta = Math.round((amount - own) * 1e10) / 1e10;
    if (delta) companion.usage = { costUsd: delta };
    event(`${call}-${generationId ?? "bill"}`, "span", companion);
  };
  // A call of response i with its estimate, top-level or at a span, and its bill.
  const call = (id: string, i: number, r: RunRecord, at: Partial<AgentEvent> = {}): void => {
    const { input, output, estimate } = c.responses[i]!;
    const payload: Record<string, unknown> = { costEstimated: true };
    if (!r.billed || !r.bare || i === last) payload.responseId = `resp_${i}`;
    event(id, "llm.call", { usage: { inputTokens: input, outputTokens: output, costUsd: usd(estimate) }, payload, ...at });
    if (r.billed) bill(id, usd(estimate), billFor(i), `resp_${i}`);
  };
  // A record of response i, by the call that holds it, and the cost it counts when it ranks 0 and arrives first.
  const note = (i: number, rank: number, id: string, cost: number, estimated: boolean): void => {
    x.ranks[i]!.push(rank);
    if (!rank) x.unbilled[i]!.push({ call: id, cost, estimated });
  };
  // A call of response i that records it once: covered when a bill above it covers it.
  const record = (id: string, i: number, r: RunRecord, covered: boolean, at: Partial<AgentEvent> = {}): void => {
    call(id, i, r, at);
    note(i, r.billed ? 2 : covered ? 1 : 0, id, usd(c.responses[i]!.estimate), true);
  };
  for (const [p, path] of c.paths.entries()) {
    const kept = [...c.responses.keys()].filter((i) => !(path.missed & (1 << i)));
    const steps = kept.length ? kept : [...c.responses.keys()];
    if (!path.wrapped) {
      for (const i of steps) record(`p${p}s${i}`, i, path.steps[i]!, false);
      continue;
    }
    const traceId = `trace${p}`;
    const copy = path.copy;
    const of = copy ? copy.of % c.responses.length : 0;
    if (path.own) {
      // A wrapper over one call of the last response, with its tokens and response id: one record of it. The calls nested
      // in it are not checked for copies. A bill on it or below it ranks it with a billed call and replaces its own cost,
      // estimated or reported. With none, it counts the estimate, the cost it reported, or with no cost its step's estimate.
      const { input, output, estimate, over } = c.responses[last]!;
      const reported = usd(Math.min(path.own.reported, estimate + over));
      const cost = path.own.cost === "estimate" ? usd(estimate) : path.own.cost === "reported" ? reported : undefined;
      const payload: Record<string, unknown> = { responseId: `resp_${last}` };
      if (path.own.cost === "estimate") payload.costEstimated = true;
      event(`p${p}`, "llm.call", { traceId, spanId: "w", usage: cost === undefined ? { inputTokens: input, outputTokens: output } : { inputTokens: input, outputTokens: output, costUsd: cost }, payload });
      if (path.own.billed) bill(`p${p}`, cost ?? 0, billFor(last), `resp_${last}`);
      let below = true;
      if (copy?.at === "under") {
        event(`p${p}m`, "llm.call", { traceId, spanId: "m", parentSpanId: "w" });
        bill(`p${p}m`, 0, billFor(last), `resp_${last}`);
        call(`p${p}copy`, last, copy, { traceId, spanId: "copy", parentSpanId: "m" });
      } else {
        call(`p${p}s${last}`, last, path.steps[last]!, { traceId, spanId: `s${last}`, parentSpanId: "w" });
        below = path.steps[last]!.billed;
      }
      note(last, path.own.billed || below ? 2 : 0, `p${p}`, path.own.cost === "reported" ? reported : usd(estimate), path.own.cost !== "reported");
      if (copy?.at === "top") record(`p${p}copy`, of, copy, false);
      continue;
    }
    // The wrapper's bill covers the calls nested in it, unless one of them carries its generation: then it covers that
    // call, and the others keep their costs. A bill with no generation id covers them all.
    const carried = path.plain === undefined && (steps.includes(last) || (copy !== undefined && copy.at !== "top" && (of === last || (copy.at === "under" && copy.middleLast))));
    const covered = (i: number): boolean => !carried || i === last;
    event(`p${p}`, "llm.call", { traceId, spanId: "w", payload: path.wrapperId ? { responseId: `resp_${last}` } : {} });
    if (path.plain === undefined) bill(`p${p}`, 0, billFor(last), `resp_${last}`);
    else bill(`p${p}`, 0, usd(path.plain));
    for (const i of steps) record(`p${p}s${i}`, i, path.steps[i]!, covered(i), { traceId, spanId: `s${i}`, parentSpanId: "w" });
    if (!copy) continue;
    if (copy.at === "top") record(`p${p}copy`, of, copy, false);
    else if (copy.at === "beside") record(`p${p}copy`, of, copy, covered(of), { traceId, spanId: "copy", parentSpanId: "w" });
    else {
      // The call the copy is under covers it: no call nested in it carries the generation of its own bill, and its bill for
      // the last response's generation is the copy's own when the copy is of the last response.
      event(`p${p}m`, "llm.call", { traceId, spanId: "m", parentSpanId: "w" });
      bill(`p${p}m`, 0, usd(copy.middle), copy.middlePlain ? undefined : `gen_p${p}m`);
      if (copy.middleLast) bill(`p${p}m`, 0, billFor(last), `resp_${last}`);
      record(`p${p}copy`, of, copy, true, { traceId, spanId: "copy", parentSpanId: "m" });
    }
  }
  const order = made.map((e, i) => ({ e, key: c.keys[i] ?? 0, i })).sort((a, b) => a.key - b.key || a.i - b.i);
  return { ...x, events: order.map(({ e }, rank) => ({ ...e, ts: 1000 + 10 * rank })) };
}

function checkRun(s: Subject, c: RunCase): void {
  const { events, ranks, unbilled, gens, plain } = runEvents(c);
  const stats = s.fold(events).stats;
  const u = stats.usage ?? {};
  const want: Record<(typeof TOKEN_KEYS)[number], number> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  // Each response recorded once, each bill once, and for each response no bill covers, the cost of the first of its
  // records to arrive: none of them was billed or is over a billed call, and no bill above one of them covers it.
  const arrived = new Map(events.map((e, n) => [e.id, n]));
  let own = 0;
  let estimated = 0;
  for (const [i, r] of c.responses.entries()) {
    const rank = Math.max(-1, ...ranks[i]!);
    if (rank < 0) continue;
    want.inputTokens += r.input;
    want.outputTokens += r.output;
    if (rank > 0) continue;
    const first = unbilled[i]!.reduce((a, b) => (arrived.get(b.call)! < arrived.get(a.call)! ? b : a));
    own += first.cost;
    if (first.estimated) estimated += first.cost;
  }
  const cost = [...gens.values(), ...plain].reduce((a, b) => a + b, own);
  const near = (got: number, want: number): boolean => Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));
  const arrival = events.map((e) => e.id).join(" ");
  for (const k of TOKEN_KEYS) assert.equal(u[k] ?? 0, want[k], `${k}: ${u[k] ?? 0}, the responses add up to ${want[k]} (in order: ${arrival})`);
  assert.ok(near(u.costUsd ?? 0, cost), `the cost: ${u.costUsd ?? 0}, the bills and the costs no bill covers add up to ${cost} (in order: ${arrival})`);
  assert.ok(near(u.estimatedCostUsd ?? 0, estimated), `the estimated cost: ${u.estimatedCostUsd ?? 0}, the estimates no bill covers add up to ${estimated} (in order: ${arrival})`);
  const all = events.reduce((a, e) => a + (e.kind === "llm.call" ? tokensOf(e) : 0), 0);
  assert.equal(stats.duplicateUsage?.tokens ?? 0, all - want.inputTokens - want.outputTokens, `the tokens left out (in order: ${arrival})`);
  // What was counted and what was left out is every cost the events carry: the bills are no lower than the estimates.
  const carried = events.reduce((a, e) => a + costOf(e), 0);
  const both = (u.costUsd ?? 0) + (stats.duplicateUsage?.costUsd ?? 0);
  assert.ok(near(both, carried), `the cost counted and left out: ${both}, the events carry ${carried} (in order: ${arrival})`);
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

test("a token count that is not a whole number from 0 to 2^53 - 1 bills nothing", async () => {
  await forAll(badGen(REAL), (b) => checkBad(REAL, b), { runs: CALL_RUNS, label: "bad counts" });
});

test("estimateCost and costParts, which reports and evals price usage with, bill a bad token count as nothing too", async () => {
  await forAll(badGen(REAL), (b) => checkBadEstimate(ESTIMATOR, b), { runs: CALL_RUNS, label: "bad counts, estimateCost" });
});

test("a tool eval's cost bills a bad token count as nothing, and takes nothing off another call's", async (t) => {
  let priced = 0;
  await forAll(
    evalGen(REAL),
    (cases) => {
      checkBadEval(evalCost, cases);
      if (evalCost(cases.map((b) => b.call)).cost !== null) priced++;
    },
    { runs: SESSION_RUNS, label: "bad counts, tool eval" },
  );
  t.diagnostic(`${priced} evals priced`);
});

test("a call whose estimate would not be a finite number gets none", () => {
  // The largest counts that bill, at a rate no table has: the estimate overflows.
  const prices: Prices = { ...REAL.prices, "huge-model": { input: Number.MAX_VALUE, output: Number.MAX_VALUE } };
  const e = callEvent({ model: "huge-model", input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER });
  assert.equal(REAL.price(e, prices), e);
});

test("a session's tokens and cost are the sums over the calls it counts, and what it left out is the duplicate", async (t) => {
  const seen = { calls: 0, leftOut: 0, wrapped: 0, free: 0, estimated: 0 };
  await forAll(
    sessionGen(SESSION),
    (c) => {
      checkSession(SESSION, c);
      const { groups } = sessionEvents(SESSION, c);
      seen.calls += groups.length;
      seen.wrapped += groups.filter((g) => g.wrapper && carries(g.wrapper) && carries(g.call)).length;
      seen.free += groups.filter((g) => g.wrapper && isEstimate(g.wrapper) && costOf(g.wrapper) === 0 && carries(g.wrapper) && costOf(g.call) > 0 && !isEstimate(g.call)).length;
      seen.estimated += groups.filter((g) => isEstimate(g.call)).length;
      seen.leftOut += expected(groups, undefined).leftOut.calls;
    },
    { runs: SESSION_RUNS, label: "session cost" },
  );
  t.diagnostic(`${seen.calls} calls: ${seen.estimated} estimated, ${seen.wrapped} under a wrapper (${seen.free} with a cost reported under an estimate of $0), ${seen.leftOut} left out`);
});

test("a run of responses recorded on several paths counts each response's tokens once and each bill once, whatever order its calls arrive in", async (t) => {
  const seen = { paths: 0, partial: 0, wrapped: 0, named: 0, plain: 0, own: 0, reported: 0, below: 0, beside: 0, under: 0, top: 0, calls: 0, billed: 0, covered: 0 };
  await forAll(
    runGen,
    (c) => {
      checkRun(REAL, c);
      const wrapped = c.paths.filter((p) => p.wrapped);
      const own = wrapped.filter((p) => p.own);
      const others = c.paths.filter((p) => !p.wrapped || !p.own);
      seen.paths += c.paths.length;
      seen.partial += others.filter((p) => [...c.responses.keys()].some((i) => p.missed & (1 << i)) && [...c.responses.keys()].some((i) => !(p.missed & (1 << i)))).length;
      seen.wrapped += wrapped.length;
      seen.named += wrapped.filter((p) => !p.own && p.wrapperId).length;
      seen.plain += wrapped.filter((p) => !p.own && p.plain !== undefined).length;
      seen.own += own.length;
      seen.reported += own.filter((p) => p.own!.cost === "reported").length;
      seen.below += own.filter((p) => !p.own!.billed && (p.copy?.at === "under" || p.steps[c.responses.length - 1]!.billed)).length;
      for (const at of ["beside", "under", "top"] as const) seen[at] += wrapped.filter((p) => p.copy?.at === at && !(at === "beside" && p.own)).length;
      const ranks = runEvents(c).ranks.flat();
      seen.calls += ranks.length;
      seen.billed += ranks.filter((r) => r === 2).length;
      seen.covered += ranks.filter((r) => r === 1).length;
    },
    { runs: SESSION_RUNS, label: "runs" },
  );
  t.diagnostic(
    `${seen.paths} paths, ${seen.partial} missing some responses: ${seen.wrapped} wrapped (${seen.named} with the last response id, ${seen.plain} billed with no generation id, ${seen.own} by a call with usage of its own: ${seen.reported} with a cost it reported, ${seen.below} with a bill below it and none on it), with a response recorded again beside the steps ${seen.beside} times, under another billed call ${seen.under} and at the top level ${seen.top}; ${seen.calls} records: ${seen.billed} billed or over a billed call, ${seen.covered} covered by a bill above them`,
  );
});

test("each check fails on a mutant of the table, the pricer, the estimate or the fold", async (t) => {
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
  // costFrom as it was before it dropped a bad count: a negative count takes off its size, NaN spreads.
  const unclamped: Estimator = {
    ...ESTIMATOR,
    estimate: (u, model, prices) => {
      const p = prices[model];
      if (!p) return undefined;
      return ((u.inputTokens ?? 0) * p.input + (u.outputTokens ?? 0) * p.output + (u.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input) + (u.cacheWriteTokens ?? 0) * (p.cacheWrite ?? p.input)) / 1e6;
    },
  };
  // costParts as it was before: the same.
  const unclampedParts: Estimator = {
    ...ESTIMATOR,
    parts: (u, p) => ({
      cacheRead: ((u.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input)) / 1e6,
      cacheWrite: ((u.cacheWriteTokens ?? 0) * (p.cacheWrite ?? p.input)) / 1e6,
      input: ((u.inputTokens ?? 0) * p.input) / 1e6,
      output: ((u.outputTokens ?? 0) * p.output) / 1e6,
    }),
  };
  // A tool eval as it was before: each model's finite counts added up as sent, then priced.
  const rawSums = (calls: Call[]): EvalCost => {
    const sums = new Map<string, Call>();
    for (const c of calls) {
      const sum = sums.get(c.model) ?? { model: c.model };
      for (const f of COUNT_FIELDS) {
        const v = c[f];
        if (v !== undefined && Number.isFinite(v)) sum[f] = (sum[f] ?? 0) + v;
      }
      sums.set(c.model, sum);
    }
    return evalCost([...sums.values()]);
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
  // Bills with no generation ids: each counts, also when two bill one generation.
  const noGenerationIds: Subject = {
    ...REAL,
    fold: (events) =>
      buildSession(
        events.map((e) => {
          if (e.source !== "gateway") return e;
          const payload = { ...e.payload };
          delete payload.generationId;
          return { ...e, payload };
        }),
      ),
  };
  const noBills: Subject = { ...REAL, fold: (events) => buildSession(events.filter((e) => e.source !== "gateway")) };
  // The fold as it was before: a wrapper's estimate of $0 beat the cost a nested call reported, as a $0 the wrapper reported does.
  const zeroEstimateKept: Subject = {
    ...SESSION,
    fold: (events) =>
      buildSession(
        events.map((e) => {
          if (e.payload.costEstimated !== true || e.usage?.costUsd !== 0) return e;
          const payload = { ...e.payload };
          delete payload.costEstimated;
          return { ...e, payload };
        }),
      ),
  };
  const mutants: [string, () => Promise<PropertyFailure>, RegExp][] = [
    ["cost, gpt-6-luna output at -0.5", () => failure(callGen(only("gpt-6-luna", negative)), (c) => checkCall(only("gpt-6-luna", negative), c), "negative"), /the cost is negative/],
    ["parts, a pricer with no output part", () => failure(callGen(noOutputPart), (c) => checkCall(noOutputPart, c), "no output part"), /do not add up to the cost/],
    ["bad counts, a pricer that bills a negative count by its size", () => failure(badGen(sizeOfNegative), (b) => checkBad(sizeOfNegative, b), "size of negative"), /changed the cost|with no other count was priced/],
    ["bad counts, estimateCost that bills them as sent", () => failure(badGen(REAL), (b) => checkBadEstimate(unclamped, b), "unclamped estimate"), /estimateCost is|changed estimateCost/],
    ["bad counts, costParts that bills them as sent", () => failure(badGen(REAL), (b) => checkBadEstimate(unclampedParts, b), "unclamped parts"), /changed costParts/],
    ["bad counts, a tool eval that adds them up before it prices", () => failure(evalGen(REAL), (cases) => checkBadEval(rawSums, cases), "raw sums"), /changed the eval's cost/],
    ["raise, claude-haiku-5-5 long-context rates below the short ones", () => failure(raiseGen(only("claude-haiku-5-5", cheapLong)), (r) => checkRaise(only("claude-haiku-5-5", cheapLong), r), "cheap long context"), /the cost fell .* when (input|cacheRead|cacheWrite) rose/],
    ["raise, claude-opus-5-5 1-hour writes at half the 5-minute rate", () => failure(raiseGen(only("claude-opus-5-5", halfHour)), (r) => checkRaise(only("claude-opus-5-5", halfHour), r), "cheap 1-hour writes"), /the cost fell .* when cacheWrite1h rose/],
    ["session, a fold that drops the last call", () => failure(sessionGen(lastCallDropped), (c) => checkSession(lastCallDropped, c), "last call dropped"), /add up to|left out/],
    ["session, a fold that ignores response ids", () => failure(sessionGen(noResponseIds), (c) => checkSession(noResponseIds, c), "no response ids"), /add up to/],
    ["runs, a fold that ignores response ids", () => failure(runGen, (c) => checkRun(noResponseIds, c), "runs with no response ids"), /add up to/],
    ["runs, a fold that ignores generation ids", () => failure(runGen, (c) => checkRun(noGenerationIds, c), "runs with no generation ids"), /add up to/],
    ["runs, a fold with no gateway bills", () => failure(runGen, (c) => checkRun(noBills, c), "runs with no bills"), /add up to/],
    ["session, a fold that ignores parent spans", () => failure(sessionGen(noParents), (c) => checkSession(noParents, c), "no parent spans"), /add up to/],
    ["session, a fold where a wrapper's estimate of $0 beats a nested call's reported cost", () => failure(sessionGen(zeroEstimateKept), (c) => checkSession(zeroEstimateKept, c), "zero estimate kept"), /add up to/],
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
