// Which captured sessions make good eval tasks? `rankEvalCandidates` reads each
// session (and its events) and either rejects it, with one reason, or scores it.
// Used by `coding.sh eval candidates`, `eval init --sessions` and the MCP tools
// eval_candidates and eval_init.
//
// A repo-replay task needs a pre-agent start state, a user prompt for the
// instruction, edits to compare against, and a check that can say pass or fail.
// The score favors sessions where the agent visibly went wrong (failure flags,
// the user pushing back) and that a command can verify (SWE-chat 2604.20779,
// SWE-Together 2606.29957: real failures make the most informative tasks).
//
// Hard rejects, first match wins:
//   subagent            the session is a subagent of another (Session.parent)
//   run                 a coding.sh eval or benchmark run (Session.runId)
//   no-git-start        no repo state at session start (no snapshot and no HEAD)
//   no-user-prompt      no user message with text: nothing to use as the instruction
//   no-edits            the agent changed no files
//   external-deliverable  most shell commands publish or deploy (gh, git push,
//                       kubectl, terraform, aws, gcloud, …): a replay can't check them
//
// Score (additive, constants in SCORE):
//   failure flags       premature-completion +2, repeated-tool-failure +2,
//                       no-verification +1, any other failure flag +1; at most +5
//   tests still failing +1 (stats.testsFailed > 0)
//   pushback            +3 per follow-up prompt that corrects the agent, at most +6
//   verifier guessable  +2 when the agent ran a test command (verifierGuess)
//   test edit after a failing test run  +1 (the agent may have bent the test)
//   multi-turn          +1 with 2 or more user messages
//   compaction          −1 (long context: harder to replay faithfully)
//   size                −1 over 300 tool calls
//   recency             +1 when it started within the last 7 days
// Ties: newer first, then id.
import { isPlumbing, shellParts } from "../core/failing-command.ts";
import { failureFlags, FLAGS } from "../core/sessions.ts";
import type { AgentEvent, Session } from "../core/types.ts";
import { isPushback } from "../mcp/data.ts";
import { isTestPath } from "./impossible.ts";
import { extractTestCommand, guessVerifierFromEvents, shellCommandOf } from "./task.ts";

export type CandidateReject = "subagent" | "run" | "no-git-start" | "no-user-prompt" | "no-edits" | "external-deliverable";

export const CANDIDATE_REJECTS: readonly CandidateReject[] = ["subagent", "run", "no-git-start", "no-user-prompt", "no-edits", "external-deliverable"];

/** Score constants (see the file header). */
export const SCORE = {
  flag: { [FLAGS.prematureCompletion]: 2, [FLAGS.repeatedToolFailure]: 2, [FLAGS.noVerification]: 1 } as Record<string, number>,
  otherFlag: 1,
  flagCap: 5,
  testsFailing: 1,
  pushback: 3,
  pushbackCap: 6,
  verifier: 2,
  testEditAfterFailure: 1,
  multiTurn: 1,
  compaction: -1,
  big: -1,
  bigToolCalls: 300,
  recent: 1,
  recentMs: 7 * 86_400_000,
} as const;

export interface CandidateItem {
  session: Session;
  events: readonly AgentEvent[];
}

export interface Candidate {
  sessionId: string;
  agent: string;
  title?: string;
  startedAt: number;
  eligible: boolean;
  /** Why it can't become a task (eligible false). */
  reject?: CandidateReject;
  score: number;
  /** What made up the score, e.g. "+2 premature-completion". */
  reasons: string[];
  /** Failure flags (tags left out). */
  flags: string[];
  /** The last test command the agent ran: a verifier to start from. */
  verifierGuess?: string;
  /** Follow-up prompts that read as the user correcting the agent. */
  pushback: number;
  userMessages: number;
}

