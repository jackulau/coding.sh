// A whole multi-agent run as one tree: a parent session, the subagents it
// spawned, their subagents, and (when a fan-out of separate agent processes
// shares a run id) every top-level agent of the run. Relationships are derived,
// not stored: a child session already carries its parent (Session.parent, set
// by ingest from the transcript's sidechain/subagent links or the proxy's
// per-call parent), and children are the sessions that name it as their parent.
// So no field is added to Session and no fold changes; buildTree walks the
// links the store already indexes (parent_session_id, run_id).
import type { IndexStore } from "./types.ts";
import type { Session, Usage } from "../schema/index.ts";
import { failureFlags } from "./sessions.ts";

/** How deep the subagent walk goes (a guard against a cycle the parent links should never form). */
const MAX_DEPTH = 64;
/** Children read per node (a fan-out this wide is already pathological). */
const MAX_CHILDREN = 1000;

export interface TreeNode {
  session: Session;
  /** Subagent sessions, oldest first. */
  children: TreeNode[];
  /** 0 for a root, 1 for its subagents, and so on. */
  depth: number;
}

/** Rolled-up totals over a whole tree (or subtree): every node counted once. */
export interface TreeTotals {
  /** Sessions in the tree, the root(s) included. */
  sessions: number;
  usage: Usage;
  toolCalls: number;
  toolErrors: number;
  filesChanged: number;
  /** First start to last end across the tree, when both are known. */
  wallMs?: number;
  /** Every failure flag seen anywhere in the tree, worst first. */
  flags: string[];
}

export interface Tree {
  /**
   * Roots of the run. A session tree has one (the top-level agent the session
   * belongs to). A run tree (grouped by run id) has one per top-level process.
   */
  roots: TreeNode[];
  /** Set when the tree was gathered by run id rather than from one session. */
  runId?: string;
  totals: TreeTotals;
  /** Nodes in tree order (depth-first, roots first), for a flat render. */
  flat: TreeNode[];
}

/** Failure flags worst first, so a tree reports the most serious one it holds. */
const FLAG_SEVERITY = [
  "test-tamper",
  "secret:exposed",
  "premature-completion",
  "repeated-tool-failure",
  "looping",
  "failure-streak",
  "no-progress",
  "churn",
  "context-thrash",
  "stalled",
  "no-verification",
  "text-tool-call",
  "model:switch",
  "model:fallback",
  "refusal",
  "duplicate-fetch",
  "skill-copy-conflict",
  "compaction",
] as const;

const severity = (flag: string): number => {
  const i = (FLAG_SEVERITY as readonly string[]).indexOf(flag);
  return i === -1 ? FLAG_SEVERITY.length : i;
};

/** Failure flags of a session (tags like `gateway:vercel` left out), worst first. */
export function worstFirst(flags: readonly string[]): string[] {
  return [...failureFlags(flags)].sort((a, b) => severity(a) - severity(b));
}

/**
 * The top-level session `id` belongs to: walk Session.parent up to the session
 * with no parent (or whose parent was never captured). Returns `id` itself when
 * it is already top-level, and stops on a missing or repeated link.
 */
export async function rootOf(index: IndexStore, id: string): Promise<string> {
  const seen = new Set<string>([id]);
  let cur = await index.getSession(id);
  for (let hop = 0; cur?.parent?.sessionId && hop < MAX_DEPTH; hop++) {
    const parentId = cur.parent.sessionId;
    if (seen.has(parentId)) break;
    const parent = await index.getSession(parentId);
    if (!parent) break; // parent process never captured: treat this session as the root
    seen.add(parentId);
    cur = parent;
  }
  return cur?.id ?? id;
}

/** The subtree rooted at `session`, reading child sessions (Session.parent) breadth by node. */
async function nodeOf(index: IndexStore, session: Session, depth: number, seen: Set<string>): Promise<TreeNode> {
  if (depth >= MAX_DEPTH) return { session, children: [], depth };
  const kids = await index.listSessions({ parentSessionId: session.id, limit: MAX_CHILDREN });
  kids.sort((a, b) => a.startedAt - b.startedAt);
  const children: TreeNode[] = [];
  for (const k of kids) {
    if (seen.has(k.id)) continue; // a link cycle, or a child reachable two ways
    seen.add(k.id);
    children.push(await nodeOf(index, k, depth + 1, seen));
  }
  return { session, children, depth };
}

