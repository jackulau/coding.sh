// Requirement-ledger task statements (`eval new --statement ledger`): build a
// task's instruction from every user turn of the session, not only the first.
//
// SessionFarmer (arXiv 2611.02440): 87.6% of real tasks depend on a requirement
// added or changed after the first message, and the first message alone covers
// 26% of a reference requirement ledger. A task whose instruction is the first
// prompt, verified against the session's end state, checks requirements the
// agent was never told about: a built-in false reject.
//
//   requirementCandidates  user turns (acknowledgements and harness text dropped) and
//                          assistant proposals the user approved, each with its event id;
//                          an approval that goes on keeps the user's words after the proposal
//   deterministicLedger    offline: one surviving obligation per candidate
//   draftStatement         a model merges them into atomic obligations, marks the ones
//                          a later turn replaced (superseded) and the ones the session
//                          never built (notImplemented); validateLedger checks every
//                          submission, problems go back verbatim, at most 3 tries
//   renderStatement        surviving, implemented obligations as plain bullets (no ids)
import { isSyntheticPrompt } from "../core/sessions.ts";
import type { AgentEvent } from "../core/types.ts";
import { extractJson } from "../judge/extract.ts";
import type { ChatProvider } from "../judge/providers.ts";
import { blockOverlap } from "./leakage.ts";
import { addedBlocks } from "./patch.ts";

export interface RequirementCandidate {
  eventId: string;
  ts: number;
  kind: "user" | "approved-proposal";
  text: string;
}

export interface LedgerObligation {
  id: string;
  text: string;
  /** Event ids the obligation comes from. */
  evidence: string[];
  status: "surviving" | "superseded";
  /** The obligation that replaced this one. */
  supersededBy?: string;
}

export interface Ledger {
  obligations: LedgerObligation[];
  /** Obligations the session discussed but did not build (left out of the statement). */
  notImplemented: string[];
}

export class StatementError extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[]) {
    super(message);
    this.name = "StatementError";
    this.problems = problems;
  }
}

/** A message under this many characters that is only an acknowledgement carries no requirement. */
export const ACK_MAX = 40;
/** Pure acknowledgements: ok, yes, continue, go on, thanks, lgtm, proceed, y. */
export const ACK_RE = /^\s*(?:ok(?:ay)?|k|yes|yep|yeah|y|continue|go on|thanks?(?: you)?|thx|ty|lgtm|proceed|cool|great|nice)(?:[\s,]+(?:thanks?|please|go on|continue))?\s*[.!]*\s*$/i;
const APPROVE = String.raw`yes|yep|yeah|do it|sounds good(?: to me)?|go ahead|approved?|please do|let'?s do it|ship it`;
const COURTESY = String.raw`ok(?:ay)?|please|thanks?(?: you)?|thx|ty`;
/**
 * A bare approval of the assistant's last proposal: nothing but approval words (yes, do it,
 * sounds good, go ahead, approved), courtesy words (ok, please, thanks) and punctuation.
 * "ok" and "thanks" alone are acknowledgements, not approvals (see isBareApproval).
 */
export const APPROVAL_RE = new RegExp(String.raw`^[\s,.!;:]*(?:(?:${APPROVE}|${COURTESY})(?:[\s,.!;:]+|$))+$`, "i");
const APPROVE_WORD_RE = new RegExp(String.raw`\b(?:${APPROVE})\b`, "i");
/**
 * A reply that opens with an approval and goes on: "yes, but call it goodbye instead".
 * After yes/yep/yeah anything may follow. The other phrases are also plain imperatives
 * ("do it again for shout.js"), so they count only before punctuation or a conjunction.
 */
const APPROVAL_HEAD_RE = new RegExp(String.raw`^\s*(?:(?:yes|yep|yeah)\b|(?:ok(?:ay)?[\s,!.]*)?(?:${APPROVE})(?=\s*[,.!;:]|\s+(?:but|and|except|though|however|just|only|with)\b))`, "i");
/** Text a harness injects as a user turn: compaction summaries and slash-command wrappers. */
const INJECTED_RE = /^\s*(?:This session is being continued from a previous conversation|<command-|Caveat: The messages below were generated)/;

const textOf = (e: AgentEvent): string | undefined => (typeof e.payload.text === "string" && e.payload.text.trim() ? e.payload.text.trim() : undefined);
const isAck = (t: string): boolean => t.length < ACK_MAX && ACK_RE.test(t);
const isBareApproval = (t: string): boolean => APPROVAL_RE.test(t) && APPROVE_WORD_RE.test(t);

