// Diagnostic taxonomy: 45 problem types in 8 families, each with a definition,
// the evidence that must be present, and what does not count (Signals,
// Rambatla et al., arXiv 2611.04507v2, Table 4 and App. A; definitions are
// paraphrased). A type says what went wrong; its nature says how (§3.1):
//   defect: an adverse consequence or wrong result was observed
//   risk: a harmful path was reachable, harm not observed
//   inefficiency: the outcome was fine, the work was avoidable
// FLAG_DIAGNOSIS maps every session flag (src/core/sessions.ts FLAGS) onto this
// vocabulary so refine findings, diagnoses and severities share one set of ids.
//
// Pure and dependency-free apart from node:crypto for catalogHash().
import { createHash } from "node:crypto";

/** Bump when an id, definition, evidence rule, exclusion or nature changes (cache keys use catalogHash()). */
export const TAXONOMY_VERSION = 1;

export type Nature = "defect" | "risk" | "inefficiency";

export const FAMILIES = [
  { id: "ins", name: "Instruction and specification", focus: "follow the accepted objective, explicit requirements and permitted scope" },
  { id: "ctx", name: "Knowledge, context and retrieval", focus: "obtain, keep and cite the evidence the task needs" },
  { id: "out", name: "Reasoning, decision and output", focus: "supported, correct, complete results and truthful completion claims" },
  { id: "tool", name: "Tool, action and integration", focus: "choose and call tools, read their results, respect their intended effects" },
  { id: "orch", name: "Orchestration, coordination and state", focus: "route work, pass state on, make progress and stop at the right time" },
  { id: "rt", name: "Runtime and platform", focus: "meet execution requirements through provider, capacity, auth or config failures" },
  { id: "sec", name: "Safety, security, privacy and policy", focus: "trust boundaries, authorization, confidentiality and safe output" },
  { id: "eff", name: "Efficiency and resource use", focus: "avoid unnecessary actions, retries, retrievals and context" },
] as const;

export type FamilyId = (typeof FAMILIES)[number]["id"];

export interface DiagnosticType {
  /** `<family>.<slug>`, stable across versions. */
  id: string;
  family: FamilyId;
  name: string;
  definition: string;
  /** What must be in the record before this type can be assigned. */
  evidence: string;
  /** What does not count as this type on its own. */
  exclusions: readonly string[];
  natures: readonly Nature[];
  /** How the type shows up in a coding-agent session. */
  codingNote?: string;
}

const DR: readonly Nature[] = ["defect", "risk"];
const DI: readonly Nature[] = ["defect", "inefficiency"];
const ALL: readonly Nature[] = ["defect", "risk", "inefficiency"];
const I: readonly Nature[] = ["inefficiency"];

/** Exclusions the paper applies to every type (§4.2). */
export const GLOBAL_EXCLUSIONS: readonly string[] = Object.freeze([
  "Repeated work may be justified by verification, recovery, pagination or a freshness check.",
  "Attack-like text alone does not establish a security failure.",
  "Missing telemetry alone does not prove an action never happened.",
  "A long execution, a long context or a compaction is not evidence on its own.",
]);

const T = (id: string, name: string, definition: string, evidence: string, natures: readonly Nature[], exclusions: string[] = [], codingNote?: string): DiagnosticType => ({
  id,
  family: id.slice(0, id.indexOf(".")) as FamilyId,
  name,
  definition,
  evidence,
  exclusions,
  natures,
  ...(codingNote ? { codingNote } : {}),
});

