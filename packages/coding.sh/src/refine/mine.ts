// `refine mine` (R2-5): failure patterns across a window of sessions, ranked,
// with example sessions and an evidence count, as input for `refine propose`
// (docs/research/prime-agent.md §5.3). Four deterministic detectors, all $0:
//
//   flag                   one pattern per diagnosed session flag (taxonomy +
//                          deterministic severity, as flagFindings)
//   error-signature        the first error line of a failed tool call,
//                          normalized: standalone numbers → #, paths → <path>,
//                          hex ids → <hex>, quoted text → '…', whitespace
//                          collapsed. Error codes such as TS2307 or E0308 stay,
//                          so TS2307 and TS1294 are two patterns.
//   repeated-instruction   imperative sentences from what the user typed (not
//                          the task prompt that opens a session, not a harness
//                          notice, not a message an agent sent), canonicalized
//                          and clustered at character 5-shingle Jaccard ≥ 0.6;
//                          each cluster is labelled with its medoid sentence
//   eval-failure           failed eval runs (RunResult.pass=false), grouped by
//                          the first tool where the run left a passing attempt
//                          of the same task
//
// A pattern counts when it is seen in at least `minSupport.sessions` sessions
// over `minSupport.days` UTC days (default 3 and 2). Sessions with a runId
// (coding.sh's own eval runs) are left out of the first three. Under a repo
// filter an eval run counts by its task (the repo the task starts from, or a
// suite in the repo), since its session runs in a scratch directory. Ranking:
// sessions × (wasted tool calls, else 1), then severity, then evidence count,
// then id. Ids are sha256(kind + signature)[:12], stable across runs.
// Everything that leaves this module goes through the redactor.
import { createHash } from "node:crypto";
import { createRedactor } from "../core/redact.ts";
import { isSyntheticPrompt } from "../core/sessions.ts";
import type { AgentEvent, IndexStore, RunResult } from "../core/types.ts";
import type { Session } from "../schema/index.ts";
import { flagFindings } from "./findings.ts";
import type { Diagnosis } from "./severity.ts";

export type MinedKind = "flag" | "error-signature" | "repeated-instruction" | "eval-failure" | "diagnosis";

export interface MinedExample {
  sessionId: string;
  /** Events that show the pattern in this session (at most 5). */
  eventIds: string[];
  startedAt: number;
  /** The text seen there (redacted, clipped), when the pattern has one. */
  text?: string;
}

export interface MinedFinding {
  /** sha256(kind + signature)[:12]. */
  id: string;
  kind: MinedKind;
  /** `flag:no-verification`, `err:error TS2307: Cannot find module '…'`, `instr:run test before done`, `eval:Edit`. */
  signature: string;
  /** What a person reads: the error line, the medoid sentence, the flag. */
  label: string;
  /** Evidence count: failed calls, sentences, flagged sessions or failed runs. */
  count: number;
  agents: string[];
  support: { sessions: number; days: number; repos: number };
  impact: { wastedToolCalls?: number; failedSessions?: number };
  /** Newest first, at most 10. */
  examples: MinedExample[];
  /** Where a fix would go. */
  surface: "context-file" | "skill" | "tool-description";
  diagnosis?: Diagnosis;
}

export interface MinSupport {
  sessions: number;
  days: number;
}

export const DEFAULT_MIN_SUPPORT: MinSupport = Object.freeze({ sessions: 3, days: 2 });
export const MAX_EXAMPLES = 10;

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const findingId = (kind: MinedKind, signature: string): string => createHash("sha256").update(`${kind}\u0000${signature}`).digest("hex").slice(0, 12);

/** One sighting of a pattern. */
interface Hit {
  session: Session;
  eventId?: string;
  text?: string;
}

const repoOf = (s: Session): string => s.repo?.root ?? s.cwd ?? "";