/** Requirement sources in a session, in order. Pure. */
export function requirementCandidates(events: readonly AgentEvent[]): RequirementCandidate[] {
  const out: RequirementCandidate[] = [];
  let lastAssistant: AgentEvent | undefined;
  for (const e of events) {
    if (e.subagentId) continue;
    if (e.kind === "assistant.message" && textOf(e)) {
      lastAssistant = e;
      continue;
    }
    if (e.kind !== "user.message") continue;
    const text = textOf(e);
    if (!text || isSyntheticPrompt(text) || INJECTED_RE.test(text)) continue;
    const proposal = lastAssistant;
    lastAssistant = undefined;
    const bare = isBareApproval(text);
    if (proposal && (bare || APPROVAL_HEAD_RE.test(text))) {
      out.push({ eventId: proposal.id, ts: proposal.ts, kind: "approved-proposal", text: textOf(proposal)! });
      // A bare approval adds nothing of its own. One that goes on ("yes, but call it
      // goodbye instead") amends the proposal: the user's words stay, after it.
      if (bare || isAck(text)) continue;
    } else if (isAck(text)) continue;
    out.push({ eventId: e.id, ts: e.ts, kind: "user", text });
  }
  return out;
}

/** Offline ledger: one surviving obligation per candidate, in order. */
export function deterministicLedger(cands: readonly RequirementCandidate[]): LedgerObligation[] {
  return cands.map((c, i) => ({ id: `R${i + 1}`, text: c.text, evidence: [c.eventId], status: "surviving" }));
}

/** The statement the agent sees: surviving, implemented obligations as bullets, no ids. */
export function renderStatement(ledger: Ledger | readonly LedgerObligation[]): string {
  const l = Array.isArray(ledger) ? { obligations: ledger as LedgerObligation[], notImplemented: [] } : (ledger as Ledger);
  const skip = new Set(l.notImplemented);
  return l.obligations
    .filter((o) => o.status === "surviving" && !skip.has(o.id))
    .map((o) => `- ${o.text.replace(/\s*\n\s*/g, " ").trim()}`)
    .join("\n");
}

/** Leakage threshold: share of the reference's added 8-grams the statement may repeat. */
export const LEAK_MAX = 0.3;

/**
 * Deterministic checks on a ledger. Returns one message per problem (empty = ok).
 * `assistantIds`: every assistant.message id in the session, to tell unapproved
 * assistant text from an id that doesn't exist.
 */
export function validateLedger(ledger: Ledger, cands: readonly RequirementCandidate[], refPatch?: string, assistantIds: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  const byId = new Map(cands.map((c) => [c.eventId, c]));
  const ids = new Set<string>();
  if (!ledger.obligations.length) problems.push("the ledger has no obligations");
  for (const o of ledger.obligations) {
    if (ids.has(o.id)) problems.push(`duplicate obligation id ${o.id}`);
    ids.add(o.id);
  }
  for (const o of ledger.obligations) {
    if (!o.text.trim()) problems.push(`${o.id} has no text`);
    if (!o.evidence.length) problems.push(`${o.id} cites no evidence: every obligation cites the event ids it comes from`);
    for (const ev of o.evidence) {
      if (byId.has(ev)) continue;
      if (assistantIds.has(ev)) problems.push(`${o.id} cites ${ev}, assistant text the user never approved: requirements come from the user's turns or approved proposals`);
      else problems.push(`${o.id} cites unknown event id ${ev}`);
    }
    if (o.status === "superseded") {
      if (!o.supersededBy) problems.push(`${o.id} is superseded but names no supersededBy`);
      else if (!ids.has(o.supersededBy)) problems.push(`${o.id} is superseded by ${o.supersededBy}, which is not in the ledger`);
      else if (o.supersededBy === o.id) problems.push(`${o.id} supersedes itself`);
    }
  }
  for (const id of ledger.notImplemented) if (!ids.has(id)) problems.push(`notImplemented names ${id}, which is not in the ledger`);
  if (refPatch) {
    const blocks = addedBlocks(refPatch);
    const o = blockOverlap(blocks, renderStatement(ledger));
    if (o.total && o.fraction >= LEAK_MAX) problems.push(`the statement repeats ${Math.round(o.fraction * 100)}% of the reference patch's code (8-token runs): describe behaviour, never copy identifiers or code from it`);
  }
  return problems;
}

