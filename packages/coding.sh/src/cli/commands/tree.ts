// coding.sh tree <session|run>: a multi-agent run as one tree — the session,
// the subagents it spawned, their subagents, with per-node cost, tokens,
// duration and tool calls, rolled-up totals and the worst flag for the loop.
// From a subagent, the tree starts at that subagent and one line names the
// sessions above it; --all starts at the top-level agent. A fan-out of separate
// agent processes that share a run id (CODING_SH_RUN_ID) groups into one run;
// pass that id (or --run).
import { costNote } from "../../core/pricing.ts";
import { buildRunTree, buildSessionTree, buildSubtree, pageTree, TREE_PAGE_NODES, worstNode, worstFirst, type Tree, type TreeNode } from "../../core/tree.ts";
import type { Session } from "../../core/types.ts";
import { positiveInt, UsageError } from "../args.ts";
import { autoIngest, oneLine, resolveSession, sessionJson, shortSessionId, wholeRef, withContext, notFoundWithBacklog, pendingField, readIngest, tidyNumbers } from "../common.ts";
import { clean, duration, plural, tokens, usd, type Output } from "../output.ts";
import type { CommandContext } from "../types.ts";

/** A node's own cost/tokens/duration/tools, for one tree line and for --json. */
function nodeSummary(s: Session) {
  const u = s.stats.usage;
  return {
    costUsd: u?.costUsd,
    inputTokens: u?.inputTokens,
    outputTokens: u?.outputTokens,
    durationMs: s.endedAt !== undefined ? s.endedAt - s.startedAt : undefined,
    toolCalls: s.stats.toolCalls,
    toolErrors: s.stats.toolErrors,
    filesChanged: s.stats.filesChanged,
  };
}

/** A session's role in --json: "root" for a top-level agent (depth 0), else its subagent type. */
const roleOf = (s: Session, depth: number): string => (depth === 0 ? "root" : (s.parent?.type ?? "subagent"));

function nodeJson(n: TreeNode): Record<string, unknown> {
  const s = n.session;
  return {
    ...sessionJson(s),
    depth: n.depth,
    role: roleOf(s, n.depth),
    children: n.children.map(nodeJson),
  };
}

/** The whole tree's totals and worst node, and one page of its nodes (`limit` from `offset`, depth-first). */
function treeJson(t: Tree, offset: number, limit: number) {
  const worst = worstNode(t.roots);
  const page = pageTree(t.roots, offset, limit);
  const doc: Record<string, unknown> = { ...(t.runId ? { runId: t.runId } : {}) };
  if (t.ancestors?.length) doc.ancestors = t.ancestors.map((a, depth) => ({ id: a.id, agent: a.agent, role: roleOf(a, depth) }));
  Object.assign(doc, {
    totals: {
      sessions: t.totals.sessions,
      usage: tidyNumbers(t.totals.usage),
      toolCalls: t.totals.toolCalls,
      toolErrors: t.totals.toolErrors,
      filesChanged: t.totals.filesChanged,
      durationMs: t.totals.wallMs !== undefined ? Math.round(t.totals.wallMs) : null,
      flags: t.totals.flags,
    },
    worst: worst ? { id: worst.session.id, role: roleOf(worst.session, worst.depth), flags: worstFirst(worst.session.flags) } : null,
    tree: page.roots.map(nodeJson),
  });
  if (page.next !== undefined) Object.assign(doc, { nextCursor: String(page.next), truncated: true });
  return doc;
}

/** "└ 9f1c2e  reviewer  sonnet  12s  18 tools  $0.03  [premature-completion]  title", indented from the depth `base` of the printed root. */
function printNode(out: Output, n: TreeNode, isRoot: boolean, base: number): void {
  const s = n.session;
  const { costUsd, durationMs, toolCalls, toolErrors } = nodeSummary(s);
  const indent = "  ".repeat(n.depth - base);
  const branch = isRoot ? "" : "└ ";
  const role = n.depth === 0 ? s.agent : (s.parent?.type ?? s.agent);
  const parts = [
    wholeRef(s.id),
    out.style(role, "bold"),
    s.model ?? "",
    durationMs !== undefined ? duration(durationMs) : "-",
    `${plural(toolCalls, "tool")}${toolErrors ? ` (${toolErrors} failed)` : ""}`,
    costUsd !== undefined ? usd(costUsd) : "",
  ].filter(Boolean);
  const flags = worstFirst(s.flags);
  const flagText = flags.length ? out.style(`[${flags.join(" ")}]`, "yellow") : "";
  const title = oneLine(clean(s.title ?? ""), 48);
  out.print(`${indent}${branch}${parts.join("  ")}${flagText ? `  ${flagText}` : ""}${title ? `  ${out.style(title, "faint")}` : ""}`);
  for (const c of n.children) printNode(out, c, false, base);
}

