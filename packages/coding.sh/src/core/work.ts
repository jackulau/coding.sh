// Work items: what needs the user now, across every agent's sessions
// (docs/design/work.md). An item is a root session plus every session linked to
// it by parent (subagents, forks, workflow agents); a child that a harness or a
// host started for a separate task is its own item. Items are derived on read
// from stored sessions and the acks and snoozes in work.json (core/work-overlay.ts):
// nothing is filed. Everything here is pure except loadWorkSessions.
import { createHash } from "node:crypto";
import type { AgentEvent, Session, Waiting } from "../schema/index.ts";
import { iso, isRunning, lastActivity, matchesPlace, type Place } from "../mcp/data.ts";
import { DERAIL_THRESHOLDS } from "./derail.ts";
import { failureState, foldFailure } from "./failures.ts";
import { FLAGS } from "./sessions.ts";
import { normalizeTracePath } from "./shell-diff.ts";
import { shellCallFiles } from "./shell-files.ts";
import type { IndexStore, SessionFilter } from "./types.ts";
import { ackedFingerprint, snoozeOf, type WorkOverlay } from "./work-overlay.ts";

/** The queue's buckets, most urgent first. */
export const BUCKETS = ["blocked", "failed", "stalled", "turn", "review"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const BUCKET_LABELS: Record<Bucket, string> = {
  blocked: "Blocked on you",
  failed: "Failed",
  stalled: "Stalled",
  turn: "Your turn",
  review: "Ready for review",
};
/** Why an item with nothing to act on is hidden (`work --all` shows it). */
export type HiddenReason = "running" | "done" | "acked" | "snoozed";
/**
 * Where an item is in its life, whatever needs the person now (docs/design/work.md#stages-and-kinds).
 * A bucket is what a person must do; a stage is where the work is.
 */
export const STAGES = ["planning", "executing", "review", "approval", "done"] as const;
export type Stage = (typeof STAGES)[number];
/** A change touched files; research stopped without changing one. */
export type WorkKind = "research" | "change";

/** A wait or a stall older than this may be a closed terminal that sent no session end. */
export const PROBABLY_CLOSED_MS = 12 * 3600e3;
/** Quiet this long mid-turn is a stall: the derail stall threshold (core/derail.ts). */
export const STALL_MS = DERAIL_THRESHOLDS.stallMs;
/** Agents whose hooks (or, for T3 Code, its store) report permission prompts. Waits in the others show up as stalls. */
export const PROMPT_SIGNAL_AGENTS: ReadonlySet<string> = new Set(["claude-code", "gemini-cli", "devin", "t3code"]);
/** A session whose end is only its last activity seen (stats.endInferred) is running when it was active this recently. */
export const INFERRED_RUNNING_MS = 15 * 60e3;
/** Parent links that start a separate item: a harness child (`codex exec` from an orchestrator). */
const OWN_ITEM_PARENT = new Set(["harness"]);
/** Host apps whose threads are separate tasks (a T3 Code thread), unless the link is the same thread on another provider. */
const HOST_AGENTS = new Set(["t3code"]);

/** One thing that would put an item in a bucket. Its fingerprint is what an ack covers. */
export interface WorkCause {
  bucket: Bucket;
  sessionId: string;
  /** When the cause began: the wait's time, the last activity, or the end. */
  at: number;
  fingerprint: string;
  waiting?: Waiting;
  /** Failed: what it failed on, e.g. "api 529" or "tests failing". */
  failure?: string;
}

export interface WorkItem {
  /** `w` + 6 hex characters of a hash of the root session id: stable between reads. */
  id: string;
  /** The root session id. It may name a session not stored (a workflow agent whose parent transcript is missing). */
  rootId: string;
  /** The bucket it is in, or unset when hidden. */
  bucket?: Bucket;
  hidden?: HiddenReason;
  /** The cause behind the bucket (the most urgent one not acknowledged). */
  cause?: WorkCause;
  title?: string;
  agent: string;
  agents: string[];
  provider?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  /** The stored root session id, or the first member when the root is not stored. */
  primaryId: string;
  /** Member session ids, the primary first. */
  sessionIds: string[];
  startedAt: number;
  lastActivity: number;
  running: boolean;
  costUsd?: number;
  filesChanged: number;
  /** A wait or a stall older than PROBABLY_CLOSED_MS. */
  probablyClosed?: boolean;
  /** The item that started this one (a harness or host child). */
  startedBy?: string;
  /** For an agent that reports no prompts: the stall may be an approval wait. */
  hint?: string;
  reason: string;
  next: string;
  stage: Stage;
  /** Unset while an item that changed no file still plans or executes: not known yet. */
  kind?: WorkKind;
  /** The evidence for the stage, one short line: "changed 3 files, stopped 12m ago". */
  stageWhy: string;
}

/** Failed items that share one API cause ("api 529 x4"). */
export interface WorkGroup {
  bucket: "failed";
  cause: string;
  count: number;
  items: string[];
}

export interface WorkQueue {
  now: number;
  /** Items in queue order: visible ones, then (with all) hidden ones. */
  items: WorkItem[];
  counts: Record<Bucket, number>;
  /** Items per stage over every item in the window, hidden ones included, before the stage filter. */
  stages: Record<Stage, number>;
  /** Items hidden (running, done, acknowledged or snoozed). */
  hidden: number;
  groups: WorkGroup[];
  /** Agents in view whose hooks report no prompt signal. */
  noPromptSignal: string[];
}

export interface WorkOptions {
  now?: number;
  /** Also return hidden items. */
  all?: boolean;
  overlay?: WorkOverlay;
  /** Only items with a session from one of these agents. */
  agents?: readonly string[];
  /** Only items whose root (or first session) ran under this place. */
  place?: Place;
  /** Only items in these stages, hidden ones included. */
  stages?: readonly Stage[];
}

export const workItemId = (rootId: string): string => `w${createHash("sha256").update(rootId).digest("hex").slice(0, 6)}`;

/**
 * Running: no end and active lately (mcp/data.ts isRunning), or an end that is
 * only the last activity seen (a session read from its transcript) within
 * INFERRED_RUNNING_MS.
 */
export function workRunning(s: Session, now: number): boolean {
  if (s.endedAt === undefined) return isRunning(s, now);
  return s.stats.endInferred === true && now - lastActivity(s) < INFERRED_RUNNING_MS;
}

/** The agent that would report a prompt: a host app that reports its own (T3 Code's store), else the agent it ran, else the session's own. */
const promptAgent = (s: Session): string => (HOST_AGENTS.has(s.agent) && s.provider && !PROMPT_SIGNAL_AGENTS.has(s.agent) ? s.provider : s.agent);

/** True when the session's prompts reach coding.sh: its agent reports them, or a permission prompt was seen. */
const reportsPrompts = (s: Session): boolean => PROMPT_SIGNAL_AGENTS.has(promptAgent(s)) || s.stats.waiting?.kind === "permission";

/** True when this session starts an item of its own though it has a parent. */
function ownItem(s: Session): boolean {
  if (!s.parent) return true;
  if (s.parent.type && OWN_ITEM_PARENT.has(s.parent.type)) return true;
  return HOST_AGENTS.has(s.agent) && s.parent.type !== "provider-switch";
}

interface RawItem {
  rootId: string;
  members: Session[];
  /** Root id of the item that started this one. */
  startedByRoot?: string;
}

/**
 * Sessions grouped into items by parent links. A session whose parent is not
 * among `sessions` groups under the parent's id, so the agents of a workflow whose
 * root transcript is missing still form one item, and its id does not change
 * when the root arrives.
 */
export function groupWorkItems(sessions: readonly Session[]): RawItem[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const rootOf = new Map<string, string>();
  const find = (s: Session): string => {
    const seen: Session[] = [];
    let cur: Session | undefined = s;
    let root = s.id;
    while (cur) {
      const known = rootOf.get(cur.id);
      if (known !== undefined) {
        root = known;
        break;
      }
      seen.push(cur);
      if (ownItem(cur)) {
        root = cur.id;
        break;
      }
      const pid: string = cur.parent!.sessionId;
      const next = byId.get(pid);
      if (!next || seen.includes(next)) {
        root = pid;
        break;
      }
      cur = next;
    }
    for (const x of seen) rootOf.set(x.id, root);
    return root;
  };
  const items = new Map<string, RawItem>();
  for (const s of sessions) {
    const root = find(s);
    let it = items.get(root);
    if (!it) items.set(root, (it = { rootId: root, members: [] }));
    it.members.push(s);
  }
  for (const it of items.values()) {
    const root = byId.get(it.rootId);
    if (root?.parent && ownItem(root)) {
      const parent = byId.get(root.parent.sessionId);
      it.startedByRoot = parent ? find(parent) : root.parent.sessionId;
    }
  }
  return [...items.values()];
}

const BLOCKING: ReadonlySet<Waiting["kind"]> = new Set(["permission", "question", "plan"]);

/** The member's API failure cause ("api 529"), when it ended on API errors. */
function apiFailure(s: Session): string | undefined {
  if (!s.flags.includes(FLAGS.apiStall)) return undefined;
  const code = s.stats.llmErrors?.statusCode;
  return `api ${code ?? "error"}`;
}

/** Every cause the item has, most urgent first. */
export function workCauses(members: readonly Session[], primary: Session, now: number): WorkCause[] {
  const out: WorkCause[] = [];
  const cause = (bucket: Bucket, s: Session, at: number, key: string | number, extra: Partial<WorkCause> = {}) =>
    out.push({ bucket, sessionId: s.id, at, fingerprint: `${bucket}:${s.id}:${key}`, ...extra });
  const blocked = members.filter((s) => s.stats.waiting && BLOCKING.has(s.stats.waiting.kind)).sort((a, b) => a.stats.waiting!.at - b.stats.waiting!.at);
  for (const s of blocked) cause("blocked", s, s.stats.waiting!.at, s.stats.waiting!.toolUseId ?? s.stats.waiting!.at, { waiting: s.stats.waiting });
  const running = members.some((s) => workRunning(s, now));
  const anyWait = members.some((s) => s.stats.waiting);
  const stopped = !running && !anyWait;
  if (stopped) {
    const end = lastActivity(primary);
    const api = apiFailure(primary);
    if (api) cause("failed", primary, end, end, { failure: api });
    else if ((primary.stats.testsFailed ?? 0) > 0) cause("failed", primary, end, end, { failure: `${primary.stats.testsFailed} failing ${primary.stats.testsFailed === 1 ? "test" : "tests"}` });
  }
  // Quiet mid-turn: no end, nothing waited on (an interactive turn that ended waits as `turn`).
  const quiet = members.filter((s) => s.endedAt === undefined && !s.stats.waiting && now - lastActivity(s) >= STALL_MS).sort((a, b) => lastActivity(a) - lastActivity(b));
  for (const s of quiet) cause("stalled", s, lastActivity(s), lastActivity(s));
  if (primary.stats.waiting?.kind === "turn") cause("turn", primary, primary.stats.waiting.at, primary.stats.waiting.at, { waiting: primary.stats.waiting });
  if (stopped) {
    const files = members.reduce((n, s) => n + (s.stats.filesChanged ?? 0), 0);
    const end = Math.max(...members.map(lastActivity));
    if (files > 0) cause("review", primary, end, end);
  }
  return out;
}

const rank = (b: Bucket): number => BUCKETS.indexOf(b);

export interface WorkStage {
  stage: Stage;
  kind?: WorkKind;
  /** The evidence, at most STAGE_WHY_MAX characters. */
  why: string;
}

/** The longest stageWhy. */
export const STAGE_WHY_MAX = 80;
const clip = (text: string, n = STAGE_WHY_MAX): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const changedText = (n: number): string => `changed ${n} ${n === 1 ? "file" : "files"}`;
const WAIT_FOR: Record<Waiting["kind"], string> = { permission: "permission", question: "an answer", plan: "plan approval", turn: "your turn" };
/** The buckets a person settles by looking at the result: an ack of each moves the item to done. */
const REVIEW_BUCKETS: ReadonlySet<Bucket> = new Set(["failed", "turn", "review"]);

/** "tests: 3 passed, 2 failed", or undefined when no count is set. */
function testsText(passed: number | undefined, failed: number | undefined): string | undefined {
  if (passed === undefined && failed === undefined) return undefined;
  const parts = [passed ? `${passed} passed` : "", failed ? `${failed} failed` : ""].filter(Boolean);
  return `tests: ${parts.length ? parts.join(", ") : "none run"}`;
}

/** The sum of a stat over the sessions that set it, or undefined when none does. */
function sumSet(members: readonly Session[], pick: (s: Session) => number | undefined): number | undefined {
  let out: number | undefined;
  for (const s of members) {
    const v = pick(s);
    if (v !== undefined) out = (out ?? 0) + v;
  }
  return out;
}

/**
 * The item's stage and kind from its sessions and causes, with no store read. First match wins:
 * approval (a member waits on a permission, a question or a plan, acked or not); executing or
 * planning while a member runs or is stalled (executing once a file changed or tests ran);
 * review while a failed, turn or review cause is not acknowledged; done otherwise. A snooze does
 * not change it. `causes` are workCauses' (every one, acked or not); `acked` says which the person acked.
 */
export function workStage(members: readonly Session[], primary: Session, now: number, causes: readonly WorkCause[] = workCauses(members, primary, now), acked: (c: WorkCause) => boolean = () => false): WorkStage {
  const files = members.reduce((n, s) => n + (s.stats.filesChanged ?? 0), 0);
  const changed = files > 0 ? changedText(files) : undefined;
  const kind: WorkKind | undefined = files > 0 ? "change" : undefined;
  const blocked = members.filter((s) => s.stats.waiting && BLOCKING.has(s.stats.waiting.kind)).sort((a, b) => a.stats.waiting!.at - b.stats.waiting!.at);
  if (blocked.length) {
    const w = blocked[0]!.stats.waiting!;
    return { stage: "approval", kind, why: clip(`waits ${short(now - w.at)} for ${WAIT_FOR[w.kind]}${w.text ? `: ${w.text}` : ""}`) };
  }
  // Running or stalled: no end (or a recent inferred one) and nothing waited on.
  const working = members.filter((s) => !s.stats.waiting && (s.endedAt === undefined || workRunning(s, now)));
  if (working.length) {
    const tests = testsText(sumSet(members, (s) => s.stats.testsPassed), sumSet(members, (s) => s.stats.testsFailed));
    // Active inside the stall threshold reads as running; else every working member is stalled.
    const active = working.some((s) => now - lastActivity(s) < STALL_MS);
    const lead = active ? `running ${short(now - Math.min(...members.map((s) => s.startedAt)))}` : `quiet ${short(now - Math.max(...working.map(lastActivity)))}`;
    const evidence = [changed, tests].filter(Boolean);
    return { stage: evidence.length ? "executing" : "planning", kind, why: clip(`${lead}, ${evidence.length ? evidence.join(", ") : "no file changed yet"}`) };
  }
  const end = Math.max(...members.map(lastActivity));
  const own = causes.filter((c) => REVIEW_BUCKETS.has(c.bucket));
  if (own.length) {
    const open = own.filter((c) => !acked(c));
    const turn = own.find((c) => c.bucket === "turn");
    const failure = apiFailure(primary) ?? ((primary.stats.testsFailed ?? 0) > 0 ? `tests: ${primary.stats.testsFailed} failed` : undefined);
    const tail = turn ? `your turn for ${short(now - turn.at)}` : `stopped ${short(now - end)} ago`;
    const why = [failure, changed, tail].filter(Boolean).join(", ");
    return { stage: open.length ? "review" : "done", kind: kind ?? "research", why: clip(open.length ? why : `acknowledged: ${why}`) };
  }
  const tests = testsText(primary.stats.testsPassed, primary.stats.testsFailed);
  const why = [tests, changed, `stopped ${short(now - end)} ago`].filter(Boolean).join(", ");
  return { stage: "done", kind: kind ?? "research", why: clip(tests || changed ? why : `${why}, no file changed`) };
}

/** The command that resumes a session, when the agent has one. */
export function resumeCommand(s: Pick<Session, "id" | "agent" | "provider">): string | undefined {
  const agent = s.agent === "t3code" ? undefined : s.agent;
  if (agent === "claude-code") return `claude --resume ${s.id}`;
  if (agent === "codex") return `codex resume ${s.id}`;
  return undefined;
}

/** An age as the CLI's `ago` gives it, floored, so one instant reads the same in a reason and a "Started" row: 27s, 4m, 1h, 3d. */
function short(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1e3));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const WAIT_WORDS: Record<Waiting["kind"], string> = {
  permission: "waiting on a permission prompt",
  question: "asked you a question",
  plan: "waiting on plan approval",
  turn: "turn ended; waiting for your next prompt",
};

