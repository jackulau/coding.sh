// The monitor runner: after an ingest pass, each due monitor scores the
// sessions that ended after its cursor and match its --where query, one score
// per session (source "monitor", name = the monitor's name). A --run monitor
// pipes the session JSON to a command; a --judge monitor asks the LLM judge
// with its rubric and stops for the day at its spend limit. Nothing here throws
// to the caller for a monitor's own failure: it is logged and recorded in
// monitors.json, so an ingest never fails because of a monitor.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AgentEvent, Config, IndexStore, Session, SessionFilter } from "../core/types.ts";
import { supervise } from "../core/children.ts";
import { acquireLock, LockBusyError } from "../core/lock.ts";
import { createRedactor, type Redactor } from "../core/redact.ts";
import type { ChatProvider } from "../judge/providers.ts";
import { findSessions } from "../query/run.ts";
import { parseWhere, scopesSubagents, type Query } from "../query/where.ts";
import { addScore, ScoreError } from "../scores/scores.ts";
import { localDay, readMonitors, runLockPath, spentToday, updateMonitors, type MonitorDef, type MonitorError } from "./state.ts";

const DAY = 86_400_000;
/** How long a --run command may take for one session. */
export const MONITOR_TIMEOUT_MS = 60_000;
/** Automatic runs (ingest loops) wait this long between passes of one monitor. */
export const MONITOR_INTERVAL_MS = 60_000;
/** Sessions one automatic pass of one monitor handles; the rest wait for the next pass. */
const MAX_PER_PASS = 100;
/** Sessions are found among those that started up to this long before the window. */
const LOOKBACK_MS = 7 * DAY;
const SCAN_LIMIT = 5000;
const MAX_STDOUT = 1024 * 1024;
/** Rates for a judge reply whose model has no price entry, USD per token (input, output). */
const FALLBACK_RATES = { input: 3 / 1e6, output: 15 / 1e6 };

export const NO_PROVIDER = "no judge provider";

export interface MonitorDeps {
  index: IndexStore;
  env: NodeJS.ProcessEnv;
  config: Config;
  /** paths(env).monitors and paths(env).judgeCache. */
  paths: { monitors: string; judgeCache: string };
}

export interface RunMonitorsOptions {
  /** Only these monitors. Default: all. */
  names?: string[];
  /** Score sessions that ended after this time, instead of after each cursor. */
  since?: number;
  /** Run monitors that ran less than a minute ago too (`coding.sh ingest`, `monitor run`). */
  force?: boolean;
  /** Handle every candidate, not the first 100 (`monitor run`). */
  all?: boolean;
  now?: () => number;
  signal?: AbortSignal;
  /** The judge's model (tests). Default: the monitor's provider, or the one an API key in the environment names. */
  provider?: ChatProvider;
  /** Wraps each score write (serve's writer lane). */
  write?: <T>(fn: () => Promise<T>) => Promise<T>;
  log?: (message: string) => void;
  /** --run timeout (tests). */
  timeoutMs?: number;
}

export interface MonitorResult {
  name: string;
  scored: number;
  /** Already scored by this monitor, or nothing to judge. */
  skipped: number;
  sampledOut: number;
  failed: number;
  /** The last error of this pass. */
  error?: string;
  /** Why the pass stopped before the end: the day's spend limit or no judge provider. */
  stopped?: "budget" | "no-provider";
}

export interface RunMonitorsResult {
  /** False when there are no monitors, or another process is running them. */
  ran: boolean;
  busy?: boolean;
  monitors: MonitorResult[];
  /** monitors.json could not be read. */
  error?: string;
}

/** True when there is a monitors.json with at least one monitor (cheap: one stat, one read). */
export function hasMonitors(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    return readMonitors(file).monitors.length > 0;
  } catch {
    return true;
  }
}

/** A session id mapped to [0, 1): the same id always gets the same number. */
export function sampleKey(sessionId: string): number {
  return parseInt(createHash("sha256").update(sessionId).digest("hex").slice(0, 8), 16) / 2 ** 32;
}