/** "in: 1a2b3c4d claude-code › 5e6f7a8b Explore": the sessions above a subtree, from the top, by short id and role. */
const ancestorsLine = (ancestors: readonly Session[]): string =>
  `in: ${ancestors.map((a, depth) => `${shortSessionId(a.id)} ${depth === 0 ? a.agent : (a.parent?.type ?? "subagent")}`).join(" › ")}`;

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const arg = c.positionals[0]!;
  const forceRun = c.flags.run === true;
  const whole = c.flags.all === true;
  const limit = positiveInt(c.flags.limit, "limit") ?? TREE_PAGE_NODES;
  const cursor = typeof c.flags.cursor === "string" ? c.flags.cursor : undefined;
  if (cursor !== undefined && !/^\d{1,9}$/.test(cursor)) throw new UsageError(`--cursor must be the nextCursor of the last page, got ${JSON.stringify(cursor)}`, { reason: "invalid_argument" });
  return withContext(c, async (ctx) => {
    const backlog = await autoIngest(ctx, readIngest(c));

    let tree: Tree | undefined;
    let label: string;
    if (!forceRun) {
      // Try the argument as a session first; fall back to a run id.
      try {
        const s = await resolveSession(ctx, arg);
        // The tree under the session; --all, the whole tree from its top-level agent.
        tree = whole ? await buildSessionTree(ctx.index, s.id) : await buildSubtree(ctx.index, s.id);
        label = tree && tree.roots[0] ? treeLabel(tree.roots[0]!.session) : wholeRef(s.id);
      } catch (e) {
        tree = await buildRunTree(ctx.index, arg);
        if (!tree) throw notFoundWithBacklog(e, backlog); // neither a session nor a run: surface the session error
        label = `run ${arg}`;
      }
    } else {
      tree = await buildRunTree(ctx.index, arg);
      label = `run ${arg}`;
      if (!tree) {
        out.note(`No sessions in run ${arg}`);
        out.next("List runs by setting CODING_SH_RUN_ID on your fan-out, then", "coding.sh sessions");
        return 0;
      }
    }
    if (!tree) {
      out.note(`No tree for ${arg}`);
      return 0;
    }

    if (out.json) {
      out.data({ ...treeJson(tree, Number(cursor ?? 0), limit), ...pendingField(backlog) });
      return 0;
    }

    const t = tree.totals;
    const subagents = t.sessions - tree.roots.length;
    out.print(out.style(label!, "bold"));
    const headline = [
      tree.runId ? `${plural(tree.roots.length, "agent")}, ${plural(subagents, "subagent")}` : `${plural(subagents, "subagent")}`,
      t.wallMs !== undefined ? duration(t.wallMs) : null,
      `${plural(t.toolCalls, "tool call")}${t.toolErrors ? ` (${t.toolErrors} failed)` : ""}`,
      t.filesChanged ? `${plural(t.filesChanged, "file")} changed` : null,
      t.usage.costUsd !== undefined ? `${usd(t.usage.costUsd)}${costNote(t.usage)}` : null,
    ].filter(Boolean);
    out.print(`  ${headline.join("  ·  ")}`);
    if (t.usage.inputTokens !== undefined || t.usage.outputTokens !== undefined) {
      out.print(`  ${out.style(`in ${tokens(t.usage.inputTokens)}  out ${tokens(t.usage.outputTokens)}  cache ${tokens(t.usage.cacheReadTokens)}`, "faint")}`);
    }
    if (t.flags.length) out.print(`  ${out.style(`flags across the loop: ${t.flags.join(", ")}`, "yellow")}`);
    out.print();

    if (tree.ancestors?.length) out.print(out.style(ancestorsLine(tree.ancestors), "faint"));
    for (const r of tree.roots) printNode(out, r, true, r.depth);

    const worst = worstNode(tree.roots);
    if (worst) {
      out.print();
      const w = worst.session;
      const which = fixFirstRole(worst.depth, w.parent?.type);
      out.print(out.style("Fix first", "bold"));
      out.print(`  ${which} ${wholeRef(w.id)}: ${worstFirst(w.flags).join(", ")}`);
      out.next("Open it", `coding.sh show ${wholeRef(w.id)}`);
    }
    if (tree.ancestors?.length) out.next("See the whole run", `coding.sh tree ${wholeRef(tree.roots[0]!.session.id)} --all`);
    return 0;
  }, { create: false });
}

/**
 * Who the "Fix first" line names: the top-level agent, or "subagent" followed by the subagent's
 * type when it has one other than "subagent" itself ("subagent Explore", never "subagent subagent").
 */
export function fixFirstRole(depth: number, type: string | undefined): string {
  if (depth === 0) return "the top-level agent";
  const t = type?.trim();
  return t && t.toLowerCase() !== "subagent" ? `subagent ${t}` : "subagent";
}

/** A short label for a tree's root: its title, else its id (wholeRef). */
function treeLabel(s: Session): string {
  return s.title ? oneLine(clean(s.title), 70) : wholeRef(s.id);
}