/** Depth-first flatten, roots first. */
function flatten(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

const addToken = (into: Usage, u: Usage | undefined, k: keyof Usage): void => {
  const v = u?.[k];
  if (typeof v === "number" && Number.isFinite(v)) (into[k] as number) = ((into[k] as number) ?? 0) + v;
};

/** Sum the stats of every node in the trees into one rollup. */
export function treeTotals(roots: TreeNode[]): TreeTotals {
  const nodes = flatten(roots);
  const usage: Usage = {};
  let toolCalls = 0;
  let toolErrors = 0;
  let filesChanged = 0;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  const flags = new Set<string>();
  for (const { session: s } of nodes) {
    const u = s.stats.usage;
    for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) addToken(usage, u, k);
    toolCalls += s.stats.toolCalls;
    toolErrors += s.stats.toolErrors;
    filesChanged += s.stats.filesChanged;
    minStart = Math.min(minStart, s.startedAt);
    if (s.endedAt !== undefined) maxEnd = Math.max(maxEnd, s.endedAt);
    for (const f of failureFlags(s.flags)) flags.add(f);
  }
  const totals: TreeTotals = {
    sessions: nodes.length,
    usage,
    toolCalls,
    toolErrors,
    filesChanged,
    flags: [...flags].sort((a, b) => severity(a) - severity(b)),
  };
  if (minStart !== Infinity && maxEnd !== -Infinity && maxEnd >= minStart) totals.wallMs = maxEnd - minStart;
  return totals;
}

/**
 * The node that most wants attention: the one with the worst failure flag,
 * ties broken by cost, then by tool errors. Subagents are preferred over the
 * root when they tie, since the loop-level question is which subagent to fix.
 * Returns undefined when nothing in the tree is flagged.
 */
export function worstNode(roots: TreeNode[]): TreeNode | undefined {
  let best: TreeNode | undefined;
  let bestKey: [number, number, number, number] | undefined;
  for (const n of flatten(roots)) {
    const flags = worstFirst(n.session.flags);
    if (!flags.length) continue;
    const key: [number, number, number, number] = [
      severity(flags[0]!),
      -(n.session.stats.usage?.costUsd ?? 0),
      -n.session.stats.toolErrors,
      n.depth === 0 ? 1 : 0, // prefer a subagent over the root on a tie
    ];
    if (!bestKey || lessKey(key, bestKey)) {
      best = n;
      bestKey = key;
    }
  }
  return best;
}

const lessKey = (a: [number, number, number, number], b: [number, number, number, number]): boolean => {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return false;
};

/** The whole tree the session `id` belongs to (its top-level agent down through every subagent). */
export async function buildSessionTree(index: IndexStore, id: string): Promise<Tree | undefined> {
  const rootId = await rootOf(index, id);
  const root = await index.getSession(rootId);
  if (!root) return undefined;
  const seen = new Set<string>([root.id]);
  const node = await nodeOf(index, root, 0, seen);
  return { roots: [node], totals: treeTotals([node]), flat: flatten([node]) };
}

/**
 * The whole run grouped by run id: every top-level session stamped with
 * `runId` (a fan-out of separate agent processes whose orchestrator set
 * CODING_SH_RUN_ID) and the subagents under each. Undefined when no session
 * carries the run id.
 */
export async function buildRunTree(index: IndexStore, runId: string, opts: { project?: string } = {}): Promise<Tree | undefined> {
  const tops = await index.listSessions({ runId, parentSessionId: null, limit: MAX_CHILDREN, ...(opts.project !== undefined ? { project: opts.project } : {}) });
  if (!tops.length) return undefined;
  tops.sort((a, b) => a.startedAt - b.startedAt);
  const seen = new Set<string>(tops.map((s) => s.id));
  const roots: TreeNode[] = [];
  for (const s of tops) roots.push(await nodeOf(index, s, 0, seen));
  return { roots, runId, totals: treeTotals(roots), flat: flatten(roots) };
}