/** What a score from this monitor records as its version: a hash of the rubric text or the command. */
export function monitorVersion(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** Runs the due monitors once. Never throws for a monitor's failure; throws only for a broken monitors.json. */
export async function runMonitors(deps: MonitorDeps, o: RunMonitorsOptions = {}): Promise<RunMonitorsResult> {
  const file = deps.paths.monitors;
  if (!existsSync(file)) return { ran: false, monitors: [] };
  const doc = readMonitors(file);
  const now = o.now ?? Date.now;
  const picked = doc.monitors.filter((m) => !o.names?.length || o.names.includes(m.name));
  const due = picked.filter((m) => o.force || m.lastRunAt === undefined || now() - m.lastRunAt >= MONITOR_INTERVAL_MS);
  if (!due.length) return { ran: false, monitors: [] };
  let lock;
  try {
    lock = await acquireLock(runLockPath(file), { waitMs: o.force ? 5_000 : 0 });
  } catch (e) {
    if (e instanceof LockBusyError) return { ran: false, busy: true, monitors: [] };
    throw e;
  }
  const redactor = createRedactor({ redact: deps.config.capture.redact, patterns: deps.config.capture.redactPatterns, env: deps.env });
  const results: MonitorResult[] = [];
  try {
    for (const def of due) {
      if (o.signal?.aborted) break;
      const state: MonitorState = { cursor: def.cursor, spend: def.spend, lastError: def.lastError, scored: def.scored ?? 0 };
      const r = await runOne(deps, def, state, redactor, o).catch((e: unknown): MonitorResult => {
        const message = (e as Error)?.message ?? String(e);
        state.lastError = { message, at: now() };
        return { name: def.name, scored: 0, skipped: 0, sampledOut: 0, failed: 0, error: message };
      });
      results.push(r);
      if (r.error) o.log?.(`monitor ${def.name}: ${r.error}`);
      await updateMonitors(file, (d) => {
        const m = d.monitors.find((x) => x.name === def.name && x.createdAt === def.createdAt);
        if (!m) return { result: undefined };
        if (state.cursor !== undefined) m.cursor = state.cursor;
        if (state.spend) m.spend = state.spend;
        if (state.lastError) m.lastError = state.lastError;
        else delete m.lastError;
        m.scored = state.scored;
        m.lastRunAt = now();
        return { doc: d, result: undefined };
      }).catch((e: Error) => o.log?.(`monitor ${def.name}: could not save its state: ${e.message}`));
    }
  } finally {
    lock.release();
  }
  return { ran: true, monitors: results };
}

interface MonitorState {
  cursor?: number;
  spend?: { day: string; usd: number };
  lastError?: MonitorError;
  scored: number;
}

/** Stops a pass without advancing past the session it was on. */
class Stop extends Error {
  readonly why: "budget" | "no-provider";
  constructor(why: "budget" | "no-provider", message: string) {
    super(message);
    this.why = why;
  }
}

/** A session-level failure: recorded, no score, the pass goes on. */
class Failed extends Error {}

/** Nothing to score in this session (a judge monitor and no user message). */
class Nothing extends Error {}

async function candidates(index: IndexStore, def: MonitorDef, after: number): Promise<Session[]> {
  let q: Query = {};
  if (def.where) q = parseWhere(def.where);
  const filter: SessionFilter = { since: after - LOOKBACK_MS };
  if (!scopesSubagents(q.root)) filter.parentSessionId = null;
  const { sessions } = await findSessions(index, { ...q, sort: undefined, limit: undefined }, { filter, limit: SCAN_LIMIT });
  return sessions.filter((s) => s.endedAt !== undefined && s.endedAt > after).sort((a, b) => a.endedAt! - b.endedAt! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function runOne(deps: MonitorDeps, def: MonitorDef, state: MonitorState, redactor: Redactor, o: RunMonitorsOptions): Promise<MonitorResult> {
  const now = o.now ?? Date.now;
  const r: MonitorResult = { name: def.name, scored: 0, skipped: 0, sampledOut: 0, failed: 0 };
  const after = o.since ?? state.cursor ?? now() - DAY;
  let list = await candidates(deps.index, def, after);
  if (!o.all && list.length > MAX_PER_PASS) {
    // Sessions that end at the same time as the last one are handled together, so the cursor skips none.
    let end = MAX_PER_PASS;
    while (end < list.length && list[end]!.endedAt === list[end - 1]!.endedAt) end++;
    list = list.slice(0, end);
  }
  const scorer = def.kind === "run" ? runScorer(deps, def, redactor, o) : await judgeScorer(deps, def, state, o);
  if (!scorer) {
    // Nothing is judged and the cursor stays: the sessions wait for a provider.
    state.lastError = { message: NO_PROVIDER, at: now() };
    return { ...r, error: NO_PROVIDER, stopped: "no-provider" };
  }
  const advance = (s: Session) => {
    if (state.cursor === undefined || s.endedAt! > state.cursor) state.cursor = s.endedAt!;
  };
  let clean = true;
  for (const s of list) {
    if (o.signal?.aborted) break;
    if (def.sample !== undefined && def.sample < 1 && sampleKey(s.id) >= def.sample) {
      r.sampledOut++;
      advance(s);
      continue;
    }
    const prior = await deps.index.listScores!({ target: "session", targetId: s.id, name: def.name, source: "monitor", limit: 1 });
    if (prior.length) {
      r.skipped++;
      advance(s);
      continue;
    }
    try {
      const { value, comment } = await scorer.score(s);
      const body: Record<string, unknown> = { target: "session", targetId: s.id, name: def.name, value, source: "monitor", judgeVersion: scorer.version };
      if (comment) body.comment = redactor.string(comment).slice(0, 4000);
      const write = () => addScore(deps.index, body, { by: "monitor", source: "monitor", now: now() });
      await (o.write ? o.write(write) : write());
      r.scored++;
      state.scored++;
    } catch (e) {
      if (e instanceof Stop) {
        r.stopped = e.why;
        r.error = e.message;
        state.lastError = { message: e.message, at: now() };
        return r;
      }
      if (e instanceof Nothing) r.skipped++;
      else {
        if (!(e instanceof Failed || e instanceof ScoreError)) throw e;
        clean = false;
        r.failed++;
        r.error = e.message;
        state.lastError = { message: e.message, at: now(), sessionId: s.id };
      }
    }
    advance(s);
  }
  if (clean && r.scored > 0) delete state.lastError;
  return r;
}

function readRubric(def: MonitorDef): string {
  try {
    return readFileSync(def.rubric!, "utf8");
  } catch (e) {
    throw new Error(`cannot read the rubric ${def.rubric}: ${(e as Error).message}`);
  }
}

interface Scorer {
  score(s: Session): Promise<{ value: number | boolean | string; comment?: string }>;
  /** Stored as the score's judgeVersion. */
  version: string;
}

// ---------------------------------------------------------------- --run

/** An event as `show --json` lists it: without the session id, and without the agent and cwd when the session's. */
function eventJson(e: AgentEvent, s: Session): Record<string, unknown> {
  const { sessionId: _id, agent, cwd, ...rest } = e;
  const out: Record<string, unknown> = rest;
  if (agent !== s.agent) out.agent = agent;
  if (cwd !== undefined && cwd !== s.cwd) out.cwd = cwd;
  return out;
}

function runScorer(deps: MonitorDeps, def: MonitorDef, redactor: Redactor, o: RunMonitorsOptions): Scorer {
  const score = async (s: Session) => {
    const [{ sessionJson }, events] = await Promise.all([import("../cli/common.ts"), deps.index.listEvents(s.id)]);
    const doc = redactor.value({ session: sessionJson(s, { derailEvents: true }), eventCount: s.stats.events, events: events.map((e) => eventJson(e, s)) });
    const env = { ...deps.env, CODING_SH_SESSION_ID: s.id };
    const res = await runShell(def.command!, { cwd: existsSync(def.cwd) ? def.cwd : undefined, env, stdin: JSON.stringify(doc), timeoutMs: o.timeoutMs ?? MONITOR_TIMEOUT_MS, signal: o.signal });
    if (res.failure) throw new Failed(`${s.id}: ${res.failure}`);
    return parseOutput(res.stdout, s.id);
  };
  return { score, version: monitorVersion(def.command!) };
}

/** The command's verdict: the whole stdout as JSON, or else its last line. */
export function parseOutput(stdout: string, sessionId = "session"): { value: number | boolean | string; comment?: string } {
  const text = stdout.trim();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let doc: unknown;
  for (const t of [text, lines[lines.length - 1] ?? ""]) {
    try {
      doc = JSON.parse(t);
      break;
    } catch {
      // try the last line
    }
  }
  const v = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>).value : undefined;
  if (!(typeof v === "number" && Number.isFinite(v)) && typeof v !== "boolean" && typeof v !== "string") {
    const shown = text ? JSON.stringify(text.slice(0, 120)) : "nothing";
    throw new Failed(`${sessionId}: the command printed ${shown}, not {"value": ..., "comment"?: ...}`);
  }
  const c = (doc as Record<string, unknown>).comment;
  return typeof c === "string" && c ? { value: v, comment: c } : { value: v };
}

interface ShellResult {
  stdout: string;
  /** Why it failed: exit code, timeout, could not start. */
  failure?: string;
}

function runShell(command: string, o: { cwd?: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; signal?: AbortSignal }): Promise<ShellResult> {
  const detached = process.platform !== "win32";
  const child = spawn(command, { shell: true, cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached, windowsHide: true });
  const out: Buffer[] = [];
  let outBytes = 0;
  let err = "";
  child.stdout.on("data", (b: Buffer) => {
    if (outBytes < MAX_STDOUT) out.push(b.subarray(0, MAX_STDOUT - outBytes));
    outBytes += b.length;
  });
  child.stderr.on("data", (b: Buffer) => {
    if (err.length < 8192) err += b.toString("utf8");
  });
  // A command that never reads stdin closes it early: that is not its failure.
  child.stdin.on("error", () => {});
  child.stdin.end(o.stdin);
  return supervise(child, { group: detached, timeoutMs: o.timeoutMs, signal: o.signal }).then((s) => {
    const stdout = Buffer.concat(out).toString("utf8");
    if (s.error) return { stdout, failure: `could not start the command: ${s.error.message}` };
    if (s.timedOut) return { stdout, failure: `the command was stopped after ${Math.round(o.timeoutMs / 1000)} s` };
    if (s.aborted) return { stdout, failure: "stopped" };
    if (s.code !== 0) {
      const tail = err.trim().split(/\r?\n/).slice(-2).join(" | ").slice(0, 300);
      return { stdout, failure: `the command ${s.signal ? `was killed by ${s.signal}` : `exited ${s.code}`}${tail ? `: ${tail}` : ""}` };
    }
    return { stdout };
  });
}

// ---------------------------------------------------------------- --judge

const KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gateway: "AI_GATEWAY_API_KEY" };

/** The provider kind a judge monitor uses: its own, else the first whose API key is set. */
export function judgeProviderKind(def: Pick<MonitorDef, "provider">, env: NodeJS.ProcessEnv): string | undefined {
  if (def.provider === "mock") return "mock";
  if (def.provider) return env[KEY_ENV[def.provider]!] ? def.provider : undefined;
  return Object.keys(KEY_ENV).find((k) => env[KEY_ENV[k]!]);
}

async function judgeScorer(deps: MonitorDeps, def: MonitorDef, state: MonitorState, o: RunMonitorsOptions): Promise<Scorer | undefined> {
  const now = o.now ?? Date.now;
  let base = o.provider;
  if (!base) {
    const kind = judgeProviderKind(def, deps.env);
    if (!kind) return undefined;
    const { providerFromSpec } = await import("../graders/index.ts");
    base = providerFromSpec({ provider: kind as "anthropic", model: def.model || undefined }, { env: deps.env });
  }
  const rubric = readRubric(def);
  const [{ createJudge }, { FileJudgeCache }, { caseFromSession, DatasetError }, { estimateCost, pricesFor }] = await Promise.all([
    import("../judge/judge.ts"),
    import("../judge/cache.ts"),
    import("../datasets/dataset.ts"),
    import("../core/pricing.ts"),
  ]);
  const prices = pricesFor(deps.config.pricing);
  const charge = (usd: number) => {
    const day = localDay(now());
    state.spend = { day, usd: spentToday({ spend: state.spend } as MonitorDef, now()) + usd };
  };
  const p = base;
  const metered: ChatProvider = {
    name: p.name,
    model: p.model,
    params: p.params,
    async complete(req) {
      const res = await p.complete(req);
      if (p.name !== "mock") {
        const inTok = res.usage?.inputTokens ?? Math.ceil((req.system.length + req.user.length) / 4);
        const outTok = res.usage?.outputTokens ?? Math.ceil(res.text.length / 4);
        charge(estimateCost({ inputTokens: inTok, outputTokens: outTok }, res.model || p.model, prices) ?? inTok * FALLBACK_RATES.input + outTok * FALLBACK_RATES.output);
      }
      return res;
    },
  };
  const judge = createJudge({ name: def.name, rubric, provider: metered, cache: p.name !== "mock" ? new FileJudgeCache(deps.paths.judgeCache) : undefined });
  const redactor = createRedactor({ redact: deps.config.capture.redact, patterns: deps.config.capture.redactPatterns, env: deps.env });
  const score = async (s: Session) => {
    if (spentToday({ spend: state.spend } as MonitorDef, now()) >= def.maxUsdDay) {
      throw new Stop("budget", `stopped for today: estimated judge spend reached the $${def.maxUsdDay} daily limit (--max-usd-day)`);
    }
    const events = await deps.index.listEvents(s.id);
    let c;
    try {
      c = caseFromSession(s, events);
    } catch (e) {
      if (e instanceof DatasetError) throw new Nothing(e.message);
      throw e;
    }
    const trace = events.map((e) => ({ id: e.id, kind: e.kind, ts: e.ts, payload: e.payload as Record<string, unknown> }));
    const ctx = redactor.value({ input: c.input, output: c.metadata?.output ?? "", trace });
    let v;
    try {
      v = await judge.evaluate({ ...ctx, signal: o.signal });
    } catch (e) {
      throw new Failed(`${s.id}: the judge failed: ${(e as Error).message}`);
    }
    return v.reason ? { value: v.score, comment: v.reason } : { value: v.score };
  };
  return { score, version: monitorVersion(rubric) };
}

/** runMonitors after an ingest pass: undefined when there are no monitors, and never throws. */
export async function monitorsAfterIngest(deps: MonitorDeps, o: RunMonitorsOptions = {}): Promise<RunMonitorsResult | undefined> {
  if (!hasMonitors(deps.paths.monitors)) return undefined;
  try {
    return await runMonitors(deps, o);
  } catch (e) {
    const error = (e as Error)?.message ?? String(e);
    o.log?.(`monitors: ${error}`);
    return { ran: false, monitors: [], error };
  }
}
