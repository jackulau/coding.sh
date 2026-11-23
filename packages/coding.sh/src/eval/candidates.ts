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
//   run                 ran with a run id (Session.runId, CODING_SH_RUN_ID), as eval, compare,
//                       exp and bench trials do
//   wrapped             a `coding.sh run --` wrapper around another agent's session, which
//                       records the same work (rankSessions checks; see sessionInside)
//   no-git-start        no repo state at session start (no snapshot and no HEAD)
//   repo-gone           the repository is not on this machine and this store holds no
//                       readable copy of its start (rankSessions checks; see startReadable)
//   no-user-prompt      no user message with text, and no prompt argument in a wrapped
//                       command (commandPrompt): nothing to use as the instruction
//   no-edits            the agent changed no files
//   external-deliverable  most shell commands publish or deploy (gh, git push,
//                       kubectl, terraform, aws, gcloud, …): a replay can't check them
//
// Score (additive, constants in SCORE):
//   failure flags       premature-completion +2, repeated-tool-failure +2,
//                       no-verification +1, any other failure flag +1; at most +5
//   tests still failing +1 (stats.testsFailed > 0, or the last test command the agent ran failed)
//   pushback            +3 per follow-up prompt that corrects the agent, at most +6
//   verifier guessable  +2 when the agent ran a test command (verifierGuess)
//   test edit after a failing test run  +1 (the agent may have bent the test)
//   multi-turn          +1 with 2 or more user messages
//   compacted context   −1 (long context: harder to replay faithfully). Labeled apart from
//                       the compaction failure flag, which scores +1 above as any other flag.
//   size                −1 over 300 tool calls
//   recency             +1 when it started within the last 7 days
// Ties: newer first, then id.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isPlumbing, shellParts } from "../core/failing-command.ts";
import { isPushback } from "../core/pushback.ts";
import { failureFlags, FLAGS } from "../core/sessions.ts";
import type { AgentEvent, Session, SessionFilter } from "../core/types.ts";
import { isTestPath } from "./impossible.ts";
import { extractTestCommand, guessVerifierFromEvents, instructionFromArgs, shellCommandOf } from "./task.ts";

export type CandidateReject = "subagent" | "run" | "wrapped" | "no-git-start" | "repo-gone" | "no-user-prompt" | "no-edits" | "external-deliverable";

export const CANDIDATE_REJECTS: readonly CandidateReject[] = ["subagent", "run", "wrapped", "no-git-start", "repo-gone", "no-user-prompt", "no-edits", "external-deliverable"];

/** Each reject after a count, for one session and for more: "2 that changed no files". */
const REJECT_COUNTED: Record<CandidateReject, readonly [string, string]> = {
  subagent: ["subagent", "subagents"],
  run: ["with a run id (CODING_SH_RUN_ID)", "with a run id (CODING_SH_RUN_ID)"],
  wrapped: ["that wrapped another session", "that wrapped other sessions"],
  "no-git-start": ["with no git state at its start", "with no git state at their start"],
  "repo-gone": ["whose repository is gone", "whose repositories are gone"],
  "no-user-prompt": ["with no user prompt", "with no user prompt"],
  "no-edits": ["that changed no files", "that changed no files"],
  "external-deliverable": ["that mostly publishes or deploys", "that mostly publish or deploy"],
};