function group(kind: MinedKind, signature: string, label: string, hits: readonly Hit[], extra: Pick<MinedFinding, "surface"> & Partial<Pick<MinedFinding, "impact" | "diagnosis">>): MinedFinding {
  const bySession = new Map<string, { s: Session; ids: string[]; text?: string }>();
  for (const h of hits) {
    const e = bySession.get(h.session.id) ?? { s: h.session, ids: [] };
    if (h.eventId && e.ids.length < 5 && !e.ids.includes(h.eventId)) e.ids.push(h.eventId);
    e.text ??= h.text;
    bySession.set(h.session.id, e);
  }
  const ss = [...bySession.values()];
  const examples = ss
    .sort((a, b) => b.s.startedAt - a.s.startedAt || (a.s.id < b.s.id ? -1 : 1))
    .slice(0, MAX_EXAMPLES)
    .map((x) => ({ sessionId: x.s.id, eventIds: x.ids, startedAt: x.s.startedAt, ...(x.text ? { text: x.text } : {}) }));
  return {
    id: findingId(kind, signature),
    kind,
    signature,
    label,
    count: hits.length,
    agents: [...new Set(ss.map((x) => String(x.s.agent)))].sort(),
    support: { sessions: ss.length, days: new Set(ss.map((x) => day(x.s.startedAt))).size, repos: new Set(ss.map((x) => repoOf(x.s))).size },
    impact: extra.impact ?? {},
    examples,
    surface: extra.surface,
    ...(extra.diagnosis ? { diagnosis: extra.diagnosis } : {}),
  };
}

// ---------------------------------------------------------------- flags

/** One finding per diagnosed flag (flagFindings: taxonomy and deterministic severity). */
export function flagMined(sessions: readonly Session[]): MinedFinding[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return flagFindings(sessions, { maxExamples: Number.MAX_SAFE_INTEGER }).map((f) => {
    const hits = f.examples.map((e) => ({ session: byId.get(e.sessionId)! }));
    const failed = hits.filter((h) => (h.session.stats?.testsFailed ?? 0) > 0).length;
    return group("flag", `flag:${f.flag}`, f.flag, hits, { surface: "context-file", diagnosis: f.diagnosis, impact: failed ? { failedSessions: failed } : {} });
  });
}

// ---------------------------------------------------------------- error signatures

const ERRORISH = /error|cannot|can't|not found|failed|failure|no such|denied|missing|invalid|unknown|exception|fatal|traceback|refused|timed out/i;

/** Text of a tool output, whatever shape the adapter stored. */
function outputText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map(outputText).join("\n");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["stderr", "error", "text", "content", "stdout", "output", "message"]) if (o[k] !== undefined) {
      const t = outputText(o[k]);
      if (t.trim()) return t;
    }
    return JSON.stringify(v);
  }
  return String(v);
}

/** The first informative line of a failed output: the first that reads like an error, else the first non-empty one. Claude Code's "Exit code N" line is the status, not the error. */
export function firstErrorLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(?:Error: )?Exit code \d+\s*$/i.test(l));
  return lines.find((l) => ERRORISH.test(l)) ?? lines[0];
}

/**
 * An error line with what varies between sightings blurred: quoted text → '…',
 * paths (absolute, ./ or ../, ~, or with a directory and an extension) → <path>,
 * hex ids of 8+ → <hex>, standalone numbers → # (a number glued to letters, an
 * error code like TS2307 or E0308, stays), whitespace collapsed. At most 200 chars.
 */