function quote(text: string | undefined, n = 80): string {
  if (!text) return "";
  return `: "${text.length > n ? `${text.slice(0, n - 1)}…` : text}"`;
}

/** "finished 3m ago with 2 files changed"; with `sessions`, the count is a sum over that many sessions: "with up to 9 files changed in 3 sessions". */
function reviewReason(age: string, files: number, sessions?: number): string {
  const n = `${files} ${files === 1 ? "file" : "files"} changed`;
  return `finished ${age} ago with ${sessions ? `up to ${n} in ${sessions} sessions` : n}`;
}

/** Reason and next step for an item in a bucket. */
function describe(item: WorkItem, cause: WorkCause, members: readonly Session[], now: number): { reason: string; next: string; hint?: string } {
  const s = members.find((m) => m.id === cause.sessionId) ?? members[0]!;
  const age = short(now - cause.at);
  const place = s.cwd ? ` in ${s.cwd}` : "";
  const where = `${s.agent}${place}`;
  const resume = resumeCommand(s);
  const closedNext = resume ? `resume with \`${resume}\`, or \`coding.sh work ack ${item.id}\`` : `open ${where}, or \`coding.sh work ack ${item.id}\``;
  switch (cause.bucket) {
    case "blocked": {
      const w = cause.waiting!;
      const reason = `${WAIT_WORDS[w.kind]} for ${age}${quote(w.text)}`;
      return { reason, next: item.probablyClosed ? `probably closed: ${closedNext}` : `answer in ${where}` };
    }
    case "failed":
      return { reason: `ended ${age} ago on ${cause.failure}`, next: resume ? `\`coding.sh show ${s.id}\`, then \`${resume}\`` : `\`coding.sh show ${s.id}\`` };
    case "stalled": {
      const hint = reportsPrompts(s) ? undefined : `${promptAgent(s)} reports no prompts: it may be waiting on approval`;
      const reason = `quiet for ${age} mid-turn${hint ? `; ${hint}` : ""}`;
      const out: { reason: string; next: string; hint?: string } = { reason, next: item.probablyClosed ? `probably closed: ${closedNext}` : `check ${where}` };
      if (hint) out.hint = hint;
      return out;
    }
    case "turn":
      return { reason: `${WAIT_WORDS.turn} (${age})`, next: item.probablyClosed ? `probably closed: ${closedNext}` : `reply in ${where}` };
    case "review": {
      // Each session counts its own distinct paths, so a sum over several may count a path more than once.
      const changers = members.filter((m) => (m.stats.filesChanged ?? 0) > 0).length;
      const reason = reviewReason(age, item.filesChanged, changers > 1 ? changers : undefined);
      const diff = item.repo ? `\`git -C ${item.repo} diff\`` : `\`coding.sh work show ${item.id}\``;
      return { reason, next: `review: ${diff}, then \`coding.sh work ack ${item.id}\`` };
    }
  }
}

