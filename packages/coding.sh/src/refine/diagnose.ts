// `refine diagnose` (Y-5, arXiv 2611.04507 §3.1-3.4): a two-stage,
// evidence-gated diagnosis of sessions into Signals.
//
//   stage 1   diagnoseSession: one model call per session against the catalog.
//             Code then checks every occurrence: citations must quote the
//             cited event (verifyCitations), an occurrence with no verified
//             evidence is dropped and counted; ins.*, tool.invalid-args,
//             out.false-success and out.check-subverted need a verified
//             requirement citation, else the session is 'insufficient-evidence';
//             type ids must be in the catalog, the nature allowed for the first
//             type, the factor one of the five points, and a risk needs reach.
//   stage 2   buildSignals (signals.ts): occurrences grouped into Signals.
//
// Severity is computed by code (severity.ts), never by the model. Every model
// reply is cached on disk under sha256(prompt + catalog + prompt version +
// model), so a rerun on unchanged sessions makes no call. diagnoseRun is
// explicit (the CLI never runs it implicitly), skips eval-run sessions unless
// asked, stops at a token budget and leaves the rest as a cursor for the next
// run.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, IndexStore } from "../core/types.ts";
import type { Citation } from "../datasets/types.ts";
import { mapPool } from "../judge/limit.ts";
import { verifyCitations } from "../judge/prompt.ts";
import type { ChatProvider } from "../judge/providers.ts";
import type { Session } from "../schema/index.ts";
import { DIAGNOSE_SYSTEM, DIAGNOSIS_SCHEMA, diagnoseUser, estimateTokens, flagHints, OUTPUT_TOKENS_PER_SESSION, PROMPT_HASH, renderSession } from "./diagnose-prompt.ts";
import { COMPONENT_TYPES, type ComponentType } from "./match.ts";
import { FACTOR_POINTS, REACH_VALUES } from "./severity.ts";
import { buildSignals, jsonReply, readSignals, REQUIREMENT_SOURCES, writeSignals, type Ask, type DiagnosedOccurrence, type RequirementSource, type SignalsDoc } from "./signals.ts";
import { catalogHash, diagnosticType, type Nature } from "./taxonomy.ts";

/** Types whose occurrence needs a verified requirement citation. */
export const NEEDS_REQUIREMENT = (typeId: string): boolean => typeId.startsWith("ins.") || ["tool.invalid-args", "out.false-success", "out.check-subverted"].includes(typeId);

export interface SessionDiagnosis {
  sessionId: string;
  status: "problems" | "none" | "insufficient-evidence";
  occurrences: DiagnosedOccurrence[];
  /** Occurrences dropped for having no verified evidence citation. */
  droppedUnverified: number;
  /** Occurrences dropped as malformed (unknown type, nature not allowed, bad factor or reach). */
  droppedInvalid: number;
  /** Occurrences dropped for a missing requirement citation. */
  needsRequirement: number;
  hintVerdicts: Record<string, "confirmed" | "rejected">;
  truncated: boolean;
  /** The reply came from the cache. */
  cached: boolean;
}

// ---------------------------------------------------------------- cache

/** A reply cache on disk: one file per key. */
export class ReplyCache {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private file(key: string): string {
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }
  get(key: string): string | undefined {
    try {
      const v = JSON.parse(readFileSync(this.file(key), "utf8")) as { text?: unknown };
      return typeof v.text === "string" ? v.text : undefined;
    } catch {
      return undefined;
    }
  }
  set(key: string, text: string): void {
    const f = this.file(key);
    mkdirSync(join(this.dir, key.slice(0, 2)), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ text }));
    renameSync(tmp, f);
  }
}

export const cacheKey = (model: string, system: string, user: string): string =>
  createHash("sha256").update(`${catalogHash()}\u0000${PROMPT_HASH}\u0000${model}\u0000${system}\u0000${user}`).digest("hex");

export interface Calls {
  calls: number;
  cached: number;
  inputTokens: number;
  outputTokens: number;
}

/** A reply worth keeping: every ask wants a JSON object back. */
const usableReply = (text: string): boolean => {
  const v = jsonReply(text);
  return !!v && typeof v === "object" && !Array.isArray(v);
};

/**
 * An Ask that reads the cache first and counts the calls it makes. Only a reply
 * that parses as a JSON object is cached (and a cached one that does not is
 * asked again), so a truncated or prose reply is not reused on the next run.
 */
export function cachedAsk(provider: ChatProvider, cache: ReplyCache, calls: Calls, signal?: AbortSignal): Ask {
  return async (req) => {
    const key = cacheKey(provider.model, req.system, req.user);
    const hit = cache.get(key);
    if (hit !== undefined && usableReply(hit)) {
      calls.cached++;
      return hit;
    }
    const res = await provider.complete({ system: req.system, user: req.user, jsonSchema: req.schema, ...(signal ? { signal } : {}) });
    calls.calls++;
    calls.inputTokens += res.usage?.inputTokens ?? 0;
    calls.outputTokens += res.usage?.outputTokens ?? 0;
    if (usableReply(res.text)) cache.set(key, res.text);
    return res.text;
  };
}