export function normalizeErrorLine(line: string): string {
  return line
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, "'…'")
    .replace(/(?:[A-Za-z]:\\|~[\\/]|\.{1,2}[\\/]|(?<![\w.])[\\/])[^\s'"`:(),]+|\b[\w.@-]+(?:[\\/][\w.@-]+)+\.\w+\b/g, "<path>")
    .replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/(?<![A-Za-z_\d])\d+(?:\.\d+)*/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** The tool.end events that failed, with their start's input for the label. */
function failedCalls(events: readonly AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.kind === "tool.end" && e.payload.ok === false && !e.payload.wrapper);
}

/** One finding per normalized error line, over every failed tool call in `sessions`. */
export function errorSignatureFindings(sessions: readonly Session[], events: ReadonlyMap<string, readonly AgentEvent[]>): MinedFinding[] {
  const groups = new Map<string, { label: string; hits: Hit[]; tools: Set<string> }>();
  for (const s of sessions) {
    for (const e of failedCalls(events.get(s.id) ?? [])) {
      const line = firstErrorLine(outputText(e.payload.output ?? e.payload.error));
      if (!line) continue;
      const sig = normalizeErrorLine(line);
      if (!sig || sig === "#" || sig === "'…'") continue;
      const g = groups.get(sig) ?? { label: line.slice(0, 200), hits: [], tools: new Set() };
      g.hits.push({ session: s, eventId: e.id, text: line.slice(0, 200) });
      if (typeof e.payload.tool === "string") g.tools.add(e.payload.tool);
      groups.set(sig, g);
    }
  }
  return [...groups].map(([sig, g]) => group("error-signature", `err:${sig}`, sig, g.hits, { surface: "context-file", impact: { wastedToolCalls: g.hits.length } }));
}

// ---------------------------------------------------------------- repeated instructions

/** Leading words that make a sentence an instruction. */
const IMPERATIVE = new Set(
  (
    "add always ask avoid build call change check clean commit confirm create delete do document don't dont double-check ensure explain fix follow format " +
    "include install keep leave lint list make mark move never note open prefer put read remember remove rename repeat replace report restart rerun " +
    "retry review revert run save search show skip start stop test try update use verify wait write"
  ).split(" "),
);
/** Openers dropped before the leading word is checked: "please", "you should", "and also". */
const OPENER = /^(?:(?:please|pls|and|also|so|then|now|ok|okay|again|remember to|make sure to|be sure to|you (?:should|must|need to|have to)|i (?:need|want) you to|can you|could you)[\s,]+)+/i;

/** User sentences: split on sentence ends and line breaks. */
export function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim().replace(/^[-*>\d.)\s]+/, ""))
    .filter((s) => s.length >= 8 && s.length <= 300);
}