/** Why a session can't become a task, in words, and what would change that where something can. */
export function rejectReason(c: Pick<Candidate, "reject" | "gone" | "wrapped">): string {
  switch (c.reject) {
    case "subagent":
      return "a subagent's session: the session that started it is the one to use";
    case "run":
      return "it ran with a run id (CODING_SH_RUN_ID), as eval, compare, exp and bench trials do, and trials are left out";
    case "wrapped":
      return `it wrapped session ${(c.wrapped ?? "").slice(0, 8)}, which recorded the same work: that session is the one to use`;
    case "no-git-start":
      return `no git commit was recorded at its start (read from a transcript, or not in a git repository), so its start can't be rebuilt${c.gone ? `, and its folder ${c.gone} is not on this machine` : ""}`;
    case "repo-gone":
      return `its repository${c.gone ? ` ${c.gone}` : ""} is not on this machine, so its start can't be rebuilt: put the repository back at that path to use it`;
    case "no-user-prompt":
      return "no prompt from the user to use as the instruction (eval new --instruction can give it one)";
    case "no-edits":
      return "the agent changed no files, so there is no change to check";
    case "external-deliverable":
      return "most of its commands publish or deploy (git push, gh, kubectl and the like), which a replay can't check";
    default:
      return "";
  }
}

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
  /**
   * Set by rankSessions when it compared the files of the start state (snapshot or HEAD) and the end
   * snapshot: true when they differ, false when they are the same. Unset, two snapshot ids that differ
   * count as an edit.
   */
  snapshotChanged?: boolean;
  /** Set by rankSessions: the folder the session ran in, when neither it nor a readable copy of its start is on this machine. */
  gone?: string;
  /** Set by rankSessions: the session another agent recorded inside this `coding.sh run --` wrapper. */
  wrapped?: string;
}