export interface RankOpts {
  /** For the recency bonus (default Date.now()). */
  now?: number;
  /** Keep at most this many (after sorting). */
  limit?: number;
  /** Leave rejected sessions out of the result. */
  eligibleOnly?: boolean;
}

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch", "applypatch", "str_replace_editor", "str_replace_based_edit_tool", "edit_file", "write_file", "replace", "create_file", "patch"]);
const DELIVER_PROGS = new Set(["gh", "kubectl", "terraform", "aws", "gcloud", "az", "vercel", "wrangler", "flyctl", "fly", "heroku", "helm", "docker", "netlify", "firebase", "pulumi"]);
const DELIVER_GIT = new Set(["push", "tag"]);
const DELIVER_NPM = new Set(["publish", "deploy"]);

const text = (e: AgentEvent): string | undefined => (typeof e.payload.text === "string" && e.payload.text.trim() ? e.payload.text : undefined);

function startRepo(session: Session, events: readonly AgentEvent[]): boolean {
  const repo = events.find((e) => e.kind === "session.start" && e.repo)?.repo ?? session.repo;
  return !!repo && !!repo.root && !!(repo.snapshot || repo.head);
}

function edited(session: Session, events: readonly AgentEvent[]): boolean {
  if ((session.stats.filesChanged ?? 0) > 0) return true;
  return events.some((e) => e.kind === "file.change" || (e.kind === "tool.start" && EDIT_TOOLS.has(String(e.payload.tool ?? "").toLowerCase())));
}

/** True when a shell command publishes or deploys rather than changing the repo. */
export function isDeliveryCommand(cmd: string): boolean {
  return shellParts(cmd).some((p) => {
    const prog = p.prog;
    if (!prog || isPlumbing(prog)) return false;
    const sub = p.argv[1];
    if (prog === "git") return DELIVER_GIT.has(sub ?? "");
    if (prog === "npm" || prog === "pnpm" || prog === "yarn") return DELIVER_NPM.has(sub ?? "");
    if (prog === "docker") return sub === "push";
    return DELIVER_PROGS.has(prog);
  });
}

function editPaths(e: AgentEvent): string[] {
  if (e.kind === "file.change") return typeof e.payload.path === "string" ? [e.payload.path] : [];
  if (e.kind !== "tool.start" || !EDIT_TOOLS.has(String(e.payload.tool ?? "").toLowerCase())) return [];
  const input = e.payload.input;
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const p = o.file_path ?? o.path ?? o.filePath ?? o.notebook_path;
  return typeof p === "string" ? [p] : [];
}

/** A test file edited after a test run failed: the agent may have bent the test to pass. */
function testEditAfterFailure(events: readonly AgentEvent[]): boolean {
  const testIds = new Set<string>();
  let failed = false;
  for (const e of events) {
    if (e.kind === "tool.start") {
      const c = shellCommandOf(e);
      if (c && extractTestCommand(c) && typeof e.payload.toolUseId === "string") testIds.add(e.payload.toolUseId);
    }
    if (e.kind === "tool.end" && e.payload.ok === false && testIds.has(String(e.payload.toolUseId))) failed = true;
    if (e.kind === "test.result" && Number(e.payload.failed) > 0) failed = true;
    if (failed && editPaths(e).some((p) => isTestPath(p.replace(/\\/g, "/")))) return true;
  }
  return false;
}