// ---------------------------------------------------------------- stage 1

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function citations(v: unknown): Citation[] {
  return (Array.isArray(v) ? v : []).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const q = (c as { quote?: unknown }).quote;
    const id = (c as { eventId?: unknown }).eventId;
    return typeof q === "string" ? [{ quote: q, ...(typeof id === "string" && id ? { eventId: id } : {}) }] : [];
  });
}

/** Only citations that name a shown event and quote it. */
function verified(cs: readonly Citation[], material: ReadonlyMap<string, string>): Citation[] {
  return verifyCitations(cs.filter((c) => c.eventId && material.has(c.eventId)), material).filter((c) => c.verified);
}

const occurrenceId = (sessionId: string, component: { type: string; name: string }, typeId: string, evidenceId: string): string =>
  createHash("sha256").update(`${sessionId}\u0000${component.type}\u0000${component.name}\u0000${typeId}\u0000${evidenceId}`).digest("hex").slice(0, 12);

/** Code's checks on one model reply. */
export function verifyDiagnosis(sessionId: string, text: string, material: ReadonlyMap<string, string>, hints: readonly string[]): Omit<SessionDiagnosis, "truncated" | "cached"> {
  const v = jsonReply(text) as { status?: unknown; occurrences?: unknown; hints?: unknown } | undefined;
  const out: DiagnosedOccurrence[] = [];
  let droppedUnverified = 0;
  let droppedInvalid = 0;
  let needsRequirement = 0;
  const seen = new Set<string>();
  for (const raw of Array.isArray(v?.occurrences) ? v!.occurrences : []) {
    if (!raw || typeof raw !== "object") {
      droppedInvalid++;
      continue;
    }
    const o = raw as Record<string, unknown>;
    const comp = o.component as { type?: unknown; name?: unknown } | undefined;
    const type = comp?.type;
    const name = str(comp?.name);
    const typeIds = [...new Set((Array.isArray(o.typeIds) ? o.typeIds : []).filter((t): t is string => typeof t === "string" && !!diagnosticType(t)))].slice(0, 3);
    const nature = o.nature as Nature;
    const first = typeIds[0] ? diagnosticType(typeIds[0]) : undefined;
    const factor = Number(o.factor);
    const reach = o.reach === undefined || o.reach === null ? undefined : Number(o.reach);
    const ok =
      typeof type === "string" &&
      (COMPONENT_TYPES as readonly string[]).includes(type) &&
      name &&
      first &&
      first.natures.includes(nature) &&
      (FACTOR_POINTS as readonly number[]).includes(factor) &&
      (nature === "risk" ? reach !== undefined && (REACH_VALUES as readonly number[]).includes(reach) : true);
    if (!ok) {
      droppedInvalid++;
      continue;
    }
    const evidence = verified(citations(o.evidence), material);
    if (!evidence.length) {
      droppedUnverified++;
      continue;
    }
    const req = o.requirement as { source?: unknown; citations?: unknown } | undefined;
    const reqCites = req ? verified(citations(req.citations), material) : [];
    const source = typeof req?.source === "string" && (REQUIREMENT_SOURCES as readonly string[]).includes(req.source) ? (req.source as RequirementSource) : undefined;
    if (NEEDS_REQUIREMENT(typeIds[0]!) && (!source || !reqCites.length)) {
      needsRequirement++;
      continue;
    }
    const component = { type: type as ComponentType, name: name as string };
    const id = occurrenceId(sessionId, component, typeIds[0]!, evidence[0]!.eventId!);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      sessionId,
      component,
      typeIds,
      nature,
      explanation: (str(o.explanation) ?? "").slice(0, 600),
      ...(source && reqCites.length ? { requirement: { source, citations: reqCites } } : {}),
      evidence,
      factor,
      ...(nature === "risk" ? { reach } : {}),
    });
  }
  const hintVerdicts: Record<string, "confirmed" | "rejected"> = {};
  const want = new Set(hints);
  for (const h of Array.isArray(v?.hints) ? v!.hints : []) {
    const flag = (h as { flag?: unknown })?.flag;
    const verdict = (h as { verdict?: unknown })?.verdict;
    if (typeof flag === "string" && want.has(flag) && (verdict === "confirmed" || verdict === "rejected")) hintVerdicts[flag] = verdict;
  }
  const said = v?.status;
  const status: SessionDiagnosis["status"] = out.length ? "problems" : needsRequirement || said === "insufficient-evidence" || v === undefined ? "insufficient-evidence" : "none";
  return { sessionId, status, occurrences: out.sort((a, b) => (a.id < b.id ? -1 : 1)), droppedUnverified, droppedInvalid, needsRequirement, hintVerdicts };
}