export interface Candidate {
  sessionId: string;
  agent: string;
  title?: string;
  startedAt: number;
  eligible: boolean;
  /** Why it can't become a task (eligible false). */
  reject?: CandidateReject;
  /** A rejected session's folder, when it is not on this machine (rejectReason says so). */
  gone?: string;
  /** For a "wrapped" reject: the session recorded inside the wrapper, which is the one to use. */
  wrapped?: string;
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
  /** Files that differ between two snapshots (tests, other backends; default src/core/snapshot.ts). */
  diffSnapshots?: (root: string, a: string, b: string) => Promise<{ files: readonly unknown[] }>;
  /** Whether a start state recorded in this folder can be read here (tests; default startReadable). */
  startReadable?: (root: string) => boolean | Promise<boolean>;
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

function edited(session: Session, events: readonly AgentEvent[], snapshotChanged?: boolean): boolean {
  if ((session.stats.filesChanged ?? 0) > 0) return true;
  // Hooks emit file.change only for edit tools; a sed -i or printf > shows in the end snapshot against the start state.
  if (snapshotChanged) return true;
  // Not compared: fall back to the ids. Every snapshot is a new commit, so equal files can have two ids.
  if (snapshotChanged === undefined && session.repo?.snapshot && session.endSnapshot && session.endSnapshot !== session.repo.snapshot) return true;
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

/**
 * The last test command the agent ran failed. A script that exits 1 with plain output (`node test-sum.js`, or
 * `npm test` on a hand-written runner) gives no counts, so stats.testsFailed stays empty for it.
 */
function lastTestRunFailed(events: readonly AgentEvent[]): boolean {
  const testIds = new Set<string>();
  let failed = false;
  for (const e of events) {
    if (e.kind === "tool.start") {
      const c = shellCommandOf(e);
      if (c && extractTestCommand(c) && typeof e.payload.toolUseId === "string") testIds.add(e.payload.toolUseId);
    }
    if (e.kind === "tool.end" && testIds.has(String(e.payload.toolUseId))) failed = e.payload.ok === false;
  }
  return failed;
}

/** The start of a session captured with `coding.sh run -- <cmd>` (src/capture/wrapper.ts): it holds the command line. */
function wrapperStart(events: readonly AgentEvent[]): AgentEvent | undefined {
  return events.find((e) => e.kind === "session.start" && e.payload.source === "wrapper");
}

/**
 * The prompt argument of a command captured with `coding.sh run --` (`my-agent -p "fix the tests"`), which
 * eval new takes as the instruction when nobody typed one (eval/task.ts instructionFromArgs). A long command
 * line is stored clipped: its preview keeps 20 arguments and a "…[n more]" marker, which is not a prompt.
 */
function commandPrompt(events: readonly AgentEvent[]): string | undefined {
  const args = wrapperStart(events)?.payload.args;
  if (!Array.isArray(args)) return undefined;
  return instructionFromArgs(args.filter((a): a is string => typeof a === "string" && !/^…\[\d+ more\]$/.test(a)));
}

/** Score or reject one session. Pure: reads only its arguments. */
export function scoreCandidate(item: CandidateItem, now = Date.now()): Candidate {
  const { session: s, events } = item;
  const prompts = events.filter((e) => e.kind === "user.message").map(text).filter((t): t is string => !!t);
  const flags = failureFlags(s.flags);
  const base = { sessionId: s.id, agent: s.agent, ...(s.title ? { title: s.title } : {}), startedAt: s.startedAt, flags, userMessages: prompts.length };
  const reject = (r: CandidateReject): Candidate => {
    const c: Candidate = { ...base, eligible: false, reject: r, score: 0, reasons: [], pushback: 0 };
    if (item.gone) c.gone = item.gone;
    if (item.wrapped) c.wrapped = item.wrapped;
    return c;
  };
  if (s.parent) return reject("subagent");
  if (s.runId || events.some((e) => e.runId)) return reject("run");
  if (item.wrapped) return reject("wrapped");
  if (!startRepo(s, events)) return reject("no-git-start");
  if (item.gone) return reject("repo-gone");
  if (!prompts.length && !commandPrompt(events)) return reject("no-user-prompt");
  if (!edited(s, events, item.snapshotChanged)) return reject("no-edits");
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
  if ((s.stats.testsFailed ?? 0) > 0 || lastTestRunFailed(events)) add(SCORE.testsFailing, "tests still failing");
  const pushback = prompts.slice(1).filter(isPushback).length;
  if (pushback) add(Math.min(pushback * SCORE.pushback, SCORE.pushbackCap), `pushback ×${pushback}`);
  const verifierGuess = guessVerifierFromEvents(events, events.find((e) => e.repo)?.repo?.root ?? s.repo?.root);
  if (verifierGuess) add(SCORE.verifier, "verifier guessable");
  if (testEditAfterFailure(events)) add(SCORE.testEditAfterFailure, "test edited after a failing run");
  if (prompts.length >= 2) add(SCORE.multiTurn, "multi-turn");
  if (s.flags.includes(FLAGS.compaction) || events.some((e) => e.kind === "context.compact")) add(SCORE.compaction, "compacted context (harder to replay)");
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

/** "2 subagents, 1 that changed no files": rejected sessions by reason. */
export function rejectSummary(cands: readonly Candidate[]): string {
  const counts = new Map<CandidateReject, number>();
  for (const c of cands) if (c.reject) counts.set(c.reject, (counts.get(c.reject) ?? 0) + 1);
  return CANDIDATE_REJECTS.filter((r) => counts.has(r))
    .map((r) => {
      const n = counts.get(r)!;
      return `${n} ${REJECT_COUNTED[r][n === 1 ? 0 : 1]}`;
    })
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
    lines.push(`         ${c.eligible ? c.reasons.join(", ") || "no signals" : `rejected: ${rejectReason(c)}`}${c.verifierGuess ? `  · verifier: ${c.verifierGuess}` : ""}`);
  }
  return lines.join("\n");
}

/** Sessions `eval init --sessions` and `eval candidates` read events for, newest first. */
export const CANDIDATE_POOL = 200;

/**
 * A session with no edit-tool signal can still have changed files through Bash. Its start state and end
 * snapshot have different ids even when they hold the same files (a HEAD commit, or a snapshot taken
 * earlier), so the files are compared. Undefined when they could not be compared.
 */
async function snapshotsDiffer(session: Session, events: readonly AgentEvent[], opts: RankOpts): Promise<boolean | undefined> {
  if ((session.stats.filesChanged ?? 0) > 0 || !session.endSnapshot) return undefined;
  const root = session.repo?.root ?? events.find((e) => e.repo?.root)?.repo?.root;
  const start = session.repo?.snapshot ?? session.repo?.head ?? events.find((e) => e.kind === "session.start" && e.repo)?.repo?.head;
  if (!root || !start) return undefined;
  if (start === session.endSnapshot) return false;
  try {
    const diff = opts.diffSnapshots ?? (async (r, a, b) => (await import("../core/snapshot.ts")).diffSnapshots(r, a, b));
    return (await diff(root, start, session.endSnapshot)).files.length > 0;
  } catch {
    return undefined; // shadow repo gone or history pruned
  }
}

/**
 * Whether the start state of a session in `root` can still be read on this machine: the folder is
 * there, or this store's shadow repo for it is, along with every object store it reads through (a
 * removed linked worktree reads through its main checkout's objects; see src/core/snapshot.ts).
 */
export async function startReadable(root: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (existsSync(root)) return true;
  const { shadowRepoPath } = await import("../core/snapshot.ts");
  const shadow = shadowRepoPath(root, env);
  if (!existsSync(join(shadow, "HEAD"))) return false;
  const objects = join(shadow, "objects");
  let alternates = "";
  try {
    alternates = readFileSync(join(objects, "info", "alternates"), "utf8");
  } catch {
    return true; // no alternates: every object is in the shadow repo itself
  }
  return alternates
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .every((p) => existsSync(isAbsolute(p) ? p : join(objects, p)));
}

/** What rankSessions reads: each session's events, and other sessions to pair a `run --` wrapper with. */
export interface RankIndex {
  listEvents(sessionId: string): Promise<AgentEvent[]>;
  listSessions?(filter: SessionFilter): Promise<Session[]>;
}

/** How long a `coding.sh run --` wrapper with no recorded end is taken to have run. */
const WRAPPER_OPEN_MS = 86_400_000;

/**
 * A session recorded inside a `coding.sh run --` wrapper: another agent's session in the same repository
 * that started while the wrapper ran (a hooked agent run under `run --`). It records the same work, so the
 * wrapper is left out and the work is drafted once. eval/task.ts wrapperStart pairs them the other way round.
 */
async function sessionInside(listSessions: (filter: SessionFilter) => Promise<Session[]>, w: Session, start: AgentEvent): Promise<string | undefined> {
  const root = (start.repo ?? w.repo)?.root;
  if (!root) return undefined;
  const end = w.endedAt ?? w.startedAt + WRAPPER_OPEN_MS;
  const near = await listSessions({ repoRoot: root, since: w.startedAt, until: end + 1 });
  return near
    .filter((s) => s.id !== w.id && s.agent !== w.agent && s.agent !== "wrapper" && s.repo?.root === root && s.startedAt >= w.startedAt && s.startedAt <= end)
    .sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1))[0]?.id;
}

/** Load each session's events and rank them. */
export async function rankSessions(index: RankIndex, sessions: readonly Session[], opts: RankOpts = {}): Promise<Candidate[]> {
  const readable = opts.startReadable ?? ((root: string) => startReadable(root));
  const listSessions = index.listSessions?.bind(index);
  const items: CandidateItem[] = [];
  for (const session of sessions) {
    const events = await index.listEvents(session.id);
    const item: CandidateItem = { session, events };
    const changed = await snapshotsDiffer(session, events, opts);
    if (changed !== undefined) item.snapshotChanged = changed;
    // The folder a start state is read through, picked as eval/task.ts startOf picks it, else where the session ran.
    const folder = (events.find((e) => e.kind === "session.start" && e.repo)?.repo ?? session.repo)?.root || session.cwd;
    if (folder && !(await readable(folder))) item.gone = folder;
    const wrapper = wrapperStart(events);
    const inside = wrapper && listSessions ? await sessionInside(listSessions, session, wrapper) : undefined;
    if (inside) item.wrapped = inside;
    items.push(item);
  }
  return rankEvalCandidates(items, opts);
}