/** Score or reject one session. Pure: reads only its arguments. */
export function scoreCandidate(item: CandidateItem, now = Date.now()): Candidate {
  const { session: s, events } = item;
  const prompts = events.filter((e) => e.kind === "user.message").map(text).filter((t): t is string => !!t);
  const flags = failureFlags(s.flags);
  const base = { sessionId: s.id, agent: s.agent, ...(s.title ? { title: s.title } : {}), startedAt: s.startedAt, flags, userMessages: prompts.length };
  const reject = (r: CandidateReject): Candidate => ({ ...base, eligible: false, reject: r, score: 0, reasons: [], pushback: 0 });
  if (s.parent) return reject("subagent");
  if (s.runId || events.some((e) => e.runId)) return reject("run");
  if (!startRepo(s, events)) return reject("no-git-start");
  if (!prompts.length) return reject("no-user-prompt");
  if (!edited(s, events)) return reject("no-edits");
  const shell = events.map(shellCommandOf).filter((c): c is string => !!c);
  if (shell.length >= 2 && shell.filter(isDeliveryCommand).length * 2 >= shell.length) return reject("external-deliverable");

  const reasons: string[] = [];
  let score = 0;
  const add = (n: number, why: string) => {
    if (!n) return;
    score += n;
    reasons.push(`${n > 0 ? "+" : ""}${n} ${why}`);
  };
  let flagPts = 0;
  for (const f of flags) {
    const n = Math.min(SCORE.flag[f] ?? SCORE.otherFlag, SCORE.flagCap - flagPts);
    if (n <= 0) break;
    flagPts += n;
    add(n, f);
  }
  if ((s.stats.testsFailed ?? 0) > 0) add(SCORE.testsFailing, "tests still failing");
  const pushback = prompts.slice(1).filter(isPushback).length;
  if (pushback) add(Math.min(pushback * SCORE.pushback, SCORE.pushbackCap), `pushback ×${pushback}`);
  const verifierGuess = guessVerifierFromEvents(events, events.find((e) => e.repo)?.repo?.root ?? s.repo?.root);
  if (verifierGuess) add(SCORE.verifier, "verifier guessable");
  if (testEditAfterFailure(events)) add(SCORE.testEditAfterFailure, "test edited after a failing run");
  if (prompts.length >= 2) add(SCORE.multiTurn, "multi-turn");
  if (s.flags.includes(FLAGS.compaction) || events.some((e) => e.kind === "context.compact")) add(SCORE.compaction, "compaction");
  if (s.stats.toolCalls > SCORE.bigToolCalls) add(SCORE.big, `over ${SCORE.bigToolCalls} tool calls`);
  if (now - s.startedAt <= SCORE.recentMs) add(SCORE.recent, "last 7 days");
  return { ...base, eligible: true, score, reasons, pushback, ...(verifierGuess ? { verifierGuess } : {}) };
}

/** Eligible sessions first, by score, then newest, then id. */
export function rankEvalCandidates(items: readonly CandidateItem[], opts: RankOpts = {}): Candidate[] {
  const now = opts.now ?? Date.now();
  const all = items.map((i) => scoreCandidate(i, now)).filter((c) => !opts.eligibleOnly || c.eligible);
  all.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || b.startedAt - a.startedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return opts.limit !== undefined ? all.slice(0, opts.limit) : all;
}

/** "2 subagent, 1 no-git-start": rejected sessions by reason. */
export function rejectSummary(cands: readonly Candidate[]): string {
  const counts = new Map<string, number>();
  for (const c of cands) if (c.reject) counts.set(c.reject, (counts.get(c.reject) ?? 0) + 1);
  return CANDIDATE_REJECTS.filter((r) => counts.has(r))
    .map((r) => `${counts.get(r)} ${r}`)
    .join(", ");
}

/** A plain-text table: rank, score, session, why. */
export function formatCandidates(cands: readonly Candidate[]): string {
  if (!cands.length) return "No candidate sessions";
  const lines: string[] = [];
  for (const [i, c] of cands.entries()) {
    const title = (c.title ?? "").replace(/\s+/g, " ").trim();
    const head = c.eligible ? `${String(i + 1).padStart(2)}. ${String(c.score).padStart(3)}  ${c.sessionId}` : `    rej  ${c.sessionId}`;
    lines.push(`${head}  ${title.length > 60 ? `${title.slice(0, 59)}…` : title}`);
    lines.push(`         ${c.eligible ? c.reasons.join(", ") || "no signals" : `rejected: ${c.reject}`}${c.verifierGuess ? `  · verifier: ${c.verifierGuess}` : ""}`);
  }
  return lines.join("\n");
}

/** Sessions `eval init --sessions` and `eval candidates` read events for, newest first. */
export const CANDIDATE_POOL = 200;

/** Load each session's events and rank them. */
export async function rankSessions(index: { listEvents(sessionId: string): Promise<AgentEvent[]> }, sessions: readonly Session[], opts: RankOpts = {}): Promise<Candidate[]> {
  const items: CandidateItem[] = [];
  for (const session of sessions) items.push({ session, events: await index.listEvents(session.id) });
  return rankEvalCandidates(items, opts);
}