/** The stage-1 prompt for a session, with the material its citations are checked against. */
export function sessionPrompt(session: Pick<Session, "id" | "agent" | "flags">, events: readonly AgentEvent[]) {
  const r = renderSession(events);
  const hints = flagHints(session.flags);
  const user = diagnoseUser({ sessionId: session.id, agent: String(session.agent), trace: r.trace, hints, truncated: r.truncated });
  return { system: DIAGNOSE_SYSTEM, user, material: r.material, truncated: r.truncated, hints, tokens: estimateTokens(DIAGNOSE_SYSTEM.length + user.length) + OUTPUT_TOKENS_PER_SESSION };
}

/** Stage 1 for one session. */
export async function diagnoseSession(o: { session: Pick<Session, "id" | "agent" | "flags">; events: readonly AgentEvent[]; ask: Ask; isCached?: (system: string, user: string) => boolean }): Promise<SessionDiagnosis> {
  const p = sessionPrompt(o.session, o.events);
  const cached = o.isCached?.(p.system, p.user) ?? false;
  const text = await o.ask({ system: p.system, user: p.user, schema: DIAGNOSIS_SCHEMA, label: `session ${o.session.id}` });
  return { ...verifyDiagnosis(o.session.id, text, p.material, p.hints), truncated: p.truncated, cached };
}

// ---------------------------------------------------------------- a run

export interface DiagnoseFilter {
  since?: number;
  agents?: readonly string[];
  repo?: string;
  /** Exactly these sessions, by full id (overrides the window); an id that is not in the index throws. */
  sessionIds?: readonly string[];
  /** Also diagnose eval-run sessions. */
  includeRuns?: boolean;
}

export interface PlanSession {
  id: string;
  agent: string;
  startedAt: number;
  tokens: number;
  cached: boolean;
}

export interface DiagnosePlan {
  sessions: PlanSession[];
  /** Estimated tokens of the uncached calls (stage 1 only). */
  tokens: number;
  uncached: number;
}

export interface HintPrecision {
  flag: string;
  confirmed: number;
  rejected: number;
  /** confirmed / (confirmed + rejected); null with neither. */
  precision: number | null;
}

export interface DiagnoseRunResult {
  plan: DiagnosePlan;
  results: SessionDiagnosis[];
  /** Sessions left for the next run (the budget ran out). */
  pending: string[];
  doc: SignalsDoc;
  changed: string[];
  calls: Calls;
  hints: HintPrecision[];
  droppedUnverified: number;
}

const under = (dir: string, p: string | undefined): boolean => !!p && (p === dir || p.startsWith(`${dir.replace(/[\\/]+$/, "")}/`) || p.startsWith(`${dir.replace(/[\\/]+$/, "")}\\`));

/** The sessions a run looks at, newest first; pending ones from the cursor go first. */
export async function selectSessions(index: Pick<IndexStore, "listSessions" | "getSession">, f: DiagnoseFilter, maxSessions: number): Promise<Session[]> {
  if (f.sessionIds?.length) {
    const out: Session[] = [];
    for (const id of f.sessionIds) {
      const s = await index.getSession(id);
      // A named session that is missing is an error: an empty plan would read as "nothing to diagnose".
      if (!s) throw new Error(`No session ${JSON.stringify(id)} in the index`);
      out.push(s);
    }
    return out;
  }
  const all = await index.listSessions({ parentSessionId: null, ...(f.includeRuns ? {} : { runId: null }), ...(f.since !== undefined ? { since: f.since } : {}), limit: 5000 });
  return all
    .filter((s) => (f.includeRuns || !s.runId) && (!f.agents?.length || f.agents.includes(String(s.agent))) && (!f.repo || under(f.repo, s.cwd) || under(f.repo, s.repo?.root)))
    .slice(0, maxSessions);
}

const cursorFile = (dir: string) => join(dir, "diagnose-cursor.json");