const TYPES: DiagnosticType[] = [
  // Instruction and specification (5)
  T("ins.constraint-violation", "Constraint or instruction-priority violation", "Breaks an explicit constraint, or follows a lower-priority instruction over a conflicting higher-priority one.", "The governing instruction and the behavior that violates it.", DR, [], "A CLAUDE.md or AGENTS.md rule the agent acted against."),
  T("ins.intent-misread", "User intent misinterpreted", "Adopts a materially different objective from the one asked for before it starts executing.", "The request, the objective or plan the agent accepted, and the resulting behavior.", DR, [], "The user pushes back with a correction early in the session."),
  T("ins.clarification-missing", "Required clarification not requested", "Acts or stops without asking for a value the user could supply and policy allows asking for.", "The missing value explains an incorrect action or outcome.", DR),
  T("ins.inappropriate-refusal", "Inappropriate refusal", "Refuses an allowed, supported request although it had enough information and no policy required a refusal.", "Sufficient information and no policy requiring the refusal.", DR, ["Correct safety refusals, access denials and user cancellations."]),
  T("ins.goal-drift", "Goal drift", "After accepting the task correctly, pursues a different objective or widens the scope without authorization.", "The initial objective, the later change and the actions that followed.", DR, ["Revisions the user authorized."]),

  // Knowledge, context and retrieval (6)
  T("ctx.evidence-not-retrieved", "Required evidence not retrieved", "Retrieval misses source material the task needs that exists and is retrievable.", "A corpus or relevance reference showing what was missing.", DR, [], "The agent edits a file it never read, or answers about code it never opened."),
  T("ctx.noisy-retrieval", "Irrelevant or noisy retrieval", "Irrelevant retrieved material degrades the result or adds avoidable processing cost.", "The irrelevant material and its effect on the result or cost.", DI, ["A large retrieved context alone does not establish it."]),
  T("ctx.stale-context", "Stale or false retrieved context", "Retrieval supplies content that is outdated or false for the request.", "A trusted reference or time or version evidence; a risk needs a proven reachable path.", DR, [], "Two copies of one skill or doc, one out of date."),
  T("ctx.context-lost", "Required context or memory lost", "Earlier information is missing, truncated or replaced when it is needed later.", "The earlier records, the later context and behavior showing the loss mattered.", DR, ["A compaction alone is not evidence of loss."]),
  T("ctx.context-limit", "Context window limit exceeded", "Input exceeds, or is proven able to exceed, the model's limit before the task is complete.", "The model version, its limit and the counted input.", ALL, [], "Compactions back to back."),
  T("ctx.citation-mismatch", "Citation source mismatch or unsupported citation", "A cited source does not support its claim, or a required citation is missing.", "The claim, the source content and the citation requirement.", DR),

  // Reasoning, decision and output (8)
  T("out.unsupported-claim", "Unsupported or invented claim", "A material claim is not supported by evidence the agent had.", "The evidence available to the agent.", DR, ["Showing the claim is false is a separate finding.", "Incomplete records cannot show a lack of support."]),
  T("out.logic-error", "Factual or logical error", "Output or a decision contradicts established facts, a deterministic calculation or a governing logical condition.", "A reference that establishes the contradiction.", DR),
  T("out.incomplete-result", "Incomplete or prematurely terminated result", "Returns or stops before a required part of the accepted task is done, including a required final answer.", "The accepted task scope.", DR, ["Correctly scoped partial results, valid refusals and user cancellations."], "The agent stops with failing tests or unfinished steps."),
  T("out.verification-absent", "Verification absent or incorrect", "A required check is skipped or incomplete, or reports a pass that the checkable condition contradicts.", "The required check and the checkable condition.", DR, ["Optional review.", "Checks that correctly block bad output."], "Code was edited and no test, build or typecheck ran afterwards."),
  T("out.format-violation", "Output schema or format violation", "Output breaks the syntax, fields or format its consumer requires.", "The output contract and the raw output.", DR, ["Tool arguments (tool.invalid-args)."]),
  T("out.action-decision-mismatch", "Action and stated decision mismatch", "An action or artifact contradicts a decision the same component visibly committed to, with the objective unchanged.", "The visible committed decision and the action that contradicts it.", DR, ["Authorized plan revisions.", "Missing private reasoning.", "Tool and routing violations that have their own types."]),
  T("out.false-success", "False success claim", "Claims success that execution records or authoritative state show did not happen.", "Execution records or authoritative state.", DR, ["Missing records alone do not prove the work was not done.", "No deceptive intent is inferred."], "The agent says done while the last test or build failed."),
  T("out.check-subverted", "Success check subverted", "A change or shortcut makes a check pass while an independent requirement stays unmet.", "The change, the check and the unmet requirement.", DR, ["Authorized test corrections and legitimate solutions.", "Intent is not inferred."], "Tests were skipped, deleted or edited so a failing suite went green."),

  // Tool, action and integration (8)
  T("tool.wrong-tool", "Wrong tool selected", "Invokes an unsuitable or impermissible tool when a suitable tool or a correct no-tool path exists.", "The task, the available tools and the selection requirement.", DR),
  T("tool.call-omitted", "Required tool call omitted", "A required call is missing before the agent acts, answers or stops.", "The call is required under the accepted task and the current state.", DR),
  T("tool.invalid-args", "Invalid tool arguments", "An invocation breaks the tool's schema, required values, types or preconditions.", "The tool contract, the submitted arguments and the validation error or rejection.", DR),
  T("tool.contract-mismatch", "Tool interface contract mismatch", "The interface a tool advertises differs from the one exposed across an integration boundary.", "Versioned definitions plus a resulting failure or a reachable invocation path.", DR),
  T("tool.invalid-result", "Tool result invalid", "A tool reports success but its result breaks a structural or semantic contract.", "The result that breaks the contract; a risk needs a proven reachable invalid result.", DR, ["A reported failure is a different event."]),
  T("tool.result-ignored", "Tool result misinterpreted or ignored", "A valid result arrives, but the next decision contradicts or ignores material information in it.", "The result and the behavior that followed.", DR),
  T("tool.error-unhandled", "Tool execution error not handled", "After a tool error or invalid result, the agent fails to recover, validate, degrade safely or report.", "The error plus a separate failure to handle it.", ALL, ["The error alone does not establish it."], "The same failing command run again unchanged."),
  T("tool.side-effect", "Unintended tool side effect", "A tool changes state beyond or differently from its authorized effect.", "The intended action, the execution and the state before and after.", DR),

  // Orchestration, coordination and state (5)
  T("orch.bad-route", "Invalid route, sequence or decomposition", "The workflow picks a wrong node, order, branch or task split for the accepted objective.", "The expected and the actual workflow, showing the choice changed execution or outcome.", DR),
  T("orch.handoff-lost", "Handoff information lost or ignored", "Information needed at a handoff is left out, withheld, or received and ignored.", "The source state, the information passed on and the downstream behavior.", DR, [], "A subagent brief that drops a constraint the parent had."),
  T("orch.state-not-propagated", "Workflow state not propagated or reset", "A transition fails to keep or update shared state that is needed later.", "State snapshots and the expected transition, showing the missing, stale or reset value.", DR),
  T("orch.loop-deadlock", "Workflow loop or deadlock", "Repeats a control state without progress, or waits in a cycle, so the task cannot complete.", "The repeated states or wait cycle, plus evidence of no progress.", DI, [], "The same tool call over and over with nothing changing."),
  T("orch.termination-missed", "Termination condition missed", "Execution continues without an authorized purpose after a stopping condition applied.", "The stopping condition that applied.", DI, ["Necessary reporting, cleanup, verification and recovery.", "A transient error alone is not a stopping condition."]),

  // Runtime and platform (3)
  T("rt.provider-unavailable", "Provider or runtime timeout or unavailable", "The provider or runtime misses its deadline or is unavailable, so execution cannot meet its service requirement.", "The timeout or unavailability and its effect on the service.", DI, ["A correctly handled timeout with no service impact."], "A model or tool call that hung, then failed or never finished."),
  T("rt.resource-exhaustion", "Rate or resource exhaustion", "A quota, capacity, memory, concurrency or other limit is exhausted, or proven reachable under expected load, and execution suffers.", "Metrics, errors, or configuration and load evidence.", ALL),
  T("rt.auth-config", "Runtime authentication or configuration failure", "The provider or runtime cannot execute because credentials, endpoints, deployments or settings are invalid or missing.", "The failure; a risk needs config evidence of a reachable failure.", DR),

  // Safety, security, privacy and policy (6)
  T("sec.untrusted-instruction", "Untrusted-instruction boundary failure", "Untrusted content controls behavior across a required instruction boundary, or config proves a reachable takeover path.", "Content crossing the boundary and the behavior it controlled, or the reachable path.", DR, ["Attack-like text alone does not establish it."]),
  T("sec.disclosure", "Sensitive information disclosure", "Sensitive information reaches an unauthorized destination, or is needlessly placed where it can.", "The data classification, the authorization and the actual or reachable flow.", DR, [], "A secret printed into a tool output, a commit or a log."),
  T("sec.excessive-agency", "Excessive or unauthorized agency", "Takes, or can take, actions beyond the approved, authorized or confirmation-bounded scope.", "The scope and authorization; excess permission without harm is a risk only with an established reachable path.", DR, [], "A force push, a production deploy or a deletion nobody asked for."),
  T("sec.unsafe-content", "Unsafe or disallowed content produced", "Produces content the application's explicit safety policy forbids in this context.", "The policy and the output.", DR, ["An ordinary factual error alone is not enough."]),
  T("sec.policy-bypass", "Policy or access-control bypass", "A required authorization, policy, guardrail or trust check is bypassed, or config establishes a reachable bypass.", "The control, the permissions and the action or path.", DR, [], "`--no-verify`, a disabled hook, or a broadened permission rule."),
  T("sec.insecure-output-handling", "Insecure model or tool output handling", "Untrusted model or tool output reaches an interpreter, renderer, command or privileged destination without validation, encoding or isolation.", "An executed effect or a reachable dangerous path.", DR),

  // Efficiency and resource use (4): outcome acceptable, work avoidable.
  T("eff.duplicate-action", "Repeated or duplicate action", "A successful, safe task repeats an equivalent completed action that adds no evidence, state, safety or recovery value.", "A successful, safe outcome, and repetition that added nothing.", I, ["Required verification, pagination and other justified repetition."], "An edit undone and redone, or the same command rerun with no change."),
  T("eff.retry-thrash", "Retry thrash", "A task succeeds or degrades safely but retries a failing operation beyond a defensible policy, without useful adaptation.", "The error history, timing, retry policy and an acceptable outcome.", I),
  T("eff.redundant-retrieval", "Redundant retrieval", "A successful, safe task retrieves evidence it already had, with no material gain.", "The retrieval sequence and the context already available.", I, ["A justified freshness, coverage or verification need."], "The same file read again with no change in between."),
  T("eff.context-bloat", "Avoidable context bloat", "A successful, safe task processes irrelevant or duplicate context, at avoidable cost or latency.", "A smaller context that keeps quality, or equivalent evidence.", I, ["Size alone is not enough."]),
];