const SYSTEM = `You turn a coding session's conversation into a requirement ledger for an evaluation task.
Rules:
- Requirements come only from the developer's messages and from assistant proposals the developer explicitly approved. Never invent one.
- Write a flat list of atomic obligations: one checkable behaviour each, in plain words.
- Every obligation cites the event ids it comes from ("evidence").
- When a later message changes or replaces an earlier requirement, keep the earlier one with status "superseded" and "supersededBy" set to the obligation that replaced it.
- The reference patch, when given, is only for deciding which discussed behaviours were completed: list those that were not in "notImplemented". Never copy identifiers, file names or code from it.
Reply with JSON only: {"obligations": [{"id": "R1", "text": "...", "evidence": ["<event id>"], "status": "surviving" | "superseded", "supersededBy": "R3"}], "notImplemented": ["R2"]}`;

export const LEDGER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    obligations: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, status: { type: "string", enum: ["surviving", "superseded"] }, supersededBy: { type: "string" } },
        required: ["id", "text", "evidence", "status"],
      },
    },
    notImplemented: { type: "array", items: { type: "string" } },
  },
  required: ["obligations", "notImplemented"],
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A model reply as a ledger, or a problem message. */
export function parseLedger(text: string): Ledger | string {
  const v = extractJson(text, { accept: (x) => isObj(x) && Array.isArray(x.obligations) });
  if (!isObj(v) || !Array.isArray(v.obligations)) return "the reply had no JSON ledger ({\"obligations\": [...], \"notImplemented\": [...]})";
  const obligations: LedgerObligation[] = [];
  for (const [i, raw] of v.obligations.entries()) {
    if (!isObj(raw)) return `obligations[${i}] is not an object`;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `R${i + 1}`;
    const status = raw.status === "superseded" ? "superseded" : "surviving";
    const evidence = Array.isArray(raw.evidence) ? raw.evidence.filter((x): x is string => typeof x === "string") : [];
    obligations.push({ id, text: typeof raw.text === "string" ? raw.text.trim() : "", evidence, status, ...(typeof raw.supersededBy === "string" && raw.supersededBy ? { supersededBy: raw.supersededBy } : {}) });
  }
  const notImplemented = Array.isArray(v.notImplemented) ? v.notImplemented.filter((x): x is string => typeof x === "string") : [];
  return { obligations, notImplemented };
}

export interface DraftStatementOpts {
  candidates: readonly RequirementCandidate[];
  referencePatchText?: string;
  provider: ChatProvider;
  /** Every assistant.message id in the session (see validateLedger). */
  assistantIds?: ReadonlySet<string>;
  maxSubmissions?: number;
  signal?: AbortSignal;
}

export interface DraftedStatement {
  ledger: Ledger;
  statement: string;
  /** Submissions it took (1 = the first was accepted). */
  submissions: number;
  /** Problems of the rejected submissions, in order. */
  rejected: string[][];
}

/** Ask `provider` for a ledger until one passes validateLedger (at most maxSubmissions, default 3). */
export async function draftStatement(o: DraftStatementOpts): Promise<DraftedStatement> {
  const max = o.maxSubmissions ?? 3;
  if (!o.candidates.length) throw new StatementError("the session has no user requirements to build a statement from", []);
  const turns = o.candidates.map((c) => `[${c.eventId}] ${c.kind === "user" ? "developer" : "assistant proposal, approved by the developer"}:\n${c.text}`).join("\n\n");
  const base = `Conversation turns (event id in brackets):\n\n${turns}${o.referencePatchText ? `\n\nReference patch (use only to decide which discussed behaviours were completed; never copy identifiers):\n${o.referencePatchText.slice(0, 20_000)}` : ""}`;
  const rejected: string[][] = [];
  for (let n = 1; n <= max; n++) {
    const last = rejected.at(-1);
    const user = last ? `${base}\n\nYour previous ledger was rejected. Fix these problems and reply with the whole ledger again:\n${last.map((p) => `- ${p}`).join("\n")}` : base;
    const r = await o.provider.complete({ system: SYSTEM, user, jsonSchema: LEDGER_SCHEMA, ...(o.signal ? { signal: o.signal } : {}) });
    const parsed = parseLedger(r.text);
    const problems = typeof parsed === "string" ? [parsed] : validateLedger(parsed, o.candidates, o.referencePatchText, o.assistantIds);
    if (!problems.length && typeof parsed !== "string") return { ledger: parsed, statement: renderStatement(parsed), submissions: n, rejected };
    rejected.push(problems);
  }
  throw new StatementError(`${o.provider.name} ${o.provider.model}: no valid ledger in ${max} submissions: ${rejected.at(-1)!.join("; ")}`, rejected.at(-1)!);
}