/** A path for comparing: forward slashes, no trailing slash, lower case on Windows. */
const pathKey = (p: string): string => {
  const k = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(k) ? k.toLowerCase() : k;
};

/** The branches recorded by sessions that ran at a repo root itself, keyed by pathKey(root): the main checkout's. */
export type Checkouts = ReadonlyMap<string, readonly { at: number; branch: string }[]>;

/** The branch of each repo root's own checkout, from the sessions whose cwd is that root. */
export function rootCheckouts(sessions: readonly Session[]): Checkouts {
  const out = new Map<string, { at: number; branch: string }[]>();
  for (const s of sessions) {
    if (!s.cwd || !s.repo?.root || !s.repo.branch || pathKey(s.cwd) !== pathKey(s.repo.root)) continue;
    const k = pathKey(s.repo.root);
    out.set(k, [...(out.get(k) ?? []), { at: s.startedAt, branch: s.repo.branch }]);
  }
  return out;
}

/**
 * True when `s` ran in a folder under its repo root on a branch other than the
 * one the root's own checkout had nearest in time: a worktree nested in the repo
 * (one since removed resolves to the enclosing repo). Its diff is in the cwd.
 */
export function ownCheckout(s: Session, checkouts: Checkouts | undefined): boolean {
  const root = s.repo?.root;
  if (!checkouts || !s.cwd || !root || !s.repo?.branch) return false;
  if (!pathKey(s.cwd).startsWith(`${pathKey(root)}/`)) return false;
  const seen = checkouts.get(pathKey(root));
  if (!seen?.length) return false;
  const nearest = seen.reduce((a, b) => (Math.abs(b.at - s.startedAt) < Math.abs(a.at - s.startedAt) ? b : a));
  return nearest.branch !== s.repo.branch;
}