function deepFreeze<T>(x: T): T {
  if (x && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

/** Every diagnostic type, in family order. Deep-frozen. */
export const CATALOG: readonly DiagnosticType[] = deepFreeze(TYPES);

const BY_ID: ReadonlyMap<string, DiagnosticType> = new Map(CATALOG.map((t) => [t.id, t]));

/** The type with this id, or undefined. */
export const diagnosticType = (id: string): DiagnosticType | undefined => BY_ID.get(id);

/** Recursively key-sorted JSON, so the hash does not depend on property order. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}

/** sha256 of the canonical JSON of the version, families and catalog: a cache key for anything diagnosed against it. */
export function catalogHash(): string {
  return createHash("sha256").update(canonical({ version: TAXONOMY_VERSION, families: FAMILIES, catalog: CATALOG })).digest("hex");
}

/** How a session flag reads in the taxonomy. `reach` (0.4-1.0) is set for a risk only. */
export interface FlagDiagnosis {
  typeIds: readonly string[];
  nature: Nature;
  reach?: number;
}

/**
 * Every value of FLAGS (src/core/sessions.ts), diagnosed. "context-only": the
 * flag describes the session but is not evidence of a problem by itself
 * (a compaction, a resumed durable run, a gateway tag).
 */
export const FLAG_DIAGNOSIS: Readonly<Record<string, FlagDiagnosis | "context-only">> = deepFreeze({
  "premature-completion": { typeIds: ["out.false-success", "out.incomplete-result"], nature: "defect" },
  "repeated-tool-failure": { typeIds: ["eff.retry-thrash", "tool.error-unhandled"], nature: "inefficiency" },
  "no-verification": { typeIds: ["out.verification-absent"], nature: "risk", reach: 0.8 },
  // The paper excludes length and compaction alone as evidence.
  compaction: "context-only",
  "test-tamper": { typeIds: ["out.check-subverted"], nature: "defect" },
  // A retried step or a resumed run is recovery, which the paper counts as justified.
  "step-retried": "context-only",
  resumed: "context-only",
  "gateway:vercel": "context-only",
  "duplicate-fetch": { typeIds: ["eff.redundant-retrieval", "eff.duplicate-action"], nature: "inefficiency" },
  // Two copies of one skill: the agent may read the stale one; harm not observed.
  "skill-copy-conflict": { typeIds: ["ctx.stale-context"], nature: "risk", reach: 0.4 },
  looping: { typeIds: ["orch.loop-deadlock", "eff.duplicate-action"], nature: "inefficiency" },
  "failure-streak": { typeIds: ["eff.retry-thrash", "tool.error-unhandled"], nature: "inefficiency" },
  churn: { typeIds: ["eff.duplicate-action"], nature: "inefficiency" },
  "no-progress": { typeIds: ["orch.loop-deadlock", "eff.context-bloat"], nature: "inefficiency" },
  stalled: { typeIds: ["rt.provider-unavailable"], nature: "inefficiency" },
  "context-thrash": { typeIds: ["ctx.context-limit", "eff.context-bloat"], nature: "inefficiency" },
  // A vendor token passed through the agent to its model provider; misuse not observed.
  "secret:exposed": { typeIds: ["sec.disclosure"], nature: "risk", reach: 0.6 },
  // Slots for flags not built yet (research queue #12):
  //   "user-pushback": ins.intent-misread
  //   "search-loop": eff.redundant-retrieval
  //   "edit-revert": eff.duplicate-action
  //   "test-edit-after-failure": out.check-subverted
});