/** True when a sentence tells the agent what to do (or not to do). */
export function isImperative(sentence: string): boolean {
  const s = sentence.replace(OPENER, "").toLowerCase().replace(/[’']/g, "'");
  if (/^(?:do not|don't|dont|never|always|make sure)\b/.test(s)) return true;
  const w = /^[a-z-']+/.exec(s)?.[0];
  return w !== undefined && IMPERATIVE.has(w);
}

/** Words that carry no instruction: articles, pronouns, speech verbs ("say it's done" = "done"). */
const STOP = new Set(
  "a an the to you your it it's its is are be been that this these those of in on for at by with and or me my i we our please just any all some then so say saying said says tell telling claim claiming claimed report reporting declare saying".split(" "),
);
/** Words with one meaning in an instruction: the ways of saying "finished". */
const CANON: Record<string, string> = { finish: "done", finished: "done", finishing: "done", complete: "done", completed: "done", completing: "done", done: "done", tests: "test", testing: "test", tested: "test", "don't": "never", dont: "never", "do not": "never" };

/** The canonical form clustering compares: lowercase words, stop words dropped, synonyms folded, light stemming. */
export function canonicalInstruction(sentence: string): string {
  const words = sentence
    .replace(OPENER, "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\bdo not\b/g, "don't")
    .split(/[^a-z0-9'-]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (let w of words) {
    if (STOP.has(w)) continue;
    w = CANON[w] ?? w;
    if (!CANON[w] && w.length > 5) w = w.replace(/(?:ing|ed)$/, "");
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.push(CANON[w] ?? w);
  }
  return out.join(" ");
}

export function shingles(s: string, n = 5): Set<string> {
  const out = new Set<string>();
  if (s.length <= n) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

export function jaccardSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export const INSTRUCTION_JACCARD = 0.6;

/** What the user typed to the main agent after the opening prompt: not a notice, a subagent's prompt or an agent's message. */
function humanFollowUps(events: readonly AgentEvent[]): AgentEvent[] {
  const typed = events.filter((e) => e.kind === "user.message" && !e.subagentId && typeof e.payload.text === "string" && e.payload.from !== "agent" && !isSyntheticPrompt(e.payload.text as string));
  return typed.slice(1);
}

/** Clusters of near-identical instructions (single link at INSTRUCTION_JACCARD), each labelled with its medoid. */
export function repeatedInstructionFindings(sessions: readonly Session[], events: ReadonlyMap<string, readonly AgentEvent[]>): MinedFinding[] {
  interface Item { hit: Hit; canon: string; sh: Set<string>; raw: string }
  const items: Item[] = [];
  for (const s of sessions) {
    for (const e of humanFollowUps(events.get(s.id) ?? [])) {
      for (const raw of sentences(e.payload.text as string)) {
        if (!isImperative(raw)) continue;
        const canon = canonicalInstruction(raw);
        if (canon.length < 6) continue;
        items.push({ hit: { session: s, eventId: e.id, text: raw }, canon, sh: shingles(canon), raw });
      }
    }
  }
  // Union-find over pairs above the threshold; identical canonical forms share a set first.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const byCanon = new Map<string, number>();
  items.forEach((it, i) => {
    const j = byCanon.get(it.canon);
    if (j === undefined) byCanon.set(it.canon, i);
    else parent[find(i)] = find(j);
  });
  const reps = [...byCanon.values()];
  for (let a = 0; a < reps.length; a++) {
    for (let b = a + 1; b < reps.length; b++) {
      const i = reps[a]!;
      const j = reps[b]!;
      if (find(i) !== find(j) && jaccardSets(items[i]!.sh, items[j]!.sh) >= INSTRUCTION_JACCARD) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, Item[]>();
  items.forEach((it, i) => {
    const r = find(i);
    const l = clusters.get(r) ?? [];
    l.push(it);
    clusters.set(r, l);
  });
  const out: MinedFinding[] = [];
  for (const members of clusters.values()) {
    // Medoid: highest summed similarity to the others; ties to the shorter, then the first in sort order.
    let best = members[0]!;
    let bestScore = -1;
    for (const m of members) {
      const score = members.reduce((acc, o) => acc + jaccardSets(m.sh, o.sh), 0);
      if (score > bestScore || (score === bestScore && (m.raw.length < best.raw.length || (m.raw.length === best.raw.length && m.raw < best.raw)))) {
        best = m;
        bestScore = score;
      }
    }
    out.push(group("repeated-instruction", `instr:${best.canon}`, best.raw, members.map((m) => m.hit), { surface: "context-file" }));
  }
  return out;
}

// ---------------------------------------------------------------- eval failures

const toolSeq = (events: readonly AgentEvent[]): { tool: string; id: string }[] =>
  events.filter((e) => e.kind === "tool.start" && typeof e.payload.tool === "string" && !e.payload.wrapper).map((e) => ({ tool: e.payload.tool as string, id: e.id }));

/**
 * Failed eval runs grouped by the first tool where they leave a passing
 * attempt of the same task (the first call whose tool differs, or `<end>` when
 * the failing run stopped short, `<extra>` when it went on). A task with no
 * passing attempt groups under its first failed tool call, else `<no tool error>`.
 */
export function evalFailureFindings(runs: readonly RunResult[], sessions: ReadonlyMap<string, Session>, events: ReadonlyMap<string, readonly AgentEvent[]>): MinedFinding[] {
  const counted = runs.filter((r) => !r.cancelled && !r.superseded && !r.infra);
  const passing = new Map<string, RunResult>();
  for (const r of counted) if (r.pass && r.sessionId && !passing.has(r.taskId)) passing.set(r.taskId, r);
  const groups = new Map<string, Hit[]>();
  for (const r of counted) {
    if (r.pass || !r.sessionId) continue;
    const s = sessions.get(r.sessionId);
    if (!s) continue;
    const evs = events.get(r.sessionId) ?? [];
    const mine = toolSeq(evs);
    const good = passing.get(r.taskId);
    let key: string;
    let at: string | undefined;
    if (good?.sessionId) {
      const theirs = toolSeq(events.get(good.sessionId) ?? []);
      let i = 0;
      while (i < mine.length && i < theirs.length && mine[i]!.tool === theirs[i]!.tool) i++;
      key = i < mine.length ? (i < theirs.length ? mine[i]!.tool : "<extra>") : i < theirs.length ? "<end>" : "<same tools>";
      at = mine[Math.min(i, mine.length - 1)]?.id;
    } else {
      const f = failedCalls(evs)[0];
      key = typeof f?.payload.tool === "string" ? f.payload.tool : "<no tool error>";
      at = f?.id;
    }
    const l = groups.get(key) ?? [];
    l.push({ session: s, ...(at ? { eventId: at } : {}), text: `task ${r.taskId}` });
    groups.set(key, l);
  }
  return [...groups].map(([k, hits]) => group("eval-failure", `eval:${k}`, `failed runs diverge at ${k}`, hits, { surface: "context-file", impact: { failedSessions: hits.length } }));
}

// ---------------------------------------------------------------- ranking, mining

export const rankScore = (f: MinedFinding): number => f.support.sessions * (f.impact.wastedToolCalls ?? 1);

/** Highest first: sessions × wasted calls, then severity, then evidence count, then id. */
export function rankFindings(xs: readonly MinedFinding[]): MinedFinding[] {
  return [...xs].sort((a, b) => rankScore(b) - rankScore(a) || (b.diagnosis?.severity.score ?? 0) - (a.diagnosis?.severity.score ?? 0) || b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Labels, signatures and example texts through the redactor. */
export function redactFindings(xs: readonly MinedFinding[]): MinedFinding[] {
  const r = createRedactor();
  return xs.map((f) => ({ ...f, signature: r.string(f.signature), label: r.string(f.label), examples: f.examples.map((e) => (e.text ? { ...e, text: r.string(e.text) } : e)) }));
}

export interface MineOptions {
  index: Pick<IndexStore, "listSessions" | "listEvents"> & Partial<Pick<IndexStore, "listRuns" | "getTask">>;
  agents?: readonly string[];
  /**
   * Only sessions whose cwd or repo root is under this directory. An eval run
   * works in a scratch directory under the coding.sh home, so it counts by its
   * task instead: the repo the task starts from, or `repoTaskIds`.
   */
  repo?: string;
  /**
   * With `repo`: ids of the tasks of the suites that live in it. A suite task
   * that starts from an empty tree names no repo of its own.
   */
  repoTaskIds?: ReadonlySet<string>;
  /** Epoch ms. */
  since?: number;
  minSupport?: Partial<MinSupport>;
  limit?: number;
  /** Also mine failed eval runs (needs index.listRuns). Default true. */
  evalRuns?: boolean;
  /** Most sessions read (newest first). Default 2000. */
  maxSessions?: number;
}

export interface MineResult {
  findings: MinedFinding[];
  /** Sessions read for the first three detectors (eval runs are not among them). */
  analyzed: number;
  /** Eval-run sessions read for the eval-failure detector. */
  evalRuns: number;
  /** Patterns seen below minSupport. */
  belowSupport: number;
  minSupport: MinSupport;
  since?: number;
}

const under = (dir: string, p: string | undefined): boolean => {
  if (!p) return false;
  const d = dir.replace(/[\\/]+$/, "");
  return p === d || p.startsWith(`${d}/`) || p.startsWith(`${d}\\`);
};

/** Mines the window: flags, error signatures, repeated instructions and eval failures, ranked and redacted. */
export async function mineFindings(o: MineOptions): Promise<MineResult> {
  const min: MinSupport = { ...DEFAULT_MIN_SUPPORT, ...o.minSupport };
  const inWindow = (s: Session) => (o.since === undefined || s.startedAt >= o.since) && (!o.agents?.length || o.agents.includes(String(s.agent)));
  const inRepo = (s: Session) => !o.repo || under(o.repo, s.cwd) || under(o.repo, s.repo?.root);
  const sessions = (await o.index.listSessions({ parentSessionId: null, runId: null, ...(o.since !== undefined ? { since: o.since } : {}), limit: o.maxSessions ?? 2000 })).filter((s) => !s.runId && inWindow(s) && inRepo(s));
  const events = new Map<string, AgentEvent[]>();
  for (const s of sessions) events.set(s.id, await o.index.listEvents(s.id, { kinds: ["user.message", "tool.start", "tool.end"] }));
  const all: MinedFinding[] = [...flagMined(sessions), ...errorSignatureFindings(sessions, events), ...repeatedInstructionFindings(sessions, events)];
  let evalRuns = 0;
  if (o.evalRuns !== false && o.index.listRuns) {
    const runs = (await o.index.listRuns()).filter((r) => r.sessionId && (o.since === undefined || r.startedAt >= o.since));
    // The repo of a run is the repo of its task. A task that is gone, or a store that cannot look one up, leaves the session's own directory.
    const taskInRepo = new Map<string, boolean | undefined>();
    if (o.repo) {
      for (const id of new Set(runs.map((r) => r.taskId))) {
        const root = o.repoTaskIds?.has(id) ? o.repo : (await o.index.getTask?.(id))?.start.repoRoot;
        taskInRepo.set(id, root === undefined ? undefined : under(o.repo, root));
      }
    }
    const taskOf = new Map(runs.map((r) => [r.sessionId!, r.taskId]));
    const runSessions = new Map<string, Session>();
    const runEvents = new Map<string, AgentEvent[]>();
    for (const s of await o.index.listSessions({ ...(o.since !== undefined ? { since: o.since } : {}), limit: 5000 })) {
      const taskId = taskOf.get(s.id);
      if (taskId === undefined || !inWindow(s) || !(taskInRepo.get(taskId) ?? inRepo(s))) continue;
      runSessions.set(s.id, s);
      runEvents.set(s.id, await o.index.listEvents(s.id, { kinds: ["tool.start", "tool.end"] }));
    }
    all.push(...evalFailureFindings(runs.filter((r) => runSessions.has(r.sessionId!)), runSessions, runEvents));
    evalRuns = runSessions.size;
  }
  const supported = all.filter((f) => f.support.sessions >= min.sessions && f.support.days >= min.days);
  const ranked = rankFindings(redactFindings(supported));
  return { findings: o.limit === undefined ? ranked : ranked.slice(0, o.limit), analyzed: sessions.length, evalRuns, belowSupport: all.length - supported.length, minSupport: min, ...(o.since !== undefined ? { since: o.since } : {}) };
}

const KIND_TEXT: Record<MinedKind, string> = { flag: "flag", "error-signature": "error", "repeated-instruction": "instruction", "eval-failure": "eval", diagnosis: "diagnosis" };

/** Plain-text lines for a terminal or a prompt: one per finding plus its first example. */
export function formatFindings(xs: readonly MinedFinding[]): string[] {
  const out: string[] = [];
  for (const f of xs) {
    const sev = f.diagnosis ? `, ${f.diagnosis.severity.level} ${f.diagnosis.severity.score}` : "";
    out.push(`${f.id}  ${KIND_TEXT[f.kind]}  ${f.count}x in ${f.support.sessions} session${f.support.sessions === 1 ? "" : "s"} over ${f.support.days} day${f.support.days === 1 ? "" : "s"}${sev}: ${f.label}`);
    const e = f.examples[0];
    if (e) out.push(`    e.g. ${e.sessionId}${e.text && e.text !== f.label ? `: ${e.text.replace(/\s+/g, " ").slice(0, 120)}` : ""}`);
  }
  return out;
}