/** Builds one item from its sessions. `checkouts` (rootCheckouts) tells a worktree nested in its repo from a subfolder. */
export function workItem(raw: RawItem, now: number, overlay?: WorkOverlay, checkouts?: Checkouts): WorkItem {
  const members = [...raw.members].sort((a, b) => a.startedAt - b.startedAt);
  const root = members.find((s) => s.id === raw.rootId);
  const primary = root ?? members[0]!;
  const ordered = [primary, ...members.filter((s) => s !== primary)];
  const cost = members.reduce((n, s) => n + (s.stats.usage?.estimatedCostUsd ?? s.stats.usage?.costUsd ?? 0), 0);
  const item: WorkItem = {
    id: workItemId(raw.rootId),
    rootId: raw.rootId,
    title: primary.title ?? members.find((s) => s.title)?.title,
    agent: primary.agent,
    agents: [...new Set(members.map((s) => s.agent))],
    primaryId: primary.id,
    sessionIds: ordered.map((s) => s.id),
    startedAt: members[0]!.startedAt,
    lastActivity: Math.max(...members.map(lastActivity)),
    running: members.some((s) => workRunning(s, now)),
    filesChanged: members.reduce((n, s) => n + (s.stats.filesChanged ?? 0), 0),
    reason: "",
    next: "",
    stage: "done",
    stageWhy: "",
  };
  if (primary.provider) item.provider = primary.provider;
  if (primary.cwd) item.cwd = primary.cwd;
  // A checkout of its own is where the agent worked: Where names it and the review diffs it.
  if (primary.repo?.root) item.repo = ownCheckout(primary, checkouts) ? primary.cwd : primary.repo.root;
  if (primary.repo?.branch) item.branch = primary.repo.branch;
  if (cost > 0) item.costUsd = Math.round(cost * 1e4) / 1e4;
  if (raw.startedByRoot) item.startedBy = workItemId(raw.startedByRoot);
  const ids = item.sessionIds;
  const causes = workCauses(members, primary, now);
  const isAcked = (c: WorkCause): boolean => !!overlay && ackedFingerprint(overlay, c.sessionId, c.fingerprint);
  const open = causes.filter((c) => !isAcked(c));
  const cause = open[0];
  const st = workStage(members, primary, now, causes, isAcked);
  item.stage = st.stage;
  if (st.kind) item.kind = st.kind;
  item.stageWhy = st.why;
  const snooze = overlay ? snoozeOf(overlay, ids, now) : undefined;
  if (cause && snooze && rank(cause.bucket) >= rank(snooze.bucket)) item.hidden = "snoozed";
  else if (cause) item.bucket = cause.bucket;
  else item.hidden = causes.length ? "acked" : item.running ? "running" : "done";
  const shown = cause ?? causes[0];
  if (shown) {
    item.cause = shown;
    if (shown.bucket !== "failed" && shown.bucket !== "review" && now - shown.at >= PROBABLY_CLOSED_MS) item.probablyClosed = true;
    const d = describe(item, shown, members, now);
    item.reason = d.reason;
    item.next = d.next;
    if (d.hint) item.hint = d.hint;
  } else if (item.running) {
    item.reason = `running, active ${short(now - item.lastActivity)} ago`;
    item.next = `nothing to do yet`;
  } else {
    item.reason = `done ${short(now - item.lastActivity)} ago`;
    item.next = "nothing to do";
  }
  if (item.hidden === "acked") item.next = "acknowledged: it comes back when something new happens";
  if (item.hidden === "snoozed" && snooze) item.next = `snoozed until ${new Date(snooze.until).toISOString()}`;
  return item;
}