export function readCursor(dir: string): string[] {
  try {
    const v = JSON.parse(readFileSync(cursorFile(dir), "utf8")) as { pending?: unknown };
    return Array.isArray(v.pending) ? v.pending.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeCursor(dir: string, pending: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(cursorFile(dir), `${JSON.stringify({ pending }, null, 2)}\n`);
}

export interface DiagnoseRunOptions {
  index: Pick<IndexStore, "listSessions" | "getSession" | "listEvents">;
  /** The refine dir: signals.json, the reply cache and the cursor live here. */
  dir: string;
  filter?: DiagnoseFilter;
  maxSessions?: number;
  /** Stop starting uncached sessions once their estimated tokens would pass this. */
  tokenBudget?: number;
  concurrency?: number;
  /** Absent: plan only ($0, nothing written). */
  provider?: ChatProvider;
  /** false: one Signal per key, no partition call. */
  split?: boolean;
  signal?: AbortSignal;
  /** Repo label stored with each analyzed session (default: its repo root or cwd). */
  repoOf?: (s: Session) => string;
}

export const signalsFile = (dir: string): string => join(dir, "signals.json");
export const cacheDir = (dir: string): string => join(dir, "diagnose-cache");

/** Plans and (with a provider) runs a diagnosis: stage 1 per session, then Signals, then signals.json. */
export async function diagnoseRun(o: DiagnoseRunOptions): Promise<DiagnoseRunResult> {
  const sessions = await selectSessions(o.index, o.filter ?? {}, o.maxSessions ?? 50);
  const pendingBefore = new Set(readCursor(o.dir));
  // Sessions the last run left behind go first.
  sessions.sort((a, b) => Number(pendingBefore.has(b.id)) - Number(pendingBefore.has(a.id)));
  const cache = new ReplyCache(cacheDir(o.dir));
  const model = o.provider?.model ?? "";
  const events = new Map<string, AgentEvent[]>();
  const plan: DiagnosePlan = { sessions: [], tokens: 0, uncached: 0 };
  for (const s of sessions) {
    const evs = await o.index.listEvents(s.id);
    events.set(s.id, evs);
    const p = sessionPrompt(s, evs);
    const cached = !!o.provider && cache.get(cacheKey(model, p.system, p.user)) !== undefined;
    plan.sessions.push({ id: s.id, agent: String(s.agent), startedAt: s.startedAt, tokens: p.tokens, cached });
    if (!cached) {
      plan.tokens += p.tokens;
      plan.uncached++;
    }
  }
  const catalog = catalogHash();
  const file = signalsFile(o.dir);
  const calls: Calls = { calls: 0, cached: 0, inputTokens: 0, outputTokens: 0 };
  if (!o.provider) return { plan, results: [], pending: [], doc: readSignals(file, catalog), changed: [], calls, hints: [], droppedUnverified: 0 };

  // The budget: cached sessions are free; uncached ones run while their estimates fit.
  let budget = o.tokenBudget ?? Number.POSITIVE_INFINITY;
  const run: Session[] = [];
  const pending: string[] = [];
  for (const s of sessions) {
    const ps = plan.sessions.find((x) => x.id === s.id)!;
    if (ps.cached) run.push(s);
    else if (ps.tokens <= budget) {
      budget -= ps.tokens;
      run.push(s);
    } else pending.push(s.id);
  }
  const ask = cachedAsk(o.provider, cache, calls, o.signal);
  const results = await mapPool(run, o.concurrency ?? 4, (s) => diagnoseSession({ session: s, events: events.get(s.id)!, ask, isCached: (sys, user) => cache.get(cacheKey(model, sys, user)) !== undefined }));
  writeCursor(o.dir, pending);

  let doc = readSignals(file, catalog);
  const repoOf = o.repoOf ?? ((s: Session) => s.repo?.root ?? s.cwd ?? "");
  const byId = new Map(run.map((s) => [s.id, s]));
  const sessionsMap = { ...doc.sessions };
  for (const r of results) {
    const s = byId.get(r.sessionId)!;
    sessionsMap[r.sessionId] = { startedAt: s.startedAt, agent: String(s.agent), repo: repoOf(s), status: r.status, ...(Object.keys(r.hintVerdicts).length ? { hints: Object.fromEntries(Object.entries(r.hintVerdicts).sort()) } : {}) };
  }
  doc = { ...doc, catalog, sessions: sessionsMap };
  const built = await buildSignals(doc, results.flatMap((r) => r.occurrences), { ask, ...(o.split === false ? { split: false } : {}) });
  writeSignals(file, built.doc);
  return { plan, results, pending, doc: built.doc, changed: built.changed, calls, hints: hintPrecision(built.doc), droppedUnverified: results.reduce((a, r) => a + r.droppedUnverified, 0) };
}

/** Per flag, over every analyzed session: how often the model confirmed the rule's hit. */
export function hintPrecision(doc: SignalsDoc): HintPrecision[] {
  const by = new Map<string, { confirmed: number; rejected: number }>();
  for (const s of Object.values(doc.sessions)) {
    for (const [flag, v] of Object.entries(s.hints ?? {})) {
      const x = by.get(flag) ?? { confirmed: 0, rejected: 0 };
      x[v]++;
      by.set(flag, x);
    }
  }
  return [...by]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([flag, x]) => ({ flag, ...x, precision: x.confirmed + x.rejected ? x.confirmed / (x.confirmed + x.rejected) : null }));
}