/** Sort key inside a bucket: oldest wait or stall first; newest failure or finished work first. */
function compare(a: WorkItem, b: WorkItem): number {
  const ra = a.bucket ? rank(a.bucket) : BUCKETS.length;
  const rb = b.bucket ? rank(b.bucket) : BUCKETS.length;
  if (ra !== rb) return ra - rb;
  const at = (x: WorkItem) => x.cause?.at ?? x.lastActivity;
  if (a.bucket === "review") {
    const ka = `${a.repo ?? "~"}\u0000${a.branch ?? ""}`;
    const kb = `${b.repo ?? "~"}\u0000${b.branch ?? ""}`;
    if (ka !== kb) return ka < kb ? -1 : 1;
    return at(b) - at(a);
  }
  if (a.bucket === "failed" || !a.bucket) return at(b) - at(a) || (a.id < b.id ? -1 : 1);
  return at(a) - at(b) || (a.id < b.id ? -1 : 1);
}

/** The queue: items from sessions, bucketed, ordered, with the failed groups and the header's agents. */
export function buildWorkQueue(sessions: readonly Session[], opts: WorkOptions = {}): WorkQueue {
  const now = opts.now ?? Date.now();
  const agents = opts.agents?.length ? new Set(opts.agents) : undefined;
  const place = opts.place;
  const raws = groupWorkItems(sessions).filter((raw) => {
    if (agents && !raw.members.some((s) => agents.has(s.agent))) return false;
    if (!place) return true;
    const primary = raw.members.find((s) => s.id === raw.rootId) ?? raw.members.reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
    return matchesPlace(primary, place);
  });
  const checkouts = rootCheckouts(sessions);
  const all = raws.map((raw) => workItem(raw, now, opts.overlay, checkouts));
  all.sort(compare);
  const stages = Object.fromEntries(STAGES.map((st) => [st, 0])) as Record<Stage, number>;
  for (const i of all) stages[i.stage]++;
  const visible = all.filter((i) => i.bucket);
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  for (const i of visible) counts[i.bucket!]++;
  const byCause = new Map<string, string[]>();
  for (const i of visible) {
    const f = i.bucket === "failed" ? i.cause?.failure : undefined;
    if (f?.startsWith("api ")) byCause.set(f, [...(byCause.get(f) ?? []), i.id]);
  }
  const groups: WorkGroup[] = [...byCause].filter(([, ids]) => ids.length > 1).map(([cause, items]) => ({ bucket: "failed", cause, count: items.length, items }));
  const only = opts.stages?.length ? new Set(opts.stages) : undefined;
  const shown = only ? all.filter((i) => only.has(i.stage)) : opts.all ? all : visible;
  const shownIds = new Set(shown.flatMap((i) => i.sessionIds));
  const inView = sessions.filter((s) => shownIds.has(s.id));
  const signaled = new Set(inView.filter(reportsPrompts).map(promptAgent));
  const noPromptSignal = [...new Set(inView.map(promptAgent))].filter((a) => !signaled.has(a)).sort();
  return { now, items: shown, counts, stages, hidden: all.length - visible.length, groups, noPromptSignal };
}

/** "2 blocked on you · 1 failed · 3 ready for review", or "nothing needs you". */
export function countsLine(counts: Readonly<Record<Bucket, number>>): string {
  const parts = BUCKETS.filter((b) => counts[b]).map((b) => `${counts[b]} ${BUCKET_LABELS[b].toLowerCase()}`);
  return parts.length ? parts.join(" · ") : "nothing needs you";
}

/** "1 approval · 2 executing · 4 done", or "no items". */
export function stagesLine(stages: Readonly<Record<Stage, number>>): string {
  const parts = STAGES.filter((st) => stages[st]).map((st) => `${stages[st]} ${st}`);
  return parts.length ? parts.join(" · ") : "no items";
}

/** Items blocked on the user or failed: the statusline's "N need you". */
export const needYou = (q: Pick<WorkQueue, "counts">): number => q.counts.blocked + q.counts.failed;

export interface WorkLoad {
  sessions: Session[];
  /** The window held more sessions than the cap; the oldest were left out. */
  truncated: boolean;
}

/** The window `work`, `status` and the statusline read by default: sessions started in the last 7 days. */
export const WORK_WINDOW_MS = 7 * 86400e3;

/** At most this many sessions are read for one queue. */
export const WORK_SCAN_CAP = 20_000;
/** At most this many parents outside the window are looked up. */
const PARENT_LOOKUPS = 500;

/**
 * Sessions started in the window, plus the stored parents of those whose parent
 * started before it (so a long-running root keeps its children), up to PARENT_LOOKUPS.
 */
export async function loadWorkSessions(index: IndexStore, filter: Pick<SessionFilter, "since">, cap = WORK_SCAN_CAP): Promise<WorkLoad> {
  const sessions = await index.listSessions({ ...filter, limit: cap + 1 });
  const truncated = sessions.length > cap;
  if (truncated) sessions.length = cap;
  const have = new Set(sessions.map((s) => s.id));
  let lookups = 0;
  for (let i = 0; i < sessions.length && lookups < PARENT_LOOKUPS; i++) {
    const pid = sessions[i]!.parent?.sessionId;
    if (!pid || have.has(pid)) continue;
    have.add(pid);
    lookups++;
    const p = await index.getSession(pid);
    if (p) sessions.push(p);
  }
  return { sessions, truncated };
}

/**
 * The distinct paths a session's events changed, keyed as stats.filesChanged
 * counts them (core/sessions.ts): file.change paths relative to the cwd, and the
 * files a shell call wrote, unless it was stopped. `sorted` is in time order.
 */
export function changedPaths(sorted: readonly AgentEvent[], cwd?: string): Set<string> {
  const out = new Set<string>();
  const pending = new Map<string, string[]>();
  const failures = failureState();
  for (const e of sorted) {
    const failure = foldFailure(failures, e);
    if (e.source === "gateway") continue;
    if (e.kind === "file.change") {
      if (typeof e.payload.path === "string" && e.payload.path) out.add(normalizeTracePath(e.payload.path, e.cwd ?? cwd));
      continue;
    }
    if ((e.kind !== "tool.start" && e.kind !== "tool.end") || e.payload.wrapper === true) continue;
    const id = typeof e.payload.toolUseId === "string" && e.payload.toolUseId ? e.payload.toolUseId : undefined;
    if (e.kind === "tool.start") {
      const written = shellCallFiles(e.payload.tool, e.payload.input, e.cwd ?? cwd);
      if (written.length && id) pending.set(id, written);
      else for (const f of written) out.add(f);
    } else if (id && pending.has(id)) {
      if (failure?.cls !== "interrupted") for (const f of pending.get(id)!) out.add(f);
      pending.delete(id);
    }
  }
  return out;
}

/** Event kinds changedPaths reads. */
export const CHANGE_EVENT_KINDS = ["file.change", "tool.start", "tool.end"];
/** At most this many of an item's sessions that changed files are read for its file list. */
export const WORK_FILE_SESSIONS = 200;

/**
 * The distinct paths an item's sessions changed (`coding.sh work show`). When
 * every session was read, the item's filesChanged and a review reason take this
 * count, so the count matches the list.
 */
export async function workFiles(index: Pick<IndexStore, "listEvents">, item: WorkItem, sessions: readonly Session[], now = Date.now()): Promise<string[]> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  // Each path with the cwd it is relative to (absolute paths need none).
  const found: [string, string | undefined][] = [];
  // A session that counted no changed file has none to list.
  const changers = item.sessionIds.filter((id) => (byId.get(id)?.stats.filesChanged ?? 1) > 0);
  const ids = changers.slice(0, WORK_FILE_SESSIONS);
  for (const id of ids) {
    const cwd = byId.get(id)?.cwd;
    for (const f of changedPaths(await index.listEvents(id, { kinds: CHANGE_EVENT_KINDS }), cwd)) found.push([f, cwd]);
  }
  // One path base: when some paths are absolute (written outside the cwd), every path is.
  const absolute = (p: string) => /^(?:[A-Za-z]:)?[\\/]/.test(p);
  const mixed = found.some(([f]) => absolute(f)) && found.some(([f, cwd]) => !absolute(f) && cwd);
  const files = new Set(found.map(([f, cwd]) => (mixed && cwd && !absolute(f) ? `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${f}` : f)));
  if (ids.length === changers.length && files.size) {
    item.filesChanged = files.size;
    if (item.cause?.bucket === "review") item.reason = reviewReason(short(now - item.cause.at), files.size);
    item.stageWhy = clip(item.stageWhy.replace(/\bchanged \d+ files?\b/, changedText(files.size)));
  }
  return [...files];
}

/** The object without its undefined fields: optional JSON fields are absent, not null. */
function defined(o: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** One item as `work --json` and the MCP `status` tool's `work` field give it: times as ISO strings. */
export function workItemJson(i: WorkItem): Record<string, unknown> {
  const c = i.cause;
  const out: Record<string, unknown> = defined({
    id: i.id,
    bucket: i.bucket,
    hidden: i.hidden,
    title: i.title || undefined,
    reason: i.reason,
    next: i.next,
    agent: i.agent,
    agents: i.agents,
    provider: i.provider || undefined,
    cwd: i.cwd || undefined,
    repo: i.repo || undefined,
    branch: i.branch || undefined,
    sessionId: i.primaryId,
    rootId: i.rootId,
    sessions: i.sessionIds.length,
    startedAt: iso(i.startedAt),
    lastActivity: iso(i.lastActivity),
    running: i.running,
    filesChanged: i.filesChanged,
    stage: i.stage,
    kind: i.kind,
    stageWhy: i.stageWhy,
  });
  if (c) {
    out.since = iso(c.at);
    out.causeSessionId = c.sessionId;
    if (c.waiting) out.waiting = { ...c.waiting, at: iso(c.waiting.at) };
    if (c.failure) out.failure = c.failure;
  }
  if (i.probablyClosed) out.probablyClosed = true;
  if (i.hint) out.hint = i.hint;
  if (i.startedBy) out.startedBy = i.startedBy;
  if (i.costUsd !== undefined) out.costUsd = i.costUsd;
  return out;
}

/** The `work --json` document: counts, the header's agents, and the first `limit` items. */
export function workJson(q: WorkQueue, opts: { since: number; limit: number; truncated?: boolean }): Record<string, unknown> {
  return defined({
    since: iso(opts.since),
    counts: q.counts,
    stages: q.stages,
    needYou: needYou(q),
    hidden: q.hidden,
    noPromptSignal: q.noPromptSignal,
    items: q.items.slice(0, opts.limit).map(workItemJson),
    more: q.items.length > opts.limit ? q.items.length - opts.limit : undefined,
    groups: q.groups,
    truncated: opts.truncated || undefined,
  });
}

export interface WorkRead {
  since: number;
  all?: boolean;
  agents?: readonly string[];
  place?: Place;
  stages?: readonly Stage[];
  now?: number;
  overlay: WorkOverlay;
}

/** Loads the window's sessions and builds the queue. */
export async function readWorkQueue(index: IndexStore, r: WorkRead): Promise<{ queue: WorkQueue; sessions: Session[]; truncated: boolean }> {
  const { sessions, truncated } = await loadWorkSessions(index, { since: r.since });
  const queue = buildWorkQueue(sessions, { now: r.now, all: r.all, overlay: r.overlay, agents: r.agents, place: r.place, stages: r.stages });
  return { queue, sessions, truncated };
}
